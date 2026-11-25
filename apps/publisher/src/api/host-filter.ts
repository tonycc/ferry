import type { FastifyInstance } from "fastify";
import { errorPage } from "../gateway/gateway";

export interface HostFilterOptions {
  /** 是否已经完成初始化:未初始化时由设置向导的拦截处理,这里不管 */
  initialized: () => boolean;
  /** Ferry 对外的地址(PUBLIC_URL 或设置向导写入的);没有时(本机开发)不按域名过滤 */
  publicUrl?: string;
  /** agent 上传用的地址(AGENT_URL),和 publicUrl 不同时也放行它的域名 */
  agentUrl?: string;
  /** 应用的上级域名:这下面没有被任何应用认领的名字,返回“应用不存在” */
  appsDomain: string;
  /** 应用地址用的协议(APPS_URL_SCHEME):应用只开了 http 时,有人用 https 打开会落到这里 */
  appsScheme?: "http" | "https";
  /** 应用域名下的名字是不是一个在线的应用(没有时一律当作不存在) */
  appExists?: (hostname: string) => Promise<boolean>;
}

/** 不按域名过滤的路径:Traefik 调 /authz 时 Host 是 Ferry 的内部地址;健康检查可能用任何地址 */
const ANY_HOST_ROUTES = new Set(["/authz", "/healthz"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Ferry 在 Traefik 上是兜底路由(docs/setup-wizard.md“Ferry 自己的路由”):没有被员工应用认领的域名和服务器 IP 都会到这里。
 * 完成初始化后按请求的域名分流:
 * - Ferry 自己的域名(和 agent 上传用的域名)照常服务;用 https 时,http 的请求跳到 https;
 * - 应用域名下的应用:协议和应用地址的不一样(只开了 http 的应用被用 https 打开)时跳到应用地址;
 *   应用在但路由还没生效时说“暂时打不开”;没有这个应用时返回“应用不存在”页;
 * - 其他域名(包括服务器 IP):404。
 * 本机地址、/authz、/healthz 不过滤。要在其他路由之前注册
 */
export function registerHostFilter(app: FastifyInstance, options: HostFilterOptions): void {
  if (!options.publicUrl) return;
  const publicUrl = new URL(options.publicUrl);
  const allowed = new Set([publicUrl.host.toLowerCase(), publicUrl.hostname.toLowerCase()]);
  if (options.agentUrl) {
    const agent = new URL(options.agentUrl);
    allowed.add(agent.host.toLowerCase()).add(agent.hostname.toLowerCase());
  }
  const appsSuffix = `.${options.appsDomain.toLowerCase()}`;
  const redirectToHttps = publicUrl.protocol === "https:";

  app.addHook("onRequest", async (req, reply) => {
    if (!options.initialized()) return;
    if (ANY_HOST_ROUTES.has(req.routeOptions.url ?? "")) return;
    const host = (req.headers.host ?? "").toLowerCase();
    const hostname = host.replace(/:\d+$/, "");
    if (LOOPBACK.has(hostname)) return;
    if (allowed.has(host) || allowed.has(hostname)) {
      // 经 Traefik 的 http 入口进来的(Traefik 会设置 X-Forwarded-Proto):跳到 https,308 保留请求方法
      if (redirectToHttps && req.headers["x-forwarded-proto"] === "http" && hostname === publicUrl.hostname.toLowerCase()) {
        return reply.redirect(`https://${publicUrl.host}${req.url}`, 308);
      }
      return;
    }
    if (hostname.endsWith(appsSuffix)) {
      let page = errorPage(404, "这个应用不存在或已下线");
      if (await options.appExists?.(hostname)) {
        const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
        if (options.appsScheme && proto !== options.appsScheme) {
          // 302:管理员以后可能把应用换成 https,浏览器不要记住这次跳转
          return reply.redirect(`${options.appsScheme}://${hostname}${req.url}`, 302);
        }
        page = errorPage(503, "这个应用暂时打不开,请稍后再试");
      }
      return reply.status(page.status).headers(page.headers).send(page.body);
    }
    return reply.status(404).send({ error: "not_found", message: "这个地址不是 Ferry" });
  });
}
