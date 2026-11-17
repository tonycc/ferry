import type { IncomingHttpHeaders } from "node:http";
import type { MemoryDirectory } from "./adapters/directory";
import { UserError } from "./errors";

export interface User {
  /** 带平台前缀,如 dingtalk:123 */
  id: string;
  /** 当前所属的全部部门,ID 带平台前缀 */
  departments: string[];
  /** 平台管理员:可以查看全部应用,停用和恢复任意应用 */
  isAdmin: boolean;
}

export type IdentityResolver = (headers: IncomingHttpHeaders) => User;

/**
 * 本地开发用的身份解析:直接相信请求头。
 * x-ferry-department 可以用逗号分隔多个部门;解析出的所属部门同时写入组织架构,
 * 这样别人访问这个用户的应用时也能按部门判断。
 * TODO: 换成钉钉、企业微信登录,所属部门从同步来的组织架构查询。
 */
export function createDevIdentity(adminIds: ReadonlySet<string>, directory: MemoryDirectory): IdentityResolver {
  return (headers) => {
    const id = single(headers["x-ferry-user"]);
    if (!id) throw new UserError("unauthenticated", "缺少身份信息,请先登录");
    const departments = (single(headers["x-ferry-department"]) ?? "default")
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    directory.setUserDepartments(id, departments);
    return { id, departments, isAdmin: adminIds.has(id) };
  };
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
