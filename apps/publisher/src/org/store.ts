import type { OrgSnapshot } from "./snapshot";

export const EMPTY_ORG: OrgSnapshot = { departments: [], users: [] };

/**
 * 组织架构的持久化。数据库是唯一的来源:控制台的修改和命令行(pnpm set-password)都写这里,
 * Ferry 内存里那一份(权限判定读它)从这里读出来。
 */
export interface OrgStore {
  /** 当前的组织架构;从没有过数据时返回 undefined */
  load(): Promise<OrgSnapshot | undefined>;
  /**
   * 读出最新的组织架构交给 change,把它返回的新版本整体写回。多个修改(包括另一个进程里的命令行)串行执行,
   * 每次都基于数据库里最新的数据,不会用内存里过时的一份把别人刚写的覆盖掉。change 抛出异常时什么都不写。
   */
  update(change: (current: OrgSnapshot) => OrgSnapshot): Promise<OrgSnapshot>;
}

/** 内存实现,重启即丢失,只用于本地开发和测试 */
export class MemoryOrgStore implements OrgStore {
  private snapshot: OrgSnapshot | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  async load(): Promise<OrgSnapshot | undefined> {
    return this.snapshot && structuredClone(this.snapshot);
  }

  update(change: (current: OrgSnapshot) => OrgSnapshot): Promise<OrgSnapshot> {
    const run = this.queue.then(() => {
      const next = change(structuredClone(this.snapshot ?? EMPTY_ORG));
      this.snapshot = structuredClone(next);
      return structuredClone(next);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
