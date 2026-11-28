import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { Directory } from "../adapters/types";
import { PAGE_STYLE } from "../api/pages";
import { readCookies } from "../identity";
import type { PublisherService } from "../service";

/**
 * 登录网关:Traefik 在把请求转给员工应用之前,先调用 Ferry 的 /authz(forwardAuth)。
 *
 * 流程(访问者第一次打开某个应用):
 * 1. /authz 发现没有这个应用的凭据 → 302 到 Ferry 的 /auth/app?host=应用域名&next=原路径;
 * 2. Ferry 那边没登录就先去登录页,登录后签发一次性票据 → 302 到 应用域名/__ferry/callback?ticket=...;
 * 3. 这个请求同样先到 /authz:核对票据(只能用一次、60 秒内、绑定用户和域名)→ 在应用域名下设 cookie,302 回原路径;
 * 4. 之后每个请求带着这个 cookie,/authz 按可见范围判定,放行时把访问者身份放进请求头交给应用。
 *
 * 应用拿到的 cookie 只对它自己的域名有效,也只有 /authz 认;Ferry 自己的登录 cookie 不会发给应用。
 */

/** 应用域名下的网关 cookie。名字带前缀,避免和应用自己的 cookie 撞名 */
export const APP_COOKIE = "__ferry_gateway";
/** 保留路径:登录后带着一次性票据跳回应用的地址,不会转给应用 */
export const CALLBACK_PATH = "/__ferry/callback";
/** 交给应用的访问者身份请求头 */
export const IDENTITY_HEADERS = {
  id: "x-ferry-user-id",
  /** 姓名按 UTF-8 百分号编码(请求头只能放 ASCII),应用用 decodeURIComponent 解码 */
  name: "x-ferry-user-name",
  /** 所属部门 ID,逗号分隔 */
  departments: "x-ferry-user-departments",
  /** 所属部门的名称,和上面的 ID 一一对应:每个名称单独百分号编码后用逗号连起来(名称里的逗号会被编码) */
  departmentNames: "x-ferry-user-department-names",
} as const;
/** Ferry 自己的健康检查带的请求头。网关在放行后把它删掉,应用收不到 */
export const HEALTH_HEADER = "x-ferry-health";

export interface GatewayConfig {
  /** 签 cookie、算健康检查口令用的密钥 */
  secret: string;
  /** Ferry 对外地址,如 http://127.0.0.1:8081 */
  ferryUrl: string;
  /** 应用地址的协议 */
  appsScheme: "http" | "https";
  appCookieTtlMs: number;
  ticketTtlMs: number;
  now: () => Date;
  /**
   * 查询用户当前的密码代数(来自 AuthService 内存缓存):
   * 编码进 __ferry_gateway 并在每次 /authz 时比对,改密或重置密码后已签发的应用 cookie 立即失效。
   */
  sessionEpoch?: (userId: string) => Promise<string | undefined>;
}

export interface GatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface Ticket {
  userId: string;
  host: string;
  expiresAt: number;
}

export class Gateway {
  /** 一次性票据(只在内存里:60 秒内用掉,重启丢了就重新跳一次登录)。按签发顺序排列 */
  private readonly tickets = new Map<string, Ticket>();
  /** 每人同时有效的票据上限,超出时丢掉最早的,防止反复请求把内存撑大 */
  static readonly MAX_TICKETS_PER_USER = 20;

  constructor(
    private readonly service: PublisherService,
    private readonly directory: Directory,
    private readonly config: GatewayConfig,
  ) {}

  /** 某个应用的健康检查口令。按域名单独算,一个应用拿到自己的也开不了别的应用 */
  healthToken(host: string): string {
    return healthToken(this.config.secret, host);
  }

