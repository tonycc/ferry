import { isIP } from "node:net";
import type { DeployPlatform } from "../adapters/types";
import { type CertificateCheck, type CheckItem, checkCertificate } from "./certificate";
import type { ServedCertificate } from "./served";
import type { SetupStore } from "./store";

/**
 * 控制台的“证书”页(docs/setup-wizard.md“一并要做的”):查看证书、到期提醒、替换证书,
 * 以及向导里跳过证书(先用 HTTP)之后补装证书并切到 https。检查和安装和向导第 3 步一样。
 */

export interface CertificateManagerOptions {
  store: SetupStore;
  platform: Pick<DeployPlatform, "installCertificate" | "ensureGateway">;
  /** 这次启动用的地址配置 */
  publicUrl: string;
  appsDomain: string;
  /** PUBLIC_URL 或 APPS_URL_SCHEME 写在服务器的 .env 里:Ferry 改不了,切到 https 要人去改 .env */
  fixedByEnv: boolean;
  /** Traefik 访问 /authz 的地址:装证书后重写网关配置,触发 Traefik 重新加载 */
  authAddress: string;
  /** Traefik 对某个域名实际出示的证书;连不上时 undefined */
  served(host: string): Promise<ServedCertificate | undefined>;
  /** 切到 https 后让 Ferry 退出,由 Docker 拉起来按新配置启动 */
  restart(): void;
  /** 记审计日志(装证书的管理员) */
  audit?(actorId: string, detail: Record<string, unknown>): Promise<void>;
  /** 证书检查用的受信任根证书;默认 Node 的列表 */
  trusted?: string[];
  verifyAttempts?: number;
  verifyIntervalMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export type CertificateLevel = "ok" | "expiring" | "urgent" | "expired" | "none";

export interface CertificateStatus {
  ferryHost: string;
  appsDomain: string;
  /** Ferry 现在是不是用 https */
  https: boolean;
  fixedByEnv: boolean;
  /** 现在在用的证书:优先看 Traefik 实际出示的(手动在 Dokploy 上装的也能看到),读不到时用 Ferry 记下的 */
  certificate?: { notAfter: Date; domains: string[] };
  daysLeft?: number;
  /** ok;expiring 不到 30 天;urgent 不到 7 天;expired 已过期;none 还没有证书 */
  level: CertificateLevel;
  /** 在控制台从 http 切到 https 的时间 */
  httpsSince?: Date;
}

export interface InstallResult extends CertificateCheck {
  /** 装好并且 Traefik 已经用上了 */
  installed: boolean;
  /** 同时切到了 https,Ferry 正在重启;页面等它起来后跳到这个地址 */
  switchedTo?: string;
}

const DAY = 24 * 3600_000;

export class CertificateManager {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly ferryHost: string;
  private readonly https: boolean;
  /** 已经提醒过的到期时间(不到 30 天时每张证书提醒一次;不到 7 天时每天都提醒) */
  private warnedFor?: number;

  constructor(private readonly options: CertificateManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const url = new URL(options.publicUrl);
    this.ferryHost = url.hostname;
    this.https = url.protocol === "https:";
  }

  private get required(): string[] {
    return [this.ferryHost, `*.${this.options.appsDomain}`];
  }

  async status(): Promise<CertificateStatus> {
    const settings = await this.options.store.getSettings();
    // Ferry 的域名和应用的泛域名可能是两张证书(手动部署时常见):都读,按先过期的那张算
    const served = (
      await Promise.all([this.ferryHost, `ferry-selfcheck.${this.options.appsDomain}`].map((host) => this.options.served(host)))
    ).filter((c): c is ServedCertificate => !!c && !c.traefikDefault);
    const earliest = [...served].sort((a, b) => a.notAfter.getTime() - b.notAfter.getTime())[0];
    const certificate = earliest
      ? { notAfter: earliest.notAfter, domains: [...new Set(served.flatMap((c) => c.domains))] }
      : settings.certificate
        ? { notAfter: settings.certificate.notAfter, domains: settings.certificate.domains }
        : undefined;
    const daysLeft = certificate ? Math.floor((certificate.notAfter.getTime() - this.now().getTime()) / DAY) : undefined;
    const level: CertificateLevel =
      daysLeft === undefined ? "none" : daysLeft < 0 ? "expired" : daysLeft < 7 ? "urgent" : daysLeft < 30 ? "expiring" : "ok";
    return {
      ferryHost: this.ferryHost,
      appsDomain: this.options.appsDomain,
      https: this.https,
      fixedByEnv: this.options.fixedByEnv,
      certificate,
      daysLeft,
      level,
      httpsSince: settings.httpsSince,
    };
  }

