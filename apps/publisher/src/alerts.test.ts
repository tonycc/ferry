import { describe, expect, it } from "vitest";
import { createFakeAdapters, FakeNotifier } from "./adapters/fake";
import { Alerts } from "./alerts";
import { PublisherService } from "./service";
import { appZip } from "./test/zip";
import { Engine } from "./workflow/engine";
import { MemoryStore } from "./workflow/store";

const ADMINS = ["dingtalk:admin", "dingtalk:ops"];

function clock(start = Date.parse("2026-11-21T09:00:00Z")) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

describe("Alerts", () => {
  it("send:发给每个管理员,同时写进日志", async () => {
    const notifier = new FakeNotifier();
    const logs: string[] = [];
    await new Alerts(notifier, ADMINS, { log: (m) => logs.push(m) }).send("备份失败");
    expect(notifier.sent.map((s) => s.userId)).toEqual(ADMINS);
    expect(notifier.sent[0]?.message).toContain("备份失败");
    expect(logs.join("\n")).toContain("备份失败");
  });

  it("没有管理员:只写日志并说明没发出去", async () => {
    const notifier = new FakeNotifier();
    const logs: string[] = [];
    await new Alerts(notifier, [], { log: (m) => logs.push(m) }).send("备份失败");
    expect(notifier.sent).toEqual([]);
    expect(logs.join("\n")).toContain("ADMIN_USERS");
  });

  it("通知发送出错:不抛出,记日志,其他管理员照常收到", async () => {
    const notifier = new FakeNotifier();
    const notify = notifier.notify.bind(notifier);
    notifier.notify = async (userId, message) => {
      if (userId === ADMINS[0]) throw new Error("通知接口超时");
      return notify(userId, message);
    };
    const logs: string[] = [];
    await new Alerts(notifier, ADMINS, { log: (m) => logs.push(m) }).send("x");
    expect(notifier.sent.map((s) => s.userId)).toEqual([ADMINS[1]]);
    expect(logs.join("\n")).toContain("通知接口超时");
  });

  it("throttled:冷却期内只发一次,下一次发出时报告压下的次数和涉及的应用", async () => {
    const notifier = new FakeNotifier();
    const time = clock();
    const alerts = new Alerts(notifier, ["dingtalk:admin"], { cooldownMs: 30 * 60_000, now: time.now, log: () => {} });

    await alerts.throttled("platform_error", "应用 a 发布失败", "a");
    time.advance(60_000);
    await alerts.throttled("platform_error", "应用 b 发布失败", "b");
    await alerts.throttled("platform_error", "应用 c 发布失败", "c");
    // 不同的 key 不受影响
    await alerts.throttled("internal_error", "应用 d 发布失败", "d");
    expect(notifier.sent.map((s) => s.message)).toHaveLength(2);

    time.advance(30 * 60_000);
    await alerts.throttled("platform_error", "应用 e 发布失败", "e");
    const last = notifier.sent.at(-1)?.message ?? "";
    expect(last).toContain("应用 e 发布失败");
    expect(last).toContain("还有 2 次同类问题");
    expect(last).toContain("b、c");
  });

  it("flush:冷却期过了还没有新的同类告警,单独补发压下的部分;没有压下的不发", async () => {
    const notifier = new FakeNotifier();
    const time = clock();
    const alerts = new Alerts(notifier, ["dingtalk:admin"], { cooldownMs: 30 * 60_000, now: time.now, log: () => {} });
    await alerts.throttled("platform_error", "应用 a 发布失败", "a");
    await alerts.throttled("internal_error", "应用 x 发布失败", "x");
    time.advance(60_000);
    await alerts.throttled("platform_error", "应用 b 发布失败", "b");

    await alerts.flush();
    expect(notifier.sent).toHaveLength(2);

    time.advance(30 * 60_000);
    await alerts.flush();
    expect(notifier.sent).toHaveLength(3);
    expect(notifier.sent[2]?.message).toContain("还有 1 次同类问题,涉及 b");
    expect(notifier.sent[2]?.message).toContain("应用 a 发布失败");
    await alerts.flush();
    expect(notifier.sent).toHaveLength(3);
  });

  it("jobStatus:由好变坏时告警一次,一直失败不重复,恢复时再告诉一声", async () => {
    const notifier = new FakeNotifier();
    const alerts = new Alerts(notifier, ["dingtalk:admin"], { log: () => {} });
    await alerts.jobStatus("把网关接入应用网络");
    await alerts.jobStatus("把网关接入应用网络", "Traefik 容器不存在");
    await alerts.jobStatus("把网关接入应用网络", "Traefik 容器不存在");
    await alerts.jobStatus("把网关接入应用网络", "Traefik 容器不存在");
    await alerts.jobStatus("把网关接入应用网络");
    await alerts.jobStatus("把网关接入应用网络");
    expect(notifier.sent.map((s) => s.message)).toEqual([
      "【Ferry 告警】把网关接入应用网络失败:Traefik 容器不存在",
      "【Ferry 告警】把网关接入应用网络已恢复正常",
    ]);
  });
});

