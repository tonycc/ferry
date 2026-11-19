import { randomBytes } from "node:crypto";
import { DokployError, type DokployClient } from "./dokploy-client";
import type { Archive, CommandResult, DeployPlatform } from "./types";

/**
 * 对接真实 Dokploy(v0.31.3 实测)。各接口的用法和坑见 docs/dokploy-findings.md。
 *
 * - 创建前先按名称查找,找到就复用:建好资源、还没记下 ID 时进程退出,恢复后不会再建一个。
 *   为了不误用别人在 Dokploy 里手动建的项目,Ferry 建的项目统一加 `ferry-` 前缀。
 * - 应用和数据库建在项目的默认“环境”下。对外仍以项目 ID 作为引用(删除项目时要用),
 *   需要环境 ID 时在这里查。
 * - 不把 Dokploy 的响应内容放进报错信息,见 DokployError。
 * - 一次性命令和备份都用“手动触发的定时任务”执行:每次新建、触发、删除。
 */

export interface DokployPlatformOptions {
  /** 域名是否走 HTTPS。本机开发为 false;企业环境用泛域名证书时为 true */
  https?: boolean;
  /** 域名证书类型。本机开发为 none;企业环境用自有证书时为 custom */
  certificateType?: "none" | "letsencrypt" | "custom";
  /** 等待部署结束时的轮询间隔 */
  pollIntervalMs?: number;
  /** 单次部署(含等待之前的部署结束、等新容器启动)的最长等待时间 */
  deployTimeoutMs?: number;
  /** 构建完成后等新容器启动的最长时间(不超过 deployTimeoutMs 的剩余时间) */
  startTimeoutMs?: number;
  /** 新容器要连续运行这么久才算启动成功:启动即崩溃的容器会短暂显示为 Running(实测) */
  stableMs?: number;
  /** 构建失败时取多少行日志交给 agent */
  failureLogLines?: number;
  /** 一次性命令、备份的最长等待时间 */
  commandTimeoutMs?: number;
  /** 新建数据库用的镜像 */
  postgresImage?: string;
  /** 迁移前备份存放的目录(Dokploy 所在服务器上) */
  backupRoot?: string;
  /** 每个数据库保留最近几份备份,更早的在备份成功后删除 */
  backupKeep?: number;
  /**
   * 挂在应用域名上的登录网关中间件。null 表示不挂(只用于单独测试适配器,
   * 那时没有运行 Ferry,挂上网关就访问不了应用)
   */
  gatewayMiddleware?: string | null;
  /**
   * 每个应用和每个数据库的资源上限,让单个应用耗尽 CPU 或内存时不影响其他应用和 Ferry。
   * null 表示不限制。超出内存上限的容器会被系统杀掉并重启;CPU 只会被限速
   */
  appLimits?: ResourceLimits | null;
  databaseLimits?: ResourceLimits | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface ResourceLimits {
  /** CPU 核数,可以是小数,如 0.5;0 表示不限制 */
  cpus: number;
  /** 0 表示不限制 */
  memoryMb: number;
}

/**
 * Dokploy 原样把这两个字段交给 Docker:CPU 是纳核(1 核 = 10^9),内存是字节(实测,见 dokploy-findings.md)。
 * 预留值为空:本机和小规模部署不需要预留,只要上限
 */
function limitFields(limits: ResourceLimits | null) {
  return {
    cpuLimit: limits?.cpus ? String(Math.round(limits.cpus * 1e9)) : null,
    memoryLimit: limits?.memoryMb ? String(Math.round(limits.memoryMb * 1024 * 1024)) : null,
    cpuReservation: null,
    memoryReservation: null,
  };
}

const PROJECT_PREFIX = "ferry-";
const COMMAND_SCHEDULE_PREFIX = "ferry-command-";
const BACKUP_SCHEDULE_PREFIX = "ferry-backup-";
/** 不会自动触发的 cron 表达式,配合 enabled: false,只靠手动触发 */
const NEVER = "0 0 1 1 *";
/** 拼进备份脚本的名称只允许这些字符,防止注入 */
const SAFE_NAME = /^[a-zA-Z0-9._-]+$/;

interface DokployProject {
  projectId: string;
  name: string;
  environments?: DokployEnvironment[];
}

interface DokployEnvironment {
  environmentId: string;
  name: string;
  isDefault?: boolean;
  applications?: { applicationId: string; name: string; appName: string }[];
  postgres?: { postgresId: string; name: string; appName: string }[];
}

interface DokployPostgres {
  postgresId: string;
  appName: string;
  databaseName: string;
  databaseUser: string;
  databasePassword: string;
  applicationStatus: string;
}

interface DokploySchedule {
  scheduleId: string;
  name: string;
}

/**
 * docker.getServiceContainersByAppName 的一项:Swarm 服务的一个任务(容器)。
 * 注意 `state` 是期望状态,还在启动的容器也是 "running";实际状态要看 `currentState`,如 "Running 9 seconds ago"。
 */
interface DokployServiceTask {
  containerId: string;
  state: string;
  currentState: string;
}

function isActuallyRunning(task: DokployServiceTask): boolean {
  return task.currentState.startsWith("Running");
}

/** 部署平台上已经没有这个资源(删除时可以当作已经删掉) */
function isNotFound(err: unknown): boolean {
  return err instanceof DokployError && err.status === 404;
}

/** 容器已经退出(启动后崩溃) */
function hasExited(task: DokployServiceTask): boolean {
  return /^(Failed|Complete|Rejected)/.test(task.currentState);
}

const TIMESTAMPED = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?(.*)$/;

/**
 * 整理启动失败时的应用日志。Swarm 反复重启崩溃的容器,读到的日志是几次启动的输出混在一起,
 * 每行带着 Docker 加的时间戳,顺序也可能是乱的。按时间排好,只保留最后一次启动的输出,去掉时间戳。
 * 相邻两行间隔超过 2 秒就算另一次启动。
 */
export function lastStartLogs(raw: string): string {
  const lines = raw.split("\n").filter((line) => line.trim());
  const parsed = lines.map((line) => {
    const m = TIMESTAMPED.exec(line);
    return m ? { at: Date.parse(m[1]!), text: m[2]! } : undefined;
  });
  if (parsed.some((p) => p === undefined) || parsed.length === 0) return raw;
  const sorted = (parsed as { at: number; text: string }[]).sort((a, b) => a.at - b.at);
  let start = 0;
  for (let i = 1; i < sorted.length; i++) if (sorted[i]!.at - sorted[i - 1]!.at > 2000) start = i;
  const last = sorted.slice(start).map((p) => p.text);
  const note = start > 0 ? "(容器启动后退出,被反复重启;下面是最后一次启动的输出)\n" : "";
  return note + last.join("\n");
}

interface ScheduleRun {
  status: string;
  deploymentId?: string;
}

interface DokployApplication {
  applicationId: string;
  appName: string;
  env: string | null;
}

interface DokployDomain {
  domainId: string;
  host: string;
  port: number | null;
  path: string | null;
  middlewares: string[] | null;
}

/** Ferry 写进 Traefik 的登录网关中间件,挂在每个应用的域名上 */
export const GATEWAY_MIDDLEWARE = "ferry-gateway@file";
const GATEWAY_FILE = "/etc/dokploy/traefik/dynamic/ferry-gateway.yml";

interface DokployDeployment {
  deploymentId: string;
  status: "idle" | "running" | "done" | "error" | string;
  createdAt?: string;
}

export class DokployPlatform implements DeployPlatform {
  private readonly https: boolean;
  private readonly certificateType: "none" | "letsencrypt" | "custom";
  private readonly pollIntervalMs: number;
  private readonly deployTimeoutMs: number;
  private readonly startTimeoutMs: number;
  private readonly stableMs: number;
  private readonly failureLogLines: number;
  private readonly commandTimeoutMs: number;
  private readonly postgresImage: string;
  private readonly backupRoot: string;
  private readonly backupKeep: number;
  private readonly gatewayMiddleware: string | null;
  private readonly appLimits: ResourceLimits | null;
  private readonly databaseLimits: ResourceLimits | null;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(
    private readonly client: DokployClient,
    options: DokployPlatformOptions = {},
  ) {
    this.https = options.https ?? false;
    this.certificateType = options.certificateType ?? "none";
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.deployTimeoutMs = options.deployTimeoutMs ?? 15 * 60_000;
    this.startTimeoutMs = options.startTimeoutMs ?? 3 * 60_000;
    this.stableMs = options.stableMs ?? 8000;
    this.failureLogLines = options.failureLogLines ?? 200;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30 * 60_000;
    this.postgresImage = options.postgresImage ?? "postgres:16";
    this.backupRoot = options.backupRoot ?? "/etc/dokploy/ferry-backups";
    this.backupKeep = Math.max(1, Math.floor(options.backupKeep ?? 5));
    this.gatewayMiddleware = options.gatewayMiddleware === undefined ? GATEWAY_MIDDLEWARE : options.gatewayMiddleware;
    this.appLimits = options.appLimits ?? null;
    this.databaseLimits = options.databaseLimits ?? null;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
  }

