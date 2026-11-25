import { type IncomingMessage, request } from "node:http";
import { request as httpsRequest } from "node:https";
import type { HealthChecker, HealthResult } from "./types";

export interface HttpHealthCheckerOptions {
  /**
   * 应用的统一入口(Traefik),如 http://127.0.0.1:80。按应用域名设置 Host 请求头访问,
   * 所以 Ferry 所在的机器不需要能解析应用域名,也顺带验证了域名路由是通的。
   */
  gateway: string;
  /** 部署完成后容器还要几秒才能接收请求(这期间返回 502),在这段时间内反复检查 */
  timeoutMs?: number;
  intervalMs?: number;
  /** 单次请求的超时 */
  requestTimeoutMs?: number;
  /** 每个应用的健康检查额外带的请求头(登录网关的健康检查口令) */
  extraHeaders?: (host: string) => Record<string, string>;
  /** https 入口的端口(同一台机器),默认 443;测试用 */
  tlsPort?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 通过统一入口访问应用的健康检查接口,在限定时间内任意一次返回 2xx 即视为健康;
 * 到时还不健康时返回最后一次的状态码。
 *
 * 登录网关会拦下未登录的请求,所以健康检查带上按域名计算的口令(extraHeaders),
 * 由 /authz 识别后放行;网关放行后会删掉这个请求头,应用收不到。
 */
export class HttpHealthChecker implements HealthChecker {
  private readonly gateway: URL;
  private readonly timeoutMs: number;
  private readonly intervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly extraHeaders: (host: string) => Record<string, string>;
  private readonly tlsPort: number | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: HttpHealthCheckerOptions) {
    this.gateway = new URL(options.gateway);
    if (this.gateway.protocol !== "http:") throw new Error("健康检查入口目前只支持 http");
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.intervalMs = options.intervalMs ?? 2000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.extraHeaders = options.extraHeaders ?? (() => ({}));
    this.tlsPort = options.tlsPort;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async check(host: string, path: string): Promise<HealthResult> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const status = await this.get(host, path);
      if (status >= 200 && status < 300) return { ok: true };
      if (Date.now() >= deadline) return { ok: false, status };
      await this.sleep(this.intervalMs);
    }
  }

  /**
   * 返回状态码;连不上或超时返回 0。
   * 应用用 https 时,Dokploy 给 http 入口的路由只挂“跳到 https”,登录网关和应用都在 https 入口上:
   * 跳到同一个域名的 https 地址时,改走 https 入口再请求一次(同样带口令)
   */
  private async get(host: string, path: string): Promise<number> {
    const options = { headers: this.extraHeaders(host), timeoutMs: this.requestTimeoutMs, tlsPort: this.tlsPort };
    const res = await probeGateway(this.gateway, host, path, options);
    if (isHttpsRedirect(res, host)) return (await probeGateway(this.gateway, host, path, { ...options, tls: true })).status;
    return res.status;
  }
}

/** 跳到同一个域名的 https 地址(Dokploy 给 https 应用的 http 路由只做这个) */
export function isHttpsRedirect(res: { status: number; location?: string }, host: string): boolean {
  return res.status >= 300 && res.status < 400 && (res.location?.toLowerCase().startsWith(`https://${host.toLowerCase()}/`) ?? false);
}

/**
 * 经统一入口(Traefik 的 http 入口)按域名请求一次,不跟随跳转。返回状态码和 Location;连不上或超时状态码是 0。
 * 健康检查和设置向导的自检(检查未登录的请求被网关跳到登录页)都用它。
 * tls:改走同一台机器的 https 入口(443),按域名发 SNI。只看状态码和跳转,不发敏感内容,
 * 证书在向导第 3 步已经检查过,这里不再校验(从 Ferry 的容器里也不一定信任公司内部 CA)
 */
export function probeGateway(
  gateway: URL,
  host: string,
  path: string,
  options: { headers?: Record<string, string>; timeoutMs?: number; tls?: boolean; tlsPort?: number } = {},
): Promise<{ status: number; location?: string }> {
  return new Promise((resolve) => {
    const common = {
      hostname: gateway.hostname,
      path: path.startsWith("/") ? path : `/${path}`,
      headers: { ...options.headers, host },
      timeout: options.timeoutMs ?? 5000,
    };
    const send = options.tls
      ? (cb: (res: IncomingMessage) => void) =>
          httpsRequest({ ...common, port: options.tlsPort ?? 443, servername: host, rejectUnauthorized: false }, cb)
      : (cb: (res: IncomingMessage) => void) => request({ ...common, port: gateway.port || 80 }, cb);
    const req = send(
      (res) => {
        res.resume();
        const location = res.headers.location;
        resolve({ status: res.statusCode ?? 0, ...(location ? { location } : {}) });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ status: 0 }));
    req.end();
  });
}
