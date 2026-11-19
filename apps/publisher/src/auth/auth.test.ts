import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryDirectory } from "../adapters/directory";
import { createFakeAdapters, FakeNotifier } from "../adapters/fake";
import { buildServer } from "../api/server";
import { createIdentity } from "../identity";
import type { OrgSnapshot } from "../org/snapshot";
import { PublisherService } from "../service";
import { storeCases, type StoreCase } from "../test/stores";
import { Engine } from "../workflow/engine";
import { MemoryStore } from "../workflow/store";
import { AuthService, TOKEN_PREFIX } from "./service";
import { MemoryAuthStore, type AuthStore } from "./store";

function org(overrides: { aliceActive?: boolean } = {}): OrgSnapshot {
  return {
    departments: [
      { id: "dingtalk:root", parentId: null, name: "公司" },
      { id: "dingtalk:finance", parentId: "dingtalk:root", name: "财务部" },
    ],
    users: [
      { id: "dingtalk:alice", name: "Alice", active: overrides.aliceActive ?? true, departmentIds: ["dingtalk:finance"], jobNumber: "A001" },
      { id: "dingtalk:bob", name: "Bob", active: true, departmentIds: ["dingtalk:finance"], jobNumber: "A002", mobile: "138-0000-0002" },
    ],
  };
}