  async createProject(name: string): Promise<string> {
    const projectName = PROJECT_PREFIX + name;
    const projects = await this.client.query<DokployProject[]>("project.all");
    const existing = projects.find((p) => p.name === projectName);
    if (existing) return existing.projectId;
    const created = await this.client.mutate<{ project: DokployProject }>("project.create", { name: projectName });
    return created.project.projectId;
  }

  async createApp(input: { projectId: string; name: string; port: number }): Promise<string> {
    const environment = await this.defaultEnvironment(input.projectId);
    const existing = environment.applications?.find((a) => a.name === input.name);
    const applicationId =
      existing?.applicationId ??
      (
        await this.client.mutate<DokployApplication>("application.create", {
          name: input.name,
          appName: input.name,
          environmentId: environment.environmentId,
        })
      ).applicationId;

    // 用代码包里的 Dockerfile 构建。这个接口要求所有字段都传,不用的传空值
    await this.client.mutate("application.saveBuildType", {
      applicationId,
      buildType: "dockerfile",
      dockerfile: "Dockerfile",
      dockerContextPath: "",
      dockerBuildStage: "",
      herokuVersion: null,
      railpackVersion: null,
    });
    return applicationId;
  }

  /**
   * 按名称查找或新建数据库,并确保它已启动。postgres.deploy 会等数据库启动后才返回(实测约 50 秒)。
   * 下线时停掉的数据库状态是 idle,这里同样重新部署,数据卷不变,数据还在。
   * 连接串从 Dokploy 读回用户名和密码再拼,所以复用已有数据库时也能拿到。
   */
  async createDatabase(input: { projectId: string; name: string }): Promise<{ databaseId: string; connectionUrl: string }> {
    const name = `${input.name}-db`;
    const environment = await this.defaultEnvironment(input.projectId);
    const existing = environment.postgres?.find((p) => p.name === name);
    const postgresId =
      existing?.postgresId ??
      (
        await this.client.mutate<{ postgresId: string }>("postgres.create", {
          name,
          appName: name,
          databaseName: "app",
          databaseUser: "app",
          databasePassword: randomBytes(16).toString("hex"),
          dockerImage: this.postgresImage,
          environmentId: environment.environmentId,
        })
      ).postgresId;

    // 每次都设一遍资源上限;已经在运行的数据库要等下次重新启动(下线后重新发布)才生效
    await this.client.mutate("postgres.update", { postgresId, ...limitFields(this.databaseLimits) });
    let db = await this.postgres(postgresId);
    if (db.applicationStatus !== "done") {
      try {
        await this.client.mutate("postgres.deploy", { postgresId });
      } catch (err) {
        // Dokploy 只等 45 秒;机器忙的时候新数据库启动得慢,接口报错但容器随后会起来(实测)。再等一会儿
        if (!(await this.waitUntilRunning(db.appName))) throw err;
      }
      db = await this.postgres(postgresId);
    }
    const user = encodeURIComponent(db.databaseUser);
    const password = encodeURIComponent(db.databasePassword);
    return {
      databaseId: postgresId,
      connectionUrl: `postgresql://${user}:${password}@${db.appName}:5432/${db.databaseName}`,
    };
  }

