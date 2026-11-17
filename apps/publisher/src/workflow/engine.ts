import type { Adapters, Archive } from "../adapters/types";
import { STEP_ORDER, isTerminal, type ReleaseState, type StepState } from "./states";
import type { AppRecord, ReleaseRecord, Store } from "./store";

export interface EngineConfig {
  maxFixAttempts: number;
  /** 应用地址的协议,默认 https */
  appsUrlScheme?: "http" | "https";
}

type StepResult =
  | { kind: "next" }
  | {
      kind: "fail";
      /** agent 改代码后重新发布是否可能解决 */
      fixable: boolean;
      type: string;
      message: string;
      logs?: string;
      hint?: string;
      /** 新版本已撤下,线上恢复为上一个版本 */
      rolledBack?: boolean;
    };

type Failure = Extract<StepResult, { kind: "fail" }>;

/**
 * 发布状态机。每一步执行前先看资源是否已创建,所以 run 可以安全地重复调用:
 * 进程重启、agent 修复后重新发布,都是从记录的状态继续。
 * 每一步开始前还会检查应用是否已被管理员停用,停用后发布立即终止。
 */
export class Engine {
  constructor(
    private readonly store: Store,
    private readonly adapters: Adapters,
    private readonly config: EngineConfig,
  ) {}

  async run(releaseId: string): Promise<ReleaseRecord> {
    const release = await this.store.getRelease(releaseId);
    if (!release) throw new Error(`发布单 ${releaseId} 不存在`);
    if (isTerminal(release.state)) return release;
    if (release.state === "PENDING") await this.transition(release, "VALIDATING");

    for (;;) {
      const state = release.state as StepState;
      let result: StepResult;
      const next = STEP_ORDER[STEP_ORDER.indexOf(state) + 1];
      try {
        result = (await this.stopIfDisabled(release)) ?? (await this.steps[state](release));
        // 最后一步通过后、上线之前再检查一次,避免停用和上线同时发生时应用仍在运行
        if (result.kind === "next" && !next) result = (await this.stopIfDisabled(release)) ?? result;
      } catch (err) {
        result = { kind: "fail", fixable: false, type: "internal_error", message: (err as Error).message };
      }

      if (result.kind === "fail") {
        await this.fail(release, result);
        return release;
      }
      if (!next) {
        await this.goLive(release);
        return release;
      }
      await this.transition(release, next);
    }
  }

  /**
   * 服务重启后继续执行中断的发布。各步骤都可以重跑,只有 VERIFYING 例外:
   * 它在健康检查失败时会把上一个版本部署回去,如果正是在回滚途中中断,线上跑的可能是旧版本,
   * 这时直接重做健康检查可能误判新版本可用。所以从 VERIFYING 中断的发布退回 BUILDING,重新部署这次的版本。
   */
  async resume(releaseId: string): Promise<ReleaseRecord> {
    const release = await this.store.getRelease(releaseId);
    if (!release) throw new Error(`发布单 ${releaseId} 不存在`);
    if (release.state === "VERIFYING") await this.transition(release, "BUILDING");
    return this.run(releaseId);
  }

  /** 应用已被管理员停用时:确保服务是停止的,并返回终止发布的失败结果 */
  private async stopIfDisabled(release: ReleaseRecord): Promise<Failure | undefined> {
    const app = await this.app(release);
    if (!app.disabled) return undefined;
    if (app.platform.appId) await this.adapters.platform.stopApp(app.platform.appId);
    return {
      kind: "fail",
      fixable: false,
      type: "app_disabled",
      message: "应用已被管理员停用,发布已终止",
      hint: "请联系平台管理员了解原因",
    };
  }

