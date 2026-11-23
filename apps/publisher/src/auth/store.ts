/**
 * 登录密码(只存 scrypt 哈希,参数和盐写在哈希字符串里)。
 * mustChange 为 true 表示这是管理员生成的初始密码,用它登录后必须先改成自己的密码
 */
export interface PasswordRecord {
  userId: string;
  hash: string;
  mustChange: boolean;
  updatedAt: Date;
  /** 谁设置的:本人修改时是本人,管理员生成初始密码时是管理员,命令行设置时为空 */
  updatedBy?: string;
}

/** 浏览器登录会话:cookie 里是随机令牌,这里只存它的哈希 */
export interface Session {
  tokenHash: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

/** 个人令牌:给 agent 用,只存哈希,明文只在生成时显示一次 */
export interface PersonalToken {
  id: string;
  tokenHash: string;
  userId: string;
  label: string;
  createdAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
}

export interface AuthStore {
  getPassword(userId: string): Promise<PasswordRecord | undefined>;
  savePassword(record: PasswordRecord): Promise<void>;
  /** 全部已设置的密码(人员页显示状态用) */
  listPasswords(): Promise<PasswordRecord[]>;
  /** 标记离职时删掉:恢复在职后要管理员重新生成初始密码 */
  deletePassword(userId: string): Promise<void>;

  saveSession(session: Session): Promise<void>;
  getSession(tokenHash: string): Promise<Session | undefined>;
  deleteSession(tokenHash: string): Promise<void>;
  /** 删除某人的全部登录会话(改密码、管理员重置密码时) */
  deleteSessionsOf(userId: string): Promise<void>;

  saveToken(token: PersonalToken): Promise<void>;
  getTokenByHash(tokenHash: string): Promise<PersonalToken | undefined>;
  /** 某人的全部令牌(含已作废的),按创建时间从新到旧 */
  listTokens(userId: string): Promise<PersonalToken[]>;
}

/** 内存实现,重启即丢失,只用于本地开发和测试。读写都复制一份 */
export class MemoryAuthStore implements AuthStore {
  private readonly passwords = new Map<string, PasswordRecord>();
  private readonly sessions = new Map<string, Session>();
  private readonly tokens = new Map<string, PersonalToken>();

  async getPassword(userId: string) {
    return copy(this.passwords.get(userId));
  }

  async savePassword(record: PasswordRecord) {
    this.passwords.set(record.userId, structuredClone(record));
  }

  async listPasswords() {
    return [...this.passwords.values()].map((p) => structuredClone(p));
  }

  async deletePassword(userId: string) {
    this.passwords.delete(userId);
  }

  async saveSession(session: Session) {
    this.sessions.set(session.tokenHash, structuredClone(session));
  }

  async getSession(tokenHash: string) {
    return copy(this.sessions.get(tokenHash));
  }

  async deleteSession(tokenHash: string) {
    this.sessions.delete(tokenHash);
  }

  async deleteSessionsOf(userId: string) {
    for (const [hash, session] of this.sessions) if (session.userId === userId) this.sessions.delete(hash);
  }

  async saveToken(token: PersonalToken) {
    this.tokens.set(token.id, structuredClone(token));
  }

  async getTokenByHash(tokenHash: string) {
    return copy([...this.tokens.values()].find((t) => t.tokenHash === tokenHash));
  }

  async listTokens(userId: string) {
    return [...this.tokens.values()]
      .filter((t) => t.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((t) => structuredClone(t));
  }
}

function copy<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}
