import { randomBytes } from "node:crypto";
import type { MemoryDirectory } from "../adapters/directory";
import type { AuditAction } from "../audit/store";
import type { AuditLog } from "../audit/log";
import { UserError } from "../errors";
import { loginKeys, normalizeMobile, validateSnapshot, type OrgDepartment, type OrgSnapshot, type OrgUser } from "./snapshot";
import { EMPTY_ORG, type OrgStore } from "./store";

/**
 * 人员和部门的管理(一期没有钉钉同步,由平台管理员在控制台维护)。
 *
 * 数据库是唯一的来源。每次修改都在数据库里读出最新的一份、改好、检查、写回(OrgStore.update 串行执行),
 * 再整份换进内存里的组织架构(权限判定读它)。命令行(pnpm set-password 建第一个管理员)是另一个进程,
 * 也走同一条路;Ferry 定时从数据库重新读一次,命令行写入的数据不用重启就能生效。
 *
 * 人员不能删除,只能标记离职:应用、审计日志、令牌都按用户 ID 关联,删掉会留下查不到人的记录。
 */

export interface PersonInput {
  name: string;
  mobile?: string;
  jobNumber?: string;
  departmentIds: string[];
}

export interface DepartmentInput {
  name: string;
  parentId: string | null;
}

/** 管理员页面上看到的组织架构 */
export interface OrgView {
  departments: (OrgDepartment & { memberCount: number })[];
  users: (OrgUser & { isAdmin: boolean; fixedAdmin: boolean })[];
}

export interface OrganizationOptions {
  /** .env 的 ADMIN_USERS:始终是管理员,控制台上不能取消 */
  fixedAdmins: ReadonlySet<string>;
  /**
   * 作废这个人的登录会话、令牌和密码。标记离职后调用;恢复在职前再调用一次(可以重复执行),
   * 万一离职时这一步失败了,恢复后也不会让旧密码、旧令牌又能用
   */
  revokeAccess?: (userId: string) => Promise<void>;
  newId?: (kind: "user" | "department") => string;
}

const MAX_NAME = 40;
const MAX_JOB_NUMBER = 32;

export class Organization {
  private readonly newId: (kind: "user" | "department") => string;
  /** 每次修改后加一:定时重读时如果中途有修改,丢掉读到的旧数据,免得把刚做的修改换回去 */
  private generation = 0;

  constructor(
    private readonly store: OrgStore,
    private readonly directory: MemoryDirectory,
    private readonly audit: AuditLog,
    private readonly options: OrganizationOptions,
  ) {
    this.newId = options.newId ?? ((kind) => `local:${kind === "user" ? "u" : "d"}-${randomBytes(6).toString("hex")}`);
  }

  /** 从数据库读出最新的组织架构换进内存(启动时、定时调用) */
  async reload(): Promise<void> {
    const generation = this.generation;
    const snapshot = (await this.store.load()) ?? EMPTY_ORG;
    if (generation !== this.generation) return;
    this.directory.replace(snapshot);
  }

  async view(): Promise<OrgView> {
    const org = (await this.store.load()) ?? EMPTY_ORG;
    return {
      departments: org.departments.map((d) => ({
        ...d,
        memberCount: org.users.filter((u) => u.active && u.departmentIds.includes(d.id)).length,
      })),
      users: org.users.map((u) => ({
        ...u,
        isAdmin: this.options.fixedAdmins.has(u.id) || !!u.isAdmin,
        fixedAdmin: this.options.fixedAdmins.has(u.id),
      })),
    };
  }

  // ---- 部门 ----

  async createDepartment(actorId: string, input: DepartmentInput): Promise<OrgDepartment> {
    const id = this.newId("department");
    let created!: OrgDepartment;
    await this.change(actorId, (org) => {
      const name = departmentName(input.name);
      const parentId = input.parentId;
      if (parentId === null) throw new UserError("invalid_input", "要选上级部门(整个公司只有一个最上级部门)");
      if (!org.departments.some((d) => d.id === parentId)) throw new UserError("invalid_input", "上级部门不存在");
      uniqueSibling(org, name, parentId);
      created = { id, parentId, name };
      org.departments.push(created);
      return { action: "department.create", detail: { departmentId: id, name, parentId } };
    });
    return created;
  }