/** 可以拨动的时钟 */
function clock(start = "2026-11-18T08:00:00Z") {
  let now = new Date(start);
  return {
    now: () => now,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

function setup(store: AuthStore = new MemoryAuthStore()) {
  const directory = new MemoryDirectory();
  directory.replace(org());
  const notifier = new FakeNotifier();
  const time = clock();
  const auth = new AuthService(store, directory, notifier, { now: time.now });
  /** 最近一条通知里的验证码 */
  const lastCode = () => notifier.sent.at(-1)?.message.match(/验证码:(\d{6})/)?.[1] ?? "";
  return { auth, directory, notifier, time, lastCode };
}

let storeCase: StoreCase;

describe.each(storeCases("ferry_test_auth"))("登录:$name", (c) => {
  beforeAll(() => c.init());
  beforeEach(async () => {
    storeCase = c;
    await c.reset();
  });
  afterAll(() => c.close());

  it("按工号或手机号找到本人发验证码,填对后签发登录会话;验证码只能用一次", async () => {
    const { auth, notifier, lastCode } = setup(storeCase.createAuth());
    const { challengeId } = await auth.requestCode("a001");
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.userId).toBe("dingtalk:alice");

    const { sessionToken } = await auth.verify(challengeId, lastCode());
    expect(await auth.sessionUser(sessionToken)).toBe("dingtalk:alice");
    await expect(auth.verify(challengeId, lastCode())).rejects.toThrow("不正确或已过期");

    // 手机号带区号、分隔符也能找到
    await auth.requestCode("+86 138 0000 0002");
    expect(notifier.sent.at(-1)?.userId).toBe("dingtalk:bob");
  });

  it("账号不存在、发送太频繁时,返回和正常一样的结果,但不发通知", async () => {
    const { auth, notifier, time } = setup(storeCase.createAuth());
    const unknown = await auth.requestCode("Z999");
    expect(unknown.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(notifier.sent).toHaveLength(0);

    await auth.requestCode("A001");
    await auth.requestCode("A001");
    expect(notifier.sent).toHaveLength(1);
    // 每分钟一次,每小时最多 5 次
    for (let i = 0; i < 6; i++) {
      time.advance(61_000);
      await auth.requestCode("A001");
    }
    expect(notifier.sent).toHaveLength(5);
  });

  it("输错 5 次后锁定,填对也不行;过期后不能用", async () => {
    const { auth, time, lastCode } = setup(storeCase.createAuth());
    const { challengeId } = await auth.requestCode("A001");
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) await expect(auth.verify(challengeId, wrong)).rejects.toThrow("不正确");
    await expect(auth.verify(challengeId, wrong)).rejects.toThrow("输错次数太多");
    await expect(auth.verify(challengeId, code)).rejects.toThrow("输错次数太多");

    time.advance(61_000);
    const second = await auth.requestCode("A001");
    time.advance(5 * 60_000 + 1);
    await expect(auth.verify(second.challengeId, lastCode())).rejects.toThrow("已过期");
  });

  it("登录会话 7 天后过期;退出后失效", async () => {
    const { auth, time, lastCode } = setup(storeCase.createAuth());
    const { challengeId } = await auth.requestCode("A001");
    const { sessionToken } = await auth.verify(challengeId, lastCode());
    time.advance(7 * 24 * 3600_000 - 1000);
    expect(await auth.sessionUser(sessionToken)).toBe("dingtalk:alice");
    time.advance(2000);
    expect(await auth.sessionUser(sessionToken)).toBeUndefined();

    time.advance(61_000);
    const again = await auth.requestCode("A001");
    const { sessionToken: second } = await auth.verify(again.challengeId, lastCode());
    await auth.logout(second);
    expect(await auth.sessionUser(second)).toBeUndefined();
  });

  it("个人令牌:带前缀,只存哈希,列表里没有令牌本身;作废后失效;最近使用时间按间隔更新", async () => {
    const store = storeCase.createAuth();
    const { auth, time } = setup(store);
    const created = await auth.createToken("dingtalk:alice", "我的电脑");
    expect(created.token.startsWith(TOKEN_PREFIX)).toBe(true);
    const saved = await store.getTokenByHash(created.token);
    expect(saved).toBeUndefined();

    expect(await auth.tokenUser(created.token)).toBe("dingtalk:alice");
    const firstUse = (await auth.listTokens("dingtalk:alice"))[0]?.lastUsedAt;
    time.advance(60_000);
    await auth.tokenUser(created.token);
    expect((await auth.listTokens("dingtalk:alice"))[0]?.lastUsedAt).toBe(firstUse);
    time.advance(5 * 60_000);
    await auth.tokenUser(created.token);
    expect((await auth.listTokens("dingtalk:alice"))[0]?.lastUsedAt).not.toBe(firstUse);

    const listed = await auth.listTokens("dingtalk:alice");
    expect(JSON.stringify(listed)).not.toContain(created.token);
    await expect(auth.revokeToken("dingtalk:bob", created.id)).rejects.toThrow("令牌不存在");
    await auth.revokeToken("dingtalk:alice", created.id);
    expect(await auth.tokenUser(created.token)).toBeUndefined();
    expect(await auth.tokenUser("fry_not-a-real-token")).toBeUndefined();
  });

  it("离职后:不能登录,原来的登录会话和令牌都失效", async () => {
    const { auth, directory, notifier, lastCode } = setup(storeCase.createAuth());
    const { challengeId } = await auth.requestCode("A001");
    const { sessionToken } = await auth.verify(challengeId, lastCode());
    const { token } = await auth.createToken("dingtalk:alice", "agent");

    directory.replace(org({ aliceActive: false }));
    expect(await auth.sessionUser(sessionToken)).toBeUndefined();
    expect(await auth.tokenUser(token)).toBeUndefined();
    const before = notifier.sent.length;
    await auth.requestCode("A001");
    expect(notifier.sent).toHaveLength(before);
  });
});

/** 起一个完整的服务,用 fastify 的 inject 发请求 */
function server(options: { devAuth?: boolean; adminIds?: string[] } = {}) {
  const directory = new MemoryDirectory();
  directory.replace(org());
  const adapters = { ...createFakeAdapters(), directory };
  const store = new MemoryStore();
  const service = new PublisherService(store, new Engine(store, adapters, { maxFixAttempts: 3 }), adapters, {
    appsDomain: "apps.test",
    maxAppsPerUser: 5,
    publicUrl: "http://ferry.test",
    uploadTtlMs: 60_000,
  });
  const auth = new AuthService(new MemoryAuthStore(), directory, adapters.notifier);
  const allowedOrigins = new Set(["http://ferry.test"]);
  const identity = createIdentity({ auth, directory, adminIds: new Set(options.adminIds), devAuth: options.devAuth ?? false, allowedOrigins });
  const app = buildServer(service, identity, {
    maxArchiveBytes: 1024 * 1024,
    auth: { service: auth, directory, routes: { allowedOrigins, secureCookie: false, codeTtlMinutes: 5 } },
  });
  app.log.level = "silent";
  const lastCode = () => adapters.notifier.sent.at(-1)?.message.match(/验证码:(\d{6})/)?.[1] ?? "";
  const ORIGIN = { origin: "http://ferry.test" };

  /** 走一遍网页登录,返回 cookie 头 */
  async function login(account = "A001"): Promise<string> {
    const code = await app.inject({ method: "POST", url: "/auth/code", headers: ORIGIN, payload: { account } });
    const verify = await app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: ORIGIN,
      payload: { challengeId: code.json().challengeId, code: lastCode() },
    });
    expect(verify.statusCode).toBe(200);
    const setCookie = String(verify.headers["set-cookie"]);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("Domain=");
    return setCookie.split(";")[0]!;
  }
  return { app, auth, login, ORIGIN, service, adapters };
}

const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const toolsList = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

