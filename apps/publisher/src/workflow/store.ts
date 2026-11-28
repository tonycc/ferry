import type { Manifest, Visibility } from "@ferry/manifest";
import { isTerminal, type ReleaseState } from "./states";

export interface AppRecord {
  name: string;
  ownerId: string;
  visibility: Visibility;
  /**
   * 为 true 时可见范围以控制台(或 agent 的 set_visibility)为准,发布时不再用 app.yaml 里的值。
   * 应用第一次上线或负责人改过可见范围后变为 true
   */
  visibilityPinned?: boolean;
  /** 访问域名,如 expense-tracker.apps.corp.example */
  host: string;
  /** 已在部署平台上创建的资源 ID;有值就不再重复创建(幂等) */
  platform: {
    projectId?: string;
    appId?: string;
    databaseId?: string;
    domainAttached?: boolean;
  };
  /** 当前线上运行的代码包版本 */
  liveVersion?: string;
  /** 有值表示已被管理员停用:服务已停止,不能访问,也不能发布 */
  disabled?: { by: string; at: Date; reason?: string };
  /**
   * 有值表示负责人已下线:部署平台上的应用已删除,数据库已停止但数据保留。
   * 应用名仍归负责人所有,重新发布即恢复(连同原来的数据)
   */
  unpublishedAt?: Date;
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
  /** publish:发布新版本;rollback:回滚到之前上线过的版本,只部署代码,不迁移数据库 */
  kind: "publish" | "rollback";
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
  /** 收到代码包时从里面读出并校验过的 app.yaml;旧数据里可能没有 */
  manifest?: Manifest;
}

/** 应用密钥(见 secrets.ts)。存储里只有密文 */
export interface SecretRecord {
  appName: string;
  /** 环境变量名,如 LLM_API_KEY */
  name: string;
  ciphertext: string;
  updatedAt: Date;
  updatedBy: string;
}

export type PrepareAppResult =
  | { ok: true; app: AppRecord; created: boolean }
  | { ok: false; reason: "conflict" | "disabled" | "quota_exceeded" };

export type StartReleaseResult =
  | { ok: true; app: AppRecord; revived: boolean }
  | {
      ok: false;
      reason: "not_found" | "forbidden_owner" | "disabled" | "not_live" | "stale_live" | "in_progress" | "quota_exceeded";
    };

export type MarkUnpublishedResult =
  | { ok: true; app: AppRecord; alreadyDone: boolean; firstAttempt: boolean }
  | { ok: false; reason: "not_found" | "in_progress" };

export type StoreMutation =
  | { kind: "app"; appName: string; host?: string }
  | { kind: "release"; appName: string };

export interface Store {
  getApp(name: string): Promise<AppRecord | undefined>;
  getAppByHost(host: string): Promise<AppRecord | undefined>;
  listAppsByOwner(ownerId: string): Promise<AppRecord[]>;
  listApps(): Promise<AppRecord[]>;
  /** 新建应用;应用名已被占用时不写入并返回 false */
  createApp(app: AppRecord): Promise<boolean>;
  /**
   * 原子地校验负责人在线应用配额并占用(或复用自己的)应用名,消除并发 prepare_app 超配额竞态。
   */
  prepareAppSlot(app: AppRecord, maxActiveByOwner: number): Promise<PrepareAppResult>;
  /**
   * 更新应用的部署信息(platform、liveVersion、visibility、unpublishedAt)。
   * 不改停用状态:发布过程中管理员可能同时停用应用,用旧数据整行覆盖会把停用标记冲掉。
   */
  saveApp(app: AppRecord): Promise<void>;
  /** 设置或清除停用状态 */
  setAppDisabled(name: string, disabled: AppRecord["disabled"]): Promise<void>;
  /**
   * 原子地检查没有进行中的发布单并将应用标记为已下线,防止下线与发布并发交叉。
   */
  markAppUnpublished(appName: string, ownerId: string, at: Date): Promise<MarkUnpublishedResult>;
  /** 删除应用和它的全部发布记录、上传凭据、密钥(管理员删除应用时);之后应用名可以被重新使用 */
  deleteApp(name: string): Promise<void>;

  getRelease(id: string): Promise<ReleaseRecord | undefined>;
  /** 按创建时间从旧到新 */
  listReleases(appName: string): Promise<ReleaseRecord[]>;
  /** 最近一条发布记录里的健康检查路径(不拉取历史记录和日志大字段) */
  getLatestHealthcheck(appName: string): Promise<string | undefined>;
  saveRelease(release: ReleaseRecord): Promise<void>;
  /**
   * 原子地校验应用状态、无未结束发布单、(恢复已下线应用时)配额未满并写入新发布单。
   */
  startRelease(
    release: ReleaseRecord,
    options?: { maxActiveByOwner?: number; expectedLiveVersion?: string },
  ): Promise<StartReleaseResult>;
  /** 还没有结束的发布,按创建时间从旧到新(服务重启后继续执行用) */
  listUnfinishedReleases(): Promise<ReleaseRecord[]>;

