import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

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
    /** 为 true 时可见范围以控制台为准,发布时不再用 app.yaml 里的值 */
    visibilityPinned: boolean("visibility_pinned").notNull().default(false),
    host: text("host").notNull().unique(),
    /** 部署平台上的资源 ID: { projectId, appId, databaseId, domainAttached } */
    platform: jsonb("platform").notNull().default({}),
    liveVersion: text("live_version"),
    /** 被管理员停用时: { by, at, reason } */
    disabled: jsonb("disabled"),
    /** 负责人下线的时间;为空表示未下线 */
    unpublishedAt: timestamp("unpublished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("apps_owner_id_idx").on(t.ownerId)],
);

export const releases = pgTable(
  "releases",
  {
    id: uuid("id").primaryKey(),
    /** publish 或 rollback */
    kind: text("kind").notNull().default("publish"),
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

/** 应用密钥(任务 3.8):值用 SECRETS_KEY 加密后存放,见 src/secrets.ts */
export const appSecrets = pgTable(
  "app_secrets",
  {
    appName: text("app_name")
      .notNull()
      .references(() => apps.name),
    name: text("name").notNull(),
    ciphertext: text("ciphertext").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => [primaryKey({ columns: [t.appName, t.name] })],
);

/** 组织架构:最近一次同步的部门树。服务启动时读进内存,权限判定只查内存 */
export const orgDepartments = pgTable("org_departments", {
  id: text("id").primaryKey(),
  /** 根部门为空 */
  parentId: text("parent_id"),
  name: text("name").notNull(),
});

/** 组织架构:人员。离职的人 active 为 false,保留最后所属的部门 */
export const orgUsers = pgTable("org_users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  active: boolean("active").notNull(),
  departmentIds: jsonb("department_ids").notNull().default([]),
  /** 工号、手机号:登录时用来找本人 */
  jobNumber: text("job_number"),
  mobile: text("mobile"),
});

/** 验证码登录:只存验证码的哈希 */
export const loginChallenges = pgTable(
  "login_challenges",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id").notNull(),
    codeHash: text("code_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("login_challenges_user_idx").on(t.userId, t.createdAt)],
);

/** 浏览器登录会话:只存 cookie 令牌的哈希 */
export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

/** 个人令牌:只存哈希 */
export const personalTokens = pgTable(
  "personal_tokens",
  {
    id: uuid("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    userId: text("user_id").notNull(),
    label: text("label").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("personal_tokens_user_idx").on(t.userId)],
);

/**
 * 审计日志(任务 3.3),只追加。不引用 apps 表:应用被彻底删除后记录还要保留。
 * 应用名会被重新使用,所以同时记下当时的负责人
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    /** 为空表示 Ferry 自己 */
    actorId: text("actor_id"),
    /** 操作当时的姓名 */
    actorName: text("actor_name"),
    action: text("action").notNull(),
    appName: text("app_name"),
    appOwnerId: text("app_owner_id"),
    detail: jsonb("detail").notNull().default({}),
  },
  (t) => [index("audit_events_app_idx").on(t.appName, t.id), index("audit_events_actor_idx").on(t.actorId, t.id)],
);
