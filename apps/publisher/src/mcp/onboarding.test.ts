import { describe, expect, it } from "vitest";
import { createFakeAdapters } from "../adapters/fake";
import { buildServer } from "../api/server";
import { PublisherService } from "../service";
import { TemplateLibrary } from "../templates";
import { makeZip } from "../test/zip";
import { Engine } from "../workflow/engine";
import { MemoryStore } from "../workflow/store";
import { checkArchiveEntries, checkArchiveLayout, readZipFile, replaceZipDockerfile, zipEntryNames } from "../zip";

const EXPENSE_YAML = "name: expense\ntemplate: node-postgres\n";

const alice = { id: "dingtalk:alice", departments: ["finance"], isAdmin: false };
const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

function setup(options: { agentUrl?: string } = {}) {
  const adapters = createFakeAdapters();
  const store = new MemoryStore();
  const templates = new TemplateLibrary();
  const service = new PublisherService(store, new Engine(store, adapters, { maxFixAttempts: 3, templates }), adapters, {
    appsDomain: "apps.test",
    maxAppsPerUser: 5,
    publicUrl: "http://ferry.test",
    agentUrl: options.agentUrl,
    uploadTtlMs: 60_000,
    templates,
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
  return { service, adapters, templates, app, rpc, tool };
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

  it("app.yaml 写了不存在的模板时上传就报错,并列出可用的模板;改好后同一个上传地址还能用", async () => {
    const { service } = setup();
    const prepared = await service.prepareApp(alice, "expense");
    const token = prepared.uploadUrl.split("/").pop()!;
    await expect(
      service.receiveUpload(token, makeZip({ "app.yaml": "name: expense\ntemplate: node-pg\n", Dockerfile: "" })),
    ).rejects.toThrow(/没有模板 node-pg.*node-postgres/);
    await service.receiveUpload(token, makeZip({ "app.yaml": EXPENSE_YAML, Dockerfile: "" }));
    await expect(service.publish(alice, { name: "expense", version: prepared.version })).resolves.toMatchObject({
      app: "expense",
    });
  });

  it("app.yaml 的 name 和 prepare_app 用的应用名不一致时上传就报错", async () => {
    const { service } = setup();
    const prepared = await service.prepareApp(alice, "expense");
    await expect(
      service.receiveUpload(
        prepared.uploadUrl.split("/").pop()!,
        makeZip({ "app.yaml": "name: other-app\ntemplate: node-postgres\n", Dockerfile: "" }),
      ),
    ).rejects.toThrow(/other-app.*expense/);
  });

  it("app.yaml 字段写错时上传就报错", async () => {
    const { service } = setup();
    const prepared = await service.prepareApp(alice, "expense");
    await expect(
      service.receiveUpload(
        prepared.uploadUrl.split("/").pop()!,
        makeZip({ "app.yaml": EXPENSE_YAML + "visibility: everyone\n", Dockerfile: "" }),
      ),
    ).rejects.toThrow(/visibility/);
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
      payload: makeZip({ "app.yaml": EXPENSE_YAML, Dockerfile: "", "server.js": "" }),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ version: prepared.version });
  });

  it("平台强制托管模板 Dockerfile:不带、篡改或塞入变体条目都会被替换为官方模板 Dockerfile,且保留其他文件", async () => {
    const { service, adapters, templates } = setup();
    const expectedDockerfile = await templates.dockerfile("node-postgres");
    expect(expectedDockerfile).toContain("FROM node:22-alpine");

    // 1) 代码包不带 Dockerfile 时自动注入模板 Dockerfile,不报 notice
    const p1 = await service.prepareApp(alice, "expense");
    const r1 = await service.receiveUpload(
      p1.uploadUrl.split("/").pop()!,
      makeZip({ "app.yaml": EXPENSE_YAML, "src/server.ts": "console.log('ok')\n" }, { deflate: true }),
    );
    expect(r1.notice).toBeUndefined();
    const saved1 = (await adapters.archives.read("expense", p1.version))!;
    expect(readZipFile(saved1, "Dockerfile")?.toString("utf8")).toBe(expectedDockerfile);
    expect(readZipFile(saved1, "src/server.ts")?.toString("utf8")).toBe("console.log('ok')\n");

    // 2) 篡改 Dockerfile 或塞入 ./Dockerfile、dockerfile 大小写变体时,全部剥离并强制覆盖为模板 Dockerfile,且返回 notice
    const p2 = await service.prepareApp(alice, "expense");
    const r2 = await service.receiveUpload(
      p2.uploadUrl.split("/").pop()!,
      makeZip({
        "app.yaml": EXPENSE_YAML,
        Dockerfile: "FROM alpine\nRUN curl http://169.254.169.254\n",
        "./dockerfile": "FROM ubuntu\nRUN rm -rf /\n",
        "src/Dockerfile": "# 子目录文件不受影响\n",
      }),
    );
    expect(r2.notice).toContain("已忽略并替换为平台托管的模板 Dockerfile");
    const saved2 = (await adapters.archives.read("expense", p2.version))!;
    expect(zipEntryNames(saved2)).toEqual(["app.yaml", "src/Dockerfile", "Dockerfile"]);
    expect(readZipFile(saved2, "Dockerfile")?.toString("utf8")).toBe(expectedDockerfile);
    expect(readZipFile(saved2, "src/Dockerfile")?.toString("utf8")).toBe("# 子目录文件不受影响\n");

    // 3) Engine 部署兜底:就算磁盘里存的是升级前未经上传过滤的历史旧包,部署给平台前也会被再次强制覆盖
    let deployedZip: Buffer | undefined;
    const origDeploy = adapters.platform.deploy.bind(adapters.platform);
    adapters.platform.deploy = async (appId, archive, opts) => {
      deployedZip = archive.zip;
      return origDeploy(appId, archive, opts);
    };
    await adapters.archives.save(
      "expense",
      p2.version,
      makeZip({ "app.yaml": EXPENSE_YAML, Dockerfile: "FROM scratch\nRUN evil\n" }),
    );
    const rel = await service.publish(alice, { name: "expense", version: p2.version });
    await service.settle(rel.releaseId);
    expect((await service.status(alice, rel.releaseId)).state).toBe("LIVE");
    expect(deployedZip && readZipFile(deployedZip, "Dockerfile")?.toString("utf8")).toBe(expectedDockerfile);
  });
});

