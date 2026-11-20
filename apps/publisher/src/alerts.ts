import type { Notifier } from "./adapters/types";

export interface AlertsOptions {
  /** 同一类可以合并的告警,多久内只发一次 */
  cooldownMs?: number;
  now?: () => Date;
  /** 告警内容总是同时写进服务日志:没配置通知方式时通知发不出去,日志里还能看到 */
  log?: (message: string) => void;
}

/**
 * 给平台管理员的告警(任务 3.5),通过和其他通知一样的渠道发给 ADMIN_USERS 里的每个人。
 * 发送失败只记日志,不影响调用它的发布流程。
 *
 * 三种发法:
 * - send:每次都发。发布连续失败、备份失败这类每次都是一件独立的事,不能被合并掉。
 * - throttled:同一个 key 在冷却期内只发一次,期间压下的次数和涉及的应用在下一次发出时一起报
 *   (比如部署平台出故障时,每个应用的发布都会失败)。
 * - jobStatus:后台定时任务只在从正常变成失败、以及恢复时各发一次,不会每分钟重复。
 */
export class Alerts {
  private readonly cooldownMs: number;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly throttle = new Map<string, { sentAt: number; suppressed: number; subjects: Set<string> }>();
  private readonly failingJobs = new Map<string, string>();

  constructor(
    private readonly notifier: Notifier,
    private readonly adminIds: readonly string[],
    options: AlertsOptions = {},
  ) {
    this.cooldownMs = options.cooldownMs ?? 30 * 60_000;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((m) => console.error(m));
  }

  async send(message: string): Promise<void> {
    this.log(`[告警] ${message}`);
    if (this.adminIds.length === 0) {
      this.log("没有设置 ADMIN_USERS,上面的告警没有发给任何人");
      return;
    }
    await Promise.all(
      this.adminIds.map((id) =>
        this.notifier
          .notify(id, `【Ferry 告警】${message}`)
          .catch((err: unknown) => this.log(`告警发给 ${id} 失败: ${(err as Error).message ?? String(err)}`)),
      ),
    );
  }

  /** subject 是这次涉及的对象(如应用名),被压下时记下来,下一次发出时列出 */
  async throttled(key: string, message: string, subject?: string): Promise<void> {
    const now = this.now().getTime();
    const state = this.throttle.get(key);
    if (state && now - state.sentAt < this.cooldownMs) {
      state.suppressed++;
      if (subject) state.subjects.add(subject);
      this.log(`[告警,冷却期内不重复发送] ${message}`);
      return;
    }
    let text = message;
    if (state && state.suppressed > 0) {
      const minutes = Math.round((now - state.sentAt) / 60_000);
      const subjects = state.subjects.size > 0 ? `,涉及 ${[...state.subjects].join("、")}` : "";
      text += `(上次告警后的 ${minutes} 分钟里还有 ${state.suppressed} 次同类问题${subjects})`;
    }
    this.throttle.set(key, { sentAt: now, suppressed: 0, subjects: new Set() });
    await this.send(text);
  }

  /** 后台任务每次运行后调用:error 为空表示这次成功 */
  async jobStatus(job: string, error?: string): Promise<void> {
    const wasFailing = this.failingJobs.has(job);
    if (error) {
      if (wasFailing) return;
      this.failingJobs.set(job, error);
      await this.send(`${job}失败:${error}`);
    } else if (wasFailing) {
      this.failingJobs.delete(job);
      await this.send(`${job}已恢复正常`);
    }
  }
}
