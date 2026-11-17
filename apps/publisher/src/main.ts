import { DokployPlatform } from "./adapters/dokploy";
import { DokployClient } from "./adapters/dokploy-client";
import { FsArchiveStore } from "./adapters/archive-store";
import { HttpHealthChecker } from "./adapters/health";
import { MemoryDirectory } from "./adapters/directory";
import { createFakeAdapters } from "./adapters/fake";
import type { Adapters } from "./adapters/types";
import { buildServer } from "./api/server";
import { loadConfig } from "./config";
import { createDevIdentity } from "./identity";
import { PublisherService } from "./service";
import { Engine } from "./workflow/engine";
import { openDatabase, PostgresStore } from "./db/postgres-store";
import { MemoryStore, type Store } from "./workflow/store";

const config = loadConfig();

if (config.DEV_AUTH !== "true") {
  // 还没有接入钉钉、企业微信登录,拒绝在关闭开发身份的情况下启动,避免误以为已有真实鉴权
  throw new Error("尚未实现钉钉、企业微信登录,目前只能以 DEV_AUTH=true 运行");
}

// 代码包保存在本地目录;FERRY_PLATFORM=dokploy 时部署平台和健康检查是真实的,密钥扫描、通知还是假实现
// 组织架构目前只来自开发用的身份请求头,还没有接钉钉、企业微信
const directory = new MemoryDirectory();
const adapters: Adapters = {
  ...createFakeAdapters(),
  archives: new FsArchiveStore(config.ARCHIVE_DIR),
  directory,
};
if (config.FERRY_PLATFORM === "dokploy") {
  if (!config.DOKPLOY_URL || !config.DOKPLOY_API_KEY) {
    throw new Error("FERRY_PLATFORM=dokploy 时必须设置 DOKPLOY_URL 和 DOKPLOY_API_KEY");
  }
  adapters.platform = new DokployPlatform(
    new DokployClient({ baseUrl: config.DOKPLOY_URL, apiKey: config.DOKPLOY_API_KEY }),
    { https: config.APPS_URL_SCHEME === "https" },
  );
  adapters.health = new HttpHealthChecker({
    gateway: config.HEALTHCHECK_GATEWAY,
    timeoutMs: config.HEALTHCHECK_TIMEOUT_SECONDS * 1000,
  });
}

let store: Store;
if (config.DATABASE_URL) {
  // 启动时自动执行尚未执行的数据库迁移
  const database = await openDatabase(config.DATABASE_URL);
  store = new PostgresStore(database.db);
} else {
  console.warn("未设置 DATABASE_URL,使用内存存储:服务重启后应用和发布记录都会丢失");
  store = new MemoryStore();
}
const engine = new Engine(store, adapters, {
  maxFixAttempts: config.MAX_FIX_ATTEMPTS,
  appsUrlScheme: config.APPS_URL_SCHEME,
});
const service = new PublisherService(store, engine, adapters, {
  appsDomain: config.APPS_DOMAIN,
  appsUrlScheme: config.APPS_URL_SCHEME,
  maxAppsPerUser: config.MAX_APPS_PER_USER,
  publicUrl: config.PUBLIC_URL ?? `http://127.0.0.1:${config.PORT}`,
  uploadTtlMs: config.UPLOAD_TTL_MINUTES * 60_000,
});

const adminIds = new Set(config.ADMIN_USERS.split(",").map((id) => id.trim()).filter(Boolean));
const server = buildServer(service, createDevIdentity(adminIds, directory), {
  maxArchiveBytes: config.MAX_ARCHIVE_MB * 1024 * 1024,
});
await server.listen({ port: config.PORT, host: "127.0.0.1" });

// 继续执行上次没跑完的发布(进程重启前正在进行的)
const resumed = await service.resumeUnfinished();
if (resumed.length > 0) server.log.info({ releases: resumed }, `继续执行 ${resumed.length} 个未完成的发布`);
