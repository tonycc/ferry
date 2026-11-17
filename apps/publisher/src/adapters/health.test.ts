import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { HttpHealthChecker } from "./health";

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

/** 起一个本地服务充当统一入口,按调用次数决定返回的状态码,并记录收到的 Host 和路径 */
async function gateway(statuses: number[]) {
  const seen: { host?: string; path?: string }[] = [];
  server = createServer((req, res) => {
    seen.push({ host: req.headers.host, path: req.url });
    res.writeHead(statuses[Math.min(seen.length - 1, statuses.length - 1)]!).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen };
}

describe("HttpHealthChecker", () => {
  it("按应用域名访问统一入口;启动期间的 502 之后返回 200 即为健康", async () => {
    const { url, seen } = await gateway([502, 502, 200]);
    const checker = new HttpHealthChecker({ gateway: url, intervalMs: 0, timeoutMs: 5000 });
    expect(await checker.check("ledger.apps.localhost", "/healthz")).toBe(true);
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual({ host: "ledger.apps.localhost", path: "/healthz" });
  });

  it("超时内一直不是 2xx 时判为不健康", async () => {
    const { url } = await gateway([500]);
    const checker = new HttpHealthChecker({ gateway: url, intervalMs: 10, timeoutMs: 100 });
    expect(await checker.check("ledger.apps.localhost", "/healthz")).toBe(false);
  });

  it("入口连不上时判为不健康,不抛错", async () => {
    const checker = new HttpHealthChecker({ gateway: "http://127.0.0.1:1", intervalMs: 10, timeoutMs: 50 });
    expect(await checker.check("ledger.apps.localhost", "healthz")).toBe(false);
  });
});
