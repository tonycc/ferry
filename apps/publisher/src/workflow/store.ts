import type { Manifest, Visibility } from "@ferry/manifest";
import { isTerminal, type ReleaseState } from "./states";

export interface AppRecord {
  name: string;
  ownerId: string;
  visibility: Visibility;
  /** 访问域名,如 expense-tracker.apps.corp.example */
  host: string;
  /** 已在部署平台上创建的资源 ID;有值就不再重复创建(幂等) */
  platform: { projectId?: string; appId?: string; databaseId?: string; domainAttached?: boolean };
  /** 当前线上运行的代码包版本 */
  liveVersion?: string;
  /** 有值表示已被管理员停用:服务已停止,不能访问,也不能发布 */
  disabled?: { by: string; at: Date; reason?: string };
  createdAt: Date;
}

export interface ReleaseError {
  stage: ReleaseState;
  type: string;
  message: string;
  logs?: string;
  hint?: string;
}

export interface ReleaseRecord {
  id: string;
  appName: string;
  ownerId: string;
  /** 这次发布使用的代码包版本 */
  version: string;
  manifest: Manifest;
  state: ReleaseState;
  backupId?: string;
  error?: ReleaseError;
  url?: string;
  history: { state: ReleaseState; at: Date }[];
  createdAt: Date;
}

/** 一次性上传凭据:prepare_app 签发,代码包上传后即失效 */
export interface UploadTicket {
  /** 只保存令牌的 SHA-256,不保存令牌本身 */
  tokenHash: string;
  appName: string;
  ownerId: string;
  version: string;
  expiresAt: Date;
  /** 有值表示代码包已收到 */
  receivedAt?: Date;
}

export interface Store {
  getApp(name: string): Promise<AppRecord | undefined>;
  getAppByHost(host: string): Promise<AppRecord | undefined>;
  listAppsByOwner(ownerId: string): Promise<AppRecord[]>;
  listApps(): Promise<AppRecord[]>;
  /** 新建应用;应用名已被占用时不写入并返回 false */
  createApp(app: AppRecord): Promise<boolean>;
  /**
   * 更新应用的部署信息(platform、liveVersion、visibility)。
   * 不改停用状态:发布过程中管理员可能同时停用应用,用旧数据整行覆盖会把停用标记冲掉。
   */
  saveApp(app: AppRecord): Promise<void>;
  /** 设置或清除停用状态 */
  setAppDisabled(name: string, disabled: AppRecord["disabled"]): Promise<void>;

  getRelease(id: string): Promise<ReleaseRecord | undefined>;
  /** 按创建时间从旧到新 */
  listReleases(appName: string): Promise<ReleaseRecord[]>;
  saveRelease(release: ReleaseRecord): Promise<void>;
  /** 还没有结束的发布,按创建时间从旧到新(服务重启后继续执行用) */
  listUnfinishedReleases(): Promise<ReleaseRecord[]>;

  saveUpload(ticket: UploadTicket): Promise<void>;
  getUploadByTokenHash(tokenHash: string): Promise<UploadTicket | undefined>;
  getUpload(appName: string, version: string): Promise<UploadTicket | undefined>;
}

/**
 * 内存实现,重启即丢失,只用于本地开发和测试。
 * 读写都复制一份,和数据库一样拿到的是快照:调用方改了对象但没保存,存储里的数据不会变。
 */
export class MemoryStore implements Store {
  private apps = new Map<string, AppRecord>();
  private releases = new Map<string, ReleaseRecord>();
  private uploads = new Map<string, UploadTicket>();

  async getApp(name: string) {
    return copy(this.apps.get(name));
  }

  async getAppByHost(host: string) {
    return copy([...this.apps.values()].find((app) => app.host === host));
  }

  async listAppsByOwner(ownerId: string) {
    return [...this.apps.values()].filter((app) => app.ownerId === ownerId).map(copy);
  }

  async listApps() {
    return [...this.apps.values()].map(copy);
  }

  async createApp(app: AppRecord) {
    if (this.apps.has(app.name)) return false;
    this.apps.set(app.name, copy(app));
    return true;
  }

  async saveApp(app: AppRecord) {
    const current = this.apps.get(app.name);
    if (!current) throw new Error(`应用 ${app.name} 不存在`);
    this.apps.set(app.name, { ...copy(app), disabled: current.disabled });
  }

  async setAppDisabled(name: string, disabled: AppRecord["disabled"]) {
    const current = this.apps.get(name);
    if (!current) throw new Error(`应用 ${name} 不存在`);
    current.disabled = copy(disabled);
  }

  async getRelease(id: string) {
    return copy(this.releases.get(id));
  }

  async listReleases(appName: string) {
    // 按写入顺序排列,创建时间相同时也不会乱序
    return [...this.releases.values()].filter((release) => release.appName === appName).map(copy);
  }

  async saveRelease(release: ReleaseRecord) {
    this.releases.set(release.id, copy(release));
  }

  async listUnfinishedReleases() {
    return [...this.releases.values()].filter((release) => !isTerminal(release.state)).map(copy);
  }

  async saveUpload(ticket: UploadTicket) {
    this.uploads.set(ticket.tokenHash, copy(ticket));
  }

  async getUploadByTokenHash(tokenHash: string) {
    return copy(this.uploads.get(tokenHash));
  }

  async getUpload(appName: string, version: string) {
    return copy([...this.uploads.values()].find((t) => t.appName === appName && t.version === version));
  }
}

function copy<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
