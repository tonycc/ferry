/**
 * 审计日志(任务 3.3):谁在什么时候对哪个应用做了什么。只追加,不修改、不删除。
 *
 * 和应用记录分开存放:管理员彻底删除应用时,应用的发布记录会一起删掉,审计记录要留下来。
 * 应用名在删除后可以被别人重新使用,所以每条记录都带上当时的负责人,用来区分同名的两个应用。
 */

/** 记录的操作。写进数据库的是这些字符串,改名要兼容已有的记录 */
export const AUDIT_ACTIONS = [
  /** 占用应用名(第一次 prepare_app) */
  "app.create",
  /** 发起发布;detail.revived 为 true 表示重新发布已下线的应用(恢复) */
  "app.publish",
  /** 发起回滚 */
  "app.rollback",
  /** 发布或回滚结束(Ferry 记录):detail.state 是结果,失败时有 detail.errorType */
  "release.finish",
  /** 负责人下线 */
  "app.unpublish",
  /** 修改可见范围 */
  "app.visibility",
  /** 新增或替换应用密钥(只记名称) */
  "secret.set",
  "secret.delete",
  /** 管理员停用;detail.reason 是填写的原因 */
  "app.disable",
  /** 管理员恢复 */
  "app.enable",
  /** 管理员彻底删除(发起;中途失败后重试会再记一条) */
  "app.delete",
  /** 个人令牌 */
  "token.create",
  "token.revoke",
  /** 生成初始密码(管理员或命令行);detail.userId 是被重置的人 */
  "password.reset",
  /** 本人修改密码;detail.initial 为 true 表示首次登录时把初始密码改掉 */
  "password.change",
  /** 人员管理(管理员在控制台,或命令行建第一个管理员):detail.userId、detail.name 是被操作的人 */
  "user.create",
  /** 修改姓名、手机号、工号或部门;detail.fields 列出改了哪些(不记手机号的值) */
  "user.update",
  /** 标记离职 */
  "user.deactivate",
  /** 恢复在职 */
  "user.reactivate",
  /** 设为或取消平台管理员;detail.isAdmin 是改后的值 */
  "user.admin",
  /** 部门管理:detail.departmentId、detail.name */
  "department.create",
  /** 改名或调整上级部门;detail 里有改前改后的值 */
  "department.update",
  "department.delete",
  /** 设置向导第 6 步自检:detail.skipped 为 true 表示跳过了 */
  "setup.selfcheck",
  /** 设置向导第 7 步完成初始化;detail.publicUrl 是正式地址 */
  "setup.complete",
  /** 管理员在控制台装证书(替换或补装);detail.notAfter、detail.domains,detail.switchedToHttps 表示同时切到了 https */
  "certificate.install",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditEvent {
  /** 写入顺序,越大越新;分页用 */
  id: number;
  at: Date;
  /** 操作人;为空表示 Ferry 自己(如发布结束) */
  actorId?: string;
  /** 操作当时的姓名,之后改名或离职也不变 */
  actorName?: string;
  action: AuditAction;
  appName?: string;
  /** 应用当时的负责人 */
  appOwnerId?: string;
  /** 操作的细节,只由 Ferry 写入,不含密钥的值 */
  detail: Record<string, unknown>;
}

export type NewAuditEvent = Omit<AuditEvent, "id">;

export interface AuditQuery {
  appName?: string;
  actorId?: string;
  action?: AuditAction;
  /** 只返回 id 小于它的记录(翻到下一页) */
  beforeId?: number;
  limit: number;
}

export interface AuditStore {
  append(event: NewAuditEvent): Promise<void>;
  /** 按 id 从新到旧 */
  list(query: AuditQuery): Promise<AuditEvent[]>;
}

/** 内存实现,重启即丢失,只用于本地开发和测试 */
export class MemoryAuditStore implements AuditStore {
  private events: AuditEvent[] = [];

  async append(event: NewAuditEvent) {
    this.events.push(structuredClone({ ...event, id: this.events.length + 1 }));
  }

  async list(q: AuditQuery) {
    return this.events
      .filter(
        (e) =>
          (q.appName === undefined || e.appName === q.appName) &&
          (q.actorId === undefined || e.actorId === q.actorId) &&
          (q.action === undefined || e.action === q.action) &&
          (q.beforeId === undefined || e.id < q.beforeId),
      )
      .reverse()
      .slice(0, q.limit)
      .map((e) => structuredClone(e));
  }
}
