import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeAdapters } from "../adapters/fake";
import { PublisherService } from "../service";
import { Engine } from "./engine";
import { storeCases, type StoreCase } from "../test/stores";
import type { ReleaseState } from "./states";
import type { Store } from "./store";

const alice = { id: "alice", departments: ["finance"], isAdmin: false };
const bob = { id: "bob", departments: ["finance"], isAdmin: false };
const carol = { id: "carol", departments: ["sales"], isAdmin: false };
const admin = { id: "root", departments: ["it"], isAdmin: true };

const MANIFEST = "name: ledger\ntemplate: node-postgres\ndatabase: postgres\nmigrate: npm run migrate\n";

/** 一个只有 zip 文件头的假代码包;marker 用来让假平台按内容决定部署成败 */
function zipOf(marker: string): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(marker)]);
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
      expect(await service.authorize(carol, "ledger.apps.test")).toBe(true);
    });
  });

  describe("应用名和配额", () => {
    it("应用名被别人占用时拒绝;超出配额时拒绝;重复准备自己的应用不占配额", async () => {
      const { service } = setup();
      await service.prepareApp(alice, "ledger");
      await expect(service.prepareApp(bob, "ledger")).rejects.toThrow("已被其他人使用");

      await service.prepareApp(alice, "ledger");
      await service.prepareApp(alice, "second-app");
      await expect(service.prepareApp(alice, "third-app")).rejects.toThrow("最多 2 个应用");
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
      expect(await service.authorize(bob, "ledger.apps.test")).toBe(true);

      await service.disableApp(admin, "ledger", "存放了客户隐私数据");

      expect(adapters.platform.stopped.has("app_2")).toBe(true);
      expect(await service.authorize(bob, "ledger.apps.test")).toBe(false);
      expect(await service.authorize(alice, "ledger.apps.test")).toBe(false);
      await expect(publish("v2")).rejects.toThrow("已被管理员停用");
      expect((await service.listApps(alice))[0]?.disabled).toBe(true);
      expect(adapters.notifier.sent.at(-1)).toEqual({
        userId: "alice",
        message: "应用 ledger 已被管理员停用,原因: 存放了客户隐私数据",
      });

      await service.enableApp(admin, "ledger");
      expect(adapters.platform.stopped.has("app_2")).toBe(false);
      expect(await service.authorize(bob, "ledger.apps.test")).toBe(true);
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
    /** 永远不返回:模拟进程在这一步执行到一半时退出 */
    const hang = <T,>() => new Promise<T>(() => {});

    async function waitForState(store: Store, releaseId: string, state: ReleaseState) {
      for (let i = 0; i < 200; i++) {
        if ((await store.getRelease(releaseId))?.state === state) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`发布没有到达 ${state}`);
    }

    it("从中断的步骤继续,不重复创建应用和数据库", async () => {
      const { store, adapters, startPublish, restart } = setup();
      const deploy = adapters.platform.deploy.bind(adapters.platform);
      adapters.platform.deploy = () => hang();
      const { releaseId, version } = await startPublish("v1");
      await waitForState(store, releaseId, "BUILDING");

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
      adapters.platform.setEnv = () => hang();
      const { releaseId } = await startPublish("v1");
      await waitForState(store, releaseId, "PROVISIONING");
      await new Promise((r) => setTimeout(r, 20));

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
      adapters.platform.runCommand = () => hang();
      const { releaseId } = await startPublish("v1");
      await waitForState(store, releaseId, "MIGRATING");
      await new Promise((r) => setTimeout(r, 20));
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
      adapters.health.check = () => hang();
      const { releaseId, version } = await startPublish("v2");
      await waitForState(store, releaseId, "VERIFYING");
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
      adapters.platform.deploy = () => hang();
      const { releaseId } = await startPublish("v1");
      await waitForState(store, releaseId, "BUILDING");
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
