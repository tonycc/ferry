import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { RESERVED_ENV_NAMES as RESERVED, secretNameProblem } from "@ferry/manifest/secrets";
import { UserError } from "./errors";

/**
 * 应用密钥(任务 3.8):员工在控制台上给应用配置的第三方密钥,如大模型 API key、群机器人 webhook。
 * 值只在浏览器里输入,加密后存进数据库,每次发布和回滚时注入应用的环境变量;
 * 保存后不再显示,也不经过 agent 和 MCP。
 */

/** Ferry 自己注入的环境变量,不能被应用密钥覆盖(名称规则和控制台共用,见 @ferry/manifest/secrets) */
export const RESERVED_ENV_NAMES: readonly string[] = RESERVED;
export const MAX_SECRETS_PER_APP = 50;
export const MAX_SECRET_VALUE_BYTES = 8 * 1024;

export function validateSecretName(name: string): void {
  const problem = secretNameProblem(name);
  if (problem) throw new UserError("invalid_input", problem);
}

export function validateSecretValue(value: string): void {
  if (value.length === 0) throw new UserError("invalid_input", "值不能为空");
  if (Buffer.byteLength(value, "utf8") > MAX_SECRET_VALUE_BYTES) {
    throw new UserError("invalid_input", `值不能超过 ${MAX_SECRET_VALUE_BYTES / 1024} KB`);
  }
  // 环境变量按行保存,值里有换行就能伪造出别的变量(如 DATABASE_URL)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new UserError("invalid_input", "值只能是一行,不能有换行等控制字符(多行的私钥文件目前不支持)");
  }
  // 部署平台(Dokploy)会把 ${{名称}} 当成引用别的变量去替换,找不到就部署失败
  if (value.includes("${{")) throw new UserError("invalid_input", "值里不能有 ${{");
  // 带 #、首尾空格、引号开头的值要加引号才能原样传给应用(见 adapters/dokploy.ts 的 formatEnv),
  // 单引号和反引号都有时没有能用的引号
  if (value.includes("'") && value.includes("`")) {
    throw new UserError("invalid_input", "值里不能同时有单引号 ' 和反引号 `");
  }
}

const VERSION = "v1";

/**
 * 用 AES-256-GCM 加密密钥的值。应用名和密钥名作为附加认证数据:
 * 数据库里的密文挪到别的应用或别的名称下会解密失败,不会被注入到别的应用。
 */
export class SecretBox {
  private readonly key: Buffer;

  /** secret 至少 32 个字符,如 openssl rand -hex 32 的输出 */
  constructor(secret: string) {
    if (secret.length < 32) throw new Error("SECRETS_KEY 至少要 32 个字符");
    this.key = createHash("sha256").update(secret, "utf8").digest();
  }

  static random(): SecretBox {
    return new SecretBox(randomBytes(32).toString("hex"));
  }

  encrypt(appName: string, name: string, value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(aad(appName, name));
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [VERSION, iv, cipher.getAuthTag(), data].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
  }

  /** 解密失败时抛出的错误不含密文和原文 */
  decrypt(appName: string, name: string, ciphertext: string): string {
    const [version, iv, tag, data] = ciphertext.split(".");
    try {
      if (version !== VERSION || !iv || !tag || data === undefined) throw new Error("format");
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
      decipher.setAAD(aad(appName, name));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      throw new Error(`应用 ${appName} 的密钥 ${name} 解密失败(SECRETS_KEY 可能被改过)`);
    }
  }
}

function aad(appName: string, name: string): Buffer {
  return Buffer.from(`${appName}\u0000${name}`, "utf8");
}
