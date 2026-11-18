import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { HTTP_STATUS, UserError } from "../errors";
import type { IdentityResolver } from "../identity";
import { createMcpServer } from "../mcp/server";
import type { PublisherService } from "../service";

const prepareBody = z.object({ name: z.string() });
const publishBody = z.object({ manifestYaml: z.string(), version: z.string().min(1) });
const disableBody = z.object({ reason: z.string().max(500).optional() });

export interface ServerOptions {
  maxArchiveBytes: number;
}

export function buildServer(
  service: PublisherService,
  identity: IdentityResolver,
  options: ServerOptions,
): FastifyInstance {
  const app = Fastify({ logger: true });

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

  app.get("/healthz", async () => ({ ok: true }));

  // ---- 给“我的应用”网页用的 REST 接口,与 MCP 工具一一对应 ----

  app.post("/api/apps/prepare", async (req) => {
    const { name } = prepareBody.parse(req.body);
    return service.prepareApp(identity(req.headers), name);
  });

  app.get("/api/apps", async (req) => service.listApps(identity(req.headers)));

  app.get<{ Params: { name: string } }>("/api/apps/:name/logs", async (req) => ({
    logs: await service.getLogs(identity(req.headers), req.params.name),
  }));

  app.post<{ Params: { name: string } }>("/api/apps/:name/rollback", async (req, reply) => {
    const view = await service.rollback(identity(req.headers), req.params.name);
    return reply.status(202).send(view);
  });

  app.post<{ Params: { name: string } }>("/api/apps/:name/unpublish", async (req) =>
    service.unpublish(identity(req.headers), req.params.name),
  );

  app.post("/api/releases", async (req, reply) => {
    const view = await service.publish(identity(req.headers), publishBody.parse(req.body));
    return reply.status(202).send(view);
  });

  app.get<{ Params: { id: string } }>("/api/releases/:id", async (req) =>
    service.status(identity(req.headers), req.params.id),
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

  app.get("/api/admin/apps", async (req) => service.listAllApps(identity(req.headers)));

  app.post<{ Params: { name: string } }>("/api/admin/apps/:name/disable", async (req) => {
    const { reason } = disableBody.parse(req.body ?? {});
    await service.disableApp(identity(req.headers), req.params.name, reason);
    return { ok: true };
  });

  app.post<{ Params: { name: string } }>("/api/admin/apps/:name/enable", async (req) => {
    await service.enableApp(identity(req.headers), req.params.name);
    return { ok: true };
  });

  // ---- 登录网关(Traefik forwardAuth)的权限判定 ----
  // 网关带着访问者身份和被访问的域名来问:放行还是拒绝
  app.get("/authz", async (req, reply) => {
    const host = req.headers["x-forwarded-host"];
    if (typeof host !== "string") return reply.status(400).send();
    const allowed = await service.authorize(identity(req.headers), host);
    return reply.status(allowed ? 200 : 403).send();
  });

  // ---- 给 agent 用的 MCP 入口(无状态:每个请求一个实例) ----
  app.post("/mcp", async (req, reply) => {
    const user = identity(req.headers);
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
