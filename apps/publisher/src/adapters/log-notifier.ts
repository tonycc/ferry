import type { Notifier } from "./types";

/**
 * 把通知(给负责人的通知、给管理员的告警)打印到服务日志里。需要显式设置 NOTIFY_VIA=log 才会启用。
 * 一期没有对外发通知的渠道,这是唯一能看到通知内容的地方;以后有了对外发通知的渠道再换掉它。
 */
export class LogNotifier implements Notifier {
  async notify(userId: string, message: string): Promise<void> {
    console.log(`[通知 → ${userId}] ${message}`);
  }
}

/** 没有配置通知方式时用:不发送,只记一条不含内容的日志,免得以为通知发出去了 */
export class UnconfiguredNotifier implements Notifier {
  async notify(userId: string): Promise<void> {
    console.warn(`未配置通知方式(NOTIFY_VIA),发给 ${userId} 的通知没有发出`);
  }
}
