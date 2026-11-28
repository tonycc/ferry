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
import type { AuthStore, PasswordRecord, PersonalToken } from "./store";

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

/** 所有登录失败都用这一句:不透露账号是否存在、是否被锁定、是否已离职。次数和时长按配置写 */
function loginFailedMessage(config: AuthConfig): string {
  const minutes = Math.round(config.lockMs / 60_000);
  return `账号或密码不正确。连续输错 ${config.maxFailures} 次要等 ${minutes} 分钟再试;忘记密码请找平台管理员重置`;
}

/**
 * 手机号 + 密码登录,以及个人令牌。
 *
 * - 一期不接企业通讯录和消息平台,没有渠道给本人发验证码,所以用密码登录。初始密码由管理员在控制台生成并转交,
 *   用初始密码登录后必须先改成自己的密码:这时只拿到一张一次性的改密码票据,不签发登录会话,
 *   控制台、访问员工应用、个人令牌在改密码之前都用不了。
 * - 账号不存在、密码错误、已锁定、已离职,返回一样的错误,账号不存在时也算一次哈希,登录页不能用来探测谁是员工。
 *   输错次数按人计(手机号和工号算同一个人;已登录改密码时输错当前密码也算),不存在的账号按输入的账号计,同样会锁定。
 *   已知的限制:知道同事手机号的人可以故意输错,让对方 15 分钟内登录不了。
 * - 密码只存 scrypt 哈希;登录会话和个人令牌只存 SHA-256 哈希。
 * - 每次用登录会话或令牌时都检查本人是否在职,离职后立即失效。
 * - 管理员重置密码或本人修改密码时,作废这个人的全部登录会话,并通过密码代数(sessionEpoch)使所有员工应用的网关 cookie 即时失效;
 *   个人令牌不受影响(忘记密码不该让 agent 停掉)。
 */
export class AuthService {
  private readonly config: AuthConfig;
  /**
   * 输错次数:找得到人时按人计(user:<ID>),找不到时按规范化后的输入计。只有一个 Ferry 实例,放在内存里;重启后清零。
   * 超过锁定时长没再输错的、锁定已经过了的,定期清掉,免得被大量随机账号撑大
   */
  private readonly failures = new Map<string, { count: number; lockedUntil?: number; lastAt: number }>();
  private lastSweep = 0;
  /**
   * 改密码票据(只存哈希),短时间有效、只能用一次;重启后作废,重新登录一次即可。
   * issuedFor 是签发时的密码哈希:密码在这之后变过(被重置、已经改过),票据就不能再用
   */
  private readonly changeTickets = new Map<string, { userId: string; expiresAt: number; issuedFor: string }>();
  /**
   * 每个在用密码对应的网关会话代数(常驻内存,/authz O(1) 校验不查库):
   * 只有已设置正式密码(mustChange=false)的人才有值;改密码、重置为初始密码、离职删密码时同步更新或清除。
   */
  private epochsLoaded = false;
  private hydratingEpochs?: Promise<void>;
  private readonly passwordEpochs = new Map<string, string>();
  private epochGen = 0;

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
    const userId = await this.directory.findLogin(account);
    const key = userId ? `user:${userId}` : accountKey(account);
    // 账号不存在时也查一次库(查不到),和账号存在时的耗时一致
    const record = await this.store.getPassword(userId ?? "");
    let ok = false;
    if (record && password.length <= MAX_PASSWORD_LENGTH) ok = await verifyPassword(password, record.hash);
    else await burnPasswordCheck(password);
    if (ok && userId) ok = await this.directory.isActive(userId);

    // 输错次数和锁定在校验完之后才读写,中间没有 await:同时发来的一批请求各自都会计数,
    // 校验期间账号被锁了的话,这次就算密码对了也不放行
    const now = this.config.now().getTime();
    this.sweep(now);
    const locked = this.isLocked(key, now);
    if (!ok || locked || !userId || !record) {
      if (!locked) this.recordFailure(key, now);
      throw new UserError("unauthenticated", loginFailedMessage(this.config));
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
    // 输错当前密码和登录输错算在一起:拿到一个没退出的会话也不能用这里猜密码
    const key = `user:${userId}`;
    const lockedMessage = `输错次数太多,请 ${Math.round(this.config.lockMs / 60_000)} 分钟后再试`;
    if (this.isLocked(key, this.config.now().getTime())) throw new UserError("invalid_input", lockedMessage);
    const record = await this.store.getPassword(userId);
    const ok = !!record && (await verifyPassword(currentPassword, record.hash));
    const now = this.config.now().getTime();
    if (this.isLocked(key, now)) throw new UserError("invalid_input", lockedMessage);
    if (!ok) {
      this.recordFailure(key, now);
      throw new UserError("invalid_input", "当前密码不正确");
    }
    this.failures.delete(key);
    checkNewPassword(newPassword);
    if (newPassword === currentPassword) throw new UserError("invalid_input", "新密码不能和当前密码一样");
    await this.setPassword(userId, newPassword, false, userId);
    this.clearTickets(userId);
    await this.store.deleteSessionsOf(userId);
    await this.audit.record(userId, "password.change", undefined, {});
    return this.newSession(userId);
  }

