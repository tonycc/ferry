import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakePlatform } from "../adapters/fake";
import { CertificateManager, type CertificateManagerOptions } from "./certificate-manager";
import type { ServedCertificate } from "./served";
import { MemorySetupStore } from "./store";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const ROOT = fixture("root.pem");
const CHAIN = fixture("chain.pem");
const KEY = fixture("leaf.key");
const LEAF_END = new Date("2036-11-22T01:34:02Z");
const NOW = new Date("2026-12-01T00:00:00Z");
const DOMAINS = ["ferry.example.com", "*.apps.example.com"];

function setup(overrides: Partial<CertificateManagerOptions> = {}) {
  const store = new MemorySetupStore();
  const platform = new FakePlatform();
  const state = { served: undefined as ServedCertificate | undefined, restarts: 0, audits: [] as string[], now: NOW };
  const manager = new CertificateManager({
    store,
    platform,
    publicUrl: "http://ferry.example.com",
    appsDomain: "apps.example.com",
    fixedByEnv: false,
    authAddress: "http://ferry-publisher:8080/authz",
    served: async () => state.served,
    restart: () => void state.restarts++,
    audit: async (actor, detail) => void state.audits.push(`${actor}:${JSON.stringify(detail)}`),
    trusted: [ROOT],
    now: () => state.now,
    verifyAttempts: 2,
    sleep: async () => {},
    ...overrides,
  });
  return { manager, store, platform, state };
}

describe("控制台的证书页", () => {
  it("还没有证书:none;Traefik 出示默认证书也算没有", async () => {
    const { manager, state } = setup();
    expect(await manager.status()).toMatchObject({ https: false, level: "none", ferryHost: "ferry.example.com" });
    state.served = { notAfter: new Date("2027-01-01"), domains: [], traefikDefault: true };
    expect((await manager.status()).level).toBe("none");
  });

  it("到期提醒:看 Traefik 实际出示的证书(手动装的也算);不到 30 天提醒一次,不到 7 天和过期后每次都提醒", async () => {
    const { manager, state } = setup({ publicUrl: "https://ferry.example.com", fixedByEnv: true });
    const sent: string[] = [];
    const send = async (m: string) => void sent.push(m);
    state.served = { notAfter: new Date("2027-03-01T00:00:00Z"), domains: DOMAINS, traefikDefault: false };
    expect(await manager.status()).toMatchObject({ level: "ok", daysLeft: 90 });
    await manager.remind(send);
    expect(sent).toHaveLength(0);

    state.now = new Date("2027-02-10T00:00:00Z");
    expect((await manager.status()).level).toBe("expiring");
    await manager.remind(send);
    await manager.remind(send);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("还有 19 天过期");

    state.now = new Date("2027-02-25T00:00:00Z");
    expect((await manager.status()).level).toBe("urgent");
    await manager.remind(send);
    await manager.remind(send);
    expect(sent).toHaveLength(3);

    state.now = new Date("2027-03-02T00:00:00Z");
    expect((await manager.status()).level).toBe("expired");
    await manager.remind(send);
    expect(sent.at(-1)).toContain("已经在 2027-03-01 过期");
  });

  it("补装(先用 HTTP 的):检查、安装、确认 Traefik 用上了,再切到 https 并重启;记审计", async () => {
    const { manager, store, platform, state } = setup();
    state.served = { notAfter: LEAF_END, domains: DOMAINS, traefikDefault: false };
    const result = await manager.install("admin-1", CHAIN, KEY);
    expect(result).toMatchObject({ ok: true, installed: true, switchedTo: "https://ferry.example.com" });
    expect(platform.calls).toEqual(["installCertificate:ferry-example.com"]);
    expect(platform.gatewayAddress).toBe("http://ferry-publisher:8080/authz");
    const settings = await store.getSettings();
    expect(settings).toMatchObject({ publicUrl: "https://ferry.example.com", appsDomain: "apps.example.com", appsUrlScheme: "https" });
    expect(settings.httpsSince).toEqual(NOW);
    expect(settings.certificate?.notAfter).toEqual(LEAF_END);
    expect(state.restarts).toBe(1);
    expect(state.audits[0]).toContain('"switchedToHttps":true');
    expect(JSON.stringify(settings)).not.toContain("PRIVATE KEY");
    expect(await manager.info()).toEqual({ https: false, httpsSince: NOW });
  });

  it("地址写在 .env 里:装好但不切换,提示去改 .env", async () => {
    const { manager, store, state } = setup({ fixedByEnv: true });
    state.served = { notAfter: LEAF_END, domains: DOMAINS, traefikDefault: false };
    const result = await manager.install("admin-1", CHAIN, KEY);
    expect(result.installed).toBe(true);
    expect(result.switchedTo).toBeUndefined();
    expect(result.items.at(-1)).toMatchObject({ key: "switch", state: "warn" });
    expect((await store.getSettings()).publicUrl).toBeUndefined();
    expect(state.restarts).toBe(0);
  });

  it("Traefik 出示的还是另一张(Dokploy 里有覆盖同样域名的旧证书):不算装好,不切换", async () => {
    const { manager, state } = setup();
    state.served = { notAfter: new Date("2027-01-01"), domains: DOMAINS, traefikDefault: false };
    const result = await manager.install("admin-1", CHAIN, KEY);
    expect(result).toMatchObject({ ok: false, installed: false });
    expect(result.items.at(-1)?.message).toContain("删掉它");
    expect(state.restarts).toBe(0);
    expect(state.audits).toEqual([]);
  });

  it("证书不覆盖这两个域名:不装", async () => {
    const { manager, platform } = setup({ appsDomain: "apps.other.com" });
    const result = await manager.install("admin-1", CHAIN, KEY);
    expect(result.ok).toBe(false);
    expect(platform.calls).toEqual([]);
  });
});

