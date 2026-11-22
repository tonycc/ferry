import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import pg from "pg";

const port = Number(process.env.PORT ?? 3000);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

interface Visitor {
  id: string;
  name: string;
  departments: string[];
  /** 部门名称,和 departments 一一对应 */
  departmentNames: string[];
}

/**
 * 访问者是谁:由 Ferry 的登录网关放在请求头里,应用自己不用做登录。
 * 请求头只能由网关写入(访问者伪造的会被删掉),可以直接相信。
 */
function visitor(req: IncomingMessage): Visitor | undefined {
  const id = req.headers["x-ferry-user-id"];
  if (typeof id !== "string" || !id) return undefined;
  const name = req.headers["x-ferry-user-name"];
  const departments = req.headers["x-ferry-user-departments"];
  const departmentNames = req.headers["x-ferry-user-department-names"];
  return {
    id,
    // 姓名按 UTF-8 百分号编码
    name: decodeURIComponent(typeof name === "string" ? name : ""),
    departments: (typeof departments === "string" ? departments : "").split(",").filter(Boolean),
    // 每个名称单独百分号编码,用逗号分隔
    departmentNames: (typeof departmentNames === "string" ? departmentNames : "")
      .split(",")
      .filter(Boolean)
      .map(decodeURIComponent),
  };
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function send(res: ServerResponse, status: number, type: string, body: string) {
  res.writeHead(status, { "content-type": type });
  res.end(body);
}

const json = (res: ServerResponse, status: number, data: unknown) =>
  send(res, status, "application/json; charset=utf-8", JSON.stringify(data));

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

interface Item {
  id: number;
  title: string;
  created_at: Date;
}

const server = createServer(async (req, res) => {
  try {
    // 健康检查:数据库连不上时返回 500,Ferry 据此判断应用是否可用
    if (req.url === "/healthz") {
      await pool.query("select 1");
      return json(res, 200, { ok: true });
    }
    if (req.url === "/items" && req.method === "POST") {
      const input = JSON.parse((await readBody(req)) || "{}") as { title?: unknown };
      const title = String(input.title ?? "").trim();
      if (!title) return json(res, 400, { error: "title 不能为空" });
      const { rows } = await pool.query<Item>(
        "insert into items (title) values ($1) returning id, title, created_at",
        [title],
      );
      return json(res, 201, rows[0]);
    }
    if (req.url === "/") {
      // 数据库只在收到请求时查询:发布时先启动新代码再执行迁移,启动阶段不能依赖这次迁移才建的表
      const { rows } = await pool.query<{ count: number }>("select count(*)::int as count from items");
      const who = visitor(req);
      const greeting = who ? `<p>你好,${escapeHtml(who.name)}</p>` : "";
      return send(res, 200, "text/html; charset=utf-8", `<h1>my-app</h1>${greeting}<p>items 表里有 ${rows[0]?.count ?? 0} 条记录</p>`);
    }
    res.writeHead(404).end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(port, () => console.log(`listening on ${port}`));
