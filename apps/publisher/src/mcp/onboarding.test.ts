import { describe, expect, it } from "vitest";
import { createFakeAdapters } from "../adapters/fake";
import { buildServer } from "../api/server";
import { PublisherService } from "../service";
import { TemplateLibrary } from "../templates";
import { makeZip } from "../test/zip";
import { Engine } from "../workflow/engine";
import { MemoryStore } from "../workflow/store";
import { checkArchiveLayout, zipEntryNames } from "../zip";

const alice = { id: "dingtalk:alice", departments: ["finance"], isAdmin: false };
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

function setup(options: { agentUrl?: string } = {}) {
  const adapters = createFakeAdapters();
  const store = new MemoryStore();
  const service = new PublisherService(store, new Engine(store, adapters, { maxFixAttempts: 3 }), adapters, {
    appsDomain: "apps.test",
    maxAppsPerUser: 5,
    publicUrl: "http://ferry.test",
    agentUrl: options.agentUrl,
    uploadTtlMs: 60_000,
    templates: new TemplateLibrary(),
  });
  const app = buildServer(service, async () => alice, { maxArchiveBytes: 1024 * 1024 });
  app.log.level = "silent";

  async function rpc(method: string, params: unknown = {}) {
    const res = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: MCP_HEADERS,
      payload: { jsonrpc: "2.0", id: 1, method, params },
    });
    expect(res.statusCode).toBe(200);
    const line = res.body.split("\n").find((l) => l.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : res.body).result;
  }
  async function tool(name: string, args: Record<string, unknown> = {}) {
    const result = await rpc("tools/call", { name, arguments: args });
    const text: string = result.content[0].text;
    return { isError: result.isError === true, text, json: () => JSON.parse(text) };
  }
  return { service, app, rpc, tool };
}

describe("agent 接入", () => {
  it("连接时把使用说明作为 instructions 发给 agent", async () => {
    const { rpc } = setup();
    const result = await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(result.instructions).toContain("发布前先向用户确认");
    expect(result.instructions).toContain("X-Ferry-User-Id");
    // 控制台的完整地址:agent 只知道 MCP 的地址,自己猜会猜错
    expect(result.instructions).toContain("http://ferry.test/console/apps/<应用名>#secrets");
    expect(result.instructions).not.toContain("{{CONSOLE_URL}}");
  });

  it("agent 能列出模板并取到模板文件,不含依赖目录,不能越出模板目录", async () => {
    const { rpc, tool } = setup();
    const names = (await rpc("tools/list")).tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_templates", "get_template", "prepare_app", "publish_app"]));

    const templates = (await tool("list_templates")).json();
    expect(templates).toContainEqual({ name: "node-postgres", description: expect.stringContaining("PostgreSQL") });
    expect(templates).toContainEqual({ name: "static", description: expect.stringContaining("静态网页") });

    const files: { path: string; content: string }[] = (await tool("get_template", { name: "node-postgres" })).json();
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining(["app.yaml", "Dockerfile", "tsconfig.json", "src/server.ts", "src/migrate.ts", "migrations/001_init.sql"]),
    );
    expect(paths.some((p) => p.startsWith("node_modules"))).toBe(false);

    for (const name of ["../manifest", "..", "node-postgres/../../manifest"]) {
      const result = await tool("get_template", { name });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("没有模板");
    }
  });

  it("app.yaml 写了不存在的模板时直接报错,并列出可用的模板", async () => {
    const { service } = setup();
    const prepared = await service.prepareApp(alice, "expense");
    await service.receiveUpload(prepared.uploadUrl.split("/").pop()!, makeZip({ "app.yaml": "", Dockerfile: "" }));
    await expect(
      service.publish(alice, { manifestYaml: "name: expense\ntemplate: node-pg\n", version: prepared.version }),
    ).rejects.toThrow(/没有模板 node-pg.*node-postgres/);
  });

  it("设了 agentUrl 时上传地址用它,控制台地址仍用 publicUrl", async () => {
    const { service } = setup({ agentUrl: "http://host.docker.internal:8080" });
    const prepared = await service.prepareApp(alice, "expense");
    expect(prepared.uploadUrl).toMatch(/^http:\/\/host\.docker\.internal:8080\/uploads\//);
    expect(service.consoleUrl()).toBe("http://ferry.test/console");
  });

  it("代码包多包了一层目录时上传就报错,改好后同一个上传地址还能用", async () => {
    const { app, service } = setup();
    const prepared = await service.prepareApp(alice, "expense");
    const path = new URL(prepared.uploadUrl).pathname;

    const wrapped = await app.inject({
      method: "PUT",
      url: path,
      headers: { "content-type": "application/octet-stream" },
      payload: makeZip({ "expense/app.yaml": "", "expense/Dockerfile": "", "expense/server.js": "" }),
    });
    expect(wrapped.statusCode).toBe(400);
    expect(wrapped.body).toContain("多了一层目录 expense/");

    const ok = await app.inject({
      method: "PUT",
      url: path,
      headers: { "content-type": "application/octet-stream" },
      payload: makeZip({ "app.yaml": "", Dockerfile: "", "server.js": "" }),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ version: prepared.version });
  });
});

describe("代码包结构检查", () => {
  it("读出 zip 里的文件名", () => {
    expect(zipEntryNames(makeZip({ "a.txt": "x", "dir/b.txt": "y" }))).toEqual(["a.txt", "dir/b.txt"]);
    expect(zipEntryNames(Buffer.from("PK\x03\x04 truncated"))).toBeUndefined();
  });

  it("根目录缺文件时说明缺什么", () => {
    expect(checkArchiveLayout(["app.yaml", "Dockerfile"])).toBeUndefined();
    expect(checkArchiveLayout(["./app.yaml", "./Dockerfile"])).toBeUndefined();
    expect(checkArchiveLayout(["app.yaml", "server.js"])).toContain("缺少 Dockerfile");
    expect(checkArchiveLayout(["my-app/", "my-app/app.yaml", "my-app/Dockerfile"])).toContain("多了一层目录 my-app/");
  });
});
