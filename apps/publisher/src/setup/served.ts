import { connect } from "node:tls";

/** Traefik 对某个域名实际出示的证书 */
export interface ServedCertificate {
  notAfter: Date;
  /** 证书覆盖的域名(SAN 里的 DNS 名) */
  domains: string[];
  /** Traefik 没有匹配的证书时出示自己的默认证书(自签名) */
  traefikDefault: boolean;
}

/**
 * 按域名(SNI)连一次 Traefik 的 https 入口,读出它出示的证书。不校验证书:要看的就是它出示了什么,
 * 包括已经过期的、手动在 Dokploy 上装的(Ferry 没有记录的)。连不上时返回 undefined
 */
export function servedCertificate(gatewayHost: string, port: number, host: string, timeoutMs = 5000): Promise<ServedCertificate | undefined> {
  return new Promise((resolve) => {
    const socket = connect({ host: gatewayHost, port, servername: host, rejectUnauthorized: false, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert || !cert.valid_to) return resolve(undefined);
      const domains = (cert.subjectaltname ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.startsWith("DNS:"))
        .map((s) => s.slice(4).toLowerCase());
      const commonName = typeof cert.subject?.CN === "string" ? cert.subject.CN : "";
      resolve({ notAfter: new Date(cert.valid_to), domains, traefikDefault: commonName === "TRAEFIK DEFAULT CERT" });
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(undefined);
    });
    socket.on("error", () => resolve(undefined));
  });
}
