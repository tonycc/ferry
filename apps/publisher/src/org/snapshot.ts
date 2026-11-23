/**
 * 组织架构:部门树和人员。一期由平台管理员在控制台维护(存在数据库里),见 org/service.ts。
 * ID 都带来源前缀:控制台新建的是 local:,早期从组织架构文件导入的是 dingtalk:,以后接入钉钉同步时沿用 dingtalk:。
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
  /** false 表示已离职。离职的人不能登录,但保留最后所属的部门:他负责的应用照常按部门判定访问,直到管理员处理 */
  active: boolean;
  departmentIds: string[];
  /** 在控制台设为平台管理员(.env 的 ADMIN_USERS 里的人不论这里是什么都是管理员) */
  isAdmin?: boolean;
}

export interface OrgSnapshot {
  departments: OrgDepartment[];
  users: OrgUser[];
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
 * 写回数据库前对整份组织架构做的结构检查(兜底:控制台的每个操作自己会先给出更具体的提示)。
 * 返回问题列表,为空表示可以保存。
 */
export function validateSnapshot(next: OrgSnapshot): string[] {
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
