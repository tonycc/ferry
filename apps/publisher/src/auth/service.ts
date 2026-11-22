import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Directory } from "../adapters/types";
import { memoryAuditLog, type AuditLog } from "../audit/log";
import { UserError } from "../errors";
import { normalizeMobile } from "../org/snapshot";
import {
  burnPasswordCheck,
  checkNewPassword,
  generateInitialPassword,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  verifyPassword,
} from "./password";
import type { AuthStore, PersonalToken } from "./store";

export interface AuthConfig {
  /** 同一个账号连续输错几次后锁定 */
  maxFailures: number;
  /** 锁定多久;这段时间里密码对了也不能登录 */
  lockMs: number;
  /** 用初始密码登录后拿到的改密码票据多久内有效 */
  changeTicketTtlMs: number;
  sessionTtlMs: number;
  /** 令牌最近使用时间多久更新一次,避免每个请求都写库 */
  tokenTouchIntervalMs: number;
  now: () => Date;
}

export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  maxFailures: 5,
  lockMs: 15 * 60_000,
  changeTicketTtlMs: 10 * 60_000,
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

/** 登录结果:普通密码直接登录;初始密码只给一张改密码票据,改完才登录 */
export type LoginResult =
  | { kind: "session"; sessionToken: string; expiresAt: Date }
  | { kind: "must_change"; ticket: string };

/** 管理员人员页上一个人的密码状态 */
export type PasswordStatus = "none" | "initial" | "set";

/** 所有登录失败都用这一句:不透露账号是否存在、是否被锁定、是否已离职 */
const LOGIN_FAILED = "账号或密码不正确。连续输错 5 次要等 15 分钟再试;忘记密码请找平台管理员重置";

/**
 * 手机号 + 密码登录,以及个人令牌。
 *
 * - 一期不接企业通讯录和消息平台,没有渠道给本人发验证码,所以用密码登录。初始密码由管理员在控制台生成并转交,
 *   用初始密码登录后必须先改成自己的密码:这时只拿到一张一次性的改密码票据,不签发登录会话,
 *   控制台、访问员工应用、个人令牌在改密码之前都用不了。
 * - 账号不存在、密码错误、已锁定、已离职,返回一样的错误,账号不存在时也算一次哈希,登录页不能用来探测谁是员工。
 *   输错次数按输入的账号计,不存在的账号同样会锁定。已知的限制:知道同事手机号的人可以故意输错,让对方 15 分钟内登录不了。
 * - 密码只存 scrypt 哈希;登录会话和个人令牌只存 SHA-256 哈希。
 * - 每次用登录会话或令牌时都检查本人是否在职,离职后立即失效。
 * - 管理员重置密码时作废这个人的全部登录会话;个人令牌不受影响(忘记密码不该让 agent 停掉),
 *   访问员工应用的网关 cookie 也要等它自己过期(最长 GATEWAY_COOKIE_HOURS)。
 */
export class AuthService {
  private readonly config: AuthConfig;
  /** 输错次数,按规范化后的账号计。只有一个 Ferry 实例,放在内存里;重启后清零 */
  private readonly failures = new Map<string, { count: number; lockedUntil?: number }>();
  /**
   * 改密码票据(只存哈希),短时间有效、只能用一次;重启后作废,重新登录一次即可。
   * issuedFor 是签发时的密码哈希:密码在这之后变过(被重置、已经改过),票据就不能再用
   */
  private readonly changeTickets = new Map<string, { userId: string; expiresAt: number; issuedFor: string }>();

  constructor(
    private readonly store: AuthStore,
    private readonly directory: Directory,
    config: Partial<AuthConfig> = {},
    /** 审计日志,记录密码和令牌的变化;不传时记在内存里(只有测试可以不传) */
    private readonly audit: AuditLog = memoryAuditLog(),
  ) {
    this.config = { ...DEFAULT_AUTH_CONFIG, ...config };
  }

  /** 用手机号(或工号)和密码登录 */
  async login(account: string, password: string): Promise<LoginResult> {
    const key = accountKey(account);
    const userId = await this.directory.findLogin(account);
    const record = userId ? await this.store.getPassword(userId) : undefined;
    let ok = false;
    if (record && password.length <= MAX_PASSWORD_LENGTH) ok = await verifyPassword(password, record.hash);
    else await burnPasswordCheck(password);
    if (ok && userId) ok = await this.directory.isActive(userId);

    // 输错次数和锁定在校验完之后才读写,中间没有 await:同时发来的一批请求各自都会计数,
    // 校验期间账号被锁了的话,这次就算密码对了也不放行
    const now = this.config.now().getTime();
    const failed = this.failures.get(key);
    const locked = failed?.lockedUntil !== undefined && failed.lockedUntil > now;
    if (!ok || locked || !userId || !record) {
      if (!locked) {
        const count = (failed?.lockedUntil !== undefined ? 0 : (failed?.count ?? 0)) + 1;
        this.failures.set(key, {
          count,
          lockedUntil: count >= this.config.maxFailures ? now + this.config.lockMs : undefined,
        });
      }
      throw new UserError("unauthenticated", LOGIN_FAILED);
    }
    this.failures.delete(key);

    if (record.mustChange) {
      const ticket = randomBytes(32).toString("base64url");
      this.changeTickets.set(hashToken(ticket), {
        userId,
        expiresAt: now + this.config.changeTicketTtlMs,
        issuedFor: record.hash,
      });
      return { kind: "must_change", ticket };
    }
    return { kind: "session", ...(await this.newSession(userId)) };
  }

