import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { UserError } from "../errors";
import { SETUP_COOKIE, type SetupService } from "../setup/service";

export interface SetupRouteOptions {
  service: SetupService;
  /** 现在是否已完成初始化。完成后向导的接口一律 404 */
  initialized: () => boolean;
}

const codeBody = z.object({ code: z.string().max(100) });

/** 未初始化时还能访问的路由(按 Fastify 匹配到的路由模式判断,不看原始地址,免得 /api/setup/../ 之类绕过) */
function allowedBeforeSetup(route: string | undefined): boolean {
  return route === "/healthz" || route === "/setup" || (route?.startsWith("/api/setup/") ?? false);
}

function isSetupRoute(route: string | undefined): boolean {
  return route === "/setup" || (route?.startsWith("/api/setup/") ?? false);
}

/**
 * 未初始化模式(docs/setup-wizard.md):只开放设置向导和 /healthz。
 * 登录、控制台、MCP、上传、登录网关 /authz 都返回“还没完成初始化”;初始化完成后向导的接口返回 404。
 * 要在注册其他路由之前调用,钩子才会作用到全部路由。
 */
export function registerSetupGate(app: FastifyInstance, options: SetupRouteOptions): void {
  app.addHook("onRequest", async (req, reply) => {
    const route = req.routeOptions.url;
    if (options.initialized()) {
      if (isSetupRoute(route)) return reply.status(404).send({ error: "not_found", message: "Ferry 已经完成初始化" });
      return;
    }
    if (allowedBeforeSetup(route)) return;
    return reply
      .status(503)
      .send({ error: "not_initialized", message: "Ferry 还没有完成初始化,请管理员先用设置向导完成初始化" });
  });
}

export function registerSetupRoutes(app: FastifyInstance, options: SetupRouteOptions): void {
  const { service } = options;

  app.get("/api/setup/status", async (req) => ({
    initialized: options.initialized(),
    session: await service.hasSession(req.headers),
  }));

  app.post("/api/setup/code", async (req, reply) => {
    requireSameHostOrigin(req);
    const { code } = codeBody.parse(req.body);
    const { token } = await service.verifyCode(code);
    const cookie = [
      `${SETUP_COOKIE}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${service.sessionMaxAgeSeconds}`,
      ...(isHttps(req) ? ["Secure"] : []),
    ].join("; ");
    return reply.header("set-cookie", cookie).send({ ok: true });
  });
}

/**
 * 向导的修改请求只接受来自向导页面自己的请求。向导会用服务器 IP 和正式域名两种地址打开,
 * 不能用按 PUBLIC_URL 算出的固定来源列表,改为要求 Origin 和请求的 Host 一致(同源)。
 */
function requireSameHostOrigin(req: FastifyRequest): void {
  const origin = req.headers.origin;
  let host: string | undefined;
  try {
    host = origin ? new URL(origin).host : undefined;
  } catch {
    host = undefined;
  }
  if (!host || host !== req.headers.host) {
    throw new UserError("forbidden", "请求来源不对,只能在设置向导页面上操作");
  }
}

/** 经 Traefik 转过来时看它设置的 X-Forwarded-Proto(Traefik 会覆盖客户端自己带的) */
function isHttps(req: FastifyRequest): boolean {
  return req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
}
