/**
 * 工作流只依赖这些接口,不直接依赖任何外部系统。
 * 每个接口在 fake.ts 里有内存假实现,真实实现各自一个文件。
 */

export type CommandResult = { ok: true } | { ok: false; logs: string };

/** 应用某个版本的代码包(zip) */
export interface Archive {
  version: string;
  zip: Buffer;
}

/** 部署平台(Dokploy) */
export interface DeployPlatform {
  /** 以下三个都是按名称查找或新建:已有同名的就复用 */
  createProject(name: string): Promise<string>;
  createApp(input: { projectId: string; name: string; port: number }): Promise<string>;
  /** 查找或新建数据库,并确保它在运行(停着的会启动),返回连接串 */
  createDatabase(input: {
    projectId: string;
    name: string;
  }): Promise<{ databaseId: string; connectionUrl: string }>;
  attachDomain(input: { appId: string; host: string; port: number }): Promise<void>;
  /** 合并写入:只更新传入的变量,保留已有的其他变量 */
  setEnv(appId: string, env: Record<string, string>): Promise<void>;
  /** 上传代码包并构建部署,结束后才返回 */
  deploy(appId: string, archive: Archive): Promise<CommandResult>;
  /** 在应用容器里执行一条命令(用于数据库迁移) */
  runCommand(appId: string, command: string): Promise<CommandResult>;
  backupDatabase(databaseId: string): Promise<string>;
  getLogs(appId: string, lines: number): Promise<string>;
  /** 停止应用的服务(管理员停用时用),数据和配置保留 */
  stopApp(appId: string): Promise<void>;
  startApp(appId: string): Promise<void>;
  /** 下线:删除应用(连同域名),等它的容器都停掉后返回 */
  removeApp(appId: string): Promise<void>;
  /** 下线:停止数据库,数据保留;之后 createDatabase 会重新启动它 */
  stopDatabase(databaseId: string): Promise<void>;
}

/** 代码包存储:每次上传保存一份,部署和回滚时取回,按保留规则清理 */
export interface ArchiveStore {
  save(appName: string, version: string, zip: Buffer): Promise<void>;
  read(appName: string, version: string): Promise<Buffer | undefined>;
  /** 应用现有的全部代码包及保存时间 */
  list(appName: string): Promise<{ version: string; savedAt: Date }[]>;
  /** 删除一个代码包;不存在时不报错 */
  remove(appName: string, version: string): Promise<void>;
}

export interface Finding {
  file?: string;
  detail: string;
}

/** 发布前密钥扫描(gitleaks) */
export interface Scanner {
  scan(zip: Buffer): Promise<Finding[]>;
}

export interface HealthChecker {
  check(host: string, path: string): Promise<boolean>;
}

export interface Notifier {
  notify(userId: string, message: string): Promise<void>;
}

/**
 * 组织架构:从钉钉、企业微信等平台同步来的部门树和人员所属部门。
 * 用户 ID 和部门 ID 都带平台前缀(如 dingtalk:123),不同平台的 ID 不会冲突。
 */
export interface Directory {
  /** 用户当前所属的全部部门;不在组织架构里的用户返回空数组 */
  departmentsOf(userId: string): Promise<string[]>;
  /**
   * 部门的全部上级部门,从直接上级往上排。不含根部门:
   * 根部门代表整个企业,把它算作上级会让直接挂在根部门下的人看到所有“本部门可见”的应用。
   */
  ancestorsOf(departmentId: string): Promise<string[]>;
  /** 在组织架构里且在职 */
  isActive(userId: string): Promise<boolean>;
  /** 按登录时输入的账号(工号或手机号)找在职的人 */
  findLogin(account: string): Promise<string | undefined>;
  nameOf(userId: string): Promise<string | undefined>;
}

export interface Adapters {
  platform: DeployPlatform;
  archives: ArchiveStore;
  scanner: Scanner;
  health: HealthChecker;
  notifier: Notifier;
  directory: Directory;
}
