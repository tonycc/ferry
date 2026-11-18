import type { OrgSnapshot } from "./snapshot";

/** 组织架构的持久化:服务重启后从这里恢复,不用等下一次同步 */
export interface OrgStore {
  /** 上次保存的快照;从没同步过时返回 undefined */
  load(): Promise<OrgSnapshot | undefined>;
  /** 整体替换(在一个事务里完成) */
  save(snapshot: OrgSnapshot): Promise<void>;
}

/** 内存实现,重启即丢失,只用于本地开发和测试 */
export class MemoryOrgStore implements OrgStore {
  private snapshot: OrgSnapshot | undefined;

  async load(): Promise<OrgSnapshot | undefined> {
    return this.snapshot && structuredClone(this.snapshot);
  }

  async save(snapshot: OrgSnapshot): Promise<void> {
    this.snapshot = structuredClone(snapshot);
  }
}
