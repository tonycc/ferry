import { describe, expect, it } from "vitest";
import { parseManifest } from "./index";

describe("parseManifest", () => {
  it("接受合法清单并补全默认值", () => {
    const result = parseManifest("name: expense-tracker\ntemplate: node-postgres\n");
    expect(result).toEqual({
      ok: true,
      manifest: {
        name: "expense-tracker",
        template: "node-postgres",
        port: 3000,
        healthcheck: "/healthz",
        database: "none",
        visibility: "self",
      },
    });
  });

  it("拒绝不能做域名的应用名", () => {
    const result = parseManifest("name: My_App\ntemplate: node-postgres\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toContain("name");
  });

  it("报告 YAML 语法错误", () => {
    const result = parseManifest("name: [unclosed");
    expect(result.ok).toBe(false);
  });
});