describe("HTTP 入口的身份", () => {
  it("网页登录后用 cookie 访问接口;GET 不要求来源", async () => {
    const { app, login } = server();
    const cookie = await login();
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(me.json()).toEqual({ id: "dingtalk:alice", name: "Alice", isAdmin: false });
  });

  it("用 cookie 发修改请求时,来源必须是 Ferry 自己;员工应用里伪造的请求被拒绝", async () => {
    const { app, login, ORIGIN } = server();
    const cookie = await login();
    const forged = await app.inject({
      method: "POST",
      url: "/api/apps/prepare",
      headers: { cookie, origin: "http://evil.apps.test" },
      payload: { name: "ledger" },
    });
    expect(forged.statusCode).toBe(403);
    const noOrigin = await app.inject({ method: "POST", url: "/api/apps/prepare", headers: { cookie }, payload: { name: "ledger" } });
    expect(noOrigin.statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: "/api/apps/prepare", headers: { cookie, ...ORIGIN }, payload: { name: "ledger" } });
    expect(ok.statusCode).toBe(200);
    const loginForged = await app.inject({ method: "POST", url: "/auth/code", headers: { origin: "http://evil.apps.test" }, payload: { account: "A001" } });
    expect(loginForged.statusCode).toBe(403);
  });

  it("MCP 只认个人令牌,不认 cookie;作废后立即不能用", async () => {
    const { app, login, ORIGIN } = server();
    const cookie = await login();
    const withCookie = await app.inject({ method: "POST", url: "/mcp", headers: { ...MCP_HEADERS, cookie }, payload: toolsList });
    expect(withCookie.statusCode).toBe(401);

    const created = await app.inject({ method: "POST", url: "/api/tokens", headers: { cookie, ...ORIGIN }, payload: { label: "agent" } });
    expect(created.statusCode).toBe(201);
    const { token, id } = created.json();
    const authorization = `Bearer ${token}`;
    const withToken = await app.inject({ method: "POST", url: "/mcp", headers: { ...MCP_HEADERS, authorization }, payload: toolsList });
    expect(withToken.statusCode).toBe(200);
    expect(withToken.body).toContain("unpublish_app");

    await app.inject({ method: "POST", url: `/api/tokens/${id}/revoke`, headers: { cookie, ...ORIGIN } });
    const revoked = await app.inject({ method: "POST", url: "/mcp", headers: { ...MCP_HEADERS, authorization }, payload: toolsList });
    expect(revoked.statusCode).toBe(401);
  });

  it("令牌不能用来管理令牌", async () => {
    const { app, login, ORIGIN } = server();
    const cookie = await login();
    const { token } = (await app.inject({ method: "POST", url: "/api/tokens", headers: { cookie, ...ORIGIN }, payload: {} })).json();
    const viaToken = await app.inject({ method: "POST", url: "/api/tokens", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(viaToken.statusCode).toBe(403);
  });

  it("关闭开发身份时,只带 x-ferry-user 请求头会被拒绝", async () => {
    const { app } = server({ devAuth: false });
    const res = await app.inject({ method: "GET", url: "/api/apps", headers: { "x-ferry-user": "dingtalk:alice" } });
    expect(res.statusCode).toBe(401);
  });

  it("开启开发身份时,带了无效凭据也不会退回去用请求头", async () => {
    const { app } = server({ devAuth: true });
    const header = { "x-ferry-user": "dingtalk:alice" };
    expect((await app.inject({ method: "GET", url: "/api/apps", headers: header })).statusCode).toBe(200);
    const badToken = await app.inject({ method: "GET", url: "/api/apps", headers: { ...header, authorization: "Bearer fry_garbage" } });
    expect(badToken.statusCode).toBe(401);
    const badCookie = await app.inject({ method: "GET", url: "/api/apps", headers: { ...header, cookie: "ferry_session=garbage" } });
    expect(badCookie.statusCode).toBe(401);
  });

  it("登录页和令牌页可以打开", async () => {
    const { app } = server();
    expect((await app.inject({ method: "GET", url: "/login" })).body).toContain("登录 Ferry");
    expect((await app.inject({ method: "GET", url: "/me" })).body).toContain("我的个人令牌");
  });

  it("管理页:只有管理员能看全部应用(含负责人姓名和部门名),停用要同源请求,停用后列表显示原因", async () => {
    const { app, login, ORIGIN, service } = server({ adminIds: ["dingtalk:alice"] });
    const page = await app.inject({ method: "GET", url: "/admin" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Ferry 管理");

    await service.prepareApp({ id: "dingtalk:bob", departments: ["dingtalk:finance"], isAdmin: false }, "bob-tool");
    const bob = await login("A002");
    expect((await app.inject({ method: "GET", url: "/api/admin/apps", headers: { cookie: bob } })).statusCode).toBe(403);

    const alice = await login("A001");
    const listed = await app.inject({ method: "GET", url: "/api/admin/apps", headers: { cookie: alice } });
    expect(listed.json()).toEqual([
      expect.objectContaining({ name: "bob-tool", ownerName: "Bob", departments: ["dingtalk:finance"], departmentNames: ["财务部"], disabled: false }),
    ]);

    const crossSite = await app.inject({ method: "POST", url: "/api/admin/apps/bob-tool/disable", headers: { cookie: alice }, payload: {} });
    expect(crossSite.statusCode).toBe(403);
    const disabled = await app.inject({
      method: "POST",
      url: "/api/admin/apps/bob-tool/disable",
      headers: { cookie: alice, ...ORIGIN },
      payload: { reason: "占用资源过多" },
    });
    expect(disabled.statusCode).toBeLessThan(300);
    const after = (await app.inject({ method: "GET", url: "/api/admin/apps", headers: { cookie: alice } })).json();
    expect(after[0]).toMatchObject({ disabled: true, disabledReason: "占用资源过多" });
  });
});

