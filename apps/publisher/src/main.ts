import { randomBytes } from "node:crypto";
import { DokployPlatform, type ResourceLimits } from "./adapters/dokploy";
import { DokployClient } from "./adapters/dokploy-client";
import { FsArchiveStore } from "./adapters/archive-store";
import { HttpHealthChecker } from "./adapters/health";
import { GitleaksScanner } from "./adapters/gitleaks";
import { AuditLog } from "./audit/log";
import { Alerts } from "./alerts";
import { MemoryAuditStore, type AuditStore } from "./audit/store";
import { PostgresAuditStore } from "./db/postgres-audit-store";
import { Gateway, HEALTH_HEADER, healthToken } from "./gateway/gateway";
import { setupGateway } from "./gateway/setup";
import { MemoryDirectory } from "./adapters/directory";
import { createFakeAdapters } from "./adapters/fake";
import type { Adapters } from "./adapters/types";
import { buildServer } from "./api/server";
import { TemplateLibrary } from "./templates";
import { loadConfig } from "./config";
import { createIdentity } from "./identity";
import { AuthService } from "./auth/service";
import { MemoryAuthStore, type AuthStore } from "./auth/store";
import { PostgresAuthStore } from "./db/postgres-auth-store";
import { LogNotifier, UnconfiguredNotifier } from "./adapters/log-notifier";
import { PublisherService } from "./service";
import { Engine } from "./workflow/engine";
import { openDatabase, PostgresStore } from "./db/postgres-store";
import { PostgresOrgStore } from "./db/postgres-org-store";
import { FileOrgSource } from "./adapters/org-file-source";
import { MemoryOrgStore, type OrgStore } from "./org/store";
import { OrgSync } from "./org/sync";
import { MemoryStore, type Store } from "./workflow/store";
import { SecretBox } from "./secrets";

const config = loadConfig();

if (config.DEV_AUTH === "true") {
  console.warn("DEV_AUTH=true:没带凭据的请求可以用 x-ferry-user 请求头冒充任何人,只能用于本地开发");
}

// 代码包保存在本地目录;FERRY_PLATFORM=dokploy 时部署平台和健康检查是真实的
// 登录网关的密钥:签网关 cookie、算健康检查口令
if (!config.GATEWAY_SECRET) {
  console.warn("未设置 GATEWAY_SECRET:本次随机生成,服务重启后访问应用要重新跳转登录一次");
}
const gatewaySecret = config.GATEWAY_SECRET ?? randomBytes(32).toString("hex");

// 组织架构:权限判定读内存里的这一份,由 OrgSync 从数据源同步、从数据库恢复
const directory = new MemoryDirectory();
const adapters: Adapters = {
  ...createFakeAdapters(),
  archives: new FsArchiveStore(config.ARCHIVE_DIR),
  directory,
  notifier: config.NOTIFY_VIA === "log" ? new LogNotifier() : new UnconfiguredNotifier(),
};
if (config.SECRET_SCAN === "gitleaks") {
  // 找不到 gitleaks 时直接退出,而不是带着不扫描的发布流程跑起来
  const scanner = new GitleaksScanner({ binary: config.GITLEAKS_PATH });
  const version = await scanner.version().catch((err: Error) => {
    throw new Error(`${err.message}。请安装 gitleaks(macOS:brew install gitleaks)或设置 GITLEAKS_PATH;临时试用可以设 SECRET_SCAN=off`);
  });
  console.log(`密钥扫描:gitleaks ${version}`);
  adapters.scanner = scanner;
} else {
  console.warn("SECRET_SCAN=off:发布前不扫描密钥,只能用于临时试用");
}
if (config.NOTIFY_VIA === "log") {
  console.warn("NOTIFY_VIA=log:通知和登录验证码会打印在日志里,能看到日志的人就能登录任何账号,只能用于本地开发");
} else {
  console.warn("未设置 NOTIFY_VIA:通知和登录验证码都发不出去,无法用验证码登录");
}
if (config.FERRY_PLATFORM === "dokploy") {
  if (!config.DOKPLOY_URL || !config.DOKPLOY_API_KEY) {
    throw new Error("FERRY_PLATFORM=dokploy 时必须设置 DOKPLOY_URL 和 DOKPLOY_API_KEY");
  }
  adapters.platform = new DokployPlatform(
    new DokployClient({ baseUrl: config.DOKPLOY_URL, apiKey: config.DOKPLOY_API_KEY }),
    {
      https: config.APPS_URL_SCHEME === "https",
      backupKeep: config.BACKUP_KEEP,
      appLimits: limits(config.APP_CPU_LIMIT, config.APP_MEMORY_LIMIT_MB),
      databaseLimits: limits(config.DB_CPU_LIMIT, config.DB_MEMORY_LIMIT_MB),
    },
  );
  adapters.health = new HttpHealthChecker({
    gateway: config.HEALTHCHECK_GATEWAY,
    timeoutMs: config.HEALTHCHECK_TIMEOUT_SECONDS * 1000,
    // 登录网关的健康检查口令,和网关用同一个密钥按域名计算
    extraHeaders: (host) => ({ [HEALTH_HEADER]: healthToken(gatewaySecret, host) }),
  });
}

