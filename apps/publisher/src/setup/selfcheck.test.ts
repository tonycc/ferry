import { describe, expect, it } from "vitest";
import { createFakeAdapters } from "../adapters/fake";
import { PublisherService } from "../service";
import { TemplateLibrary } from "../templates";
import { Engine } from "../workflow/engine";
import { MemoryStore } from "../workflow/store";
import { SELFCHECK_APP, SelfCheck } from "./selfcheck";

const LOGIN = "https://ferry.example.com/auth/app?host=ferry-selfcheck.apps.example.com&next=%2F";

type Probe = (host: string, tls: boolean) => { status: number; location?: string };

function setup(probe: Probe = () => ({ status: 302, location: LOGIN })) {
  const adapters = createFakeAdapters();
  const store = new MemoryStore();
  const service = new PublisherService(store, new Engine(store, adapters, { maxFixAttempts: 3 }), adapters, {
    appsDomain: "apps.example.com",
    maxAppsPerUser: 5,
    publicUrl: "https://ferry.example.com",
    uploadTtlMs: 60_000,
    templates: new TemplateLibrary(),
  });
  const probed: string[] = [];
  const check = new SelfCheck({
    service,
    probe: async (host, _path, options) => (probed.push(`${options?.tls ? "https" : "http"}:${host}`), probe(host, options?.tls === true)),
    publicUrl: "https://ferry.example.com",
    appsDomain: "apps.example.com",
    pollMs: 1,
    sleep: async () => {},
  });
  return { check, store, adapters, probed };
}

async function run(check: SelfCheck) {
  let passed = 0;
  const { progress, done } = check.start(async () => void passed++);
  expect(progress.running).toBe(true);
  await done;
  return { passed, status: check.status() };
}

describe("设置向导的自检", () => {
  it("用 node-postgres 模板发布 ferry-selfcheck,未登录访问跳到登录页,最后删掉", async () => {
    const { check, store, probed, adapters } = setup();
    const { passed, status } = await run(check);
    expect(status).toMatchObject({ running: false, result: "passed" });
    expect(status.steps.map((s) => s.state)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(passed).toBe(1);
    expect(probed).toEqual(["http:ferry-selfcheck.apps.example.com"]);
    // 测试应用和它的数据库都删掉了
    expect(await store.getApp(SELFCHECK_APP)).toBeUndefined();
    expect(adapters.platform.calls.some((c) => c.startsWith("createDatabase"))).toBe(true);
    expect([...(adapters.platform as { databases: Map<string, unknown> }).databases.keys()]).toEqual([]);
  });

  it("没跳到登录页:那一步不通过并给出处理建议,测试应用照样删掉", async () => {
    const { check, store } = setup(() => ({ status: 200 }));
    const { passed, status } = await run(check);
    expect(passed).toBe(0);
    expect(status.result).toBe("failed");
    expect(status.steps.map((s) => s.state)).toEqual(["ok", "ok", "bad", "ok"]);
    expect(status.steps[2]!.message).toContain("没有跳到登录页(返回 200)");
    expect(status.hint).toContain("登录网关");
    expect(await store.getApp(SELFCHECK_APP)).toBeUndefined();
  });

  it("发布失败:报出失败原因,不再检查网关,测试应用照样删掉", async () => {
    const { check, store, adapters, probed } = setup();
    adapters.platform.failDeployMarkers.add("node:22-alpine");
    const { status } = await run(check);
    expect(status.result).toBe("failed");
    expect(status.steps.map((s) => s.state)).toEqual(["ok", "bad", "wait", "ok"]);
    expect(status.hint).toBeTruthy();
    expect(probed).toEqual([]);
    expect(await store.getApp(SELFCHECK_APP)).toBeUndefined();
  });

  it("上一次(Ferry 中途重启)留下的测试应用,开始时先删掉;跑着的时候不重复开始", async () => {
    const { check, store } = setup();
    await store.createApp({
      name: SELFCHECK_APP,
      ownerId: "ferry:selfcheck",
      visibility: "self",
      host: "ferry-selfcheck.apps.example.com",
      platform: {},
      liveVersion: "old",
      createdAt: new Date(),
    });
    let passed = 0;
    const first = check.start(async () => void passed++);
    const again = check.start(async () => void passed++);
    expect(again.progress.running).toBe(true);
    await Promise.all([first.done, again.done]);
    expect(passed).toBe(1);
    expect(check.status().result).toBe("passed");
    expect(await store.getApp(SELFCHECK_APP)).toBeUndefined();
  });

  it("只删留下的测试应用(跳过自检时用);正在自检时不做", async () => {
    const { check, store } = setup();
    await store.createApp({
      name: SELFCHECK_APP,
      ownerId: "ferry:selfcheck",
      visibility: "self",
      host: "ferry-selfcheck.apps.example.com",
      platform: {},
      liveVersion: "old",
      createdAt: new Date(),
    });
    await check.cleanup();
    expect(await store.getApp(SELFCHECK_APP)).toBeUndefined();
    await check.cleanup();
  });

  it("应用用 https 时,http 入口先跳到 https:改走 https 入口再检查", async () => {
    const { check, probed } = setup((host, tls) =>
      tls ? { status: 302, location: LOGIN } : { status: 308, location: `https://${host}/` },
    );
    const { status } = await run(check);
    expect(status.result).toBe("passed");
    expect(probed).toEqual(["http:ferry-selfcheck.apps.example.com", "https:ferry-selfcheck.apps.example.com"]);
  });

  it("前面没通过、清理也失败:两条提示都留着", async () => {
    const { check, adapters } = setup(() => ({ status: 200 }));
    adapters.platform.removeApp = async () => {
      throw new Error("Dokploy 连不上");
    };
    const { status } = await run(check);
    expect(status.steps.map((s) => s.state)).toEqual(["ok", "ok", "bad", "bad"]);
    expect(status.hint).toContain("登录网关");
    expect(status.hint).toContain("测试应用没删掉");
  });
});
