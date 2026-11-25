import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyInstance } from "fastify";
import { visibilitySchema } from "@ferry/manifest";
import { z } from "zod";
import { AUDIT_ACTIONS } from "../audit/store";
import { HTTP_STATUS, UserError } from "../errors";
import type { IdentityResolver } from "../identity";
import { createMcpServer } from "../mcp/server";
import type { PublisherService } from "../service";
import type { Directory } from "../adapters/types";
import type { AuthService } from "../auth/service";
import { registerAuthRoutes, type AuthRouteOptions } from "./auth-routes";
import { registerConsole } from "./console";
import { registerSetupGate, registerSetupRoutes, type SetupRouteOptions } from "./setup-routes";
import type { Gateway } from "../gateway/gateway";
import type { Organization } from "../org/service";

const prepareBody = z.object({ name: z.string() });
const publishBody = z.object({ name: z.string().min(1), version: z.string().min(1) });
const disableBody = z.object({ reason: z.string().max(500).optional() });
const visibilityBody = z.object({ visibility: visibilitySchema });
const secretBody = z.object({ name: z.string(), value: z.string() });
const auditQuery = z.object({
  app: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const logsQuery = z.object({ lines: z.coerce.number().int().min(1).max(1000).optional() });

export interface ServerOptions {
  /** 控制台构建结果所在目录,默认 apps/console/dist */
  consoleDir?: string;
  maxArchiveBytes: number;
  /** 密码登录和个人令牌;不传时只有开发用的请求头身份 */
  auth?: { service: AuthService; directory: Directory; routes: AuthRouteOptions; organization?: Organization };
  /** 登录网关;不传时没有 /authz 和 /auth/app */
  gateway?: Gateway;
  /** 设置向导和未初始化模式;不传时视为已初始化(测试和旧的调用方式) */
  setup?: SetupRouteOptions;
}

export function buildServer(
  service: PublisherService,
  identity: IdentityResolver,
  options: ServerOptions,
): FastifyInstance {
  const app = Fastify({
    logger: {
      serializers: {
        // 请求日志里的地址去掉设置向导的交接令牌(/setup?handoff=…),令牌不进日志
        req: (req) => ({
          method: req.method,
          url: redactUrl(req.url),
          host: req.host,
          remoteAddress: req.ip,
          remotePort: req.socket?.remotePort,
        }),
      },
    },
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof UserError) {
      return reply.status(HTTP_STATUS[err.code]).send({ error: err.code, message: err.message });
    }
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: "invalid_input", message: err.message });
    }
    // Fastify 自己抛出的请求错误(如 JSON 格式不对)保留原状态码
    const status = (err as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.status(status).send({ error: "invalid_input", message: (err as Error).message });
    }
    app.log.error(err);
    return reply.status(500).send({ error: "internal_error", message: "服务内部错误" });
  });

  // 要在其他路由之前,未初始化时的拦截才作用到全部路由
  if (options.setup) {
    const setup = { consoleDir: options.consoleDir, ...options.setup };
    registerSetupGate(app, setup);
    registerSetupRoutes(app, setup);
  }

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/", async (_req, reply) => reply.redirect("/console/"));
  registerConsole(app, options.consoleDir);

  if (options.auth) {
    const { service: auth, directory, routes, organization } = options.auth;
    registerAuthRoutes(app, auth, identity, directory, routes, options.gateway, organization);
  }

  // ---- 给“我的应用”网页用的 REST 接口,与 MCP 工具一一对应 ----

  app.post("/api/apps/prepare", async (req) => {
    const { name } = prepareBody.parse(req.body);
    return service.prepareApp(await identity(req, "api"), name);
  });

  app.get("/api/apps", async (req) => service.listApps(await identity(req, "api")));

  app.get<{ Params: { name: string } }>("/api/apps/:name", async (req) =>
    service.appDetail(await identity(req, "api"), req.params.name),
  );

  app.get<{ Params: { name: string } }>("/api/apps/:name/logs", async (req) => ({
    logs: await service.getLogs(await identity(req, "api"), req.params.name, logsQuery.parse(req.query).lines),
  }));

  app.post<{ Params: { name: string } }>("/api/apps/:name/visibility", async (req) =>
    service.setVisibility(await identity(req, "api"), req.params.name, visibilityBody.parse(req.body).visibility),
  );

  app.post<{ Params: { name: string } }>("/api/apps/:name/rollback", async (req, reply) => {
    const view = await service.rollback(await identity(req, "api"), req.params.name);
    return reply.status(202).send(view);
  });

  app.post<{ Params: { name: string } }>("/api/apps/:name/unpublish", async (req) =>
    service.unpublish(await identity(req, "api"), req.params.name),
  );

  // ---- 应用密钥:只认浏览器登录(console 入口),个人令牌(agent)调不了,值只在网页上填写 ----

  app.get<{ Params: { name: string } }>("/api/apps/:name/secrets", async (req) =>
    service.listSecrets(await identity(req, "console"), req.params.name),
  );

  app.post<{ Params: { name: string } }>("/api/apps/:name/secrets", async (req) => {
    const user = await identity(req, "console");
    const { name, value } = secretBody.parse(req.body);
    return service.setSecret(user, req.params.name, name, value);
  });

  app.post<{ Params: { name: string; secret: string } }>("/api/apps/:name/secrets/:secret/delete", async (req) =>
    service.deleteSecret(await identity(req, "console"), req.params.name, req.params.secret),
  );

  app.post("/api/releases", async (req, reply) => {
    const view = await service.publish(await identity(req, "api"), publishBody.parse(req.body));
    return reply.status(202).send(view);
  });

  app.get<{ Params: { id: string } }>("/api/releases/:id", async (req) =>
    service.status(await identity(req, "api"), req.params.id),
  );

  // ---- 代码包上传 ----
  // 不看身份请求头:地址里的一次性令牌就是凭据。放在独立的作用域里,
  // 这样“任何内容类型都按二进制接收”只对这一个接口生效。
  app.register(async (scope) => {
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.put<{ Params: { token: string } }>(
      "/uploads/:token",
      { bodyLimit: options.maxArchiveBytes },
      async (req) => {
        if (!Buffer.isBuffer(req.body)) throw new UserError("invalid_input", "请求体必须是 zip 文件");
        return service.receiveUpload(req.params.token, req.body);
      },
    );
  });

  // ---- 管理员接口:查看全部应用,随时停用或恢复任意应用 ----

  app.get("/api/admin/apps", async (req) => service.listAllApps(await identity(req, "api")));

  app.get("/api/admin/audit", async (req) => service.listAudit(await identity(req, "api"), auditQuery.parse(req.query)));

  app.post<{ Params: { name: string } }>("/api/admin/apps/:name/disable", async (req) => {
    const { reason } = disableBody.parse(req.body ?? {});
    await service.disableApp(await identity(req, "api"), req.params.name, reason);
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>("/api/admin/apps/:name/delete", async (req) => {
    await service.deleteApp(await identity(req, "api"), req.params.name);
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>("/api/admin/apps/:name/enable", async (req) => {
    await service.enableApp(await identity(req, "api"), req.params.name);
    return { ok: true };
  });

  // ---- 登录网关(Traefik forwardAuth)----
  // 每个访问员工应用的请求都先到这里:放行(把访问者身份交给应用)、拒绝,或跳转去登录
  if (options.gateway) {
    const gateway = options.gateway;
    app.route({
      method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      url: "/authz",
      handler: async (req, reply) => {
        const result = await gateway.authorize(req.headers);
        return reply.status(result.status).headers(result.headers).send(result.body);
      },
    });
  }

  // ---- 给 agent 用的 MCP 入口(无状态:每个请求一个实例) ----
  app.post("/mcp", async (req, reply) => {
    const user = await identity(req, "mcp");
    const server = createMcpServer(service, user);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req.raw, reply.raw, req.body);
  });

  return app;
}

/** 日志里的地址:去掉查询串里的交接令牌 */
export function redactUrl(url: string): string {
  return url.replace(/([?&]handoff=)[^&#]*/g, "$1<redacted>");
}
