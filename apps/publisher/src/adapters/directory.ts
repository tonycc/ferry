import type { OrgSnapshot } from "../org/snapshot";
import type { Directory } from "./types";

/**
 * 内存里的组织架构。本地开发和测试直接往里写;
 * 接入钉钉、企业微信后,由同步任务把它们的部门和人员写进来。
 */
export class MemoryDirectory implements Directory {
  /** 部门 ID → 上级部门 ID;根部门的上级是 null */
  private parents = new Map<string, string | null>();
  private members = new Map<string, string[]>();

  /**
   * 用一份快照整体替换(同步完成后、服务启动时调用)。先建好新数据再一次性换上,
   * 权限判定不会读到一半新一半旧的数据。离职的人也保留所属部门,见 mergeDeparted。
   */
  replace(snapshot: OrgSnapshot): void {
    const parents = new Map<string, string | null>(snapshot.departments.map((d) => [d.id, d.parentId]));
    const members = new Map<string, string[]>(snapshot.users.map((u) => [u.id, [...u.departmentIds]]));
    this.parents = parents;
    this.members = members;
  }

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
