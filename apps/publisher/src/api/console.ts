import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";

/** 控制台(apps/console)的构建结果,由 pnpm --filter @ferry/console build 生成 */
export const DEFAULT_CONSOLE_DIR = fileURLToPath(new URL("../../../console/dist", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".json": "application/json",
};

/**
 * 在 /console/ 下提供控制台。assets/ 下的文件名带内容哈希,可以长期缓存;
 * 其他路径都是前端路由,返回 index.html(不缓存,发布新版控制台后立即生效)。
 */
export function registerConsole(app: FastifyInstance, dir: string = DEFAULT_CONSOLE_DIR): void {
  const root = resolve(dir);

  app.get("/console", async (_req, reply) => reply.redirect("/console/"));

  app.get<{ Params: { "*": string } }>("/console/*", async (req, reply) => {
    const rel = req.params["*"];
    if (rel.startsWith("assets/")) {
      const file = resolve(root, rel);
      // 不允许用 ../ 读到构建目录以外的文件
      if (!file.startsWith(root + sep)) return reply.status(404).send();
      const body = await readFile(file).catch(() => undefined);
      if (!body) return reply.status(404).send();
      return reply
        .type(TYPES[extname(file)] ?? "application/octet-stream")
        .header("cache-control", "public, max-age=31536000, immutable")
        .send(body);
    }
    const index = await readFile(join(root, "index.html")).catch(() => undefined);
    if (!index) {
      return reply
        .status(503)
        .type("text/plain; charset=utf-8")
        .send("控制台还没有构建。请运行 pnpm --filter @ferry/console build,然后刷新");
    }
    return reply.type(TYPES[".html"]!).header("cache-control", "no-cache").send(index);
  });
}
