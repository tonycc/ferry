import { describe, expect, it } from "vitest";
import { DokployClient, DokployError } from "./dokploy-client";
import { DokployPlatform, formatEnv, lastStartLogs, parseEnv } from "./dokploy";

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
  const platform = new DokployPlatform(client, { pollIntervalMs: 0, deployTimeoutMs: 1000, stableMs: 0, sleep: async () => {} });
  const called = (procedure: string) => calls.filter((c) => c.procedure === procedure);
  return { client, platform, calls, called, logged };
}

const ARCHIVE = { version: "v1", zip: Buffer.from("PK\x03\x04fake") };
const APP_ONE = () => ({ applicationId: "a1", appName: "ledger-x1", env: null });
/** 新容器已在运行 */
const NEW_TASK_RUNNING = () => [{ containerId: "t-new", state: "running", currentState: "Running 2 seconds ago" }];

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

  it("attachDomain:新域名挂上登录网关;已一致时不动;没挂网关或端口变了就更新,保留原有中间件", async () => {
    let domains: Record<string, unknown>[] = [];
    const { platform, called } = fakeDokploy({
      "domain.byApplicationId": () => domains,
      "domain.create": () => ({ domainId: "d-new" }),
      "domain.update": () => true,
    });
    await platform.attachDomain({ appId: "a1", host: "crm.apps.localhost", port: 8080 });
    expect(called("domain.create")[0]?.input).toMatchObject({
      host: "crm.apps.localhost",
      port: 8080,
      https: false,
      certificateType: "none",
      applicationId: "a1",
      middlewares: ["ferry-gateway@file"],
    });

    domains = [{ domainId: "d1", host: "ledger.apps.localhost", port: 3000, path: "/", middlewares: ["ferry-gateway@file"] }];
    await platform.attachDomain({ appId: "a1", host: "ledger.apps.localhost", port: 3000 });
    expect(called("domain.update")).toHaveLength(0);

    // 网关上线之前建的域名:没有中间件
    domains = [{ domainId: "d1", host: "ledger.apps.localhost", port: 3000, path: "/", middlewares: ["other@file"] }];
    await platform.attachDomain({ appId: "a1", host: "ledger.apps.localhost", port: 3000 });
    expect(called("domain.update")[0]?.input).toMatchObject({
      domainId: "d1",
      port: 3000,
      path: "/",
      middlewares: ["other@file", "ferry-gateway@file"],
    });

    // 端口变了
    domains = [{ domainId: "d1", host: "ledger.apps.localhost", port: 3000, path: "/", middlewares: ["ferry-gateway@file"] }];
    await platform.attachDomain({ appId: "a1", host: "ledger.apps.localhost", port: 8080 });
    expect(called("domain.update")[1]?.input).toMatchObject({ domainId: "d1", port: 8080 });
  });

  it("ensureGateway:写入网关配置,顺序是删身份头、问 /authz、删健康检查口令", async () => {
    const { platform, called } = fakeDokploy({ "settings.updateTraefikFile": () => true });
    await platform.ensureGateway({ authAddress: "http://host.docker.internal:8080/authz" });
    const input = called("settings.updateTraefikFile")[0]?.input as { path: string; traefikConfig: string };
    expect(input.path).toBe("/etc/dokploy/traefik/dynamic/ferry-gateway.yml");
    expect(input.traefikConfig).toContain('address: "http://host.docker.internal:8080/authz"');
    expect(input.traefikConfig).toMatch(/- ferry-strip-identity\n\s+- ferry-auth\n\s+- ferry-strip-health/);
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
    let uploaded = false;
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
      "application.dropDeployment": () => {
        uploaded = true;
        return true;
      },
      "application.one": APP_ONE,
      "docker.getServiceContainersByAppName": () => (uploaded ? NEW_TASK_RUNNING() : []),
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
      "application.one": APP_ONE,
      "docker.getServiceContainersByAppName": () => [],
    });
    expect(await platform.deploy("a1", ARCHIVE)).toEqual({ ok: false, reason: "build", logs: "Step 3/5 : RUN npm install\nnpm ERR! missing script" });
    expect(called("deployment.readLogs")[0]?.input).toEqual({ deploymentId: "new", tail: "200" });
  });

  it("deploy:一直没有结果时按超时失败,而不是无限等待", async () => {
    const { client } = fakeDokploy({
      "deployment.all": () => [{ deploymentId: "old", status: "done" }],
      "application.dropDeployment": () => true,
      "application.one": APP_ONE,
      "docker.getServiceContainersByAppName": () => [],
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

  it("deploy:构建完成后,等上传前没有的新容器运行起来才返回", async () => {
    let uploaded = false;
    let taskCalls = 0;
    const { platform } = fakeDokploy({
      "application.one": APP_ONE,
      "deployment.all": () => (uploaded ? [{ deploymentId: "new", status: "done" }] : []),
      "application.dropDeployment": () => {
        uploaded = true;
        return true;
      },
      "docker.getServiceContainersByAppName": () => {
        taskCalls++;
        const old = { containerId: "t-old", state: "running", currentState: "Running 5 minutes ago" };
        // 上传前:只有旧容器
        if (taskCalls === 1) return [old];
        // 新容器期望状态已是 running,但实际还在启动
        if (taskCalls === 2) return [old, { containerId: "t-new", state: "running", currentState: "Starting 1 second ago" }];
        // 新容器已运行,但旧容器还没停(先启动新的再停旧的)
        if (taskCalls === 3) return [old, { containerId: "t-new", state: "running", currentState: "Running 1 second ago" }];
        return [
          { containerId: "t-old", state: "shutdown", currentState: "Shutdown 1 second ago" },
          { containerId: "t-new", state: "running", currentState: "Running 2 seconds ago" },
        ];
      },
    });
    expect(await platform.deploy("a1", ARCHIVE)).toEqual({ ok: true });
    expect(taskCalls).toBe(4);
  });

  it("deploy:新容器启动即崩溃、被反复重启时,不等超时,返回最后一次启动的日志", async () => {
    let uploaded = false;
    let taskCalls = 0;
    const { platform } = fakeDokploy({
      "application.one": APP_ONE,
      "deployment.all": () => (uploaded ? [{ deploymentId: "new", status: "done" }] : []),
      "application.dropDeployment": () => {
        uploaded = true;
        return true;
      },
      "docker.getServiceContainersByAppName": () => {
        if (!uploaded) return [];
        taskCalls++;
        const failed = (id: string) => ({ containerId: id, state: "shutdown", currentState: "Failed 3 seconds ago" });
        return taskCalls === 1 ? [failed("t1")] : [failed("t1"), failed("t2")];
      },
      "application.readLogs": () =>
        [
          "2026-11-18T15:53:02.100Z Error: relation \"app_settings\" does not exist",
          "2026-11-18T15:52:16.100Z Error: relation \"app_settings\" does not exist",
          "2026-11-18T15:52:16.200Z Node.js v22",
          "2026-11-18T15:53:02.200Z Node.js v22",
        ].join("\n"),
    });
    const result = await platform.deploy("a1", ARCHIVE);
    expect(result).toEqual({
      ok: false,
      reason: "start",
      logs: '(容器启动后退出,被反复重启;下面是最后一次启动的输出)\nError: relation "app_settings" does not exist\nNode.js v22',
    });
    expect(taskCalls).toBe(2);
  });

  it("deploy:新容器短暂显示为运行中随即崩溃,不算启动成功", async () => {
    let uploaded = false;
    let taskCalls = 0;
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const { client } = fakeDokploy({
        "application.one": APP_ONE,
        "deployment.all": () => (uploaded ? [{ deploymentId: "new", status: "done" }] : []),
        "application.dropDeployment": () => {
          uploaded = true;
          return true;
        },
        "docker.getServiceContainersByAppName": () => {
          if (!uploaded) return [];
          taskCalls++;
          const failed = (id: string) => ({ containerId: id, state: "shutdown", currentState: "Failed 1 second ago" });
          if (taskCalls === 1) return [{ containerId: "t1", state: "running", currentState: "Running less than a second ago" }];
          if (taskCalls === 2) return [failed("t1"), { containerId: "t2", state: "running", currentState: "Running less than a second ago" }];
          return [failed("t1"), failed("t2")];
        },
        "application.readLogs": () => "Error: boom",
      });
      const platform = new DokployPlatform(client, { pollIntervalMs: 3000, stableMs: 8000, sleep: async (ms) => void (now += ms) });
      expect(await platform.deploy("a1", ARCHIVE)).toMatchObject({ ok: false, reason: "start" });
    } finally {
      Date.now = realNow;
    }
  });

  it("deploy:构建成功但新容器一直没起来时,返回失败和应用日志", async () => {
    let uploaded = false;
    const { client } = fakeDokploy({
      "application.one": APP_ONE,
      "deployment.all": () => (uploaded ? [{ deploymentId: "new", status: "done" }] : []),
      "application.dropDeployment": () => {
        uploaded = true;
        return true;
      },
      "docker.getServiceContainersByAppName": () =>
        uploaded ? [{ containerId: "t-new", state: "running", currentState: "Failed 2 seconds ago" }] : [],
      "application.readLogs": () => "Error: Cannot find module 'pg'",
    });
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const platform = new DokployPlatform(client, {
        pollIntervalMs: 1000,
        startTimeoutMs: 5000,
        sleep: async (ms) => {
          now += ms;
        },
      });
      const result = await platform.deploy("a1", ARCHIVE);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe("start");
      expect(result.ok === false && result.logs).toContain("Cannot find module 'pg'");
    } finally {
      Date.now = realNow;
    }
  });
});

