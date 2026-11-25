/** 设置向导装好的证书(向导第 3 步、控制台的证书页写入) */
export interface CertificateInfo {
  /** Dokploy 的证书 ID */
  id: string;
  notAfter: Date;
  domains: string[];
}

/** 向导第 2 步检测通过的域名:先存着,第 4 步才生效 */
export interface WizardDomain {
  /** 公司域名,如 example.com */
  domain: string;
  /** Ferry 的域名,如 ferry.example.com */
  ferryHost: string;
  /** 应用的上级域名,如 apps.example.com */
  appsDomain: string;
  /** 两条 A 记录指向的服务器 IP */
  serverIp: string;
}

/** 向导做到哪了。只在向导期间用,完成初始化后不再读 */
export interface WizardState {
  domain?: WizardDomain;
  /** 第 3 步选了“暂时不用 HTTPS” */
  certificateSkipped?: boolean;
  /** 第 4 步切到正式地址时发的交接令牌:只存哈希 */
  handoff?: { tokenHash: string; expiresAt: Date };
}

/** 设置向导写入的本实例配置,没写过的项是 undefined */
export interface InstanceSettings {
  publicUrl?: string;
  appsDomain?: string;
  appsUrlScheme?: "http" | "https";
  certificate?: CertificateInfo;
  setupCodeHash?: string;
  setupCompletedAt?: Date;
  wizard?: WizardState;
}

/** 第 4 步写入、重启后生效的地址配置 */
export interface InstanceAddress {
  publicUrl: string;
  appsDomain: string;
  appsUrlScheme: "http" | "https";
}

export interface SetupStore {
  getSettings(): Promise<InstanceSettings>;
  setSetupCodeHash(hash: string): Promise<void>;
  /** 新建向导会话,只存令牌的哈希 */
  createSession(tokenHash: string, expiresAt: Date): Promise<void>;
  /** 会话的到期时间;没有这个会话时是 undefined */
  sessionExpiry(tokenHash: string): Promise<Date | undefined>;
  deleteExpiredSessions(now: Date): Promise<void>;
  /** 整体替换向导进度 */
  saveWizard(state: WizardState): Promise<void>;
  /** 记下装好的证书;传 undefined 表示没有证书 */
  setCertificate(certificate: CertificateInfo | undefined): Promise<void>;
  /** 写入地址配置(第 4 步),Ferry 重启后按它启动 */
  setAddress(address: InstanceAddress): Promise<void>;
}

/** 测试和内存存储用。未初始化模式要求数据库(向导中途要重启),正式运行不会用到它 */
export class MemorySetupStore implements SetupStore {
  private settings: InstanceSettings = {};
  private readonly sessions = new Map<string, Date>();

  async getSettings() {
    return structuredClone(this.settings);
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

  async saveWizard(state: WizardState) {
    this.settings.wizard = structuredClone(state);
  }

  async setCertificate(certificate: CertificateInfo | undefined) {
    this.settings.certificate = certificate;
  }

  async setAddress(address: InstanceAddress) {
    this.settings = { ...this.settings, ...address };
  }

  /** 只给测试用:模拟向导写入的配置 */
  update(patch: Partial<InstanceSettings>) {
    this.settings = { ...this.settings, ...patch };
  }
}
