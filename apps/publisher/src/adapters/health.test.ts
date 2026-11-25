import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { join } from "node:path";
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
    expect(await checker.check("ledger.apps.localhost", "/healthz")).toEqual({ ok: true });
    expect(seen).toHaveLength(3);
    expect(seen[0]).toEqual({ host: "ledger.apps.localhost", path: "/healthz" });
  });

  it("超时内一直不是 2xx 时判为不健康,并带上最后一次的状态码", async () => {
    const { url } = await gateway([502, 404]);
    const checker = new HttpHealthChecker({ gateway: url, intervalMs: 10, timeoutMs: 100 });
    expect(await checker.check("ledger.apps.localhost", "/healthz")).toEqual({ ok: false, status: 404 });
  });

  it("入口连不上时判为不健康(状态码 0),不抛错", async () => {
    const checker = new HttpHealthChecker({ gateway: "http://127.0.0.1:1", intervalMs: 10, timeoutMs: 50 });
    expect(await checker.check("ledger.apps.localhost", "healthz")).toEqual({ ok: false, status: 0 });
  });

  it("https 应用:http 入口跳到同一域名的 https 时,改走 https 入口再查一次,同样带口令", async () => {
    const fixtures = join(__dirname, "../setup/fixtures");
    const seen: { host?: string; token?: string; sni?: string }[] = [];
    const tls = createHttpsServer(
      { cert: readFileSync(join(fixtures, "chain.pem")), key: readFileSync(join(fixtures, "leaf.key")) },
      (req, res) => {
        seen.push({ host: req.headers.host, token: String(req.headers["x-token"]), sni: (req.socket as { servername?: string }).servername });
        res.writeHead(200).end();
      },
    );
    await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
    server = createServer((req, res) => res.writeHead(308, { location: `https://${req.headers.host}${req.url}` }).end());
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    try {
      const checker = new HttpHealthChecker({
        gateway: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        tlsPort: (tls.address() as AddressInfo).port,
        extraHeaders: () => ({ "x-token": "t1" }),
        intervalMs: 0,
        timeoutMs: 1000,
      });
      expect(await checker.check("ledger.apps.example.com", "/healthz")).toEqual({ ok: true });
      expect(seen).toEqual([{ host: "ledger.apps.example.com", token: "t1", sni: "ledger.apps.example.com" }]);
    } finally {
      tls.close();
    }
  });

  it("跳到别的地址不算:判为不健康", async () => {
    server = createServer((_req, res) => res.writeHead(302, { location: "https://other.example.com/" }).end());
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const checker = new HttpHealthChecker({ gateway: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, intervalMs: 0, timeoutMs: 50 });
    expect(await checker.check("ledger.apps.example.com", "/healthz")).toEqual({ ok: false, status: 302 });
  });
});
