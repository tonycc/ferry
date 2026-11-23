import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryDirectory } from "../adapters/directory";
import { createFakeAdapters } from "../adapters/fake";
import { AuditLog } from "../audit/log";
import { MemoryAuditStore } from "../audit/store";
import { buildServer } from "../api/server";
import { createIdentity } from "../identity";
import { Organization } from "../org/service";
import type { OrgSnapshot } from "../org/snapshot";
import { MemoryOrgStore } from "../org/store";
import { PublisherService } from "../service";
import { storeCases, type StoreCase } from "../test/stores";
import { Engine } from "../workflow/engine";
import { SecretBox } from "../secrets";
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
      { id: "dingtalk:alice", name: "Alice", active: overrides.aliceActive ?? true, departmentIds: ["dingtalk:finance"], jobNumber: "A001", mobile: "13800000001" },
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

function setup(store: AuthStore = new MemoryAuthStore(), audit?: AuditLog) {
  const directory = new MemoryDirectory();
  directory.replace(org());
  const time = clock();
  const auth = new AuthService(store, directory, { now: time.now }, audit);
  /** 管理员给 Alice 生成初始密码、Alice 用它登录并改成自己的密码,返回登录会话 */
  async function aliceWithPassword(password = "alice-own-pass") {
    const initial = await auth.resetPassword("dingtalk:admin", "dingtalk:alice");
    const first = await auth.login("13800000001", initial);
    if (first.kind !== "must_change") throw new Error("应该先改密码");
    const session = await auth.changeInitialPassword(first.ticket, password);
    return { initial, password, ...session };
  }
  return { auth, directory, time, store, aliceWithPassword };
}

let storeCase: StoreCase;

