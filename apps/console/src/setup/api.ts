/** 设置向导的接口(apps/publisher/src/api/setup-routes.ts)。都是同源请求,浏览器自动带上向导会话的 cookie */

export type CheckState = "ok" | "bad" | "warn";

export interface CheckItem {
  key: string;
  state: CheckState;
  message: string;
}

export interface WizardDomain {
  domain: string;
  ferryHost: string;
  appsDomain: string;
  serverIp: string;
}

export interface SetupStatus {
  initialized: boolean;
  session: boolean;
  suggestedIp?: string;
  wizard?: {
    domain?: WizardDomain;
    certificate?: { notAfter: string; domains: string[] };
    certificateSkipped: boolean;
    publicUrl?: string;
    httpConfirmed: boolean;
    admin?: { name: string; orgName: string };
    selfCheck?: "passed" | "skipped";
  };
}

export interface DomainResult {
  ok: boolean;
  items: CheckItem[];
  hint?: string;
  domain: WizardDomain;
}

export interface CertificateResult {
  ok: boolean;
  installed: boolean;
  items: CheckItem[];
  notAfter?: string;
  domains?: string[];
}

export class SetupError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { message?: string };
  if (!response.ok) throw new SetupError(response.status, data.message ?? `请求失败(${response.status})`);
  return data as T;
}

export const setupApi = {
  status: () => request<SetupStatus>("GET", "/api/setup/status"),
  ping: () => request<{ instance: string }>("GET", "/api/setup/ping"),
  code: (code: string) => request<{ ok: true }>("POST", "/api/setup/code", { code }),
  domain: (input: { domain: string; ferrySub: string; appsSub: string; serverIp: string }) =>
    request<DomainResult>("POST", "/api/setup/domain", input),
  certificate: (certificate: string, privateKey: string) =>
    request<CertificateResult>("POST", "/api/setup/certificate", { certificate, privateKey }),
  skipCertificate: () => request<{ ok: true }>("POST", "/api/setup/certificate/skip", {}),
  switchAddress: () => request<{ publicUrl: string; handoff: boolean }>("POST", "/api/setup/switch", {}),
  undoSwitch: () => request<{ ok: true }>("POST", "/api/setup/switch/undo", {}),
  handoff: () => request<{ token: string }>("POST", "/api/setup/handoff", {}),
  redeem: (token: string) => request<{ ok: true }>("POST", "/api/setup/handoff/redeem", { token }),
  confirmHttp: () => request<{ ok: true }>("POST", "/api/setup/switch/confirm", {}),
  admin: (input: { orgName: string; name: string; mobile: string; password: string }) =>
    request<{ name: string; orgName: string; created: boolean }>("POST", "/api/setup/admin", input),
  skipSelfCheck: () => request<{ ok: true }>("POST", "/api/setup/selfcheck/skip", {}),
  complete: () => request<{ publicUrl: string }>("POST", "/api/setup/complete", {}),
};

/**
 * 等 Ferry 重启完:本进程标识变了才算起来了。切换前没拿到旧标识(previous 是 undefined)时,
 * 要先看到一次连不上(旧进程退出了),或者已经过了 3 秒(旧进程回完话 0.5 秒就退出),再连上才算,
 * 免得把旧进程退出前的最后一次回答当成新进程。超时返回 false
 */
export async function waitForRestart(previous: string | undefined, timeoutMs = 120_000): Promise<boolean> {
  const start = Date.now();
  let sawDown = false;
  while (Date.now() - start < timeoutMs) {
    await sleep(1500);
    const now = await setupApi.ping().catch(() => undefined);
    if (!now) sawDown = true;
    else if (previous ? now.instance !== previous : sawDown || Date.now() - start >= 3000) return true;
  }
  return false;
}

/**
 * 浏览器能不能打开正式地址:跨域的 no-cors 请求,读不到内容,但请求成功说明能解析、连得上、证书可信(https 时)。
 * 页面在 https 上时浏览器会拦截发往 http 的请求,所以只用来检查 https 地址
 */
export async function canOpen(url: string, timeoutMs = 8000): Promise<boolean> {
  try {
    await fetch(`${url}/api/setup/ping`, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