  private readonly steps: Record<StepState, (release: ReleaseRecord) => Promise<StepResult>> = {
    VALIDATING: async (release) => {
      const archive = await this.archive(release.appName, release.version);
      const findings = await this.adapters.scanner.scan(archive.zip);
      if (findings.length > 0) {
        return {
          kind: "fail",
          fixable: true,
          type: "scan_failed",
          message: "代码里发现了硬编码的密钥",
          logs: findings.map((f) => `${f.file ?? ""} ${f.detail}`.trim()).join("\n"),
          hint: "删除硬编码的密钥,改为从环境变量读取,然后重新发布",
        };
      }
      return { kind: "next" };
    },

    PROVISIONING: async (release) => {
      const { platform } = this.adapters;
      const { manifest } = release;
      const app = await this.app(release);

      // 每个应用一个部署平台项目,应用和它的数据库放在一起
      if (!app.platform.projectId) {
        app.platform.projectId = await platform.createProject(app.name);
        await this.store.saveApp(app);
      }
      const { projectId } = app.platform;

      if (!app.platform.appId) {
        app.platform.appId = await platform.createApp({
          projectId,
          name: app.name,
          port: manifest.port,
        });
        await this.store.saveApp(app);
      }

      if (manifest.database === "postgres" && !app.platform.databaseId) {
        const db = await platform.createDatabase({ projectId, name: app.name });
        // 先注入连接串再记下数据库 ID:反过来的话,两步之间进程重启,恢复后会以为数据库已建好,连接串就再也注入不进去了。
        // 连接串只注入应用环境变量,不写进发布单,也不返回给 agent
        await platform.setEnv(app.platform.appId, { DATABASE_URL: db.connectionUrl });
        app.platform.databaseId = db.databaseId;
        await this.store.saveApp(app);
      }
      await platform.setEnv(app.platform.appId, { PORT: String(manifest.port) });

      if (!app.platform.domainAttached) {
        await platform.attachDomain({ appId: app.platform.appId, host: app.host, port: manifest.port });
        app.platform.domainAttached = true;
        await this.store.saveApp(app);
      }
      app.visibility = manifest.visibility;
      await this.store.saveApp(app);
      return { kind: "next" };
    },

    BUILDING: async (release) => {
      const app = await this.app(release);
      const archive = await this.archive(release.appName, release.version);
      const result = await this.adapters.platform.deploy(this.appId(app), archive);
      if (!result.ok) {
        return {
          kind: "fail",
          fixable: true,
          type: "build_failed",
          message: "应用构建或启动失败",
          logs: result.logs,
          hint: "根据日志修复代码后重新发布",
        };
      }
      return { kind: "next" };
    },

    MIGRATING: async (release) => {
      const { platform } = this.adapters;
      const { manifest } = release;
      const app = await this.app(release);
      if (manifest.database === "none" || !manifest.migrate) return { kind: "next" };

      // 恢复中断的发布时迁移会重跑,但备份只做一次:那时数据库可能已经迁移了一半,再备份就不是迁移前的数据了
      if (app.platform.databaseId && !release.backupId) {
        release.backupId = await platform.backupDatabase(app.platform.databaseId);
        await this.store.saveRelease(release);
      }
      const result = await platform.runCommand(this.appId(app), manifest.migrate);
      if (!result.ok) {
        return {
          kind: "fail",
          fixable: true,
          type: "migration_failed",
          message: "数据库迁移失败",
          logs: result.logs,
          hint: "数据库在迁移前已备份。修复迁移脚本后重新发布;迁移脚本必须可以重复执行",
        };
      }
      return { kind: "next" };
    },

    VERIFYING: async (release) => {
      const { platform, health } = this.adapters;
      const app = await this.app(release);
      if (await health.check(app.host, release.manifest.healthcheck)) return { kind: "next" };

      const appId = this.appId(app);
      const logs = await platform.getLogs(appId, 100);
      const failure: Failure = {
        kind: "fail",
        fixable: true,
        type: "healthcheck_failed",
        message: `应用启动后健康检查 ${release.manifest.healthcheck} 没有通过`,
        logs,
        hint: "确认应用监听了清单里的端口,并且健康检查接口返回 200",
      };
      if (!app.liveVersion) return failure;

      // 有上一个可用版本:用保存的代码包把它重新部署回去(只回滚代码,不动数据库)
      const previous = await this.archive(app.name, app.liveVersion);
      const rollback = await platform.deploy(appId, previous);
      if (!rollback.ok) {
        return { ...failure, fixable: false, type: "rollback_failed", message: "新版本不可用,且回滚到上一版本也失败了" };
      }
      return { ...failure, rolledBack: true };
    },
  };

  private async goLive(release: ReleaseRecord): Promise<void> {
    const app = await this.app(release);
    app.liveVersion = release.version;
    await this.store.saveApp(app);
    release.url = `${this.config.appsUrlScheme ?? "https"}://${app.host}`;
    await this.transition(release, "LIVE");
    await this.adapters.notifier.notify(release.ownerId, `应用 ${app.name} 已发布: ${release.url}`);
  }

  private async fail(release: ReleaseRecord, failure: Failure): Promise<void> {
    release.error = {
      stage: release.state,
      type: failure.type,
      message: failure.message,
      logs: failure.logs,
      hint: failure.hint,
    };

    let next: ReleaseState;
    if (!failure.fixable) {
      next = "FAILED";
    } else if ((await this.priorConsecutiveFailures(release)) + 1 >= this.config.maxFixAttempts) {
      next = "FAILED";
      release.error.hint = `已连续失败 ${this.config.maxFixAttempts} 次,不再自动重试,请联系平台管理员`;
    } else {
      next = failure.rolledBack ? "ROLLED_BACK" : "FAILED_FIXABLE";
    }

    await this.transition(release, next);
    if (next === "FAILED") {
      await this.adapters.notifier.notify(release.ownerId, `应用 ${release.appName} 发布失败: ${failure.message}`);
    }
  }

  /** 这次发布之前,同一应用连续多少次以“可修复的失败”结束 */
  private async priorConsecutiveFailures(release: ReleaseRecord): Promise<number> {
    const earlier = (await this.store.listReleases(release.appName)).filter((r) => r.id !== release.id);
    let count = 0;
    for (const r of earlier.reverse()) {
      if (r.state !== "FAILED_FIXABLE" && r.state !== "ROLLED_BACK") break;
      count++;
    }
    return count;
  }

  private async transition(release: ReleaseRecord, state: ReleaseState): Promise<void> {
    release.state = state;
    release.history.push({ state, at: new Date() });
    await this.store.saveRelease(release);
  }

  private async app(release: ReleaseRecord): Promise<AppRecord> {
    const app = await this.store.getApp(release.appName);
    if (!app) throw new Error(`应用 ${release.appName} 不存在`);
    return app;
  }

  private async archive(appName: string, version: string): Promise<Archive> {
    const zip = await this.adapters.archives.read(appName, version);
    if (!zip) throw new Error(`找不到应用 ${appName} 版本 ${version} 的代码包`);
    return { version, zip };
  }

  private appId(app: AppRecord): string {
    if (!app.platform.appId) throw new Error(`应用 ${app.name} 还没有在部署平台上创建`);
    return app.platform.appId;
  }
}
