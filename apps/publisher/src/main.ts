import { randomBytes } from "node:crypto";
import { DokployPlatform, type ResourceLimits } from "./adapters/dokploy";
import { DokployClient } from "./adapters/dokploy-client";
import { FsArchiveStore } from "./adapters/archive-store";
import { HttpHealthChecker, probeGateway } from "./adapters/health";
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
import { consoleUrlOf, PublisherService } from "./service";
import { Engine } from "./workflow/engine";
import { openDatabase, PostgresStore } from "./db/postgres-store";
import { PostgresOrgStore } from "./db/postgres-org-store";
import { MemoryOrgStore, type OrgStore } from "./org/store";
import { Organization } from "./org/service";
import { MemoryStore, type Store } from "./workflow/store";
import { SecretBox } from "./secrets";
import { PostgresSetupStore } from "./db/postgres-setup-store";
import { MemorySetupStore, type SetupStore } from "./setup/store";
import { checkInstance, resolveInstance } from "./setup/instance";
import { ensureSetupCode, removeSetupCodeFile } from "./setup/code";
import { lookupIpv4, pingFerry } from "./setup/probe";
import { SetupService } from "./setup/service";
import { CertificateManager } from "./setup/certificate-manager";
import { SelfCheck } from "./setup/selfcheck";
import { servedCertificate } from "./setup/served";
import { SetupWizard } from "./setup/wizard";

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

let store: Store;
let orgStore: OrgStore = new MemoryOrgStore();
let authStore: AuthStore = new MemoryAuthStore();
let auditStore: AuditStore = new MemoryAuditStore();
let setupStore: SetupStore = new MemorySetupStore();
if (config.DATABASE_URL) {
  // 启动时自动执行尚未执行的数据库迁移
  const database = await openDatabase(config.DATABASE_URL);
  store = new PostgresStore(database.db);
  orgStore = new PostgresOrgStore(database.db);
  authStore = new PostgresAuthStore(database.db);
  auditStore = new PostgresAuditStore(database.db);
  setupStore = new PostgresSetupStore(database.db);
} else {
  console.warn("未设置 DATABASE_URL,使用内存存储:服务重启后应用和发布记录都会丢失");
  store = new MemoryStore();
}

// 地址配置:环境变量优先,其次是设置向导写进数据库的(docs/setup-wizard.md)。还没完成初始化时只开放设置向导
const instance = resolveInstance(process.env, config, await setupStore.getSettings());
checkInstance(instance, config);
// 设置向导第 7 步完成后在本进程里变成 true:向导关闭、开始按域名分流(docs/setup-wizard.md“未初始化模式”)
let completed = instance.initialized;
if (instance.initialized) {
  await removeSetupCodeFile(config.SETUP_CODE_FILE);
} else {
  await ensureSetupCode(setupStore, config.SETUP_CODE_FILE, (m) => console.warn(m));
  console.warn(
    instance.switched
      ? "已切到正式地址、设置向导还没完成:Ferry 照常运行,向导(/setup)也开放"
      : "未完成初始化:只开放设置向导(/setup)和 /healthz,登录、控制台、MCP、上传、登录网关都暂停",
  );
}

