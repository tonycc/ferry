import type { IncomingHttpHeaders } from "node:http";
import type { Directory } from "./adapters/types";
import type { AuthService } from "./auth/service";
import { UserError } from "./errors";

export interface User {
  /** 带平台前缀,如 dingtalk:123 */
  id: string;
  /** 当前所属的全部部门,ID 带平台前缀,来自组织架构 */
  departments: string[];
  /** 平台管理员:可以查看全部应用,停用和恢复任意应用 */
  isAdmin: boolean;
}

/**
 * 请求从哪个入口进来。每个入口只认一种凭据:
 * - mcp:只认个人令牌(agent 用)。
 * - api:个人令牌,或浏览器的登录 cookie;用 cookie 做修改操作时,还要求请求来自 Ferry 自己的页面。
 * 访问员工应用(登录网关)不走这里,见 gateway/gateway.ts。
 */
export type Channel = "api" | "mcp";

export interface RequestLike {
  method: string;
  headers: IncomingHttpHeaders;
}

export type IdentityResolver = (req: RequestLike, channel: Channel) => Promise<User>;

export const SESSION_COOKIE = "ferry_session";

export interface IdentityOptions {
  /** 没有时只能用开发用的请求头 */
  auth?: AuthService;
  directory: Directory;
  adminIds: ReadonlySet<string>;
  /** true 时,没有带任何凭据的请求可以用 x-ferry-user 请求头自称是谁。只能用于本地开发 */
  devAuth: boolean;
  /** 用 cookie 做修改操作时允许的来源(Ferry 自己的页面) */
  allowedOrigins: ReadonlySet<string>;
}

/**
 * 解析请求者是谁。带了凭据(令牌或 cookie)但无效时直接拒绝,不会再退回去看开发用的请求头,
 * 否则带一个乱写的令牌加一个伪造的请求头就能冒充别人。
 */
export function createIdentity(options: IdentityOptions): IdentityResolver {
  const { auth, directory, adminIds, devAuth, allowedOrigins } = options;
  const user = async (id: string): Promise<User> => ({
    id,
    departments: await directory.departmentsOf(id),
    isAdmin: adminIds.has(id),
  });
  const devUser = async (headers: IncomingHttpHeaders): Promise<User | undefined> => {
    const id = devAuth ? single(headers["x-ferry-user"]) : undefined;
    return id ? user(id) : undefined;
  };
  const unauthenticated = (message = "需要先登录") => new UserError("unauthenticated", message);

  return async (req, channel) => {
    const authorization = single(req.headers.authorization);
    if (authorization) {
      const token = authorization.match(/^Bearer\s+(\S+)$/i)?.[1];
      const userId = token && auth ? await auth.tokenUser(token) : undefined;
      if (!userId) throw unauthenticated("个人令牌无效、已作废,或本人已离职");
      return user(userId);
    }

    if (channel === "api") {
      if (readCookies(req.headers, SESSION_COOKIE).length > 0) {
        const userId = auth ? await sessionUserFrom(req.headers, auth) : undefined;
        if (!userId) throw unauthenticated("登录已过期,请重新登录");
        requireSameOrigin(req, allowedOrigins);
        return user(userId);
      }
    }

    const dev = await devUser(req.headers);
    if (dev) return dev;
    throw unauthenticated(channel === "mcp" ? "需要个人令牌:在 Ferry 网页上登录后生成,配进 agent 的 Authorization 请求头" : "需要先登录");
  };
}

/**
 * 浏览器带着 cookie 发来的修改请求,必须来自 Ferry 自己的页面。
 * 员工应用和 Ferry 在同一个站点下,浏览器会给它们发起的请求带上 Ferry 的 cookie,
 * 不检查的话,任何应用里放一个表单就能以访问者的身份下线他的应用。
 */
export function requireSameOrigin(req: RequestLike, allowedOrigins: ReadonlySet<string>): void {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = single(req.headers.origin);
  if (!origin || !allowedOrigins.has(origin)) {
    throw new UserError("forbidden", "请求来源不对,只能在 Ferry 自己的页面上操作");
  }
}

/**
 * 同名 cookie 的全部值。同一站点下的员工应用可以给上级域名设同名 cookie(cookie tossing),
 * 浏览器会把它和真正的那个一起发来、顺序不定,所以调用方要逐个检查,不能只看第一个。
 * 解码失败的值跳过(当作没有),不让格式错误的 cookie 变成 500。
 */
export function readCookies(headers: IncomingHttpHeaders, name: string): string[] {
  const header = single(headers.cookie);
  if (!header) return [];
  const values: string[] = [];
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0 || part.slice(0, index).trim() !== name) continue;
    try {
      values.push(decodeURIComponent(part.slice(index + 1).trim()));
    } catch {
      // 不是合法的百分号编码,跳过
    }
  }
  return values;
}

/** 某人的登录会话:同名 cookie 里任意一个有效即可 */
export async function sessionUserFrom(headers: IncomingHttpHeaders, auth: AuthService): Promise<string | undefined> {
  for (const value of readCookies(headers, SESSION_COOKIE)) {
    const userId = await auth.sessionUser(value);
    if (userId) return userId;
  }
  return undefined;
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
