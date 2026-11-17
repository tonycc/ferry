import { bigint, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * PostgreSQL 表结构,是数据库迁移的唯一来源。
 * 改了这里之后运行 `pnpm --filter @ferry/publisher db:generate` 生成新的迁移文件(在 drizzle/ 目录),
 * 服务启动时自动执行未执行过的迁移。
 */

export const apps = pgTable(
  "apps",
  {
    name: text("name").primaryKey(),
    ownerId: text("owner_id").notNull(),
    visibility: text("visibility").notNull().default("self"),
    host: text("host").notNull().unique(),
    /** 部署平台上的资源 ID: { projectId, appId, databaseId, domainAttached } */
    platform: jsonb("platform").notNull().default({}),
    liveVersion: text("live_version"),
    /** 被管理员停用时: { by, at, reason } */
    disabled: jsonb("disabled"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("apps_owner_id_idx").on(t.ownerId)],
);

export const releases = pgTable(
  "releases",
  {
    id: uuid("id").primaryKey(),
    /** 写入顺序。创建时间可能相同(毫秒精度),排序时用它保证先后 */
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    appName: text("app_name")
      .notNull()
      .references(() => apps.name),
    ownerId: text("owner_id").notNull(),
    version: text("version").notNull(),
    manifest: jsonb("manifest").notNull(),
    state: text("state").notNull(),
    backupId: text("backup_id"),
    error: jsonb("error"),
    url: text("url"),
    /** [{ state, at }],at 存为 ISO 时间字符串 */
    history: jsonb("history").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("releases_app_name_idx").on(t.appName, t.createdAt, t.seq)],
);

/** 一次性上传凭据;代码包本身存在文件存储里 */
export const uploads = pgTable(
  "uploads",
  {
    tokenHash: text("token_hash").primaryKey(),
    appName: text("app_name")
      .notNull()
      .references(() => apps.name),
    ownerId: text("owner_id").notNull(),
    version: text("version").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("uploads_app_version_idx").on(t.appName, t.version)],
);
