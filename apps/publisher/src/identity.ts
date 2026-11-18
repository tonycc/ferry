import type { IncomingHttpHeaders } from "node:http";
import type { Directory } from "./adapters/types";
import { UserError } from "./errors";

export interface User {
  /** 带平台前缀,如 dingtalk:123 */
  id: string;
  /** 当前所属的全部部门,ID 带平台前缀,来自组织架构 */
  departments: string[];
  /** 平台管理员:可以查看全部应用,停用和恢复任意应用 */
  isAdmin: boolean;
}

export type IdentityResolver = (headers: IncomingHttpHeaders) => Promise<User>;

/**
 * 本地开发用的身份解析:直接相信 x-ferry-user 请求头里的用户 ID,所属部门从组织架构查。
 * 不在组织架构里的用户没有部门(只能访问自己的应用和全公司可见的应用)。
 * TODO(任务 2.2):换成验证码登录和个人令牌。
 */
export function createDevIdentity(adminIds: ReadonlySet<string>, directory: Directory): IdentityResolver {
  return async (headers) => {
    const id = single(headers["x-ferry-user"]);
    if (!id) throw new UserError("unauthenticated", "缺少身份信息,请先登录");
    return { id, departments: await directory.departmentsOf(id), isAdmin: adminIds.has(id) };
  };
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
