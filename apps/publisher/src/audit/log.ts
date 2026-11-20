import type { Directory } from "../adapters/types";
import { MemoryAuditStore, type AuditAction, type AuditEvent, type AuditQuery, type AuditStore } from "./store";

/**
 * 写审计记录。在让操作生效的那次写入之后立即调用,早于调用部署平台:
 * 后面的步骤失败时(如停用后停服务出错),操作已经生效,也要有记录。
 */
export class AuditLog {
  constructor(
    private readonly store: AuditStore,
    private readonly directory?: Pick<Directory, "nameOf">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * actorId 为空表示 Ferry 自己。app 给出应用名和当时的负责人。
   * 姓名在这时从组织架构查好存下来,之后改名或离职也不影响
   */
  async record(
    actorId: string | undefined,
    action: AuditAction,
    app?: { name: string; ownerId: string },
    detail: Record<string, unknown> = {},
  ): Promise<void> {
    const actorName = actorId ? ((await this.directory?.nameOf(actorId)) ?? undefined) : undefined;
    await this.store.append({
      at: this.now(),
      actorId,
      actorName,
      action,
      appName: app?.name,
      appOwnerId: app?.ownerId,
      detail,
    });
  }

  /** 按写入顺序从新到旧 */
  list(query: AuditQuery): Promise<AuditEvent[]> {
    return this.store.list(query);
  }
}

/** 不需要查看审计记录的地方(测试)用:记到内存里 */
export function memoryAuditLog(): AuditLog {
  return new AuditLog(new MemoryAuditStore());
}
