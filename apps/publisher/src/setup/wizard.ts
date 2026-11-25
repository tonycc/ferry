import { createHash, randomBytes } from "node:crypto";
import type { DeployPlatform } from "../adapters/types";
import { checkNewPassword } from "../auth/password";
import { UserError } from "../errors";
import { type CertificateCheck, type CheckItem, checkCertificate, covers } from "./certificate";
import { checkDomain, type DomainCheck, type DomainDeps, type DomainInput } from "./domain";
import type { SelfCheck, SelfCheckProgress } from "./selfcheck";
import type { CertificateInfo, SetupStore, WizardDomain, WizardState } from "./store";

/**
 * 设置向导第 2 到 7 步(docs/setup-wizard.md):检测域名、上传或跳过证书、切到正式地址;建管理员、自检、完成。
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
  /** 第 5 步:在正在运行的组织架构里建第一个管理员(手机号已是在职的人时设为管理员),设置他填的密码 */
  createAdmin?(input: AdminInput): Promise<{ userId: string }>;
  /** 第 6 步的自检;没有时只能跳过 */
  selfCheck?: SelfCheck;
  /** 记审计日志 */
  audit?(action: "setup.selfcheck" | "setup.complete", detail: Record<string, unknown>): Promise<void>;
  /** 第 7 步写入完成时间后:本进程里关闭向导、开始按域名分流 */
  onComplete?(): void;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export interface AdminInput {
  /** 公司名:最上级部门的名称 */
  orgName: string;
  name: string;
  mobile: string;
  password: string;
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
  /** 跳过证书时,人确认了 http 的正式地址能打开 */
  httpConfirmed: boolean;
  /** 第 5 步建好的管理员 */
  admin?: { name: string; orgName: string };
  /** 第 6 步的结果 */
  selfCheck?: "passed" | "skipped";
}

export interface CertificateResult extends CertificateCheck {
  /** 检查通过后:是否装好并能用 https 打开 Ferry 的域名 */
  installed: boolean;
}

export class SetupWizard {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  /** 第 5 步排队执行:同时提交两次(两个标签页)时,第二次要等第一次存下管理员后再判断,不能建出两个 */
  private adminQueue: Promise<unknown> = Promise.resolve();

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
      httpConfirmed: wizard.httpConfirmed === true,
      admin: wizard.admin ? { name: wizard.admin.name, orgName: wizard.admin.orgName } : undefined,
      selfCheck: wizard.selfCheck,
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

