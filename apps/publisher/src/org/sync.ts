import type { MemoryDirectory } from "../adapters/directory";
import { mergeDeparted, validateSnapshot, type OrgSnapshot, type OrgSource } from "./snapshot";
import type { OrgStore } from "./store";

export type SyncResult =
  | { status: "applied"; departments: number; active: number; departed: number }
  | { status: "rejected"; problems: string[] }
  | { status: "failed"; error: string }
  | { status: "skipped" };

interface Logger {
  info(message: string): void;
  error(message: string): void;
}

/**
 * 组织架构同步:取快照 → 处理离职 → 检查 → 写数据库 → 换掉内存里的组织架构。
 * 权限判定只读内存,数据库是持久化的副本,服务启动时用它恢复。
 * 日志只记数量,不记姓名和快照内容。
 */
export class OrgSync {
  private current: OrgSnapshot | undefined;
  private running: Promise<SyncResult> | undefined;

  constructor(
    private readonly source: OrgSource | undefined,
    private readonly store: OrgStore,
    private readonly directory: MemoryDirectory,
    private readonly log: Logger = { info: (m) => console.log(m), error: (m) => console.error(m) },
  ) {}

  /** 服务启动时调用:把上次同步保存的组织架构读进内存,不等第一次同步 */
  async init(): Promise<void> {
    const saved = await this.store.load();
    if (!saved) return;
    this.current = saved;
    this.directory.replace(saved);
  }

  /** 同步一次。上一次还没结束时直接返回那一次的结果,不会并发执行 */
  run(): Promise<SyncResult> {
    this.running ??= this.sync().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async sync(): Promise<SyncResult> {
    if (!this.source) return { status: "skipped" };
    let fetched: OrgSnapshot;
    try {
      fetched = await this.source.fetch();
    } catch (err) {
      const error = (err as Error).message;
      this.log.error(`组织架构同步失败,继续使用现有数据: ${error}`);
      return { status: "failed", error };
    }

    const { snapshot, departed } = mergeDeparted(fetched, this.current);
    const problems = validateSnapshot(snapshot, this.current);
    if (problems.length > 0) {
      this.log.error(`组织架构快照有问题,本次不应用,继续使用现有数据: ${problems.join(";")}`);
      return { status: "rejected", problems };
    }

    await this.store.save(snapshot);
    this.directory.replace(snapshot);
    this.current = snapshot;
    const result = {
      status: "applied" as const,
      departments: snapshot.departments.length,
      active: snapshot.users.filter((u) => u.active).length,
      departed,
    };
    this.log.info(`组织架构已同步:${result.departments} 个部门,${result.active} 名在职,本次新增离职 ${departed} 人`);
    return result;
  }
}
