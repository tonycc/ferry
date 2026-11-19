import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakeAdapters } from "../adapters/fake";
import { PublisherService } from "../service";
import { Engine } from "../workflow/engine";
import { MemoryStore } from "../workflow/store";
import { buildServer } from "./server";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ferry-console-"));
  await mkdir(join(dir, "dist", "assets"), { recursive: true });
  await writeFile(join(dir, "dist", "index.html"), "<div id=app></div>");
  await writeFile(join(dir, "dist", "assets", "index-abc.js"), "console.log(1)");
  await writeFile(join(dir, "secret.txt"), "do not serve");
});
afterAll(() => rm(dir, { recursive: true, force: true }));

function server(consoleDir: string) {
  const adapters = createFakeAdapters();
  const store = new MemoryStore();
  const service = new PublisherService(store, new Engine(store, adapters, { maxFixAttempts: 3 }), adapters, {
    appsDomain: "apps.test",
    maxAppsPerUser: 5,
    publicUrl: "http://ferry.test",
    uploadTtlMs: 60_000,
  });
  const app = buildServer(service, async () => ({ id: "u", departments: [], isAdmin: false }), { maxArchiveBytes: 1024, consoleDir });
  app.log.level = "silent";
  return app;
}

describe("控制台", () => {
  it("前端路由都返回 index.html(不缓存);带哈希的静态文件长期缓存", async () => {
    const app = server(join(dir, "dist"));
    expect((await app.inject({ method: "GET", url: "/" })).headers.location).toBe("/console/");
    expect((await app.inject({ method: "GET", url: "/console" })).headers.location).toBe("/console/");

    for (const url of ["/console/", "/console/apps/ledger", "/console/tokens"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe("<div id=app></div>");
      expect(res.headers["cache-control"]).toBe("no-cache");
    }
    const asset = await app.inject({ method: "GET", url: "/console/assets/index-abc.js" });
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect(asset.headers["cache-control"]).toContain("immutable");
    expect((await app.inject({ method: "GET", url: "/console/assets/missing.js" })).statusCode).toBe(404);
  });

  it("不能用 ../ 读到构建目录以外的文件", async () => {
    const app = server(join(dir, "dist"));
    for (const url of ["/console/assets/../../secret.txt", "/console/assets/..%2f..%2fsecret.txt", "/console/assets/%2e%2e/%2e%2e/secret.txt"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.body).not.toContain("do not serve");
    }
  });

  it("还没构建时提示怎么构建", async () => {
    const res = await server(join(dir, "missing")).inject({ method: "GET", url: "/console/" });
    expect(res.statusCode).toBe(503);
    expect(res.body).toContain("pnpm --filter @ferry/console build");
  });

  it("应用详情和修改可见范围的接口", async () => {
    const app = server(join(dir, "dist"));
    await app.inject({ method: "POST", url: "/api/apps/prepare", payload: { name: "ledger" } });
    const detail = await app.inject({ method: "GET", url: "/api/apps/ledger" });
    expect(detail.json()).toMatchObject({ name: "ledger", visibility: "self", visibilityPinned: false, releases: [] });

    const bad = await app.inject({ method: "POST", url: "/api/apps/ledger/visibility", payload: { visibility: "everyone" } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/api/apps/ledger/visibility", payload: { visibility: "company" } });
    expect(ok.json()).toMatchObject({ visibility: "company" });
    expect((await app.inject({ method: "GET", url: "/api/apps/ledger" })).json()).toMatchObject({ visibilityPinned: true });
    expect((await app.inject({ method: "GET", url: "/api/apps/nope" })).statusCode).toBe(404);
  });
});
