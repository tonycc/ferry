import { describe, expect, it } from "vitest";
import { isLoopbackHost, loadConfig } from "./config";

describe("loadConfig", () => {
  it("只在本机监听时可以不设 PUBLIC_URL", () => {
    expect(loadConfig({}).PUBLIC_URL).toBeUndefined();
    expect(loadConfig({ HOST: "localhost" }).HOST).toBe("localhost");
  });

  it("监听其他机器的连接但没设 PUBLIC_URL 时拒绝启动", () => {
    expect(() => loadConfig({ HOST: "0.0.0.0" })).toThrow(/PUBLIC_URL/);
    expect(() => loadConfig({ HOST: "192.168.1.10" })).toThrow(/127\.0\.0\.1/);
    expect(loadConfig({ HOST: "0.0.0.0", PUBLIC_URL: "https://ferry.corp.example" }).PUBLIC_URL).toBe(
      "https://ferry.corp.example",
    );
  });

  it("PUBLIC_URL 去掉末尾的 /,空值当作没设", () => {
    expect(loadConfig({ PUBLIC_URL: "https://ferry.corp.example/" }).PUBLIC_URL).toBe("https://ferry.corp.example");
    expect(loadConfig({ PUBLIC_URL: "http://127.0.0.1:8080//" }).PUBLIC_URL).toBe("http://127.0.0.1:8080");
    expect(loadConfig({ PUBLIC_URL: "" }).PUBLIC_URL).toBeUndefined();
    expect(() => loadConfig({ HOST: "0.0.0.0", PUBLIC_URL: " " })).toThrow(/PUBLIC_URL/);
  });

  it("AGENT_URL 和 PUBLIC_URL 一样校验和整理,可以单独设置", () => {
    const config = loadConfig({ AGENT_URL: "http://host.docker.internal:8080/" });
    expect(config.AGENT_URL).toBe("http://host.docker.internal:8080");
    expect(config.PUBLIC_URL).toBeUndefined();
    expect(loadConfig({ AGENT_URL: "" }).AGENT_URL).toBeUndefined();
    expect(() => loadConfig({ AGENT_URL: "host.docker.internal:8080" })).toThrow(/AGENT_URL/);
  });

  it("PUBLIC_URL 必须是 http(s) 地址", () => {
    expect(() => loadConfig({ PUBLIC_URL: "ferry.corp.example" })).toThrow();
    expect(() => loadConfig({ PUBLIC_URL: "ftp://ferry.corp.example" })).toThrow();
  });

  it("识别本机监听地址", () => {
    for (const host of ["127.0.0.1", "127.0.1.1", "::1", "[::1]", "::ffff:127.0.0.1", " localhost ", "LOCALHOST"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    for (const host of ["0.0.0.0", "::", "10.0.0.5", "ferry.corp.example"]) expect(isLoopbackHost(host)).toBe(false);
  });
});