  /** 改名或调整上级部门。调整上级会改变“本部门可见”的应用对谁可见 */
  async updateDepartment(actorId: string, id: string, input: DepartmentInput): Promise<void> {
    await this.change(actorId, (org) => {
      const department = findDepartment(org, id);
      const name = departmentName(input.name);
      const detail: Record<string, unknown> = { departmentId: id, name };
      if (department.parentId === null) {
        if (input.parentId !== null) throw new UserError("invalid_input", "最上级部门不能调整到别的部门下面");
      } else {
        const parentId = input.parentId;
        if (parentId === null) throw new UserError("invalid_input", "要选上级部门(整个公司只有一个最上级部门)");
        if (!org.departments.some((d) => d.id === parentId)) throw new UserError("invalid_input", "上级部门不存在");
        if (parentId === id || descendantsOf(org, id).has(parentId)) {
          throw new UserError("invalid_input", "不能把部门调整到它自己或它的下级部门下面");
        }
        if (parentId !== department.parentId) Object.assign(detail, { fromParentId: department.parentId, parentId });
        department.parentId = parentId;
      }
      if (name !== department.name || detail.parentId !== undefined) uniqueSibling(org, name, department.parentId, id);
      if (name !== department.name) detail.fromName = department.name;
      department.name = name;
      return { action: "department.update", detail };
    });
  }

  /** 只能删除没有下级部门、也没有人(包括已离职的人)的部门 */
  async deleteDepartment(actorId: string, id: string): Promise<void> {
    await this.change(actorId, (org) => {
      const department = findDepartment(org, id);
      if (department.parentId === null) throw new UserError("invalid_input", "最上级部门不能删除");
      if (org.departments.some((d) => d.parentId === id)) throw new UserError("invalid_input", "部门下面还有下级部门,先删除或移走它们");
      const members = org.users.filter((u) => u.departmentIds.includes(id));
      if (members.length > 0) {
        const departed = members.filter((u) => !u.active).length;
        throw new UserError(
          "invalid_input",
          `部门里还有 ${members.length} 人${departed ? `(其中 ${departed} 人已离职)` : ""},先把他们调到别的部门`,
        );
      }
      org.departments = org.departments.filter((d) => d.id !== id);
      return { action: "department.delete", detail: { departmentId: id, name: department.name } };
    });
  }

  // ---- 人员 ----

  async createUser(actorId: string | undefined, input: PersonInput, options: { isAdmin?: boolean } = {}): Promise<OrgUser> {
    const id = this.newId("user");
    let created!: OrgUser;
    await this.change(actorId, (org) => {
      created = { id, active: true, ...person(org, input), ...(options.isAdmin ? { isAdmin: true } : {}) };
      uniqueLogin(org, created);
      org.users.push(created);
      return { action: "user.create", detail: { userId: id, name: created.name, ...(options.isAdmin ? { isAdmin: true } : {}) } };
    });
    return created;
  }

  async updateUser(actorId: string, id: string, input: PersonInput): Promise<void> {
    await this.change(actorId, (org) => {
      const user = findUser(org, id);
      const { mobile: _mobile, jobNumber: _jobNumber, ...rest } = user;
      const next: OrgUser = { ...rest, ...person(org, input) };
      if (user.active) uniqueLogin(org, next);
      const fields: string[] = (["name", "mobile", "jobNumber"] as const).filter((f) => (user[f] ?? "") !== (next[f] ?? ""));
      if (user.departmentIds.join() !== next.departmentIds.join()) fields.push("departmentIds");
      org.users[org.users.indexOf(user)] = next;
      return { action: "user.update", detail: { userId: id, name: next.name, fields } };
    });
  }