  /**
   * 检查、装进 Traefik,再确认 Traefik 出示的就是这张。Ferry 还在用 http、地址又不是写在 .env 里时,
   * 同时切到 https:写入 https 的地址配置,Ferry 重启后已有应用的域名也一起改成 https。私钥只交给部署平台,不保存
   */
  /** 给所有登录的人看的:是不是 https、什么时候切过去的(个人令牌页据此提醒改 MCP 地址)。不连 Traefik */
  async info(): Promise<{ https: boolean; httpsSince?: Date }> {
    return { https: this.https, httpsSince: (await this.options.store.getSettings()).httpsSince };
  }

  async install(actorId: string, chain: string, privateKey: string): Promise<InstallResult> {
    if (isIP(this.ferryHost)) {
      return {
        ok: false,
        installed: false,
        items: [{ key: "domains", state: "bad", message: `Ferry 的地址是 IP(${this.ferryHost}):HTTPS 要用域名,先在 .env 里把 PUBLIC_URL 改成域名` }],
      };
    }
    const check = checkCertificate(chain, privateKey, { required: this.required, now: this.now(), trusted: this.options.trusted });
    if (!check.ok) return { ...check, installed: false };

    const settings = await this.options.store.getSettings();
    const id = await this.options.platform.installCertificate({
      name: `ferry-${this.ferryHost.split(".").slice(1).join(".")}`,
      chain,
      privateKey,
      id: settings.certificate?.id,
    });
    await this.options.platform.ensureGateway({ authAddress: this.options.authAddress });
    await this.options.store.setCertificate({ id, notAfter: check.notAfter!, domains: check.domains! });

    // Traefik 几秒内加载新证书;覆盖同样域名的旧证书(比如手动在 Dokploy 上装的另一张)还在时,出示哪张不确定
    const attempts = this.options.verifyAttempts ?? 10;
    let served: ServedCertificate | undefined;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await this.sleep(this.options.verifyIntervalMs ?? 2000);
      served = await this.options.served(this.ferryHost);
      if (served && served.notAfter.getTime() === check.notAfter!.getTime()) break;
    }
    const installed = !!served && served.notAfter.getTime() === check.notAfter!.getTime();
    const item: CheckItem = installed
      ? { key: "install", state: "ok", message: `${this.ferryHost} 已使用这张证书` }
      : {
          key: "install",
          state: "bad",
          message: served
            ? `${this.ferryHost} 出示的还是另一张证书(${date(served.notAfter)} 到期):Dokploy 里可能还有一张覆盖同样域名的旧证书,到 Dokploy 的“证书”页删掉它后再上传`
            : `连不上 ${this.ferryHost} 的 https:查看 Traefik 是否在运行`,
        };
    const items = [...check.items, item];
    if (!installed) return { ...check, ok: false, installed, items };

    const switching = !this.https && !this.options.fixedByEnv;
    await this.options.audit?.(actorId, { notAfter: check.notAfter!.toISOString(), domains: check.domains, switchedToHttps: switching });
    if (switching) {
      const publicUrl = `https://${this.ferryHost}`;
      await this.options.store.switchToHttps({ publicUrl, appsDomain: this.options.appsDomain, appsUrlScheme: "https" }, this.now());
      this.options.restart();
      return { ...check, ok: true, installed, items, switchedTo: publicUrl };
    }
    if (!this.https) {
      items.push({
        key: "switch",
        state: "warn",
        message: "地址写在服务器的 .env 里:把 PUBLIC_URL 改成 https://…、APPS_URL_SCHEME 改成 https,再重启 Ferry",
      });
    }
    return { ...check, ok: true, installed, items };
  }

  /**
   * 每天调用一次:不到 30 天时提醒一次(每张证书一次),不到 7 天和已过期时每次都提醒。还没有证书时不提醒(控制台上有常驻提示)
   */
  async remind(send: (message: string) => Promise<void>): Promise<void> {
    const status = await this.status();
    if (!status.certificate || status.level === "ok" || status.level === "none") return;
    const at = status.certificate.notAfter.getTime();
    if (status.level === "expiring" && this.warnedFor === at) return;
    this.warnedFor = at;
    const when = status.level === "expired" ? `已经在 ${date(status.certificate.notAfter)} 过期` : `还有 ${status.daysLeft} 天过期(${date(status.certificate.notAfter)})`;
    await send(`HTTPS 证书${when},过期后 Ferry 和所有应用都打不开:请尽快在控制台“证书”页上传新证书`);
  }
}

function date(d: Date): string {
  return d.toISOString().slice(0, 10);
}
