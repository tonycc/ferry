import { parseManifest } from "@ferry/manifest";
import { describe, expect, it, vi } from "vitest";
import { MemoryDirectory } from "../adapters/directory";
import { createFakeAdapters } from "../adapters/fake";
import { buildServer } from "../api/server";
import { AuthService } from "../auth/service";
import { MemoryAuthStore } from "../auth/store";
import { createIdentity } from "../identity";
import { PublisherService } from "../service";
import { Engine } from "../workflow/engine";
import { MemoryStore, type AppRecord } from "../workflow/store";
import { APP_COOKIE, Gateway, safePath } from "./gateway";

const FERRY = "http://ferry.test";

async function setup() {
  const directory = new MemoryDirectory();
  directory.replace({
    departments: [
      { id: "dingtalk:root", parentId: null, name: "公司" },
      { id: "dingtalk:finance", parentId: "dingtalk:root", name: "财务部" },
      { id: "dingtalk:sales", parentId: "dingtalk:root", name: "销售部" },
    ],
    users: [
      { id: "dingtalk:alice", name: "张三", active: true, departmentIds: ["dingtalk:finance"], jobNumber: "A001" },
      { id: "dingtalk:bob", name: "Bob", active: true, departmentIds: ["dingtalk:finance"], jobNumber: "A002" },
      { id: "dingtalk:carol", name: "Carol", active: true, departmentIds: ["dingtalk:sales"], jobNumber: "B001" },
    ],
  });
  const adapters = { ...createFakeAdapters(), directory };
  const store = new MemoryStore();
  const service = new PublisherService(store, new Engine(store, adapters, { maxFixAttempts: 3 }), adapters, {
    appsDomain: "apps.test",
    maxAppsPerUser: 5,
    publicUrl: FERRY,
    uploadTtlMs: 60_000,
  });
  let now = new Date("2026-11-18T08:00:00Z");
  const auth = new AuthService(new MemoryAuthStore(), directory, { now: () => now });
  const gateway = new Gateway(service, directory, {
    secret: "x".repeat(32),
    ferryUrl: FERRY,
    appsScheme: "http",
    appCookieTtlMs: 12 * 3600_000,
    ticketTtlMs: 60_000,
    now: () => now,
    sessionEpoch: (userId) => auth.sessionEpoch(userId),
  });
  const allowedOrigins = new Set([FERRY]);
  const identity = createIdentity({ auth, directory, adminIds: new Set(), devAuth: false, allowedOrigins });
  const app = buildServer(service, identity, {
    maxArchiveBytes: 1024,
    gateway,
    auth: { service: auth, directory, routes: { allowedOrigins, secureCookie: false } },
  });
  app.log.level = "silent";

  const parsed = parseManifest("name: ledger\ntemplate: node-postgres\nhealthcheck: /healthz\n");
  if (!parsed.ok) throw new Error("bad manifest");
  const manifest = parsed.manifest;
  async function addApp(name: string, overrides: Partial<AppRecord> = {}) {
    await store.createApp({
      name,
      ownerId: "dingtalk:alice",
      visibility: "department",
      host: `${name}.apps.test`,
      platform: { appId: `app-${name}` },
      liveVersion: "v1",
      createdAt: now,
      ...overrides,
    });
    await store.saveRelease({
      id: crypto.randomUUID(),
      kind: "publish",
      appName: name,
      ownerId: "dingtalk:alice",
      version: "v1",
      manifest: { ...manifest, name },
      state: "LIVE",
      history: [],
      createdAt: now,
    });
  }

  /** Traefik 发给 /authz 的请求 */
  const authz = (host: string, uri: string, headers: Record<string, string> = {}, method = "GET") =>
    app.inject({
      method: "GET",
      url: "/authz",
      headers: { "x-forwarded-host": host, "x-forwarded-uri": uri, "x-forwarded-method": method, ...headers },
    });

  /** 走一遍 Ferry 登录,返回 Ferry 的登录 cookie */
  async function ferryLogin(account: string): Promise<string> {
    const userId = await directory.findLogin(account);
    const initial = await auth.resetPassword(undefined, userId!);
    const first = await app.inject({ method: "POST", url: "/auth/login", headers: { origin: FERRY }, payload: { account, password: initial } });
    const changed = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: { origin: FERRY },
      payload: { ticket: first.json().ticket, newPassword: "own-password-1" },
    });
    return String(changed.headers["set-cookie"]).split(";")[0]!;
  }

  /** 完整的浏览器流程:访问应用 → 跳 Ferry → 拿票据 → 回调 → 拿到应用 cookie */
  async function visit(account: string, host = "ledger.apps.test", path = "/reports?m=11"): Promise<string> {
    const first = await authz(host, path);
    expect(first.statusCode).toBe(302);
    const toFerry = new URL(String(first.headers.location));
    const ferryCookie = await ferryLogin(account);
    const ticketRes = await app.inject({ method: "GET", url: toFerry.pathname + toFerry.search, headers: { cookie: ferryCookie } });
    expect(ticketRes.statusCode).toBe(302);
    const callback = new URL(String(ticketRes.headers.location));
    expect(callback.host).toBe(host);
    const back = await authz(host, callback.pathname + callback.search);
    expect(back.statusCode).toBe(302);
    expect(back.headers.location).toBe(`http://${host}${path}`);
    const setCookie = String(back.headers["set-cookie"]);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).not.toContain("Domain=");
    return setCookie.split(";")[0]!;
  }

  return { app, auth, service, store, gateway, directory, authz, ferryLogin, visit, addApp, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("登录网关", () => {
  it("没登录时跳到 Ferry;登录后带着一次性票据回到应用,拿到只属于这个应用的 cookie,之后放行并带上访问者身份", async () => {
    const { authz, addApp, visit } = await setup();
    await addApp("ledger");
    const first = await authz("ledger.apps.test", "/reports?m=11");
    expect(first.statusCode).toBe(302);
    expect(first.headers.location).toBe(`${FERRY}/auth/app?host=ledger.apps.test&next=%2Freports%3Fm%3D11`);

    const cookie = await visit("A001");
    const ok = await authz("ledger.apps.test", "/reports?m=11", { cookie });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["x-ferry-user-id"]).toBe("dingtalk:alice");
    expect(decodeURIComponent(String(ok.headers["x-ferry-user-name"]))).toBe("张三");
    expect(ok.headers["x-ferry-user-departments"]).toBe("dingtalk:finance");
    // 部门名称和 ID 一一对应,每个名称单独百分号编码
    expect(String(ok.headers["x-ferry-user-department-names"]).split(",").map(decodeURIComponent)).toEqual(["财务部"]);
  });

  it("Ferry 没登录时先去登录页,登录后回到原来的跳转", async () => {
    const { app, addApp } = await setup();
    await addApp("ledger");
    const res = await app.inject({ method: "GET", url: "/auth/app?host=ledger.apps.test&next=%2Fa" });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/login?next=${encodeURIComponent("/auth/app?host=ledger.apps.test&next=%2Fa")}`);
  });

  it("按可见范围判定:其他部门 403;全公司可见的应用也要登录", async () => {
    const { authz, addApp, visit } = await setup();
    await addApp("ledger");
    await addApp("wiki", { visibility: "company" });
    const carol = await visit("B001");
    expect((await authz("ledger.apps.test", "/", { cookie: carol })).statusCode).toBe(403);
    expect((await authz("wiki.apps.test", "/")).statusCode).toBe(302);
  });

  it("应用 cookie 只对自己的域名有效;过期或离职后要重新登录", async () => {
    const { authz, addApp, visit, directory, advance } = await setup();
    await addApp("ledger");
    await addApp("crm");
    const cookie = await visit("A002");
    expect((await authz("crm.apps.test", "/", { cookie })).statusCode).toBe(302);
    expect((await authz("ledger.apps.test", "/", { cookie: `${APP_COOKIE}=forged.sig` })).statusCode).toBe(302);

    advance(12 * 3600_000 + 1);
    expect((await authz("ledger.apps.test", "/", { cookie })).statusCode).toBe(302);

    const fresh = await visit("A002");
    directory.replace({
      departments: [
        { id: "dingtalk:root", parentId: null, name: "公司" },
        { id: "dingtalk:finance", parentId: "dingtalk:root", name: "财务部" },
      ],
      users: [
        { id: "dingtalk:alice", name: "张三", active: true, departmentIds: ["dingtalk:finance"] },
        { id: "dingtalk:bob", name: "Bob", active: false, departmentIds: ["dingtalk:finance"] },
      ],
    });
    expect((await authz("ledger.apps.test", "/", { cookie: fresh })).statusCode).toBe(302);
  });

  it("票据只能用一次、60 秒内有效、只能用在签发时的域名", async () => {
    const { app, authz, addApp, ferryLogin, advance } = await setup();
    await addApp("ledger");
    await addApp("crm");
    const ferryCookie = await ferryLogin("A001");
    const ticketUrl = async () => {
      const res = await app.inject({ method: "GET", url: "/auth/app?host=ledger.apps.test&next=%2F", headers: { cookie: ferryCookie } });
      const u = new URL(String(res.headers.location));
      return u.pathname + u.search;
    };

    const once = await ticketUrl();
    expect((await authz("ledger.apps.test", once)).headers["set-cookie"]).toBeDefined();
    expect((await authz("ledger.apps.test", once)).headers["set-cookie"]).toBeUndefined();

    expect((await authz("crm.apps.test", await ticketUrl())).headers["set-cookie"]).toBeUndefined();

    const late = await ticketUrl();
    advance(61_000);
    expect((await authz("ledger.apps.test", late)).headers["set-cookie"]).toBeUndefined();
  });

  it("不会被当成跳转器:只给在线应用的域名签票据,跳转目标只能是站内路径", async () => {
    const { app, addApp, ferryLogin, authz } = await setup();
    await addApp("ledger");
    await addApp("gone", { unpublishedAt: new Date() });
    const cookie = await ferryLogin("A001");
    expect((await app.inject({ method: "GET", url: "/auth/app?host=evil.example&next=%2F", headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/auth/app?host=gone.apps.test&next=%2F", headers: { cookie } })).statusCode).toBe(404);

    const res = await app.inject({ method: "GET", url: "/auth/app?host=ledger.apps.test&next=%2F%2Fevil.example", headers: { cookie } });
    const callback = new URL(String(res.headers.location));
    expect(callback.searchParams.get("next")).toBe("/");
    const back = await authz("ledger.apps.test", callback.pathname + callback.search);
    expect(back.headers.location).toBe("http://ledger.apps.test/");

    expect(safePath("//evil.example")).toBe("/");
    expect(safePath("/\\evil.example")).toBe("/");
    expect(safePath("https://evil.example")).toBe("/");
    expect(safePath("/a?b=1")).toBe("/a?b=1");
  });

  it("伪造的身份请求头:连字符和下划线写法都直接拒绝", async () => {
    const { authz, addApp, visit } = await setup();
    await addApp("ledger");
    const cookie = await visit("A001");
    expect((await authz("ledger.apps.test", "/", { cookie, "x-ferry-user-id": "dingtalk:carol" })).statusCode).toBe(400);
    expect((await authz("ledger.apps.test", "/", { cookie, x_ferry_user_id: "dingtalk:carol" })).statusCode).toBe(400);
    expect((await authz("ledger.apps.test", "/", { cookie, x_ferry_health: "whatever" })).statusCode).toBe(400);
  });

  it("健康检查口令:只对自己的域名、自己的健康检查路径、GET 有效", async () => {
    const { authz, addApp, gateway } = await setup();
    await addApp("ledger");
    await addApp("crm");
    const token = gateway.healthToken("ledger.apps.test");
    expect((await authz("ledger.apps.test", "/healthz", { "x-ferry-health": token })).statusCode).toBe(200);
    expect((await authz("crm.apps.test", "/healthz", { "x-ferry-health": token })).statusCode).toBe(403);
    expect((await authz("ledger.apps.test", "/admin", { "x-ferry-health": token })).statusCode).toBe(403);
    expect((await authz("ledger.apps.test", "/healthz", { "x-ferry-health": token }, "POST")).statusCode).toBe(403);
  });

  it("同名 cookie 有多个时逐个检查:别的应用往上级域名塞的假 cookie 不会造成反复跳转", async () => {
    const { authz, addApp, visit } = await setup();
    await addApp("ledger");
    const cookie = await visit("A001");
    const tossed = `${APP_COOKIE}=junk.sig; ${cookie}`;
    expect((await authz("ledger.apps.test", "/", { cookie: tossed })).statusCode).toBe(200);
  });

  it("格式错误的 cookie 当作没有:网关跳去登录,Ferry 接口返回 401,都不是 500", async () => {
    const { app, authz, addApp } = await setup();
    await addApp("ledger");
    expect((await authz("ledger.apps.test", "/", { cookie: `${APP_COOKIE}=%E0` })).statusCode).toBe(302);
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: "ferry_session=%E0" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/auth/app?host=ledger.apps.test&next=%2F", headers: { cookie: "ferry_session=%E0" } })).statusCode).toBe(302);
  });

  it("Ferry 的登录 cookie 也逐个检查:前面有一个无效的,后面有效的仍然能用", async () => {
    const { app, ferryLogin } = await setup();
    const cookie = await ferryLogin("A001");
    const res = await app.inject({ method: "GET", url: "/api/me", headers: { cookie: `ferry_session=bogus; ${cookie}` } });
    expect(res.statusCode).toBe(200);
  });

  it("每人同时有效的票据有上限,反复请求不会让票据无限增加", async () => {
    const { app, addApp, ferryLogin, gateway } = await setup();
    await addApp("ledger");
    const cookie = await ferryLogin("A001");
    for (let i = 0; i < 30; i++) {
      await app.inject({ method: "GET", url: "/auth/app?host=ledger.apps.test&next=%2F", headers: { cookie } });
    }
    expect(gateway.pendingTickets).toBe(Gateway.MAX_TICKETS_PER_USER);
  });

  it("下线的应用 404,被停用的应用 403", async () => {
    const { authz, addApp, visit } = await setup();
    await addApp("ledger");
    await addApp("gone", { unpublishedAt: new Date() });
    await addApp("blocked", { disabled: { by: "dingtalk:admin", at: new Date() } });
    const cookie = await visit("A001");
    expect((await authz("gone.apps.test", "/", { cookie })).statusCode).toBe(404);
    expect((await authz("blocked.apps.test", "/", { cookie })).statusCode).toBe(403);
  });

  it("改密码或管理员重置密码后,已签发的网关 cookie 立即失效;旧代数 cookie 不会挡住后面的新 cookie", async () => {
    const { app, auth, authz, addApp } = await setup();
    await addApp("ledger");

    // 首次登录并访问应用(时钟固定不推进,验证不依赖毫秒递增也能精确吊销)
    const userId = (await auth.resetPassword(undefined, "dingtalk:alice")) && "dingtalk:alice";
    const initial = await auth.resetPassword("dingtalk:admin", userId);
    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { origin: FERRY },
      payload: { account: "A001", password: initial },
    });
    const changed = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: { origin: FERRY },
      payload: { ticket: loginRes.json().ticket, newPassword: "own-password-1" },
    });
    const ferrySession1 = String(changed.headers["set-cookie"]).split(";")[0]!;

    const issueAppCookie = async (sessionCookie: string) => {
      const t = await app.inject({
        method: "GET",
        url: "/auth/app?host=ledger.apps.test&next=%2F",
        headers: { cookie: sessionCookie },
      });
      expect(t.statusCode).toBe(302);
      const cb = new URL(String(t.headers.location));
      const back = await authz("ledger.apps.test", cb.pathname + cb.search);
      return String(back.headers["set-cookie"]).split(";")[0]!;
    };

    const appCookie1 = await issueAppCookie(ferrySession1);
    expect((await authz("ledger.apps.test", "/", { cookie: appCookie1 })).statusCode).toBe(200);

    // 本人修改密码:同一毫秒内旧应用 cookie 立即 302 跳回登录
    const pwdChanged = await app.inject({
      method: "POST",
      url: "/api/me/password",
      headers: { cookie: ferrySession1, origin: FERRY },
      payload: { currentPassword: "own-password-1", newPassword: "own-password-2" },
    });
    expect(pwdChanged.statusCode).toBe(200);
    expect((await authz("ledger.apps.test", "/", { cookie: appCookie1 })).statusCode).toBe(302);

    // 用新会话重新换取应用 cookie 后恢复访问;请求头里夹带旧代数 cookie 时仍能匹配到新 cookie
    const ferrySession2 = String(pwdChanged.headers["set-cookie"]).split(";")[0]!;
    const appCookie2 = await issueAppCookie(ferrySession2);
    expect((await authz("ledger.apps.test", "/", { cookie: `${appCookie1}; ${appCookie2}` })).statusCode).toBe(200);

    // 不同应用的网关 cookie 里的代数标识按域名独立派生,应用之间不能横向关联
    await addApp("crm");
    const crmCookie = await issueAppCookie(ferrySession2);
    // (上面默认请求 ledger.apps.test,再单独签一张 crm.apps.test 的对比 v 字段)
    const crmTicket = await app.inject({
      method: "GET",
      url: "/auth/app?host=crm.apps.test&next=%2F",
      headers: { cookie: ferrySession2 },
    });
    const crmCb = new URL(String(crmTicket.headers.location));
    const crmSet = String((await authz("crm.apps.test", crmCb.pathname + crmCb.search)).headers["set-cookie"]).split(";")[0]!;
    const decodePayload = (c: string) => JSON.parse(Buffer.from(c.split("=")[1]!.split(".")[0]!, "base64url").toString()) as { v: string };
    expect(decodePayload(crmCookie).v).not.toBe(decodePayload(crmSet).v);

    // 改密期间若并发触发 reloadPasswordEpochs,旧数据库快照绝不能覆盖刚落库的新代数
    let releaseList!: () => void;
    const listGate = new Promise<void>((r) => (releaseList = r));
    const authStore = (auth as unknown as { store: { listPasswords: () => Promise<unknown[]> } }).store;
    const rawList = authStore.listPasswords.bind(authStore);
    let intercepted = false;
    authStore.listPasswords = async () => {
      const snapshot = await rawList();
      if (!intercepted) {
        intercepted = true;
        await listGate;
      }
      return snapshot;
    };
    const reloading = auth.reloadPasswordEpochs();
    const pwdChanged2 = await app.inject({
      method: "POST",
      url: "/api/me/password",
      headers: { cookie: ferrySession2, origin: FERRY },
      payload: { currentPassword: "own-password-2", newPassword: "own-password-3" },
    });
    expect(pwdChanged2.statusCode).toBe(200);
    releaseList();
    await reloading;
    // 旧的 appCookie2 必须依然是失效状态(不能被 reload 的旧快照复活)
    expect((await authz("ledger.apps.test", "/", { cookie: appCookie2 })).statusCode).toBe(302);

    // 管理员重置密码(进入 mustChange 状态):应用 cookie 失效;若残留旧 ferry_session 请求 /auth/app,跳 /login 而非自跳 /auth/app
    const ferrySession3 = String(pwdChanged2.headers["set-cookie"]).split(";")[0]!;
    const appCookie3 = await issueAppCookie(ferrySession3);
    expect((await authz("ledger.apps.test", "/", { cookie: appCookie3 })).statusCode).toBe(200);
    await auth.resetPassword("dingtalk:admin", "dingtalk:alice");
    expect((await authz("ledger.apps.test", "/", { cookie: appCookie3 })).statusCode).toBe(302);

    // 模拟数据库异常残留了一个会话但用户处于无有效正式密码状态:访问 /auth/app 必须跳 /login,绝不能跳回 /auth/app 死循环
    const rawAuthStore = (auth as unknown as { store: import("../auth/store").AuthStore }).store;
    const { createHash } = await import("node:crypto");
    const orphanToken = "orphan-session-token";
    await rawAuthStore.saveSession({
      tokenHash: createHash("sha256").update(orphanToken).digest("hex"),
      userId: "dingtalk:alice",
      createdAt: new Date("2026-11-18T08:00:00Z"),
      expiresAt: new Date("2026-11-25T08:00:00Z"),
    });
    const noLoop = await app.inject({
      method: "GET",
      url: "/auth/app?host=ledger.apps.test&next=%2F",
      headers: { cookie: `ferry_session=${orphanToken}` },
    });
    expect(noLoop.statusCode).toBe(302);
    expect(String(noLoop.headers.location)).toMatch(/^\/login\?next=/);
  });

  it("/authz 稳态请求零存储查询,并发慢读不会覆盖新写入的停用状态,访问不存在应用不会冲刷缓存", async () => {
    const { authz, addApp, visit, service, store, gateway } = await setup();
    await addApp("ledger");
    const cookie = await visit("A001");
    const carolCookie = await visit("B001");
    const health = gateway.healthToken("ledger.apps.test");

    // 预热一次应用路由缓存和健康检查缓存
    expect((await authz("ledger.apps.test", "/", { cookie })).statusCode).toBe(200);
    expect((await authz("ledger.apps.test", "/healthz", { "x-ferry-health": health })).statusCode).toBe(200);

    const spies = [
      vi.spyOn(store, "listApps"),
      vi.spyOn(store, "getAppByHost"),
      vi.spyOn(store, "getActiveHealthchecks"),
      vi.spyOn(store, "listReleases"),
    ];
    for (let i = 0; i < 10; i++) {
      expect((await authz("ledger.apps.test", "/assets/app.js", { cookie })).statusCode).toBe(200);
      expect((await authz("ledger.apps.test", "/healthz", { "x-ferry-health": health })).statusCode).toBe(200);
      expect((await authz("missing.apps.test", "/", { cookie })).statusCode).toBe(404);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();

    // 对随机不存在的应用调用下线接口失败时,不能使整表网关缓存失效
    const alice = { id: "dingtalk:alice", departments: ["dingtalk:finance"], isAdmin: true };
    await expect(service.unpublish(alice, "ghost-app")).rejects.toThrow("不存在");
    expect((await authz("ledger.apps.test", "/assets/app.js", { cookie })).statusCode).toBe(200);
    expect(spies[0]).not.toHaveBeenCalled();

    // 修改可见范围为全公司:Carol 立即可以访问,且只按单域名重读一次
    expect((await authz("ledger.apps.test", "/", { cookie: carolCookie })).statusCode).toBe(403);
    await service.setVisibility(alice, "ledger", "company");
    expect((await authz("ledger.apps.test", "/", { cookie: carolCookie })).statusCode).toBe(200);
    expect(spies[1]).toHaveBeenCalledTimes(1);
    expect(spies[0]).not.toHaveBeenCalled();

    // 模拟单域名刷新 getAppByHost 慢返回期间管理员紧急停用应用:旧快照绝不能把停用后的应用复活
    await service.setVisibility(alice, "ledger", "department");
    const rawGetByHost = store.getAppByHost.bind(store);
    let releaseSlowRead!: () => void;
    const slowReadGate = new Promise<void>((r) => (releaseSlowRead = r));
    let enteredSlowRead!: () => void;
    const slowReadStarted = new Promise<void>((r) => (enteredSlowRead = r));
    let delayOnce = true;
    store.getAppByHost = async (h) => {
      const snap = await rawGetByHost(h);
      if (delayOnce) {
        delayOnce = false;
        enteredSlowRead();
        await slowReadGate;
      }
      return snap;
    };
    const pendingAuthz = authz("ledger.apps.test", "/", { cookie });
    await slowReadStarted;
    await service.disableApp(alice, "ledger", "紧急停用");
    releaseSlowRead();
    expect((await pendingAuthz).statusCode).toBe(403);
    expect((await authz("ledger.apps.test", "/", { cookie })).statusCode).toBe(403);

    await service.unpublish(alice, "ledger");
    expect((await authz("ledger.apps.test", "/", { cookie })).statusCode).toBe(404);
  });
});
