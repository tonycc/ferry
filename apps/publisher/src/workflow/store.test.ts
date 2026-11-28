import { parseManifest } from "@ferry/manifest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { storeCases, type StoreCase } from "../test/stores";
import type { AppRecord, ReleaseRecord, UploadTicket } from "./store";

const parsed = parseManifest("name: ledger\ntemplate: node-postgres\ndatabase: postgres\nmigrate: npm run migrate\n");
if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
const manifest = parsed.manifest;

/** 时间取整到毫秒:PostgreSQL 精度是微秒,JS 是毫秒,整毫秒的值两边一致 */
const at = (iso: string) => new Date(iso);

function newApp(overrides: Partial<AppRecord> = {}): AppRecord {
  return {
    name: "ledger",
    ownerId: "dingtalk:alice",
    visibility: "self",
    host: "ledger.apps.test",
    platform: {},
    createdAt: at("2026-11-16T08:00:00.000Z"),
    ...overrides,
  };
}

function newRelease(overrides: Partial<ReleaseRecord> = {}): ReleaseRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "publish",
    appName: "ledger",
    ownerId: "dingtalk:alice",
    version: "v1",
    manifest,
    state: "PENDING",
    history: [{ state: "PENDING", at: at("2026-11-16T08:00:01.000Z") }],
    createdAt: at("2026-11-16T08:00:01.000Z"),
    ...overrides,
  };
}

let storeCase: StoreCase;

