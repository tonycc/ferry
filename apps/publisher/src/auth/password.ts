import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { UserError } from "../errors";

/**
 * 登录密码的哈希和校验(scrypt)。哈希字符串里带着参数和盐:scrypt$N$r$p$盐$哈希,
 * 以后调高参数时旧密码照样能校验。
 */

const KEY_LENGTH = 32;
const PARAMS = { N: 16384, r: 8, p: 1 };
export const MIN_PASSWORD_LENGTH = 8;
/** 超长的输入不交给 scrypt,免得被用来消耗服务器 CPU */
export const MAX_PASSWORD_LENGTH = 128;

function scrypt(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, KEY_LENGTH, { ...options, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, PARAMS);
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const key = await scrypt(password, Buffer.from(salt, "base64url"), { N: Number(n), r: Number(r), p: Number(p) });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** 账号不存在时也算一次哈希,让响应时间和密码错误时一样,登录页不能用来探测谁是员工 */
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(password.slice(0, MAX_PASSWORD_LENGTH), await dummyHash);
}

/** 员工自己设置的新密码要满足的条件;不满足时抛出可以直接显示给员工的错误 */
export function checkNewPassword(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new UserError("invalid_input", `新密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new UserError("invalid_input", `新密码最多 ${MAX_PASSWORD_LENGTH} 位`);
  }
  if (/^\d+$/.test(password)) throw new UserError("invalid_input", "新密码不能全是数字");
}

/** 管理员生成的初始密码:12 位,去掉了容易看错的字符(0 O 1 l I),每 4 位一组方便转述 */
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generateInitialPassword(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map((g) => g.join("")).join("-");
}
