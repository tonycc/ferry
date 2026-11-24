import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { checkInstance, resolveInstance } from "./instance";
import type { InstanceSettings } from "./store";

function resolve(env: Record<string, string>, settings: InstanceSettings = {}) {
  const config = loadConfig(env);
  const state = resolveInstance(env, config, settings);
  return { config, state, check: () => checkInstance(state, config) };
}

const DB = { DATABASE_URL: "postgres://x@db/ferry" };

describe("是否已初始化", () => {
  it("环境变量里有 PUBLIC_URL:现有部署,已初始化,向导不出现", () => {
    const { state, check } = resolve({ HOST: "0.0.0.0", PUBLIC_URL: "https://ferry.corp.example", ...DB });
    expect(state.initialized).toBe(true);
    expect(state.publicUrl).toBe("https://ferry.corp.example");
    expect(check).not.toThrow();
  });

  it("本机监听算已初始化,本机开发照常;SETUP_DEV=1 时进入未初始化模式", () => {
    expect(resolve({}).state.initialized).toBe(true);
    expect(resolve({ HOST: "localhost" }).state.initialized).toBe(true);
    expect(resolve({ SETUP_DEV: "1", ...DB }).state.initialized).toBe(false);
  });

  it("监听其他机器的连接、没设 PUBLIC_URL、有数据库:未初始化,只开放向导", () => {
    const { state, check } = resolve({ HOST: "0.0.0.0", ...DB });
    expect(state.initialized).toBe(false);
    expect(check).not.toThrow();
  });

  it("数据库里有向导完成的记录:已初始化,用向导写入的地址", () => {
    const { state, check } = resolve(
      { HOST: "0.0.0.0", ...DB },
      { publicUrl: "https://ferry.x.example", appsDomain: "apps.x.example", appsUrlScheme: "https", setupCompletedAt: new Date() },
    );
    expect(state).toEqual({
      initialized: true,
      publicUrl: "https://ferry.x.example",
      appsDomain: "apps.x.example",
      appsUrlScheme: "https",
    });
    expect(check).not.toThrow();
  });

  it("向导写了地址但还没完成(第 4 步重启后):用新地址,仍是未初始化", () => {
    const { state } = resolve({ HOST: "0.0.0.0", ...DB }, { publicUrl: "https://ferry.x.example", appsDomain: "apps.x.example" });
    expect(state.initialized).toBe(false);
    expect(state.publicUrl).toBe("https://ferry.x.example");
    expect(state.appsDomain).toBe("apps.x.example");
  });
});

describe("环境变量优先", () => {
  it("环境变量里设了的用环境变量", () => {
    const { state } = resolve(
      { PUBLIC_URL: "https://env.example", APPS_DOMAIN: "apps.env.example", APPS_URL_SCHEME: "http" },
      { publicUrl: "https://db.example", appsDomain: "apps.db.example", appsUrlScheme: "https" },
    );
    expect(state).toMatchObject({ publicUrl: "https://env.example", appsDomain: "apps.env.example", appsUrlScheme: "http" });
  });

  it("APPS_DOMAIN 只是默认值时,用向导写入的(不被 config.ts 的默认值挡住)", () => {
    const { config, state } = resolve({ HOST: "0.0.0.0", ...DB }, { appsDomain: "apps.db.example", appsUrlScheme: "http" });
    expect(config.APPS_DOMAIN).toBe("apps.corp.example");
    expect(state.appsDomain).toBe("apps.db.example");
    expect(state.appsUrlScheme).toBe("http");
  });

  it("空值当作没设", () => {
    const { state } = resolve({ HOST: "0.0.0.0", PUBLIC_URL: " ", APPS_DOMAIN: "", ...DB }, { appsDomain: "apps.db.example" });
    expect(state.initialized).toBe(false);
    expect(state.appsDomain).toBe("apps.db.example");
  });

  it("都没有时用默认值", () => {
    expect(resolve({}).state).toMatchObject({ appsDomain: "apps.corp.example", appsUrlScheme: "https", publicUrl: undefined });
  });
});

describe("不能启动的情况", () => {
  it("监听其他机器的连接,既没有 PUBLIC_URL 也没有数据库", () => {
    expect(resolve({ HOST: "0.0.0.0" }).check).toThrow(/PUBLIC_URL.*DATABASE_URL/);
    expect(resolve({ HOST: "192.168.1.10" }).check).toThrow(/127\.0\.0\.1/);
  });

  it("SETUP_DEV=1 但没有数据库", () => {
    expect(resolve({ SETUP_DEV: "1" }).check).toThrow(/SETUP_DEV=1.*DATABASE_URL/);
  });

  it("本机监听不设 PUBLIC_URL 可以启动", () => {
    expect(resolve({}).check).not.toThrow();
  });
});