describe("发布流程里的告警", () => {
  const alice = { id: "dingtalk:alice", departments: ["dingtalk:finance"], isAdmin: false };
  const MANIFEST = "name: ledger\ntemplate: node-postgres\ndatabase: postgres\nmigrate: npm run migrate\n";

  function setup() {
    const store = new MemoryStore();
    const adapters = createFakeAdapters();
    adapters.directory.setUserDepartments(alice.id, alice.departments);
    // 负责人的通知和管理员的告警走同一个通知渠道,按收件人区分
    const alerts = new Alerts(adapters.notifier, ["dingtalk:admin"], { log: () => {} });
    const service = new PublisherService(store, new Engine(store, adapters, { maxFixAttempts: 3, alerts }), adapters, {
      appsDomain: "apps.test",
      maxAppsPerUser: 5,
      publicUrl: "http://ferry.test",
      uploadTtlMs: 60_000,
    });
    async function publish(marker: string) {
      const prepared = await service.prepareApp(alice, "ledger");
      await service.receiveUpload(prepared.uploadUrl.split("/").pop()!, appZip(marker));
      const { releaseId } = await service.publish(alice, { manifestYaml: MANIFEST, version: prepared.version });
      await service.settle(releaseId);
      return service.status(alice, releaseId);
    }
    const adminMessages = () =>
      adapters.notifier.sent.filter((s) => s.userId === "dingtalk:admin").map((s) => s.message);
    return { adapters, service, publish, adminMessages };
  }

  it("连续失败到上限:告警管理员,带应用、负责人和最近一次的错误;没到上限不告警", async () => {
    const { adapters, publish, adminMessages } = setup();
    adapters.platform.failDeployMarkers.add("broken");
    await publish("broken-1");
    await publish("broken-2");
    expect(adminMessages()).toEqual([]);

    const third = await publish("broken-3");
    expect(third.state).toBe("FAILED");
    expect(adminMessages()).toHaveLength(1);
    expect(adminMessages()[0]).toContain("ledger");
    expect(adminMessages()[0]).toContain("连续 3 次");
    expect(adminMessages()[0]).toContain("build_failed");
  });

  it("迁移前备份失败:发布终止、恢复上一版本、数据库不动,并告警管理员", async () => {
    const { adapters, publish, adminMessages } = setup();
    const v1 = await publish("v1");
    expect(v1.state).toBe("LIVE");

    adapters.platform.backupDatabase = async () => {
      throw new Error("磁盘已满");
    };
    const v2 = await publish("v2");

    expect(v2.state).toBe("FAILED");
    expect(v2.error?.type).toBe("backup_failed");
    expect(v2.error?.message).toContain("线上已恢复为上一个版本");
    expect(v2.error?.hint).toContain("不要修改代码");
    // 提示和下一步指引说法一致:都不让 agent 马上重新发布
    expect(v2.error?.hint).toContain("不要马上重新发布");
    expect(v2.nextAction).toContain("不要马上重新发布");
    expect(adapters.platform.calls.filter((c) => c.startsWith("runCommand"))).toHaveLength(1);
    // 线上部署的是 v1 的代码包
    const deployed = [...adapters.platform.deployedVersion.values()];
    expect(deployed).toHaveLength(1);
    expect(adminMessages()).toHaveLength(1);
    expect(adminMessages()[0]).toContain("备份数据库失败");
    expect(adminMessages()[0]).toContain("磁盘已满");
  });

  it("备份失败后恢复上一版本时直接出错:按恢复失败报,每次都告警", async () => {
    const { adapters, publish, adminMessages } = setup();
    await publish("v1");
    adapters.platform.backupDatabase = async () => {
      throw new Error("磁盘已满");
    };
    const deploy = adapters.platform.deploy.bind(adapters.platform);
    let deploys = 0;
    adapters.platform.deploy = async (...args) => {
      // 第一次是部署新版本,第二次是恢复上一版本
      if (++deploys === 2) throw new Error("Dokploy 连不上");
      return deploy(...args);
    };
    const view = await publish("v2");
    expect(view.error?.type).toBe("rollback_failed");
    expect(view.error?.message).toContain("迁移前备份数据库失败");
    expect(view.error?.message).toContain("Dokploy 连不上");
    expect(adminMessages()).toHaveLength(1);
    expect(adminMessages()[0]).toContain("恢复上一版本也失败");
  });

  it("第一次发布就备份失败:说明应用这次没有上线", async () => {
    const { adapters, publish, adminMessages } = setup();
    adapters.platform.backupDatabase = async () => {
      throw new Error("磁盘已满");
    };
    const view = await publish("v1");
    expect(view.error?.type).toBe("backup_failed");
    expect(view.error?.message).toContain("应用这次没有上线");
    expect(adminMessages()).toHaveLength(1);
  });

  it("部署平台出错:告警(按类型合并);代码问题和管理员停用不告警", async () => {
    const { adapters, service, publish, adminMessages } = setup();
    adapters.platform.failDeployMarkers.add("platform");
    adapters.platform.failDeployReason = "platform";
    const failed = await publish("platform-1");
    expect(failed.error?.type).toBe("platform_error");
    expect(adminMessages()).toHaveLength(1);
    expect(adminMessages()[0]).toContain("部署平台或 Ferry 出错");

    await publish("platform-2");
    expect(adminMessages()).toHaveLength(1);

    adapters.platform.failDeployMarkers.clear();
    adapters.scanner.findings = [{ file: "a.ts", line: 1, rule: "sk-api-key", detail: "key" }];
    await publish("scan");
    adapters.scanner.findings = [];
    await service.disableApp({ id: "dingtalk:root", departments: [], isAdmin: true }, "ledger");
    expect(adminMessages()).toHaveLength(1);
  });

  it("给管理员的告警发不出去:发布结果照常记下", async () => {
    const { adapters, publish } = setup();
    const notify = adapters.notifier.notify.bind(adapters.notifier);
    adapters.notifier.notify = async (userId, message) => {
      if (userId === "dingtalk:admin") throw new Error("通知接口超时");
      return notify(userId, message);
    };
    adapters.platform.failDeployMarkers.add("platform");
    adapters.platform.failDeployReason = "platform";
    const view = await publish("platform");
    expect(view.state).toBe("FAILED");
    expect(view.done).toBe(true);
    // 负责人的失败通知照常发出
    expect(adapters.notifier.sent.some((s) => s.userId === "dingtalk:alice" && s.message.includes("失败"))).toBe(true);
  });
});
