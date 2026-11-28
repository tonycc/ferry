import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Directory } from "../adapters/types";
import type { AuthService } from "../auth/service";
import type { Organization } from "../org/service";
import { UserError } from "../errors";
import { readCookies, requireSameOrigin, SESSION_COOKIE, sessionUserFrom, type IdentityResolver } from "../identity";
import { LOGIN_PAGE } from "./pages";
import { safePath, type Gateway } from "../gateway/gateway";

const loginBody = z.object({ account: z.string().min(1).max(100), password: z.string().min(1).max(200) });
const changeInitialBody = z.object({ ticket: z.string().min(1).max(200), newPassword: z.string().max(200) });
const changeBody = z.object({ currentPassword: z.string().max(200), newPassword: z.string().max(200) });
const tokenBody = z.object({ label: z.string().max(60).default("") });
const departmentBody = z.object({ name: z.string().max(200), parentId: z.string().max(200).nullable() });
const personBody = z.object({
  name: z.string().max(200),
  mobile: z.string().max(40).optional(),
  jobNumber: z.string().max(100).optional(),
  departmentIds: z.array(z.string().max(200)).max(50),
});
const newPersonBody = personBody.extend({ isAdmin: z.boolean().optional() });
const adminBody = z.object({ isAdmin: z.boolean() });

export interface AuthRouteOptions {
  allowedOrigins: ReadonlySet<string>;
  /** Ferry 用 https 对外时为 true,cookie 加 Secure */
  secureCookie: boolean;
}

