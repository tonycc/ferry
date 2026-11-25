import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { UserError } from "../errors";
import { suggestServerIp } from "../setup/domain";
import { SETUP_COOKIE, type SetupService } from "../setup/service";
import type { SetupWizard } from "../setup/wizard";
import { SETUP_PAGE } from "./pages";

export interface SetupRouteOptions {
  service: SetupService;
  /** 现在是否已完成初始化。完成后向导的接口一律 404 */
  initialized: () => boolean;
  /** 第 2 到 4 步。没有时(测试)只有设置码这一步 */
  wizard?: SetupWizard;
  /** 本进程的标识,/api/setup/ping 返回它 */
  instanceId?: string;
}

const codeBody = z.object({ code: z.string().max(100) });
const domainBody = z.object({
  domain: z.string().max(253),
  ferrySub: z.string().max(63),
  appsSub: z.string().max(63),
  serverIp: z.string().max(45),
});
/** PEM 文本;证书链一般几 KB */
const certificateBody = z.object({ certificate: z.string().max(64 * 1024), privateKey: z.string().max(16 * 1024) });
const handoffBody = z.object({ token: z.string().max(200) });

/** 未初始化时还能访问的路由(按 Fastify 匹配到的路由模式判断,不看原始地址,免得 /api/setup/../ 之类绕过) */
function allowedBeforeSetup(route: string | undefined): boolean {
  return route === "/healthz" || route === "/setup" || (route?.startsWith("/api/setup/") ?? false);
}

function isSetupRoute(route: string | undefined): boolean {
  return route === "/setup" || (route?.startsWith("/api/setup/") ?? false);
}

/**
 * 未初始化模式(docs/setup-wizard.md):只开放设置向导和 /healthz,首页跳到向导。
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
    // 打开 Ferry 的首页就进向导,和初始化后进控制台一样
    if (route === "/") return reply.redirect("/setup");
    return reply
      .status(503)
      .send({ error: "not_initialized", message: "Ferry 还没有完成初始化,请管理员先用设置向导完成初始化" });
  });
}

export function registerSetupRoutes(app: FastifyInstance, options: SetupRouteOptions): void {
  const { service } = options;

  const sessionCookie = (req: FastifyRequest, token: string) =>
    [
      `${SETUP_COOKIE}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Strict",
      `Max-Age=${service.sessionMaxAgeSeconds}`,
      ...(isHttps(req) ? ["Secure"] : []),
    ].join("; ");

  // 第 4 步从服务器 IP 跳到正式地址时地址里带着交接令牌(/setup?handoff=…)。GET 只返回页面、不用掉令牌:
  // 链接预览、浏览器预取这类抢先访问不会把一次性的令牌用掉;页面去掉地址栏里的令牌,再用同源 POST 兑换
  app.get("/setup", async (_req, reply) =>
    reply.type("text/html; charset=utf-8").header("cache-control", "no-store").header("referrer-policy", "no-referrer").send(SETUP_PAGE),
  );

  // 第 2 步经 Traefik 请求它、第 4 步在浏览器里请求它,确认到的是这台服务器上的这个 Ferry。不需要会话,只返回一个随机标识
  app.get("/api/setup/ping", async (_req, reply) =>
    reply.header("access-control-allow-origin", "*").header("cache-control", "no-store").send({ instance: options.instanceId }),
  );

  app.get("/api/setup/status", async (req) => {
    const session = await service.hasSession(req.headers);
    return {
      initialized: options.initialized(),
      session,
      // 向导进度只给有会话的人看
      ...(session && options.wizard
        ? { wizard: await options.wizard.status(), suggestedIp: suggestServerIp(req.headers.host) }
        : {}),
    };
  });

  app.post("/api/setup/handoff/redeem", async (req, reply) => {
    requireSameHostOrigin(req);
    const { token } = handoffBody.parse(req.body);
    if (!options.wizard || !(await options.wizard.redeemHandoff(token))) {
      throw new UserError("unauthenticated", "交接链接无效或已过期,请重新输入设置码");
    }
    const session = await service.openSession();
    return reply.header("set-cookie", sessionCookie(req, session.token)).send({ ok: true });
  });

  app.post("/api/setup/code", async (req, reply) => {
    requireSameHostOrigin(req);
    const { code } = codeBody.parse(req.body);
    const { token } = await service.verifyCode(code, clientIp(req));
    return reply.header("set-cookie", sessionCookie(req, token)).send({ ok: true });
  });

  /** 第 2 到 4 步的修改请求:同源、带着向导会话 */
  const guard = async (req: FastifyRequest): Promise<SetupWizard> => {
    requireSameHostOrigin(req);
    if (!(await service.hasSession(req.headers))) throw new UserError("unauthenticated", "向导会话已过期,请重新输入设置码");
    if (!options.wizard) throw new UserError("not_found", "这一步还没有开放");
    return options.wizard;
  };

  app.post("/api/setup/domain", async (req) => (await guard(req)).checkDomain(domainBody.parse(req.body)));

  app.post("/api/setup/certificate", async (req) => {
    const wizard = await guard(req);
    const { certificate, privateKey } = certificateBody.parse(req.body);
    return wizard.installCertificate(certificate, privateKey);
  });

  app.post("/api/setup/certificate/skip", async (req) => {
    await (await guard(req)).skipCertificate();
    return { ok: true };
  });

  app.post("/api/setup/switch", async (req) => (await guard(req)).switchAddress());

  app.post("/api/setup/switch/undo", async (req) => {
    await (await guard(req)).undoSwitch();
    return { ok: true };
  });

  app.post("/api/setup/handoff", async (req) => ({ token: await (await guard(req)).issueHandoff() }));
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

/**
 * 访问者的 IP,按它分别计算设置码输错次数。经 Traefik 转过来时,Traefik 丢掉客户端自带的 X-Forwarded-For、
 * 换成它看到的来源(入口没有配置信任的上游时的默认行为),取最后一个。
 * 直接访问 Ferry(只在本机开发时)时客户端能伪造这个头,但所有来源合计的次数上限仍然有效
 */
function clientIp(req: FastifyRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const last = (Array.isArray(forwarded) ? forwarded.join(",") : forwarded)?.split(",").pop()?.trim();
  return last || req.ip;
}

/** 经 Traefik 转过来时看它设置的 X-Forwarded-Proto(Traefik 会覆盖客户端自己带的) */
function isHttps(req: FastifyRequest): boolean {
  return req.protocol === "https" || req.headers["x-forwarded-proto"] === "https";
}