// 应用密钥的加密密钥。用数据库时必须固定,否则重启后已保存的密钥都解不开:
// 没设置时照常启动,只是不能保存密钥,已有密钥的应用发布会失败(按平台问题)。只用内存存储时随机生成
let secretBox: SecretBox | undefined;
if (config.SECRETS_KEY) {
  secretBox = new SecretBox(config.SECRETS_KEY);
} else if (config.DATABASE_URL) {
  console.warn("未设置 SECRETS_KEY:控制台上不能保存应用密钥,已有密钥的应用发布会失败。生成:openssl rand -hex 32");
} else {
  secretBox = SecretBox.random();
}

let store: Store;
let orgStore: OrgStore = new MemoryOrgStore();
let authStore: AuthStore = new MemoryAuthStore();
let auditStore: AuditStore = new MemoryAuditStore();
if (config.DATABASE_URL) {
  // 启动时自动执行尚未执行的数据库迁移
  const database = await openDatabase(config.DATABASE_URL);
  store = new PostgresStore(database.db);
  orgStore = new PostgresOrgStore(database.db);
  authStore = new PostgresAuthStore(database.db);
  auditStore = new PostgresAuditStore(database.db);
} else {
  console.warn("未设置 DATABASE_URL,使用内存存储:服务重启后应用和发布记录都会丢失");
  store = new MemoryStore();
}
// 给平台管理员的告警(任务 3.5):发布连续失败、迁移前备份失败、部署平台出错、后台任务失败
const adminIds = new Set(config.ADMIN_USERS.split(",").map((id) => id.trim()).filter(Boolean));
const alerts = new Alerts(adapters.notifier, [...adminIds], { cooldownMs: config.ALERT_COOLDOWN_MINUTES * 60_000 });
if (adminIds.size === 0) console.warn("未设置 ADMIN_USERS:告警只写进服务日志,不会发给任何人");

// 先用上次同步保存的组织架构,再同步一次,之后定时同步。同步失败只记日志,继续用现有数据
// 组织架构目前来自文件(本地开发);接入钉钉后换成钉钉通讯录(任务 2.1)
const orgSync = new OrgSync(config.ORG_FILE ? new FileOrgSource(config.ORG_FILE) : undefined, orgStore, directory);
await orgSync.init();
if (!config.ORG_FILE) console.warn("未设置 ORG_FILE:不同步组织架构,按部门的可见范围只能用上次保存的数据");
/** 同步一次;失败或快照被拒时告警管理员(连续失败只在第一次告警,恢复时再告诉一声) */
async function syncOrg(): Promise<void> {
  const result = await orgSync.run().catch((err: Error) => ({ status: "failed" as const, error: err.message }));
  const error =
    result.status === "failed" ? result.error : result.status === "rejected" ? result.problems.join(";") : undefined;
  await alerts.jobStatus("组织架构同步", error);
}
await syncOrg();
setInterval(() => void syncOrg(), config.ORG_SYNC_MINUTES * 60_000).unref();

