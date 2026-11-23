import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().default(8080),
  /** 监听地址。Traefik 要能访问到 /authz;本机 Docker Desktop 里的容器能访问到 127.0.0.1 */
  HOST: z.string().default("127.0.0.1"),
  /** Traefik 访问 Ferry 的 /authz 用的地址。默认是 Docker Desktop 里容器访问本机的地址 */
  GATEWAY_AUTH_URL: z.string().optional(),
  /**
   * 签网关 cookie、算健康检查口令的密钥。不设置时每次启动随机生成:重启后访问者要重新跳一次登录(已登录 Ferry 的话是自动的)
   */
  GATEWAY_SECRET: z.string().min(32).optional(),
  /** 访问应用的网关 cookie 有效期(小时)。退出 Ferry 不会让它提前失效,离职会(每个请求都检查) */
  GATEWAY_COOKIE_HOURS: z.coerce.number().positive().default(12),
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
  /**
   * 浏览器和 agent 访问本服务用的完整地址,上传地址、控制台地址都按它拼。
   * 只在本机监听(HOST 是 127.0.0.1 等)时可以不设,默认 http://127.0.0.1:<PORT>;
   * 否则必须设置,不然交给 agent 的上传地址是别的机器访问不到的 127.0.0.1
   */
  PUBLIC_URL: z.url({ protocol: /^https?$/ }).optional(),
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
  /**
   * 每个应用的资源上限(任务 2.8):CPU 核数(可以是小数)和内存(MB)。设为 0 表示不限制。
   * 超出内存上限的应用会被杀掉重启,不会拖垮同一台服务器上的其他应用和 Ferry
   */
  APP_CPU_LIMIT: z.coerce.number().min(0).default(1),
  APP_MEMORY_LIMIT_MB: z.coerce.number().int().min(0).default(512),
  /** 每个应用的数据库的资源上限,含义同上 */
  DB_CPU_LIMIT: z.coerce.number().min(0).default(1),
  DB_MEMORY_LIMIT_MB: z.coerce.number().int().min(0).default(512),
  /** 同一应用连续可修复失败达到这个次数后,不再让 agent 重试 */
  MAX_FIX_ATTEMPTS: z.coerce.number().int().default(3),
  /**
   * 发布前的密钥扫描(任务 3.1)。gitleaks:用 gitleaks 扫描代码包,启动时找不到 gitleaks 会直接退出;
   * off:不扫描,只用于没装 gitleaks 的临时试用
   */
  SECRET_SCAN: z.enum(["gitleaks", "off"]).default("gitleaks"),
  /** gitleaks 可执行文件,默认在 PATH 里找(macOS 上 brew install gitleaks) */
  GITLEAKS_PATH: z.string().default("gitleaks"),
  /**
   * 加密应用密钥(控制台上给应用配置的第三方 API key 等,任务 3.8)用的密钥,至少 32 个字符,
   * 生成:openssl rand -hex 32。用数据库时不设置就不能保存密钥;改了之后已保存的密钥都无法解密(要重新填写)。
   * 只用内存存储时可以不设置,每次启动随机生成
   */
  SECRETS_KEY: z.string().min(32).optional(),
  /** fake:全部用内存假实现,本地开发用;dokploy:对接真实 Dokploy */
  FERRY_PLATFORM: z.enum(["fake", "dokploy"]).default("fake"),
  DOKPLOY_URL: z.string().optional(),
  DOKPLOY_API_KEY: z.string().optional(),
  /**
   * 同一类可以合并的告警(部署平台或 Ferry 出错导致发布失败)多久内只发一次。
   * 发布连续失败、备份失败每次都发,不受它影响
   */
  ALERT_COOLDOWN_MINUTES: z.coerce.number().positive().default(30),
  /**
   * 固定的平台管理员(用户 ID,逗号分隔):始终是管理员,控制台上不能取消。可以不设,管理员都在控制台上设置;
   * 第一个管理员用 pnpm set-password <手机号> --name <姓名> 建。管理员可以管理全部应用、人员和部门,并接收告警
   */
  ADMIN_USERS: z.string().default(""),
  /**
   * true 时,没有带任何凭据的请求可以用 x-ferry-user 请求头自称是谁。只能用于本地开发,默认关闭
   */
  DEV_AUTH: z.enum(["true", "false"]).default("false"),
  /**
   * 通知(给负责人的通知、给管理员的告警)怎么发。log:写进服务日志。
   * 一期没有对外发通知的渠道,不设置时通知内容不会记录
   */
  NOTIFY_VIA: z.enum(["log"]).optional(),
  /** 登录有效期 */
  SESSION_DAYS: z.coerce.number().positive().default(7),
  /**
   * 允许用登录 cookie 发起修改请求的来源(Ferry 自己的页面),逗号分隔。
   * PUBLIC_URL 的来源总是允许;本地用控制台开发服务器时加上 http://localhost:5173
   */
  ALLOWED_ORIGINS: z.string().default(""),
}).superRefine((env, ctx) => {
  if (!env.PUBLIC_URL && !isLoopbackHost(env.HOST)) {
    ctx.addIssue({
      code: "custom",
      path: ["PUBLIC_URL"],
      message:
        `HOST=${env.HOST} 会接受其他机器的连接,必须设置 PUBLIC_URL(agent 和浏览器访问 Ferry 用的地址,如 https://ferry.corp.example);` +
        "否则交给 agent 的上传地址是 127.0.0.1,别的机器或容器里的 agent 访问不到",
    });
  }
});

/** 只接受本机连接的监听地址 */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127(\.\d{1,3}){3}$/.test(host);
}

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return envSchema.parse(env);
}
