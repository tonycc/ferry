import { loginKeys, normalizeMobile, type OrgSnapshot } from "../org/snapshot";
import type { Directory } from "./types";

/**
 * 内存里的组织架构。本地开发和测试直接往里写;
 * 接入钉钉、企业微信后,由同步任务把它们的部门和人员写进来。
 */
export class MemoryDirectory implements Directory {
  /** 部门 ID → 上级部门 ID;根部门的上级是 null */
  private parents = new Map<string, string | null>();
  private members = new Map<string, string[]>();
  private inactive = new Set<string>();
  private names = new Map<string, string>();
  private departmentNames = new Map<string, string>();
  /** 规范化后的工号、手机号 → 在职的人 */
  private logins = new Map<string, string>();

  /**
   * 用一份快照整体替换(同步完成后、服务启动时调用)。先建好新数据再一次性换上,
   * 权限判定不会读到一半新一半旧的数据。离职的人也保留所属部门,见 mergeDeparted。
   */
  replace(snapshot: OrgSnapshot): void {
    const parents = new Map<string, string | null>(snapshot.departments.map((d) => [d.id, d.parentId]));
    const members = new Map<string, string[]>(snapshot.users.map((u) => [u.id, [...u.departmentIds]]));
    const inactive = new Set(snapshot.users.filter((u) => !u.active).map((u) => u.id));
    const names = new Map(snapshot.users.map((u) => [u.id, u.name]));
    const departmentNames = new Map(snapshot.departments.map((d) => [d.id, d.name]));
    const logins = new Map<string, string>();
    for (const u of snapshot.users) if (u.active) for (const key of loginKeys(u)) logins.set(key, u.id);
    this.parents = parents;
    this.members = members;
    this.inactive = inactive;
    this.names = names;
    this.departmentNames = departmentNames;
    this.logins = logins;
  }

  setDepartment(id: string, parentId: string | null): void {
    this.parents.set(id, parentId);
  }

  setUserDepartments(userId: string, departmentIds: readonly string[]): void {
    this.members.set(userId, [...departmentIds]);
  }

  async isActive(userId: string): Promise<boolean> {
    return this.members.has(userId) && !this.inactive.has(userId);
  }

  async findLogin(account: string): Promise<string | undefined> {
    const value = account.trim();
    if (!value) return undefined;
    return this.logins.get(`job:${value.toLowerCase()}`) ?? this.logins.get(`mobile:${normalizeMobile(value)}`);
  }

  async nameOf(userId: string): Promise<string | undefined> {
    return this.names.get(userId);
  }

  async departmentNameOf(departmentId: string): Promise<string | undefined> {
    return this.departmentNames.get(departmentId);
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
