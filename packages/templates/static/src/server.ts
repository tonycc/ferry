import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

/**
 * 静态页面服务:把 public/ 下的文件原样返回。页面、样式、脚本、图片都放在 public/ 里,一般不用改这个文件。
 */
const port = Number(process.env.PORT ?? 3000);
const root = resolve("public");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
  ".csv": "text/csv; charset=utf-8",
};

/**
 * 访问者是谁:由 Ferry 的登录网关放在请求头里,应用自己不用做登录。
 * 浏览器里的脚本读不到请求头,所以由 /whoami 转成 JSON 返回,页面用 fetch("/whoami") 读取。
 */
function visitor(req: IncomingMessage) {
  const header = (name: string) => {
    const value = req.headers[name];
    return typeof value === "string" ? value : "";
  };
  const id = header("x-ferry-user-id");
  if (!id) return null;
  return {
    id,
    // 姓名按 UTF-8 百分号编码
    name: decodeURIComponent(header("x-ferry-user-name")),
    departments: header("x-ferry-user-departments").split(",").filter(Boolean),
    // 部门名称,和 departments 一一对应;每个名称单独百分号编码,用逗号分隔
    departmentNames: header("x-ferry-user-department-names").split(",").filter(Boolean).map(decodeURIComponent),
  };
}

/** 请求路径对应的文件;越出 public/ 的路径返回 undefined */
function fileFor(urlPath: string): string | undefined {
  let path: string;
  try {
    path = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  } catch {
    return undefined;
  }
  const file = resolve(join(root, normalize(path)));
  return file === root || file.startsWith(root + sep) ? file : undefined;
}

/** 读出文件;目录读它下面的 index.html。返回实际读到的文件(用来判断内容类型) */
async function readIfFile(file: string): Promise<{ file: string; body: Buffer } | undefined> {
  const info = await stat(file).catch(() => undefined);
  if (info?.isDirectory()) return readIfFile(join(file, "index.html"));
  return info?.isFile() ? { file, body: await readFile(file) } : undefined;
}

const server = createServer(async (req, res) => {
  try {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    if (req.url === "/whoami") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(visitor(req)));
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const file = fileFor(req.url ?? "/");
    let found = file ? await readIfFile(file) : undefined;
    // 没有扩展名的路径找不到时返回首页,方便单页应用用前端路由
    if (!found && file && !extname(file)) found = await readIfFile(join(root, "index.html"));
    if (!found) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("页面不存在");
      return;
    }
    const type = TYPES[extname(found.file).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": type.startsWith("text/html") ? "no-cache" : "max-age=300" });
    res.end(req.method === "HEAD" ? undefined : found.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(port, () => console.log(`listening on ${port}`));
