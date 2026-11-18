import type { Notifier } from "./types";

/**
 * 把通知(包括登录验证码)打印到服务日志里。只能用于本地开发:
 * 在真实环境里,能看到日志的人就能拿到任何人的验证码。需要显式设置 NOTIFY_VIA=log 才会启用。
 */
export class LogNotifier implements Notifier {
  async notify(userId: string, message: string): Promise<void> {
    console.log(`[通知 → ${userId}] ${message}`);
  }
}

/** 没有配置通知方式时用:不发送,只记一条不含内容的日志,避免验证码被悄悄吞掉还以为发出去了 */
export class UnconfiguredNotifier implements Notifier {
  async notify(userId: string): Promise<void> {
    console.warn(`未配置通知方式(NOTIFY_VIA),发给 ${userId} 的通知没有发出`);
  }
}
