import { randomInt } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hashPassword, verifyPassword } from "../auth/password";
import type { SetupStore } from "./store";

/** 12 位,只用大写字母和数字,去掉了容易看错的 0 O 1 I L;每 4 位一组方便抄写 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 12;

export function generateSetupCode(): string {
  const chars = Array.from({ length: LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map((g) => g.join("")).join("-");
}

/** 输入时不区分大小写,分组用的 - 和空格可有可无 */
export function normalizeSetupCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * 未初始化时确保有设置码:数据库里只存哈希,明文写在服务器上的文件里(chmod 600),不打进日志
 * (日志保留时间长、看得到的人多)。
 *
 * 已有哈希、文件也在且对得上时沿用,重启 Ferry 不换设置码。文件丢了或对不上时只能换一个新的:
 * 数据库里只有哈希,找不回原来的明文。
 */
export async function ensureSetupCode(store: SetupStore, file: string, log: (message: string) => void): Promise<void> {
  const { setupCodeHash } = await store.getSettings();
  const existing = await readFile(file, "utf8").then(
    (text) => normalizeSetupCode(text),
    () => undefined,
  );
  if (setupCodeHash && existing && (await verifyPassword(existing, setupCodeHash))) {
    log(`Ferry 还没有完成初始化。设置码在 ${file}`);
    return;
  }
  const code = generateSetupCode();
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${code}\n`, { mode: 0o600 });
  // writeFile 的 mode 只在新建文件时生效,覆盖已有文件时要再设一次
  await chmod(file, 0o600);
  await store.setSetupCodeHash(await hashPassword(normalizeSetupCode(code)));
  log(`Ferry 还没有完成初始化。新的设置码已写入 ${file}`);
}

/** 完成初始化后删掉设置码文件(设置码随之作废) */
export async function removeSetupCodeFile(file: string): Promise<void> {
  await rm(file, { force: true });
}
