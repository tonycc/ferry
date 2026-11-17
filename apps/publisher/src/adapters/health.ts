import { request } from "node:http";
import type { HealthChecker } from "./types";

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
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 通过统一入口访问应用的健康检查接口,在限定时间内任意一次返回 2xx 即视为健康。
 *
 * 注意:接入登录网关(任务 2.3)后,未登录的请求会被拦下,健康检查请求需要网关放行,
 * 比如由 Ferry 的 /authz 识别只有 Ferry 知道的请求头。
 */
export class HttpHealthChecker implements HealthChecker {
  private readonly gateway: URL;
  private readonly timeoutMs: number;
  private readonly intervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: HttpHealthCheckerOptions) {
    this.gateway = new URL(options.gateway);
    if (this.gateway.protocol !== "http:") throw new Error("健康检查入口目前只支持 http");
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.intervalMs = options.intervalMs ?? 2000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async check(host: string, path: string): Promise<boolean> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const status = await this.get(host, path);
      if (status >= 200 && status < 300) return true;
      if (Date.now() >= deadline) return false;
      await this.sleep(this.intervalMs);
    }
  }

  /** 返回状态码;连不上或超时返回 0 */
  private get(host: string, path: string): Promise<number> {
    return new Promise((resolve) => {
      const req = request(
        {
          hostname: this.gateway.hostname,
          port: this.gateway.port || 80,
          path: path.startsWith("/") ? path : `/${path}`,
          headers: { host },
          timeout: this.requestTimeoutMs,
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(0));
      req.end();
    });
  }
}