  /**
   * 撤销第 4 步:正式地址在人的电脑上打不开、要回去改域名或 IP 时用。清掉写入的地址配置和交接令牌,
   * 让 Ferry 重启后回到没有正式地址的状态;第 2、3 步的结果(域名草稿、证书)保留,改完再切换
   */
  async undoSwitch(): Promise<void> {
    const settings = await this.store.getSettings();
    if (!settings.publicUrl) throw new UserError("conflict", "还没有切到正式地址");
    await this.store.clearAddress();
    const { handoff: _dropped, httpConfirmed: _confirmed, ...rest } = settings.wizard ?? {};
    await this.store.saveWizard(rest);
    this.options.restart();
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

  /** 跳过证书时第 4 步重启后:人在新标签页里打开了 http 的正式地址,确认能打开。记下来,刷新页面不用再确认 */
  async confirmHttp(): Promise<void> {
    const settings = await this.store.getSettings();
    if (!settings.publicUrl?.startsWith("http://")) throw new UserError("conflict", "没有切到 http 的正式地址,不需要确认");
    await this.store.saveWizard({ ...(await this.wizard()), httpConfirmed: true });
  }

  /**
   * 第 5 步:建公司(最上级部门)和第一个管理员,密码是他自己填的。只能做一次:建好后再提交只返回已建好的管理员,
   * 向导会话不能用来多建管理员
   */
  async createAdmin(input: AdminInput): Promise<{ name: string; orgName: string; created: boolean }> {
    const run = this.adminQueue.then(() => this.createAdminNow(input));
    this.adminQueue = run.catch(() => {});
    return run;
  }

  private async createAdminNow(input: AdminInput): Promise<{ name: string; orgName: string; created: boolean }> {
    await this.requireSwitched();
    const existing = (await this.wizard()).admin;
    if (existing) return { name: existing.name, orgName: existing.orgName, created: false };
    if (!this.options.createAdmin) throw new UserError("not_found", "这一步还没有开放");
    // 先检查密码:建人之后才发现密码不合规,会留下一个没有密码、向导也没记下的管理员
    checkNewPassword(input.password);
    const { userId } = await this.options.createAdmin(input);
    const admin = { userId, name: input.name, orgName: input.orgName };
    await this.store.saveWizard({ ...(await this.wizard()), admin });
    return { name: admin.name, orgName: admin.orgName, created: true };
  }

  /** 第 6 步:开始自检(在后台跑,已经在跑时不重复开始),返回当前进度。通过后记下结果和审计日志 */
  async startSelfCheck(): Promise<SelfCheckProgress> {
    await this.requireAdmin();
    const check = this.options.selfCheck;
    if (!check) throw new UserError("not_found", "自检还没有开放,请先跳过");
    return check.start(async () => {
      await this.store.saveWizard({ ...(await this.wizard()), selfCheck: "passed" });
      await this.options.audit?.("setup.selfcheck", { skipped: false });
    }).progress;
  }

  /** 跳过自检时在后台删除留下的测试应用;只给测试等待用 */
  cleanup?: Promise<void>;

  /** 第 6 步的进度;没有自检时是 undefined */
  selfCheckStatus(): SelfCheckProgress | undefined {
    return this.options.selfCheck?.status();
  }

  /** 第 6 步选择跳过自检:记进审计日志 */
  async skipSelfCheck(): Promise<void> {
    await this.requireAdmin();
    await this.store.saveWizard({ ...(await this.wizard()), selfCheck: "skipped" });
    await this.options.audit?.("setup.selfcheck", { skipped: true });
    // 之前的自检中途被打断时测试应用会留下:在后台删掉(可能要等它的发布结束),不让人等
    this.cleanup = this.options.selfCheck
      ?.cleanup()
      .catch((err: Error) => console.error(`删除自检留下的测试应用失败(可以在控制台“全部应用”里删除): ${err.message}`));
  }

  /** 第 7 步:写入完成时间,向导永久关闭。返回正式地址(完成页上的“进入控制台”指向它,不是当前地址) */
  async complete(): Promise<{ publicUrl: string }> {
    const settings = await this.requireAdmin();
    if (!settings.wizard?.selfCheck) throw new UserError("conflict", "请先完成自检,或者选择跳过");
    const publicUrl = settings.publicUrl!;
    await this.store.markCompleted(this.now());
    await this.options.audit?.("setup.complete", { publicUrl });
    this.options.onComplete?.();
    return { publicUrl };
  }

  /** 第 5 到 7 步要先切到正式地址;跳过证书时还要人确认过 http 地址能打开 */
  private async requireSwitched() {
    const settings = await this.store.getSettings();
    if (!settings.publicUrl) throw new UserError("conflict", "请先切到正式地址");
    if (settings.publicUrl.startsWith("http://") && settings.wizard?.httpConfirmed !== true) {
      throw new UserError("conflict", `请先确认 ${settings.publicUrl} 能打开`);
    }
    return settings;
  }

  private async requireAdmin() {
    const settings = await this.requireSwitched();
    if (!settings.wizard?.admin) throw new UserError("conflict", "请先设置公司和管理员");
    return settings;
  }

  private async wizard(): Promise<WizardState> {
    return (await this.store.getSettings()).wizard ?? {};
  }

  private async requireDomain(): Promise<WizardDomain> {
    const domain = (await this.wizard()).domain;
    if (!domain) throw new UserError("conflict", "请先完成域名设置");
    return domain;
  }

  /** 切换之后不能再改域名和证书(向导的后面几步在新地址上做);要改就先撤销切换 */
  private async requireNotSwitched(): Promise<void> {
    if ((await this.store.getSettings()).publicUrl) {
      throw new UserError("conflict", "已经切到正式地址,不能再改域名和证书:要改的话先撤销切换");
    }
  }
}

/** 证书要覆盖的两个名字 */
function required(domain: WizardDomain): string[] {
  return [domain.ferryHost, `*.${domain.appsDomain}`];
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
