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
      for (const id of ids) await store.saveRelease(newRelease({ id }));
      expect((await store.listReleases("ledger")).map((r) => r.id)).toEqual(ids);
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
