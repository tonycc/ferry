import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeAdapters } from "../adapters/fake";
import type { CommandResult, HealthResult } from "../adapters/types";
import { PublisherService } from "../service";
import { Engine } from "./engine";
import { storeCases, type StoreCase } from "../test/stores";
import { appZip } from "../test/zip";

const alice = { id: "alice", departments: ["finance"], isAdmin: false };
const bob = { id: "bob", departments: ["finance"], isAdmin: false };
const carol = { id: "carol", departments: ["sales"], isAdmin: false };
const admin = { id: "root", departments: ["it"], isAdmin: true };

const MANIFEST = "name: ledger\ntemplate: node-postgres\ndatabase: postgres\nmigrate: npm run migrate\n";

/** 一个只有 zip 文件头的假代码包;marker 用来让假平台按内容决定部署成败 */
function zipOf(marker: string): Buffer {
  return appZip(marker);
}

function tokenOf(uploadUrl: string): string {
  return uploadUrl.split("/").pop()!;
}

function setup(options: { uploadTtlMs?: number; archiveGraceMs?: number } = {}) {
  const store = storeCase.create();
  const adapters = createFakeAdapters();
  for (const user of [alice, bob, carol, admin]) adapters.directory.setUserDepartments(user.id, user.departments);
  /** 新建一套服务。用同一个存储和同一套外部系统再调用一次,就相当于 Ferry 进程重启 */
  const start = () =>
    new PublisherService(store, new Engine(store, adapters, { maxFixAttempts: 3 }), adapters, {
      appsDomain: "apps.test",
      maxAppsPerUser: 2,
      publicUrl: "http://ferry.test",
      uploadTtlMs: options.uploadTtlMs ?? 60_000,
      archiveGraceMs: options.archiveGraceMs,
    });
  const service = start();

  /** 申请上传地址、上传代码包、发起发布,不等发布结束 */
  async function startPublish(marker: string, extra = "") {
    const prepared = await service.prepareApp(alice, "ledger");
    await service.receiveUpload(tokenOf(prepared.uploadUrl), zipOf(marker));
    const { releaseId } = await service.publish(alice, {
      manifestYaml: MANIFEST + extra,
      version: prepared.version,
    });
    return { releaseId, version: prepared.version };
  }

  /** 走一遍 agent 的完整流程:申请上传地址、上传代码包、发布,并等发布结束 */
  async function publish(marker: string, extra = "") {
    const { releaseId, version } = await startPublish(marker, extra);
    await service.settle(releaseId);
    return { ...(await service.status(alice, releaseId)), version };
  }

  return { store, adapters, service, publish, startPublish, restart: start };
}

/** 访问者能否打开应用:和登录网关走同一条路(按域名找应用,再按可见范围判定) */
async function canSee(service: PublisherService, viewer: { id: string; departments: string[] }, host: string) {
  const app = await service.gatewayApp(host);
  return app !== undefined && (await service.canView(app, viewer));
}

let storeCase: StoreCase;