  /**
   * 标记离职:不能再登录,登录会话、个人令牌和密码作废,控制台设的管理员身份取消;
   * 保留所属部门,他负责的应用照常运行,由管理员停用或删除。
   * ADMIN_USERS 里的人不能在控制台上标记离职(那是保底的管理员)
   */
  async deactivate(actorId: string, id: string): Promise<void> {
    if (actorId === id) throw new UserError("invalid_input", "不能把自己标记为离职");
    if (this.options.fixedAdmins.has(id)) {
      throw new UserError("invalid_input", "这个人是在服务配置(ADMIN_USERS)里指定的管理员,要先从配置里去掉才能标记离职");
    }
    await this.change(actorId, (org) => {
      const user = findUser(org, id);
      if (!user.active) throw new UserError("conflict", `${user.name} 已经是离职状态`);
      user.active = false;
      const wasAdmin = !!user.isAdmin;
      delete user.isAdmin;
      return { action: "user.deactivate", detail: { userId: id, name: user.name, ...(wasAdmin ? { wasAdmin } : {}) } };
    });
    await this.options.revokeAccess?.(id);
  }

  /**
   * 恢复在职(离职标错了,或者人回来了):还是原来的账号和应用,恢复后是普通员工;
   * 密码和令牌已作废,要重新生成初始密码、重新领令牌
   */
  async reactivate(actorId: string, id: string): Promise<void> {
    const current = (await this.store.load())?.users.find((u) => u.id === id);
    if (!current) throw new UserError("not_found", "人员不存在");
    if (current.active) throw new UserError("conflict", `${current.name} 已经是在职状态`);
    // 先确保旧的登录凭据都作废了,再恢复在职(失败时不恢复)
    await this.options.revokeAccess?.(id);
    await this.change(actorId, (org) => {
      const user = findUser(org, id);
      if (user.active) throw new UserError("conflict", `${user.name} 已经是在职状态`);
      user.active = true;
      uniqueLogin(org, user);
      if (user.departmentIds.length === 0) throw new UserError("invalid_input", `${user.name} 没有所属部门,先编辑选好部门再恢复`);
      return { action: "user.reactivate", detail: { userId: id, name: user.name } };
    });
  }

  async setAdmin(actorId: string, id: string, isAdmin: boolean): Promise<void> {
    if (this.options.fixedAdmins.has(id)) {
      throw new UserError("invalid_input", "这个人是在服务配置(ADMIN_USERS)里指定的管理员,要在配置里改");
    }
    if (!isAdmin && actorId === id) throw new UserError("invalid_input", "不能取消自己的管理员身份,请另一位管理员操作");
    await this.change(actorId, (org) => {
      const user = findUser(org, id);
      if (isAdmin && !user.active) throw new UserError("invalid_input", `${user.name} 已离职,不能设为管理员`);
      if (!!user.isAdmin === isAdmin) return undefined;
      if (isAdmin) user.isAdmin = true;
      else delete user.isAdmin;
      return { action: "user.admin", detail: { userId: id, name: user.name, isAdmin } };
    });
  }

  /**
   * 命令行用:建第一个管理员。组织架构还是空的时候先建最上级部门(orgName,默认“公司”);
   * 手机号已经属于某个在职的人时,只把他设为管理员。返回这个人的用户 ID
   */
  async bootstrapAdmin(input: { name: string; mobile: string; orgName?: string }): Promise<{ userId: string; created: boolean }> {
    const userId = this.newId("user");
    const rootId = this.newId("department");
    let result!: { userId: string; created: boolean };
    await this.change(undefined, (org) => {
      const mobile = mobileOf(input.mobile);
      const existing = org.users.find((u) => u.active && u.mobile && normalizeMobile(u.mobile) === mobile);
      if (existing) {
        result = { userId: existing.id, created: false };
        if (existing.isAdmin) return undefined;
        existing.isAdmin = true;
        return { action: "user.admin", detail: { userId: existing.id, name: existing.name, isAdmin: true, via: "cli" } };
      }
      let root = org.departments.find((d) => d.parentId === null);
      if (!root) {
        root = { id: rootId, parentId: null, name: departmentName(input.orgName ?? "公司") };
        org.departments.push(root);
      }
      const user: OrgUser = { id: userId, active: true, isAdmin: true, ...person(org, { name: input.name, mobile, departmentIds: [root.id] }) };
      org.users.push(user);
      result = { userId, created: true };
      return { action: "user.create", detail: { userId, name: user.name, isAdmin: true, via: "cli" } };
    });
    return result;
  }

