import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UserError } from "../errors";
import type { User } from "../identity";
import type { PublisherService } from "../service";

/**
 * 给 agent 用的 MCP 工具。每个请求按当前登录用户建一个实例,
 * 所以工具里拿不到、也不需要任何平台凭据。
 *
 * TODO: rollback_app、unpublish_app 还没有实现。
 */
export function createMcpServer(service: PublisherService, user: User): McpServer {
  const server = new McpServer({ name: "ferry", version: "0.0.0" });

  server.registerTool(
    "prepare_app",
    {
      description:
        "每次发布的第一步:为应用占用名称(已是用户自己的应用则复用),返回一次性的 uploadUrl 和 version。" +
        "接着把应用目录打成 zip(根目录含 app.yaml;排除 node_modules、.git、.env 等)," +
        '用 HTTP PUT 上传,例如 curl -T app.zip "<uploadUrl>",然后用 version 调用 publish_app。' +
        "uploadUrl 只能用一次且会过期,失效后重新调用本工具。",
      inputSchema: { name: z.string().describe("应用名,小写字母、数字和连字符,会成为访问域名的一部分") },
    },
    ({ name }) => respond(() => service.prepareApp(user, name)),
  );

  server.registerTool(
    "publish_app",
    {
      description:
        "发布应用到企业服务器。只在用户明确确认发布后调用。返回 releaseId,之后用 get_publish_status 查询进度。",
      inputSchema: {
        manifestYaml: z.string().describe("代码根目录 app.yaml 的完整内容"),
        version: z.string().describe("prepare_app 返回的 version,对应的代码包必须已经上传"),
      },
    },
    (input) => respond(() => service.publish(user, input)),
  );

  server.registerTool(
    "get_publish_status",
    {
      description: "查询一次发布的进度。done 为 false 时隔几秒再查;结束后按 nextAction 操作。",
      inputSchema: { releaseId: z.string() },
    },
    ({ releaseId }) => respond(() => service.status(user, releaseId)),
  );

  server.registerTool(
    "list_my_apps",
    { description: "列出当前用户的全部应用和访问地址。", inputSchema: {} },
    () => respond(() => service.listApps(user)),
  );

  server.registerTool(
    "get_app_logs",
    {
      description: "读取应用最近的运行日志,用于排查线上问题。",
      inputSchema: { name: z.string(), lines: z.number().int().min(1).max(1000).optional() },
    },
    ({ name, lines }) => respond(() => service.getLogs(user, name, lines)),
  );

  return server;
}

async function respond(fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    return { content: [{ type: "text" as const, text }] };
  } catch (err) {
    if (err instanceof UserError) {
      return { content: [{ type: "text" as const, text: err.message }], isError: true };
    }
    throw err;
  }
}