describe.each(storeCases("ferry_test_engine"))("存储:$name", (c) => {
  beforeAll(() => c.init());
  beforeEach(async () => {
    storeCase = c;
    await c.reset();
  });
  afterAll(() => c.close());

  describe("发布工作流", () => {
    it("首次发布:建库、注入连接串、绑定域名并上线", async () => {
      const { adapters, publish } = setup();

      const view = await publish("v1");

      expect(view.state).toBe("LIVE");
      expect(view.url).toBe("https://ledger.apps.test");
      expect(adapters.platform.env.get("app_2")?.DATABASE_URL).toContain("postgres://");
      expect(adapters.platform.calls).toContain("attachDomain:ledger.apps.test");
      expect(adapters.platform.deployedVersion.get("app_2")).toBe(view.version);
      // 连接串不能出现在返回给 agent 的内容里
      expect(JSON.stringify(view)).not.toContain("postgres://");
    });

    it("构建失败后重新发布:返回日志,且不会重复建库", async () => {
      const { adapters, publish } = setup();
      adapters.platform.failDeployMarkers.add("bad");

      const failed = await publish("bad");
      expect(failed.state).toBe("FAILED_FIXABLE");
      expect(failed.error?.type).toBe("build_failed");
      expect(failed.error?.logs).toContain("build failed");

      const fixed = await publish("good");
      expect(fixed.state).toBe("LIVE");
      expect(adapters.platform.calls.filter((c) => c.startsWith("createDatabase"))).toHaveLength(1);
      expect(adapters.platform.calls.filter((c) => c.startsWith("createApp"))).toHaveLength(1);
      expect(adapters.platform.calls.filter((c) => c.startsWith("createProject"))).toEqual(["createProject:ledger"]);
    });

    it("启动就崩溃和构建失败分开报告,提示 agent 看启动日志", async () => {
      const { adapters, publish } = setup();
      adapters.platform.failDeployMarkers.add("bad");
      adapters.platform.failDeployReason = "start";

      const failed = await publish("bad");
      expect(failed.state).toBe("FAILED_FIXABLE");
      expect(failed.error).toMatchObject({ stage: "BUILDING", type: "start_failed" });
      expect(failed.error?.message).toContain("一启动就退出");
      expect(failed.error?.hint).toContain("CMD");
    });

    it("更新后新版本启动即崩溃:把上一个版本部署回去,结果是 ROLLED_BACK", async () => {
      const { adapters, publish } = setup();
      const v1 = await publish("v1");
      adapters.platform.failDeployMarkers.add("crash");
      adapters.platform.failDeployReason = "start";

      const v2 = await publish("crash");
      expect(v2.state).toBe("ROLLED_BACK");
      expect(v2.error?.type).toBe("start_failed");
      expect(adapters.platform.deployedVersion.get("app_2")).toBe(v1.version);
    });

    it("更新时迁移失败:把上一个版本部署回去,结果是 ROLLED_BACK", async () => {
      const { adapters, publish } = setup();
      const v1 = await publish("v1");
      adapters.platform.failMigrate = true;

      const v2 = await publish("v2");
      expect(v2.state).toBe("ROLLED_BACK");
      expect(v2.error?.type).toBe("migration_failed");
      expect(adapters.platform.deployedVersion.get("app_2")).toBe(v1.version);
    });

    it("构建失败时线上版本没被动过,不重新部署上一个版本", async () => {
      const { adapters, publish } = setup();
      await publish("v1");
      adapters.platform.failDeployMarkers.add("bad");
      const deploys = () => adapters.platform.calls.filter((c) => c.startsWith("deploy:")).length;
      const before = deploys();

      expect((await publish("bad")).state).toBe("FAILED_FIXABLE");
      expect(deploys() - before).toBe(1);
    });

    it("部署平台的问题不算代码问题:直接结束,提示 agent 不要改代码,也不计入修复次数", async () => {
      const { adapters, publish } = setup();
      adapters.platform.failDeployMarkers.add("bad");
      adapters.platform.failDeployReason = "platform";

      const failed = await publish("bad");
      expect(failed.state).toBe("FAILED");
      expect(failed.error?.type).toBe("platform_error");
      expect(failed.error?.hint).toContain("不要修改代码");
    });

    it.each([
      [0, "没有响应", "127.0.0.1"],
      [502, "没有程序接受连接", "PORT"],
      [404, "没有这个路径", "healthcheck"],
      [500, "健康检查接口出错", "migrations"],
    ])("健康检查返回 %i 时给出对应的说明", async (status, message, hint) => {
      const { adapters, publish } = setup();
      adapters.health.healthy = false;
      adapters.health.status = status;

      const failed = await publish("v1");
      expect(failed.state).toBe("FAILED_FIXABLE");
      expect(failed.error?.type).toBe("healthcheck_failed");
      expect(failed.error?.message).toContain(message);
      expect(failed.error?.hint).toContain(hint);
    });

    it("可见范围:上线前按 app.yaml,上线后以控制台为准,app.yaml 不同时忽略并提醒 agent", async () => {
      const { service, publish, startPublish } = setup();
      expect((await publish("v1", "visibility: department\n")).state).toBe("LIVE");
      expect((await service.appDetail(alice, "ledger")).visibility).toBe("department");

      await service.setVisibility(alice, "ledger", "company");
      const { releaseId } = await startPublish("v2", "visibility: self\n");
      expect((await service.status(alice, releaseId)).notice).toBeUndefined();
      await service.settle(releaseId);
      const detail = await service.appDetail(alice, "ledger");
      expect(detail.visibility).toBe("company");
      expect(detail.visibilityPinned).toBe(true);
      expect(await canSee(service, carol, "ledger.apps.test")).toBe(true);
    });

    it("上线后发布时 app.yaml 的可见范围不同:发布结果里带 notice", async () => {
      const { service, publish } = setup();
      await publish("v1");
      const prepared = await service.prepareApp(alice, "ledger");
      await service.receiveUpload(tokenOf(prepared.uploadUrl), zipOf("v2"));
      const view = await service.publish(alice, { manifestYaml: MANIFEST + "visibility: company\n", version: prepared.version });
      expect(view.notice).toContain("已忽略");
      await service.settle(view.releaseId);
      expect((await service.appDetail(alice, "ledger")).visibility).toBe("self");
    });

    it("上线前在控制台改过可见范围,第一次发布也不会被 app.yaml 覆盖", async () => {
      const { service, publish } = setup();
      await service.prepareApp(alice, "ledger");
      await service.setVisibility(alice, "ledger", "department");
      await publish("v1", "visibility: company\n");
      expect((await service.appDetail(alice, "ledger")).visibility).toBe("department");
    });

    it("应用详情:发布历史最新的在前,标出线上版本和失败原因;别人看不到", async () => {
      const { adapters, service, publish } = setup();
      const v1 = await publish("v1");
      adapters.platform.failDeployMarkers.add("bad");
      await publish("bad");

      const detail = await service.appDetail(alice, "ledger");
      expect(detail).toMatchObject({ name: "ledger", port: 3000, healthcheck: "/healthz", database: "postgres", live: true });
      expect(detail.releases.map((r) => r.state)).toEqual(["FAILED_FIXABLE", "LIVE"]);
      expect(detail.releases[1]).toMatchObject({ version: v1.version, live: true, done: true });
      expect(detail.releases[0]).toMatchObject({ live: false, error: { type: "build_failed" } });
      expect(detail.releases[0]?.finishedAt).toBeDefined();
      expect(JSON.stringify(detail)).not.toContain("npm ERR");
      await expect(service.appDetail(bob, "ledger")).rejects.toThrow("不存在");
    });

    it("代码里有密钥:发布被拦截,不会建任何资源", async () => {
      const { adapters, publish } = setup();
      adapters.scanner.findings = [{ file: "config.js", detail: "疑似 API 密钥" }];

      const view = await publish("v1");

      expect(view.state).toBe("FAILED_FIXABLE");
      expect(view.error?.type).toBe("scan_failed");
      expect(view.error?.logs).toContain("config.js");
      expect(adapters.platform.calls).toHaveLength(0);
    });

    it("新版本健康检查失败:用保存的代码包回滚到上一个版本", async () => {
      const { adapters, publish } = setup();
      const v1 = await publish("v1");

      adapters.health.healthy = false;
      const v2 = await publish("v2");

      expect(v2.state).toBe("ROLLED_BACK");
      expect(adapters.platform.deployedVersion.get("app_2")).toBe(v1.version);
      expect(adapters.platform.calls).toContain("backupDatabase:db_3");
    });

    it("连续失败达到上限后不再让 agent 重试", async () => {
      const { adapters, publish } = setup();
      adapters.platform.failDeployMarkers.add("bad");

      expect((await publish("bad")).state).toBe("FAILED_FIXABLE");
      expect((await publish("bad")).state).toBe("FAILED_FIXABLE");
      const last = await publish("bad");
      expect(last.state).toBe("FAILED");
      expect(adapters.notifier.sent.at(-1)?.message).toContain("发布失败");
    });

    it("对全公司开放不需要审批,直接上线", async () => {
      const { service, publish } = setup();

      const view = await publish("v1", "visibility: company\n");

      expect(view.state).toBe("LIVE");
      expect(await canSee(service, carol, "ledger.apps.test")).toBe(true);
    });
  });

  describe("应用名和配额", () => {
    it("应用名被别人占用时拒绝;超出配额时拒绝;重复准备自己的应用不占配额", async () => {
      const { service } = setup();
      await service.prepareApp(alice, "ledger");
      await expect(service.prepareApp(bob, "ledger")).rejects.toThrow("已被其他人使用");

      await service.prepareApp(alice, "ledger");
      await service.prepareApp(alice, "second-app");
      await expect(service.prepareApp(alice, "third-app")).rejects.toThrow("最多 2 个在线的应用");
    });
  });

  describe("代码包上传", () => {
    it("上传地址只能用一次", async () => {
      const { service } = setup();
      const { uploadUrl } = await service.prepareApp(alice, "ledger");
      expect(uploadUrl).toMatch(/^http:\/\/ferry\.test\/uploads\/[0-9a-f]{64}$/);

      await service.receiveUpload(tokenOf(uploadUrl), zipOf("v1"));
      await expect(service.receiveUpload(tokenOf(uploadUrl), zipOf("v1"))).rejects.toThrow("已经用过了");
    });

    it("过期的、不存在的上传地址被拒绝", async () => {
      const { service } = setup({ uploadTtlMs: -1 });
      const { uploadUrl } = await service.prepareApp(alice, "ledger");

      await expect(service.receiveUpload(tokenOf(uploadUrl), zipOf("v1"))).rejects.toThrow("已过期");
      await expect(service.receiveUpload("0".repeat(64), zipOf("v1"))).rejects.toThrow("上传地址无效");
    });

    it("不是 zip 的内容被拒绝,且不消耗上传地址", async () => {
      const { service } = setup();
      const { uploadUrl } = await service.prepareApp(alice, "ledger");

      await expect(service.receiveUpload(tokenOf(uploadUrl), Buffer.from("not a zip"))).rejects.toThrow("不是 zip");
      await expect(service.receiveUpload(tokenOf(uploadUrl), zipOf("v1"))).resolves.toMatchObject({ app: "ledger" });
    });

    it("没有上传代码包就发布会被拒绝", async () => {
      const { service } = setup();
      const { version } = await service.prepareApp(alice, "ledger");

      await expect(service.publish(alice, { manifestYaml: MANIFEST, version })).rejects.toThrow("还没有收到");
      await expect(service.publish(alice, { manifestYaml: MANIFEST, version: "no-such-version" })).rejects.toThrow(
        "还没有收到",
      );
    });

    it("库里只保存令牌的哈希", async () => {
      const { store, service } = setup();
      const { uploadUrl, version } = await service.prepareApp(alice, "ledger");

      const ticket = await store.getUpload("ledger", version);
      expect(ticket?.tokenHash).toHaveLength(64);
      expect(ticket?.tokenHash).not.toBe(tokenOf(uploadUrl));
    });
  });

  describe("管理员停用", () => {
    it("停用后:停止服务、拒绝访问、禁止发布;恢复后可用", async () => {
      const { adapters, service, publish } = setup();
      await publish("v1", "visibility: department\n");
      expect(await canSee(service, bob, "ledger.apps.test")).toBe(true);

      await service.disableApp(admin, "ledger", "存放了客户隐私数据");

      expect(adapters.platform.stopped.has("app_2")).toBe(true);
      expect(await canSee(service, bob, "ledger.apps.test")).toBe(false);
      expect(await canSee(service, alice, "ledger.apps.test")).toBe(false);
      await expect(publish("v2")).rejects.toThrow("已被管理员停用");
      expect((await service.listApps(alice))[0]?.disabled).toBe(true);
      expect(adapters.notifier.sent.at(-1)).toEqual({
        userId: "alice",
        message: "应用 ledger 已被管理员停用,原因: 存放了客户隐私数据",
      });

      await service.enableApp(admin, "ledger");
      expect(adapters.platform.stopped.has("app_2")).toBe(false);
      expect(await canSee(service, bob, "ledger.apps.test")).toBe(true);
      expect((await publish("v2")).state).toBe("LIVE");
    });

    it("发布进行中被停用:发布终止,服务被停止", async () => {
      const { adapters, service, publish } = setup();
      // 在构建那一步模拟管理员同时停用了应用
      const deploy = adapters.platform.deploy.bind(adapters.platform);
      adapters.platform.deploy = async (appId, archive) => {
        await service.disableApp(admin, "ledger");
        return deploy(appId, archive);
      };

      const view = await publish("v1");

      expect(view.state).toBe("FAILED");
      expect(view.error?.type).toBe("app_disabled");
      expect(adapters.platform.stopped.has("app_2")).toBe(true);
      expect((await service.listApps(alice))[0]?.live).toBe(false);
    });

    it("非管理员不能停用应用,也不能查看全部应用", async () => {
      const { service } = setup();
      await service.prepareApp(alice, "ledger");
      await expect(service.disableApp(alice, "ledger")).rejects.toThrow("只有平台管理员");
      await expect(service.listAllApps(bob)).rejects.toThrow("只有平台管理员");
      expect(await service.listAllApps(admin)).toHaveLength(1);
    });
  });

  describe("域名", () => {
    it("改了端口后重新发布,域名跟着指向新端口;端口没变时不重复设置", async () => {
      const { adapters, publish } = setup();
      await publish("v1");
      await publish("v2");
      expect(adapters.platform.calls.filter((c) => c.startsWith("attachDomain"))).toHaveLength(1);
      await publish("v3", "port: 8080\n");
      expect(adapters.platform.domains.get("ledger.apps.test")).toBe(8080);
      expect(adapters.platform.calls.filter((c) => c.startsWith("attachDomain"))).toHaveLength(2);
    });
  });

  describe("回滚", () => {
    it("回到上一个上线过的版本:只部署代码和检查,不迁移、不备份、不改可见范围", async () => {
      const { adapters, service, store, publish } = setup();
      const v1 = await publish("v1");
      const v2 = await publish("v2");
      await service.setVisibility(alice, "ledger", "department");
      const migrationsBefore = adapters.platform.calls.filter((c) => c.startsWith("runCommand")).length;
      const backupsBefore = adapters.platform.calls.filter((c) => c.startsWith("backupDatabase")).length;

      const started = await service.rollback(alice, "ledger");
      expect(started.kind).toBe("rollback");
      expect(started.from.version).toBe(v2.version);
      expect(started.to.version).toBe(v1.version);
      await service.settle(started.releaseId);

      const view = await service.status(alice, started.releaseId);
      expect(view.state).toBe("LIVE");
      expect(view.nextAction).toContain("数据库没有回滚");
      const release = await store.getRelease(started.releaseId);
      expect(release?.history.map((h) => h.state)).toEqual(["PENDING", "BUILDING", "VERIFYING", "LIVE"]);
      expect(adapters.platform.deployedVersion.get("app_2")).toBe(v1.version);
      expect(adapters.platform.calls.filter((c) => c.startsWith("runCommand"))).toHaveLength(migrationsBefore);
      expect(adapters.platform.calls.filter((c) => c.startsWith("backupDatabase"))).toHaveLength(backupsBefore);
      const app = await store.getApp("ledger");
      expect(app?.liveVersion).toBe(v1.version);
      expect(app?.visibility).toBe("department");
    });

    it("回滚一次后再回滚,回到回滚前的版本", async () => {
      const { adapters, service, publish } = setup();
      await publish("v1");
      const v2 = await publish("v2");
      await service.settle((await service.rollback(alice, "ledger")).releaseId);
      const again = await service.rollback(alice, "ledger");
      expect(again.to.version).toBe(v2.version);
      await service.settle(again.releaseId);
      expect(adapters.platform.deployedVersion.get("app_2")).toBe(v2.version);
    });

    it("没有上一个版本、端口不同、不是负责人时拒绝", async () => {
      const { service, publish } = setup();
      await publish("v1");
      await expect(service.rollback(alice, "ledger")).rejects.toThrow("没有可以回滚的上一个版本");
      await expect(service.rollback(bob, "ledger")).rejects.toThrow("不存在");
      await publish("v2", "port: 8080\n");
      await expect(service.rollback(alice, "ledger")).rejects.toThrow("端口");
    });

    it("回滚失败时线上仍是原来的版本,结果是 FAILED,提示 agent 不要改代码", async () => {
      const { adapters, service, publish } = setup();
      await publish("v1");
      const v2 = await publish("v2");
      adapters.health.healthy = false;
      const started = await service.rollback(alice, "ledger");
      await service.settle(started.releaseId);
      const view = await service.status(alice, started.releaseId);
      expect(view.state).toBe("FAILED");
      expect(view.error?.message).toContain("线上仍是原来的版本");
      expect(view.error?.hint).toContain("不要修改代码");
      expect(adapters.platform.deployedVersion.get("app_2")).toBe(v2.version);
    });
  });

  describe("下线", () => {
    it("下线后无法访问、数据库停止、不占名额;重新发布即恢复,数据库重新启动并注入连接串", async () => {
      const { adapters, service, store, publish } = setup();
      await publish("v1", "visibility: department\n");
      expect(await canSee(service, bob, "ledger.apps.test")).toBe(true);

      const view = await service.unpublish(alice, "ledger");
      expect(view).toMatchObject({ name: "ledger", live: false, unpublished: true });
      expect(adapters.platform.calls).toContain("removeApp:app_2");
      expect(adapters.platform.calls).toContain("stopDatabase:db_3");
      expect(await canSee(service, bob, "ledger.apps.test")).toBe(false);
      expect(await canSee(service, alice, "ledger.apps.test")).toBe(false);
      expect(adapters.notifier.sent.at(-1)?.message).toContain("已下线");

      // 下线的应用不占名额(每人 2 个)
      await service.prepareApp(alice, "crm");
      await service.prepareApp(alice, "wiki");
      await service.unpublish(alice, "wiki");

      const restored = await publish("v2", "visibility: department\n");
      expect(restored.state).toBe("LIVE");
      expect(adapters.platform.calls).toContain("startDatabase:db_3");
      expect(adapters.platform.calls.filter((c) => c.startsWith("createDatabase"))).toHaveLength(1);
      const app = await store.getApp("ledger");
      expect(app?.unpublishedAt).toBeUndefined();
      expect(adapters.platform.env.get(app!.platform.appId!)?.DATABASE_URL).toBeDefined();
      expect(await canSee(service, bob, "ledger.apps.test")).toBe(true);
    });

    it("恢复已下线的应用要占回名额,满了就拒绝", async () => {
      const { service, publish } = setup();
      await publish("v1");
      await service.unpublish(alice, "ledger");
      await service.prepareApp(alice, "crm");
      await service.prepareApp(alice, "wiki");
      await expect(service.prepareApp(alice, "ledger")).rejects.toThrow("最多 2 个在线的应用");
    });

    it("发布进行中不能下线;被管理员停用的应用可以下线;重复下线不报错", async () => {
      const { adapters, service, startPublish, publish } = setup();
      const deploy = adapters.platform.deploy.bind(adapters.platform);
      let release: () => void = () => {};
      let entered!: () => void;
      const reached = new Promise<void>((r) => (entered = r));
      adapters.platform.deploy = async (appId, archive) => {
        const gate = new Promise<void>((r) => (release = r));
        entered();
        await gate;
        return deploy(appId, archive);
      };
      const { releaseId } = await startPublish("v1");
      // 等发布真正卡在部署这一步;固定等几毫秒在较慢的 PostgreSQL 上不够
      await reached;
      await expect(service.unpublish(alice, "ledger")).rejects.toThrow("还在进行中");
      release();
      await service.settle(releaseId);
      adapters.platform.deploy = deploy;

      await publish("v2");
      await service.disableApp(admin, "ledger");
      expect((await service.unpublish(alice, "ledger")).unpublished).toBe(true);
      expect((await service.unpublish(alice, "ledger")).unpublished).toBe(true);
      expect(adapters.platform.calls.filter((c) => c.startsWith("removeApp"))).toHaveLength(1);
    });
  });

  describe("管理员删除应用", () => {
    it("在线的应用不能删;下线后管理员删除:清掉数据库、项目、代码包和记录,通知负责人,应用名可以给别人用", async () => {
      const { adapters, service, publish } = setup();
      await publish("v1");
      await expect(service.deleteApp(admin, "ledger")).rejects.toThrow("还在线");
      await expect(service.deleteApp(bob, "ledger")).rejects.toThrow("只有平台管理员");

      await service.unpublish(alice, "ledger");
      await service.deleteApp(admin, "ledger");

      expect(adapters.platform.calls).toEqual(expect.arrayContaining(["deleteDatabase:db_3", "deleteProject:proj_1"]));
      expect(await adapters.archives.list("ledger")).toEqual([]);
      expect(await service.listApps(alice)).toEqual([]);
      await expect(service.appDetail(alice, "ledger")).rejects.toThrow("不存在");
      expect(adapters.notifier.sent.at(-1)).toMatchObject({ userId: alice.id, message: expect.stringContaining("已被管理员删除") });
      // 应用名已释放,别人可以用
      expect((await service.prepareApp(bob, "ledger")).name).toBe("ledger");
    });

    it("停用(没下线)的应用也能删,会先删掉部署平台上的应用", async () => {
      const { adapters, service, publish } = setup();
      await publish("v1");
      await service.disableApp(admin, "ledger", "违规");
      await service.deleteApp(admin, "ledger");
      expect(adapters.platform.calls.filter((c) => /^(removeApp|deleteDatabase|deleteProject)/.test(c))).toEqual([
        "removeApp:app_2",
        "deleteDatabase:db_3",
        "deleteProject:proj_1",
      ]);
      expect((await service.listAllApps(admin)).map((a) => a.name)).toEqual([]);
    });

    it("删除期间负责人不能重新发布已下线的应用;发不出通知不影响删除", async () => {
      const { adapters, service, publish } = setup();
      await publish("v1");
      await service.unpublish(alice, "ledger");
      const deleteDatabase = adapters.platform.deleteDatabase.bind(adapters.platform);
      let republish: Promise<unknown> | undefined;
      adapters.platform.deleteDatabase = async (id) => {
        republish = service.prepareApp(alice, "ledger");
        await expect(republish).rejects.toThrow("停用");
        return deleteDatabase(id);
      };
      adapters.notifier.notify = async () => {
        throw new Error("钉钉接口超时");
      };
      await service.deleteApp(admin, "ledger");
      expect(republish).toBeDefined();
      expect(await service.listAllApps(admin)).toEqual([]);
    });

    it("标记停用时刚好开始了一次发布:先不删,撤回停用标记", async () => {
      const { adapters, service, publish, startPublish, store } = setup();
      await publish("v1");
      await service.unpublish(alice, "ledger");
      // 让这次发布停在第一步(扫描代码)里:已经过了停用检查,删除再检查时它还在进行
      let entered!: () => void;
      const scanning = { reached: new Promise<void>((resolve) => (entered = resolve)) };
      adapters.scanner.scan = () => {
        entered();
        return new Promise(() => {});
      };
      const setAppDisabled = store.setAppDisabled.bind(store);
      let started = false;
      store.setAppDisabled = async (name, disabled) => {
        await setAppDisabled(name, disabled);
        // 模拟检查和标记之间,负责人刚好发起了发布(此时还没被标记拦住)
        if (disabled && !started) {
          started = true;
          await setAppDisabled(name, undefined);
          await startPublish("v2");
          await scanning.reached;
          await setAppDisabled(name, disabled);
        }
      };
      await expect(service.deleteApp(admin, "ledger")).rejects.toThrow("刚刚开始");
      expect((await store.getApp("ledger"))?.disabled).toBeUndefined();
    });

    it("中途失败后再删一次,接着做完,不重复删已经删掉的", async () => {
      const { adapters, service, publish } = setup();
      await publish("v1");
      await service.unpublish(alice, "ledger");
      const deleteProject = adapters.platform.deleteProject.bind(adapters.platform);
      adapters.platform.deleteProject = async () => {
        throw new Error("部署平台暂时不可用");
      };
      await expect(service.deleteApp(admin, "ledger")).rejects.toThrow("暂时不可用");
      expect((await service.listAllApps(admin)).map((a) => a.name)).toEqual(["ledger"]);

      adapters.platform.deleteProject = deleteProject;
      await service.deleteApp(admin, "ledger");
      expect(adapters.platform.calls.filter((c) => c.startsWith("deleteDatabase"))).toHaveLength(1);
      expect(await service.listAllApps(admin)).toEqual([]);
    });
  });

  describe("代码包清理", () => {
    it("发布结束后清掉不再需要的代码包,自动回滚仍然可用", async () => {
      const { adapters, publish } = setup({ archiveGraceMs: 0 });
      const v1 = await publish("v1");
      const v2 = await publish("v2");
      const v3 = await publish("v3");
      expect([v1.state, v2.state, v3.state]).toEqual(["LIVE", "LIVE", "LIVE"]);
      // v1 已经不是最近两个上线版本,被清掉
      expect((await adapters.archives.list("ledger")).map((a) => a.version).sort()).toEqual([v2.version, v3.version].sort());

      adapters.health.healthy = false;
      const v4 = await publish("v4");
      expect(v4.state).toBe("ROLLED_BACK");
      expect(adapters.platform.deployedVersion.get("app_2")).toBe(v3.version);
      // 回滚后:线上的 v3 和之前的 v2 保留,失败的 v4 清掉
      expect((await adapters.archives.list("ledger")).map((a) => a.version).sort()).toEqual([v2.version, v3.version].sort());
    });
  });

  describe("服务重启后继续执行", () => {
    /**
     * 一个永远不返回的替身:模拟进程在这一步执行到一半时退出。`entered` 在它真正被调用时完成。
     *
     * 不能只等发布单的状态变过来:状态写进存储后,原来的流程还要读几次存储才会走到这次调用
     * (PostgreSQL 比内存慢,这段时间更长)。如果测试在这期间就把被替换的方法换回去,
     * 原来的流程会调到真实的方法、自己把发布做完,和“重启后”的流程同时执行。
     * 真实重启时旧进程已经不在了,不会有这种情况。
     */
    function stuck<T>(onEnter?: () => void) {
      let entered!: () => void;
      const reached = new Promise<void>((resolve) => (entered = resolve));
      return {
        fn: (): Promise<T> => {
          onEnter?.();
          entered();
          return new Promise<T>(() => {});
        },
        reached,
      };
    }

    it("从中断的步骤继续,不重复创建应用和数据库", async () => {
      const { store, adapters, startPublish, restart } = setup();
      const deploy = adapters.platform.deploy.bind(adapters.platform);
      const deployStuck = stuck<CommandResult>();
      adapters.platform.deploy = deployStuck.fn;
      const { releaseId, version } = await startPublish("v1");
      await deployStuck.reached;

      adapters.platform.deploy = deploy;
      const service = restart();
      expect(await service.resumeUnfinished()).toEqual([releaseId]);
      await service.settle(releaseId);

      expect((await service.status(alice, releaseId)).state).toBe("LIVE");
      expect(adapters.platform.deployedVersion.get("app_2")).toBe(version);
      for (const step of ["createProject", "createApp", "createDatabase", "attachDomain"]) {
        expect(adapters.platform.calls.filter((c) => c.startsWith(step))).toHaveLength(1);
      }
    });

    it("建库后、注入连接串前中断:恢复后连接串仍会注入", async () => {
      const { store, adapters, startPublish, restart } = setup();
      const setEnv = adapters.platform.setEnv.bind(adapters.platform);
      // 数据库已经建好,进程在写入环境变量之前退出
      const setEnvStuck = stuck<void>();
      adapters.platform.setEnv = setEnvStuck.fn;
      const { releaseId } = await startPublish("v1");
      await setEnvStuck.reached;

      adapters.platform.setEnv = setEnv;
      const service = restart();
      await service.resumeUnfinished();
      await service.settle(releaseId);

      expect((await service.status(alice, releaseId)).state).toBe("LIVE");
      expect(adapters.platform.env.get("app_2")?.DATABASE_URL).toBeDefined();
    });

    it("迁移中断:恢复后重跑迁移,但不再备份,保留迁移前的那份备份", async () => {
      const { store, adapters, startPublish, restart } = setup();
      const runCommand = adapters.platform.runCommand.bind(adapters.platform);
      const runStuck = stuck<CommandResult>();
      adapters.platform.runCommand = runStuck.fn;
      const { releaseId } = await startPublish("v1");
      await runStuck.reached;
      const backupId = (await store.getRelease(releaseId))?.backupId;
      expect(backupId).toBeDefined();

      adapters.platform.runCommand = runCommand;
      const service = restart();
      await service.resumeUnfinished();
      await service.settle(releaseId);

      expect((await service.status(alice, releaseId)).state).toBe("LIVE");
      expect(adapters.platform.calls.filter((c) => c.startsWith("backupDatabase"))).toHaveLength(1);
      expect((await store.getRelease(releaseId))?.backupId).toBe(backupId);
    });

    it("健康检查阶段中断:退回构建,重新部署这次的版本再检查", async () => {
      const { store, adapters, publish, startPublish, restart } = setup();
      await publish("v1");
      const check = adapters.health.check.bind(adapters.health);
      const checkStuck = stuck<HealthResult>();
      adapters.health.check = checkStuck.fn;
      const { releaseId, version } = await startPublish("v2");
      await checkStuck.reached;
      // 模拟中断前正在回滚:线上跑的是上一个版本
      await adapters.platform.deploy("app_2", { version: "v1-running", zip: zipOf("v1") });

      adapters.health.check = check;
      const service = restart();
      await service.resumeUnfinished();
      await service.settle(releaseId);

      const release = await store.getRelease(releaseId);
      expect(release?.state).toBe("LIVE");
      expect(release?.history.map((h) => h.state).slice(-5)).toEqual(["VERIFYING", "BUILDING", "MIGRATING", "VERIFYING", "LIVE"]);
      expect(adapters.platform.deployedVersion.get("app_2")).toBe(version);
    });

    it("已结束的发布不会被重新执行", async () => {
      const { adapters, publish, restart } = setup();
      await publish("v1");
      const before = adapters.platform.calls.length;
      expect(await restart().resumeUnfinished()).toEqual([]);
      expect(adapters.platform.calls).toHaveLength(before);
    });

    it("中断期间应用被停用:恢复后发布终止,服务保持停止", async () => {
      const { store, adapters, service, startPublish, restart } = setup();
      const deploy = adapters.platform.deploy.bind(adapters.platform);
      const deployStuck = stuck<CommandResult>();
      adapters.platform.deploy = deployStuck.fn;
      const { releaseId } = await startPublish("v1");
      await deployStuck.reached;
      await service.disableApp(admin, "ledger");

      adapters.platform.deploy = deploy;
      const restarted = restart();
      await restarted.resumeUnfinished();
      await restarted.settle(releaseId);

      const view = await restarted.status(alice, releaseId);
      expect(view.state).toBe("FAILED");
      expect(view.error?.type).toBe("app_disabled");
      expect(adapters.platform.stopped.has("app_2")).toBe(true);
    });
  });
});
