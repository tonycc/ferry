import { isHttpsRedirect } from "../adapters/health";
import { UserError } from "../errors";
import type { User } from "../identity";
import type { PublisherService } from "../service";
import { makeZip } from "../zip";

/**
 * 设置向导第 6 步的自检(docs/setup-wizard.md):以一个内部的系统身份走一遍员工的发布流程。
 * 用 node-postgres 模板建应用 ferry-selfcheck、上传、发布、等上线;再不带登录状态经 Traefik 请求应用地址,
 * 应该被登录网关跳到 Ferry 的登录页;最后彻底删掉这个应用(含数据库)。
 *
 * 构建要几分钟,所以在后台跑,页面轮询进度。进度只在内存里:Ferry 中途重启后从头再来,
 * 上一次留下的测试应用在下一次开始时先删掉。
 */

export const SELFCHECK_APP = "ferry-selfcheck";
const TEMPLATE = "node-postgres";

/** 自检用的系统身份:不是组织架构里的人,只拥有测试应用;删除应用要管理员身份 */
const SYSTEM_USER: User = { id: "ferry:selfcheck", departments: [], isAdmin: true };

export type SelfCheckStepKey = "create" | "publish" | "gateway" | "cleanup";
export type SelfCheckStepState = "wait" | "running" | "ok" | "bad";

export interface SelfCheckStep {
  key: SelfCheckStepKey;
  label: string;
  state: SelfCheckStepState;
  /** 没通过时的原因 */
  message?: string;
}

export interface SelfCheckProgress {
  running: boolean;
  steps: SelfCheckStep[];
  /** 跑完之后:都通过,或者没通过 */
  result?: "passed" | "failed";
  /** 没通过时怎么处理 */
  hint?: string;
}

export interface SelfCheckDeps {
  service: Pick<
    PublisherService,
    "getTemplate" | "prepareApp" | "receiveUpload" | "publish" | "status" | "listApps" | "unpublish" | "deleteApp"
  >;
  /** 经 Traefik 的 http 入口(tls 时是 https 入口)按域名请求一次,不跟随跳转 */
  probe(host: string, path: string, options?: { tls?: boolean }): Promise<{ status: number; location?: string }>;
  /** Ferry 的正式地址:未登录的请求应该跳到它的 /auth/app */
  publicUrl: string;
  appsDomain: string;
  /** 等发布结束:每隔多久查一次、最多等多久(构建 node 应用要装依赖,给足时间) */
  pollMs?: number;
  publishTimeoutMs?: number;
  /** 删除前等发布结束(上一次自检的发布可能还在进行) */
  sleep?: (ms: number) => Promise<void>;
}

const LABELS: Record<SelfCheckStepKey, string> = {
  create: `创建测试应用 ${SELFCHECK_APP}`,
  publish: "发布并上线",
  gateway: "未登录访问时跳转登录",
  cleanup: "删除测试应用",
};

const LOGS_HINT = `多半是 Dokploy 构建或启动失败:在 Dokploy 管理页面查看 ${SELFCHECK_APP} 的构建和运行日志,处理后重试`;

export class SelfCheck {
  private progress: SelfCheckProgress = { running: false, steps: fresh() };
  private readonly sleep: (ms: number) => Promise<void>;
  /** 这次上传的代码包版本,发布时用 */
  private version = "";

