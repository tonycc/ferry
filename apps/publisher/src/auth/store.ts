/** 一次验证码登录:发出的验证码(只存哈希)、过期时间、已输错次数 */
export interface LoginChallenge {
  id: string;
  userId: string;
  codeHash: string;
  createdAt: Date;
  expiresAt: Date;
  attempts: number;
  usedAt?: Date;
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
  saveChallenge(challenge: LoginChallenge): Promise<void>;
  getChallenge(id: string): Promise<LoginChallenge | undefined>;
  /** 某人在 since 之后发过的验证码(限频用),按时间从新到旧 */
  listChallengesSince(userId: string, since: Date): Promise<LoginChallenge[]>;

  saveSession(session: Session): Promise<void>;
  getSession(tokenHash: string): Promise<Session | undefined>;
  deleteSession(tokenHash: string): Promise<void>;

  saveToken(token: PersonalToken): Promise<void>;
  getTokenByHash(tokenHash: string): Promise<PersonalToken | undefined>;
  /** 某人的全部令牌(含已作废的),按创建时间从新到旧 */
  listTokens(userId: string): Promise<PersonalToken[]>;
}

/** 内存实现,重启即丢失,只用于本地开发和测试。读写都复制一份 */
export class MemoryAuthStore implements AuthStore {
  private readonly challenges = new Map<string, LoginChallenge>();
  private readonly sessions = new Map<string, Session>();
  private readonly tokens = new Map<string, PersonalToken>();

  async saveChallenge(challenge: LoginChallenge) {
    this.challenges.set(challenge.id, structuredClone(challenge));
  }

  async getChallenge(id: string) {
    return copy(this.challenges.get(id));
  }

  async listChallengesSince(userId: string, since: Date) {
    return [...this.challenges.values()]
      .filter((c) => c.userId === userId && c.createdAt >= since)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((c) => structuredClone(c));
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
