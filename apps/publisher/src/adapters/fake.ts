import { MemoryArchiveStore } from "./archive-store";
import { MemoryDirectory } from "./directory";
import type {
  Adapters,
  Archive,
  CommandResult,
  FailureReason,
  HealthResult,
  DeployPlatform,
  Finding,
  HealthChecker,
  Notifier,
  Scanner,
} from "./types";

/**
 * 内存假实现:不接触任何外部系统,用于本地开发和测试。
 * 公开的字段是给测试用来制造失败和检查调用的开关。
 */

export class FakePlatform implements DeployPlatform {
  calls: string[] = [];
  env = new Map<string, Record<string, string>>();
  /** 每个应用当前部署的版本 */
  deployedVersion = new Map<string, string>();
  /** 代码包内容里含有这些标记时,部署失败 */
  failDeployMarkers = new Set<string>();
  /** 带标记的代码包部署失败时报告的原因 */
  failDeployReason: FailureReason = "build";
  failMigrate = false;
  stopped = new Set<string>();
  private seq = 0;

  private id(prefix: string): string {
    return `${prefix}_${++this.seq}`;
  }

  /** 和真实平台一样按名称查找或新建,只有真正新建时才记入 calls */
  private readonly projects = new Map<string, string>();
  private readonly apps = new Map<string, string>();
  /** 数据库名称 → ID 和是否在运行 */
  readonly databases = new Map<string, { id: string; running: boolean }>();

  async createProject(name: string): Promise<string> {
    let id = this.projects.get(name);
    if (!id) {
      this.calls.push(`createProject:${name}`);
      id = this.id("proj");
      this.projects.set(name, id);
    }
    return id;
  }

  async createApp(input: { name: string }): Promise<string> {
    let id = this.apps.get(input.name);
    if (!id) {
      this.calls.push(`createApp:${input.name}`);
      id = this.id("app");
      this.apps.set(input.name, id);
    }
    return id;
  }

  async createDatabase(input: { name: string }) {
    let db = this.databases.get(input.name);
    if (!db) {
      this.calls.push(`createDatabase:${input.name}`);
      db = { id: this.id("db"), running: true };
      this.databases.set(input.name, db);
    } else if (!db.running) {
      this.calls.push(`startDatabase:${db.id}`);
      db.running = true;
    }
    return {
      databaseId: db.id,
      connectionUrl: `postgres://app:fake@${input.name}-db:5432/${input.name}`,
    };
  }

  /** 域名 → 端口。只有新建或端口变了才记入 calls,和真实平台一样“没有变化就什么都不做” */
  readonly domains = new Map<string, number>();
  gatewayAddress: string | undefined;

  async attachDomain(input: { host: string; port: number }): Promise<void> {
    if (this.domains.get(input.host) === input.port) return;
    this.calls.push(`attachDomain:${input.host}`);
    this.domains.set(input.host, input.port);
  }

  async ensureGateway(input: { authAddress: string }): Promise<void> {
    this.gatewayAddress = input.authAddress;
  }

  async setEnv(appId: string, env: Record<string, string>, unset: string[] = []): Promise<void> {
    const current = { ...this.env.get(appId) };
    for (const name of unset) delete current[name];
    this.env.set(appId, { ...current, ...env });
  }

  /** 每次部署带的数据库 ID(网络隔离时数据库要和应用一起挪,回滚也要带) */
  readonly deployedWithDatabase: (string | undefined)[] = [];

  async deploy(appId: string, archive: Archive, options: { databaseId?: string } = {}): Promise<CommandResult> {
    this.calls.push(`deploy:${archive.version}`);
    this.deployedWithDatabase.push(options.databaseId);
    const content = archive.zip.toString("latin1");
    if ([...this.failDeployMarkers].some((marker) => content.includes(marker))) {
      return { ok: false, reason: this.failDeployReason, logs: "error: build failed\nnpm ERR! missing script: build" };
    }
    this.deployedVersion.set(appId, archive.version);
    return { ok: true };
  }

  async runCommand(_appId: string, command: string): Promise<CommandResult> {
    this.calls.push(`runCommand:${command}`);
    return this.failMigrate ? { ok: false, reason: "command", logs: "relation \"items\" already exists" } : { ok: true };
  }

  async backupDatabase(databaseId: string): Promise<string> {
    this.calls.push(`backupDatabase:${databaseId}`);
    return this.id("backup");
  }

  async getLogs(): Promise<string> {
    return "(fake) 应用日志";
  }

  async stopApp(appId: string): Promise<void> {
    this.calls.push(`stopApp:${appId}`);
    this.stopped.add(appId);
  }

  async startApp(appId: string): Promise<void> {
    this.calls.push(`startApp:${appId}`);
    this.stopped.delete(appId);
  }

  async removeApp(appId: string): Promise<void> {
    this.calls.push(`removeApp:${appId}`);
    for (const [name, id] of this.apps) if (id === appId) this.apps.delete(name);
    this.deployedVersion.delete(appId);
    this.env.delete(appId);
  }

  async stopDatabase(databaseId: string): Promise<void> {
    this.calls.push(`stopDatabase:${databaseId}`);
    for (const db of this.databases.values()) if (db.id === databaseId) db.running = false;
  }

  async deleteDatabase(databaseId: string): Promise<void> {
    this.calls.push(`deleteDatabase:${databaseId}`);
    for (const [name, db] of this.databases) if (db.id === databaseId) this.databases.delete(name);
  }

  async ensureGatewayNetworks(appNames: string[]): Promise<{ networks: number; warnings: string[] }> {
    return { networks: appNames.length, warnings: [] };
  }

  async deleteAppNetwork(name: string): Promise<void> {
    this.calls.push(`deleteAppNetwork:${name}`);
  }

  async deleteProject(projectId: string): Promise<void> {
    this.calls.push(`deleteProject:${projectId}`);
    for (const [name, id] of this.projects) if (id === projectId) this.projects.delete(name);
  }
}

export class FakeScanner implements Scanner {
  findings: Finding[] = [];
  async scan(): Promise<Finding[]> {
    return this.findings;
  }
}

export class FakeHealth implements HealthChecker {
  healthy = true;
  /** 不健康时报告的状态码 */
  status = 502;
  async check(): Promise<HealthResult> {
    return this.healthy ? { ok: true } : { ok: false, status: this.status };
  }
}

export class FakeNotifier implements Notifier {
  sent: { userId: string; message: string }[] = [];
  async notify(userId: string, message: string): Promise<void> {
    this.sent.push({ userId, message });
  }
}

export interface FakeAdapters extends Adapters {
  platform: FakePlatform;
  scanner: FakeScanner;
  health: FakeHealth;
  notifier: FakeNotifier;
  directory: MemoryDirectory;
}

export function createFakeAdapters(): FakeAdapters {
  return {
    platform: new FakePlatform(),
    archives: new MemoryArchiveStore(),
    scanner: new FakeScanner(),
    health: new FakeHealth(),
    notifier: new FakeNotifier(),
    directory: new MemoryDirectory(),
  };
}
