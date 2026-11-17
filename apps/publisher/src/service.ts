import { createHash, randomBytes, randomUUID } from "node:crypto";
import { manifestSchema, parseManifest } from "@ferry/manifest";
import type { Adapters } from "./adapters/types";
import { canAccess } from "./authz/decide";
import { UserError } from "./errors";
import type { User } from "./identity";
import type { Engine } from "./workflow/engine";
import { isTerminal, type ReleaseState } from "./workflow/states";
import type { AppRecord, ReleaseError, ReleaseRecord, Store, UploadTicket } from "./workflow/store";

export interface ServiceConfig {
  appsDomain: string;
  maxAppsPerUser: number;
  /** agent 访问本服务用的地址 */
  publicUrl: string;
  uploadTtlMs: number;
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
  app: string;
  state: ReleaseState;
  /** 发布流程是否已结束(成功或失败) */
  done: boolean;
  url?: string;
  error?: ReleaseError;
  /** 写给 agent 的下一步指引 */
  nextAction: string;
}

export interface AppView {
  name: string;
  url: string;
  visibility: string;
  live: boolean;
  /** 已被管理员停用 */
  disabled: boolean;
}

export interface AdminAppView extends AppView {
  ownerId: string;
  /** 负责人当前所属的部门,来自组织架构 */
  departments: string[];
  disabledReason?: string;
}

/** REST 和 MCP 共用的业务入口 */
export class PublisherService {
  private readonly running = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: Store,
    private readonly engine: Engine,
    private readonly adapters: Adapters,
    private readonly config: ServiceConfig,
  ) {}

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
    if (!existing) {
      const mine = await this.store.listAppsByOwner(user.id);
      if (mine.length >= this.config.maxAppsPerUser) {
        throw new UserError("quota_exceeded", `每人最多 ${this.config.maxAppsPerUser} 个应用,请先下线不用的应用`);
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
      url: `https://${app.host}`,
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
    if (!isZip(zip)) throw new UserError("invalid_input", "上传的内容不是 zip 文件");

    ticket.receivedAt = new Date();
    await this.store.saveUpload(ticket);
    await this.adapters.archives.save(ticket.appName, ticket.version, zip);
    return { app: ticket.appName, version: ticket.version, bytes: zip.length };
  }

  async publish(user: User, input: { manifestYaml: string; version: string }): Promise<ReleaseView> {
    const parsed = parseManifest(input.manifestYaml);
    if (!parsed.ok) throw new UserError("invalid_input", `app.yaml 有问题:\n${parsed.errors.join("\n")}`);
    const { manifest } = parsed;

    const app = await this.store.getApp(manifest.name);
    if (!app) throw new UserError("not_found", `应用 ${manifest.name} 还没有创建,请先调用 prepare_app`);
    if (app.ownerId !== user.id) throw new UserError("forbidden", `你不是应用 ${manifest.name} 的负责人`);
    if (app.disabled) {
      throw new UserError("forbidden", `应用 ${app.name} 已被管理员停用,不能发布。请联系平台管理员`);
    }

    const upload = await this.store.getUpload(app.name, input.version);
    if (!upload?.receivedAt) {
      throw new UserError("invalid_input", "还没有收到这个版本的代码包,请先把 zip 上传到 prepare_app 返回的 uploadUrl");
    }

    const releases = await this.store.listReleases(app.name);
    if (releases.some((r) => !isTerminal(r.state))) {
      throw new UserError("conflict", `应用 ${app.name} 有一次发布还在进行中,请等它结束`);
    }

    const release: ReleaseRecord = {
      id: randomUUID(),
      appName: app.name,
      ownerId: user.id,
      version: input.version,
      manifest,
      state: "PENDING",
      history: [{ state: "PENDING", at: new Date() }],
      createdAt: new Date(),
    };
    await this.store.saveRelease(release);
    this.schedule(release.id);
    return toView(release);
  }

  async status(user: User, releaseId: string): Promise<ReleaseView> {
    const release = await this.store.getRelease(releaseId);
    if (!release || release.ownerId !== user.id) throw new UserError("not_found", "发布单不存在");
    return toView(release);
  }

  async listApps(user: User): Promise<AppView[]> {
    const apps = await this.store.listAppsByOwner(user.id);
    return apps.map(toAppView);
  }

  // ---- 管理员操作 ----

  async listAllApps(admin: User): Promise<AdminAppView[]> {
    requireAdmin(admin);
    const apps = await this.store.listApps();
    return Promise.all(
      apps.map(async (app) => ({
        ...toAppView(app),
        ownerId: app.ownerId,
        departments: await this.adapters.directory.departmentsOf(app.ownerId),
        disabledReason: app.disabled?.reason,
      })),
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
    if (app.platform.appId) await this.adapters.platform.stopApp(app.platform.appId);
    await this.adapters.notifier.notify(
      app.ownerId,
      `应用 ${app.name} 已被管理员停用${reason ? `,原因: ${reason}` : ""}`,
    );
  }

  async enableApp(admin: User, appName: string): Promise<void> {
    requireAdmin(admin);
    const app = await this.store.getApp(appName);
    if (!app) throw new UserError("not_found", `应用 ${appName} 不存在`);
    if (!app.disabled) return;

    await this.store.setAppDisabled(app.name, undefined);
    if (app.platform.appId && app.liveVersion) await this.adapters.platform.startApp(app.platform.appId);
    await this.adapters.notifier.notify(app.ownerId, `应用 ${app.name} 已恢复`);
  }

  async getLogs(user: User, appName: string, lines = 200): Promise<string> {
    const app = await this.store.getApp(appName);
    if (!app || app.ownerId !== user.id) throw new UserError("not_found", `应用 ${appName} 不存在`);
    if (!app.platform.appId) return "应用还没有部署过,没有日志";
    return this.adapters.platform.getLogs(app.platform.appId, lines);
  }

  /** 登录网关的权限判定:viewer 能否访问 host 对应的应用 */
  async authorize(viewer: User, host: string): Promise<boolean> {
    const app = await this.store.getAppByHost(host);
    if (!app || app.disabled) return false;
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

  /** 等待某次发布的后台执行告一段落(测试用) */
  async settle(releaseId: string): Promise<void> {
    await this.running.get(releaseId);
  }

  /** 在后台推进发布 */
  private schedule(releaseId: string, start = () => this.engine.run(releaseId)): void {
    const task = start()
      .catch((err) => console.error(`发布单 ${releaseId} 执行出错`, err))
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

function toAppView(app: AppRecord): AppView {
  return {
    name: app.name,
    url: `https://${app.host}`,
    visibility: app.visibility,
    live: app.liveVersion !== undefined,
    disabled: app.disabled !== undefined,
  };
}

function toView(release: ReleaseRecord): ReleaseView {
  return {
    releaseId: release.id,
    app: release.appName,
    state: release.state,
    done: isTerminal(release.state),
    url: release.url,
    error: release.error,
    nextAction: nextAction(release),
  };
}

function nextAction(release: ReleaseRecord): string {
  switch (release.state) {
    case "LIVE":
      return `发布成功,把访问地址 ${release.url} 告诉用户`;
    case "FAILED_FIXABLE":
      return "根据 error 里的日志和提示修复代码,然后重新走一遍 prepare_app、上传、publish_app";
    case "ROLLED_BACK":
      return "新版本有问题,线上已恢复为上一个版本。根据 error 修复后重新走一遍 prepare_app、上传、publish_app";
    case "FAILED":
      return "不要再重试。用通俗的话向用户说明原因,并建议联系平台管理员";
    default:
      return "发布进行中,几秒后再查询";
  }
}
