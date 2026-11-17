import { randomBytes } from "node:crypto";
import type { DokployClient } from "./dokploy-client";
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
  /** 构建失败时取多少行日志交给 agent */
  failureLogLines?: number;
  /** 一次性命令、备份的最长等待时间 */
  commandTimeoutMs?: number;
  /** 新建数据库用的镜像 */
  postgresImage?: string;
  /** 迁移前备份存放的目录(Dokploy 所在服务器上) */
  backupRoot?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
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
}

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
  private readonly failureLogLines: number;
  private readonly commandTimeoutMs: number;
  private readonly postgresImage: string;
  private readonly backupRoot: string;
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
    this.failureLogLines = options.failureLogLines ?? 200;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30 * 60_000;
    this.postgresImage = options.postgresImage ?? "postgres:16";
    this.backupRoot = options.backupRoot ?? "/etc/dokploy/ferry-backups";
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

    let db = await this.postgres(postgresId);
    if (db.applicationStatus !== "done") {
      await this.client.mutate("postgres.deploy", { postgresId });
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
    if (domains.some((d) => d.host === input.host)) return;
    await this.client.mutate("domain.create", {
      host: input.host,
      port: input.port,
      https: this.https,
      certificateType: this.certificateType,
      applicationId: input.appId,
      domainType: "application",
    });
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
        return { ok: false, logs };
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
    return { ok: false, logs: run.logs };
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

  private async defaultEnvironment(projectId: string): Promise<DokployEnvironment> {
    const project = await this.client.query<DokployProject>("project.one", { projectId });
    const environments = project.environments ?? [];
    const environment = environments.find((e) => e.isDefault) ?? environments[0];
    if (!environment) throw new Error(`部署平台上的项目 ${projectId} 没有环境`);
    return environment;
  }

  /** 构建完成后,等新容器实际运行、旧容器全部停止 */
  private async waitForNewTask(appId: string, appName: string, oldTasks: Set<string>, deadline: number): Promise<CommandResult> {
    const startDeadline = Math.min(deadline, Date.now() + this.startTimeoutMs);
    for (;;) {
      const running = (await this.tasks(appName)).filter(isActuallyRunning);
      const newRunning = running.some((t) => !oldTasks.has(t.containerId));
      const oldRunning = running.some((t) => oldTasks.has(t.containerId));
      if (newRunning && !oldRunning) return { ok: true };
      if (Date.now() > startDeadline) {
        const logs = await this.getLogs(appId, this.failureLogLines).catch(() => "");
        return { ok: false, logs: `构建成功,但应用容器没有启动起来。应用日志:\n${logs}` };
      }
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
  private async runOnce(schedule: Record<string, unknown>): Promise<{ status: string; logs: string }> {
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
        status === "done" || !deploymentId
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
  return { ok: false, logs: `部署平台:${reason},已等待超过上限。请联系平台管理员查看部署平台的状态` };
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
