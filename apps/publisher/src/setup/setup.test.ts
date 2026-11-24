import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeAdapters } from "../adapters/fake";
import { buildServer } from "../api/server";
import { PublisherService } from "../service";
import { storeCases } from "../test/stores";
import { Engine } from "../workflow/engine";
import { MemoryStore } from "../workflow/store";
import { ensureSetupCode, generateSetupCode, normalizeSetupCode, removeSetupCodeFile } from "./code";
import { SETUP_COOKIE, SetupService } from "./service";
import { MemorySetupStore, type SetupStore } from "./store";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ferry-setup-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("设置码", () => {
  it("12 位,每 4 位一组,不含容易看错的字符", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateSetupCode();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(code).not.toMatch(/[01OIL]/);
    }
  });

  it("输入时不区分大小写,- 和空格可有可无", () => {
    expect(normalizeSetupCode(" abcd-efgh ijkm\n")).toBe("ABCDEFGHIJKM");
  });
});

for (const c of storeCases("ferry_test_setup")) {
  describe(`设置向导(${c.name})`, () => {
    let store: SetupStore;
    const logs: string[] = [];
    const log = (m: string) => void logs.push(m);

    beforeAll(() => c.init());
    afterAll(() => c.close());
    beforeEach(async () => {
      await c.reset();
      store = c.createSetup();
      logs.length = 0;
    });

    it("第一次启动生成设置码:明文只在 600 权限的文件里,数据库里只有哈希,日志里只有文件位置", async () => {
      const file = join(dir, "state", "setup-code");
      await ensureSetupCode(store, file, log);
      const code = (await readFile(file, "utf8")).trim();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const { setupCodeHash } = await store.getSettings();
      expect(setupCodeHash).toMatch(/^scrypt\$/);
      expect(setupCodeHash).not.toContain(normalizeSetupCode(code));
      expect(logs.join("\n")).toContain(file);
      expect(logs.join("\n")).not.toContain(code);
      expect(logs.join("\n")).not.toContain(normalizeSetupCode(code));
    });

    it("重启不换设置码;文件丢了或被改了就换一个新的", async () => {
      const file = join(dir, "setup-code");
      await ensureSetupCode(store, file, log);
      const first = await readFile(file, "utf8");
      await ensureSetupCode(store, file, log);
      expect(await readFile(file, "utf8")).toBe(first);

      await rm(file);
      await ensureSetupCode(store, file, log);
      const second = await readFile(file, "utf8");
      expect(second).not.toBe(first);

      await writeFile(file, "AAAA-AAAA-AAAA\n");
      await ensureSetupCode(store, file, log);
      expect(await readFile(file, "utf8")).not.toBe("AAAA-AAAA-AAAA\n");
      expect((await stat(file)).mode & 0o777).toBe(0o600);

      await removeSetupCodeFile(file);
      await removeSetupCodeFile(file);
      await expect(stat(file)).rejects.toThrow();
    });

    it("设置码对了开向导会话,会话存在数据库里(换一个服务实例也认)", async () => {
      const file = join(dir, "setup-code");
      await ensureSetupCode(store, file, log);
      const code = await readFile(file, "utf8");
      const { token } = await new SetupService(store).verifyCode(code.toLowerCase());
      const restarted = new SetupService(c.createSetup());
      expect(await restarted.hasSession({ cookie: `${SETUP_COOKIE}=${token}` })).toBe(true);
      expect(await restarted.hasSession({ cookie: `${SETUP_COOKIE}=nope` })).toBe(false);
      expect(await restarted.hasSession({ cookie: `${SETUP_COOKIE}=nope; ${SETUP_COOKIE}=${token}` })).toBe(true);
      expect(await restarted.hasSession({})).toBe(false);
    });

    it("会话过期后无效", async () => {
      await ensureSetupCode(store, join(dir, "setup-code"), log);
      let now = new Date("2026-11-24T00:00:00Z");
      const service = new SetupService(store, { now: () => now });
      const { token } = await service.verifyCode(await readFile(join(dir, "setup-code"), "utf8"));
      now = new Date("2026-11-24T01:59:00Z");
      expect(await service.hasSession({ cookie: `${SETUP_COOKIE}=${token}` })).toBe(true);
      now = new Date("2026-11-24T02:00:01Z");
      expect(await service.hasSession({ cookie: `${SETUP_COOKIE}=${token}` })).toBe(false);
    });

    it("连续输错 5 次锁定 10 分钟,锁定期间对的设置码也不行", async () => {
      const file = join(dir, "setup-code");
      await ensureSetupCode(store, file, log);
      const code = await readFile(file, "utf8");
      let now = new Date("2026-11-24T00:00:00Z");
      const service = new SetupService(store, { now: () => now });
      for (let i = 0; i < 5; i++) await expect(service.verifyCode("AAAA-AAAA-AAAA")).rejects.toThrow("设置码不对");
      await expect(service.verifyCode(code)).rejects.toThrow(/10 分钟后再试/);
      now = new Date("2026-11-24T00:10:01Z");
      await expect(service.verifyCode(code)).resolves.toHaveProperty("token");
    });

    it("同时发来的多个猜测也受次数限制", async () => {
      await ensureSetupCode(store, join(dir, "setup-code"), log);
      const service = new SetupService(store);
      const results = await Promise.allSettled(Array.from({ length: 20 }, () => service.verifyCode("AAAA-AAAA-AAAA")));
      const wrong = results.filter((r) => r.status === "rejected" && String(r.reason).includes("设置码不对"));
      expect(wrong.length).toBeLessThanOrEqual(5);
    });

    it("还没有设置码时不能开会话", async () => {
      await expect(new SetupService(store).verifyCode("AAAA-AAAA-AAAA")).rejects.toThrow(/还没有生成设置码/);
    });
  });
}

