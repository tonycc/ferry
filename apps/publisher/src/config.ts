import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().default(8080),
  /**
   * PostgreSQL 连接地址。不设置时用内存存储,重启即丢失(只适合临时试用)。
   * 本地开发库:postgres://ferry:ferry-dev@127.0.0.1:55432/ferry
   */
  DATABASE_URL: z.string().optional(),
  /** 应用域名后缀:应用地址为 <APPS_URL_SCHEME>://<name>.<APPS_DOMAIN>。本机开发用 apps.localhost */
  APPS_DOMAIN: z.string().default("apps.corp.example"),
  /** 应用地址的协议。本机开发没有证书,用 http */
  APPS_URL_SCHEME: z.enum(["http", "https"]).default("https"),
  /**
   * 健康检查经由的统一入口(Traefik),按应用域名设置 Host 请求头访问。
   * 只在 FERRY_PLATFORM=dokploy 时使用;假平台下健康检查也是假的
   */
  HEALTHCHECK_GATEWAY: z.string().default("http://127.0.0.1:80"),
  /** 部署完成后等应用变健康的最长时间 */
  HEALTHCHECK_TIMEOUT_SECONDS: z.coerce.number().int().default(90),
  /** agent 访问本服务用的地址,用于拼出上传地址。默认是本机地址 */
  PUBLIC_URL: z.string().optional(),
  /** 代码包的保存目录 */
  ARCHIVE_DIR: z.string().default("./data/archives"),
  MAX_ARCHIVE_MB: z.coerce.number().int().default(100),
  /** 上传后超过这个时间还没发布的代码包,会在该应用下次发布结束时清理 */
  ARCHIVE_GRACE_HOURS: z.coerce.number().default(24),
  /** 每个数据库在服务器上保留最近几份迁移前备份 */
  BACKUP_KEEP: z.coerce.number().int().min(1).default(5),
  /** 上传地址的有效期 */
  UPLOAD_TTL_MINUTES: z.coerce.number().int().default(15),
  MAX_APPS_PER_USER: z.coerce.number().int().default(5),
  /** 同一应用连续可修复失败达到这个次数后,不再让 agent 重试 */
  MAX_FIX_ATTEMPTS: z.coerce.number().int().default(3),
  /** fake:全部用内存假实现,本地开发用;dokploy:对接真实 Dokploy */
  FERRY_PLATFORM: z.enum(["fake", "dokploy"]).default("fake"),
  DOKPLOY_URL: z.string().optional(),
  DOKPLOY_API_KEY: z.string().optional(),
  /** 平台管理员的用户 ID,逗号分隔。管理员可以查看全部应用并停用任意应用 */
  ADMIN_USERS: z.string().default(""),
  /** true 时从 x-ferry-user 请求头读取身份,仅限本地开发 */
  DEV_AUTH: z.enum(["true", "false"]).default("true"),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env);
}
