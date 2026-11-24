/** 设置向导装好的证书(向导第 3 步、控制台的证书页写入) */
export interface CertificateInfo {
  /** Dokploy 的证书 ID */
  id: string;
  notAfter: Date;
  domains: string[];
}

/** 设置向导写入的本实例配置,没写过的项是 undefined */
export interface InstanceSettings {
  publicUrl?: string;
  appsDomain?: string;
  appsUrlScheme?: "http" | "https";
  certificate?: CertificateInfo;
  setupCodeHash?: string;
  setupCompletedAt?: Date;
}

export interface SetupStore {
  getSettings(): Promise<InstanceSettings>;
  setSetupCodeHash(hash: string): Promise<void>;
  /** 新建向导会话,只存令牌的哈希 */
  createSession(tokenHash: string, expiresAt: Date): Promise<void>;
  /** 会话的到期时间;没有这个会话时是 undefined */
  sessionExpiry(tokenHash: string): Promise<Date | undefined>;
  deleteExpiredSessions(now: Date): Promise<void>;
}

/** 测试和内存存储用。未初始化模式要求数据库(向导中途要重启),正式运行不会用到它 */
export class MemorySetupStore implements SetupStore {
  private settings: InstanceSettings = {};
  private readonly sessions = new Map<string, Date>();

  async getSettings() {
    return { ...this.settings };
  }

  async setSetupCodeHash(hash: string) {
    this.settings.setupCodeHash = hash;
  }

  async createSession(tokenHash: string, expiresAt: Date) {
    this.sessions.set(tokenHash, expiresAt);
  }

  async sessionExpiry(tokenHash: string) {
    return this.sessions.get(tokenHash);
  }

  async deleteExpiredSessions(now: Date) {
    for (const [hash, expiresAt] of this.sessions) if (expiresAt <= now) this.sessions.delete(hash);
  }

  /** 只给测试用:模拟向导写入的配置 */
  update(patch: Partial<InstanceSettings>) {
    this.settings = { ...this.settings, ...patch };
  }
}