describe("DokployPlatform:数据库、命令、备份", () => {
  const ENV = {
    projectId: "p1",
    environments: [{ environmentId: "e1", name: "production", isDefault: true, applications: [], postgres: [] as unknown[] }],
  };
  const PG = {
    postgresId: "pg1",
    appName: "ledger-db-x1",
    databaseName: "app",
    databaseUser: "app",
    databasePassword: "p@ss/word",
    applicationStatus: "idle",
  };

  it("createDatabase:新建、启动,并用读回的账号拼连接串(特殊字符会转义)", async () => {
    let status = "idle";
    const { platform, called } = fakeDokploy({
      "project.one": () => ENV,
      "postgres.create": () => ({ postgresId: "pg1" }),
      "postgres.one": () => ({ ...PG, applicationStatus: status }),
      "postgres.deploy": () => {
        status = "done";
        return true;
      },
    });
    const db = await platform.createDatabase({ projectId: "p1", name: "ledger" });
    expect(db).toEqual({ databaseId: "pg1", connectionUrl: "postgresql://app:p%40ss%2Fword@ledger-db-x1:5432/app" });
    expect(called("postgres.create")[0]?.input).toMatchObject({ name: "ledger-db", environmentId: "e1", dockerImage: "postgres:16" });
    expect(called("postgres.deploy")).toHaveLength(1);
  });

  it("createDatabase:Dokploy 等数据库启动超时报错,但容器随后起来了,继续用它", async () => {
    let taskCalls = 0;
    const { platform } = fakeDokploy({
      "project.one": () => ENV,
      "postgres.create": () => ({ postgresId: "pg1" }),
      "postgres.one": () => PG,
      "postgres.deploy": () => new Response("did not converge within 45000ms", { status: 500 }),
      "docker.getServiceContainersByAppName": () =>
        ++taskCalls < 3 ? [{ containerId: "d1", state: "running", currentState: "Preparing 40 seconds ago" }]
          : [{ containerId: "d1", state: "running", currentState: "Running 1 second ago" }],
    });
    expect((await platform.createDatabase({ projectId: "p1", name: "ledger" })).databaseId).toBe("pg1");
    expect(taskCalls).toBe(3);
  });

  it("createDatabase:数据库一直没起来时,把 Dokploy 的错误抛出去", async () => {
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const { client } = fakeDokploy({
        "project.one": () => ENV,
        "postgres.create": () => ({ postgresId: "pg1" }),
        "postgres.one": () => PG,
        "postgres.deploy": () => new Response("boom", { status: 500 }),
        "docker.getServiceContainersByAppName": () => [],
      });
      const platform = new DokployPlatform(client, { pollIntervalMs: 1000, startTimeoutMs: 5000, sleep: async (ms) => void (now += ms) });
      await expect(platform.createDatabase({ projectId: "p1", name: "ledger" })).rejects.toThrow("postgres.deploy");
    } finally {
      Date.now = realNow;
    }
  });

  it("createDatabase:已有且在运行的数据库直接复用,不重复启动", async () => {
    const { platform, called } = fakeDokploy({
      "project.one": () => ({
        ...ENV,
        environments: [{ ...ENV.environments[0], postgres: [{ postgresId: "pg1", name: "ledger-db", appName: "ledger-db-x1" }] }],
      }),
      "postgres.one": () => ({ ...PG, applicationStatus: "done" }),
    });
    expect((await platform.createDatabase({ projectId: "p1", name: "ledger" })).databaseId).toBe("pg1");
    expect(called("postgres.create")).toHaveLength(0);
    expect(called("postgres.deploy")).toHaveLength(0);
  });

  it("runCommand:先等上次留下的任务执行完并删掉,再新建、执行、删除", async () => {
    let leftoverRuns = 0;
    const { platform, called } = fakeDokploy({
      "schedule.list": () => [
        { scheduleId: "old", name: "ferry-command-1" },
        { scheduleId: "other", name: "user-backup-job" },
      ],
      "deployment.allByType": () => (++leftoverRuns < 2 ? [{ deploymentId: "r1", status: "running" }] : [{ deploymentId: "r1", status: "done" }]),
      "schedule.delete": () => true,
      "schedule.create": () => ({ scheduleId: "s2" }),
      "schedule.runManually": () => ({ status: "done", deploymentId: "r2" }),
    });
    expect(await platform.runCommand("a1", "node migrate.js")).toEqual({ ok: true });
    expect(leftoverRuns).toBe(2);
    expect(called("schedule.delete").map((c) => c.input.scheduleId)).toEqual(["old", "s2"]);
    expect(called("schedule.create")[0]?.input).toMatchObject({
      command: "node migrate.js",
      scheduleType: "application",
      applicationId: "a1",
      enabled: false,
    });
  });

  it("runCommand:失败时返回这次执行的日志,任务照样删掉", async () => {
    const { platform, called } = fakeDokploy({
      "schedule.list": () => [],
      "schedule.create": () => ({ scheduleId: "s1" }),
      "schedule.runManually": () => ({ status: "error", deploymentId: "r1" }),
      "deployment.readLogs": () => 'relation "items" already exists',
      "schedule.delete": () => true,
    });
    expect(await platform.runCommand("a1", "node migrate.js")).toEqual({ ok: false, reason: "command", logs: 'relation "items" already exists' });
    expect(called("schedule.delete")).toHaveLength(1);
  });

  it("backupDatabase:在服务器上执行 pg_dump,写 script 字段,返回备份文件路径", async () => {
    const { client, called } = fakeDokploy({
      "postgres.one": () => ({ ...PG, applicationStatus: "done" }),
      "schedule.create": () => ({ scheduleId: "s1" }),
      "schedule.runManually": () => ({ status: "done", deploymentId: "r1" }),
      "schedule.delete": () => true,
    });
    const platform = new DokployPlatform(client, { now: () => new Date("2026-11-17T08:00:00.000Z") });
    const file = await platform.backupDatabase("pg1");
    expect(file).toBe("/etc/dokploy/ferry-backups/ledger-db-x1/2026-11-17T08-00-00-000Z.sql.gz");
    const input = called("schedule.create")[0]?.input;
    expect(input).toMatchObject({ scheduleType: "dokploy-server", shellType: "bash", enabled: false });
    const script = input?.script as string;
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain("name=^ledger-db-x1\\.");
    expect(script).toContain("pg_dump -U app -d app | gzip > " + file + ".tmp");
    expect(script).toContain(`trap 'rm -f ${file}.tmp' ERR`);
    // 默认只保留最新 5 份
    expect(script).toContain("ls -1 /etc/dokploy/ferry-backups/ledger-db-x1/*.sql.gz | sort -r | tail -n +6 | xargs -r rm -f");
    expect(script).not.toContain("p@ss");
  });

  it("backupDatabase:失败时抛出不含细节的错误,名称里有特殊字符时拒绝执行", async () => {
    let pg = { ...PG };
    const { platform, called } = fakeDokploy({
      "postgres.one": () => pg,
      "schedule.create": () => ({ scheduleId: "s1" }),
      "schedule.runManually": () => ({ status: "error", deploymentId: "r1" }),
      "deployment.readLogs": () => "pg_dump: error: connection failed",
      "schedule.delete": () => true,
    });
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      await expect(platform.backupDatabase("pg1")).rejects.toThrow("迁移前备份数据库失败");
    } finally {
      console.error = original;
    }
    expect(errors).toHaveLength(1);
    expect(called("schedule.delete")).toHaveLength(1);

    pg = { ...PG, databaseUser: "app; rm -rf /" };
    await expect(platform.backupDatabase("pg1")).rejects.toThrow("不支持的字符");
    expect(called("schedule.create")).toHaveLength(1);
  });
});