  /** 用初始密码登录后,凭票据改成自己的密码,改完签发登录会话 */
  async changeInitialPassword(ticket: string, newPassword: string): Promise<{ sessionToken: string; expiresAt: Date }> {
    const hash = hashToken(ticket);
    const entry = this.changeTickets.get(hash);
    const now = this.config.now().getTime();
    const expired = new UserError("unauthenticated", "改密码的页面已过期,请用初始密码重新登录");
    if (!entry || entry.expiresAt <= now || !(await this.directory.isActive(entry.userId))) {
      this.changeTickets.delete(hash);
      throw expired;
    }
    // 签发之后密码变过(管理员重置了、或者已经用别的票据改过):这张票据作废
    const current = await this.store.getPassword(entry.userId);
    if (!current?.mustChange || current.hash !== entry.issuedFor) {
      this.changeTickets.delete(hash);
      throw expired;
    }
    checkNewPassword(newPassword);
    if (await verifyPassword(newPassword, current.hash)) {
      throw new UserError("invalid_input", "新密码不能和初始密码一样");
    }
    // 再确认一次票据还在(校验期间可能已经被同时提交的另一次用掉了)
    if (!this.changeTickets.delete(hash)) throw expired;
    this.clearTickets(entry.userId);
    await this.setPassword(entry.userId, newPassword, false, entry.userId);
    await this.audit.record(entry.userId, "password.change", undefined, { initial: true });
    return this.newSession(entry.userId);
  }

  /** 已登录时修改密码:要输入当前密码;改完作废这个人的全部登录会话,签发一个新的 */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ sessionToken: string; expiresAt: Date }> {
    const record = await this.store.getPassword(userId);
    if (!record || !(await verifyPassword(currentPassword, record.hash))) {
      throw new UserError("invalid_input", "当前密码不正确");
    }
    checkNewPassword(newPassword);
    if (newPassword === currentPassword) throw new UserError("invalid_input", "新密码不能和当前密码一样");
    await this.setPassword(userId, newPassword, false, userId);
    this.clearTickets(userId);
    await this.store.deleteSessionsOf(userId);
    await this.audit.record(userId, "password.change", undefined, {});
    return this.newSession(userId);
  }

  /**
   * 生成初始密码(管理员在人员页上,或者第一个管理员用命令行)。返回明文,只显示这一次;
   * 这个人原有的登录会话全部作废,下次登录后必须先改密码。actorId 为空表示命令行
   */
  async resetPassword(actorId: string | undefined, userId: string): Promise<string> {
    if (!(await this.directory.isActive(userId))) throw new UserError("not_found", "组织架构里没有这个人,或者已离职");
    const password = generateInitialPassword();
    await this.setPassword(userId, password, true, actorId);
    // 之前用旧的初始密码拿到的改密码票据一起作废(初始密码泄露时,重置就是补救办法)
    this.clearTickets(userId);
    await this.store.deleteSessionsOf(userId);
    await this.audit.record(actorId, "password.reset", undefined, { userId, ...(actorId ? {} : { via: "cli" }) });
    return password;
  }

  /** 人员页用:每个人的密码状态 */
  async passwordStatuses(): Promise<Map<string, PasswordStatus>> {
    const statuses = new Map<string, PasswordStatus>();
    for (const p of await this.store.listPasswords()) statuses.set(p.userId, p.mustChange ? "initial" : "set");
    return statuses;
  }

  /** 登录会话对应的人;会话过期、不存在或本人已离职时返回 undefined */
  async sessionUser(sessionToken: string): Promise<string | undefined> {
    const session = await this.store.getSession(hashToken(sessionToken));
    if (!session || session.expiresAt <= this.config.now()) return undefined;
    return (await this.directory.isActive(session.userId)) ? session.userId : undefined;
  }

  private clearTickets(userId: string): void {
    for (const [hash, entry] of this.changeTickets) if (entry.userId === userId) this.changeTickets.delete(hash);
  }

  private async setPassword(userId: string, password: string, mustChange: boolean, by: string | undefined) {
    await this.store.savePassword({
      userId,
      hash: await hashPassword(password),
      mustChange,
      updatedAt: this.config.now(),
      updatedBy: by,
    });
  }

  private async newSession(userId: string): Promise<{ sessionToken: string; expiresAt: Date }> {
    const now = this.config.now();
    const sessionToken = randomBytes(32).toString("base64url");
    const expiresAt = new Date(now.getTime() + this.config.sessionTtlMs);
    await this.store.saveSession({ tokenHash: hashToken(sessionToken), userId, createdAt: now, expiresAt });
    return { sessionToken, expiresAt };
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

/** 计输错次数用的账号:手机号去掉格式差异,工号不分大小写 */
function accountKey(account: string): string {
  const value = account.trim();
  return /^[+\d\s-]+$/.test(value) ? `mobile:${normalizeMobile(value)}` : `job:${value.toLowerCase()}`;
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
