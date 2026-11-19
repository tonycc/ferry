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
}

export interface TokenView {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  revoked: boolean;
}