describe("DokployPlatform:下线", () => {
  it("removeApp:先删残留的命令任务,再删应用,等容器停掉;查询容器报错也算已停止", async () => {
    let deleted = false;
    let taskCalls = 0;
    const { platform, called } = fakeDokploy({
      "application.one": () => ({ applicationId: "a1", appName: "ledger-x1", env: null }),
      "schedule.list": () => [
        { scheduleId: "s1", name: "ferry-command-1" },
        { scheduleId: "s2", name: "user-job" },
      ],
      "schedule.delete": () => true,
      "application.delete": () => {
        deleted = true;
        return true;
      },
      "docker.getServiceContainersByAppName": () => {
        taskCalls++;
        if (!deleted || taskCalls === 1) return [{ containerId: "t1", state: "running", currentState: "Running 1 minute ago" }];
        return new Response("no such service", { status: 500 });
      },
    });
    await platform.removeApp("a1");
    expect(called("schedule.delete").map((c) => c.input.scheduleId)).toEqual(["s1"]);
    expect(called("application.delete")).toHaveLength(1);
    expect(taskCalls).toBe(2);
  });

  it("stopDatabase:调用 postgres.stop", async () => {
    const { platform, called } = fakeDokploy({ "postgres.stop": () => true });
    await platform.stopDatabase("pg1");
    expect(called("postgres.stop")[0]?.input).toEqual({ postgresId: "pg1" });
  });
});

describe("环境变量文本", () => {
  it("解析和拼接互为逆操作,值里可以有等号,跳过注释和空行", () => {
    const env = parseEnv("# comment\nA=1\n\nB=x=y\n");
    expect(env).toEqual({ A: "1", B: "x=y" });
    expect(parseEnv(formatEnv(env))).toEqual(env);
  });
});

describe("lastStartLogs", () => {
  it("没有时间戳的日志原样返回", () => {
    expect(lastStartLogs("plain line\nanother")).toBe("plain line\nanother");
  });
  it("只启动过一次时只去掉时间戳", () => {
    expect(lastStartLogs("2026-11-18T15:52:16.1Z a\n2026-11-18T15:52:16.2Z b\n")).toBe("a\nb");
  });
});
