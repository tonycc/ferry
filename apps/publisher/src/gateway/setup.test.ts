import { describe, expect, it } from "vitest";
import { createFakeAdapters } from "../adapters/fake";
import { PublisherService } from "../service";
import { Engine } from "../workflow/engine";
import { MemoryStore } from "../workflow/store";
import { setupGateway } from "./setup";
import { appZip } from "../test/zip";

const ZIP = appZip("v1");

async function setup() {
  const adapters = createFakeAdapters();
  adapters.directory.setUserDepartments("dingtalk:alice", ["dingtalk:finance"]);
  const store = new MemoryStore();
  const service = new PublisherService(store, new Engine(store, adapters, { maxFixAttempts: 3 }), adapters, {
    appsDomain: "apps.test",
    maxAppsPerUser: 5,
    publicUrl: "http://ferry.test",
    uploadTtlMs: 60_000,
  });
  const alice = { id: "dingtalk:alice", departments: ["dingtalk:finance"], isAdmin: false };
  async function publish(name: string, extra = "") {
    const prepared = await service.prepareApp(alice, name);
    await service.receiveUpload(prepared.uploadUrl.split("/").pop()!, ZIP);
    const { releaseId } = await service.publish(alice, { manifestYaml: `name: ${name}\ntemplate: node-postgres\n${extra}`, version: prepared.version });
    await service.settle(releaseId);
  }
  const logs: { level: string; message: string }[] = [];
  const log = { info: (m: string) => logs.push({ level: "info", message: m }), error: (m: string) => logs.push({ level: "error", message: m }) };
  return { adapters, store, service, publish, logs, log };
}

describe("setupGateway", () => {
  it("部署平台连不上时不抛错,记日志并安排重试;重试成功后再检查域名", async () => {
    const { adapters, service, log, logs } = await setup();
    const ensure = adapters.platform.ensureGateway.bind(adapters.platform);
    adapters.platform.ensureGateway = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const retries: (() => void)[] = [];
    const ok = await setupGateway(adapters.platform, service, "http://ferry/authz", log, { schedule: (retry) => retries.push(retry) });
    expect(ok).toBe(false);
    expect(retries).toHaveLength(1);
    expect(logs.at(-1)).toMatchObject({ level: "error" });

    adapters.platform.ensureGateway = ensure;
    retries[0]!();
    await new Promise((r) => setTimeout(r, 10));
    expect(adapters.platform.gatewayAddress).toBe("http://ferry/authz");
    expect(logs.at(-1)?.message).toContain("登录网关已就绪");
  });

  it("一个应用的域名设置失败,不影响其他应用", async () => {
    const { adapters, service, publish, log, logs } = await setup();
    await publish("ledger");
    await publish("crm");
    const attach = adapters.platform.attachDomain.bind(adapters.platform);
    const attached: string[] = [];
    adapters.platform.attachDomain = async (input) => {
      if (input.host.startsWith("ledger")) throw new Error("domain not found");
      attached.push(input.host);
      return attach(input);
    };
    expect(await setupGateway(adapters.platform, service, "http://ferry/authz", log)).toBe(true);
    expect(attached).toEqual(["crm.apps.test"]);
    expect(logs.some((l) => l.level === "error" && l.message.includes("ledger"))).toBe(true);
    expect(logs.at(-1)?.message).toContain("其中 1 个失败");
  });

  it("端口取最近一次发布的清单,即使那次没有上线;不猜默认端口", async () => {
    const { adapters, service, publish } = await setup();
    adapters.health.healthy = false;
    // 第一次发布在健康检查失败,没有上线版本,但域名已经按 8080 绑好
    await publish("ledger", "port: 8080\n");
    const ports: number[] = [];
    adapters.platform.attachDomain = async (input) => {
      ports.push(input.port);
    };
    await service.ensureDomains();
    expect(ports).toEqual([8080]);
  });

  it("把网关接入应用网络失败时重试;Traefik 管理接口开着时记一条错误日志提醒", async () => {
    const { adapters, service, log, logs } = await setup();
    let calls = 0;
    adapters.platform.ensureGatewayNetworks = async () => {
      if (++calls === 1) throw new Error("schedule failed");
      return { networks: 3, warnings: ["Traefik 的管理接口开着"] };
    };
    const retries: (() => void)[] = [];
    expect(await setupGateway(adapters.platform, service, "http://ferry/authz", log, { schedule: (retry) => retries.push(retry) })).toBe(false);
    expect(retries).toHaveLength(1);

    expect(await setupGateway(adapters.platform, service, "http://ferry/authz", log, { schedule: () => {} })).toBe(true);
    expect(logs.some((l) => l.level === "info" && l.message.includes("接入了 3 个应用网络"))).toBe(true);
    expect(logs.at(-1)).toEqual({ level: "error", message: "Traefik 的管理接口开着" });
  });
});

