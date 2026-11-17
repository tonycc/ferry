import { createServer } from "node:http";
import pg from "pg";

const port = Number(process.env.PORT ?? 3000);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const server = createServer(async (req, res) => {
  try {
    if (req.url === "/healthz") {
      await pool.query("select 1");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/items" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const title = String(JSON.parse(body || "{}").title ?? "").trim();
      if (!title) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "title 不能为空" }));
        return;
      }
      const { rows } = await pool.query("insert into items (title) values ($1) returning id, title, created_at", [title]);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify(rows[0]));
      return;
    }
    if (req.url === "/") {
      const { rows } = await pool.query("select count(*)::int as count from items");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<h1>my-app</h1><p>items 表里有 ${rows[0].count} 条记录</p>`);
      return;
    }
    res.writeHead(404).end();
  } catch (err) {
    console.error(err);
    res.writeHead(500).end();
  }
});

server.listen(port, () => console.log(`listening on ${port}`));
