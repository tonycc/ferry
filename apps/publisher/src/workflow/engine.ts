import type { Adapters, Archive } from "../adapters/types";
import { memoryAuditLog, type AuditLog } from "../audit/log";
import type { Alerts } from "../alerts";
import { deployFailure, healthFailure, migrationFailure, scanFailure } from "./failures";
import { isTerminal, stepOrder, type ReleaseState, type StepState } from "./states";
import { RESERVED_ENV_NAMES, type SecretBox } from "../secrets";
import type { AppRecord, ReleaseRecord, Store } from "./store";

export interface EngineConfig {
  maxFixAttempts: number;
  /** 应用地址的协议,默认 https */
  appsUrlScheme?: "http" | "https";
  /** 解密应用密钥用;不传时有密钥的应用发布会失败(只有不涉及密钥的测试可以不传) */
  secretBox?: SecretBox;
  /** 审计日志,记录每次发布的结果;不传时记在内存里(只有测试可以不传) */
  audit?: AuditLog;
  /** 给平台管理员的告警(发布连续失败、备份失败、平台问题);不传时不告警 */
  alerts?: Alerts;
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

/** 迁移前备份失败时给 agent 的提示;和发布单的 nextAction 说法一致 */
export const BACKUP_FAILED_HINT =
  "不要修改代码,这不是代码的问题,也不要马上重新发布。告诉用户:迁移前备份数据库失败,平台管理员已收到告警;" +
  "等管理员处理好、用户让你再发布时,再重新发布";

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
  ) {
    this.audit = config.audit ?? memoryAuditLog();
  }

  private readonly audit: AuditLog;

  async run(releaseId: string): Promise<ReleaseRecord> {
    const release = await this.store.getRelease(releaseId);
    if (!release) throw new Error(`发布单 ${releaseId} 不存在`);
    if (isTerminal(release.state)) return release;
    const order = stepOrder(release.kind);
    if (release.state === "PENDING") await this.transition(release, order[0]!);

    for (;;) {
      const state = release.state as StepState;
      let result: StepResult;
      const next = order[order.indexOf(state) + 1];
      try {
        result = (await this.stopIfDisabled(release)) ?? (await this.steps[state](release));
        // 最后一步通过后、上线之前再检查一次,避免停用和上线同时发生时应用仍在运行
        if (result.kind === "next" && !next) result = (await this.stopIfDisabled(release)) ?? result;
      } catch (err) {
        result = {
          kind: "fail",
          fixable: false,
          type: "internal_error",
          message: `Ferry 或部署平台出错,这不是代码的问题:${(err as Error).message}`,
          hint: "不要修改代码。把情况告诉用户,请平台管理员检查;问题解决后重新发布即可",
        };
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
      if (findings.length > 0) return { kind: "fail", ...scanFailure(findings, release.manifest) };
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

      // 每次发布都把环境变量整体写一遍:控制台上的密钥、PORT,以及数据库连接串。
      // 每次都确认数据库存在、已启动:下线后重新发布时,应用是新建的(环境变量为空),数据库是停着的。
      // createDatabase 会复用同名数据库。先写环境变量再记下数据库 ID:反过来的话,两步之间进程重启,
      // 恢复后连接串可能注入不进去。连接串和密钥只进应用环境变量,不写进发布单,也不返回给 agent
      const env: Record<string, string> = { ...(await this.secretEnv(app)), PORT: String(manifest.port) };
      let databaseId: string | undefined;
      if (manifest.database === "postgres") {
        const db = await platform.createDatabase({ projectId, name: app.name });
        env.DATABASE_URL = db.connectionUrl;
        databaseId = db.databaseId;
      }
      // 只保留 Ferry 自己的变量(这次没有数据库时保留原来的连接串),控制台上删掉的密钥随之移除
      await platform.setEnv(app.platform.appId, env, RESERVED_ENV_NAMES);
      if (databaseId && app.platform.databaseId !== databaseId) {
        app.platform.databaseId = databaseId;
        await this.store.saveApp(app);
      }

      // 每次发布都确认域名指向清单里的端口、挂着登录网关(端口改了也能跟上;没有变化时平台什么都不做)
      await platform.attachDomain({ appId: app.platform.appId, host: app.host, port: manifest.port });
      if (!app.platform.domainAttached) {
        app.platform.domainAttached = true;
        await this.store.saveApp(app);
      }
      // 应用上线之前,可见范围按 app.yaml;上线之后以控制台为准(见 AppRecord.visibilityPinned)
      if (!app.visibilityPinned && app.visibility !== manifest.visibility) {
        const from = app.visibility;
        app.visibility = manifest.visibility;
        await this.store.saveApp(app);
        // 第一次上线前按 app.yaml 改的可见范围也要留记录(比如一上线就对全公司开放),操作人是发布的人
        await this.audit.record(release.ownerId, "app.visibility", app, {
          from,
          to: manifest.visibility,
          source: "app.yaml",
          releaseId: release.id,
        });
      }
      return { kind: "next" };
    },

    BUILDING: async (release) => {
      const app = await this.app(release);
      // 回滚不经过 PROVISIONING,在部署前写入控制台上现在的密钥(DATABASE_URL、PORT 保持原样)
      if (release.kind === "rollback") {
        await this.adapters.platform.setEnv(this.appId(app), await this.secretEnv(app), RESERVED_ENV_NAMES);
      }
      const archive = await this.archive(release.appName, release.version);
      const result = await this.adapters.platform.deploy(this.appId(app), archive, { databaseId: app.platform.databaseId });
      if (!result.ok) {
        const failure: Failure = { kind: "fail", ...deployFailure(result.reason, release.manifest), logs: result.logs };
        // 启动即崩溃时新镜像已经替换了线上版本(Swarm 自己的回滚用的是同一个镜像标签,救不回来),
        // 有上一个可用版本就把它部署回去;构建失败时线上版本没被动过
        return result.reason === "start" ? this.restoreLive(app, failure) : failure;
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
        try {
          release.backupId = await platform.backupDatabase(app.platform.databaseId);
        } catch (err) {
          // 新代码已经部署了,数据库还没动:和迁移失败一样,有上一个可用版本就把它部署回去
          return this.backupFailed(app, (err as Error).message);
        }
        await this.store.saveRelease(release);
      }
      const result = await platform.runCommand(this.appId(app), manifest.migrate);
      if (!result.ok) {
        // 新代码已经在跑,但数据库没迁移成功(每个迁移文件在事务里执行,失败的那个没有生效),
        // 新代码多半用不了;有上一个可用版本就把它部署回去
        return this.restoreLive(app, { kind: "fail", ...migrationFailure(result.reason, manifest), logs: result.logs });
      }
      return { kind: "next" };
    },

    VERIFYING: async (release) => {
      const { platform, health } = this.adapters;
      const app = await this.app(release);
      const checked = await health.check(app.host, release.manifest.healthcheck);
      if (checked.ok) return { kind: "next" };

      const appId = this.appId(app);
      const logs = await platform.getLogs(appId, 100);
      const failure: Failure = { kind: "fail", ...healthFailure(checked.status, release.manifest), logs };
      return this.restoreLive(app, failure);
    },
  };

  /** 控制台上配置的密钥,解密成环境变量。解密失败时抛出的错误不含密钥的值 */
  private async secretEnv(app: AppRecord): Promise<Record<string, string>> {
    const env: Record<string, string> = {};
    for (const secret of await this.store.listSecrets(app.name)) {
      if (!this.config.secretBox) throw new Error("没有配置 SECRETS_KEY,无法解密应用密钥");
      env[secret.name] = this.config.secretBox.decrypt(app.name, secret.name, secret.ciphertext);
    }
    return env;
  }

  /** 迁移前备份失败:不是代码的问题,发布终止,数据库没有改动;有上一个可用版本就恢复它 */
  private async backupFailed(app: AppRecord, error: string): Promise<Failure> {
    const failure = { kind: "fail", fixable: false, type: "backup_failed", logs: error, hint: BACKUP_FAILED_HINT } as const;
    if (!app.liveVersion) {
      return { ...failure, message: "迁移前备份数据库失败,发布已停止:数据库没有改动,应用这次没有上线" };
    }
    let restored: Failure;
    try {
      restored = await this.restoreLive(app, { ...failure, message: "迁移前备份数据库失败" });
    } catch (err) {
      // 备份失败多半是部署平台出了问题,恢复也可能直接出错;这时新代码还在线上,按恢复失败报,每次都告警
      return {
        ...failure,
        type: "rollback_failed",
        message: `迁移前备份数据库失败,恢复上一版本时也出错了(${(err as Error).message}),应用现在可能无法正常使用`,
        hint: "不要修改代码。马上告诉用户应用可能无法访问,并请平台管理员处理",
      };
    }
    // 恢复失败时 restoreLive 已经改成 rollback_failed,message 里带着“迁移前备份数据库失败”
    if (!restored.rolledBack) return restored;
    return { ...restored, message: "迁移前备份数据库失败,发布已停止:数据库没有改动,线上已恢复为上一个版本" };
  }

  /** 新版本不可用时:有上一个可用版本就用保存的代码包把它重新部署回去(只回滚代码,不动数据库) */
  private async restoreLive(app: AppRecord, failure: Failure): Promise<Failure> {
    if (!app.liveVersion) return failure;
    const previous = await this.archive(app.name, app.liveVersion);
    const rollback = await this.adapters.platform.deploy(this.appId(app), previous, { databaseId: app.platform.databaseId });
    if (!rollback.ok) {
      return {
        ...failure,
        fixable: false,
        type: "rollback_failed",
        message: `新版本不可用,且回滚到上一版本也失败了,应用现在可能无法访问。${failure.message}`,
        hint: "不要修改代码。马上告诉用户应用可能无法访问,并请平台管理员处理",
      };
    }
    return { ...failure, rolledBack: true };
  }

  private async goLive(release: ReleaseRecord): Promise<void> {
    const app = await this.app(release);
    app.liveVersion = release.version;
    app.visibilityPinned = true;
    await this.store.saveApp(app);
    release.url = `${this.config.appsUrlScheme ?? "https"}://${app.host}`;
    await this.transition(release, "LIVE");
    await this.recordFinish(release);
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
    let capped = false;
    if (release.kind === "rollback") {
      // 回滚失败时线上仍是原来的版本;不是代码问题,不计入 agent 的修复次数,也不让 agent 去改代码
      next = "FAILED";
      release.error.message = `回滚没有成功,线上仍是原来的版本。${failure.message}`;
      release.error.hint = "不要修改代码。把情况告诉用户;需要的话请联系平台管理员";
    } else if (!failure.fixable) {
      next = "FAILED";
    } else if ((await this.priorConsecutiveFailures(release)) + 1 >= this.config.maxFixAttempts) {
      next = "FAILED";
      capped = true;
      release.error.hint = `已连续失败 ${this.config.maxFixAttempts} 次,不再自动重试,请联系平台管理员`;
    } else {
      next = failure.rolledBack ? "ROLLED_BACK" : "FAILED_FIXABLE";
    }

    await this.transition(release, next);
    await this.recordFinish(release);
    // 发现了密钥的代码包不再保留:发布单已经结束,这个版本不会再被部署(回滚目标也一样,扫描不会通过)
    if (failure.type === "scan_failed") await this.adapters.archives.remove(release.appName, release.version);
    await this.alert(release, failure, capped);
    if (next === "FAILED") {
      const action = release.kind === "rollback" ? "回滚" : "发布";
      await this.adapters.notifier.notify(release.ownerId, `应用 ${release.appName} ${action}失败: ${failure.message}`);
    }
  }

  /**
   * 给平台管理员的告警。连续失败到上限、备份失败、回滚旧版本也失败,每次都单独告警;
   * 部署平台或 Ferry 自己出错(每个应用的发布都可能因此失败)按类型合并,冷却期内只发一次
   */
  private async alert(release: ReleaseRecord, failure: Failure, capped: boolean): Promise<void> {
    const { alerts } = this.config;
    if (!alerts) return;
    const action = release.kind === "rollback" ? "回滚" : "发布";
    const reason = `${failure.type}:${failure.message}`;
    const alerted =
      capped || ["backup_failed", "rollback_failed", "platform_error", "internal_error"].includes(failure.type);
    if (!alerted) return;
    const owner = (await this.adapters.directory.nameOf(release.ownerId)) ?? release.ownerId;
    const about = `应用 ${release.appName}(负责人 ${owner})`;
    if (capped) {
      await alerts.send(`${about}连续 ${this.config.maxFixAttempts} 次发布失败,已不再让 agent 自动重试。最近一次:${reason}`);
    } else if (failure.type === "backup_failed") {
      await alerts.send(`${about}迁移前备份数据库失败,${action}已停止。${failure.message}。错误:${failure.logs ?? ""}`);
    } else if (failure.type === "rollback_failed") {
      await alerts.send(`${about}新版本不可用,恢复上一版本也失败了,应用可能无法访问。${failure.message}`);
    } else if (failure.type === "platform_error" || failure.type === "internal_error") {
      await alerts.throttled(failure.type, `${about}${action}失败,原因是部署平台或 Ferry 出错:${reason}`, release.appName);
    }
  }

  /** 审计日志:发布或回滚结束,由 Ferry 记录(发布单在应用被删除时会一起删掉,审计记录不会) */
  private async recordFinish(release: ReleaseRecord): Promise<void> {
    await this.audit.record(undefined, "release.finish", { name: release.appName, ownerId: release.ownerId }, {
      releaseId: release.id,
      kind: release.kind,
      version: release.version,
      state: release.state,
      ...(release.error ? { errorType: release.error.type } : {}),
    });
  }

  /** 这次发布之前,同一应用连续多少次以“可修复的失败”结束 */
  private async priorConsecutiveFailures(release: ReleaseRecord): Promise<number> {
    // 回滚不是 agent 发起的修复,不参与计数
    const earlier = (await this.store.listReleases(release.appName)).filter(
      (r) => r.id !== release.id && r.kind === "publish",
    );
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