  /** 订阅应用或发布单的变更通知(供网关内存缓存失效用) */
  subscribe?(listener: (mutation: StoreMutation) => void): () => void;

  saveUpload(ticket: UploadTicket): Promise<void>;
  getUploadByTokenHash(tokenHash: string): Promise<UploadTicket | undefined>;
  getUpload(appName: string, version: string): Promise<UploadTicket | undefined>;
  /**
   * 原子地把上传凭据标记为已收到,同时记下清单。凭据已经被用过(包括并发的另一次上传抢先)时返回 false。
   */
  claimUpload(tokenHash: string, receivedAt: Date, manifest: Manifest): Promise<boolean>;

  /** 按名称排序 */
  listSecrets(appName: string): Promise<SecretRecord[]>;
  /**
   * 新增或替换同名密钥。新增后这个应用的密钥会超过 limit 个时不写入,返回 false。
   * 数量检查和写入是原子的,并发新增也不会超出
   */
  saveSecret(secret: SecretRecord, limit: number): Promise<boolean>;
  /** 返回是否删掉了 */
  deleteSecret(appName: string, name: string): Promise<boolean>;
}

/**
 * 内存实现,重启即丢失,只用于本地开发和测试。
 * 读写都复制一份,和数据库一样拿到的是快照:调用方改了对象但没保存,存储里的数据不会变。
 */
export class MemoryStore implements Store {
  private apps = new Map<string, AppRecord>();
  private releases = new Map<string, ReleaseRecord>();
  private uploads = new Map<string, UploadTicket>();
  private secrets = new Map<string, SecretRecord>();
  private locks = new Map<string, Promise<void>>();
  private listeners = new Set<(mutation: StoreMutation) => void>();

  subscribe(listener: (mutation: StoreMutation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(mutation: StoreMutation): void {
    for (const listener of this.listeners) listener(mutation);
  }

  private async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => gate);
    this.locks.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

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
    this.emit({ kind: "app", appName: app.name, host: app.host });
    return true;
  }

  async prepareAppSlot(candidate: AppRecord, maxActiveByOwner: number): Promise<PrepareAppResult> {
    try {
      return await this.withLock(`owner:${candidate.ownerId}`, () =>
        this.withLock(`app:${candidate.name}`, async () => {
          const existing = this.apps.get(candidate.name);
          if (existing && existing.ownerId !== candidate.ownerId) return { ok: false, reason: "conflict" };
          if (existing?.disabled) return { ok: false, reason: "disabled" };
          if (!existing || existing.unpublishedAt !== undefined) {
            const active = [...this.apps.values()].filter((a) => a.ownerId === candidate.ownerId && !a.unpublishedAt).length;
            if (active >= maxActiveByOwner) return { ok: false, reason: "quota_exceeded" };
          }
          if (existing) return { ok: true, app: copy(existing), created: false };
          const stored = copy(candidate);
          this.apps.set(stored.name, stored);
          return { ok: true, app: copy(stored), created: true };
        }),
      );
    } finally {
      this.emit({ kind: "app", appName: candidate.name, host: candidate.host });
    }
  }

  async saveApp(app: AppRecord) {
    const current = this.apps.get(app.name);
    if (!current) throw new Error(`应用 ${app.name} 不存在`);
    this.apps.set(app.name, { ...copy(app), disabled: current.disabled });
    this.emit({ kind: "app", appName: app.name, host: app.host });
  }

  async markAppUnpublished(appName: string, ownerId: string, at: Date): Promise<MarkUnpublishedResult> {
    let host: string | undefined;
    try {
      return await this.withLock(`app:${appName}`, async () => {
        const current = this.apps.get(appName);
        if (!current || current.ownerId !== ownerId) return { ok: false, reason: "not_found" };
        host = current.host;
        if (current.unpublishedAt && !current.platform.appId) {
          return { ok: true, app: copy(current), alreadyDone: true, firstAttempt: false };
        }
        for (const existing of this.releases.values()) {
          if (existing.appName === appName && !isTerminal(existing.state)) {
            return { ok: false, reason: "in_progress" };
          }
        }
        const firstAttempt = !current.unpublishedAt;
        current.unpublishedAt = new Date(at.getTime());
        return { ok: true, app: copy(current), alreadyDone: false, firstAttempt };
      });
    } finally {
      this.emit({ kind: "app", appName, host });
    }
  }

