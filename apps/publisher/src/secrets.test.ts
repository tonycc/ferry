import { describe, expect, it } from "vitest";
import { SecretBox, validateSecretName, validateSecretValue } from "./secrets";

describe("SecretBox", () => {
  const box = new SecretBox("k".repeat(32));

  it("加密后能解密回原文;同一个值每次的密文都不同,密文里没有原文", () => {
    const a = box.encrypt("ledger", "LLM_API_KEY", "sk-0123456789");
    const b = box.encrypt("ledger", "LLM_API_KEY", "sk-0123456789");
    expect(a).not.toBe(b);
    expect(a).not.toContain("sk-0123456789");
    expect(box.decrypt("ledger", "LLM_API_KEY", a)).toBe("sk-0123456789");
    expect(box.decrypt("ledger", "K", box.encrypt("ledger", "K", "中文 和 emoji 🚀"))).toBe("中文 和 emoji 🚀");
  });

  it("密文挪到别的应用或别的名称下、被改动、或换了密钥,都解不开;报错里没有密文", () => {
    const blob = box.encrypt("ledger", "LLM_API_KEY", "sk-0123456789");
    expect(() => box.decrypt("other", "LLM_API_KEY", blob)).toThrow("解密失败");
    expect(() => box.decrypt("ledger", "OTHER", blob)).toThrow("解密失败");
    expect(() => new SecretBox("z".repeat(32)).decrypt("ledger", "LLM_API_KEY", blob)).toThrow("解密失败");
    const parts = blob.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => box.decrypt("ledger", "LLM_API_KEY", parts.join("."))).toThrow("解密失败");
    expect(() => box.decrypt("ledger", "LLM_API_KEY", "garbage")).toThrow("解密失败");
    try {
      box.decrypt("other", "LLM_API_KEY", blob);
    } catch (err) {
      expect((err as Error).message).not.toContain(blob.split(".")[3]!);
    }
  });

  it("密钥太短时拒绝", () => {
    expect(() => new SecretBox("short")).toThrow("至少要 32 个字符");
  });
});

describe("名称和值的检查", () => {
  it("名称:大写字母开头,只有大写字母、数字和下划线;不能用 Ferry 自己的变量", () => {
    for (const ok of ["LLM_API_KEY", "DINGTALK_WEBHOOK", "A", "KEY_2"]) expect(() => validateSecretName(ok)).not.toThrow();
    for (const bad of ["llm", "_KEY", "2KEY", "A B", "A-B", "", "A".repeat(65)]) expect(() => validateSecretName(bad)).toThrow();
    for (const reserved of ["DATABASE_URL", "PORT", "FERRY_X"]) expect(() => validateSecretName(reserved)).toThrow("Ferry");
  });

  it("值:非空、一行、不超过 8 KB", () => {
    expect(() => validateSecretValue("https://oapi.dingtalk.com/robot/send?access_token=abc&x=1 ")).not.toThrow();
    expect(() => validateSecretValue("")).toThrow();
    expect(() => validateSecretValue("a\nB=c")).toThrow("一行");
    expect(() => validateSecretValue("a\rb")).toThrow("一行");
    expect(() => validateSecretValue("a\u0000b")).toThrow("一行");
    expect(() => validateSecretValue("x".repeat(8192))).not.toThrow();
    expect(() => validateSecretValue("x".repeat(8193))).toThrow("不能超过");
  });
});
