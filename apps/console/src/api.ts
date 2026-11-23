/** 调 Ferry 的接口。登录 cookie 由浏览器自动带上;未登录时跳到登录页,登录后回到当前页面 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw new ApiError("请先登录", 401);
  }
  const data = (await res.json().catch(() => ({}))) as { message?: string };
  if (!res.ok) throw new ApiError(data.message ?? `请求失败(${res.status})`, res.status);
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
};

export type Visibility = "self" | "department" | "company";
export type ReleaseState =
  | "PENDING"
  | "VALIDATING"
  | "PROVISIONING"
  | "BUILDING"
  | "MIGRATING"
  | "VERIFYING"
  | "LIVE"
  | "FAILED_FIXABLE"
  | "ROLLED_BACK"
  | "FAILED";

export interface Me {
  id: string;
  name: string;
  isAdmin: boolean;
}

export interface AppView {
  name: string;
  url: string;
  visibility: Visibility;
  live: boolean;
  disabled: boolean;
  unpublished: boolean;
  disabledReason?: string;
}

export interface ReleaseSummary {
  releaseId: string;
  kind: "publish" | "rollback";
  state: ReleaseState;
  done: boolean;
  version: string;
  live: boolean;
  createdAt: string;
  finishedAt?: string;
  error?: { stage: ReleaseState; type: string; message: string; hint?: string };
}

export interface AppDetail extends AppView {
  visibilityPinned: boolean;
  createdAt: string;
  port?: number;
  healthcheck?: string;
  database?: "none" | "postgres";
  releases: ReleaseSummary[];
}

export interface ReleaseView {
  releaseId: string;
  state: ReleaseState;
  done: boolean;
  error?: { stage: ReleaseState; type: string; message: string; logs?: string; hint?: string };
}

export interface AdminAppView extends AppView {
  ownerId: string;
  ownerName: string;
  departmentNames: string[];
  createdAt: string;
  unpublishedAt?: string;
}

export type AuditAction =
  | "app.create"
  | "app.publish"
  | "app.rollback"
  | "release.finish"
  | "app.unpublish"
  | "app.visibility"
  | "secret.set"
  | "secret.delete"
  | "app.disable"
  | "app.enable"
  | "app.delete"
  | "token.create"
  | "token.revoke"
  | "password.reset"
  | "password.change"
  | "user.create"
  | "user.update"
  | "user.deactivate"
  | "user.reactivate"
  | "user.admin"
  | "department.create"
  | "department.update"
  | "department.delete";

/** 一条审计记录 */
export interface AuditEvent {
  id: number;
  at: string;
  /** 为空表示 Ferry 自己 */
  actorId?: string;
  /** 操作当时的姓名 */
  actorName?: string;
  action: AuditAction;
  appName?: string;
  /** 应用当时的负责人 */
  appOwnerId?: string;
  appOwnerName?: string;
  detail: Record<string, unknown>;
}

export interface AuditPage {
  events: AuditEvent[];
  nextBefore?: number;
}

/** 管理员人员页上的一个人。password:none 没设密码,initial 初始密码还没改,set 已设置 */
export interface AdminUser {
  id: string;
  name: string;
  mobile: string | null;
  jobNumber: string | null;
  departmentIds: string[];
  /** false 表示已离职 */
  active: boolean;
  isAdmin: boolean;
  /** 在服务配置 ADMIN_USERS 里指定的管理员,控制台上不能取消 */
  fixedAdmin: boolean;
  password: "none" | "initial" | "set";
}

export interface AdminDepartment {
  id: string;
  /** 最上级部门为 null */
  parentId: string | null;
  name: string;
  /** 在职人数(只算直接属于这个部门的人) */
  memberCount: number;
}

export interface AdminOrg {
  departments: AdminDepartment[];
  users: AdminUser[];
}

/** 应用密钥:只有名称和更新时间,值保存后不再返回 */
export interface SecretView {
  name: string;
  updatedAt: string;
}

export interface TokenView {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  revoked: boolean;
}