describe("读出 Traefik 出示的证书", () => {
  it("按 SNI 连 https 入口,读出到期时间和域名;连不上时 undefined", async () => {
    const { createServer } = await import("node:https");
    const { servedCertificate } = await import("./served");
    const server = createServer({ cert: CHAIN, key: KEY }, (_req, res) => res.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      expect(await servedCertificate("127.0.0.1", port, "ferry.example.com")).toEqual({
        notAfter: LEAF_END,
        domains: DOMAINS,
        traefikDefault: false,
      });
    } finally {
      server.close();
    }
    expect(await servedCertificate("127.0.0.1", 1, "ferry.example.com", 500)).toBeUndefined();
  });
});

describe("证书页的接口", () => {
  async function app(isAdmin: boolean) {
    const { buildServer } = await import("../api/server");
    const { createFakeAdapters } = await import("../adapters/fake");
    const { PublisherService } = await import("../service");
    const { Engine } = await import("../workflow/engine");
    const { MemoryStore } = await import("../workflow/store");
    const adapters = createFakeAdapters();
    const workflow = new MemoryStore();
    const service = new PublisherService(workflow, new Engine(workflow, adapters, { maxFixAttempts: 3 }), adapters, {
      appsDomain: "apps.example.com",
      maxAppsPerUser: 5,
      publicUrl: "http://ferry.example.com",
      uploadTtlMs: 60_000,
    });
    const channels: string[] = [];
    const server = buildServer(
      service,
      async (_req, channel) => (channels.push(channel), { id: "u1", departments: [], isAdmin }),
      { maxArchiveBytes: 1024, certificates: setup().manager },
    );
    server.log.level = "silent";
    return { server, channels };
  }

  it("只有管理员能看和装;上传要在控制台网页上做;是不是 https 所有登录的人都能看", async () => {
    const user = await app(false);
    expect((await user.server.inject({ method: "GET", url: "/api/admin/certificate" })).statusCode).toBe(403);
    expect((await user.server.inject({ method: "GET", url: "/api/instance" })).json()).toEqual({ https: false });

    const admin = await app(true);
    expect((await admin.server.inject({ method: "GET", url: "/api/admin/certificate" })).json()).toMatchObject({ level: "none" });
    const bad = await admin.server.inject({ method: "POST", url: "/api/admin/certificate", payload: { certificate: "x", privateKey: "y" } });
    expect(bad.statusCode).toBe(200);
    expect(bad.json()).toMatchObject({ ok: false, installed: false });
    expect(admin.channels).toContain("console");
  });
});
