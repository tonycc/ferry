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
  /** 同一来源连续输错这么多次后,锁定这个来源 */
  maxFailures?: number;
  /** 所有来源合计输错这么多次后,锁定全部来源(防止换着来源猜) */
  maxTotalFailures?: number;
  lockMs?: number;
  now?: () => Date;
}

/** 一个计数:输错次数、正在校验的请求数、锁到什么时候 */
class Attempts {
  failures = 0;
  /** 正在校验的请求也算进次数,免得同时发来的请求绕过锁定 */
  inFlight = 0;
  lockedUntil = 0;

  constructor(private readonly max: number) {}

  /** 还能不能再试一次;不能时抛出说明原因的错误 */
  check(now: number): void {
    if (now < this.lockedUntil) {
      const minutes = Math.ceil((this.lockedUntil - now) / 60_000);
      throw new UserError("quota_exceeded", `设置码输错次数太多,请 ${minutes} 分钟后再试`);
    }
    if (this.failures + this.inFlight >= this.max) throw new UserError("quota_exceeded", "请稍后再试");
  }

  fail(now: number, lockMs: number): void {
    this.failures++;
    if (this.failures >= this.max) {
      this.failures = 0;
      this.lockedUntil = now + lockMs;
    }
  }

  get idle(): boolean {
    return this.failures === 0 && this.inFlight === 0;
  }
}

/**
 * 设置码校验和向导会话。
 *
 * 输错次数按来源(访问者的 IP)分别计数:同一来源连续输错 5 次锁 10 分钟。只锁那个来源,
 * 内网里别人反复输错不会把管理员也锁在外面。所有来源合计输错 50 次时全部锁 10 分钟,防止换着来源猜。
 * 计数在内存里,重启 Ferry 会清零。设置码 12 位(约 59 位随机),这个速度猜不出来。
 */
export class SetupService {
  private readonly sessionTtlMs: number;
  private readonly maxFailures: number;
  private readonly lockMs: number;
  private readonly now: () => Date;
  private readonly total: Attempts;
  private readonly byClient = new Map<string, Attempts>();

  constructor(
    private readonly store: SetupStore,
    options: SetupServiceOptions = {},
  ) {
    this.sessionTtlMs = options.sessionTtlMs ?? 2 * 3600_000;
    this.maxFailures = options.maxFailures ?? 5;
    this.lockMs = options.lockMs ?? 10 * 60_000;
    this.now = options.now ?? (() => new Date());
    this.total = new Attempts(options.maxTotalFailures ?? 50);
  }

  /** 设置码对了就开一个向导会话,返回 cookie 里放的令牌。client 是访问者的 IP */
  async verifyCode(input: string, client: string): Promise<{ token: string; expiresAt: Date }> {
    const now = this.now().getTime();
    this.prune(now);
    const mine = this.byClient.get(client) ?? new Attempts(this.maxFailures);
    mine.check(now);
    this.total.check(now);
    this.byClient.set(client, mine);
    // 在第一个 await 之前占上名额,同时到达的请求才看得到彼此
    mine.inFlight++;
    this.total.inFlight++;
    let ok: boolean;
    try {
      const { setupCodeHash } = await this.store.getSettings();
      if (!setupCodeHash) throw new UserError("conflict", "还没有生成设置码,请重启 Ferry");
      const code = normalizeSetupCode(input);
      ok = code.length > 0 && code.length <= 32 && (await verifyPassword(code, setupCodeHash));
    } finally {
      mine.inFlight--;
      this.total.inFlight--;
    }
    if (!ok) {
      const at = this.now().getTime();
      mine.fail(at, this.lockMs);
      this.total.fail(at, this.lockMs);
      throw new UserError("unauthenticated", "设置码不对");
    }
    mine.failures = 0;

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now().getTime() + this.sessionTtlMs);
    await this.store.deleteExpiredSessions(this.now());
    await this.store.createSession(hashToken(token), expiresAt);
    return { token, expiresAt };
  }

  /** 去掉已经没有记录的来源。合计输错次数有上限,所以表的大小也有上限 */
  private prune(now: number): void {
    for (const [client, attempts] of this.byClient) {
      if (attempts.idle && attempts.lockedUntil <= now) this.byClient.delete(client);
    }
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
