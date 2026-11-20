import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeZip } from "../test/zip";
import { GitleaksScanner } from "./gitleaks";

/**
 * 用真实的 gitleaks 扫描。没装 gitleaks 时跳过;CI 里设了 GITLEAKS_REQUIRED=1,没装就失败。
 * 测试里的假密钥在运行时拼出来,仓库里不出现完整的密钥样式(也避免被代码托管平台的推送保护拦下)。
 */
const binary = process.env.GITLEAKS_PATH ?? "gitleaks";
const installed = (() => {
  try {
    execFileSync(binary, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
if (!installed && process.env.GITLEAKS_REQUIRED === "1") {
  throw new Error(`GITLEAKS_REQUIRED=1,但找不到 gitleaks(${binary})`);
}

const hex = (n: number, seed: number) =>
  Array.from({ length: n }, (_, i) => "0123456789abcdef"[(i * 7 + seed * 13 + ((i * i) % 5)) % 16]).join("");
const dingtalk = `https://oapi.dingtalk.com/robot/send?access_token=${hex(64, 1)}`;
const llmKey = ["sk", "-", "4f8e2a1b9c7d6e5f", "3a2b1c0d9e8f7a6b"].join("");
const dbUrl = ["postgres://admin", ":S3cretPassw0rd", "@db.internal:5432/app"].join("");
const base = { "app.yaml": "name: demo\ntemplate: node-postgres\n", Dockerfile: "FROM node:22\n" };

describe.skipIf(!installed)("GitleaksScanner(真实 gitleaks)", () => {
  const scanner = new GitleaksScanner({ binary });

  it("干净的代码包:没有发现", async () => {
    const zip = makeZip({
      ...base,
      "src/server.ts": "const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });\n",
      "src/db.ts": "const url = `postgres://${user}:${password}@${host}/db`;\nconst ex = 'postgres://user:password@localhost/db';\n",
    });
    expect(await scanner.scan(zip)).toEqual([]);
  });

  it("报告文件、行号和种类,不带密钥原文", async () => {
    const zip = makeZip({
      ...base,
      "src/notify.ts": `// 发到群里\nconst url = "${dingtalk}";\n`,
      "src/ai.ts": `const client = new OpenAI({ apiKey: "${llmKey}" });\n`,
      "src/db.ts": `\n\nconst db = "${dbUrl}";\n`,
      ".env": `DEEPSEEK_API_KEY=${llmKey}\n`,
    });

    const findings = await scanner.scan(zip);

    const byFile = Object.fromEntries(findings.map((f) => [f.file, f]));
    expect(byFile["src/notify.ts"]).toMatchObject({ line: 2, rule: "dingtalk-robot-webhook" });
    expect(byFile["src/ai.ts"]).toMatchObject({ line: 1 });
    expect(byFile["src/db.ts"]).toMatchObject({ line: 3, rule: "connection-string-password" });
    expect(byFile[".env"]).toBeDefined();
    const text = JSON.stringify(findings);
    expect(text).not.toContain(hex(64, 1));
    expect(text).not.toContain("3a2b1c0d9e8f7a6b");
    expect(text).not.toContain("S3cretPassw0rd");
  });

  it("代码包自己控制的豁免都不起作用:gitleaks:allow、.gitleaks.toml、.gitleaksignore", async () => {
    const zip = makeZip({
      ...base,
      "src/notify.ts": `const url = "${dingtalk}"; // gitleaks:allow\n`,
      ".gitleaks.toml": '[allowlist]\npaths = [".*"]\n',
      ".gitleaksignore": "src/notify.ts:dingtalk-robot-webhook:1\n",
    });
    const findings = await scanner.scan(zip);
    expect(findings.map((f) => f.file)).toContain("src/notify.ts");
  });

  it("node_modules 里的不算(依赖由构建时安装,不是员工写的代码)", async () => {
    const zip = makeZip({ ...base, "node_modules/x/index.js": `const k = "${dingtalk}";\n` });
    expect(await scanner.scan(zip)).toEqual([]);
  });

  it("不是合法 zip:报错,不当作没有密钥", async () => {
    await expect(scanner.scan(Buffer.from("not a zip"))).rejects.toThrow("不是合法的 zip");
  });

  it("扫描超时:报错,不当作没有密钥", async () => {
    const slow = new GitleaksScanner({ binary, timeoutMs: 1 });
    await expect(slow.scan(makeZip({ ...base, "src/a.ts": `const url = "${dingtalk}";\n` }))).rejects.toThrow("超时");
  });

  it("找不到 gitleaks:报错,不当作没有密钥", async () => {
    const missing = new GitleaksScanner({ binary: "/nonexistent/gitleaks" });
    await expect(missing.scan(makeZip(base))).rejects.toThrow("找不到 gitleaks");
    await expect(missing.version()).rejects.toThrow("找不到 gitleaks");
  });
});