  /**
   * 标记离职时调用:作废登录会话、改密码票据和全部个人令牌,删掉密码。
   * 离职期间这些本来就过不了在职检查;清掉是为了恢复在职后不会让旧密码、旧电脑上的旧令牌又能用,
   * 要由管理员重新生成初始密码、本人重新领令牌。返回作废的令牌数
   */
  async endAccess(userId: string): Promise<number> {
    this.clearTickets(userId);
    this.epochGen++;
    await this.store.deleteSessionsOf(userId);
    await this.store.deletePassword(userId);
    this.epochGen++;
    this.passwordEpochs.delete(userId);
    let revoked = 0;
    for (const token of await this.store.listTokens(userId)) {
      if (token.revokedAt) continue;
      token.revokedAt = this.config.now();
      await this.store.saveToken(token);
      revoked++;
    }
    return revoked;
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
    const name = await this.directory.nameOf(userId);
    await this.audit.record(actorId, "password.reset", undefined, { userId, ...(name ? { name } : {}), ...(actorId ? {} : { via: "cli" }) });
    return password;
  }

  /**
   * 设置向导第 5 步:第一个管理员在向导页面上自己设置的密码,不是初始密码,登录后不用再改。规则和改密码一样。
   * 这个人原有的登录会话全部作废
   */
  async setPasswordFromSetup(userId: string, password: string): Promise<void> {
    if (!(await this.directory.isActive(userId))) throw new UserError("not_found", "组织架构里没有这个人,或者已离职");
    checkNewPassword(password);
    await this.setPassword(userId, password, false, undefined);
    this.clearTickets(userId);
    await this.store.deleteSessionsOf(userId);
    const name = await this.directory.nameOf(userId);
    await this.audit.record(undefined, "password.change", undefined, { userId, ...(name ? { name } : {}), via: "setup" });
  }

  /** 人员页用:每个人的密码状态 */
  async passwordStatuses(): Promise<Map<string, PasswordStatus>> {
    const statuses = new Map<string, PasswordStatus>();
    for (const p of await this.store.listPasswords()) statuses.set(p.userId, p.mustChange ? "initial" : "set");
    return statuses;
  }

  /**
   * 从存储重新同步全部用户的密码代数(启动后首次访问自动加载;主进程每分钟与组织架构一起重读一次,
   * 使命令行 set-password 重置的密码也在一分钟内让网关 cookie 失效)。
   */
  async reloadPasswordEpochs(): Promise<void> {
    if (this.hydratingEpochs) return this.hydratingEpochs;
    const task = (async () => {
      for (;;) {
        const gen = this.epochGen;
        const records = await this.store.listPasswords();
        if (this.epochGen !== gen) continue;
        const next = new Map<string, string>();
        for (const record of records) {
          const epoch = passwordEpochOf(record);
          if (epoch) next.set(record.userId, epoch);
        }
        this.passwordEpochs.clear();
        for (const [k, v] of next) this.passwordEpochs.set(k, v);
        this.epochsLoaded = true;
        return;
      }
    })().finally(() => {
      if (this.hydratingEpochs === task) this.hydratingEpochs = undefined;
    });
    this.hydratingEpochs = task;
    return task;
  }

  /** 网关用:某人当前的有效密码代数;未设正式密码或处于初始密码待改状态时返回 undefined */
  async sessionEpoch(userId: string): Promise<string | undefined> {
    if (!this.epochsLoaded) await this.reloadPasswordEpochs();
    return this.passwordEpochs.get(userId);
  }

  /** 登录会话对应的人;会话过期、不存在或本人已离职时返回 undefined */
  async sessionUser(sessionToken: string): Promise<string | undefined> {
    const session = await this.store.getSession(hashToken(sessionToken));
    if (!session || session.expiresAt <= this.config.now()) return undefined;
    return (await this.directory.isActive(session.userId)) ? session.userId : undefined;
  }

  private isLocked(key: string, now: number): boolean {
    const failed = this.failures.get(key);
    return failed?.lockedUntil !== undefined && failed.lockedUntil > now;
  }

  /** 记一次输错;锁定已过、或者上次输错已经是锁定时长之前的,从头计 */
  private recordFailure(key: string, now: number): void {
    const failed = this.failures.get(key);
    const fresh = !failed || failed.lockedUntil !== undefined || now - failed.lastAt > this.config.lockMs;
    const count = (fresh ? 0 : failed.count) + 1;
    this.failures.set(key, {
      count,
      lastAt: now,
      lockedUntil: count >= this.config.maxFailures ? now + this.config.lockMs : undefined,
    });
  }

  /** 每分钟最多一次:清掉不再起作用的输错记录和过期的改密码票据 */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, f] of this.failures) {
      const stale = f.lockedUntil !== undefined ? f.lockedUntil <= now : now - f.lastAt > this.config.lockMs;
      if (stale) this.failures.delete(key);
    }
    for (const [hash, t] of this.changeTickets) if (t.expiresAt <= now) this.changeTickets.delete(hash);
  }

  private clearTickets(userId: string): void {
    for (const [hash, entry] of this.changeTickets) if (entry.userId === userId) this.changeTickets.delete(hash);
  }

  private async setPassword(userId: string, password: string, mustChange: boolean, by: string | undefined) {
    this.epochGen++;
    const record: PasswordRecord = {
      userId,
      hash: await hashPassword(password),
      mustChange,
      updatedAt: this.config.now(),
      updatedBy: by,
    };
    await this.store.savePassword(record);
    this.epochGen++;
    const epoch = passwordEpochOf(record);
    if (epoch) this.passwordEpochs.set(userId, epoch);
    else this.passwordEpochs.delete(userId);
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

  /** 清理已过期的浏览器登录会话(后台定时调用) */
  async pruneExpiredSessions(): Promise<number> {
    return this.store.deleteExpiredSessions(this.config.now());
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

function passwordEpochOf(record: PasswordRecord): string | undefined {
  if (record.mustChange) return undefined;
  return createHash("sha256").update(`ferry-gateway-epoch:${record.hash}`).digest("base64url").slice(0, 16);
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
