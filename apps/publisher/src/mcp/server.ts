import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { visibilitySchema } from "@ferry/manifest";
import { z } from "zod";
import { UserError } from "../errors";
import type { User } from "../identity";
import type { PublisherService } from "../service";

/**
 * 给 agent 的使用说明,作为 MCP 的 instructions 在连接时发给 agent(Claude Code 等会放进提示词)。
 * 员工的 agent 拿不到 Ferry 的仓库,所以说明和模板都只能经 MCP 送过去。
 */
export const AGENT_GUIDE = readFileSync(new URL("./agent-guide.md", import.meta.url), "utf8");

/** 把说明里的 {{CONSOLE_URL}} 换成这套 Ferry 的控制台地址:agent 只知道 MCP 的地址,不知道控制台在哪 */
export function agentGuide(consoleUrl: string): string {
  return AGENT_GUIDE.replaceAll("{{CONSOLE_URL}}", consoleUrl);
}

/**
 * 给 agent 用的 MCP 工具。每个请求按当前登录用户建一个实例,
 * 所以工具里拿不到、也不需要任何平台凭据。
 */
export function createMcpServer(service: PublisherService, user: User): McpServer {
  const server = new McpServer({ name: "ferry", version: "0.0.0" }, { instructions: agentGuide(service.consoleUrl()) });

  server.registerTool(
    "list_templates",
    { description: "列出可用的应用模板。用户要给同事做小工具、登记表、看板、内部系统等网页应用时先调用,选一个模板再用 get_template 取文件。", inputSchema: {} },
    () => respond(() => service.listTemplates()),
  );

  server.registerTool(
    "get_template",
    {
      description:
        "取一个模板的全部文件(path 和 content)。把它们原样写到一个新目录里,再在此基础上修改;" +
        "先改 app.yaml 的 name 和 visibility。模板里的 README.md 说明了每个文件的作用。",
      inputSchema: { name: z.string().describe("模板名,来自 list_templates") },
    },
    ({ name }) => respond(() => service.getTemplate(name)),
  );

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
        "发布应用到企业服务器(用户说“发布”“上线”“部署”“给同事用”时走这个流程)。只在用户明确确认发布后调用。返回 releaseId,之后用 get_publish_status 查询进度。",
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
    { description: "列出当前用户的全部应用和访问地址。用户问“我有哪些应用”“xxx 的地址/链接是多少”时调用。", inputSchema: {} },
    () => respond(() => service.listApps(user)),
  );

  server.registerTool(
    "get_app_logs",
    {
      description: "读取应用最近的运行日志,用于排查线上问题。用户说已发布的应用“打不开”“报错”“不对劲”时先调用。",
      inputSchema: { name: z.string(), lines: z.number().int().min(1).max(1000).optional() },
    },
    ({ name, lines }) => respond(() => service.getLogs(user, name, lines)),
  );

  server.registerTool(
    "set_visibility",
    {
      description:
        "修改应用的可见范围,立即生效。只在用户明确要求时调用。应用上线后可见范围以这里(和网页控制台)的设置为准," +
        "发布时 app.yaml 里的 visibility 不再起作用;改完后把 app.yaml 也改成一致,免得以后混淆。",
      inputSchema: {
        name: z.string().describe("应用名"),
        visibility: visibilitySchema.describe("self 仅自己;department 本部门(同部门和上级部门的同事);company 全公司"),
      },
    },
    ({ name, visibility }) => respond(() => service.setVisibility(user, name, visibility)),
  );

  server.registerTool(
    "rollback_app",
    {
      description:
        "把应用恢复到上一个上线过的版本。只在用户明确要求“回到上一个版本”时调用。" +
        "只恢复代码,不恢复数据库:旧代码会跑在新版本迁移过的数据库上,这一点要告诉用户。" +
        "返回 releaseId 以及 from/to 两个版本的上线时间,之后用 get_publish_status 查询进度。" +
        "回滚一次后再回滚,会回到回滚前的版本,不会更早。",
      inputSchema: { name: z.string().describe("应用名") },
    },
    ({ name }) => respond(() => service.rollback(user, name)),
  );

  server.registerTool(
    "unpublish_app",
    {
      description:
        "下线应用:访问地址立即失效,同事都无法再访问。只在用户明确要求下线时调用,调用前先向用户确认。" +
        "数据库会停止,但数据保留;应用名仍归用户所有,以后对同名应用重新走一遍 prepare_app、上传、publish_app 即可恢复,原来的数据还在。" +
        "要告诉用户:长期不用的已下线应用,平台管理员可能会彻底删除,删除后数据无法恢复。",
      inputSchema: { name: z.string().describe("应用名") },
    },
    ({ name }) => respond(() => service.unpublish(user, name)),
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
