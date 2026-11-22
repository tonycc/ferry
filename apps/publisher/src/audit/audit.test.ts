import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeAdapters } from "../adapters/fake";
import { AuthService } from "../auth/service";
import type { OrgSnapshot } from "../org/snapshot";
import { SecretBox } from "../secrets";
import { PublisherService } from "../service";
import { storeCases, type StoreCase } from "../test/stores";
import { appZip } from "../test/zip";
import { Engine } from "../workflow/engine";
import { AuditLog } from "./log";
import type { AuditStore } from "./store";

const alice = { id: "dingtalk:alice", departments: ["dingtalk:finance"], isAdmin: false };
const bob = { id: "dingtalk:bob", departments: ["dingtalk:finance"], isAdmin: false };
const admin = { id: "dingtalk:root", departments: ["dingtalk:it"], isAdmin: true };
const MANIFEST = (name: string) => `name: ${name}\ntemplate: node-postgres\ndatabase: postgres\nmigrate: npm run migrate\n`;

function org(names: Record<string, string>): OrgSnapshot {
  return {
    departments: [
      { id: "dingtalk:root-dept", parentId: null, name: "示例公司" },
      { id: "dingtalk:finance", parentId: "dingtalk:root-dept", name: "财务部" },
      { id: "dingtalk:it", parentId: "dingtalk:root-dept", name: "信息部" },
    ],
    users: [alice, bob, admin].map((u) => ({
      id: u.id,
      name: names[u.id] ?? u.id,
      departmentIds: u.departments,
      active: true,
    })),
  } as OrgSnapshot;
}

let c: StoreCase;

function setup() {
  const store = c.create();
  const auditStore: AuditStore = c.createAudit();
  const adapters = createFakeAdapters();
  adapters.directory.replace(org({ [alice.id]: "Alice", [bob.id]: "Bob", [admin.id]: "管理员" }));
  const audit = new AuditLog(auditStore, adapters.directory);
  const secretBox = SecretBox.random();
  const service = new PublisherService(store, new Engine(store, adapters, { maxFixAttempts: 3, secretBox, audit }), adapters, {
    appsDomain: "apps.test",
    maxAppsPerUser: 5,
    publicUrl: "http://ferry.test",
    uploadTtlMs: 60_000,
    secretBox,
    audit,
  });

  async function publish(user: typeof alice, name: string, marker = "ok") {
    const prepared = await service.prepareApp(user, name);
    await service.receiveUpload(prepared.uploadUrl.split("/").pop()!, appZip(marker));
    const { releaseId } = await service.publish(user, { manifestYaml: MANIFEST(name), version: prepared.version });
    await service.settle(releaseId);
    return service.status(user, releaseId);
  }
  /** 全部记录,从旧到新 */
  const all = async () => (await auditStore.list({ limit: 1000 })).reverse();
  return { store, adapters, service, audit, auditStore, publish, all };
}

