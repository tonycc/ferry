/**
 * 组织架构快照:从数据源(一期是组织架构文件)完整取一次得到的部门树和人员。
 * ID 都带平台前缀,如 dingtalk:123。
 */
export interface OrgDepartment {
  id: string;
  /** 上级部门;根部门为 null */
  parentId: string | null;
  name: string;
}

export interface OrgUser {
  id: string;
  name: string;
  /** 工号,登录时用。可选 */
  jobNumber?: string;
  /** 手机号,登录时用。可选;比较前用 normalizeMobile 规范化 */
  mobile?: string;
  /** false 表示已离职。离职的人不能登录(任务 2.2),但保留最后所属的部门,见 mergeDeparted */
  active: boolean;
  departmentIds: string[];
}

export interface OrgSnapshot {
  departments: OrgDepartment[];
  users: OrgUser[];
}

/** 组织架构的数据来源:每次返回完整快照 */
export interface OrgSource {
  fetch(): Promise<OrgSnapshot>;
}

const PREFIXED = /^[a-z]+:.+$/;

/** 手机号规范化:只留数字,去掉中国区号 86 */
export function normalizeMobile(mobile: string): string {
  const digits = mobile.replace(/\D/g, "");
  return digits.length === 13 && digits.startsWith("86") ? digits.slice(2) : digits;
}

/** 登录时输入的账号(工号或手机号)规范化后的形式,用于查找本人 */
export function loginKeys(user: OrgUser): string[] {
  const keys: string[] = [];
  if (user.jobNumber?.trim()) keys.push(`job:${user.jobNumber.trim().toLowerCase()}`);
  if (user.mobile?.trim()) keys.push(`mobile:${normalizeMobile(user.mobile)}`);
  return keys;
}

/**
 * 应用快照前的检查。数据源出问题时(文件被截断、接口权限不够只返回了一部分),
 * 直接整体替换会让部门可见的应用一下子全都无法访问,所以有任何问题就整份拒绝,保留旧数据。
 * 返回问题列表,为空表示可以应用。
 */
export function validateSnapshot(next: OrgSnapshot, previous?: OrgSnapshot): string[] {
  const problems: string[] = [];
  const departments = new Map(next.departments.map((d) => [d.id, d]));

  if (departments.size !== next.departments.length) problems.push("部门 ID 有重复");
  if (new Set(next.users.map((u) => u.id)).size !== next.users.length) problems.push("人员 ID 有重复");
  for (const id of [...departments.keys(), ...next.users.map((u) => u.id)]) {
    if (!PREFIXED.test(id)) {
      problems.push(`ID 缺少平台前缀: ${id}`);
      break;
    }
  }

  const roots = next.departments.filter((d) => d.parentId === null);
  if (roots.length === 0) problems.push("没有根部门");
  for (const d of next.departments) {
    if (d.parentId !== null && !departments.has(d.parentId)) {
      problems.push(`部门 ${d.id} 的上级部门 ${d.parentId} 不存在`);
      break;
    }
  }
  if (hasCycle(departments)) problems.push("部门的上下级关系有环");

  const active = next.users.filter((u) => u.active);
  if (active.length === 0) problems.push("没有在职人员");
  for (const u of next.users) {
    const missing = u.departmentIds.find((id) => !departments.has(id));
    if (missing) {
      problems.push(`人员 ${u.id} 所属的部门 ${missing} 不存在`);
      break;
    }
  }

  // 两个在职的人工号或手机号相同时,登录时会认错人
  const owners = new Map<string, string>();
  for (const u of active) {
    for (const key of loginKeys(u)) {
      if (owners.has(key)) {
        problems.push(`在职人员 ${owners.get(key)} 和 ${u.id} 的${key.startsWith("job:") ? "工号" : "手机号"}相同`);
        break;
      }
      owners.set(key, u.id);
    }
  }

  if (previous) {
    const before = previous.users.filter((u) => u.active).length;
    const drop = before - active.length;
    // 在职人数一次减少超过 20% 且超过 10 人,更可能是数据源出了问题而不是真的有这么多人离职
    if (drop > 10 && drop > before * 0.2) problems.push(`在职人数从 ${before} 降到 ${active.length},减少过多`);
  }
  return problems;
}

function hasCycle(departments: Map<string, OrgDepartment>): boolean {
  for (const start of departments.keys()) {
    const seen = new Set<string>();
    let current: string | null | undefined = start;
    while (current) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = departments.get(current)?.parentId;
    }
  }
  return false;
}

/**
 * 处理离职:上一份里在职、新快照里不在或已标记离职的人,记为离职并保留上一份里的所属部门。
 *
 * 保留部门是为了不让离职者负责的应用一下子变成“只有自己可见”:那些应用要由管理员停用或转交,
 * 在那之前同事照常访问。离职的人自己不能再登录(任务 2.2)。
 */
export function mergeDeparted(next: OrgSnapshot, previous?: OrgSnapshot): { snapshot: OrgSnapshot; departed: number } {
  if (!previous) return { snapshot: next, departed: 0 };
  const departments = new Set(next.departments.map((d) => d.id));
  const nextUsers = new Map(next.users.map((u) => [u.id, u]));
  const users = [...next.users];
  let departed = 0;

  for (const old of previous.users) {
    const current = nextUsers.get(old.id);
    // 部门被删掉的,不再保留
    const keptDepartments = old.departmentIds.filter((id) => departments.has(id));
    if (!current) {
      users.push({ ...old, active: false, departmentIds: keptDepartments });
      if (old.active) departed++;
    } else if (!current.active && old.active) {
      departed++;
      if (current.departmentIds.length === 0) {
        users[users.indexOf(current)] = { ...current, departmentIds: keptDepartments };
      }
    }
  }
  return { snapshot: { departments: next.departments, users }, departed };
}
