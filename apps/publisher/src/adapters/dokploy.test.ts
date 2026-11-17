import { describe, expect, it } from "vitest";
import { DokployClient, DokployError } from "./dokploy-client";
import { DokployPlatform, formatEnv, parseEnv } from "./dokploy";

type Handler = (input: Record<string, unknown>, request: Request) => unknown;

/** 按接口名应答的假 Dokploy,记录每次调用 */
function fakeDokploy(handlers: Record<string, Handler>) {
  const calls: { procedure: string; input: Record<string, unknown>; request: Request }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const request = new Request(url as string, init);
    const { pathname, searchParams } = new URL(request.url);
    const procedure = pathname.replace(/^\/api\//, "");
    let input: Record<string, unknown> = Object.fromEntries(searchParams);
    if (request.method === "POST" && request.headers.get("content-type")?.startsWith("application/json")) {
      input = (await request.clone().json()) as Record<string, unknown>;
    }
    calls.push({ procedure, input, request });
    const handler = handlers[procedure];
    if (!handler) return new Response(`no handler for ${procedure}`, { status: 404 });
    const result = await handler(input, request);
    if (result instanceof Response) return result;
    return new Response(result === undefined ? "" : JSON.stringify(result), { status: 200 });
  };
  const logged: string[] = [];
  const client = new DokployClient({
    baseUrl: "http://dokploy.test/",
    apiKey: "test-key",
    fetch: fetchImpl,
    logError: (m) => logged.push(m),
  });
  const platform = new DokployPlatform(client, { pollIntervalMs: 0, deployTimeoutMs: 1000, sleep: async () => {} });
  const called = (procedure: string) => calls.filter((c) => c.procedure === procedure);
  return { client, platform, calls, called, logged };
}

const ARCHIVE = { version: "v1", zip: Buffer.from("PK\x03\x04fake") };

