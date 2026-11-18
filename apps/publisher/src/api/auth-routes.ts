import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Directory } from "../adapters/types";
import type { AuthService } from "../auth/service";
import { UserError } from "../errors";
import { readCookie, requireSameOrigin, SESSION_COOKIE, type IdentityResolver } from "../identity";
import { LOGIN_PAGE, TOKENS_PAGE } from "./pages";

const codeBody = z.object({ account: z.string().min(1).max(100) });
const verifyBody = z.object({ challengeId: z.string().uuid(), code: z.string().min(1).max(20) });
const tokenBody = z.object({ label: z.string().max(60).default("") });

export interface AuthRouteOptions {
  allowedOrigins: ReadonlySet<string>;
  /** Ferry 用 https 对外时为 true,cookie 加 Secure */
  secureCookie: boolean;
  /** 验证码有效期(分钟),用于提示文字 */
  codeTtlMinutes: number;
}

/**
 * 验证码登录、登录页、个人令牌管理。
 *
 * 登录 cookie 只发给 Ferry 自己的域名(不设 Domain),不覆盖 *.apps:员工应用是任意代码,
 * 如果能收到这个 cookie,就能拿它以访问者的身份调用 Ferry 的接口。
 */
export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthService,
  identity: IdentityResolver,
  directory: Directory,
  options: AuthRouteOptions,
): void {
  const cookie = (value: string, maxAgeSeconds: number) =>
    [
      `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
      "HttpOnly",
      "SameSite=Lax",
      "Path=/",
      `Max-Age=${maxAgeSeconds}`,
      ...(options.secureCookie ? ["Secure"] : []),
    ].join("; ");

  /** 管理令牌只能用浏览器登录会话,不能用令牌本身(泄露的令牌不能用来生成更多令牌) */
  const sessionUser = async (req: FastifyRequest) => {
    if (req.headers.authorization) throw new UserError("forbidden", "管理个人令牌需要在网页上登录,不能用令牌");
    if (!readCookie(req.headers, SESSION_COOKIE)) throw new UserError("unauthenticated", "需要先登录");
    return identity(req, "api");
  };

  app.get("/login", async (_req, reply) => reply.type("text/html; charset=utf-8").send(LOGIN_PAGE));
  app.get("/me", async (_req, reply) => reply.type("text/html; charset=utf-8").send(TOKENS_PAGE));

  app.post("/auth/code", async (req) => {
    requireSameOrigin(req, options.allowedOrigins);
    const { account } = codeBody.parse(req.body);
    const { challengeId } = await auth.requestCode(account);
    return {
      challengeId,
      message: `如果账号存在,验证码已通过工作通知发给本人,${options.codeTtlMinutes} 分钟内有效;一分钟内只能发一次`,
    };
  });

  app.post("/auth/verify", async (req, reply) => {
    requireSameOrigin(req, options.allowedOrigins);
    const { challengeId, code } = verifyBody.parse(req.body);
    const { sessionToken, expiresAt } = await auth.verify(challengeId, code);
    const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    return reply.header("set-cookie", cookie(sessionToken, maxAge)).send({ ok: true });
  });

  app.post("/auth/logout", async (req, reply) => {
    requireSameOrigin(req, options.allowedOrigins);
    const session = readCookie(req.headers, SESSION_COOKIE);
    if (session) await auth.logout(session);
    return reply.header("set-cookie", cookie("", 0)).send({ ok: true });
  });

  app.get("/api/me", async (req) => {
    const user = await identity(req, "api");
    return { id: user.id, name: (await directory.nameOf(user.id)) ?? user.id, isAdmin: user.isAdmin };
  });

  app.get("/api/tokens", async (req) => auth.listTokens((await sessionUser(req)).id));

  app.post("/api/tokens", async (req, reply) => {
    const user = await sessionUser(req);
    const { label } = tokenBody.parse(req.body ?? {});
    return reply.status(201).send(await auth.createToken(user.id, label));
  });

  app.post<{ Params: { id: string } }>("/api/tokens/:id/revoke", async (req) => {
    const user = await sessionUser(req);
    await auth.revokeToken(user.id, req.params.id);
    return { ok: true };
  });
}
