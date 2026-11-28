import { fileURLToPath } from "node:url";
import { and, asc, count, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { Manifest, Visibility } from "@ferry/manifest";
import { TERMINAL_STATES, type ReleaseState } from "../workflow/states";
import type {
  AppRecord,
  MarkUnpublishedResult,
  PrepareAppResult,
  ReleaseError,
  ReleaseRecord,
  SecretRecord,
  StartReleaseResult,
  Store,
  StoreMutation,
  UploadTicket,
} from "../workflow/store";
import * as schema from "./schema";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../drizzle", import.meta.url));

export interface Database {
  db: PostgresJsDatabase<typeof schema>;
  close(): Promise<void>;
}

/** 连接数据库并执行尚未执行的迁移 */
export async function openDatabase(url: string): Promise<Database> {
  const client = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return { db, close: () => client.end() };
}

/**
 * PostgreSQL 存储。数据库里可以为空的列读出来是 null,这里统一转成 undefined,
 * jsonb 里的时间读出来是字符串,这里转回 Date,保证和内存存储的结果完全一致。
 */
export class PostgresStore implements Store {
  private readonly listeners = new Set<(mutation: StoreMutation) => void>();

  constructor(private readonly db: PostgresJsDatabase<typeof schema>) {}

  subscribe(listener: (mutation: StoreMutation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(mutation: StoreMutation): void {
    for (const listener of this.listeners) listener(mutation);
  }

  async getApp(name: string) {
    const [row] = await this.db.select().from(schema.apps).where(eq(schema.apps.name, name));
    return row && toApp(row);
  }

  async getAppByHost(host: string) {
    const [row] = await this.db.select().from(schema.apps).where(eq(schema.apps.host, host));
    return row && toApp(row);
  }

  async listAppsByOwner(ownerId: string) {
    const rows = await this.db
      .select()
      .from(schema.apps)
      .where(eq(schema.apps.ownerId, ownerId))
      .orderBy(asc(schema.apps.createdAt), asc(schema.apps.name));
    return rows.map(toApp);
  }

  async listApps() {
    const rows = await this.db.select().from(schema.apps).orderBy(asc(schema.apps.createdAt), asc(schema.apps.name));
    return rows.map(toApp);
  }

  async createApp(app: AppRecord) {
    try {
      const inserted = await this.db
        .insert(schema.apps)
        .values({
          name: app.name,
          ownerId: app.ownerId,
          visibility: app.visibility,
          visibilityPinned: app.visibilityPinned ?? false,
          host: app.host,
          platform: app.platform,
          liveVersion: app.liveVersion ?? null,
          disabled: app.disabled ?? null,
          unpublishedAt: app.unpublishedAt ?? null,
          createdAt: app.createdAt,
        })
        .onConflictDoNothing()
        .returning({ name: schema.apps.name });
      return inserted.length > 0;
    } finally {
      this.emit({ kind: "app", appName: app.name, host: app.host });
    }
  }

  async prepareAppSlot(candidate: AppRecord, maxActiveByOwner: number): Promise<PrepareAppResult> {
    try {
      return await this.db.transaction(async (tx) => {
        // 严格按 owner → app 两层顺序拿事务级咨询锁,消除空表幻读且绝对不会死锁
        await lockKey(tx, `ferry:owner:${candidate.ownerId}`);
        await lockKey(tx, `ferry:app:${candidate.name}`);
        const [existingRow] = await tx.select().from(schema.apps).where(eq(schema.apps.name, candidate.name)).for("update");
        const existing = existingRow && toApp(existingRow);
        if (existing && existing.ownerId !== candidate.ownerId) return { ok: false, reason: "conflict" };
        if (existing?.disabled) return { ok: false, reason: "disabled" };
        if (!existing || existing.unpublishedAt !== undefined) {
          const [{ active } = { active: 0 }] = await tx
            .select({ active: count() })
            .from(schema.apps)
            .where(and(eq(schema.apps.ownerId, candidate.ownerId), isNull(schema.apps.unpublishedAt)));
          if (active >= maxActiveByOwner) return { ok: false, reason: "quota_exceeded" };
        }
        if (existing) return { ok: true, app: existing, created: false };
        const inserted = await tx
          .insert(schema.apps)
          .values({
            name: candidate.name,
            ownerId: candidate.ownerId,
            visibility: candidate.visibility,
            visibilityPinned: candidate.visibilityPinned ?? false,
            host: candidate.host,
            platform: candidate.platform,
            liveVersion: candidate.liveVersion ?? null,
            disabled: candidate.disabled ?? null,
            unpublishedAt: candidate.unpublishedAt ?? null,
            createdAt: candidate.createdAt,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted.length === 0) return { ok: false, reason: "conflict" };
        return { ok: true, app: toApp(inserted[0]!), created: true };
      });
    } finally {
      this.emit({ kind: "app", appName: candidate.name, host: candidate.host });
    }
  }

  async saveApp(app: AppRecord) {
    try {
      const updated = await this.db
        .update(schema.apps)
        .set({
          platform: app.platform,
          liveVersion: app.liveVersion ?? null,
          visibility: app.visibility,
          visibilityPinned: app.visibilityPinned ?? false,
          unpublishedAt: app.unpublishedAt ?? null,
        })
        .where(eq(schema.apps.name, app.name))
        .returning({ name: schema.apps.name });
      if (updated.length === 0) throw new Error(`应用 ${app.name} 不存在`);
    } finally {
      this.emit({ kind: "app", appName: app.name, host: app.host });
    }
  }

  async markAppUnpublished(appName: string, ownerId: string, at: Date): Promise<MarkUnpublishedResult> {
    let host: string | undefined;
    try {
      return await this.db.transaction(async (tx) => {
        await lockKey(tx, `ferry:app:${appName}`);
        const [appRow] = await tx.select().from(schema.apps).where(eq(schema.apps.name, appName)).for("update");
        if (!appRow) return { ok: false, reason: "not_found" };
        const app = toApp(appRow);
        host = app.host;
        if (app.ownerId !== ownerId) return { ok: false, reason: "not_found" };
        if (app.unpublishedAt && !app.platform.appId) {
          return { ok: true, app, alreadyDone: true, firstAttempt: false };
        }
        const [unfinished] = await tx
          .select({ id: schema.releases.id })
          .from(schema.releases)
          .where(and(eq(schema.releases.appName, appName), notInArray(schema.releases.state, [...TERMINAL_STATES])))
          .limit(1);
        if (unfinished) return { ok: false, reason: "in_progress" };
        const firstAttempt = !app.unpublishedAt;
        await tx.update(schema.apps).set({ unpublishedAt: at }).where(eq(schema.apps.name, appName));
        app.unpublishedAt = at;
        return { ok: true, app, alreadyDone: false, firstAttempt };
      });
    } finally {
      this.emit({ kind: "app", appName, host });
    }
  }

  async deleteApp(name: string) {
    let host: string | undefined;
    try {
      // 发布记录、上传凭据和密钥引用了应用,先删它们;放在一个事务里,不会只删一半
      await this.db.transaction(async (tx) => {
        await lockKey(tx, `ferry:app:${name}`);
        const [existing] = await tx.select({ host: schema.apps.host }).from(schema.apps).where(eq(schema.apps.name, name)).for("update");
        host = existing?.host;
        await tx.delete(schema.appSecrets).where(eq(schema.appSecrets.appName, name));
        await tx.delete(schema.uploads).where(eq(schema.uploads.appName, name));
        await tx.delete(schema.releases).where(eq(schema.releases.appName, name));
        await tx.delete(schema.apps).where(eq(schema.apps.name, name));
      });
    } finally {
      this.emit({ kind: "app", appName: name, host });
      this.emit({ kind: "release", appName: name });
    }
  }

  async setAppDisabled(name: string, disabled: AppRecord["disabled"]) {
    let host: string | undefined;
    try {
      const updated = await this.db
        .update(schema.apps)
        .set({ disabled: disabled ?? null })
        .where(eq(schema.apps.name, name))
        .returning({ name: schema.apps.name, host: schema.apps.host });
      if (updated.length === 0) throw new Error(`应用 ${name} 不存在`);
      host = updated[0]?.host;
    } finally {
      this.emit({ kind: "app", appName: name, host });
    }
  }

  async getRelease(id: string) {
    const [row] = await this.db.select().from(schema.releases).where(eq(schema.releases.id, id));
    return row && toRelease(row);
  }

  async listReleases(appName: string) {
    const rows = await this.db
      .select()
      .from(schema.releases)
      .where(eq(schema.releases.appName, appName))
      .orderBy(asc(schema.releases.createdAt), asc(schema.releases.seq));
    return rows.map(toRelease);
  }

  async getLatestHealthcheck(appName: string) {
    const [row] = await this.db
      .select({ healthcheck: sql<string | null>`${schema.releases.manifest}->>'healthcheck'` })
      .from(schema.releases)
      .where(eq(schema.releases.appName, appName))
      .orderBy(desc(schema.releases.createdAt), desc(schema.releases.seq))
      .limit(1);
    return row?.healthcheck ?? undefined;
  }

  async saveRelease(release: ReleaseRecord) {
    const changes = {
      state: release.state,
      backupId: release.backupId ?? null,
      error: release.error ?? null,
      url: release.url ?? null,
      history: release.history,
    };
    try {
      await this.db
        .insert(schema.releases)
        .values({
          id: release.id,
          kind: release.kind,
          appName: release.appName,
          ownerId: release.ownerId,
          version: release.version,
          manifest: release.manifest,
          createdAt: release.createdAt,
          ...changes,
        })
        .onConflictDoUpdate({ target: schema.releases.id, set: changes });
    } finally {
      this.emit({ kind: "release", appName: release.appName });
    }
  }

  async startRelease(
    release: ReleaseRecord,
    options: { maxActiveByOwner?: number; expectedLiveVersion?: string } = {},
  ): Promise<StartReleaseResult> {
    let host: string | undefined;
    try {
      return await this.db.transaction(async (tx) => {
        await lockKey(tx, `ferry:owner:${release.ownerId}`);
        await lockKey(tx, `ferry:app:${release.appName}`);
        const [appRow] = await tx.select().from(schema.apps).where(eq(schema.apps.name, release.appName)).for("update");
        if (!appRow) return { ok: false, reason: "not_found" };
        const app = toApp(appRow);
        host = app.host;
        if (app.ownerId !== release.ownerId) return { ok: false, reason: "forbidden_owner" };
        if (app.disabled) return { ok: false, reason: "disabled" };
        if (options.expectedLiveVersion !== undefined) {
          if (app.unpublishedAt || !app.liveVersion) return { ok: false, reason: "not_live" };
          if (app.liveVersion !== options.expectedLiveVersion) return { ok: false, reason: "stale_live" };
        }
        const [unfinished] = await tx
          .select({ id: schema.releases.id })
          .from(schema.releases)
          .where(and(eq(schema.releases.appName, release.appName), notInArray(schema.releases.state, [...TERMINAL_STATES])))
          .limit(1);
        if (unfinished) return { ok: false, reason: "in_progress" };

        let revived = false;
        if (app.unpublishedAt !== undefined && options.expectedLiveVersion === undefined) {
          if (options.maxActiveByOwner !== undefined) {
            const [{ active } = { active: 0 }] = await tx
              .select({ active: count() })
              .from(schema.apps)
              .where(and(eq(schema.apps.ownerId, app.ownerId), isNull(schema.apps.unpublishedAt)));
            if (active >= options.maxActiveByOwner) return { ok: false, reason: "quota_exceeded" };
          }
          await tx.update(schema.apps).set({ unpublishedAt: null }).where(eq(schema.apps.name, app.name));
          app.unpublishedAt = undefined;
          revived = true;
        }

        await tx.insert(schema.releases).values({
          id: release.id,
          kind: release.kind,
          appName: release.appName,
          ownerId: release.ownerId,
          version: release.version,
          manifest: release.manifest,
          createdAt: release.createdAt,
          state: release.state,
          backupId: release.backupId ?? null,
          error: release.error ?? null,
          url: release.url ?? null,
          history: release.history,
        });
        return { ok: true, app, revived };
      });
    } finally {
      this.emit({ kind: "app", appName: release.appName, host });
      this.emit({ kind: "release", appName: release.appName });
    }
  }

  async listUnfinishedReleases() {
    const rows = await this.db
      .select()
      .from(schema.releases)
      .where(notInArray(schema.releases.state, [...TERMINAL_STATES]))
      .orderBy(asc(schema.releases.createdAt), asc(schema.releases.seq));
    return rows.map(toRelease);
  }

  async saveUpload(ticket: UploadTicket) {
    await this.db
      .insert(schema.uploads)
      .values({ ...ticket, receivedAt: ticket.receivedAt ?? null, manifest: ticket.manifest ?? null })
      .onConflictDoUpdate({
        target: schema.uploads.tokenHash,
        set: { receivedAt: ticket.receivedAt ?? null, manifest: ticket.manifest ?? null },
      });
  }

  async claimUpload(tokenHash: string, receivedAt: Date, manifest: Manifest) {
    const rows = await this.db
      .update(schema.uploads)
      .set({ receivedAt, manifest })
      .where(and(eq(schema.uploads.tokenHash, tokenHash), isNull(schema.uploads.receivedAt)))
      .returning({ tokenHash: schema.uploads.tokenHash });
    return rows.length > 0;
  }

  async getUploadByTokenHash(tokenHash: string) {
    const [row] = await this.db.select().from(schema.uploads).where(eq(schema.uploads.tokenHash, tokenHash));
    return row && toUpload(row);
  }

  async getUpload(appName: string, version: string) {
    const row = await this.db.query.uploads.findFirst({
      where: (t, { and, eq }) => and(eq(t.appName, appName), eq(t.version, version)),
    });
    return row && toUpload(row);
  }

  async listSecrets(appName: string): Promise<SecretRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.appSecrets)
      .where(eq(schema.appSecrets.appName, appName))
      .orderBy(asc(schema.appSecrets.name));
    return rows.map((row) => ({ ...row }));
  }

  async saveSecret(secret: SecretRecord, limit: number) {
    const changes = { ciphertext: secret.ciphertext, updatedAt: secret.updatedAt, updatedBy: secret.updatedBy };
    const key = and(eq(schema.appSecrets.appName, secret.appName), eq(schema.appSecrets.name, secret.name));
    return this.db.transaction(async (tx) => {
      // 锁住应用这一行,同一应用的密钥写入排队进行,数量检查不会被并发的新增绕过
      const [app] = await tx.select({ name: schema.apps.name }).from(schema.apps).where(eq(schema.apps.name, secret.appName)).for("update");
      if (!app) throw new Error(`应用 ${secret.appName} 不存在`);
      const [existing] = await tx.select({ name: schema.appSecrets.name }).from(schema.appSecrets).where(key);
      if (existing) {
        await tx.update(schema.appSecrets).set(changes).where(key);
        return true;
      }
      const [{ total } = { total: 0 }] = await tx
        .select({ total: count() })
        .from(schema.appSecrets)
        .where(eq(schema.appSecrets.appName, secret.appName));
      if (total >= limit) return false;
      await tx.insert(schema.appSecrets).values({ appName: secret.appName, name: secret.name, ...changes });
      return true;
    });
  }

  async deleteSecret(appName: string, name: string) {
    const deleted = await this.db
      .delete(schema.appSecrets)
      .where(and(eq(schema.appSecrets.appName, appName), eq(schema.appSecrets.name, name)))
      .returning({ name: schema.appSecrets.name });
    return deleted.length > 0;
  }
}

type AppRow = typeof schema.apps.$inferSelect;
type ReleaseRow = typeof schema.releases.$inferSelect;
type UploadRow = typeof schema.uploads.$inferSelect;

/** 事务级 64 位咨询锁:随事务提交/回滚自动释放,也能锁住尚未写入数据库的新名字或空配额用户 */
async function lockKey(tx: Pick<PostgresJsDatabase<typeof schema>, "execute">, key: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}::text, 0))`);
}

function toApp(row: AppRow): AppRecord {
  const disabled = row.disabled as { by: string; at: string; reason?: string } | null;
  return {
    name: row.name,
    ownerId: row.ownerId,
    visibility: row.visibility as Visibility,
    visibilityPinned: row.visibilityPinned || undefined,
    host: row.host,
    platform: row.platform as AppRecord["platform"],
    liveVersion: row.liveVersion ?? undefined,
    disabled: disabled ? { ...disabled, at: new Date(disabled.at) } : undefined,
    unpublishedAt: row.unpublishedAt ?? undefined,
    createdAt: row.createdAt,
  };
}

function toRelease(row: ReleaseRow): ReleaseRecord {
  const history = row.history as { state: ReleaseState; at: string }[];
  return {
    id: row.id,
    kind: row.kind as ReleaseRecord["kind"],
    appName: row.appName,
    ownerId: row.ownerId,
    version: row.version,
    manifest: row.manifest as Manifest,
    state: row.state as ReleaseState,
    backupId: row.backupId ?? undefined,
    error: (row.error as ReleaseError | null) ?? undefined,
    url: row.url ?? undefined,
    history: history.map((h) => ({ state: h.state, at: new Date(h.at) })),
    createdAt: row.createdAt,
  };
}

function toUpload(row: UploadRow): UploadTicket {
  return {
    tokenHash: row.tokenHash,
    appName: row.appName,
    ownerId: row.ownerId,
    version: row.version,
    expiresAt: row.expiresAt,
    receivedAt: row.receivedAt ?? undefined,
    manifest: (row.manifest as Manifest | null) ?? undefined,
  };
}