  async attachDomain(input: { appId: string; host: string; port: number }): Promise<void> {
    const domains = await this.client.query<DokployDomain[]>("domain.byApplicationId", { applicationId: input.appId });
    const existing = domains.find((d) => d.host === input.host);
    // 每次都传完整的期望状态:不确定 domain.update 会不会把没传的字段重置
    const gateway = this.gatewayMiddleware ? [this.gatewayMiddleware] : [];
    const desired = {
      host: input.host,
      port: input.port,
      https: this.https,
      certificateType: this.certificateType,
      middlewares: gateway,
      domainType: "application",
    };
    if (!existing) {
      await this.client.mutate("domain.create", { ...desired, applicationId: input.appId });
      return;
    }
    const gated = gateway.every((m) => existing.middlewares?.includes(m));
    if (existing.port === input.port && gated) return;
    await this.client.mutate("domain.update", {
      ...desired,
      domainId: existing.domainId,
      path: existing.path ?? "/",
      middlewares: [...new Set([...(existing.middlewares ?? []), ...gateway])],
    });
  }

  /**
   * 写入登录网关的 Traefik 配置(Dokploy 的 settings.updateTraefikFile,文件在 dynamic/ 下,Traefik 自动加载)。
   * 顺序:删掉请求里的身份头 → 问 Ferry 的 /authz → 删掉健康检查口令。
   * 身份头在调用 /authz 之前删掉,所以应用收到的身份头只能来自 /authz;健康检查口令在放行后删掉,应用收不到。
   */
  async ensureGateway(input: { authAddress: string }): Promise<void> {
    const config = [
      "# 由 Ferry 在启动时写入,不要手动修改",
      "http:",
      "  middlewares:",
      "    ferry-strip-identity:",
      "      headers:",
      "        customRequestHeaders:",
      '          X-Ferry-User-Id: ""',
      '          X-Ferry-User-Name: ""',
      '          X-Ferry-User-Departments: ""',
      "    ferry-auth:",
      "      forwardAuth:",
      `        address: ${JSON.stringify(input.authAddress)}`,
      "        trustForwardHeader: false",
      "        authResponseHeaders:",
      "          - X-Ferry-User-Id",
      "          - X-Ferry-User-Name",
      "          - X-Ferry-User-Departments",
      "    ferry-strip-health:",
      "      headers:",
      "        customRequestHeaders:",
      '          X-Ferry-Health: ""',
      "    ferry-gateway:",
      "      chain:",
      "        middlewares:",
      "          - ferry-strip-identity",
      "          - ferry-auth",
      "          - ferry-strip-health",
      "",
    ].join("\n");
    await this.client.mutate("settings.updateTraefikFile", { path: GATEWAY_FILE, traefikConfig: config });
  }

