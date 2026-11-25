import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkCertificate, covers } from "./certificate";

const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const root = fixture("root.pem");
const required = ["ferry.example.com", "*.apps.example.com"];
const now = new Date("2026-12-01T00:00:00Z");
const check = (chain: string, key: string, extra: { now?: Date; trusted?: string[] } = {}) =>
  checkCertificate(chain, key, { required, now, trusted: [root], ...extra });
const state = (result: ReturnType<typeof check>, key: string) => result.items.find((i) => i.key === key)?.state;

describe("证书检查", () => {
  it("完整的证书链:各项都通过,给出到期时间和域名", () => {
    const result = check(fixture("chain.pem"), fixture("leaf.key"));
    expect(result.ok).toBe(true);
    expect(result.items.map((i) => i.state)).toEqual(["ok", "ok", "ok", "ok", "ok"]);
    expect(result.domains).toEqual(["ferry.example.com", "*.apps.example.com"]);
    expect(result.notAfter?.getUTCFullYear()).toBe(2036);
  });

  it("不覆盖 *.apps:指出缺哪个名字", () => {
    const result = check(fixture("chain-ferry-only.pem"), fixture("leaf.key"));
    expect(result.ok).toBe(false);
    expect(state(result, "domains")).toBe("bad");
    expect(result.items.find((i) => i.key === "domains")?.message).toContain("*.apps.example.com");
  });

  it("私钥不是一对 / 私钥解析不了", () => {
    expect(state(check(fixture("chain.pem"), fixture("other.key")), "key")).toBe("bad");
    expect(state(check(fixture("chain.pem"), "not a key"), "key")).toBe("bad");
  });

  it("只有叶子证书、缺中间证书:证书链不通过", () => {
    const result = check(fixture("leaf.pem"), fixture("leaf.key"));
    expect(state(result, "chain")).toBe("bad");
    expect(result.items.find((i) => i.key === "chain")?.message).toContain("缺中间证书");
  });

  it("根证书不受信任:证书链不通过", () => {
    expect(state(check(fixture("chain.pem"), fixture("leaf.key"), { trusted: [] }), "chain")).toBe("bad");
  });

  it("顺序反了:证书链不通过", () => {
    expect(state(check(fixture("inter.pem") + fixture("leaf.pem"), fixture("leaf.key")), "chain")).toBe("bad");
  });

  it("少于 30 天到期只提醒,过期了不通过", () => {
    const soon = check(fixture("chain.pem"), fixture("leaf.key"), { now: new Date("2036-11-01T00:00:00Z") });
    expect(soon.ok).toBe(true);
    expect(state(soon, "expiry")).toBe("warn");
    const expired = check(fixture("chain.pem"), fixture("leaf.key"), { now: new Date("2037-01-01T00:00:00Z") });
    expect(expired.ok).toBe(false);
    expect(state(expired, "expiry")).toBe("bad");
  });

  it("不是证书:只报解析不了", () => {
    const result = check("hello", fixture("leaf.key"));
    expect(result.ok).toBe(false);
    expect(result.items).toHaveLength(1);
    expect(state(result, "parse")).toBe("bad");
  });

  it("泛域名只匹配一层", () => {
    expect(covers(["*.example.com"], "ferry.example.com")).toBe(true);
    expect(covers(["*.example.com"], "*.apps.example.com")).toBe(false);
    expect(covers(["*.example.com"], "a.apps.example.com")).toBe(false);
    expect(covers(["*.apps.example.com"], "*.apps.example.com")).toBe(true);
    expect(covers(["FERRY.example.com".toLowerCase()], "Ferry.Example.com")).toBe(true);
  });
});
