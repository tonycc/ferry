import { lookup } from "node:dns/promises";

/**
 * 设置向导在服务器上做的真实检测:解析域名、请求 /api/setup/ping。
 * 解析用系统的解析方式(和 curl、浏览器一样,会读 /etc/hosts),只要 IPv4
 */

export async function lookupIpv4(host: string): Promise<string[]> {
  try {
    const answers = await lookup(host, { family: 4, all: true });
    return [...new Set(answers.map((a) => a.address))];
  } catch {
    return [];
  }
}

/**
 * 请求 <scheme>://<host>/api/setup/ping,返回对方的进程标识;请求不到、超时或者返回的不是 Ferry 时返回 undefined。
 * https 时照常校验证书(不跳过),证书不对就是请求不到
 */
export async function pingFerry(scheme: "http" | "https", host: string, timeoutMs = 5000): Promise<string | undefined> {
  try {
    const response = await fetch(`${scheme}://${host}/api/setup/ping`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { instance?: unknown };
    return typeof body.instance === "string" ? body.instance : undefined;
  } catch {
    return undefined;
  }
}