// 审计日志(任务 3.3):操作人的姓名在记录时从组织架构查好存下来
const audit = new AuditLog(auditStore, directory);
const engine = new Engine(store, adapters, {
  maxFixAttempts: config.MAX_FIX_ATTEMPTS,
  appsUrlScheme: config.APPS_URL_SCHEME,
  secretBox,
  audit,
  alerts,
});
const service = new PublisherService(store, engine, adapters, {
  appsDomain: config.APPS_DOMAIN,
  appsUrlScheme: config.APPS_URL_SCHEME,
  maxAppsPerUser: config.MAX_APPS_PER_USER,
  publicUrl: config.PUBLIC_URL ?? `http://127.0.0.1:${config.PORT}`,
  uploadTtlMs: config.UPLOAD_TTL_MINUTES * 60_000,
  archiveGraceMs: config.ARCHIVE_GRACE_HOURS * 3600_000,
  templates: new TemplateLibrary(),
  secretBox,
  audit,
});

const publicUrl = new URL(config.PUBLIC_URL ?? `http://127.0.0.1:${config.PORT}`);
const allowedOrigins = new Set([
  publicUrl.origin,
  ...config.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
]);
// 本机地址 127.0.0.1 和 localhost 都能打开登录页
if (publicUrl.hostname === "127.0.0.1") allowedOrigins.add(publicUrl.origin.replace("127.0.0.1", "localhost"));
const auth = new AuthService(
  authStore,
  directory,
  adapters.notifier,
  { sessionTtlMs: config.SESSION_DAYS * 24 * 3600_000 },
  audit,
);
const gateway = new Gateway(service, directory, {
  secret: gatewaySecret,
  ferryUrl: publicUrl.origin,
  appsScheme: config.APPS_URL_SCHEME,
  appCookieTtlMs: config.GATEWAY_COOKIE_HOURS * 3600_000,
  ticketTtlMs: 60_000,
  now: () => new Date(),
});
const identity = createIdentity({ auth, directory, adminIds, devAuth: config.DEV_AUTH === "true", allowedOrigins });
const server = buildServer(service, identity, {
  maxArchiveBytes: config.MAX_ARCHIVE_MB * 1024 * 1024,
  gateway,
  auth: {
    service: auth,
    directory,
    routes: { allowedOrigins, secureCookie: publicUrl.protocol === "https:", codeTtlMinutes: 5 },
  },
});
await server.listen({ port: config.PORT, host: config.HOST });

// 写入登录网关的 Traefik 配置,并让已有应用的域名都挂上网关。失败只记日志并定时重试,不让 Ferry 退出
if (config.FERRY_PLATFORM === "dokploy") {
  const authAddress = config.GATEWAY_AUTH_URL ?? `http://host.docker.internal:${config.PORT}/authz`;
  await setupGateway(
    adapters.platform,
    service,
    authAddress,
    { info: (m) => server.log.info(m), error: (m) => server.log.error(m) },
    { onStatus: (error) => alerts.jobStatus("登录网关配置", error) },
  );
  // 网关容器被重建(升级 Dokploy、改 Traefik 设置)后,它接入的应用网络会丢,应用全成 502。
  // 每分钟查一次(只是一次接口调用;缺了才去服务器上接),出事后最多一分钟恢复
  setInterval(() => {
    service
      .allAppNames()
      .then((names) => adapters.platform.ensureGatewayNetworks(names))
      .then(() => alerts.jobStatus("把网关接入应用网络"))
      .catch((err: Error) => {
        server.log.error(`把网关接入应用网络失败: ${err.message}`);
        // 接不上时所有应用都是 502;一直失败只告警一次,恢复时再告诉一声
        return alerts.jobStatus("把网关接入应用网络", `${err.message}(应用可能都无法访问)`);
      });
  }, 60_000).unref();
}

// 冷却期内被压下的告警,冷却期过了还没被新告警带出去的,单独补发
setInterval(() => void alerts.flush(), 60_000).unref();

// 继续执行上次没跑完的发布(进程重启前正在进行的)
const resumed = await service.resumeUnfinished();
if (resumed.length > 0) server.log.info({ releases: resumed }, `继续执行 ${resumed.length} 个未完成的发布`);

/** 0 表示不限制;只限制其中一项时另一项不限 */
function limits(cpus: number, memoryMb: number): ResourceLimits | null {
  if (!cpus && !memoryMb) return null;
  return { cpus, memoryMb };
}