  /**
   * 修改的公共部分:在数据库里最新的一份上执行 apply,结构检查通过才写回,然后换进内存、记审计日志。
   * apply 返回 undefined 表示没有变化,不写审计
   */
  private async change(
    actorId: string | undefined,
    apply: (org: OrgSnapshot) => { action: AuditAction; detail: Record<string, unknown> } | undefined,
  ): Promise<void> {
    let record: { action: AuditAction; detail: Record<string, unknown> } | undefined;
    const next = await this.store.update((org) => {
      record = apply(org);
      const problems = validateSnapshot(org);
      if (problems.length > 0) throw new UserError("invalid_input", `组织架构检查没通过:${problems[0]}`);
      return org;
    });
    this.generation++;
    this.directory.replace(next);
    if (record) await this.audit.record(actorId, record.action, undefined, record.detail);
  }
}

function departmentName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new UserError("invalid_input", "部门名称不能为空");
  if (name.length > MAX_NAME) throw new UserError("invalid_input", `部门名称最多 ${MAX_NAME} 个字`);
  return name;
}

function uniqueSibling(org: OrgSnapshot, name: string, parentId: string | null, self?: string): void {
  if (org.departments.some((d) => d.id !== self && d.parentId === parentId && d.name === name)) {
    throw new UserError("conflict", `同一个上级部门下已经有叫“${name}”的部门`);
  }
}

function findDepartment(org: OrgSnapshot, id: string): OrgDepartment {
  const department = org.departments.find((d) => d.id === id);
  if (!department) throw new UserError("not_found", "部门不存在");
  return department;
}

function findUser(org: OrgSnapshot, id: string): OrgUser {
  const user = org.users.find((u) => u.id === id);
  if (!user) throw new UserError("not_found", "人员不存在");
  return user;
}

function descendantsOf(org: OrgSnapshot, id: string): Set<string> {
  const result = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const d of org.departments) {
      if (d.parentId === current && !result.has(d.id)) {
        result.add(d.id);
        queue.push(d.id);
      }
    }
  }
  return result;
}

function mobileOf(raw: string): string {
  const mobile = normalizeMobile(raw);
  if (!/^1\d{10}$/.test(mobile)) throw new UserError("invalid_input", "手机号要是 11 位的中国大陆手机号");
  return mobile;
}

/** 检查并规范化姓名、手机号、工号、部门 */
function person(org: OrgSnapshot, input: PersonInput): Pick<OrgUser, "name" | "mobile" | "jobNumber" | "departmentIds"> {
  const name = input.name.trim();
  if (!name) throw new UserError("invalid_input", "姓名不能为空");
  if (name.length > MAX_NAME) throw new UserError("invalid_input", `姓名最多 ${MAX_NAME} 个字`);
  const mobile = input.mobile?.trim() ? mobileOf(input.mobile) : undefined;
  const jobNumber = input.jobNumber?.trim() || undefined;
  if (jobNumber && (jobNumber.length > MAX_JOB_NUMBER || /\s/.test(jobNumber))) {
    throw new UserError("invalid_input", `工号最多 ${MAX_JOB_NUMBER} 个字符,不能有空格`);
  }
  if (!mobile && !jobNumber) throw new UserError("invalid_input", "手机号和工号至少填一个:员工用它们登录");
  const departmentIds = [...new Set(input.departmentIds)];
  if (departmentIds.length === 0) throw new UserError("invalid_input", "至少选一个部门");
  const missing = departmentIds.find((id) => !org.departments.some((d) => d.id === id));
  if (missing) throw new UserError("invalid_input", "选的部门不存在,可能刚被删除了,请刷新页面");
  return { name, departmentIds, ...(mobile ? { mobile } : {}), ...(jobNumber ? { jobNumber } : {}) };
}

/** 在职人员的手机号、工号不能重复,否则登录时会认错人 */
function uniqueLogin(org: OrgSnapshot, user: OrgUser): void {
  const keys = new Set(loginKeys(user));
  for (const other of org.users) {
    if (other.id === user.id || !other.active) continue;
    const clash = loginKeys(other).find((k) => keys.has(k));
    if (clash) {
      throw new UserError("conflict", `${clash.startsWith("job:") ? "工号" : "手机号"}和在职的 ${other.name} 重复`);
    }
  }
}
