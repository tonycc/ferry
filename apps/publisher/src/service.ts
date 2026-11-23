import { createHash, randomBytes, randomUUID } from "node:crypto";
import { manifestSchema, parseManifest, type Manifest, type Visibility } from "@ferry/manifest";
import type { Adapters } from "./adapters/types";
import { canAccess } from "./authz/decide";
import { UserError } from "./errors";
import type { User } from "./identity";
import type { Engine } from "./workflow/engine";
import type { TemplateFile, TemplateLibrary, TemplateSummary } from "./templates";
import { pruneArchives } from "./workflow/retention";
import { checkArchiveLayout, readZipFile, zipEntryNames } from "./zip";
import { isTerminal, type ReleaseState } from "./workflow/states";
import type { AppRecord, ReleaseError, ReleaseRecord, Store, UploadTicket } from "./workflow/store";
import { MAX_SECRETS_PER_APP, validateSecretName, validateSecretValue, type SecretBox } from "./secrets";
import { memoryAuditLog, type AuditLog } from "./audit/log";
import type { AuditAction } from "./audit/store";

export interface ServiceConfig {
  /** 应用地址的协议,默认 https */
  appsUrlScheme?: "http" | "https";
  appsDomain: string;
  maxAppsPerUser: number;
  /** agent 访问本服务用的地址 */
  publicUrl: string;
  uploadTtlMs: number;
  /** 上传后多久还没发布的代码包可以清理,默认 24 小时 */
  archiveGraceMs?: number;
  /** 应用模板。设置后发布时检查 app.yaml 的 template 是否存在 */
  templates?: TemplateLibrary;
  /** 加密应用密钥用;不传时不能保存密钥 */
  secretBox?: SecretBox;
  /** 审计日志;不传时记在内存里(只有测试可以不传) */
  audit?: AuditLog;
  now?: () => Date;
}

/** 控制台上显示的密钥:只有名称和更新时间,值保存后不再返回 */
export interface SecretView {
  name: string;
  updatedAt: string;
}

export interface PreparedUpload {
  name: string;
  /** 应用发布后的访问地址 */
  url: string;
  /** 这次上传对应的代码包版本,发布时要用 */
  version: string;
  /** 一次性上传地址:用 HTTP PUT 把 zip 传到这里 */
  uploadUrl: string;
  uploadExpiresAt: string;
}

export interface ReleaseView {
  releaseId: string;
  /** publish:发布新版本;rollback:回滚 */
  kind: "publish" | "rollback";
  app: string;
  state: ReleaseState;
  /** 发布流程是否已结束(成功或失败) */
  done: boolean;
  url?: string;
  error?: ReleaseError;
  /** 写给 agent 的下一步指引 */
  nextAction: string;
  /** 发布时需要 agent 知道、但不影响发布的情况(如 app.yaml 的可见范围被忽略) */
  notice?: string;
}

export interface AppView {
  name: string;
  url: string;
  visibility: string;
  live: boolean;
  /** 已被管理员停用 */
  disabled: boolean;
  /** 已被负责人下线,数据保留,重新发布即恢复 */
  unpublished: boolean;
  disabledReason?: string;
}

/** 控制台的应用详情 */
export interface AppDetailView extends AppView {
  /** 为 true 时可见范围以控制台为准,发布时不再用 app.yaml 里的值 */
  visibilityPinned: boolean;
  createdAt: string;
  /** 最近一次发布用的清单里的设置;没发布过时没有 */
  port?: number;
  healthcheck?: string;
  database?: "none" | "postgres";
  /** 发布历史,最新的在前,最多 50 条。日志不在这里,用 releaseId 查单次发布 */
  releases: ReleaseSummary[];
}

export interface ReleaseSummary {
  releaseId: string;
  kind: "publish" | "rollback";
  state: ReleaseState;
  done: boolean;
  version: string;
  /** 这个版本正是线上运行的版本 */
  live: boolean;
  createdAt: string;
  /** 结束时间;进行中为空 */
  finishedAt?: string;
  error?: { stage: ReleaseState; type: string; message: string; hint?: string };
}

/** 回滚时返回:发起的回滚发布单,以及从哪个版本回到哪个版本(用上线时间让用户分辨) */
export interface RollbackView extends ReleaseView {
  from: { version: string; publishedAt: string };
  to: { version: string; publishedAt: string };
}

