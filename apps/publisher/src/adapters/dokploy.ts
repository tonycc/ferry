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
 *
 * 数据库、迁移命令、备份(createDatabase、runCommand、backupDatabase)属于任务 1.5,还没有实现。
 */

export interface DokployPlatformOptions {
  /** 域名是否走 HTTPS。本机开发为 false;企业环境用泛域名证书时为 true */
  https?: boolean;
  /** 域名证书类型。本机开发为 none;企业环境用自有证书时为 custom */
  certificateType?: "none" | "letsencrypt" | "custom";
  /** 等待部署结束时的轮询间隔 */
  pollIntervalMs?: number;
  /** 单次部署(含等待之前的部署结束)的最长等待时间 */
  deployTimeoutMs?: number;
  /** 构建失败时取多少行日志交给 agent */
  failureLogLines?: number;
  sleep?: (ms: number) => Promise<void>;
}

const PROJECT_PREFIX = "ferry-";

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
  private readonly failureLogLines: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly client: DokployClient,
    options: DokployPlatformOptions = {},
  ) {
    this.https = options.https ?? false;
    this.certificateType = options.certificateType ?? "none";
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.deployTimeoutMs = options.deployTimeoutMs ?? 15 * 60_000;
    this.failureLogLines = options.failureLogLines ?? 200;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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

  createDatabase(_input: { projectId: string; name: string }): Promise<{ databaseId: string; connectionUrl: string }> {
    return this.notImplemented("createDatabase(任务 1.5)");
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
   */
  async deploy(appId: string, archive: Archive): Promise<CommandResult> {
    const deadline = Date.now() + this.deployTimeoutMs;
    let before = await this.deployments(appId);
    while (before.some((d) => d.status === "running")) {
      if (Date.now() > deadline) return timeout("之前的部署一直没有结束");
      await this.sleep(this.pollIntervalMs);
      before = await this.deployments(appId);
    }
    const seen = new Set(before.map((d) => d.deploymentId));

    const form = new FormData();
    form.set("applicationId", appId);
    form.set("zip", new Blob([new Uint8Array(archive.zip)], { type: "application/zip" }), `${archive.version}.zip`);
    await this.client.upload("application.dropDeployment", form);

    for (;;) {
      const current = (await this.deployments(appId)).find((d) => !seen.has(d.deploymentId));
      if (current?.status === "done") return { ok: true };
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

  runCommand(_appId: string, _command: string): Promise<CommandResult> {
    return this.notImplemented("runCommand(任务 1.5)");
  }

  backupDatabase(_databaseId: string): Promise<string> {
    return this.notImplemented("backupDatabase(任务 1.5)");
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

  private deployments(appId: string): Promise<DokployDeployment[]> {
    return this.client.query<DokployDeployment[]>("deployment.all", { applicationId: appId });
  }

  private notImplemented(method: string): Promise<never> {
    return Promise.reject(new Error(`DokployPlatform.${method} 尚未实现`));
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
