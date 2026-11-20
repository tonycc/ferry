import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { Directory, Notifier } from "../adapters/types";
import { memoryAuditLog, type AuditLog } from "../audit/log";
import { UserError } from "../errors";
import type { AuthStore, PersonalToken } from "./store";

export interface AuthConfig {
  codeTtlMs: number;
  /** 一个验证码最多输错几次 */
  maxAttempts: number;
  /** 同一个人两次发送验证码的最短间隔 */
  resendIntervalMs: number;
  maxCodesPerHour: number;
  sessionTtlMs: number;
  /** 令牌最近使用时间多久更新一次,避免每个请求都写库 */
  tokenTouchIntervalMs: number;
  now: () => Date;
}

export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  codeTtlMs: 5 * 60_000,
  maxAttempts: 5,
  resendIntervalMs: 60_000,
  maxCodesPerHour: 5,
  sessionTtlMs: 7 * 24 * 3600_000,
  tokenTouchIntervalMs: 5 * 60_000,
  now: () => new Date(),
};

/** 个人令牌的前缀,方便密钥扫描工具认出来 */
export const TOKEN_PREFIX = "fry_";

export interface TokenView {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  revoked: boolean;
}

/**
 * 验证码登录和个人令牌。
 *
 * - 验证码通过钉钉、企业微信的工作通知发给本人(本地开发打印在日志里),只有本人能收到,这就证明了身份。
 * - 账号不存在、发送太频繁时,返回和正常发送一样的结果,登录页不能用来探测谁是员工。
 * - 验证码、登录会话、个人令牌都只存哈希。
 * - 每次用登录会话或令牌时都检查本人是否在职,离职后立即失效。
 */
export class AuthService {
  private readonly config: AuthConfig;

  constructor(
    private readonly store: AuthStore,
    private readonly directory: Directory,
    private readonly notifier: Notifier,
    config: Partial<AuthConfig> = {},
    /** 审计日志,记录令牌的生成和作废;不传时记在内存里(只有测试可以不传) */
    private readonly audit: AuditLog = memoryAuditLog(),
  ) {
    this.config = { ...DEFAULT_AUTH_CONFIG, ...config };
  }

  /** 第一步:按工号或手机号找到本人,发验证码。返回值不透露账号是否存在 */
  async requestCode(account: string): Promise<{ challengeId: string }> {
    const challengeId = randomUUID();
    const userId = await this.directory.findLogin(account);
    if (!userId) return { challengeId };

    const now = this.config.now();
    const recent = await this.store.listChallengesSince(userId, new Date(now.getTime() - 3600_000));
    const tooSoon = recent[0] && now.getTime() - recent[0].createdAt.getTime() < this.config.resendIntervalMs;
    if (tooSoon || recent.length >= this.config.maxCodesPerHour) return { challengeId };

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await this.store.saveChallenge({
      id: challengeId,
      userId,
      codeHash: hashCode(challengeId, code),
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.config.codeTtlMs),
      attempts: 0,
    });
    const minutes = Math.round(this.config.codeTtlMs / 60_000);
    await this.notifier.notify(userId, `Ferry 登录验证码:${code},${minutes} 分钟内有效。如果不是你本人操作,请忽略。`);
    return { challengeId };
  }

  /** 第二步:核对验证码,成功后签发登录会话,返回放进 cookie 的令牌 */
  async verify(challengeId: string, code: string): Promise<{ sessionToken: string; expiresAt: Date }> {
    const invalid = new UserError("unauthenticated", "验证码不正确或已过期,请重新获取");
    const now = this.config.now();
    const challenge = await this.store.getChallenge(challengeId);
    if (!challenge || challenge.usedAt || challenge.expiresAt <= now) throw invalid;
    if (challenge.attempts >= this.config.maxAttempts) {
      throw new UserError("unauthenticated", "输错次数太多,请重新获取验证码");
    }
    if (!sameHash(hashCode(challengeId, code.trim()), challenge.codeHash)) {
      challenge.attempts += 1;
      await this.store.saveChallenge(challenge);
      if (challenge.attempts >= this.config.maxAttempts) {
        throw new UserError("unauthenticated", "输错次数太多,请重新获取验证码");
      }
      throw invalid;
    }
    if (!(await this.directory.isActive(challenge.userId))) throw invalid;

    challenge.usedAt = now;
    await this.store.saveChallenge(challenge);
    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + this.config.sessionTtlMs);
    await this.store.saveSession({ tokenHash: hashToken(sessionToken), userId: challenge.userId, createdAt: now, expiresAt });
    return { sessionToken, expiresAt };
  }

  /** 登录会话对应的人;会话过期、不存在或本人已离职时返回 undefined */
  async sessionUser(sessionToken: string): Promise<string | undefined> {
    const session = await this.store.getSession(hashToken(sessionToken));
    if (!session || session.expiresAt <= this.config.now()) return undefined;
    return (await this.directory.isActive(session.userId)) ? session.userId : undefined;
  }

  async logout(sessionToken: string): Promise<void> {
    await this.store.deleteSession(hashToken(sessionToken));
  }

  /** 生成个人令牌,明文只返回这一次 */
  async createToken(userId: string, label: string): Promise<TokenView & { token: string }> {
    const name = label.trim() || "agent";
    if (name.length > 60) throw new UserError("invalid_input", "令牌名称最多 60 个字");
    const token = TOKEN_PREFIX + randomBytes(32).toString("base64url");
    const record: PersonalToken = {
      id: randomUUID(),
      tokenHash: hashToken(token),
      userId,
      label: name,
      createdAt: this.config.now(),
    };
    await this.store.saveToken(record);
    await this.audit.record(userId, "token.create", undefined, { tokenId: record.id, label: name });
    return { ...toView(record), token };
  }

  async listTokens(userId: string): Promise<TokenView[]> {
    return (await this.store.listTokens(userId)).map(toView);
  }

  async revokeToken(userId: string, tokenId: string): Promise<void> {
    const token = (await this.store.listTokens(userId)).find((t) => t.id === tokenId);
    if (!token) throw new UserError("not_found", "令牌不存在");
    if (token.revokedAt) return;
    token.revokedAt = this.config.now();
    await this.store.saveToken(token);
    await this.audit.record(userId, "token.revoke", undefined, { tokenId: token.id, label: token.label });
  }

  /** 个人令牌对应的人;令牌无效、已作废或本人已离职时返回 undefined */
  async tokenUser(token: string): Promise<string | undefined> {
    if (!token.startsWith(TOKEN_PREFIX)) return undefined;
    const record = await this.store.getTokenByHash(hashToken(token));
    if (!record || record.revokedAt) return undefined;
    if (!(await this.directory.isActive(record.userId))) return undefined;
    const now = this.config.now();
    if (!record.lastUsedAt || now.getTime() - record.lastUsedAt.getTime() > this.config.tokenTouchIntervalMs) {
      record.lastUsedAt = now;
      await this.store.saveToken(record);
    }
    return record.userId;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashCode(challengeId: string, code: string): string {
  return createHash("sha256").update(`${challengeId}:${code}`).digest("hex");
}

function sameHash(a: string, b: string): boolean {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function toView(token: PersonalToken): TokenView {
  return {
    id: token.id,
    label: token.label,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString(),
    revoked: token.revokedAt !== undefined,
  };
}