/** 管理员查看的一条审计记录 */
export interface AuditEventView {
  id: number;
  at: string;
  /** 为空表示 Ferry 自己(如发布结束) */
  actorId?: string;
  /** 操作当时的姓名 */
  actorName?: string;
  action: AuditAction;
  appName?: string;
  /** 应用当时的负责人 */
  appOwnerId?: string;
  /** 负责人现在的姓名;已不在组织架构里时没有 */
  appOwnerName?: string;
  detail: Record<string, unknown>;
}

export interface AuditPage {
  events: AuditEventView[];
  /** 还有更早的记录时,用它作为下一页的 before */
  nextBefore?: number;
}

export interface AdminAppView extends AppView {
  ownerId: string;
  /** 负责人姓名;已不在组织架构里时为 ownerId */
  ownerName: string;
  /** 负责人当前所属的部门 ID,来自组织架构 */
  departments: string[];
  /** 对应的部门名称;查不到名称的部门显示 ID */
  departmentNames: string[];
  createdAt: string;
  /** 负责人下线的时间;管理员据此决定要不要删除 */
  unpublishedAt?: string;
  disabledReason?: string;
}

/** Ferry 地址对应的网页控制台地址。MCP 说明和密钥扫描提示都用它算,保证两处一致 */
export function consoleUrlOf(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/console`;
}

/** REST 和 MCP 共用的业务入口 */
export class PublisherService {
  private readonly running = new Map<string, Promise<unknown>>();
  private readonly audit: AuditLog;

  constructor(
    private readonly store: Store,
    private readonly engine: Engine,
    private readonly adapters: Adapters,
    private readonly config: ServiceConfig,
  ) {
    this.audit = config.audit ?? memoryAuditLog();
  }

  /** 网页控制台的地址(给 agent 的说明里用,agent 自己不知道) */
  consoleUrl(): string {
    return consoleUrlOf(this.config.publicUrl);
  }

  /**
   * 占用应用名(已是自己的应用则复用),并签发一个一次性的代码包上传地址。
   * 每次发布前都要调用一次:agent 把代码包传到返回的地址,再用返回的 version 调用 publish。
   */
  async prepareApp(user: User, name: string): Promise<PreparedUpload> {
    const parsed = manifestSchema.shape.name.safeParse(name);
    if (!parsed.success) {
      throw new UserError("invalid_input", `应用名不合法: ${parsed.error.issues[0]?.message ?? ""}`);
    }

    const existing = await this.store.getApp(name);
    if (existing && existing.ownerId !== user.id) {
      throw new UserError("conflict", `应用名 ${name} 已被其他人使用,请换一个名字`);
    }
    if (existing?.disabled) {
      throw new UserError("forbidden", `应用 ${name} 已被管理员停用,不能发布。请联系平台管理员`);
    }
    // 下线的应用不占名额;重新发布已下线的应用等于恢复它,要占回一个名额
    if (!existing || existing.unpublishedAt) {
      const active = (await this.store.listAppsByOwner(user.id)).filter((a) => !a.unpublishedAt);
      if (active.length >= this.config.maxAppsPerUser) {
        throw new UserError("quota_exceeded", `每人最多 ${this.config.maxAppsPerUser} 个在线的应用,请先下线不用的应用`);
      }
    }

    let app = existing;
    if (!app) {
      app = {
        name,
        ownerId: user.id,
        visibility: "self",
        host: `${name}.${this.config.appsDomain}`,
        platform: {},
        createdAt: new Date(),
      };
      // 两个人同时抢同一个名字时,只有一个能写入成功
      if (!(await this.store.createApp(app))) {
        throw new UserError("conflict", `应用名 ${name} 已被其他人使用,请换一个名字`);
      }
      await this.audit.record(user.id, "app.create", app);
    }

    // 令牌只在这里返回一次,库里只存它的哈希
    const token = randomBytes(32).toString("hex");
    const ticket: UploadTicket = {
      tokenHash: hashToken(token),
      appName: name,
      ownerId: user.id,
      version: randomUUID(),
      expiresAt: new Date(Date.now() + this.config.uploadTtlMs),
    };
    await this.store.saveUpload(ticket);
    return {
      name,
      url: this.appUrl(app.host),
      version: ticket.version,
      uploadUrl: `${this.config.publicUrl}/uploads/${token}`,
      uploadExpiresAt: ticket.expiresAt.toISOString(),
    };
  }

  /** 接收代码包。上传地址里的令牌就是凭据:只能用一次,过期作废 */
  async receiveUpload(token: string, zip: Buffer): Promise<{ app: string; version: string; bytes: number }> {
    const ticket = await this.store.getUploadByTokenHash(hashToken(token));
    if (!ticket) throw new UserError("not_found", "上传地址无效");
    if (ticket.receivedAt) throw new UserError("conflict", "这个上传地址已经用过了,请重新调用 prepare_app");
    if (ticket.expiresAt.getTime() <= Date.now()) {
      throw new UserError("forbidden", "上传地址已过期,请重新调用 prepare_app");
    }
    const names = isZip(zip) ? zipEntryNames(zip) : undefined;
    if (!names) throw new UserError("invalid_input", "上传的内容不是 zip 文件");
    // 检查不通过时上传地址还能再用
    const layoutProblem = checkArchiveLayout(names);
    if (layoutProblem) throw new UserError("invalid_input", layoutProblem);
    // 发布只认代码包里的 app.yaml;这里先检查一遍,写错了在上传时就报出来
    await this.manifestOf(zip, ticket.appName);

    ticket.receivedAt = new Date();
    await this.store.saveUpload(ticket);
    await this.adapters.archives.save(ticket.appName, ticket.version, zip);
    return { app: ticket.appName, version: ticket.version, bytes: zip.length };
  }

  /** 读出并校验代码包根目录的 app.yaml;有问题时抛出写给 agent 的修复说明 */
  private async manifestOf(zip: Buffer, appName: string): Promise<Manifest> {
    const text = readZipFile(zip, "app.yaml");
    if (!text) throw new UserError("invalid_input", "读不出代码包根目录的 app.yaml(文件过大或压缩方式不支持),请检查后重新打包上传");
    const parsed = parseManifest(text.toString("utf8"));
    if (!parsed.ok) throw new UserError("invalid_input", `app.yaml 有问题:\n${parsed.errors.join("\n")}\n改好后重新打包上传`);
    const { manifest } = parsed;
    if (manifest.name !== appName) {
      throw new UserError(
        "invalid_input",
        `app.yaml 有问题:\nname: 是 ${manifest.name},但调用 prepare_app 时用的应用名是 ${appName}。把两者改成一致后重新打包上传`,
      );
    }
    if (this.config.templates) {
      const templates = await this.config.templates.names();
      if (!templates.includes(manifest.template)) {
        throw new UserError(
          "invalid_input",
          `app.yaml 有问题:\ntemplate: 没有模板 ${manifest.template},可用的模板:${templates.join("、")}。改好后重新打包上传`,
        );
      }
    }
    return manifest;
  }

  async listTemplates(): Promise<TemplateSummary[]> {
    return this.config.templates ? this.config.templates.list() : [];
  }

  async getTemplate(name: string): Promise<TemplateFile[]> {
    const files = await this.config.templates?.get(name);
    if (!files) {
      const names = (await this.config.templates?.names()) ?? [];
      throw new UserError("not_found", `没有模板 ${name},可用的模板:${names.join("、") || "无"}`);
    }
    return files;
  }

  /**
   * 发布已上传的代码包。清单只取代码包根目录的 app.yaml,不另外传,免得两份不一致。
   */
  async publish(user: User, input: { name: string; version: string }): Promise<ReleaseView> {
    const app = await this.store.getApp(input.name);
    if (!app) throw new UserError("not_found", `应用 ${input.name} 还没有创建,请先调用 prepare_app`);
    if (app.ownerId !== user.id) throw new UserError("forbidden", `你不是应用 ${input.name} 的负责人`);
    if (app.disabled) {
      throw new UserError("forbidden", `应用 ${app.name} 已被管理员停用,不能发布。请联系平台管理员`);
    }

    const upload = await this.store.getUpload(app.name, input.version);
    const zip = upload?.receivedAt && (await this.adapters.archives.read(app.name, input.version));
    if (!zip) {
      throw new UserError(
        "invalid_input",
        `应用 ${app.name} 还没有收到 version 为 ${input.version} 的代码包。请先把 zip 上传到 prepare_app 返回的 uploadUrl,` +
          "并确认 name 和调用 prepare_app 时用的应用名一致",
      );
    }
    const manifest = await this.manifestOf(zip, app.name);

    const releases = await this.store.listReleases(app.name);
    if (releases.some((r) => !isTerminal(r.state))) {
      throw new UserError("conflict", `应用 ${app.name} 有一次发布还在进行中,请等它结束`);
    }
    const revived = app.unpublishedAt !== undefined;
    if (app.unpublishedAt) {
      // 重新发布已下线的应用:恢复它,数据库会重新启动,原来的数据还在
      app.unpublishedAt = undefined;
      await this.store.saveApp(app);
    }

    const release: ReleaseRecord = {
      id: randomUUID(),
      kind: "publish",
      appName: app.name,
      ownerId: user.id,
      version: input.version,
      manifest,
      state: "PENDING",
      history: [{ state: "PENDING", at: new Date() }],
      createdAt: new Date(),
    };
    await this.store.saveRelease(release);
    await this.audit.record(user.id, "app.publish", app, {
      releaseId: release.id,
      version: release.version,
      ...(revived ? { revived: true } : {}),
    });
    this.schedule(release.id);
    const view = toView(release);
    if (app.visibilityPinned && manifest.visibility !== app.visibility) {
      view.notice =
        `app.yaml 里的 visibility(${manifest.visibility})和应用当前的可见范围(${app.visibility})不同,已忽略:` +
        `应用上线后可见范围以控制台为准。请把 app.yaml 的 visibility 改成 ${app.visibility};` +
        "用户要改可见范围时用 set_visibility";
    }
    return view;
  }

  async status(user: User, releaseId: string): Promise<ReleaseView> {
    const release = await this.store.getRelease(releaseId);
    if (!release || release.ownerId !== user.id) throw new UserError("not_found", "发布单不存在");
    return toView(release);
  }

  async appDetail(user: User, appName: string): Promise<AppDetailView> {
    const app = await this.ownApp(user, appName);
    const releases = await this.store.listReleases(app.name);
    const latest = releases.at(-1)?.manifest;
    return {
      ...toAppView(app, this.appUrl(app.host)),
      visibilityPinned: app.visibilityPinned ?? false,
      createdAt: app.createdAt.toISOString(),
      port: latest?.port,
      healthcheck: latest?.healthcheck,
      database: latest?.database,
      releases: releases
        .slice(-50)
        .reverse()
        .map((r) => ({
          releaseId: r.id,
          kind: r.kind,
          state: r.state,
          done: isTerminal(r.state),
          version: r.version,
          live: !app.unpublishedAt && r.version === app.liveVersion && r.state === "LIVE",
          createdAt: r.createdAt.toISOString(),
          finishedAt: isTerminal(r.state) ? r.history.at(-1)?.at.toISOString() : undefined,
          error: r.error && { stage: r.error.stage, type: r.error.type, message: r.error.message, hint: r.error.hint },
        })),
    };
  }

  /** 负责人修改可见范围,立即生效(网关每个请求都按它判断);之后发布时不再用 app.yaml 里的值 */
  async setVisibility(user: User, appName: string, visibility: Visibility): Promise<AppView> {
    const app = await this.ownApp(user, appName);
    const from = app.visibility;
    app.visibility = visibility;
    app.visibilityPinned = true;
    await this.store.saveApp(app);
    if (from !== visibility) await this.audit.record(user.id, "app.visibility", app, { from, to: visibility });
    return toAppView(app, this.appUrl(app.host));
  }

  async listApps(user: User): Promise<AppView[]> {
    const apps = await this.store.listAppsByOwner(user.id);
    return apps.map((app) => toAppView(app, this.appUrl(app.host)));
  }

  /**
   * 回滚到上一个上线过的版本:只重新部署那个版本的代码并做健康检查,不动数据库,
   * 也不改可见范围等设置。上线过的版本最多保留两个,所以回滚一次之后再回滚,会回到回滚前的版本。
   */
  async rollback(user: User, appName: string): Promise<RollbackView> {
    const app = await this.ownApp(user, appName);
    if (app.disabled) throw new UserError("forbidden", `应用 ${app.name} 已被管理员停用,不能回滚。请联系平台管理员`);
    if (app.unpublishedAt || !app.liveVersion) {
      throw new UserError("invalid_input", `应用 ${app.name} 现在没有在线的版本,不能回滚`);
    }
    const releases = await this.store.listReleases(app.name);
    if (releases.some((r) => !isTerminal(r.state))) {
      throw new UserError("conflict", `应用 ${app.name} 有一次发布还在进行中,请等它结束`);
    }

    const live = [...releases].reverse().filter((r) => r.state === "LIVE");
    const current = live.find((r) => r.version === app.liveVersion);
    const target = live.find((r) => r.version !== app.liveVersion);
    if (!current || !target || !(await this.adapters.archives.read(app.name, target.version))) {
      throw new UserError("not_found", `应用 ${app.name} 没有可以回滚的上一个版本`);
    }
    if (target.manifest.port !== current.manifest.port) {
      throw new UserError(
        "invalid_input",
        `上一个版本监听的端口(${target.manifest.port})和现在的(${current.manifest.port})不同,不能直接回滚。请修复当前版本后重新发布`,
      );
    }

    const release: ReleaseRecord = {
      id: randomUUID(),
      kind: "rollback",
      appName: app.name,
      ownerId: user.id,
      version: target.version,
      manifest: target.manifest,
      state: "PENDING",
      history: [{ state: "PENDING", at: new Date() }],
      createdAt: new Date(),
    };
    await this.store.saveRelease(release);
    await this.audit.record(user.id, "app.rollback", app, {
      releaseId: release.id,
      fromVersion: current.version,
      toVersion: target.version,
    });
    this.schedule(release.id);
    return {
      ...toView(release),
      from: { version: current.version, publishedAt: current.createdAt.toISOString() },
      to: { version: target.version, publishedAt: target.createdAt.toISOString() },
    };
  }

  /** 应用的密钥名称和更新时间,不含值 */
  async listSecrets(user: User, appName: string): Promise<SecretView[]> {
    const app = await this.ownApp(user, appName);
    const secrets = await this.store.listSecrets(app.name);
    return secrets.map((s) => ({ name: s.name, updatedAt: s.updatedAt.toISOString() }));
  }

  /** 新增或替换一个密钥。下次发布或回滚时注入应用的环境变量 */
  async setSecret(user: User, appName: string, name: string, value: string): Promise<SecretView[]> {
    const app = await this.ownApp(user, appName);
    validateSecretName(name);
    validateSecretValue(value);
    if (!this.config.secretBox) throw new UserError("conflict", "平台没有配置 SECRETS_KEY,暂时不能保存密钥。请联系平台管理员");
    const saved = await this.store.saveSecret(
      {
        appName: app.name,
        name,
        ciphertext: this.config.secretBox.encrypt(app.name, name, value),
        updatedAt: (this.config.now ?? (() => new Date()))(),
        updatedBy: user.id,
      },
      MAX_SECRETS_PER_APP,
    );
    if (!saved) throw new UserError("quota_exceeded", `每个应用最多 ${MAX_SECRETS_PER_APP} 个密钥`);
    // 只记名称,不记值
    await this.audit.record(user.id, "secret.set", app, { name });
    return this.listSecrets(user, appName);
  }

  /** 删除一个密钥。下次发布或回滚时从应用的环境变量里移除 */
  async deleteSecret(user: User, appName: string, name: string): Promise<SecretView[]> {
    const app = await this.ownApp(user, appName);
    if (!(await this.store.deleteSecret(app.name, name))) throw new UserError("not_found", `密钥 ${name} 不存在`);
    await this.audit.record(user.id, "secret.delete", app, { name });
    return this.listSecrets(user, appName);
  }

  /**
   * 下线:删除部署平台上的应用(访问地址随即失效),停止数据库但保留数据。
   * 应用名仍归负责人所有,重新发布即恢复,原来的数据还在。被管理员停用的应用也可以下线。
   */
  async unpublish(user: User, appName: string): Promise<AppView> {
    const app = await this.ownApp(user, appName);
    // 已下线且资源已删完才直接返回;上次下线中途出错时,再调用一次会把剩下的做完
    if (app.unpublishedAt && !app.platform.appId) return toAppView(app, this.appUrl(app.host));
    const releases = await this.store.listReleases(app.name);
    if (releases.some((r) => !isTerminal(r.state))) {
      throw new UserError("conflict", `应用 ${app.name} 有一次发布还在进行中,请等它结束后再下线`);
    }

    // 先标记下线,访问立即被拒绝;再删部署平台上的资源。
    // 中途出错后再调用一次会把剩下的做完,那次不再记录(第一次已经记了)
    const firstAttempt = !app.unpublishedAt;
    app.unpublishedAt = new Date();
    await this.store.saveApp(app);
    if (firstAttempt) await this.audit.record(user.id, "app.unpublish", app);
    if (app.platform.appId) await this.adapters.platform.removeApp(app.platform.appId);
    if (app.platform.databaseId) await this.adapters.platform.stopDatabase(app.platform.databaseId);
    app.platform = { ...app.platform, appId: undefined, domainAttached: false };
    app.liveVersion = undefined;
    await this.store.saveApp(app);
    await this.adapters.notifier.notify(app.ownerId, `应用 ${app.name} 已下线,数据已保留,重新发布即可恢复`);
    return toAppView(app, this.appUrl(app.host));
  }

  // ---- 管理员操作 ----

  async listAllApps(admin: User): Promise<AdminAppView[]> {
    requireAdmin(admin);
    const apps = await this.store.listApps();
    return Promise.all(
      apps.map(async (app) => {
        const { directory } = this.adapters;
        const departments = await directory.departmentsOf(app.ownerId);
        return {
          ...toAppView(app, this.appUrl(app.host)),
          ownerId: app.ownerId,
          ownerName: (await directory.nameOf(app.ownerId)) ?? app.ownerId,
          departments,
          departmentNames: await Promise.all(departments.map(async (id) => (await directory.departmentNameOf(id)) ?? id)),
          createdAt: app.createdAt.toISOString(),
          unpublishedAt: app.unpublishedAt?.toISOString(),
          disabledReason: app.disabled?.reason,
        };
      }),
    );
  }

  /**
   * 停用应用:立即停止服务、拒绝访问、禁止再发布。数据和配置保留,可以恢复。
   * 先写停用标记再停服务,这样正在进行的发布会在下一步检查时自行终止。
   */
  async disableApp(admin: User, appName: string, reason?: string): Promise<void> {
    requireAdmin(admin);
    const app = await this.store.getApp(appName);
    if (!app) throw new UserError("not_found", `应用 ${appName} 不存在`);
    if (app.disabled) return;

    await this.store.setAppDisabled(app.name, { by: admin.id, at: new Date(), reason });
    await this.audit.record(admin.id, "app.disable", app, reason ? { reason } : {});
    if (app.platform.appId) await this.adapters.platform.stopApp(app.platform.appId);
    await this.adapters.notifier.notify(
      app.ownerId,
      `应用 ${app.name} 已被管理员停用${reason ? `,原因: ${reason}` : ""}`,
    );
  }

  /**
   * 管理员彻底删除应用:删除部署平台上的应用、数据库(连同数据卷和迁移前备份)和项目,
   * 删除代码包和全部记录,释放应用名。数据无法恢复。
   * 只能删除已下线或已停用的应用:在线的应用要先停用,免得误删正在使用的应用。
   * 每删完一类资源就记下来,中途失败时再删一次会接着做完
   */
  async deleteApp(admin: User, appName: string): Promise<void> {
    requireAdmin(admin);
    const app = await this.store.getApp(appName);
    if (!app) throw new UserError("not_found", `应用 ${appName} 不存在`);
    if (!app.unpublishedAt && !app.disabled) {
      throw new UserError("invalid_input", `应用 ${app.name} 还在线,不能删除。请先停用,或者请负责人先下线`);
    }
    const running = async () => (await this.store.listReleases(app.name)).some((r) => !isTerminal(r.state));
    if (await running()) {
      throw new UserError("conflict", `应用 ${app.name} 有一次发布还在进行中,请等它结束后再删除`);
    }
    // 先标记为停用:删除要十几秒,这期间负责人不能再发布(已下线的应用本来可以随时重新发布)。
    // 标记前刚好开始的发布,会在下一步检查到停用后自行终止;这里再查一次,有就先不删
    if (!app.disabled) {
      await this.store.setAppDisabled(app.name, { by: admin.id, at: new Date(), reason: "管理员正在删除这个应用" });
      if (await running()) {
        await this.store.setAppDisabled(app.name, undefined);
        throw new UserError("conflict", `应用 ${app.name} 有一次发布刚刚开始,请等它结束后再删除`);
      }
    }
    // 确定要删之后、删除任何资源之前记录:删除要十几秒,中途失败时应用已经被停用、部分资源已经删掉
    await this.audit.record(admin.id, "app.delete", app);

    const { platform } = this.adapters;
    if (app.platform.appId) {
      await platform.removeApp(app.platform.appId);
      app.platform = { ...app.platform, appId: undefined, domainAttached: false };
      await this.store.saveApp(app);
    }
    if (app.platform.databaseId) {
      await platform.deleteDatabase(app.platform.databaseId);
      app.platform = { ...app.platform, databaseId: undefined };
      await this.store.saveApp(app);
    }
    // 应用和数据库都删掉后才能删它们的网络;网络按应用名找,重试时已经删掉的不报错
    await platform.deleteAppNetwork(app.name);
    if (app.platform.projectId) {
      await platform.deleteProject(app.platform.projectId);
      app.platform = { ...app.platform, projectId: undefined };
      await this.store.saveApp(app);
    }
    await this.adapters.archives.removeAll(app.name);
    await this.store.deleteApp(app.name);
    // 删除已经完成,通知发不出去不影响结果,只记日志
    await this.adapters.notifier
      .notify(app.ownerId, `应用 ${app.name} 已被管理员删除,数据已清除,应用名已释放`)
      .catch((err: unknown) => console.error(`应用 ${app.name} 已删除,但通知负责人失败:`, err));
  }

  /** 审计日志,从新到旧分页。可以按应用名、操作人、操作类型筛选 */
  async listAudit(
    admin: User,
    query: { app?: string; actor?: string; action?: AuditAction; before?: number; limit?: number } = {},
  ): Promise<AuditPage> {
    requireAdmin(admin);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const rows = await this.audit.list({
      appName: query.app,
      actorId: query.actor,
      action: query.action,
      beforeId: query.before,
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const ownerIds = [...new Set(page.map((e) => e.appOwnerId).filter((id): id is string => !!id))];
    const names = new Map(
      await Promise.all(ownerIds.map(async (id) => [id, await this.adapters.directory.nameOf(id)] as const)),
    );
    return {
      events: page.map((e) => ({
        id: e.id,
        at: e.at.toISOString(),
        actorId: e.actorId,
        actorName: e.actorName,
        action: e.action,
        appName: e.appName,
        appOwnerId: e.appOwnerId,
        appOwnerName: e.appOwnerId ? names.get(e.appOwnerId) : undefined,
        detail: e.detail,
      })),
      nextBefore: rows.length > limit ? page.at(-1)?.id : undefined,
    };
  }

  async enableApp(admin: User, appName: string): Promise<void> {
    requireAdmin(admin);
    const app = await this.store.getApp(appName);
    if (!app) throw new UserError("not_found", `应用 ${appName} 不存在`);
    if (!app.disabled) return;

    await this.store.setAppDisabled(app.name, undefined);
    await this.audit.record(admin.id, "app.enable", app);
    if (app.platform.appId && app.liveVersion) await this.adapters.platform.startApp(app.platform.appId);
    await this.adapters.notifier.notify(app.ownerId, `应用 ${app.name} 已恢复`);
  }

  async getLogs(user: User, appName: string, lines = 200): Promise<string> {
    const app = await this.store.getApp(appName);
    if (!app || app.ownerId !== user.id) throw new UserError("not_found", `应用 ${appName} 不存在`);
    if (!app.platform.appId) return "应用还没有部署过,没有日志";
    return this.adapters.platform.getLogs(app.platform.appId, lines);
  }

  /**
   * 服务启动时调用:确保每个在线应用的域名都挂着登录网关、指向当前端口。
   * 网关上线之前建的域名没有挂网关,不处理的话这些应用会一直不用登录就能访问。返回检查过的应用数
   */
  async ensureDomains(onError: (appName: string, err: Error) => void = () => {}): Promise<{ checked: number; failed: number }> {
    let checked = 0;
    let failed = 0;
    for (const app of await this.store.listApps()) {
      if (!app.platform.appId || !app.platform.domainAttached || app.unpublishedAt) continue;
      // 端口取最近一次发布的清单:域名就是那次发布绑的。没有发布记录的不猜端口,跳过
      const latest = (await this.store.listReleases(app.name)).at(-1);
      if (!latest) continue;
      checked++;
      try {
        await this.adapters.platform.attachDomain({ appId: app.platform.appId, host: app.host, port: latest.manifest.port });
      } catch (err) {
        // 一个应用失败不影响其他应用
        failed++;
        onError(app.name, err as Error);
      }
    }
    return { checked, failed };
  }

  /** 网关用:域名对应的、没有下线的应用。每个经过网关的请求都会调用,只查这一次存储 */
  async gatewayApp(host: string): Promise<AppRecord | undefined> {
    const app = await this.store.getAppByHost(host);
    if (!app || app.unpublishedAt) return undefined;
    return app;
  }

  /** 全部应用的名字(网关要接入它们的网络;下线的应用网络还在,数据库在里面) */
  async allAppNames(): Promise<string[]> {
    return (await this.store.listApps()).map((app) => app.name);
  }

  /** 网关用:应用当前的健康检查路径(最近一次发布的清单里的) */
  async healthcheckPath(appName: string): Promise<string | undefined> {
    return (await this.store.listReleases(appName)).at(-1)?.manifest.healthcheck;
  }

  /** 网关用:viewer 能否访问这个应用(停用、下线的都不能;其余按可见范围和组织架构)。不再查存储 */
  async canView(app: AppRecord, viewer: { id: string; departments: readonly string[] }): Promise<boolean> {
    if (app.disabled || app.unpublishedAt) return false;
    return canAccess(app, viewer, this.adapters.directory);
  }

  /**
   * 服务启动时调用:在后台继续执行上次没跑完的发布,返回这些发布单的 ID。
   * 前提是同一时间只有一个 Ferry 实例在运行,否则同一个发布会被两个实例同时执行。
   */
  async resumeUnfinished(): Promise<string[]> {
    const unfinished = await this.store.listUnfinishedReleases();
    for (const release of unfinished) this.schedule(release.id, () => this.engine.resume(release.id));
    return unfinished.map((release) => release.id);
  }

  /** 发布结束后清理这个应用不再需要的代码包。清理失败只记日志,不影响发布结果 */
  private async cleanupArchives(releaseId: string): Promise<void> {
    try {
      const release = await this.store.getRelease(releaseId);
      if (!release) return;
      await pruneArchives(this.store, this.adapters.archives, release.appName, {
        now: (this.config.now ?? (() => new Date()))(),
        graceMs: this.config.archiveGraceMs ?? 24 * 3600_000,
      });
    } catch (err) {
      console.error(`清理发布单 ${releaseId} 所属应用的代码包时出错`, err);
    }
  }

  private async ownApp(user: User, appName: string): Promise<AppRecord> {
    const app = await this.store.getApp(appName);
    if (!app || app.ownerId !== user.id) throw new UserError("not_found", `应用 ${appName} 不存在`);
    return app;
  }

  private appUrl(host: string): string {
    return `${this.config.appsUrlScheme ?? "https"}://${host}`;
  }

  /** 等待某次发布的后台执行告一段落(测试用) */
  async settle(releaseId: string): Promise<void> {
    await this.running.get(releaseId);
  }

  /** 在后台推进发布 */
  private schedule(releaseId: string, start = () => this.engine.run(releaseId)): void {
    const task = start()
      .catch((err) => console.error(`发布单 ${releaseId} 执行出错`, err))
      .then(() => this.cleanupArchives(releaseId))
      .finally(() => {
        if (this.running.get(releaseId) === task) this.running.delete(releaseId);
      });
    this.running.set(releaseId, task);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** zip 文件以 "PK\x03\x04" 开头 */
function isZip(data: Buffer): boolean {
  return data.length > 4 && data.readUInt32LE(0) === 0x04034b50;
}

function requireAdmin(user: User): void {
  if (!user.isAdmin) throw new UserError("forbidden", "只有平台管理员可以执行这个操作");
}

function toAppView(app: AppRecord, url: string): AppView {
  return {
    name: app.name,
    url,
    visibility: app.visibility,
    live: app.liveVersion !== undefined,
    disabled: app.disabled !== undefined,
    unpublished: app.unpublishedAt !== undefined,
    disabledReason: app.disabled?.reason,
  };
}

function toView(release: ReleaseRecord): ReleaseView {
  return {
    releaseId: release.id,
    kind: release.kind,
    app: release.appName,
    state: release.state,
    done: isTerminal(release.state),
    url: release.url,
    error: release.error,
    nextAction: nextAction(release),
  };
}

function nextAction(release: ReleaseRecord): string {
  if (release.kind === "rollback") {
    switch (release.state) {
      case "LIVE":
        return `回滚成功,线上已恢复为之前的版本。告诉用户访问地址 ${release.url},并提醒数据库没有回滚`;
      case "FAILED":
        return "回滚没有成功,线上仍是原来的版本。不要修改代码,把情况告诉用户";
      default:
        return "回滚进行中,几秒后再查询";
    }
  }
  switch (release.state) {
    case "LIVE":
      return `发布成功,把访问地址 ${release.url} 告诉用户`;
    case "FAILED_FIXABLE":
      return "根据 error 里的日志和提示修复代码,然后重新走一遍 prepare_app、上传、publish_app";
    case "ROLLED_BACK":
      return "新版本有问题,线上已恢复为上一个版本。根据 error 修复后重新走一遍 prepare_app、上传、publish_app";
    case "FAILED":
      if (release.error?.type === "backup_failed") {
        return "不要修改代码,也不要马上重新发布。告诉用户迁移前备份数据库失败、平台管理员已收到告警;等管理员处理好、用户让你再发布时再重新发布";
      }
      return "不要再重试。用通俗的话向用户说明原因,并建议联系平台管理员";
    default:
      return "发布进行中,几秒后再查询";
  }
}