  async deleteApp(name: string) {
    const host = this.apps.get(name)?.host;
    this.apps.delete(name);
    for (const [id, release] of this.releases) if (release.appName === name) this.releases.delete(id);
    for (const [key, upload] of this.uploads) if (upload.appName === name) this.uploads.delete(key);
    for (const [key, secret] of this.secrets) if (secret.appName === name) this.secrets.delete(key);
    this.emit({ kind: "app", appName: name, host });
    this.emit({ kind: "release", appName: name });
  }

  async setAppDisabled(name: string, disabled: AppRecord["disabled"]) {
    const current = this.apps.get(name);
    if (!current) throw new Error(`应用 ${name} 不存在`);
    current.disabled = copy(disabled);
    this.emit({ kind: "app", appName: name, host: current.host });
  }

  async getRelease(id: string) {
    return copy(this.releases.get(id));
  }

  async listReleases(appName: string) {
    // 按写入顺序排列,创建时间相同时也不会乱序
    return [...this.releases.values()].filter((release) => release.appName === appName).map(copy);
  }

  async getLatestHealthcheck(appName: string) {
    return [...this.releases.values()].filter((release) => release.appName === appName).at(-1)?.manifest.healthcheck;
  }

  async saveRelease(release: ReleaseRecord) {
    if (!isTerminal(release.state)) {
      for (const existing of this.releases.values()) {
        if (existing.appName === release.appName && existing.id !== release.id && !isTerminal(existing.state)) {
          throw new Error(`应用 ${release.appName} 已有未结束的发布单`);
        }
      }
    }
    this.releases.set(release.id, copy(release));
    this.emit({ kind: "release", appName: release.appName });
  }

  async startRelease(
    release: ReleaseRecord,
    options: { maxActiveByOwner?: number; expectedLiveVersion?: string } = {},
  ): Promise<StartReleaseResult> {
    let host: string | undefined;
    try {
      return await this.withLock(`owner:${release.ownerId}`, () =>
        this.withLock(`app:${release.appName}`, async () => {
          const current = this.apps.get(release.appName);
          if (!current) return { ok: false, reason: "not_found" };
          host = current.host;
          if (current.ownerId !== release.ownerId) return { ok: false, reason: "forbidden_owner" };
          if (current.disabled) return { ok: false, reason: "disabled" };
          if (options.expectedLiveVersion !== undefined) {
            if (current.unpublishedAt || !current.liveVersion) return { ok: false, reason: "not_live" };
            if (current.liveVersion !== options.expectedLiveVersion) return { ok: false, reason: "stale_live" };
          }
          for (const existing of this.releases.values()) {
            if (existing.appName === release.appName && !isTerminal(existing.state)) {
              return { ok: false, reason: "in_progress" };
            }
          }
          let revived = false;
          if (current.unpublishedAt !== undefined && options.expectedLiveVersion === undefined) {
            if (options.maxActiveByOwner !== undefined) {
              const active = [...this.apps.values()].filter((a) => a.ownerId === current.ownerId && !a.unpublishedAt).length;
              if (active >= options.maxActiveByOwner) return { ok: false, reason: "quota_exceeded" };
            }
            current.unpublishedAt = undefined;
            revived = true;
          }
          this.releases.set(release.id, copy(release));
          return { ok: true, app: copy(current), revived };
        }),
      );
    } finally {
      this.emit({ kind: "app", appName: release.appName, host });
      this.emit({ kind: "release", appName: release.appName });
    }
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

  async claimUpload(tokenHash: string, receivedAt: Date, manifest: Manifest) {
    const ticket = this.uploads.get(tokenHash);
    if (!ticket || ticket.receivedAt) return false;
    ticket.receivedAt = receivedAt;
    ticket.manifest = copy(manifest);
    return true;
  }

  async listSecrets(appName: string) {
    return [...this.secrets.values()]
      .filter((s) => s.appName === appName)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map(copy);
  }

  async saveSecret(secret: SecretRecord, limit: number) {
    if (!this.apps.has(secret.appName)) throw new Error(`应用 ${secret.appName} 不存在`);
    const key = secretKey(secret.appName, secret.name);
    const count = [...this.secrets.values()].filter((s) => s.appName === secret.appName).length;
    if (!this.secrets.has(key) && count >= limit) return false;
    this.secrets.set(key, copy(secret));
    return true;
  }

  async deleteSecret(appName: string, name: string) {
    return this.secrets.delete(secretKey(appName, name));
  }
}

function secretKey(appName: string, name: string): string {
  return `${appName}\u0000${name}`;
}

function copy<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