  /** Traefik forwardAuth 调用的判定 */
  async authorize(headers: IncomingHttpHeaders): Promise<GatewayResponse> {
    // 伪造的身份请求头:连字符形式由网关在调用 /authz 之前删掉了,还在说明网关没配好;
    // 下划线形式(X_Ferry_User_Id)网关删不掉,而有的框架会把它当成同一个请求头,所以整个请求拒绝
    for (const name of Object.keys(headers)) {
      const normalized = name.toLowerCase().replace(/_/g, "-");
      if (normalized.startsWith("x-ferry-user") || (name.includes("_") && normalized.startsWith("x-ferry-"))) {
        return page(400, "请求里带了不允许的请求头");
      }
    }

    const host = single(headers["x-forwarded-host"])?.toLowerCase().split(":")[0];
    const uri = single(headers["x-forwarded-uri"]) ?? "/";
    const method = single(headers["x-forwarded-method"]) ?? "GET";
    if (!host) return page(400, "缺少请求的域名");
    const app = await this.service.gatewayApp(host);
    if (!app) return page(404, "这个应用不存在或已下线");

    // Ferry 自己的健康检查:只放行 GET 本应用当前活跃/线上版本的健康检查路径
    const health = single(headers[HEALTH_HEADER]);
    if (health) {
      const path = uri.split("?")[0] ?? "/";
      const valid = method === "GET" && sameText(health, this.healthToken(host));
      if (valid && (await this.service.healthcheckPaths(app.name)).includes(path)) {
        return { status: 200, headers: {}, body: "" };
      }
      return page(403, "健康检查口令不对");
    }

    if (app.disabled !== undefined) return page(403, "这个应用已被管理员停用");

    const url = new URL(uri, "http://x");
    if (url.pathname === CALLBACK_PATH) return this.callback(host, url);

    const userId = await this.readAppCookie(headers, host);
    if (!userId || !(await this.directory.isActive(userId))) return this.toLogin(host, uri);

    const viewer = { id: userId, departments: await this.directory.departmentsOf(userId) };
    if (!(await this.service.canView(app, viewer))) return page(403, "你没有权限访问这个应用。请联系应用负责人调整可见范围");

    const name = (await this.directory.nameOf(userId)) ?? userId;
    const departmentNames = await Promise.all(
      viewer.departments.map(async (id) => (await this.directory.departmentNameOf(id)) ?? id),
    );
    return {
      status: 200,
      headers: {
        [IDENTITY_HEADERS.id]: userId,
        [IDENTITY_HEADERS.name]: encodeURIComponent(name),
        [IDENTITY_HEADERS.departments]: viewer.departments.join(","),
        [IDENTITY_HEADERS.departmentNames]: departmentNames.map(encodeURIComponent).join(","),
      },
      body: "",
    };
  }