describe.each(storeCases("ferry_test_auth"))("登录:$name", (c) => {
  beforeAll(() => c.init());
  beforeEach(async () => {
    storeCase = c;
    await c.reset();
  });
  afterAll(() => c.close());

  it("初始密码只能用来改密码,不签发登录会话;改完之后用新密码登录", async () => {
    const { auth, store } = setup(storeCase.createAuth());
    const initial = await auth.resetPassword("dingtalk:admin", "dingtalk:alice");
    expect(initial).toMatch(/^\w{4}-\w{4}-\w{4}$/);
    expect((await store.getPassword("dingtalk:alice"))?.hash).not.toContain(initial);

    const first = await auth.login("13800000001", initial);
    expect(first.kind).toBe("must_change");
    if (first.kind !== "must_change") return;

    // 不满足要求、和初始密码一样的新密码被拒绝,票据还能继续用
    await expect(auth.changeInitialPassword(first.ticket, "short")).rejects.toThrow("至少 8 位");
    await expect(auth.changeInitialPassword(first.ticket, "12345678")).rejects.toThrow("不能全是数字");
    await expect(auth.changeInitialPassword(first.ticket, initial)).rejects.toThrow("不能和初始密码一样");

    const { sessionToken } = await auth.changeInitialPassword(first.ticket, "alice-own-pass");
    expect(await auth.sessionUser(sessionToken)).toBe("dingtalk:alice");
    // 票据只能用一次;初始密码不再有效
    await expect(auth.changeInitialPassword(first.ticket, "another-pass")).rejects.toThrow("重新登录");
    await expect(auth.login("13800000001", initial)).rejects.toThrow("账号或密码不正确");

    // 手机号带区号、分隔符,或者用工号,都能登录
    for (const account of ["+86 138-0000-0001", "a001"]) {
      expect((await auth.login(account, "alice-own-pass")).kind).toBe("session");
    }
  });

  it("改密码票据 10 分钟后过期", async () => {
    const { auth, time } = setup(storeCase.createAuth());
    const initial = await auth.resetPassword("dingtalk:admin", "dingtalk:alice");
    const first = await auth.login("13800000001", initial);
    if (first.kind !== "must_change") throw new Error();
    time.advance(10 * 60_000 + 1);
    await expect(auth.changeInitialPassword(first.ticket, "alice-own-pass")).rejects.toThrow("已过期");
  });

  it("账号不存在、没设密码、密码错误、已离职:都是同一句错误", async () => {
    const { auth, directory, aliceWithPassword } = setup(storeCase.createAuth());
    await aliceWithPassword();
    const errors = await Promise.all(
      [
        auth.login("13999999999", "whatever-pass"), // 不存在
        auth.login("13800000002", "whatever-pass"), // Bob 没设密码
        auth.login("13800000001", "wrong-pass"), // 密码错
      ].map((p) => p.then(() => "ok", (e: Error) => e.message)),
    );
    expect(new Set(errors).size).toBe(1);
    expect(errors[0]).toContain("账号或密码不正确");

    directory.replace(org({ aliceActive: false }));
    await expect(auth.login("13800000001", "alice-own-pass")).rejects.toThrow(errors[0]);
  });

  it("同一账号连续输错 5 次锁 15 分钟,密码对了也不行;不存在的账号同样会锁", async () => {
    const { auth, time, aliceWithPassword } = setup(storeCase.createAuth());
    await aliceWithPassword();
    for (let i = 0; i < 5; i++) await expect(auth.login("13800000001", "wrong-pass")).rejects.toThrow();
    await expect(auth.login("13800000001", "alice-own-pass")).rejects.toThrow("账号或密码不正确");
    // 换个写法也是同一个账号
    await expect(auth.login("138 0000 0001", "alice-own-pass")).rejects.toThrow("账号或密码不正确");
    time.advance(15 * 60_000 + 1);
    expect((await auth.login("13800000001", "alice-own-pass")).kind).toBe("session");

    // 不存在的账号:锁定后行为一样(看不出账号存不存在)
    for (let i = 0; i < 6; i++) await expect(auth.login("13999999999", "x-wrong-pass")).rejects.toThrow("账号或密码不正确");
  });

  it("同时发来一批错误密码也逐个计数:之后密码对了也被拒绝", async () => {
    const { auth, aliceWithPassword } = setup(storeCase.createAuth());
    await aliceWithPassword();
    // 10 个错误密码同时校验;如果计数是在校验前读的,整批只会记 1 次
    await Promise.all(Array.from({ length: 10 }, (_, i) => auth.login("13800000001", `wrong-${i}`).catch(() => undefined)));
    await expect(auth.login("13800000001", "alice-own-pass")).rejects.toThrow("账号或密码不正确");
  });

  it("改密码票据:重置密码后作废;已经用别的票据改过之后也作废", async () => {
    const { auth } = setup(storeCase.createAuth());
    const leaked = await auth.resetPassword("dingtalk:admin", "dingtalk:alice");
    const stolen = await auth.login("13800000001", leaked);
    if (stolen.kind !== "must_change") throw new Error();
    // 管理员发现初始密码泄露,重新生成
    const fresh = await auth.resetPassword("dingtalk:admin", "dingtalk:alice");
    await expect(auth.changeInitialPassword(stolen.ticket, "attacker-pass")).rejects.toThrow("重新登录");

    const a = await auth.login("13800000001", fresh);
    const b = await auth.login("13800000001", fresh);
    if (a.kind !== "must_change" || b.kind !== "must_change") throw new Error();
    await auth.changeInitialPassword(a.ticket, "alice-own-pass");
    await expect(auth.changeInitialPassword(b.ticket, "other-pass-1")).rejects.toThrow("重新登录");
    expect((await auth.login("13800000001", "alice-own-pass")).kind).toBe("session");
  });

  it("输错次数按人计:手机号和工号轮流输错也一起计数", async () => {
    const { auth, aliceWithPassword } = setup(storeCase.createAuth());
    await aliceWithPassword();
    for (let i = 0; i < 5; i++) {
      await expect(auth.login(i % 2 ? "A001" : "13800000001", "wrong-pass")).rejects.toThrow();
    }
    await expect(auth.login("A001", "alice-own-pass")).rejects.toThrow("账号或密码不正确");
  });

  it("超过锁定时长没再输错,之前的输错不再算;过期的记录会被清掉", async () => {
    const { auth, time, aliceWithPassword } = setup(storeCase.createAuth());
    await aliceWithPassword();
    for (let i = 0; i < 4; i++) await expect(auth.login("13800000001", "wrong-pass")).rejects.toThrow();
    for (let i = 0; i < 50; i++) await expect(auth.login(`1390000${String(i).padStart(4, "0")}`, "x-wrong-pass")).rejects.toThrow();
    time.advance(15 * 60_000 + 1);
    await expect(auth.login("13800000001", "wrong-pass")).rejects.toThrow();
    // 只剩刚才这一次
    expect((auth as unknown as { failures: Map<string, unknown> }).failures.size).toBe(1);
    expect((await auth.login("13800000001", "alice-own-pass")).kind).toBe("session");
  });

  it("已登录改密码时输错当前密码也计数,锁定后不能再试", async () => {
    const { auth, aliceWithPassword } = setup(storeCase.createAuth());
    await aliceWithPassword();
    for (let i = 0; i < 5; i++) {
      await expect(auth.changePassword("dingtalk:alice", "wrong", "new-own-pass")).rejects.toThrow("当前密码不正确");
    }
    await expect(auth.changePassword("dingtalk:alice", "alice-own-pass", "new-own-pass")).rejects.toThrow("输错次数太多");
    await expect(auth.login("13800000001", "alice-own-pass")).rejects.toThrow("账号或密码不正确");
  });

  it("错误提示里的次数和时长按配置", async () => {
    const directory = new MemoryDirectory();
    directory.replace(org());
    const auth = new AuthService(storeCase.createAuth(), directory, { maxFailures: 3, lockMs: 30 * 60_000 });
    await expect(auth.login("13800000001", "x")).rejects.toThrow("连续输错 3 次要等 30 分钟");
  });

  it("登录成功后输错次数清零", async () => {
    const { auth, aliceWithPassword } = setup(storeCase.createAuth());
    await aliceWithPassword();
    for (let i = 0; i < 4; i++) await expect(auth.login("13800000001", "wrong-pass")).rejects.toThrow();
    await auth.login("13800000001", "alice-own-pass");
    for (let i = 0; i < 4; i++) await expect(auth.login("13800000001", "wrong-pass")).rejects.toThrow();
    expect((await auth.login("13800000001", "alice-own-pass")).kind).toBe("session");
  });

  it("已登录时改密码:要当前密码;改完其他登录会话失效,换一个新的", async () => {
    const { auth, aliceWithPassword } = setup(storeCase.createAuth());
    const { sessionToken: old } = await aliceWithPassword();
    const other = await auth.login("13800000001", "alice-own-pass");
    if (other.kind !== "session") throw new Error();

    await expect(auth.changePassword("dingtalk:alice", "wrong", "new-own-pass")).rejects.toThrow("当前密码不正确");
    await expect(auth.changePassword("dingtalk:alice", "alice-own-pass", "alice-own-pass")).rejects.toThrow("不能和当前密码一样");
    const { sessionToken } = await auth.changePassword("dingtalk:alice", "alice-own-pass", "new-own-pass");
    expect(await auth.sessionUser(old)).toBeUndefined();
    expect(await auth.sessionUser(other.sessionToken)).toBeUndefined();
    expect(await auth.sessionUser(sessionToken)).toBe("dingtalk:alice");
    expect((await auth.login("13800000001", "new-own-pass")).kind).toBe("session");
  });

  it("管理员重置密码:原来的登录会话失效,下次登录必须改密码;个人令牌不受影响", async () => {
    const { auth, aliceWithPassword } = setup(storeCase.createAuth());
    const { sessionToken } = await aliceWithPassword();
    const { token } = await auth.createToken("dingtalk:alice", "agent");
    const fresh = await auth.resetPassword("dingtalk:admin", "dingtalk:alice");
    expect(await auth.sessionUser(sessionToken)).toBeUndefined();
    expect(await auth.tokenUser(token)).toBe("dingtalk:alice");
    await expect(auth.login("13800000001", "alice-own-pass")).rejects.toThrow();
    expect((await auth.login("13800000001", fresh)).kind).toBe("must_change");
    expect((await auth.passwordStatuses()).get("dingtalk:alice")).toBe("initial");
  });

  it("不能给不在组织架构里或已离职的人生成密码", async () => {
    const { auth, directory } = setup(storeCase.createAuth());
    await expect(auth.resetPassword("dingtalk:admin", "dingtalk:nobody")).rejects.toThrow("没有这个人");
    directory.replace(org({ aliceActive: false }));
    await expect(auth.resetPassword("dingtalk:admin", "dingtalk:alice")).rejects.toThrow("已离职");
  });

  it("审计日志记录重置和修改密码,里面没有任何密码", async () => {
    const auditStore = new MemoryAuditStore();
    const { auth, aliceWithPassword } = setup(storeCase.createAuth(), new AuditLog(auditStore));
    const { initial, password } = await aliceWithPassword();
    const fresh = await auth.resetPassword(undefined, "dingtalk:alice");
    const events = (await auditStore.list({ limit: 100 })).reverse();
    expect(events.map((e) => [e.action, e.actorId])).toEqual([
      ["password.reset", "dingtalk:admin"],
      ["password.change", "dingtalk:alice"],
      ["password.reset", undefined],
    ]);
    expect(events[2]?.detail).toEqual({ userId: "dingtalk:alice", name: "Alice", via: "cli" });
    const text = JSON.stringify(events);
    for (const secret of [initial, password, fresh]) expect(text).not.toContain(secret);
  });

  it("登录会话 7 天后过期;退出后失效", async () => {
    const { auth, time, aliceWithPassword } = setup(storeCase.createAuth());
    const { sessionToken } = await aliceWithPassword();
    time.advance(7 * 24 * 3600_000 - 1000);
    expect(await auth.sessionUser(sessionToken)).toBe("dingtalk:alice");
    time.advance(2000);
    expect(await auth.sessionUser(sessionToken)).toBeUndefined();

    const second = await auth.login("13800000001", "alice-own-pass");
    if (second.kind !== "session") throw new Error();
    await auth.logout(second.sessionToken);
    expect(await auth.sessionUser(second.sessionToken)).toBeUndefined();
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
    const { auth, directory, aliceWithPassword } = setup(storeCase.createAuth());
    const { sessionToken } = await aliceWithPassword();
    const { token } = await auth.createToken("dingtalk:alice", "agent");

    directory.replace(org({ aliceActive: false }));
    expect(await auth.sessionUser(sessionToken)).toBeUndefined();
    expect(await auth.tokenUser(token)).toBeUndefined();
    await expect(auth.login("13800000001", "alice-own-pass")).rejects.toThrow("账号或密码不正确");
  });
});

