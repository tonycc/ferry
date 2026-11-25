import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeAdapters, FakePlatform } from "../adapters/fake";
import { buildServer, redactUrl } from "../api/server";
import { PublisherService } from "../service";
import { storeCases } from "../test/stores";
import { Engine } from "../workflow/engine";
import { MemoryStore } from "../workflow/store";
import { ensureSetupCode } from "./code";
import { SetupService } from "./service";
import { MemorySetupStore, type SetupStore } from "./store";
import { SetupWizard, type WizardOptions } from "./wizard";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const ROOT = fixture("root.pem");
const CHAIN = fixture("chain.pem");
const KEY = fixture("leaf.key");
const INSTANCE = "instance-1";
const INPUT = { domain: "Example.com", ferrySub: "ferry", appsSub: "apps", serverIp: "10.0.0.5" };

/** 假的 DNS 和 ping:records 里没有的名字解析不到;泛域名下的任何名字都按 *.apps.example.com 解析 */
function network() {
  const records = new Map<string, string[]>([
    ["ferry.example.com", ["10.0.0.5"]],
    ["*.apps.example.com", ["10.0.0.5"]],
  ]);
  const net = {
    records,
    /** http ping 的回答;undefined 表示请求不到 */
    httpAnswer: INSTANCE as string | undefined,
    /** https ping:第几次开始能拿到回答(模拟 Traefik 几秒后才加载证书) */
    httpsReadyAfter: 0,
    httpsCalls: 0,
    restarts: 0,
  };
  const options = (overrides: Partial<WizardOptions> = {}): WizardOptions => ({
    instanceId: INSTANCE,
    authAddress: "http://ferry-publisher:8080/authz",
    trusted: [ROOT],
    now: () => new Date("2026-12-01T00:00:00Z"),
    sleep: async () => {},
    verifyAttempts: 3,
    dns: {
      lookup: async (host) => records.get(host) ?? records.get(host.replace(/^[^.]+/, "*")) ?? [],
      ping: async () => net.httpAnswer,
    },
    httpsPing: async () => (++net.httpsCalls > net.httpsReadyAfter ? INSTANCE : undefined),
    restart: () => void net.restarts++,
    ...overrides,
  });
  return { net, options };
}

