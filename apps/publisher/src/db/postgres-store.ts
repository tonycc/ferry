import { fileURLToPath } from "node:url";
import { and, asc, eq, notInArray } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { Manifest, Visibility } from "@ferry/manifest";
import { TERMINAL_STATES, type ReleaseState } from "../workflow/states";
import type { AppRecord, ReleaseError, ReleaseRecord, SecretRecord, Store, UploadTicket } from "../workflow/store";
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
  constructor(private readonly db: PostgresJsDatabase<typeof schema>) {}

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
  }

  async saveApp(app: AppRecord) {
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
  }

  async deleteApp(name: string) {
    // 发布记录、上传凭据和密钥引用了应用,先删它们;放在一个事务里,不会只删一半
    await this.db.transaction(async (tx) => {
      await tx.delete(schema.appSecrets).where(eq(schema.appSecrets.appName, name));
      await tx.delete(schema.uploads).where(eq(schema.uploads.appName, name));
      await tx.delete(schema.releases).where(eq(schema.releases.appName, name));
      await tx.delete(schema.apps).where(eq(schema.apps.name, name));
    });
  }

  async setAppDisabled(name: string, disabled: AppRecord["disabled"]) {
    const updated = await this.db
      .update(schema.apps)
      .set({ disabled: disabled ?? null })
      .where(eq(schema.apps.name, name))
      .returning({ name: schema.apps.name });
    if (updated.length === 0) throw new Error(`应用 ${name} 不存在`);
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

  async saveRelease(release: ReleaseRecord) {
    const changes = {
      state: release.state,
      backupId: release.backupId ?? null,
      error: release.error ?? null,
      url: release.url ?? null,
      history: release.history,
    };
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
      .values({ ...ticket, receivedAt: ticket.receivedAt ?? null })
      .onConflictDoUpdate({
        target: schema.uploads.tokenHash,
        set: { receivedAt: ticket.receivedAt ?? null },
      });
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

  async saveSecret(secret: SecretRecord) {
    const changes = { ciphertext: secret.ciphertext, updatedAt: secret.updatedAt, updatedBy: secret.updatedBy };
    await this.db
      .insert(schema.appSecrets)
      .values({ appName: secret.appName, name: secret.name, ...changes })
      .onConflictDoUpdate({ target: [schema.appSecrets.appName, schema.appSecrets.name], set: changes });
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
  };
}