/** 起一个完整的服务,用 fastify 的 inject 发请求 */
async function server(options: { devAuth?: boolean; adminIds?: string[] } = {}) {
  const directory = new MemoryDirectory();
  const orgStore = new MemoryOrgStore();
  await orgStore.update(() => org());
  const adapters = { ...createFakeAdapters(), directory };
  const store = new MemoryStore();
  const service = new PublisherService(store, new Engine(store, adapters, { maxFixAttempts: 3 }), adapters, {
    appsDomain: "apps.test",
    maxAppsPerUser: 5,
    publicUrl: "http://ferry.test",
    uploadTtlMs: 60_000,
    secretBox: SecretBox.random(),
  });
  const auth = new AuthService(new MemoryAuthStore(), directory);
  const organization = new Organization(orgStore, directory, new AuditLog(new MemoryAuditStore(), directory), {
    fixedAdmins: new Set(options.adminIds),
    onDeactivate: async (id) => void (await auth.endAccess(id)),
  });
  await organization.reload();
  const allowedOrigins = new Set(["http://ferry.test"]);
  const identity = createIdentity({ auth, directory, adminIds: new Set(options.adminIds), devAuth: options.devAuth ?? false, allowedOrigins });
  const app = buildServer(service, identity, {
    maxArchiveBytes: 1024 * 1024,
    auth: { service: auth, directory, organization, routes: { allowedOrigins, secureCookie: false } },
  });
  app.log.level = "silent";
  const ORIGIN = { origin: "http://ferry.test" };

  /** 走一遍网页登录:管理员生成初始密码,本人登录、改密码,返回 cookie 头 */
  async function login(account = "13800000001"): Promise<string> {
    const userId = await directory.findLogin(account);
    const initial = await auth.resetPassword(undefined, userId!);
    const first = await app.inject({ method: "POST", url: "/auth/login", headers: ORIGIN, payload: { account, password: initial } });
    expect(first.statusCode).toBe(200);
    expect(first.headers["set-cookie"]).toBeUndefined();
    const { ticket } = first.json();
    const changed = await app.inject({
      method: "POST",
      url: "/auth/change-password",
      headers: ORIGIN,
      payload: { ticket, newPassword: "own-password-1" },
    });
    expect(changed.statusCode).toBe(200);
    const setCookie = String(changed.headers["set-cookie"]);
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
    const { app, login } = await server();
    const cookie = await login();
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    expect(me.json()).toEqual({ id: "dingtalk:alice", name: "Alice", isAdmin: false });
  });

  it("用 cookie 发修改请求时,来源必须是 Ferry 自己;员工应用里伪造的请求被拒绝", async () => {
    const { app, login, ORIGIN } = await server();
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
    const loginForged = await app.inject({ method: "POST", url: "/auth/login", headers: { origin: "http://evil.apps.test" }, payload: { account: "13800000001", password: "x" } });
    expect(loginForged.statusCode).toBe(403);
  });

  it("MCP 只认个人令牌,不认 cookie;作废后立即不能用", async () => {
    const { app, login, ORIGIN } = await server();
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
    const { app, login, ORIGIN } = await server();
    const cookie = await login();
    const { token } = (await app.inject({ method: "POST", url: "/api/tokens", headers: { cookie, ...ORIGIN }, payload: {} })).json();
    const viaToken = await app.inject({ method: "POST", url: "/api/tokens", headers: { authorization: `Bearer ${token}` }, payload: {} });
    expect(viaToken.statusCode).toBe(403);
  });

  it("应用密钥只能用网页登录管理:个人令牌(agent)查、设、删都被拒绝;返回里没有值", async () => {
    const { app, login, ORIGIN } = await server();
    const cookie = await login();
    await app.inject({ method: "POST", url: "/api/apps/prepare", headers: { cookie, ...ORIGIN }, payload: { name: "ledger" } });
    const base = "/api/apps/ledger/secrets";

    const set = await app.inject({ method: "POST", url: base, headers: { cookie, ...ORIGIN }, payload: { name: "LLM_API_KEY", value: "sk-hidden-value" } });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual([{ name: "LLM_API_KEY", updatedAt: expect.any(String) }]);
    expect(set.body).not.toContain("sk-hidden");
    const list = await app.inject({ method: "GET", url: base, headers: { cookie } });
    expect(list.json()).toEqual(set.json());
    expect(list.body).not.toContain("sk-hidden");

    // 员工应用里伪造的请求被拒绝
    const forged = await app.inject({ method: "POST", url: base, headers: { cookie, origin: "http://evil.apps.test" }, payload: { name: "X", value: "y" } });
    expect(forged.statusCode).toBe(403);

    const { token } = (await app.inject({ method: "POST", url: "/api/tokens", headers: { cookie, ...ORIGIN }, payload: { label: "agent" } })).json();
    const authorization = `Bearer ${token}`;
    // 令牌本身可以用普通接口,但不能碰密钥
    expect((await app.inject({ method: "GET", url: "/api/apps", headers: { authorization } })).statusCode).toBe(200);
    const viaToken = [
      await app.inject({ method: "GET", url: base, headers: { authorization } }),
      await app.inject({ method: "POST", url: base, headers: { authorization }, payload: { name: "LLM_API_KEY", value: "from-agent" } }),
      await app.inject({ method: "POST", url: `${base}/LLM_API_KEY/delete`, headers: { authorization } }),
      // 同时带了 cookie 也不行
      await app.inject({ method: "POST", url: base, headers: { authorization, cookie, ...ORIGIN }, payload: { name: "LLM_API_KEY", value: "from-agent" } }),
    ];
    for (const res of viaToken) {
      expect(res.statusCode).toBe(403);
      expect(res.json().message).toContain("控制台网页");
    }

    const bad = await app.inject({ method: "POST", url: base, headers: { cookie, ...ORIGIN }, payload: { name: "PORT", value: "1" } });
    expect(bad.statusCode).toBe(400);
    const deleted = await app.inject({ method: "POST", url: `${base}/LLM_API_KEY/delete`, headers: { cookie, ...ORIGIN } });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual([]);
  });

  it("人员管理只有管理员能用,而且只能用网页登录;返回里有密码状态,没有哈希", async () => {
    const { app, login, ORIGIN } = await server({ adminIds: ["dingtalk:bob"] });
    const alice = await login();
    const forbidden = await app.inject({ method: "GET", url: "/api/admin/org", headers: { cookie: alice } });
    expect(forbidden.statusCode).toBe(403);
    const forbiddenReset = await app.inject({ method: "POST", url: "/api/admin/users/dingtalk:bob/reset-password", headers: { cookie: alice, ...ORIGIN } });
    expect(forbiddenReset.statusCode).toBe(403);
    const forbiddenCreate = await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: alice, ...ORIGIN },
      payload: { name: "X", mobile: "13800000009", departmentIds: ["dingtalk:finance"] },
    });
    expect(forbiddenCreate.statusCode).toBe(403);

    const bob = await login("13800000002");
    const res = await app.inject({ method: "GET", url: "/api/admin/org", headers: { cookie: bob } });
    expect(res.statusCode).toBe(200);
    const { users, departments } = res.json() as { users: { id: string; password: string; isAdmin: boolean; fixedAdmin: boolean }[]; departments: unknown[] };
    expect(departments.length).toBeGreaterThan(0);
    expect(users.find((u) => u.id === "dingtalk:alice")).toMatchObject({ password: "set", isAdmin: false });
    expect(users.find((u) => u.id === "dingtalk:bob")).toMatchObject({ isAdmin: true, fixedAdmin: true });
    expect(JSON.stringify(users)).not.toContain("scrypt");

    const reset = await app.inject({ method: "POST", url: "/api/admin/users/dingtalk:alice/reset-password", headers: { cookie: bob, ...ORIGIN } });
    expect(reset.json().password).toMatch(/^\w{4}-\w{4}-\w{4}$/);
    // Alice 原来的登录失效
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: alice } })).statusCode).toBe(401);

    // 管理员的个人令牌不能用来管理人员
    const { token } = (await app.inject({ method: "POST", url: "/api/tokens", headers: { cookie: bob, ...ORIGIN }, payload: {} })).json();
    const viaToken = await app.inject({ method: "POST", url: "/api/admin/users/dingtalk:alice/reset-password", headers: { authorization: `Bearer ${token}` } });
    expect(viaToken.statusCode).toBe(403);
    const deactivateViaToken = await app.inject({ method: "POST", url: "/api/admin/users/dingtalk:alice/deactivate", headers: { authorization: `Bearer ${token}` } });
    expect(deactivateViaToken.statusCode).toBe(403);
  });

  it("管理员在控制台新建的人能登录;标记离职后登录会话和个人令牌立即失效;设为管理员后能进管理接口", async () => {
    const { app, login, ORIGIN } = await server({ adminIds: ["dingtalk:bob"] });
    const bob = await login("13800000002");
    const post = (url: string, payload: Record<string, unknown> = {}) => app.inject({ method: "POST", url, headers: { cookie: bob, ...ORIGIN }, payload });

    const created = await post("/api/admin/users", { name: "Dan", mobile: "13800000006", departmentIds: ["dingtalk:finance"] });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();
    const bad = await post("/api/admin/users", { name: "Dup", mobile: "13800000006", departmentIds: ["dingtalk:finance"] });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().message).toContain("手机号和在职的 Dan 重复");

    const dan = await login("13800000006");
    const { token } = (await app.inject({ method: "POST", url: "/api/tokens", headers: { cookie: dan, ...ORIGIN }, payload: {} })).json();
    expect((await app.inject({ method: "GET", url: "/api/admin/org", headers: { cookie: dan } })).statusCode).toBe(403);
    expect((await post(`/api/admin/users/${encodeURIComponent(id)}/admin`, { isAdmin: true })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/admin/org", headers: { cookie: dan } })).statusCode).toBe(200);

    expect((await post(`/api/admin/users/${encodeURIComponent(id)}/deactivate`)).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: dan } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    const relogin = await app.inject({ method: "POST", url: "/auth/login", headers: ORIGIN, payload: { account: "13800000006", password: "own-password-1" } });
    expect(relogin.statusCode).toBe(401);

    // 恢复在职后旧密码和旧令牌都不能用:密码和令牌在离职时已作废,要重新生成初始密码
    expect((await post(`/api/admin/users/${encodeURIComponent(id)}/reactivate`)).statusCode).toBe(200);
    const afterReactivate = await app.inject({ method: "POST", url: "/auth/login", headers: ORIGIN, payload: { account: "13800000006", password: "own-password-1" } });
    expect(afterReactivate.statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    const org = (await app.inject({ method: "GET", url: "/api/admin/org", headers: { cookie: bob } })).json() as { users: { id: string; password: string }[] };
    expect(org.users.find((u) => u.id === id)?.password).toBe("none");
    await login("13800000006");
  });

  it("已登录时改密码:换一个新 cookie,旧的失效;令牌不能用来改密码", async () => {
    const { app, login, ORIGIN } = await server();
    const cookie = await login();
    const changed = await app.inject({
      method: "POST",
      url: "/api/me/password",
      headers: { cookie, ...ORIGIN },
      payload: { currentPassword: "own-password-1", newPassword: "own-password-2" },
    });
    expect(changed.statusCode).toBe(200);
    const fresh = String(changed.headers["set-cookie"]).split(";")[0]!;
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/me", headers: { cookie: fresh } })).statusCode).toBe(200);

    const { token } = (await app.inject({ method: "POST", url: "/api/tokens", headers: { cookie: fresh, ...ORIGIN }, payload: {} })).json();
    const viaToken = await app.inject({
      method: "POST",
      url: "/api/me/password",
      headers: { authorization: `Bearer ${token}` },
      payload: { currentPassword: "own-password-2", newPassword: "own-password-3" },
    });
    expect(viaToken.statusCode).toBe(403);
  });

  it("关闭开发身份时,只带 x-ferry-user 请求头会被拒绝", async () => {
    const { app } = await server({ devAuth: false });
    const res = await app.inject({ method: "GET", url: "/api/apps", headers: { "x-ferry-user": "dingtalk:alice" } });
    expect(res.statusCode).toBe(401);
  });

  it("开启开发身份时,带了无效凭据也不会退回去用请求头", async () => {
    const { app } = await server({ devAuth: true });
    const header = { "x-ferry-user": "dingtalk:alice" };
    expect((await app.inject({ method: "GET", url: "/api/apps", headers: header })).statusCode).toBe(200);
    const badToken = await app.inject({ method: "GET", url: "/api/apps", headers: { ...header, authorization: "Bearer fry_garbage" } });
    expect(badToken.statusCode).toBe(401);
    const badCookie = await app.inject({ method: "GET", url: "/api/apps", headers: { ...header, cookie: "ferry_session=garbage" } });
    expect(badCookie.statusCode).toBe(401);
  });

  it("登录页可以打开;旧的令牌页和管理页地址跳到控制台", async () => {
    const { app } = await server();
    expect((await app.inject({ method: "GET", url: "/login" })).body).toContain("登录 Ferry");
    const me = await app.inject({ method: "GET", url: "/me" });
    expect([me.statusCode, me.headers.location]).toEqual([302, "/console/tokens"]);
    const admin = await app.inject({ method: "GET", url: "/admin" });
    expect([admin.statusCode, admin.headers.location]).toEqual([302, "/console/admin"]);
  });

  it("管理接口:只有管理员能看全部应用(含负责人姓名和部门名),停用要同源请求,停用后列表显示原因", async () => {
    const { app, login, ORIGIN, service } = await server({ adminIds: ["dingtalk:alice"] });

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

