import { createHash, randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { verifyPassword } from "../auth/password";
import { UserError } from "../errors";
import { readCookies } from "../identity";
import { normalizeSetupCode } from "./code";
import type { SetupStore } from "./store";

/** 设置向导的会话 cookie,和员工登录的 cookie 分开 */
export const SETUP_COOKIE = "ferry_setup";

export interface SetupServiceOptions {
  sessionTtlMs?: number;
  /** 连续输错这么多次后锁定 */
  maxFailures?: number;
  lockMs?: number;
  now?: () => Date;
}

/**
 * 设置码校验和向导会话。
 *
 * 输错次数记在内存里(整个实例共用一个计数,不分来源):重启 Ferry 会清零。
 * 设置码 12 位(约 59 位随机),每 10 分钟最多试 5 次,重启清零也猜不出来。
 */
export class SetupService {
  private readonly sessionTtlMs: number;
  private readonly maxFailures: number;
  private readonly lockMs: number;
  private readonly now: () => Date;
  private failures = 0;
  /** 正在校验的请求也算进次数,免得并发请求绕过锁定 */
  private inFlight = 0;
  private lockedUntil = 0;

  constructor(
    private readonly store: SetupStore,
    options: SetupServiceOptions = {},
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? 2 * 3600_000;
    this.maxFailures = options.maxFailures ?? 5;
    this.lockMs = options.lockMs ?? 10 * 60_000;
    this.now = options.now ?? (() => new Date());
  }

  /** 设置码对了就开一个向导会话,返回 cookie 里放的令牌 */
  async verifyCode(input: string): Promise<{ token: string; expiresAt: Date }> {
    const now = this.now().getTime();
    if (now < this.lockedUntil) {
      const minutes = Math.ceil((this.lockedUntil - now) / 60_000);
      throw new UserError("quota_exceeded", `设置码输错次数太多,请 ${minutes} 分钟后再试`);
    }
    if (this.failures + this.inFlight >= this.maxFailures) {
      throw new UserError("quota_exceeded", "请稍后再试");
    }
    // 在第一个 await 之前占上名额,同时到达的请求才看得到彼此
    this.inFlight++;
    let ok: boolean;
    try {
      const { setupCodeHash } = await this.store.getSettings();
      if (!setupCodeHash) throw new UserError("conflict", "还没有生成设置码,请重启 Ferry");
      const code = normalizeSetupCode(input);
      ok = code.length > 0 && code.length <= 32 && (await verifyPassword(code, setupCodeHash));
    } finally {
      this.inFlight--;
    }
    if (!ok) {
      this.failures++;
      if (this.failures >= this.maxFailures) {
        this.failures = 0;
        this.lockedUntil = this.now().getTime() + this.lockMs;
      }
      throw new UserError("unauthenticated", "设置码不对");
    }
    this.failures = 0;

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now().getTime() + this.sessionTtlMs);
    await this.store.deleteExpiredSessions(this.now());
    await this.store.createSession(hashToken(token), expiresAt);
    return { token, expiresAt };
  }

  /** 请求带着有效的向导会话。同名 cookie 可能有多个(见 readCookies),任意一个有效即可 */
  async hasSession(headers: IncomingHttpHeaders): Promise<boolean> {
    for (const token of readCookies(headers, SETUP_COOKIE)) {
      const expiresAt = await this.store.sessionExpiry(hashToken(token));
      if (expiresAt && expiresAt > this.now()) return true;
    }
    return false;
  }

  get sessionMaxAgeSeconds(): number {
    return Math.floor(this.sessionTtlMs / 1000);
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