  /**
   * Dokploy 的 saveEnvironment 会整体覆盖全部变量,所以先读出原有的再合并。
   * 读出的内容里有数据库连接串等密钥,只在这里使用,不写日志、不放进报错。
   */
  async setEnv(appId: string, env: Record<string, string>): Promise<void> {
    const app = await this.client.query<DokployApplication>("application.one", { applicationId: appId });
    const merged = { ...parseEnv(app.env ?? ""), ...env };
    await this.client.mutate("application.saveEnvironment", {
      applicationId: appId,
      env: formatEnv(merged),
      buildArgs: "",
      buildSecrets: "",
      createEnvFile: false,
    });
  }

  /**
   * 上传代码包并等这次部署结束。
   *
   * 1. 先等这个应用正在进行的部署结束:进程重启后恢复发布、回滚时,上一次构建可能还在跑,不能叠在一起。
   * 2. 记下已有的部署记录,上传后等出现一条新的,只跟踪这一条。不能只看“最新一条”,
   *    上传接口返回时新记录可能还没写入。
   * 3. 部署记录显示完成时,新容器可能还没启动(实测晚了 16 秒),旧容器也可能还在运行(先启动新的再停旧的)。
   *    这时执行迁移、健康检查,可能落在旧容器上,把旧版本误判为新版本可用。
   *    所以要等到:一个上传前没有的容器实际在运行,并且上传前的容器都已不再运行。
   */
  async deploy(appId: string, archive: Archive): Promise<CommandResult> {
    const deadline = Date.now() + this.deployTimeoutMs;
    const { appName } = await this.client.query<DokployApplication>("application.one", { applicationId: appId });
    let before = await this.deployments(appId);
    while (before.some((d) => d.status === "running")) {
      if (Date.now() > deadline) return timeout("之前的部署一直没有结束");
      await this.sleep(this.pollIntervalMs);
      before = await this.deployments(appId);
    }
    const seen = new Set(before.map((d) => d.deploymentId));
    // 上传前已有的容器(不论状态),之后出现的才算这次部署的新容器
    const oldTasks = new Set((await this.tasks(appName)).map((t) => t.containerId));

    // 每次部署前都设一遍资源上限:已有的应用和调整过的配置,在下次发布或回滚时生效
    await this.client.mutate("application.update", { applicationId: appId, ...limitFields(this.appLimits) });

    const form = new FormData();
    form.set("applicationId", appId);
    form.set("zip", new Blob([new Uint8Array(archive.zip)], { type: "application/zip" }), `${archive.version}.zip`);
    await this.client.upload("application.dropDeployment", form);

    for (;;) {
      const current = (await this.deployments(appId)).find((d) => !seen.has(d.deploymentId));
      if (current?.status === "done") return this.waitForNewTask(appId, appName, oldTasks, deadline);
      if (current?.status === "error") {
        const logs = await this.client.query<string>("deployment.readLogs", {
          deploymentId: current.deploymentId,
          tail: this.failureLogLines,
        });
        return { ok: false, reason: "build", logs };
      }
      if (Date.now() > deadline) return timeout(current ? "构建超时" : "上传后没有看到新的部署记录");
      await this.sleep(this.pollIntervalMs);
    }
  }

