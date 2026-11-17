import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DokployClient } from "./dokploy-client";
import { DokployPlatform, parseEnv } from "./dokploy";

/**
 * 对本机真实 Dokploy 的集成测试(任务 1.4 的完成标准)。默认跳过,运行:
 *   pnpm test:dokploy
 * 需要先用 infra/dokploy/setup-local.sh 装好 Dokploy,并在根目录 .env 里配好 DOKPLOY_URL、DOKPLOY_API_KEY。
 * 会在 Dokploy 上建一个临时项目,结束时(包括失败时)按正确顺序删除。
 */

const enabled = process.env.DOKPLOY_INTEGRATION === "1";
const ROOT_ENV = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (enabled && existsSync(ROOT_ENV)) process.loadEnvFile(ROOT_ENV);

const NAME = `it-${Date.now().toString(36)}`;
const HOST = `${NAME}.apps.localhost`;

const GOOD_DOCKERFILE = 'FROM node:22-alpine\nWORKDIR /app\nCOPY server.js .\nCMD ["node", "server.js"]\n';
const SERVER_JS = `require("node:http").createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, b: process.env.B ?? null }));
}).listen(3000, () => console.log("listening on 3000"));
`;
const BAD_DOCKERFILE = "FROM node:22-alpine\nRUN echo FERRY_BUILD_MARKER && exit 1\n";

function zipOf(files: Record<string, string>): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "ferry-it-"));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    execFileSync("zip", ["-q", "-r", "app.zip", ...Object.keys(files)], { cwd: dir });
    return readFileSync(join(dir, "app.zip"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 经本机 80 端口的 Traefik 按域名访问应用 */
function get(host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port: 80, path: "/", headers: { host }, timeout: 5000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.on("timeout", () => req.destroy());
    req.end();
  });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

describe.skipIf(!enabled)("Dokploy 适配器(真实实例)", () => {
  let client: DokployClient;
  let platform: DokployPlatform;
  let projectId: string | undefined;
  let appId: string | undefined;

  beforeAll(() => {
    const baseUrl = process.env.DOKPLOY_URL;
    const apiKey = process.env.DOKPLOY_API_KEY;
    if (!baseUrl || !apiKey) throw new Error("需要在 .env 里设置 DOKPLOY_URL 和 DOKPLOY_API_KEY");
    client = new DokployClient({ baseUrl, apiKey });
    platform = new DokployPlatform(client, { pollIntervalMs: 2000, deployTimeoutMs: 10 * 60_000 });
  });

  // 按实测的顺序清理:先删应用,再删项目(只删项目会留下仍在运行的容器)
  afterAll(async () => {
    if (appId) await client.mutate("application.delete", { applicationId: appId }).catch(() => {});
    if (projectId) {
      await new Promise((r) => setTimeout(r, 5000));
      await client.mutate("project.remove", { projectId }).catch(() => {});
    }
    const services = execFileSync("docker", ["service", "ls", "--format", "{{.Name}}"]).toString();
    expect(services).not.toContain(NAME);
  }, 60_000);

  it("建项目、应用、域名:重复调用时复用,不会建出第二个", async () => {
    projectId = await platform.createProject(NAME);
    expect(await platform.createProject(NAME)).toBe(projectId);

    appId = await platform.createApp({ projectId, name: NAME, port: 3000 });
    expect(await platform.createApp({ projectId, name: NAME, port: 3000 })).toBe(appId);

    await platform.attachDomain({ appId, host: HOST, port: 3000 });
    await platform.attachDomain({ appId, host: HOST, port: 3000 });
    const domains = await client.query<{ host: string }[]>("domain.byApplicationId", { applicationId: appId });
    expect(domains.filter((d) => d.host === HOST)).toHaveLength(1);
  });

  it("setEnv 合并写入,不覆盖已有变量", async () => {
    await platform.setEnv(appId!, { A: "1" });
    await platform.setEnv(appId!, { B: "from-ferry" });
    const app = await client.query<{ env: string | null }>("application.one", { applicationId: appId! });
    expect(parseEnv(app.env ?? "")).toEqual({ A: "1", B: "from-ferry" });
  });

  it("上传代码包部署成功后,能通过域名访问,并读到注入的环境变量", async () => {
    const result = await platform.deploy(appId!, {
      version: "v1",
      zip: zipOf({ Dockerfile: GOOD_DOCKERFILE, "server.js": SERVER_JS }),
    });
    expect(result).toEqual({ ok: true });
    // 部署完成后的几秒内会返回 502
    let last = { status: 0, body: "" };
    expect(await waitFor(async () => (last = await get(HOST)).status === 200)).toBe(true);
    expect(JSON.parse(last.body)).toEqual({ ok: true, b: "from-ferry" });
    expect(await platform.getLogs(appId!, 50)).toContain("listening on 3000");
  }, 11 * 60_000);

  it("构建失败时返回失败和这次构建的日志,线上的旧版本不受影响", async () => {
    const result = await platform.deploy(appId!, { version: "v2", zip: zipOf({ Dockerfile: BAD_DOCKERFILE }) });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.logs).toContain("FERRY_BUILD_MARKER");
    expect((await get(HOST)).status).toBe(200);
  }, 11 * 60_000);

  it("停止后无法访问,启动后恢复", async () => {
    await platform.stopApp(appId!);
    expect(await waitFor(async () => (await get(HOST)).status !== 200)).toBe(true);
    await platform.startApp(appId!);
    expect(await waitFor(async () => (await get(HOST)).status === 200, 120_000)).toBe(true);
  }, 4 * 60_000);
});