for (const c of storeCases("ferry_test_wizard")) {
  describe(`设置向导第 2 到 4 步(${c.name})`, () => {
    let store: SetupStore;
    let platform: FakePlatform;
    beforeAll(() => c.init());
    afterAll(() => c.close());
    beforeEach(async () => {
      await c.reset();
      store = c.createSetup();
      platform = new FakePlatform();
    });

    it("域名检测:两条记录都解析到服务器、请求能到这个 Ferry 才通过,通过后存下域名(还没生效)", async () => {
      const { options } = network();
      const wizard = new SetupWizard(store, platform, options());
      const result = await wizard.checkDomain(INPUT);
      expect(result.ok).toBe(true);
      expect(result.items.map((i) => i.state)).toEqual(["ok", "ok", "ok"]);
      expect(result.domain).toEqual({ domain: "example.com", ferryHost: "ferry.example.com", appsDomain: "apps.example.com", serverIp: "10.0.0.5" });
      const settings = await store.getSettings();
      expect(settings.wizard?.domain?.ferryHost).toBe("ferry.example.com");
      expect(settings.publicUrl).toBeUndefined();
    });

    it("域名检测:泛域名没加、解析到别的 IP、请求到不了,各自指出哪项不过,不保存", async () => {
      const { net, options } = network();
      const wizard = new SetupWizard(store, platform, options());

      net.records.delete("*.apps.example.com");
      let result = await wizard.checkDomain(INPUT);
      expect(result.ok).toBe(false);
      expect(result.items.find((i) => i.key === "apps")).toMatchObject({ state: "bad", message: "*.apps.example.com:没有记录" });
      expect(result.hint).toContain("*.apps");
      expect(result.items.some((i) => i.key === "reach")).toBe(false);

      net.records.set("*.apps.example.com", ["10.0.0.5"]);
      net.records.set("ferry.example.com", ["47.98.12.34"]);
      result = await wizard.checkDomain(INPUT);
      expect(result.items.find((i) => i.key === "ferry")?.message).toContain("应为 10.0.0.5");

      net.records.set("ferry.example.com", ["10.0.0.5"]);
      net.httpAnswer = undefined;
      result = await wizard.checkDomain(INPUT);
      expect(result.items.find((i) => i.key === "reach")).toMatchObject({ state: "bad", message: "请求到不了这台服务器" });

      net.httpAnswer = "another-ferry";
      result = await wizard.checkDomain(INPUT);
      expect(result.items.find((i) => i.key === "reach")?.message).toBe("请求到了另一个 Ferry");
      expect((await store.getSettings()).wizard?.domain).toBeUndefined();
    });

    it("域名格式不对:直接报错", async () => {
      const wizard = new SetupWizard(store, platform, network().options());
      await expect(wizard.checkDomain({ ...INPUT, domain: "example" })).rejects.toThrow(/公司域名/);
      await expect(wizard.checkDomain({ ...INPUT, appsSub: "ferry" })).rejects.toThrow(/不能一样/);
      await expect(wizard.checkDomain({ ...INPUT, serverIp: "10.0.0" })).rejects.toThrow(/服务器 IP/);
    });

    it("证书:没设域名不能传;检查通过后装进平台、重写网关配置触发加载、等 https 用上;记下证书,不存私钥", async () => {
      const { net, options } = network();
      const wizard = new SetupWizard(store, platform, options());
      await expect(wizard.installCertificate(CHAIN, KEY)).rejects.toThrow(/请先完成域名设置/);
      await wizard.checkDomain(INPUT);

      net.httpsReadyAfter = 1;
      const result = await wizard.installCertificate(CHAIN, KEY);
      expect(result.ok).toBe(true);
      expect(result.installed).toBe(true);
      expect(result.items.at(-1)).toMatchObject({ key: "install", state: "ok" });
      expect(platform.calls).toContain("installCertificate:ferry-example.com");
      // 装完重写网关配置,让 Traefik 加载新证书
      expect(platform.gatewayAddress).toBe("http://ferry-publisher:8080/authz");
      expect(net.httpsCalls).toBe(2);
      const settings = await store.getSettings();
      expect(settings.certificate).toMatchObject({ domains: ["ferry.example.com", "*.apps.example.com"] });
      expect(JSON.stringify(settings)).not.toContain("PRIVATE KEY");

      // 再传一次是原地替换同一张
      await wizard.installCertificate(CHAIN, KEY);
      expect(platform.certificates.size).toBe(1);
    });

    it("证书:检查不过不装;装了但一直用不上时报告没用上", async () => {
      const { net, options } = network();
      const wizard = new SetupWizard(store, platform, options());
      await wizard.checkDomain(INPUT);
      const bad = await wizard.installCertificate(fixture("chain-ferry-only.pem"), KEY);
      expect(bad.ok).toBe(false);
      expect(platform.certificates.size).toBe(0);

      net.httpsReadyAfter = 99;
      const notLoaded = await wizard.installCertificate(CHAIN, KEY);
      expect(notLoaded.ok).toBe(false);
      expect(notLoaded.installed).toBe(false);
      expect(notLoaded.items.at(-1)).toMatchObject({ key: "install", state: "bad" });
    });

    it("切换:要先装好覆盖域名的证书或者选择跳过;用证书时写 https 地址并要交接,跳过时写 http 地址不交接", async () => {
      const { net, options } = network();
      const wizard = new SetupWizard(store, platform, options());
      await wizard.checkDomain(INPUT);
      await expect(wizard.switchAddress()).rejects.toThrow(/还没有装好/);

      await wizard.skipCertificate();
      expect(await wizard.switchAddress()).toEqual({ publicUrl: "http://ferry.example.com", handoff: false });
      expect(net.restarts).toBe(1);
      const settings = await store.getSettings();
      expect(settings).toMatchObject({ publicUrl: "http://ferry.example.com", appsDomain: "apps.example.com", appsUrlScheme: "http" });
      // 切换后不能再改域名和证书
      await expect(wizard.checkDomain(INPUT)).rejects.toThrow(/已经切到正式地址/);
      await expect(wizard.issueHandoff()).rejects.toThrow(/不需要交接/);
    });

    it("撤销切换:清掉地址配置和交接令牌、重启;域名草稿和证书保留,可以改了再切换", async () => {
      const { net, options } = network();
      const wizard = new SetupWizard(store, platform, options());
      await expect(wizard.undoSwitch()).rejects.toThrow(/还没有切到正式地址/);
      await wizard.checkDomain(INPUT);
      await wizard.installCertificate(CHAIN, KEY);
      await wizard.switchAddress();
      await wizard.issueHandoff();
      await expect(wizard.checkDomain(INPUT)).rejects.toThrow(/先撤销切换/);

      await wizard.undoSwitch();
      expect(net.restarts).toBe(2);
      const settings = await store.getSettings();
      expect(settings.publicUrl).toBeUndefined();
      expect(settings.appsDomain).toBeUndefined();
      expect(settings.appsUrlScheme).toBeUndefined();
      expect(settings.wizard?.handoff).toBeUndefined();
      expect(settings.wizard?.domain?.ferryHost).toBe("ferry.example.com");
      expect(settings.certificate).toBeDefined();
      expect((await wizard.checkDomain(INPUT)).ok).toBe(true);
      expect(await wizard.switchAddress()).toEqual({ publicUrl: "https://ferry.example.com", handoff: true });
    });

    it("切换(用证书)后交接:令牌只能用一次,过期作废;只存哈希", async () => {
      let now = new Date("2026-12-01T00:00:00Z");
      const { options } = network();
      const wizard = new SetupWizard(store, platform, options({ now: () => now }));
      await wizard.checkDomain(INPUT);
      await wizard.installCertificate(CHAIN, KEY);
      expect(await wizard.switchAddress()).toEqual({ publicUrl: "https://ferry.example.com", handoff: true });

      const token = await wizard.issueHandoff();
      expect(JSON.stringify(await store.getSettings())).not.toContain(token);
      expect(await wizard.redeemHandoff("wrong")).toBe(false);
      expect(await wizard.redeemHandoff(token)).toBe(true);
      expect(await wizard.redeemHandoff(token)).toBe(false);

      const late = await wizard.issueHandoff();
      now = new Date(now.getTime() + 5 * 60_000 + 1);
      expect(await wizard.redeemHandoff(late)).toBe(false);
    });

    it("换了域名:之前“跳过证书”的选择作废", async () => {
      const { net, options } = network();
      const wizard = new SetupWizard(store, platform, options());
      await wizard.checkDomain(INPUT);
      await wizard.skipCertificate();
      net.records.set("ferry.corp.example.com", ["10.0.0.5"]);
      net.records.set("*.apps.corp.example.com", ["10.0.0.5"]);
      await wizard.checkDomain({ ...INPUT, domain: "corp.example.com" });
      expect((await wizard.status()).certificateSkipped).toBe(false);
    });
  });
}

