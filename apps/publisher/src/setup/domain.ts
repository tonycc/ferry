import { randomBytes } from "node:crypto";
import { isIPv4 } from "node:net";
import { UserError } from "../errors";
import type { CheckItem as CertCheckItem } from "./certificate";
import type { WizardDomain } from "./store";

/**
 * 设置向导第 2 步的检测(docs/setup-wizard.md),都在服务器上做:
 * 1. Ferry 的域名和应用泛域名下的一个随机名字,都要解析到服务器 IP;
 * 2. 用 Ferry 的域名经 Traefik 的 80 端口请求 /api/setup/ping,拿回本进程的标识,证明解析到的就是这台服务器、Traefik 能转过来。
 */

export interface DomainInput {
  domain: string;
  ferrySub: string;
  appsSub: string;
  serverIp: string;
}

export interface DomainCheckItem {
  key: "ferry" | "apps" | "reach";
  state: CertCheckItem["state"];
  message: string;
}

export interface DomainCheck {
  ok: boolean;
  items: DomainCheckItem[];
  /** 没通过时一句话怎么改 */
  hint?: string;
  domain: WizardDomain;
}

export interface DomainDeps {
  /** 解析成 IPv4 地址;解析不到返回空数组 */
  lookup(host: string): Promise<string[]>;
  /** 请求 http://<host>/api/setup/ping,返回对方的进程标识;请求不到返回 undefined */
  ping(host: string): Promise<string | undefined>;
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** 校验并规范化输入,不对时抛出说明哪一项不对的错误 */
export function normalizeDomain(input: DomainInput): WizardDomain {
  const domain = input.domain.trim().toLowerCase().replace(/\.$/, "");
  const ferrySub = input.ferrySub.trim().toLowerCase();
  const appsSub = input.appsSub.trim().toLowerCase();
  const serverIp = input.serverIp.trim();
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) throw new UserError("invalid_input", `公司域名 ${input.domain} 格式不对,如 example.com`);
  if (!LABEL.test(ferrySub)) throw new UserError("invalid_input", `Ferry 子域名 ${input.ferrySub} 格式不对,只能有字母、数字和 -`);
  if (!LABEL.test(appsSub)) throw new UserError("invalid_input", `应用子域名 ${input.appsSub} 格式不对,只能有字母、数字和 -`);
  if (ferrySub === appsSub) throw new UserError("invalid_input", "Ferry 子域名和应用子域名不能一样");
  if (!isIPv4(serverIp)) throw new UserError("invalid_input", `服务器 IP ${input.serverIp} 格式不对,如 10.0.0.5`);
  return { domain, ferryHost: `${ferrySub}.${domain}`, appsDomain: `${appsSub}.${domain}`, serverIp };
}

export async function checkDomain(input: DomainInput, deps: DomainDeps, instanceId: string): Promise<DomainCheck> {
  const d = normalizeDomain(input);
  const probe = `ferry-check-${randomBytes(4).toString("hex")}.${d.appsDomain}`;
  const [ferryIps, appsIps] = await Promise.all([deps.lookup(d.ferryHost), deps.lookup(probe)]);
  const items: DomainCheckItem[] = [];
  let hint: string | undefined;
  const ferrySub = d.ferryHost.split(".")[0]!;
  const appsSub = d.appsDomain.split(".")[0]!;

  const resolved = (key: "ferry" | "apps", shown: string, ips: string[], record: string) => {
    if (ips.includes(d.serverIp)) {
      items.push({ key, state: "ok", message: `${shown} → ${d.serverIp}` });
      return true;
    }
    if (ips.length === 0) {
      items.push({ key, state: "bad", message: `${shown}:没有记录` });
      hint ??= key === "ferry"
        ? `刚加完就等一两分钟再测。主机记录只填 ${record},不要带域名。`
        : `还差一条:主机记录 ${record},类型 A。`;
    } else {
      items.push({ key, state: "bad", message: `${shown} → ${ips.join("、")},应为 ${d.serverIp}` });
      hint ??= `把 ${record} 的记录值改成 ${d.serverIp}。`;
    }
    return false;
  };
  const ferryOk = resolved("ferry", d.ferryHost, ferryIps, ferrySub);
  const appsOk = resolved("apps", `*.${d.appsDomain}`, appsIps, `*.${appsSub}`);

  if (ferryOk && appsOk) {
    const answer = await deps.ping(d.ferryHost);
    if (answer === instanceId) items.push({ key: "reach", state: "ok", message: "请求能到达这台服务器" });
    else {
      items.push({ key: "reach", state: "bad", message: answer ? "请求到了另一个 Ferry" : "请求到不了这台服务器" });
      hint = `确认 ${d.serverIp} 是这台服务器的内网地址,且防火墙放行了 80、443 端口。`;
    }
  }
  return { ok: items.every((i) => i.state === "ok") && items.length === 3, items, hint, domain: d };
}

/** 用浏览器打开向导时的地址猜服务器 IP:Host 头是 IPv4 地址时就用它 */
export function suggestServerIp(hostHeader: string | undefined): string | undefined {
  const host = hostHeader?.replace(/:\d+$/, "");
  return host && isIPv4(host) ? host : undefined;
}
