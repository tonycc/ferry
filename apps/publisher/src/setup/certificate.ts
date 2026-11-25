import { createPrivateKey, X509Certificate } from "node:crypto";
import * as tls from "node:tls";

/**
 * 设置向导第 3 步(和以后控制台的证书页)上传证书时的检查(docs/setup-wizard.md):
 * 能解析、覆盖要求的域名、私钥和证书是一对、证书链完整并能用受信任的根证书验证、还没过期(少于 30 天时提醒)。
 * 每一项都给出结果,页面逐项显示。
 */

export type CheckState = "ok" | "bad" | "warn";

export interface CheckItem {
  key: "parse" | "domains" | "key" | "chain" | "expiry" | "install";
  state: CheckState;
  message: string;
}

export interface CertificateCheck {
  /** 没有不通过的项(提醒不算) */
  ok: boolean;
  items: CheckItem[];
  /** 能解析时才有:叶子证书的到期时间和覆盖的域名 */
  notAfter?: Date;
  domains?: string[];
}

export interface CheckOptions {
  /** 证书要覆盖的名字,如 ferry.example.com、*.apps.example.com */
  required: string[];
  now?: Date;
  /** 受信任的根证书(PEM)。默认是 Node 的默认列表(内置的 + NODE_EXTRA_CA_CERTS 指定的,公司内部 CA 用后者) */
  trusted?: string[];
}

const WARN_DAYS = 30;
const DAY = 86_400_000;

export function checkCertificate(chainPem: string, keyPem: string, options: CheckOptions): CertificateCheck {
  const now = options.now ?? new Date();
  const items: CheckItem[] = [];
  const bad = (key: CheckItem["key"], message: string) => items.push({ key, state: "bad", message });

  let chain: X509Certificate[];
  try {
    chain = splitPem(chainPem).map((pem) => new X509Certificate(pem));
  } catch {
    chain = [];
  }
  if (chain.length === 0) {
    bad("parse", "证书文件解析不了:请上传 PEM 格式(以 -----BEGIN CERTIFICATE----- 开头)的 .pem 或 .crt 文件");
    return { ok: false, items };
  }
  const leaf = chain[0]!;
  const domains = sanNames(leaf);
  items.push({ key: "parse", state: "ok", message: `证书能解析(${chain.length} 段)` });

  const missing = options.required.filter((name) => !covers(domains, name));
  if (missing.length > 0) bad("domains", `不覆盖 ${missing.join("、")}(证书里是 ${domains.join("、") || "空"})`);
  else items.push({ key: "domains", state: "ok", message: `覆盖 ${options.required.join("、")}` });

  try {
    if (leaf.checkPrivateKey(createPrivateKey(keyPem))) items.push({ key: "key", state: "ok", message: "私钥和证书匹配" });
    else bad("key", "私钥和证书不是一对:请上传同一次下载里的 .pem 和 .key");
  } catch {
    bad("key", "私钥文件解析不了:请上传 PEM 格式(以 -----BEGIN … PRIVATE KEY----- 开头)、没有密码保护的 .key 文件");
  }

  const chainProblem = verifyChain(chain, options.trusted ?? defaultTrusted()) ?? staleIssuer(chain.slice(1), now);
  if (chainProblem) bad("chain", chainProblem);
  else items.push({ key: "chain", state: "ok", message: "证书链完整,受信任" });

  const notAfter = new Date(leaf.validTo);
  const notBefore = new Date(leaf.validFrom);
  const days = Math.floor((notAfter.getTime() - now.getTime()) / DAY);
  if (notBefore > now) bad("expiry", `证书 ${date(notBefore)} 才开始生效`);
  else if (notAfter <= now) bad("expiry", `证书已在 ${date(notAfter)} 过期`);
  else if (days < WARN_DAYS) items.push({ key: "expiry", state: "warn", message: `${date(notAfter)} 到期,只剩 ${days} 天` });
  else items.push({ key: "expiry", state: "ok", message: `${date(notAfter)} 到期` });

  return { ok: items.every((i) => i.state !== "bad"), items, notAfter, domains };
}

/** 逐段确认“这一段是下一段签发的”,最后一段要由受信任的根证书签发(或者本身就是受信任的根) */
function verifyChain(chain: X509Certificate[], trustedPem: string[]): string | undefined {
  for (let i = 0; i + 1 < chain.length; i++) {
    const cert = chain[i]!;
    const issuer = chain[i + 1]!;
    if (!cert.checkIssued(issuer) || !cert.verify(issuer.publicKey)) {
      return "证书链的顺序或内容不对:请上传证书服务下载的原始 .pem 文件,不要自己拼接";
    }
  }
  const last = chain[chain.length - 1]!;
  const roots = trustedPem.flatMap((pem) => {
    try {
      return [new X509Certificate(pem)];
    } catch {
      return [];
    }
  });
  const trusted = roots.some(
    (root) => root.fingerprint256 === last.fingerprint256 || (last.checkIssued(root) && last.verify(root.publicKey)),
  );
  if (trusted) return undefined;
  return chain.length === 1
    ? "缺中间证书,很多电脑和手机会提示证书不受信任:请上传证书服务下载的原始 .pem 文件(里面一般有两段证书)"
    : "证书链验证不到受信任的根证书:可能缺中间证书,或者是公司内部 CA 签发的(这时服务器上要设 NODE_EXTRA_CA_CERTS 指向公司的根证书)";
}

/** 中间证书也要在有效期内:过期了浏览器照样不认,哪怕叶子证书还没到期 */
function staleIssuer(issuers: X509Certificate[], now: Date): string | undefined {
  for (const cert of issuers) {
    const name = cert.subject.match(/CN=([^\n,]+)/)?.[1] ?? "中间证书";
    if (new Date(cert.validTo) <= now) return `中间证书 ${name} 已在 ${date(new Date(cert.validTo))} 过期:请重新下载完整的证书文件`;
    if (new Date(cert.validFrom) > now) return `中间证书 ${name} ${date(new Date(cert.validFrom))} 才开始生效`;
  }
  return undefined;
}

function defaultTrusted(): string[] {
  // Node 22.15 起有 getCACertificates("default"):内置列表加 NODE_EXTRA_CA_CERTS;更早的版本只有内置列表
  const api = tls as unknown as { getCACertificates?: (type: string) => string[] };
  return api.getCACertificates ? api.getCACertificates("default") : [...tls.rootCertificates];
}

/** 证书里的 DNS 名字(subjectAltName),全部小写 */
function sanNames(cert: X509Certificate): string[] {
  return (cert.subjectAltName ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("DNS:"))
    .map((part) => part.slice(4).toLowerCase());
}

/**
 * 证书里的名字是否覆盖要求的名字。要求的是泛域名(*.apps.x)时,证书里必须正好有这个泛域名;
 * 要求的是具体名字时,证书里有它本身或者同一层的泛域名(*.x)都行。泛域名只匹配一层
 */
export function covers(names: string[], required: string): boolean {
  const want = required.toLowerCase();
  if (names.includes(want)) return true;
  if (want.startsWith("*.")) return false;
  const parent = want.slice(want.indexOf(".") + 1);
  return names.includes(`*.${parent}`);
}

function splitPem(pem: string): string[] {
  return pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}

function date(d: Date): string {
  return d.toISOString().slice(0, 10);
}