/**
 * 手机号 + 密码登录、登录页、修改密码、个人令牌管理,以及管理员的人员和部门管理(organization 不传时没有)。
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
  gateway?: Gateway,
  organization?: Organization,
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

  /**
   * 管理令牌、改密码、管理员重置密码都只能用浏览器登录会话,不能用令牌本身
   * (泄露的令牌不能用来生成更多令牌,也不能用来改密码或给别人生成密码)
   */
  const sessionUser = async (req: FastifyRequest) => {
    if (req.headers.authorization) throw new UserError("forbidden", "管理个人令牌需要在网页上登录,不能用令牌");
    if (readCookies(req.headers, SESSION_COOKIE).length === 0) throw new UserError("unauthenticated", "需要先登录");
    return identity(req, "api");
  };

  app.get("/login", async (_req, reply) => reply.type("text/html; charset=utf-8").send(LOGIN_PAGE));

  // 访问员工应用前的登录:已登录就签一次性票据跳回应用,没登录先去登录页、登录后再回到这里
  if (gateway) {
    app.get<{ Querystring: { host?: string; next?: string } }>("/auth/app", async (req, reply) => {
      const host = String(req.query.host ?? "");
      const next = safePath(String(req.query.next ?? "/"));
      const userId = await sessionUserFrom(req.headers, auth);
      if (!userId || !(await auth.sessionEpoch(userId))) {
        // 会话存在但没有有效正式密码(异常残留会话):清掉失效会话并跳登录页,避免 /auth/app 自我重定向死循环
        if (userId) {
          for (const session of readCookies(req.headers, SESSION_COOKIE)) await auth.logout(session);
          reply.header("set-cookie", cookie("", 0));
        }
        const back = `/auth/app?host=${encodeURIComponent(host)}&next=${encodeURIComponent(next)}`;
        return reply.redirect(`/login?next=${encodeURIComponent(back)}`);
      }
      const result = await gateway.issueTicket(userId, host, next);
      return reply.status(result.status).headers(result.headers).send(result.body);
    });
  }
  // 个人令牌页和管理页已并入控制台,旧地址跳过去
  app.get("/me", async (_req, reply) => reply.redirect("/console/tokens"));
  app.get("/admin", async (_req, reply) => reply.redirect("/console/admin"));

  /** 登录成功时设置登录 cookie */
  const setSession = (reply: FastifyReply, session: { sessionToken: string; expiresAt: Date }) => {
    const maxAge = Math.max(0, Math.floor((session.expiresAt.getTime() - Date.now()) / 1000));
    return reply.header("set-cookie", cookie(session.sessionToken, maxAge));
  };

  app.post("/auth/login", async (req, reply) => {
    requireSameOrigin(req, options.allowedOrigins);
    const { account, password } = loginBody.parse(req.body);
    const result = await auth.login(account, password);
    // 初始密码:不设 cookie,只给改密码票据
    if (result.kind === "must_change") return { mustChange: true, ticket: result.ticket };
    return setSession(reply, result).send({ ok: true });
  });

  app.post("/auth/change-password", async (req, reply) => {
    requireSameOrigin(req, options.allowedOrigins);
    const { ticket, newPassword } = changeInitialBody.parse(req.body);
    return setSession(reply, await auth.changeInitialPassword(ticket, newPassword)).send({ ok: true });
  });

  /** 已登录时修改密码(控制台);改完其他地方的登录都失效,这里换一个新的 cookie */
  app.post("/api/me/password", async (req, reply) => {
    const user = await sessionUser(req);
    const { currentPassword, newPassword } = changeBody.parse(req.body);
    return setSession(reply, await auth.changePassword(user.id, currentPassword, newPassword)).send({ ok: true });
  });

  // ---- 管理员的人员和部门管理(只认网页登录,不认令牌) ----

  /** 当前登录的管理员;操作人员和部门都要求是管理员 */
  const admin = async (req: FastifyRequest) => {
    const user = await sessionUser(req);
    requireAdmin(user);
    return user;
  };

  if (organization) {
    /** 人员页、部门页用:全部部门(含在职人数)和全部人员(含已离职的人、管理员身份、密码状态) */
    app.get("/api/admin/org", async (req) => {
      await admin(req);
      const [view, statuses] = await Promise.all([organization.view(), auth.passwordStatuses()]);
      return {
        departments: view.departments,
        users: view.users.map((u) => ({
          id: u.id,
          name: u.name,
          mobile: u.mobile ?? null,
          jobNumber: u.jobNumber ?? null,
          departmentIds: u.departmentIds,
          active: u.active,
          isAdmin: u.isAdmin,
          fixedAdmin: u.fixedAdmin,
          password: statuses.get(u.id) ?? "none",
        })),
      };
    });

    app.post("/api/admin/departments", async (req, reply) => {
      const user = await admin(req);
      return reply.status(201).send(await organization.createDepartment(user.id, departmentBody.parse(req.body)));
    });
    app.post<{ Params: { id: string } }>("/api/admin/departments/:id", async (req) => {
      const user = await admin(req);
      await organization.updateDepartment(user.id, req.params.id, departmentBody.parse(req.body));
      return { ok: true };
    });
    app.post<{ Params: { id: string } }>("/api/admin/departments/:id/delete", async (req) => {
      const user = await admin(req);
      await organization.deleteDepartment(user.id, req.params.id);
      return { ok: true };
    });

    app.post("/api/admin/users", async (req, reply) => {
      const user = await admin(req);
      const { isAdmin, ...input } = newPersonBody.parse(req.body);
      const created = await organization.createUser(user.id, input, { isAdmin });
      return reply.status(201).send({ id: created.id });
    });
    app.post<{ Params: { id: string } }>("/api/admin/users/:id", async (req) => {
      const user = await admin(req);
      await organization.updateUser(user.id, req.params.id, personBody.parse(req.body));
      return { ok: true };
    });
    app.post<{ Params: { id: string } }>("/api/admin/users/:id/deactivate", async (req) => {
      const user = await admin(req);
      await organization.deactivate(user.id, req.params.id);
      return { ok: true };
    });
    app.post<{ Params: { id: string } }>("/api/admin/users/:id/reactivate", async (req) => {
      const user = await admin(req);
      await organization.reactivate(user.id, req.params.id);
      return { ok: true };
    });
    app.post<{ Params: { id: string } }>("/api/admin/users/:id/admin", async (req) => {
      const user = await admin(req);
      await organization.setAdmin(user.id, req.params.id, adminBody.parse(req.body).isAdmin);
      return { ok: true };
    });
  }

  app.post<{ Params: { id: string } }>("/api/admin/users/:id/reset-password", async (req) => {
    const user = await admin(req);
    return { password: await auth.resetPassword(user.id, req.params.id) };
  });

  app.post("/auth/logout", async (req, reply) => {
    requireSameOrigin(req, options.allowedOrigins);
    for (const session of readCookies(req.headers, SESSION_COOKIE)) await auth.logout(session);
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

function requireAdmin(user: { isAdmin: boolean }): void {
  if (!user.isAdmin) throw new UserError("forbidden", "只有平台管理员可以管理人员和部门");
}