  /**
   * 在正在运行的应用容器里执行一条命令(数据库迁移)。
   * 进程重启前留下的同类任务如果还在执行,先等它结束再删掉,避免两次迁移同时作用于一个数据库。
   */
  async runCommand(appId: string, command: string): Promise<CommandResult> {
    const leftovers = (
      await this.client.query<DokploySchedule[]>("schedule.list", { id: appId, scheduleType: "application" })
    ).filter((s) => s.name.startsWith(COMMAND_SCHEDULE_PREFIX));
    for (const schedule of leftovers) {
      await this.waitForScheduleIdle(schedule.scheduleId);
      await this.client.mutate("schedule.delete", { scheduleId: schedule.scheduleId });
    }

    const run = await this.runOnce({
      name: `${COMMAND_SCHEDULE_PREFIX}${this.now().getTime()}`,
      cronExpression: NEVER,
      command,
      shellType: "sh",
      scheduleType: "application",
      applicationId: appId,
      enabled: false,
    });
    if (run.status === "done") return { ok: true };
    return { ok: false, reason: "command", logs: run.logs };
  }

  /**
   * 迁移前备份:在 Dokploy 所在服务器上对数据库容器执行 pg_dump,存为本机文件,返回文件路径。
   * 一期不做异地备份,见 docs/dokploy-findings.md。失败时抛错,发布终止,不会在没有备份的情况下迁移。
   */
  async backupDatabase(databaseId: string): Promise<string> {
    const db = await this.postgres(databaseId);
    for (const value of [db.appName, db.databaseUser, db.databaseName]) {
      if (!SAFE_NAME.test(value)) throw new Error(`数据库名称含有不支持的字符,无法备份: ${databaseId}`);
    }
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    const dir = `${this.backupRoot}/${db.appName}`;
    const file = `${dir}/${stamp}.sql.gz`;
    const script = [
      "set -euo pipefail",
      `mkdir -p ${dir}`,
      `trap 'rm -f ${file}.tmp' ERR`,
      `cid=$(docker ps -q -f name=^${db.appName}\\. | head -n1)`,
      'if [ -z "$cid" ]; then echo "找不到数据库容器"; exit 1; fi',
      `docker exec "$cid" pg_dump -U ${db.databaseUser} -d ${db.databaseName} | gzip > ${file}.tmp`,
      `mv ${file}.tmp ${file}`,
      `echo "备份完成: ${file}"`,
      // 文件名以时间开头,按名称倒序即从新到旧;只保留最新的几份
      `ls -1 ${dir}/*.sql.gz | sort -r | tail -n +${this.backupKeep + 1} | xargs -r rm -f`,
    ].join("\n");

    // dokploy-server 类型执行的是 script 字段,command 只是占位
    const run = await this.runOnce({
      name: `${BACKUP_SCHEDULE_PREFIX}${this.now().getTime()}`,
      cronExpression: NEVER,
      command: "ferry-backup",
      script,
      shellType: "bash",
      scheduleType: "dokploy-server",
      enabled: false,
    });
    if (run.status !== "done") {
      console.error(`数据库 ${db.appName} 迁移前备份失败:\n${run.logs}`);
      throw new Error("迁移前备份数据库失败,发布已终止。请联系平台管理员");
    }
    return file;
  }

