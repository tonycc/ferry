import { createHash, randomBytes } from "node:crypto";
import type { DeployPlatform } from "../adapters/types";
import { UserError } from "../errors";
import { type CertificateCheck, type CheckItem, checkCertificate, covers } from "./certificate";
import { checkDomain, type DomainCheck, type DomainDeps, type DomainInput } from "./domain";
import type { CertificateInfo, SetupStore, WizardDomain, WizardState } from "./store";

/**
 * 设置向导第 2 到 4 步(docs/setup-wizard.md):检测域名、上传或跳过证书、切到正式地址。
 * 调用方(路由)负责检查向导会话和请求来源;这里只管每一步的规则和顺序。
 */

export interface WizardOptions {
  /** 本进程的标识,/api/setup/ping 返回它,第 2 步据此确认请求到的是这台服务器上的这个 Ferry */
  instanceId: string;
  /** Traefik 访问 /authz 的地址;装证书后重写网关配置触发 Traefik 加载要用 */
  authAddress: string;
  dns: DomainDeps;
  /** 用 https 请求 Ferry 的域名(校验证书,不跳过),返回对方的进程标识;请求不到返回 undefined */
  httpsPing(host: string): Promise<string | undefined>;
  /** 第 4 步保存后让 Ferry 退出,由 Docker 拉起来按新配置启动 */
  restart(): void;
  /** 证书检查用的受信任根证书;默认 Node 的列表 */
  trusted?: string[];
  /** 装好证书后等 Traefik 加载:最多试几次、每次间隔多久 */
  verifyAttempts?: number;
  verifyIntervalMs?: number;
  handoffTtlMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface WizardStatus {
  /** 第 2 步检测通过的域名 */
  domain?: WizardDomain;
  /** 装好的证书 */
  certificate?: { notAfter: Date; domains: string[] };
  /** 第 3 步选了暂时不用 HTTPS */
  certificateSkipped: boolean;
  /** 第 4 步写入的正式地址;有它说明已经切换过 */
  publicUrl?: string;
}

export interface CertificateResult extends CertificateCheck {
  /** 检查通过后:是否装好并能用 https 打开 Ferry 的域名 */
  installed: boolean;
}

export class SetupWizard {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly store: SetupStore,
    private readonly platform: DeployPlatform,
    private readonly options: WizardOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async status(): Promise<WizardStatus> {
    const settings = await this.store.getSettings();
    const wizard = settings.wizard ?? {};
    return {
      domain: wizard.domain,
      certificate: settings.certificate ? { notAfter: settings.certificate.notAfter, domains: settings.certificate.domains } : undefined,
      certificateSkipped: wizard.certificateSkipped === true,
      publicUrl: settings.publicUrl,
    };
  }

  /** 第 2 步:检测通过就存下域名(还不生效)。换了域名时之前的证书选择作废,第 3 步要重新做 */
  async checkDomain(input: DomainInput): Promise<DomainCheck> {
    await this.requireNotSwitched();
    const result = await checkDomain(input, this.options.dns, this.options.instanceId);
    if (!result.ok) return result;
    const wizard = await this.wizard();
    const changed = wizard.domain?.ferryHost !== result.domain.ferryHost || wizard.domain?.appsDomain !== result.domain.appsDomain;
    await this.store.saveWizard({ ...wizard, domain: result.domain, ...(changed ? { certificateSkipped: false } : {}) });
    return result;
  }