describe.each(storeCases("ferry_test_audit"))("审计日志:$name", (storeCase) => {
  beforeAll(() => storeCase.init());
  beforeEach(async () => {
    c = storeCase;
    await storeCase.reset();
  });
  afterAll(() => storeCase.close());

  it("发布:记录占用应用名、发起发布和发布结果,带操作人当时的姓名和应用负责人", async () => {
    const { publish, all } = setup();
    const view = await publish(alice, "ledger");

    const events = await all();
    expect(events.map((e) => e.action)).toEqual(["app.create", "app.publish", "release.finish"]);
    expect(events[0]).toMatchObject({ actorId: alice.id, actorName: "Alice", appName: "ledger", appOwnerId: alice.id });
    expect(events[1]?.detail).toMatchObject({ releaseId: view.releaseId });
    expect(events[1]?.detail).not.toHaveProperty("revived");
    // 发布结果由 Ferry 记录,没有操作人
    expect(events[2]).toMatchObject({ actorId: undefined, appOwnerId: alice.id });
    expect(events[2]?.detail).toMatchObject({ releaseId: view.releaseId, kind: "publish", state: "LIVE" });
  });

  it("发布失败:结果里有失败类型", async () => {
    const { adapters, publish, all } = setup();
    adapters.scanner.findings = [{ file: "a.ts", line: 1, rule: "sk-api-key", detail: "key" }];
    await publish(alice, "ledger");
    const finish = (await all()).find((e) => e.action === "release.finish");
    expect(finish?.detail).toMatchObject({ state: "FAILED_FIXABLE", errorType: "scan_failed" });
  });

  it("下线、重新发布(恢复)、停用、恢复:都有记录和操作人", async () => {
    const { service, publish, all } = setup();
    await publish(alice, "ledger");
    await service.unpublish(alice, "ledger");
    await publish(alice, "ledger", "again");
    await service.disableApp(admin, "ledger", "数据有问题");
    await service.enableApp(admin, "ledger");

    const events = (await all()).filter((e) => e.action !== "release.finish");
    expect(events.map((e) => [e.action, e.actorId])).toEqual([
      ["app.create", alice.id],
      ["app.publish", alice.id],
      ["app.unpublish", alice.id],
      ["app.publish", alice.id],
      ["app.disable", admin.id],
      ["app.enable", admin.id],
    ]);
    expect(events[3]?.detail).toMatchObject({ revived: true });
    expect(events[4]).toMatchObject({ actorName: "管理员", appOwnerId: alice.id, detail: { reason: "数据有问题" } });
  });

  it("没有改变状态的操作不记录:重复停用、重复恢复、可见范围没变", async () => {
    const { service, publish, all } = setup();
    await publish(alice, "ledger");
    await service.disableApp(admin, "ledger");
    await service.disableApp(admin, "ledger");
    await service.enableApp(admin, "ledger");
    await service.enableApp(admin, "ledger");
    await service.setVisibility(alice, "ledger", "self");
    const actions = (await all()).map((e) => e.action);
    expect(actions.filter((a) => a === "app.disable")).toHaveLength(1);
    expect(actions.filter((a) => a === "app.enable")).toHaveLength(1);
    expect(actions).not.toContain("app.visibility");
  });

  it("停用后停止服务出错:停用已经生效,也要有记录", async () => {
    const { adapters, service, publish, all } = setup();
    await publish(alice, "ledger");
    adapters.platform.stopApp = async () => {
      throw new Error("Dokploy 连不上");
    };
    await expect(service.disableApp(admin, "ledger", "紧急")).rejects.toThrow("Dokploy");
    expect((await all()).map((e) => e.action)).toContain("app.disable");
  });

  it("应用被彻底删除后记录还在;应用名被别人重新使用时,按负责人分得清", async () => {
    const { service, publish, audit, all } = setup();
    await publish(alice, "ledger");
    await service.disableApp(admin, "ledger");
    await service.deleteApp(admin, "ledger");
    await publish(bob, "ledger");

    const events = await all();
    expect(events.map((e) => e.action)).toContain("app.delete");
    const ledger = await audit.list({ appName: "ledger", limit: 100 });
    expect(new Set(ledger.map((e) => e.appOwnerId))).toEqual(new Set([alice.id, bob.id]));
    expect(ledger.filter((e) => e.action === "app.create").map((e) => e.appOwnerId).sort()).toEqual(
      [alice.id, bob.id].sort(),
    );
  });

  it("回滚、可见范围、密钥:密钥只记名称,值不出现在任何记录里", async () => {
    const { service, publish, all } = setup();
    await publish(alice, "ledger", "v1");
    await publish(alice, "ledger", "v2");
    await service.setVisibility(alice, "ledger", "department");
    await service.setSecret(alice, "ledger", "LLM_API_KEY", "super-secret-value-123");
    await service.deleteSecret(alice, "ledger", "LLM_API_KEY");
    const started = await service.rollback(alice, "ledger");
    await service.settle(started.releaseId);

    const events = await all();
    expect(events.find((e) => e.action === "app.visibility")?.detail).toEqual({ from: "self", to: "department" });
    expect(events.find((e) => e.action === "secret.set")?.detail).toEqual({ name: "LLM_API_KEY" });
    expect(events.find((e) => e.action === "secret.delete")?.detail).toEqual({ name: "LLM_API_KEY" });
    expect(events.find((e) => e.action === "app.rollback")?.detail).toMatchObject({
      releaseId: started.releaseId,
      fromVersion: started.from.version,
      toVersion: started.to.version,
    });
    expect(JSON.stringify(events)).not.toContain("super-secret-value-123");
  });

  it("审计记录写不进去时不影响操作本身:发布照常完成", async () => {
    const { auditStore, publish } = setup();
    auditStore.append = async () => {
      throw new Error("审计库写入失败");
    };
    const view = await publish(alice, "ledger");
    expect(view.state).toBe("LIVE");
  });

  it("第一次上线前按 app.yaml 设置的可见范围也有记录,操作人是发布的人", async () => {
    const { service, all } = setup();
    const prepared = await service.prepareApp(alice, "ledger");
    await service.receiveUpload(prepared.uploadUrl.split("/").pop()!, appZip("ok"));
    const { releaseId } = await service.publish(alice, {
      manifestYaml: MANIFEST("ledger") + "visibility: company\n",
      version: prepared.version,
    });
    await service.settle(releaseId);

    const visibility = (await all()).filter((e) => e.action === "app.visibility");
    expect(visibility).toHaveLength(1);
    expect(visibility[0]).toMatchObject({
      actorId: alice.id,
      detail: { from: "self", to: "company", source: "app.yaml", releaseId },
    });
  });

  it("删除时刚好有发布开始、删除中止:不留删除记录", async () => {
    const { store, service, publish, all } = setup();
    await publish(alice, "ledger");
    await service.unpublish(alice, "ledger");
    // 模拟:管理员把应用标记为停用的同时,负责人发起的一次发布刚好写进来
    const setAppDisabled = store.setAppDisabled.bind(store);
    store.setAppDisabled = async (name, disabled) => {
      await setAppDisabled(name, disabled);
      if (disabled) {
        const [last] = (await store.listReleases(name)).slice(-1);
        await store.saveRelease({ ...last!, id: crypto.randomUUID(), state: "PENDING", history: [] });
      }
    };
    await expect(service.deleteApp(admin, "ledger")).rejects.toThrow("刚刚开始");
    expect((await all()).map((e) => e.action)).not.toContain("app.delete");
  });

  it("操作人的姓名按记录当时保存,之后改名不影响", async () => {
    const { adapters, publish, all } = setup();
    await publish(alice, "ledger");
    adapters.directory.replace(org({ [alice.id]: "Alice Wang" }));
    expect((await all())[0]?.actorName).toBe("Alice");
  });

  it("个人令牌的生成和作废", async () => {
    const { adapters, audit, all } = setup();
    const auth = new AuthService(c.createAuth(), adapters.directory, {}, audit);
    const token = await auth.createToken(alice.id, "我的 agent");
    await auth.revokeToken(alice.id, token.id);
    await auth.revokeToken(alice.id, token.id);
    const events = await all();
    expect(events.map((e) => e.action)).toEqual(["token.create", "token.revoke"]);
    expect(events[0]).toMatchObject({ actorId: alice.id, detail: { tokenId: token.id, label: "我的 agent" } });
    expect(JSON.stringify(events)).not.toContain(token.token);
  });

  describe("查询", () => {
    it("只有管理员能查", async () => {
      const { service } = setup();
      await expect(service.listAudit(alice)).rejects.toThrow();
    });

    it("从新到旧分页,可以按应用、操作人、操作类型筛选,带负责人现在的姓名", async () => {
      const { service, publish } = setup();
      await publish(alice, "ledger");
      await publish(bob, "expense");
      await service.disableApp(admin, "expense");

      const first = await service.listAudit(admin, { limit: 2 });
      expect(first.events.map((e) => e.action)).toEqual(["app.disable", "release.finish"]);
      expect(first.events[0]).toMatchObject({ appName: "expense", appOwnerName: "Bob", actorName: "管理员" });
      expect(first.nextBefore).toBe(first.events[1]?.id);
      const second = await service.listAudit(admin, { limit: 100, before: first.nextBefore });
      expect(second.events).toHaveLength(5);
      expect(second.nextBefore).toBeUndefined();

      expect((await service.listAudit(admin, { app: "ledger" })).events.every((e) => e.appName === "ledger")).toBe(true);
      expect((await service.listAudit(admin, { actor: admin.id })).events.map((e) => e.action)).toEqual(["app.disable"]);
      expect((await service.listAudit(admin, { action: "app.create" })).events.map((e) => e.appName)).toEqual([
        "expense",
        "ledger",
      ]);
    });
  });
});