  async getLogs(appId: string, lines: number): Promise<string> {
    return this.client.query<string>("application.readLogs", { applicationId: appId, tail: lines });
  }

  async stopApp(appId: string): Promise<void> {
    await this.client.mutate("application.stop", { applicationId: appId });
  }

  async startApp(appId: string): Promise<void> {
    await this.client.mutate("application.start", { applicationId: appId });
  }

  /**
   * 删除应用(域名和路由随之删除),并等它的容器全部停掉。
   * 先删这个应用上可能残留的 ferry-command-* 任务:它们属于应用,删除应用后就无法再通过接口找到。
   */
  async removeApp(appId: string): Promise<void> {
    const { appName } = await this.client.query<DokployApplication>("application.one", { applicationId: appId });
    const schedules = await this.client.query<DokploySchedule[]>("schedule.list", { id: appId, scheduleType: "application" });
    for (const schedule of schedules.filter((s) => s.name.startsWith(COMMAND_SCHEDULE_PREFIX))) {
      await this.client.mutate("schedule.delete", { scheduleId: schedule.scheduleId });
    }
    await this.client.mutate("application.delete", { applicationId: appId });

    const deadline = Date.now() + this.startTimeoutMs;
    // 服务删掉后查询容器可能直接报“找不到服务”,也算已停止
    while ((await this.tasks(appName).catch(() => [])).some(isActuallyRunning)) {
      if (Date.now() > deadline) throw new Error("部署平台上的应用已删除,但容器一直没有停止");
      await this.sleep(this.pollIntervalMs);
    }
  }

  /** 停止数据库,数据卷保留(实测 postgres.stop 后状态变为 idle,重新部署后数据还在) */
  async stopDatabase(databaseId: string): Promise<void> {
    await this.client.mutate("postgres.stop", { postgresId: databaseId });
  }

  /**
   * 彻底删除数据库。先停掉数据库、在服务器上删掉数据卷和迁移前备份,最后才删 Dokploy 里的记录:
   * 中途失败时记录还在,再调用一次能接着做完(反过来先删记录的话,就查不到数据卷叫什么了)。
   * postgres.remove 本身不删数据卷(实测,见 dokploy-findings.md)
   */
  async deleteDatabase(databaseId: string): Promise<void> {
    let db: DokployPostgres;
    try {
      db = await this.postgres(databaseId);
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
    // 名称拼进要在服务器上执行的脚本,只允许安全字符;备份目录必须是绝对路径且不是根目录
    // 这里会 rm -rf 备份目录:名称必须以字母或数字开头、不含 "..",免得拼出上级目录
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(db.appName) || db.appName.includes("..")) {
      throw new Error(`数据库名称含有不支持的字符,无法删除: ${databaseId}`);
    }
    if (!/^\/[a-zA-Z0-9._/-]+$/.test(this.backupRoot) || this.backupRoot.split("/").filter(Boolean).length < 2) {
      throw new Error(`备份目录不安全,拒绝删除: ${this.backupRoot}`);
    }
    await this.client.mutate("postgres.stop", { postgresId: databaseId });

    const volume = `${db.appName}-data`;
    const backups = `${this.backupRoot}/${db.appName}`;
    const script = [
      "set -u",
      // 容器停下来之前删不掉数据卷,最多等 60 秒
      "for i in $(seq 1 30); do",
      `  docker volume inspect ${volume} >/dev/null 2>&1 || break`,
      `  docker volume rm ${volume} >/dev/null 2>&1 && break`,
      "  sleep 2",
      "done",
      `if docker volume inspect ${volume} >/dev/null 2>&1; then echo "数据卷 ${volume} 删不掉"; exit 1; fi`,
      `rm -rf -- ${backups}`,
      `echo "已删除数据卷 ${volume} 和备份目录 ${backups}"`,
    ].join("\n");
    const run = await this.runOnce({
      name: `${BACKUP_SCHEDULE_PREFIX}delete-${this.now().getTime()}`,
      cronExpression: NEVER,
      command: "ferry-delete-database",
      script,
      shellType: "bash",
      scheduleType: "dokploy-server",
      enabled: false,
    });
    if (run.status !== "done") {
      console.error(`删除数据库 ${db.appName} 的数据失败:\n${run.logs}`);
      throw new Error("删除数据库的数据失败,请查看 Ferry 的日志后重试");
    }
    await this.client.mutate("postgres.remove", { postgresId: databaseId }).catch((err: unknown) => {
      if (!isNotFound(err)) throw err;
    });
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.client.mutate("project.remove", { projectId }).catch((err: unknown) => {
      if (!isNotFound(err)) throw err;
    });
  }

