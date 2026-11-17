import { MemoryArchiveStore } from "./archive-store";
import { MemoryDirectory } from "./directory";
import type {
  Adapters,
  Archive,
  CommandResult,
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
  failMigrate = false;
  stopped = new Set<string>();
  private seq = 0;

  private id(prefix: string): string {
    return `${prefix}_${++this.seq}`;
  }

  async createProject(name: string): Promise<string> {
    this.calls.push(`createProject:${name}`);
    return this.id("proj");
  }

  async createApp(input: { name: string }): Promise<string> {
    this.calls.push(`createApp:${input.name}`);
    return this.id("app");
  }

  async createDatabase(input: { name: string }) {
    this.calls.push(`createDatabase:${input.name}`);
    return {
      databaseId: this.id("db"),
      connectionUrl: `postgres://app:fake@${input.name}-db:5432/${input.name}`,
    };
  }

  async attachDomain(input: { host: string }): Promise<void> {
    this.calls.push(`attachDomain:${input.host}`);
  }

  async setEnv(appId: string, env: Record<string, string>): Promise<void> {
    this.env.set(appId, { ...this.env.get(appId), ...env });
  }

  async deploy(appId: string, archive: Archive): Promise<CommandResult> {
    this.calls.push(`deploy:${archive.version}`);
    const content = archive.zip.toString("latin1");
    if ([...this.failDeployMarkers].some((marker) => content.includes(marker))) {
      return { ok: false, logs: "error: build failed\nnpm ERR! missing script: build" };
    }
    this.deployedVersion.set(appId, archive.version);
    return { ok: true };
  }

  async runCommand(_appId: string, command: string): Promise<CommandResult> {
    this.calls.push(`runCommand:${command}`);
    return this.failMigrate ? { ok: false, logs: "relation \"items\" already exists" } : { ok: true };
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
}

export class FakeScanner implements Scanner {
  findings: Finding[] = [];
  async scan(): Promise<Finding[]> {
    return this.findings;
  }
}

export class FakeHealth implements HealthChecker {
  healthy = true;
  async check(): Promise<boolean> {
    return this.healthy;
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