  /**
   * 第 3 步:检查证书,通过后装进 Traefik,再用 https 实际连一次 Ferry 的域名(校验证书)确认用上了。
   * 私钥只交给部署平台,这里不保存
   */
  async installCertificate(chain: string, privateKey: string): Promise<CertificateResult> {
    await this.requireNotSwitched();
    const domain = await this.requireDomain();
    const check = checkCertificate(chain, privateKey, {
      required: required(domain),
      now: this.now(),
      trusted: this.options.trusted,
    });
    if (!check.ok) return { ...check, installed: false };

    const settings = await this.store.getSettings();
    const id = await this.platform.installCertificate({
      name: `ferry-${domain.domain}`,
      chain,
      privateKey,
      id: settings.certificate?.id,
    });
    await this.platform.ensureGateway({ authAddress: this.options.authAddress });
    const info: CertificateInfo = { id, notAfter: check.notAfter!, domains: check.domains! };
    await this.store.setCertificate(info);
    await this.store.saveWizard({ ...(await this.wizard()), certificateSkipped: false });

    const attempts = this.options.verifyAttempts ?? 10;
    let answer: string | undefined;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await this.sleep(this.options.verifyIntervalMs ?? 2000);
      answer = await this.options.httpsPing(domain.ferryHost);
      if (answer === this.options.instanceId) break;
    }
    const installed = answer === this.options.instanceId;
    const item: CheckItem = installed
      ? { key: "install", state: "ok", message: `https://${domain.ferryHost} 已使用这张证书` }
      : { key: "install", state: "bad", message: `https://${domain.ferryHost} 还没用上这张证书` };
    return { ...check, ok: installed, installed, items: [...check.items, item] };
  }

  /** 第 3 步选“暂时不用 HTTPS”:之后 Ferry 和应用都先走 http */
  async skipCertificate(): Promise<void> {
    await this.requireNotSwitched();
    await this.requireDomain();
    await this.store.saveWizard({ ...(await this.wizard()), certificateSkipped: true });
  }

  /**
   * 第 4 步:写入正式地址,让 Ferry 重启后按它启动。用证书时要求证书已经装好并覆盖这两个域名。
   * 返回正式地址,以及要不要交接(跳过证书时不交接,向导留在服务器 IP 上)
   */
  async switchAddress(): Promise<{ publicUrl: string; handoff: boolean }> {
    await this.requireNotSwitched();
    const domain = await this.requireDomain();
    const settings = await this.store.getSettings();
    const skipped = settings.wizard?.certificateSkipped === true;
    if (!skipped) {
      const cert = settings.certificate;
      if (!cert || !required(domain).every((name) => covers(cert.domains, name))) {
        throw new UserError("conflict", "还没有装好覆盖这两个域名的证书:请先完成上一步,或选择暂时不用 HTTPS");
      }
    }
    const scheme = skipped ? "http" : "https";
    const publicUrl = `${scheme}://${domain.ferryHost}`;
    await this.store.setAddress({ publicUrl, appsDomain: domain.appsDomain, appsUrlScheme: scheme });
    this.options.restart();
    return { publicUrl, handoff: !skipped };
  }

  /** 第 4 步重启后、确认正式地址能打开时:发一次性的交接令牌(5 分钟,只能用一次,只存哈希) */
  async issueHandoff(): Promise<string> {
    const settings = await this.store.getSettings();
    if (!settings.publicUrl?.startsWith("https://")) {
      throw new UserError("conflict", "没有切到 https 正式地址,不需要交接");
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now().getTime() + (this.options.handoffTtlMs ?? 5 * 60_000));
    await this.store.saveWizard({ ...(await this.wizard()), handoff: { tokenHash: hash(token), expiresAt } });
    return token;
  }

  /** 在正式地址上用交接令牌换向导会话。对了就作废它;不对或过期返回 false */
  async redeemHandoff(token: string): Promise<boolean> {
    const wizard = await this.wizard();
    const handoff = wizard.handoff;
    if (!handoff || handoff.expiresAt <= this.now() || handoff.tokenHash !== hash(token)) return false;
    const { handoff: _used, ...rest } = wizard;
    await this.store.saveWizard(rest);
    return true;
  }

  private async wizard(): Promise<WizardState> {
    return (await this.store.getSettings()).wizard ?? {};
  }

  private async requireDomain(): Promise<WizardDomain> {
    const domain = (await this.wizard()).domain;
    if (!domain) throw new UserError("conflict", "请先完成域名设置");
    return domain;
  }

  /** 切换之后不能再改域名和证书(向导的后面几步在新地址上做) */
  private async requireNotSwitched(): Promise<void> {
    if ((await this.store.getSettings()).publicUrl) throw new UserError("conflict", "已经切到正式地址,不能再改域名和证书");
  }
}

/** 证书要覆盖的两个名字 */
function required(domain: WizardDomain): string[] {
  return [domain.ferryHost, `*.${domain.appsDomain}`];
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