  /** Ferry 这边:已登录的人要去某个应用,签一次性票据跳回去。host 必须是在线的应用,防止被当成跳转器 */
  async issueTicket(userId: string, host: string, next: string): Promise<GatewayResponse> {
    const normalizedHost = host.toLowerCase();
    const safeNext = safePath(next);
    const app = await this.service.gatewayApp(normalizedHost);
    if (!app || app.disabled !== undefined) return page(404, "这个应用不存在或已下线");
    if (this.config.sessionEpoch && !(await this.config.sessionEpoch(userId))) {
      // 不能跳回 /auth/app 自己(会与有效 ferry_session 形成无限重定向死循环),直接跳 Ferry 登录页重登
      const back = `/auth/app?host=${encodeURIComponent(normalizedHost)}&next=${encodeURIComponent(safeNext)}`;
      return redirect(new URL(`/login?next=${encodeURIComponent(back)}`, this.config.ferryUrl).toString());
    }
    this.sweep();
    const mine = [...this.tickets].filter(([, t]) => t.userId === userId);
    for (const [id] of mine.slice(0, Math.max(0, mine.length - Gateway.MAX_TICKETS_PER_USER + 1))) this.tickets.delete(id);
    const ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, {
      userId,
      host: normalizedHost,
      expiresAt: this.config.now().getTime() + this.config.ticketTtlMs,
    });
    const target = `${this.config.appsScheme}://${normalizedHost}${CALLBACK_PATH}?ticket=${ticket}&next=${encodeURIComponent(safeNext)}`;
    return redirect(target);
  }

  private async callback(host: string, url: URL): Promise<GatewayResponse> {
    this.sweep();
    const ticketId = url.searchParams.get("ticket") ?? "";
    const ticket = this.tickets.get(ticketId);
    this.tickets.delete(ticketId);
    const now = this.config.now().getTime();
    const nextPath = safePath(url.searchParams.get("next") ?? "/");
    if (!ticket || ticket.host !== host || ticket.expiresAt < now) {
      return this.toLogin(host, nextPath);
    }
    let cookieEpoch: string | undefined;
    if (this.config.sessionEpoch) {
      const rawEpoch = await this.config.sessionEpoch(ticket.userId);
      if (!rawEpoch) return this.toLogin(host, nextPath);
      cookieEpoch = this.deriveCookieEpoch(host, ticket.userId, rawEpoch);
    }
    const expiresAt = now + this.config.appCookieTtlMs;
    const value = this.signCookie(ticket.userId, host, expiresAt, cookieEpoch);
    const cookie = [
      `${APP_COOKIE}=${value}`,
      "HttpOnly",
      "SameSite=Lax",
      "Path=/",
      `Max-Age=${Math.floor(this.config.appCookieTtlMs / 1000)}`,
      ...(this.config.appsScheme === "https" ? ["Secure"] : []),
    ].join("; ");
    // 必须给完整地址:Traefik 会把 /authz 返回的相对地址按 /authz 自己的地址补全,跳到错的地方
    const next = `${this.config.appsScheme}://${host}${nextPath}`;
    return { status: 302, headers: { location: next, "set-cookie": cookie }, body: "" };
  }

  private toLogin(host: string, uri: string): GatewayResponse {
    const target = new URL("/auth/app", this.config.ferryUrl);
    target.searchParams.set("host", host);
    target.searchParams.set("next", safePath(uri));
    return redirect(target.toString());
  }

  /** 按(网关密钥, 应用域名, 用户, 密码代数)派生的伪随机标识:对员工应用后端不泄露密码哈希指纹且不同应用间不可跨站关联 */
  private deriveCookieEpoch(host: string, userId: string, rawEpoch: string): string {
    return this.hmac(`epoch:${host}:${userId}:${rawEpoch}`).slice(0, 16);
  }

  private signCookie(userId: string, host: string, expiresAt: number, epoch?: string): string {
    const payload = Buffer.from(
      JSON.stringify({ u: userId, h: host, e: expiresAt, ...(epoch ? { v: epoch } : {}) }),
    ).toString("base64url");
    return `${payload}.${this.hmac(`cookie:${payload}`)}`;
  }

  /**
   * 网关 cookie 里的用户。同名 cookie 可能有多个(别的应用往上级域名塞的,或改密前残留的旧 cookie),逐个检查,
   * 任意一个签名对、没过期、属于这个域名且密码代数匹配就算数;都不行返回 undefined
   */
  private async readAppCookie(headers: IncomingHttpHeaders, host: string): Promise<string | undefined> {
    for (const raw of readCookies(headers, APP_COOKIE)) {
      const verified = this.verifyAppCookie(raw, host);
      if (!verified) continue;
      if (this.config.sessionEpoch) {
        const rawEpoch = await this.config.sessionEpoch(verified.userId);
        if (!rawEpoch || !verified.epoch) continue;
        if (!sameText(verified.epoch, this.deriveCookieEpoch(host, verified.userId, rawEpoch))) continue;
      }
      return verified.userId;
    }
    return undefined;
  }

  private verifyAppCookie(raw: string, host: string): { userId: string; epoch?: string } | undefined {
    const [payload, signature] = raw.split(".");
    if (!payload || !signature || !sameText(signature, this.hmac(`cookie:${payload}`))) return undefined;
    try {
      const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
        u: string;
        h: string;
        e: number;
        v?: unknown;
      };
      if (data.h !== host || data.e <= this.config.now().getTime() || typeof data.u !== "string") return undefined;
      if (data.v !== undefined && typeof data.v !== "string") return undefined;
      return { userId: data.u, epoch: data.v };
    } catch {
      return undefined;
    }
  }

  private hmac(value: string): string {
    return createHmac("sha256", this.config.secret).update(value).digest("base64url");
  }

  /** 当前有效的票据数(测试用) */
  get pendingTickets(): number {
    return this.tickets.size;
  }

  private sweep(): void {
    const now = this.config.now().getTime();
    for (const [id, ticket] of this.tickets) if (ticket.expiresAt < now) this.tickets.delete(id);
  }
}

/** 健康检查口令:HMAC(密钥, 域名)。单独导出,健康检查不用等网关对象创建好就能算 */
export function healthToken(secret: string, host: string): string {
  return createHmac("sha256", secret).update(`health:${host.toLowerCase()}`).digest("base64url");
}

/**
 * 只允许站内路径:以单个 / 开头,不能是 //host 或 /\host 这类会被浏览器当成别的网站的写法。
 * 不合格的一律回到首页。
 */
export function safePath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || /[\r\n]/.test(value)) return "/";
  return value;
}

function redirect(location: string): GatewayResponse {
  return { status: 302, headers: { location }, body: "" };
}

/** 网关的报错页(无法访问 / 出错了),Ferry 自己的兜底路由收到不认识的应用域名时也用它 */
export function errorPage(status: number, message: string): GatewayResponse {
  return page(status, message);
}

function page(status: number, message: string): GatewayResponse {
  const title = status === 403 ? "无法访问" : "出错了";
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Ferry</title><style>${PAGE_STYLE}</style></head>
<body><h1>${title}</h1><p>${escapeHtml(message)}</p></body></html>`;
  return { status, headers: { "content-type": "text/html; charset=utf-8" }, body: html };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
