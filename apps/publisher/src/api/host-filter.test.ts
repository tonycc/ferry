import { describe, expect, it } from "vitest";
import { createFakeAdapters } from "../adapters/fake";
import { PublisherService } from "../service";
import { Engine } from "../workflow/engine";
import { MemoryStore } from "../workflow/store";
import { buildServer } from "./server";

function server(options: { publicUrl?: string; agentUrl?: string; initialized?: boolean }) {
  const adapters = createFakeAdapters();
  const workflow = new MemoryStore();
  const service = new PublisherService(workflow, new Engine(workflow, adapters, { maxFixAttempts: 3 }), adapters, {
    appsDomain: "apps.example.com",
    maxAppsPerUser: 5,
    publicUrl: options.publicUrl ?? "http://127.0.0.1:8080",
    uploadTtlMs: 60_000,
  });
  const app = buildServer(service, async () => ({ id: "u", departments: [], isAdmin: false }), {
    maxArchiveBytes: 1024,
    hosts: { publicUrl: options.publicUrl, agentUrl: options.agentUrl, appsDomain: "apps.example.com" },
  });
  app.log.level = "silent";
  return app;
}

const get = (app: ReturnType<typeof server>, url: string, headers: Record<string, string>) =>
  app.inject({ method: "GET", url, headers });

describe("按域名分流(Ferry 是 Traefik 上的兜底路由)", () => {
  it("Ferry 自己的域名照常;应用域名下没有的应用返回“应用不存在”页;其他域名和服务器 IP 返回 404", async () => {
    const app = server({ publicUrl: "https://ferry.example.com" });
    const https = { "x-forwarded-proto": "https" };
    expect((await get(app, "/healthz", { ...https, host: "ferry.example.com" })).statusCode).toBe(200);
    expect((await get(app, "/", { ...https, host: "ferry.example.com" })).statusCode).toBe(302);

    const missing = await get(app, "/", { ...https, host: "nope.apps.example.com" });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).toContain("text/html");
    expect(missing.body).toContain("这个应用不存在或已下线");

    for (const host of ["10.0.0.5", "evil.example.com", "apps.example.com"]) {
      expect((await get(app, "/", { ...https, host })).statusCode, host).toBe(404);
    }
  });

  it("用 https 时,Ferry 域名上的 http 请求跳到 https(308,保留方法和路径);/authz、/healthz、本机地址不受影响", async () => {
    const app = server({ publicUrl: "https://ferry.example.com" });
    const res = await get(app, "/console/apps?x=1", { host: "ferry.example.com", "x-forwarded-proto": "http" });
    expect(res.statusCode).toBe(308);
    expect(res.headers.location).toBe("https://ferry.example.com/console/apps?x=1");
    expect((await get(app, "/healthz", { host: "10.0.0.5" })).statusCode).toBe(200);
    expect((await get(app, "/healthz", { host: "127.0.0.1:8080" })).statusCode).toBe(200);
    expect((await get(app, "/", { host: "localhost:8080" })).statusCode).toBe(302);
  });

  it("用 http 时不跳转;agent 上传用的域名也放行", async () => {
    const app = server({ publicUrl: "http://ferry.example.com", agentUrl: "http://host.docker.internal:8080" });
    expect((await get(app, "/", { host: "ferry.example.com", "x-forwarded-proto": "http" })).statusCode).toBe(302);
    expect((await get(app, "/healthz", { host: "host.docker.internal:8080" })).statusCode).toBe(200);
    expect((await get(app, "/", { host: "host.docker.internal:8080" })).statusCode).toBe(302);
  });

  it("没有对外地址(本机开发)时不过滤", async () => {
    const app = server({});
    expect((await get(app, "/", { host: "anything.example.com" })).statusCode).toBe(302);
  });
});