describe("DokployClient", () => {
  it("带上 API key;报错信息只有接口名和状态码,响应内容只进服务端日志", async () => {
    const { client, calls, logged } = fakeDokploy({
      "application.one": () => new Response('{"env":"DATABASE_URL=postgres://u:secret@db/app"}', { status: 500 }),
    });
    const error = await client.query<unknown>("application.one", { applicationId: "a1" }).then(
      () => new Error("应当失败"),
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(DokployError);
    expect(error.message).toBe("调用部署平台接口 application.one 失败(HTTP 500)");
    expect(error.message).not.toContain("secret");
    expect(logged[0]).toContain("secret");
    expect(calls[0]?.request.headers.get("x-api-key")).toBe("test-key");
  });

  it("上传时用 multipart,不带 JSON 的 content-type", async () => {
    const { client, calls } = fakeDokploy({ "application.dropDeployment": () => true });
    const form = new FormData();
    form.set("applicationId", "a1");
    await client.upload("application.dropDeployment", form);
    expect(calls[0]?.request.headers.get("content-type")).toMatch(/^multipart\/form-data; boundary=/);
  });
});

describe("DokployPlatform", () => {
  it("createProject:复用已有的同名 ferry- 项目,不碰别人手动建的同名项目", async () => {
    const { platform, called } = fakeDokploy({
      "project.all": () => [
        { projectId: "manual", name: "ledger" },
        { projectId: "p1", name: "ferry-ledger" },
      ],
      "project.create": () => ({ project: { projectId: "new" } }),
    });
    expect(await platform.createProject("ledger")).toBe("p1");
    expect(await platform.createProject("crm")).toBe("new");
    expect(called("project.create")[0]?.input).toEqual({ name: "ferry-crm" });
  });

  it("createApp:在默认环境里按名称复用,并设为 Dockerfile 构建", async () => {
    const { platform, called } = fakeDokploy({
      "project.one": () => ({
        projectId: "p1",
        environments: [
          { environmentId: "e-staging", name: "staging", applications: [] },
          { environmentId: "e1", name: "production", isDefault: true, applications: [{ applicationId: "a1", name: "ledger", appName: "ledger-x1" }] },
        ],
      }),
      "application.create": () => ({ applicationId: "a2", appName: "crm-y2" }),
      "application.saveBuildType": () => true,
    });
    expect(await platform.createApp({ projectId: "p1", name: "ledger", port: 3000 })).toBe("a1");
    expect(called("application.create")).toHaveLength(0);
    expect(await platform.createApp({ projectId: "p1", name: "crm", port: 3000 })).toBe("a2");
    expect(called("application.create")[0]?.input).toMatchObject({ name: "crm", environmentId: "e1" });
    expect(called("application.saveBuildType").map((c) => c.input.buildType)).toEqual(["dockerfile", "dockerfile"]);
  });

  it("attachDomain:已经绑过的域名不再重复绑定", async () => {
    const { platform, called } = fakeDokploy({
      "domain.byApplicationId": () => [{ domainId: "d1", host: "ledger.apps.localhost" }],
      "domain.create": () => ({ domainId: "d2" }),
    });
    await platform.attachDomain({ appId: "a1", host: "ledger.apps.localhost", port: 3000 });
    expect(called("domain.create")).toHaveLength(0);
    await platform.attachDomain({ appId: "a1", host: "crm.apps.localhost", port: 8080 });
    expect(called("domain.create")[0]?.input).toMatchObject({
      host: "crm.apps.localhost",
      port: 8080,
      https: false,
      certificateType: "none",
      applicationId: "a1",
    });
  });

  it("setEnv:保留已有变量,只更新传入的", async () => {
    let saved = "";
    const { platform } = fakeDokploy({
      "application.one": () => ({ applicationId: "a1", env: "DATABASE_URL=postgres://u:p@db:5432/app?ssl=a=b\nPORT=3000" }),
      "application.saveEnvironment": (input) => {
        saved = input.env as string;
        return true;
      },
    });
    await platform.setEnv("a1", { PORT: "8080", NEW: "1" });
    expect(parseEnv(saved)).toEqual({ DATABASE_URL: "postgres://u:p@db:5432/app?ssl=a=b", PORT: "8080", NEW: "1" });
  });

  it("deploy:先等之前的部署结束,再只跟踪这次新出现的部署记录", async () => {
    let listCalls = 0;
    const { platform, called } = fakeDokploy({
      "deployment.all": () => {
        listCalls++;
        if (listCalls === 1) return [{ deploymentId: "old", status: "running" }];
        if (listCalls === 2) return [{ deploymentId: "old", status: "error" }];
        // 上传后第一次查询时新记录还没出现
        if (listCalls === 3) return [{ deploymentId: "old", status: "error" }];
        if (listCalls === 4) return [{ deploymentId: "new", status: "running" }, { deploymentId: "old", status: "error" }];
        return [{ deploymentId: "new", status: "done" }, { deploymentId: "old", status: "error" }];
      },
      "application.dropDeployment": () => true,
    });
    expect(await platform.deploy("a1", ARCHIVE)).toEqual({ ok: true });
    expect(listCalls).toBe(5);
    expect(called("application.dropDeployment")).toHaveLength(1);
    // 上传发生在之前的部署结束之后
    expect(called("deployment.all").length).toBeGreaterThanOrEqual(2);
  });

  it("deploy:构建失败时取回这次部署的日志", async () => {
    let uploaded = false;
    const { platform, called } = fakeDokploy({
      "deployment.all": () =>
        uploaded ? [{ deploymentId: "new", status: "error" }, { deploymentId: "old", status: "done" }] : [{ deploymentId: "old", status: "done" }],
      "application.dropDeployment": () => {
        uploaded = true;
        return true;
      },
      "deployment.readLogs": () => "Step 3/5 : RUN npm install\nnpm ERR! missing script",
    });
    expect(await platform.deploy("a1", ARCHIVE)).toEqual({ ok: false, logs: "Step 3/5 : RUN npm install\nnpm ERR! missing script" });
    expect(called("deployment.readLogs")[0]?.input).toEqual({ deploymentId: "new", tail: "200" });
  });

  it("deploy:一直没有结果时按超时失败,而不是无限等待", async () => {
    const { client } = fakeDokploy({
      "deployment.all": () => [{ deploymentId: "old", status: "done" }],
      "application.dropDeployment": () => true,
    });
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const platform = new DokployPlatform(client, {
        pollIntervalMs: 1000,
        deployTimeoutMs: 5000,
        sleep: async (ms) => {
          now += ms;
        },
      });
      const result = await platform.deploy("a1", ARCHIVE);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.logs).toContain("没有看到新的部署记录");
    } finally {
      Date.now = realNow;
    }
  });
});

describe("环境变量文本", () => {
  it("解析和拼接互为逆操作,值里可以有等号,跳过注释和空行", () => {
    const env = parseEnv("# comment\nA=1\n\nB=x=y\n");
    expect(env).toEqual({ A: "1", B: "x=y" });
    expect(parseEnv(formatEnv(env))).toEqual(env);
  });
});
