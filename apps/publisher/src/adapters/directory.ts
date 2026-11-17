import type { Directory } from "./types";

/**
 * 内存里的组织架构。本地开发和测试直接往里写;
 * 接入钉钉、企业微信后,由同步任务把它们的部门和人员写进来。
 */
export class MemoryDirectory implements Directory {
  /** 部门 ID → 上级部门 ID;根部门的上级是 null */
  private readonly parents = new Map<string, string | null>();
  private readonly members = new Map<string, string[]>();

  setDepartment(id: string, parentId: string | null): void {
    this.parents.set(id, parentId);
  }

  setUserDepartments(userId: string, departmentIds: readonly string[]): void {
    this.members.set(userId, [...departmentIds]);
  }

  async departmentsOf(userId: string): Promise<string[]> {
    return [...(this.members.get(userId) ?? [])];
  }

  async ancestorsOf(departmentId: string): Promise<string[]> {
    const result: string[] = [];
    const seen = new Set([departmentId]);
    let current = this.parents.get(departmentId);
    // 上级未登记(undefined)时停止;同步数据有环时也停止,不会死循环
    while (typeof current === "string" && !seen.has(current)) {
      if (this.parents.get(current) === null) break; // current 是根部门,不计入
      result.push(current);
      seen.add(current);
      current = this.parents.get(current);
    }
    return result;
  }
}