describe("代码包结构检查", () => {
  it("读出 zip 里的文件名", () => {
    expect(zipEntryNames(makeZip({ "a.txt": "x", "dir/b.txt": "y" }))).toEqual(["a.txt", "dir/b.txt"]);
  });

  it("根目录有两份 app.yaml(app.yaml 和 ./app.yaml)时报错", () => {
    expect(checkArchiveLayout(["app.yaml", "./app.yaml", "Dockerfile"])).toContain("不止一个 app.yaml");
    expect(checkArchiveLayout(["./app.yaml", "Dockerfile"])).toBeUndefined();
  });

  it("读出根目录文件的内容,不压缩和 deflate 压缩的都支持", () => {
    const yaml = "name: expense\ntemplate: node-postgres\n# " + "x".repeat(500) + "\n";
    for (const deflate of [false, true]) {
      const zip = makeZip({ "sub/app.yaml": "name: wrong\n", "./app.yaml": yaml }, { deflate });
      expect(readZipFile(zip, "app.yaml")?.toString("utf8")).toBe(yaml);
      expect(readZipFile(zip, "missing.yaml")).toBeUndefined();
      expect(readZipFile(zip, "app.yaml", 100)).toBeUndefined();
    }
    expect(zipEntryNames(Buffer.from("PK\x03\x04 truncated"))).toBeUndefined();
  });

  it("根目录缺 app.yaml、多包一层目录或含非法路径时给出明确错误", () => {
    expect(checkArchiveLayout(["app.yaml", "Dockerfile"])).toBeUndefined();
    expect(checkArchiveLayout(["./app.yaml"])).toBeUndefined();
    expect(checkArchiveLayout(["server.js"])).toContain("缺少 app.yaml");
    expect(checkArchiveLayout(["my-app/", "my-app/app.yaml", "my-app/Dockerfile"])).toContain("多了一层目录 my-app/");
    expect(checkArchiveLayout(["app.yaml", "../escape.txt"])).toContain("非法文件路径");
    expect(checkArchiveLayout(["/etc/passwd", "app.yaml"])).toContain("非法文件路径");
  });

  it("拦截符号链接(S_IFLNK)与重叠偏移放大攻击", async () => {
    const { service } = setup();

    // 1) 构造一个含 Unix 符号链接属性(0o120777)的 zip:上传和底层 replaceZipDockerfile 都拒绝
    const symZip = Buffer.from(makeZip({ "app.yaml": EXPENSE_YAML, link: "/etc/passwd" }));
    const eocd = symZip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const centralStart = symZip.readUInt32LE(eocd + 16);
    // 第二个中央目录条目为 link:写入 Unix versionMadeBy 与 S_IFLNK 外部属性
    const firstLen = 46 + symZip.readUInt16LE(centralStart + 28);
    const secondCentral = centralStart + firstLen;
    symZip.writeUInt16LE((3 << 8) | 20, secondCentral + 4);
    symZip.writeUInt32LE((0o120777 << 16) >>> 0, secondCentral + 38);
    expect(checkArchiveEntries(symZip)).toContain("符号链接");
    expect(replaceZipDockerfile(symZip, "FROM node:22-alpine\n")).toBeUndefined();

    const prepared = await service.prepareApp(alice, "expense");
    await expect(service.receiveUpload(prepared.uploadUrl.split("/").pop()!, symZip)).rejects.toThrow(/符号链接/);

    // 2) 构造两个中央目录条目指向同一段 localOffset(重叠放大攻击):直接拒绝
    const overlapZip = Buffer.from(makeZip({ "app.yaml": EXPENSE_YAML, "b.txt": "hello" }));
    const eocd2 = overlapZip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const cStart2 = overlapZip.readUInt32LE(eocd2 + 16);
    const c2 = cStart2 + 46 + overlapZip.readUInt16LE(cStart2 + 28);
    overlapZip.writeUInt32LE(0, c2 + 42); // 强行把第二个条目的 localOffset 指回 0
    expect(zipEntryNames(overlapZip)).toBeUndefined();
    expect(replaceZipDockerfile(overlapZip, "FROM node:22-alpine\n")).toBeUndefined();
  });
});