describe("未初始化模式", () => {
  let initialized = false;
  let store: SetupStore;
  let code: string;

  function server() {
    const adapters = createFakeAdapters();
    const workflow = new MemoryStore();
    const service = new PublisherService(workflow, new Engine(workflow, adapters, { maxFixAttempts: 3 }), adapters, {
      appsDomain: "apps.test",
      maxAppsPerUser: 5,
      publicUrl: "http://ferry.test",
      uploadTtlMs: 60_000,
    });
    const app = buildServer(service, async () => ({ id: "u", departments: [], isAdmin: false }), {
      maxArchiveBytes: 1024,
      consoleDir: dir,
      setup: { service: new SetupService(store), initialized: () => initialized },
    });
    app.log.level = "silent";
    return app;
  }

  beforeEach(async () => {
    initialized = false;
    store = new MemorySetupStore();
    await ensureSetupCode(store, join(dir, "setup-code"), () => {});
    code = await readFile(join(dir, "setup-code"), "utf8");
  });

  it("只开放 /healthz 和 /api/setup/*,其余(含 /authz、上传、MCP、控制台)都返回 503", async () => {
    const app = server();
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/setup/status" })).json()).toEqual({ initialized: false, session: false });
    for (const [method, url] of [
      ["GET", "/"],
      ["GET", "/console/"],
      ["GET", "/api/apps"],
      ["POST", "/api/releases"],
      ["PUT", "/uploads/abc"],
      ["POST", "/mcp"],
      ["GET", "/authz"],
      ["GET", "/api/setup/../apps"],
      ["GET", "/API/SETUP/status"],
      ["GET", "/nope"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(503);
      expect(res.json().error).toBe("not_initialized");
    }
  });

  it("输入设置码:要同源;对了下发 HttpOnly、SameSite=Strict 的会话 cookie,https 时带 Secure", async () => {
    const app = server();
    const post = (headers: Record<string, string>, body: unknown) =>
      app.inject({ method: "POST", url: "/api/setup/code", headers: { host: "10.0.0.5", ...headers }, payload: body as object });

    expect((await post({}, { code })).statusCode).toBe(403);
    expect((await post({ origin: "https://evil.example" }, { code })).statusCode).toBe(403);
    expect((await post({ origin: "https://10.0.0.5" }, { code: "AAAA-AAAA-AAAA" })).statusCode).toBe(401);

    const ok = await post({ origin: "https://10.0.0.5", "x-forwarded-proto": "https" }, { code });
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers["set-cookie"]);
    expect(cookie).toMatch(new RegExp(`^${SETUP_COOKIE}=[\\w-]+; Path=/; HttpOnly; SameSite=Strict; Max-Age=7200; Secure$`));

    const token = cookie.split(";")[0];
    const status = await app.inject({ method: "GET", url: "/api/setup/status", headers: { cookie: token } });
    expect(status.json()).toEqual({ initialized: false, session: true });

    const plain = await post({ origin: "http://10.0.0.5" }, { code });
    expect(String(plain.headers["set-cookie"])).not.toContain("Secure");
  });

  it("完成初始化后向导的接口 404,其他照常", async () => {
    const app = server();
    initialized = true;
    expect((await app.inject({ method: "GET", url: "/api/setup/status" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/setup/code", payload: { code } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(302);
  });
});