// 组织架构:权限判定读内存里的这一份,由 Organization 从数据库读出(人员和部门由管理员在控制台维护)
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
// 一期没有对外发通知的渠道:给负责人的通知和给管理员的告警都只写进服务日志
if (config.NOTIFY_VIA !== "log") {
  console.warn("未设置 NOTIFY_VIA:给负责人的通知和给管理员的告警都不会记录内容;设 NOTIFY_VIA=log 写进服务日志");
}
if (config.FERRY_PLATFORM === "dokploy") {
  if (!config.DOKPLOY_URL || !config.DOKPLOY_API_KEY) {
    throw new Error("FERRY_PLATFORM=dokploy 时必须设置 DOKPLOY_URL 和 DOKPLOY_API_KEY");
  }
  adapters.platform = new DokployPlatform(
    new DokployClient({ baseUrl: config.DOKPLOY_URL, apiKey: config.DOKPLOY_API_KEY }),
    {
      https: instance.appsUrlScheme === "https",
      backupKeep: config.BACKUP_KEEP,
      appLimits: limits(config.APP_CPU_LIMIT, config.APP_MEMORY_LIMIT_MB),
      databaseLimits: limits(config.DB_CPU_LIMIT, config.DB_MEMORY_LIMIT_MB),
    },
  );
  adapters.health = new HttpHealthChecker({
    gateway: config.HEALTHCHECK_GATEWAY,
    tlsPort: config.HEALTHCHECK_TLS_PORT,
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

// 给平台管理员的告警(任务 3.5):发布连续失败、迁移前备份失败、部署平台出错、后台任务失败
// ADMIN_USERS 里的人始终是管理员;其余管理员在控制台上设置,告警每次发送时现取
const adminIds = new Set(config.ADMIN_USERS.split(",").map((id) => id.trim()).filter(Boolean));
const alerts = new Alerts(adapters.notifier, () => [...new Set([...adminIds, ...directory.adminIds()])], {
  cooldownMs: config.ALERT_COOLDOWN_MINUTES * 60_000,
});

// Ferry 对浏览器和 agent 的地址:上传地址、控制台地址、允许的来源都按它来,只在这里算一次
const ferryUrl = instance.publicUrl ?? `http://127.0.0.1:${config.PORT}`;
// agent 上传代码包用的地址:agent 和浏览器访问 Ferry 的地址不同(如 agent 在容器里)时单独设置
const agentUrl = config.AGENT_URL ?? ferryUrl;
if (instance.initialized && !instance.publicUrl && !config.AGENT_URL) {
  console.warn(
    `未设置 PUBLIC_URL:上传地址和控制台地址用 ${ferryUrl},只有本机直接运行的 agent 能访问上传地址。` +
      "agent 在 Docker 容器里时,设 AGENT_URL 为它访问 Ferry 用的地址(如 http://host.docker.internal:8081);不要改 PUBLIC_URL,浏览器登录要用它",
  );
}

// 审计日志(任务 3.3):操作人的姓名在记录时从组织架构查好存下来
const audit = new AuditLog(auditStore, directory);
const engine = new Engine(store, adapters, {
  maxFixAttempts: config.MAX_FIX_ATTEMPTS,
  appsUrlScheme: instance.appsUrlScheme,
  secretBox,
  audit,
  alerts,
  consoleUrl: consoleUrlOf(ferryUrl),
});
const service = new PublisherService(store, engine, adapters, {
  appsDomain: instance.appsDomain,
  appsUrlScheme: instance.appsUrlScheme,
  maxAppsPerUser: config.MAX_APPS_PER_USER,
  publicUrl: ferryUrl,
  agentUrl,
  uploadTtlMs: config.UPLOAD_TTL_MINUTES * 60_000,
  archiveGraceMs: config.ARCHIVE_GRACE_HOURS * 3600_000,
  templates: new TemplateLibrary(),
  secretBox,
  audit,
});

const publicUrl = new URL(ferryUrl);
const allowedOrigins = new Set([
  publicUrl.origin,
  ...config.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
]);
// 本机地址 127.0.0.1 和 localhost 都能打开登录页
if (publicUrl.hostname === "127.0.0.1") allowedOrigins.add(publicUrl.origin.replace("127.0.0.1", "localhost"));
const auth = new AuthService(authStore, directory, { sessionTtlMs: config.SESSION_DAYS * 24 * 3600_000 }, audit);
// 人员和部门:启动时从数据库读进内存,之后每分钟重读一次(命令行建的管理员不用重启就能登录)
const organization = new Organization(orgStore, directory, audit, {
  fixedAdmins: adminIds,
  revokeAccess: async (userId) => void (await auth.endAccess(userId)),
});
await organization.reload();
setInterval(() => void organization.reload().catch((err: Error) => console.error(`重新读取组织架构失败: ${err.message}`)), 60_000).unref();
// 第一个管理员怎么登录:用数据库时用命令行建(pnpm set-password <手机号> --name <姓名>);
// 内存存储(本地临时试用)时命令行连不上,组织架构是空的就建一个管理员,初始密码打印在这里
if (instance.initialized && !config.DATABASE_URL && directory.adminIds().length === 0) {
  const { userId } = await organization.bootstrapAdmin({ name: "管理员", mobile: "13800000000" });
  console.warn(
    `管理员(手机号 13800000000)的初始密码:${await auth.resetPassword(undefined, userId)}` +
      "(内存存储,只用于本地试用;第一次登录后要改)",
  );
} else if (instance.initialized && adminIds.size === 0 && directory.adminIds().length === 0) {
  console.warn("还没有平台管理员:用 pnpm set-password <手机号> --name <姓名> 建第一个");
}
const gateway = new Gateway(service, directory, {
  secret: gatewaySecret,
  ferryUrl: publicUrl.origin,
  appsScheme: instance.appsUrlScheme,
  appCookieTtlMs: config.GATEWAY_COOKIE_HOURS * 3600_000,
  ticketTtlMs: 60_000,
  now: () => new Date(),
});
// Traefik 访问 /authz 的地址:写网关配置用,设置向导装证书后也用它重写一次网关配置来触发 Traefik 加载
const authAddress = config.GATEWAY_AUTH_URL ?? `http://host.docker.internal:${config.PORT}/authz`;
// 本进程的标识:设置向导的 /api/setup/ping 返回它,用来确认请求到的是这台服务器上的这个 Ferry
const instanceId = randomBytes(16).toString("hex");
const identity = createIdentity({ auth, directory, adminIds, devAuth: config.DEV_AUTH === "true", allowedOrigins });
/** 按新的地址配置重启:先把响应发出去再退出,容器里由 Docker 的 restart: unless-stopped 拉起来 */
function restart(reason: string): void {
  console.warn(`${reason},Ferry 退出以按新配置启动(本机 tsx watch 不会自动拉起,要手动重启)`);
  setTimeout(() => process.exit(0), 500).unref();
}

// 控制台的“证书”页:有正式地址时才有。Traefik 实际出示的证书只在接了 Dokploy 时能读
const tlsGateway = new URL(config.HEALTHCHECK_GATEWAY).hostname;
const certificates = instance.publicUrl
  ? new CertificateManager({
      store: setupStore,
      platform: adapters.platform,
      publicUrl: instance.publicUrl,
      appsDomain: instance.appsDomain,
      fixedByEnv: ["PUBLIC_URL", "APPS_URL_SCHEME"].some((name) => (process.env[name]?.trim() ?? "") !== ""),
      authAddress,
      served: (host) =>
        config.FERRY_PLATFORM === "dokploy" ? servedCertificate(tlsGateway, config.HEALTHCHECK_TLS_PORT, host) : Promise.resolve(undefined),
      restart: () => restart("在控制台装好证书、切到了 https"),
      audit: (actorId, detail) => audit.record(actorId, "certificate.install", undefined, detail),
    })
  : undefined;

const server = buildServer(service, identity, {
  certificates,
  maxArchiveBytes: config.MAX_ARCHIVE_MB * 1024 * 1024,
  gateway,
  auth: {
    service: auth,
    directory,
    organization,
    routes: { allowedOrigins, secureCookie: publicUrl.protocol === "https:" },
  },
  hosts: {
    publicUrl: instance.publicUrl,
    agentUrl: config.AGENT_URL,
    appsDomain: instance.appsDomain,
    appsScheme: instance.appsUrlScheme,
  },
  setup: {
    service: new SetupService(setupStore),
    initialized: () => completed,
    switched: () => instance.switched && !completed,
    instanceId,
    wizard: instance.initialized
      ? undefined
      : new SetupWizard(setupStore, adapters.platform, {
          instanceId,
          authAddress,
          dns: { lookup: lookupIpv4, ping: (host) => pingFerry("http", host) },
          httpsPing: (host) => pingFerry("https", host),
          // 自检要真的部署一个应用、经 Traefik 访问它:只在接了 Dokploy、已经切到正式地址时有
          selfCheck:
            instance.switched && instance.publicUrl && config.FERRY_PLATFORM === "dokploy"
              ? new SelfCheck({
                  service,
                  probe: (host, path, options) =>
                    probeGateway(new URL(config.HEALTHCHECK_GATEWAY), host, path, { ...options, tlsPort: config.HEALTHCHECK_TLS_PORT }),
                  publicUrl: instance.publicUrl,
                  appsDomain: instance.appsDomain,
                })
              : undefined,
          createAdmin: async ({ orgName, name, mobile, password }) => {
            const { userId } = await organization.bootstrapAdmin({ name, mobile, orgName, via: "setup" });
            await auth.setPasswordFromSetup(userId, password);
            return { userId };
          },
          audit: (action, detail) => audit.record(undefined, action, undefined, { ...detail, via: "setup" }),
          onComplete: () => {
            completed = true;
            void removeSetupCodeFile(config.SETUP_CODE_FILE).catch((err: Error) => console.error(`删除设置码文件失败: ${err.message}`));
            console.warn("设置向导已完成:向导关闭,开始按域名分流");
          },
          restart: () => restart("设置向导写入了正式地址"),
        }),
  },
});
await server.listen({ port: config.PORT, host: config.HOST });

// 写入登录网关的 Traefik 配置,并让已有应用的域名都挂上网关。失败只记日志并定时重试,不让 Ferry 退出
// 还没切到正式地址时不碰 Traefik 和已有应用:那时还没有正式域名,登录网关也不工作。
// 切换之后、向导完成之前就要做:第 6 步的自检要走登录网关
if ((instance.initialized || instance.switched) && config.FERRY_PLATFORM === "dokploy") {
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

// 证书到期提醒:启动一分钟后查一次,之后每天一次(不到 30 天提醒一次,不到 7 天每天都提醒)
if (certificates && instance.initialized && config.FERRY_PLATFORM === "dokploy") {
  const remind = () =>
    void certificates.remind((m) => alerts.send(m)).catch((err: Error) => server.log.error(`检查证书到期失败: ${err.message}`));
  setTimeout(remind, 60_000).unref();
  setInterval(remind, 24 * 3600_000).unref();
}

// 冷却期内被压下的告警,冷却期过了还没被新告警带出去的,单独补发
setInterval(() => void alerts.flush(), 60_000).unref();

// 继续执行上次没跑完的发布(进程重启前正在进行的)
const resumed = instance.initialized || instance.switched ? await service.resumeUnfinished() : [];
if (resumed.length > 0) server.log.info({ releases: resumed }, `继续执行 ${resumed.length} 个未完成的发布`);

/** 0 表示不限制;只限制其中一项时另一项不限 */
function limits(cpus: number, memoryMb: number): ResourceLimits | null {
  if (!cpus && !memoryMb) return null;
  return { cpus, memoryMb };
}