  private async defaultEnvironment(projectId: string): Promise<DokployEnvironment> {
    const project = await this.client.query<DokployProject>("project.one", { projectId });
    const environments = project.environments ?? [];
    const environment = environments.find((e) => e.isDefault) ?? environments[0];
    if (!environment) throw new Error(`部署平台上的项目 ${projectId} 没有环境`);
    return environment;
  }

  /**
   * 构建完成后,等新容器实际运行、旧容器全部停止。
   * 新容器连续退出两次就是启动即崩溃(Swarm 会一直重启它),不再等到超时
   */
  private async waitForNewTask(appId: string, appName: string, oldTasks: Set<string>, deadline: number): Promise<CommandResult> {
    const startDeadline = Math.min(deadline, Date.now() + this.startTimeoutMs);
    /** 新容器第一次被看到在运行的时间;它退出或换了一个容器就重新计时 */
    let stable: { containerId: string; since: number } | undefined;
    for (;;) {
      const tasks = (await this.tasks(appName)).filter((t) => !oldTasks.has(t.containerId) || isActuallyRunning(t));
      const running = tasks.filter(isActuallyRunning);
      const newTask = running.find((t) => !oldTasks.has(t.containerId));
      const oldRunning = running.some((t) => oldTasks.has(t.containerId));
      if (newTask && !oldRunning) {
        if (stable?.containerId !== newTask.containerId) stable = { containerId: newTask.containerId, since: Date.now() };
        if (Date.now() - stable.since >= this.stableMs) return { ok: true };
      } else {
        stable = undefined;
      }
      const crashed = tasks.filter((t) => !oldTasks.has(t.containerId) && hasExited(t)).length;
      if (crashed >= 2 || Date.now() > startDeadline) {
        // 先读退出的容器自己的输出;读不到再用应用日志(更新时它返回的是还在运行的旧版本的输出)
        const exited = await this.exitedContainerLogs(appName).catch(() => undefined);
        if (exited) return { ok: false, reason: "start", logs: `(应用启动后退出;下面是它最后一次启动的输出)\n${exited}` };
        const raw = await this.getLogs(appId, this.failureLogLines).catch(() => "");
        return { ok: false, reason: "start", logs: lastStartLogs(raw) };
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  /**
   * 读应用最近一个已退出容器的输出。Dokploy 的 application.readLogs 只返回正在运行的容器的输出:
   * 更新时旧版本还在运行,读到的是旧版本的日志,新版本的崩溃信息就丢了(实测)。
   * 所以在 Dokploy 所在服务器上直接用 docker logs 读(和迁移前备份一样,用 dokploy-server 类型的一次性任务)。
   * 没有已退出的容器时返回 undefined
   */
  private async exitedContainerLogs(appName: string): Promise<string | undefined> {
    if (!SAFE_NAME.test(appName)) return undefined;
    const script = [
      `cid=$(docker ps -a -q --filter "name=^${appName}\\." --filter status=exited | head -n1)`,
      'if [ -z "$cid" ]; then exit 0; fi',
      `docker logs --timestamps --tail ${this.failureLogLines} "$cid" 2>&1`,
    ].join("\n");
    const run = await this.runOnce(
      {
        name: `${COMMAND_SCHEDULE_PREFIX}logs-${this.now().getTime()}`,
        cronExpression: NEVER,
        command: "ferry-logs",
        script,
        shellType: "bash",
        scheduleType: "dokploy-server",
        enabled: false,
      },
      { logsOnSuccess: true },
    );
    // 一次性任务的日志里还有 Dokploy 自己加的行,只留 docker logs 输出的(每行以时间戳开头)
    const lines = run.logs.split("\n").filter((line) => TIMESTAMPED.test(line));
    return lines.length > 0 ? lastStartLogs(lines.join("\n")) : undefined;
  }

  /** 等服务的容器实际运行起来,最多等 startTimeoutMs */
  private async waitUntilRunning(appName: string): Promise<boolean> {
    const deadline = Date.now() + this.startTimeoutMs;
    for (;;) {
      if ((await this.tasks(appName).catch(() => [])).some(isActuallyRunning)) return true;
      if (Date.now() > deadline) return false;
      await this.sleep(this.pollIntervalMs);
    }
  }

  private tasks(appName: string): Promise<DokployServiceTask[]> {
    return this.client.query<DokployServiceTask[]>("docker.getServiceContainersByAppName", { appName });
  }

  private postgres(postgresId: string): Promise<DokployPostgres> {
    return this.client.query<DokployPostgres>("postgres.one", { postgresId });
  }

  /** 新建一个只手动触发的定时任务,执行一次后删除,返回结果和(失败时的)日志 */
  private async runOnce(
    schedule: Record<string, unknown>,
    options: { logsOnSuccess?: boolean } = {},
  ): Promise<{ status: string; logs: string }> {
    const created = await this.client.mutate<DokploySchedule>("schedule.create", schedule);
    try {
      const run = await this.client.mutate<ScheduleRun>("schedule.runManually", { scheduleId: created.scheduleId });
      let status = run.status;
      let deploymentId = run.deploymentId;
      // 实测是执行完才返回;万一返回时还在执行,按任务的执行记录等到结束
      if (status !== "done" && status !== "error") {
        const latest = await this.waitForScheduleIdle(created.scheduleId);
        status = latest?.status ?? "error";
        deploymentId = latest?.deploymentId ?? deploymentId;
      }
      const logs =
        (status === "done" && !options.logsOnSuccess) || !deploymentId
          ? ""
          : await this.client.query<string>("deployment.readLogs", { deploymentId, tail: this.failureLogLines });
      return { status, logs };
    } finally {
      await this.client.mutate("schedule.delete", { scheduleId: created.scheduleId }).catch(() => {});
    }
  }

  /** 等定时任务最近一次执行结束,返回那次执行记录 */
  private async waitForScheduleIdle(scheduleId: string): Promise<DokployDeployment | undefined> {
    const deadline = Date.now() + this.commandTimeoutMs;
    for (;;) {
      const runs = await this.client.query<DokployDeployment[]>("deployment.allByType", { id: scheduleId, type: "schedule" });
      const latest = runs[0];
      if (!latest || latest.status !== "running") return latest;
      if (Date.now() > deadline) return { ...latest, status: "error" };
      await this.sleep(this.pollIntervalMs);
    }
  }

  private deployments(appId: string): Promise<DokployDeployment[]> {
    return this.client.query<DokployDeployment[]>("deployment.all", { applicationId: appId });
  }

}

function timeout(reason: string): CommandResult {
  return { ok: false, reason: "platform", logs: `部署平台:${reason},已等待超过上限` };
}

/** 解析 KEY=value 按行拼接的环境变量文本 */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index <= 0 || line.trimStart().startsWith("#")) continue;
    env[line.slice(0, index).trim()] = line.slice(index + 1);
  }
  return env;
}

export function formatEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}