  constructor(private readonly deps: SelfCheckDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  status(): SelfCheckProgress {
    return structuredClone(this.progress);
  }

  /**
   * 开始一次自检(已经在跑时不重复开始),立即返回。跑完后通过时调用 onPassed。
   * 返回的 promise 只给测试等待用
   */
  start(onPassed: () => Promise<void>): { progress: SelfCheckProgress; done: Promise<void> } {
    if (this.progress.running) return { progress: this.status(), done: Promise.resolve() };
    this.progress = { running: true, steps: fresh() };
    const done = this.run()
      .then(async (passed) => {
        if (passed) await onPassed();
        this.progress.result = passed ? "passed" : "failed";
      })
      .catch((err: Error) => {
        // run 自己处理了每一步的错误;到这里是意料之外的,也要让页面停下来
        this.progress.result = "failed";
        this.progress.hint = err.message;
      })
      .finally(() => {
        this.progress.running = false;
      });
    return { progress: this.status(), done };
  }

  /**
   * 只删掉留下的测试应用(Ferry 在自检途中重启后,发布会接着跑完,应用就留下了)。
   * 人选择跳过自检时在后台调用;正在自检时不做,那次自己会删
   */
  async cleanup(): Promise<void> {
    if (this.progress.running) return;
    await this.removeApp();
  }

  private async run(): Promise<boolean> {
    let passed = false;
    try {
      passed = (await this.step("create", () => this.create())) && (await this.step("publish", () => this.publishAndWait()));
      if (passed) passed = await this.step("gateway", () => this.checkGateway());
    } finally {
      // 不管前面哪一步没通过,都要删掉测试应用
      const cleaned = await this.step("cleanup", () => this.removeApp(), "测试应用没删掉:可以在控制台“全部应用”里停用后删除");
      passed = passed && cleaned;
    }
    return passed;
  }

  /** 执行一步:抛错时记下原因,返回 false */
  private async step(key: SelfCheckStepKey, action: () => Promise<void>, hint?: string): Promise<boolean> {
    const step = this.progress.steps.find((s) => s.key === key)!;
    step.state = "running";
    try {
      await action();
      step.state = "ok";
      return true;
    } catch (err) {
      step.state = "bad";
      step.message = (err as Error).message;
      const failure = err as Error & { hint?: string };
      const add = failure.hint ?? hint;
      // 前面已经有一步没通过时,清理的提示也要留着:测试应用还在服务器上
      if (add) this.progress.hint = this.progress.hint ? `${this.progress.hint}。${add}` : add;
      return false;
    }
  }

  /** 先删掉上一次留下的测试应用,再按模板打包上传 */
  private async create(): Promise<void> {
    if ((await this.deps.service.listApps(SYSTEM_USER)).some((a) => a.name === SELFCHECK_APP)) await this.removeApp("create");
    const files = await this.deps.service.getTemplate(TEMPLATE);
    const zip = makeZip(
      Object.fromEntries(
        files.map((f) => [f.path, f.path === "app.yaml" ? f.content.replace(/^name:.*$/m, `name: ${SELFCHECK_APP}`) : f.content]),
      ),
    );
    const prepared = await this.deps.service.prepareApp(SYSTEM_USER, SELFCHECK_APP);
    const token = prepared.uploadUrl.split("/uploads/").pop()!;
    await this.deps.service.receiveUpload(token, zip);
    this.version = prepared.version;
  }

  private async publishAndWait(): Promise<void> {
    let view = await this.deps.service.publish(SYSTEM_USER, { name: SELFCHECK_APP, version: this.version });
    const deadline = Date.now() + (this.deps.publishTimeoutMs ?? 20 * 60_000);
    while (!view.done) {
      if (Date.now() >= deadline) throw withHint(new Error("等了太久还没上线"), LOGS_HINT);
      await this.sleep(this.deps.pollMs ?? 3000);
      view = await this.deps.service.status(SYSTEM_USER, view.releaseId);
    }
    if (view.state !== "LIVE") {
      throw withHint(new Error(view.error?.message ?? `发布没有成功(${view.state})`), view.error?.hint ?? LOGS_HINT);
    }
  }

  /** 不带登录状态访问应用:登录网关应该跳到 Ferry 的登录页 */
  private async checkGateway(): Promise<void> {
    const host = `${SELFCHECK_APP}.${this.deps.appsDomain}`;
    let res = await this.deps.probe(host, "/");
    // 应用用 https 时,http 入口先跳到 https 的同一个地址:改走 https 入口再看一次
    if (isHttpsRedirect(res, host)) {
      res = await this.deps.probe(host, "/", { tls: true });
    }
    const login = new URL("/auth/app", this.deps.publicUrl).toString();
    if (res.status >= 300 && res.status < 400 && res.location?.startsWith(login)) return;
    const got = res.status === 0 ? "连不上" : `返回 ${res.status}${res.location ? `,跳到 ${res.location}` : ""}`;
    throw withHint(
      new Error(`未登录访问 ${host} 没有跳到登录页(${got})`),
      "应用没挂上登录网关:重启 Ferry 后重试(启动时会补上网关配置)",
    );
  }

  /**
   * 下线再彻底删除。上一次自检的发布还在进行时,等它结束(最多一会儿);
   * waitingOn:等的时候在这一步上说明在等什么
   */
  private async removeApp(waitingOn?: SelfCheckStepKey): Promise<void> {
    const apps = await this.deps.service.listApps(SYSTEM_USER);
    if (!apps.some((a) => a.name === SELFCHECK_APP)) return;
    for (let i = 0; ; i++) {
      try {
        await this.deps.service.unpublish(SYSTEM_USER, SELFCHECK_APP);
        break;
      } catch (err) {
        // 下线只在有发布还在进行时报 conflict
        if (!(err instanceof UserError && err.code === "conflict") || i >= 100) throw err;
        const step = waitingOn && this.progress.steps.find((s) => s.key === waitingOn);
        if (step) step.message = "等上一次自检的发布结束";
        await this.sleep(this.deps.pollMs ?? 3000);
      }
    }
    const step = waitingOn && this.progress.steps.find((s) => s.key === waitingOn);
    if (step) delete step.message;
    await this.deps.service.deleteApp(SYSTEM_USER, SELFCHECK_APP);
  }
}

function fresh(): SelfCheckStep[] {
  return (Object.keys(LABELS) as SelfCheckStepKey[]).map((key) => ({ key, label: LABELS[key], state: "wait" }));
}

function withHint(err: Error, hint: string): Error {
  return Object.assign(err, { hint });
}