describe("设置向导的接口", () => {
  let dir: string;
  let store: MemorySetupStore;
  let code: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ferry-wizard-"));
    store = new MemorySetupStore();
    await ensureSetupCode(store, join(dir, "setup-code"), () => {});
    code = await readFile(join(dir, "setup-code"), "utf8");
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  function server() {
    const adapters = createFakeAdapters();
    const workflow = new MemoryStore();
    const service = new PublisherService(workflow, new Engine(workflow, adapters, { maxFixAttempts: 3 }), adapters, {
      appsDomain: "apps.test",
      maxAppsPerUser: 5,
      publicUrl: "http://ferry.test",
      uploadTtlMs: 60_000,
    });
    const wizard = new SetupWizard(store, adapters.platform, network().options());
    const app = buildServer(service, async () => ({ id: "u", departments: [], isAdmin: false }), {
      maxArchiveBytes: 1024,
      consoleDir: dir,
      setup: { service: new SetupService(store), initialized: () => false, wizard, instanceId: INSTANCE },
    });
    app.log.level = "silent";
    return { app, wizard };
  }
  const headers = { host: "10.0.0.5", origin: "https://10.0.0.5", "x-forwarded-proto": "https" };

  async function login(app: ReturnType<typeof server>["app"]) {
    const res = await app.inject({ method: "POST", url: "/api/setup/code", headers, payload: { code } });
    return String(res.headers["set-cookie"]).split(";")[0]!;
  }

  it("向导页面:控制台构建过就用 setup.html,否则用服务器直出的简单页面;未初始化时只开放 /console/assets/ 下的文件", async () => {
    let { app } = server();
    expect((await app.inject({ method: "GET", url: "/setup" })).body).toContain("设置码");

    await writeFile(join(dir, "setup.html"), "<!doctype html><title>wizard</title>");
    await writeFile(join(dir, "index.html"), "<!doctype html><title>console</title>");
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "assets", "setup-abc.js"), "console.log(1)");
    ({ app } = server());
    const page = await app.inject({ method: "GET", url: "/setup" });
    expect(page.body).toContain("<title>wizard</title>");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect((await app.inject({ method: "GET", url: "/console/assets/setup-abc.js" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/console/assets/nope.js" })).statusCode).toBe(404);
    for (const url of ["/console/", "/console/apps", "/console/assets/../index.html", "/console/assets/%2e%2e/index.html"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode, url).not.toBe(200);
      expect(res.body, url).not.toContain("<title>console</title>");
    }
  });

  it("请求日志里去掉交接令牌", () => {
    expect(redactUrl("/setup?handoff=abc123")).toBe("/setup?handoff=<redacted>");
    expect(redactUrl("/setup?x=1&handoff=abc&y=2")).toBe("/setup?x=1&handoff=<redacted>&y=2");
    expect(redactUrl("/api/apps?handoffs=1")).toBe("/api/apps?handoffs=1");
  });

  it("ping 不要会话,返回本进程标识", async () => {
    const res = await server().app.inject({ method: "GET", url: "/api/setup/ping" });
    expect(res.json()).toEqual({ instance: INSTANCE });
  });

  it("status:有会话才给进度,并按打开向导的 IP 建议服务器 IP", async () => {
    const { app } = server();
    expect((await app.inject({ method: "GET", url: "/api/setup/status", headers })).json()).toEqual({ initialized: false, session: false });
    const cookie = await login(app);
    const body = (await app.inject({ method: "GET", url: "/api/setup/status", headers: { ...headers, cookie } })).json();
    expect(body).toMatchObject({ session: true, suggestedIp: "10.0.0.5", wizard: { certificateSkipped: false } });
  });

  it("修改类接口要同源、要会话", async () => {
    const { app } = server();
    const cookie = await login(app);
    const domain = (h: Record<string, string>) => app.inject({ method: "POST", url: "/api/setup/domain", headers: h, payload: INPUT });
    expect((await domain({ ...headers })).statusCode).toBe(401);
    expect((await domain({ ...headers, origin: "https://evil.example", cookie })).statusCode).toBe(403);
    const ok = await domain({ ...headers, cookie });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().ok).toBe(true);
    for (const url of ["/api/setup/certificate/skip", "/api/setup/switch", "/api/setup/handoff"]) {
      expect((await app.inject({ method: "POST", url, headers })).statusCode, url).toBe(401);
    }
  });

  it("交接:GET /setup?handoff= 只返回页面、不用掉令牌;页面用同源 POST 兑换,对了换成 Secure 会话,只能用一次", async () => {
    const { app, wizard } = server();
    await wizard.checkDomain(INPUT);
    await wizard.installCertificate(CHAIN, KEY);
    await wizard.switchAddress();
    const token = await wizard.issueHandoff();
    const formal = { host: "ferry.example.com", origin: "https://ferry.example.com", "x-forwarded-proto": "https" };

    // 链接预览、预取这类 GET 不会用掉令牌
    const page = await app.inject({ method: "GET", url: `/setup?handoff=${token}`, headers: formal });
    expect(page.statusCode).toBe(200);
    expect(page.headers["set-cookie"]).toBeUndefined();
    expect(page.headers["referrer-policy"]).toBe("no-referrer");

    const redeem = (h: Record<string, string>, t: string) =>
      app.inject({ method: "POST", url: "/api/setup/handoff/redeem", headers: h, payload: { token: t } });
    expect((await redeem({ ...formal, origin: "https://evil.example" }, token)).statusCode).toBe(403);
    expect((await redeem(formal, "nope")).statusCode).toBe(401);

    const ok = await redeem(formal, token);
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers["set-cookie"]);
    expect(cookie).toContain("Secure");
    const status = await app.inject({ method: "GET", url: "/api/setup/status", headers: { ...formal, cookie: cookie.split(";")[0]! } });
    expect(status.json().session).toBe(true);
    expect((await redeem(formal, token)).statusCode).toBe(401);
  });
});