describe.each(storeCases("ferry_test_store"))("存储契约:$name", (c) => {
  beforeAll(() => c.init());
  beforeEach(async () => {
    storeCase = c;
    await c.reset();
  });
  afterAll(() => c.close());

  describe("应用", () => {
    it("可选字段为空时原样读回,不存在的应用返回 undefined", async () => {
      const store = storeCase.create();
      const app = newApp();
      expect(await store.createApp(app)).toBe(true);
      const read = await store.getApp("ledger");
      expect(read).toEqual(app);
      expect(read?.liveVersion).toBeUndefined();
      expect(read?.disabled).toBeUndefined();
      expect(await store.getApp("missing")).toBeUndefined();
      expect(await store.getAppByHost("ledger.apps.test")).toEqual(app);
    });

    it("部署信息和停用状态写入后原样读回", async () => {
      const store = storeCase.create();
      await store.createApp(newApp());
      const updated = newApp({
        visibility: "department",
        platform: { projectId: "proj_1", appId: "app_2", databaseId: "db_3", domainAttached: true },
        liveVersion: "v1",
      });
      await store.saveApp(updated);
      // 下线时间也随部署信息一起保存
      updated.unpublishedAt = at("2026-11-16T08:30:00.000Z");
      await store.saveApp(updated);
      const disabled = { by: "dingtalk:admin", at: at("2026-11-16T09:00:00.000Z"), reason: "存放了客户隐私数据" };
      await store.setAppDisabled("ledger", disabled);

      const read = await store.getApp("ledger");
      expect(read).toEqual({ ...updated, disabled });
      expect(read?.disabled?.at).toBeInstanceOf(Date);

      await store.setAppDisabled("ledger", undefined);
      expect((await store.getApp("ledger"))?.disabled).toBeUndefined();
    });

    it("应用名已被占用时不覆盖", async () => {
      const store = storeCase.create();
      await store.createApp(newApp());
      expect(await store.createApp(newApp({ ownerId: "dingtalk:bob" }))).toBe(false);
      expect((await store.getApp("ledger"))?.ownerId).toBe("dingtalk:alice");
    });

    it("用旧数据保存部署信息时,不会冲掉期间写入的停用状态", async () => {
      const store = storeCase.create();
      await store.createApp(newApp());
      const stale = (await store.getApp("ledger"))!;
      await store.setAppDisabled("ledger", { by: "dingtalk:admin", at: at("2026-11-16T09:00:00.000Z") });

      stale.liveVersion = "v1";
      await store.saveApp(stale);

      const read = await store.getApp("ledger");
      expect(read?.liveVersion).toBe("v1");
      expect(read?.disabled?.by).toBe("dingtalk:admin");
    });

    it("读出的是副本:改了不保存,存储里的数据不变", async () => {
      const store = storeCase.create();
      await store.createApp(newApp());
      const read = (await store.getApp("ledger"))!;
      read.platform.appId = "changed";
      expect((await store.getApp("ledger"))?.platform).toEqual({});
    });

    it("按负责人列出应用", async () => {
      const store = storeCase.create();
      await store.createApp(newApp());
      await store.createApp(newApp({ name: "crm", host: "crm.apps.test", ownerId: "dingtalk:bob" }));
      expect((await store.listAppsByOwner("dingtalk:alice")).map((a) => a.name)).toEqual(["ledger"]);
      expect((await store.listApps()).map((a) => a.name).sort()).toEqual(["crm", "ledger"]);
    });
  });

  describe("发布单", () => {
    it("可选字段为空和有值时都原样读回,历史里的时间是 Date", async () => {
      const store = storeCase.create();
      await store.createApp(newApp());
      // 发布单类型在创建时确定,之后不变
      const release = newRelease({ kind: "rollback" });
      await store.saveRelease(release);
      expect(await store.getRelease(release.id)).toEqual(release);

      const done = newRelease({
        kind: "rollback",
        state: "FAILED_FIXABLE",
        backupId: "backup_1",
        error: { stage: "BUILDING", type: "build_failed", message: "构建失败", logs: "npm ERR!", hint: "修复后重新发布" },
        url: "https://ledger.apps.test",
        history: [...release.history, { state: "FAILED_FIXABLE", at: at("2026-11-16T08:01:00.000Z") }],
      });
      await store.saveRelease(done);
      const read = await store.getRelease(release.id);
      expect(read).toEqual(done);
      expect(read?.history[1]?.at).toBeInstanceOf(Date);
      expect(await store.getRelease("00000000-0000-4000-8000-000000000099")).toBeUndefined();
    });

    it("创建时间相同时,按写入顺序列出", async () => {
      const store = storeCase.create();
      await store.createApp(newApp());
      const ids = [3, 1, 2].map((n) => `00000000-0000-4000-8000-00000000000${n}`);
      for (const id of ids) await store.saveRelease(newRelease({ id, state: "LIVE" }));
      expect((await store.listReleases("ledger")).map((r) => r.id)).toEqual(ids);
    });

    it("同一应用不能同时有两个未结束的发布单;结束后可以新建,不同应用互不影响", async () => {
      const store = storeCase.create();
      await store.createApp(newApp());
      await store.createApp(newApp({ name: "crm", host: "crm.apps.test" }));

      const first = newRelease({ id: "00000000-0000-4000-8000-000000000011", state: "BUILDING" });
      await store.saveRelease(first);
      await expect(
        store.saveRelease(newRelease({ id: "00000000-0000-4000-8000-000000000012", state: "PENDING" })),
      ).rejects.toThrow();
      // 不同应用可以同时有未结束的发布单
      await store.saveRelease(
        newRelease({ id: "00000000-0000-4000-8000-000000000013", appName: "crm", state: "PENDING" }),
      );
      // 原发布单结束后,同一应用可以写入新的未结束发布单
      await store.saveRelease({ ...first, state: "LIVE" });
      await store.saveRelease(newRelease({ id: "00000000-0000-4000-8000-000000000014", state: "PENDING" }));
      expect((await store.listReleases("ledger")).map((r) => r.state)).toEqual(["LIVE", "PENDING"]);
    });

    it("getLatestHealthcheck:只返回最近一条发布单的健康检查路径", async () => {
      const store = storeCase.create();
      await store.createApp(newApp());
      expect(await store.getLatestHealthcheck("ledger")).toBeUndefined();
      await store.saveRelease(
        newRelease({
          id: "00000000-0000-4000-8000-000000000021",
          state: "LIVE",
          manifest: { ...manifest, healthcheck: "/ready" },
        }),
      );
      await store.saveRelease(
        newRelease({
          id: "00000000-0000-4000-8000-000000000022",
          state: "PENDING",
          manifest: { ...manifest, healthcheck: "/healthz-v2" },
        }),
      );
      expect(await store.getLatestHealthcheck("ledger")).toBe("/healthz-v2");
    });

    it("并发配额与发布互斥:prepareAppSlot、startRelease、markAppUnpublished 原子串行", async () => {
      const store = storeCase.create();
      // 8 个不同应用并发抢占同一负责人的 3 个在线名额,精确只有 3 个成功
      const slots = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          store.prepareAppSlot(newApp({ name: `app-${i}`, host: `app-${i}.apps.test` }), 3),
        ),
      );
      expect(slots.filter((s) => s.ok)).toHaveLength(3);
      expect(slots.filter((s) => !s.ok && s.reason === "quota_exceeded")).toHaveLength(5);
      expect(await store.listAppsByOwner("dingtalk:alice")).toHaveLength(3);

      // 同一应用并发发起 5 次发布,精确只有 1 次进入 PENDING,其余全部返回 in_progress
      const [firstApp] = await store.listAppsByOwner("dingtalk:alice");
      const starts = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          store.startRelease(
            newRelease({
              id: `00000000-0000-4000-8000-00000000010${i}`,
              appName: firstApp!.name,
              version: `v${i}`,
            }),
            { maxActiveByOwner: 3 },
          ),
        ),
      );
      expect(starts.filter((r) => r.ok)).toHaveLength(1);
      expect(starts.filter((r) => !r.ok && r.reason === "in_progress")).toHaveLength(4);

      // 发布未结束时不能下线
      const blockedUnpublish = await store.markAppUnpublished(firstApp!.name, "dingtalk:alice", at("2026-11-16T09:00:00.000Z"));
      expect(blockedUnpublish).toEqual({ ok: false, reason: "in_progress" });

      // 发布结束后下线释放 1 个名额;再建 1 个新应用把 3 个名额占满后,尝试恢复已下线应用会被配额拦截
      const activeRelease = (await store.listReleases(firstApp!.name))[0]!;
      await store.saveRelease({ ...activeRelease, state: "LIVE" });
      const marked = await store.markAppUnpublished(firstApp!.name, "dingtalk:alice", at("2026-11-16T09:05:00.000Z"));
      expect(marked.ok).toBe(true);
      const extra = await store.prepareAppSlot(newApp({ name: "app-extra", host: "app-extra.apps.test" }), 3);
      expect(extra.ok).toBe(true);
      const reviveOverQuota = await store.startRelease(
        newRelease({ id: "00000000-0000-4000-8000-000000000199", appName: firstApp!.name, version: "v-revive" }),
        { maxActiveByOwner: 3 },
      );
      expect(reviveOverQuota).toEqual({ ok: false, reason: "quota_exceeded" });
    });
  });

  describe("应用密钥", () => {
    const secret = (name: string, ciphertext: string, updatedAt = at("2026-11-20T08:00:00.000Z")) => ({
      appName: "ledger",
      name,
      ciphertext,
      updatedAt,
      updatedBy: "dingtalk:alice",
    });

    it("按名称排序列出;同名再保存是替换;删除返回是否删掉了", async () => {
      const store = storeCase.create();
      await store.createApp(newApp());
      await store.createApp(newApp({ name: "other", host: "other.apps.test" }));
      await store.saveSecret(secret("ZETA", "c1"), 50);
      await store.saveSecret(secret("ALPHA", "c2"), 50);
      await store.saveSecret({ ...secret("ALPHA", "c3"), appName: "other" }, 50);
      expect((await store.listSecrets("ledger")).map((s) => s.name)).toEqual(["ALPHA", "ZETA"]);
      expect(await store.listSecrets("ledger")).toEqual([secret("ALPHA", "c2"), secret("ZETA", "c1")]);

      await store.saveSecret(secret("ALPHA", "c4", at("2026-11-20T09:00:00.000Z")), 50);
      expect((await store.listSecrets("ledger"))[0]).toEqual(secret("ALPHA", "c4", at("2026-11-20T09:00:00.000Z")));

      expect(await store.deleteSecret("ledger", "ALPHA")).toBe(true);
      expect(await store.deleteSecret("ledger", "ALPHA")).toBe(false);
      expect((await store.listSecrets("ledger")).map((s) => s.name)).toEqual(["ZETA"]);
      // 别的应用的同名密钥不受影响
      expect((await store.listSecrets("other")).map((s) => s.ciphertext)).toEqual(["c3"]);
    });

    it("数量上限:超出时不写入;替换已有的不算新增;并发新增也不会超出", async () => {
      const store = storeCase.create();
      await store.createApp(newApp());
      expect(await store.saveSecret(secret("A", "c"), 2)).toBe(true);
      expect(await store.saveSecret(secret("B", "c"), 2)).toBe(true);
      expect(await store.saveSecret(secret("C", "c"), 2)).toBe(false);
      expect(await store.saveSecret(secret("A", "c2"), 2)).toBe(true);
      expect((await store.listSecrets("ledger")).map((s) => s.ciphertext)).toEqual(["c2", "c"]);

      await store.createApp(newApp({ name: "race", host: "race.apps.test" }));
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => store.saveSecret({ ...secret(`K${i}`, "c"), appName: "race" }, 3)),
      );
      expect(results.filter(Boolean)).toHaveLength(3);
      expect(await store.listSecrets("race")).toHaveLength(3);
    });

    it("应用不存在时不能保存;删除应用时一起删掉", async () => {
      const store = storeCase.create();
      await expect(store.saveSecret(secret("KEY", "c"), 50)).rejects.toThrow();
      await store.createApp(newApp());
      await store.saveSecret(secret("KEY", "c"), 50);
      await store.deleteApp("ledger");
      expect(await store.listSecrets("ledger")).toEqual([]);
    });
  });

  describe("上传凭据", () => {
    it("按令牌哈希和按版本都能查到,收到代码包后记录时间", async () => {
      const store = storeCase.create();
      await store.createApp(newApp());
      const ticket: UploadTicket = {
        tokenHash: "a".repeat(64),
        appName: "ledger",
        ownerId: "dingtalk:alice",
        version: "v1",
        expiresAt: at("2026-11-16T08:15:00.000Z"),
      };
      await store.saveUpload(ticket);
      expect(await store.getUploadByTokenHash(ticket.tokenHash)).toEqual(ticket);
      expect((await store.getUpload("ledger", "v1"))?.receivedAt).toBeUndefined();

      const received = { ...ticket, receivedAt: at("2026-11-16T08:05:00.000Z") };
      await store.saveUpload(received);
      expect(await store.getUpload("ledger", "v1")).toEqual(received);
      expect(await store.getUpload("ledger", "v2")).toBeUndefined();
    });
  });
});
