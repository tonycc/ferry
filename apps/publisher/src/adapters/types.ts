/**
 * 工作流只依赖这些接口,不直接依赖任何外部系统。
 * 每个接口在 fake.ts 里有内存假实现,真实实现各自一个文件。
 */

/**
 * 部署或命令失败的原因,决定 agent 该不该改代码:
 * - build:构建失败(依赖装不上、Dockerfile 出错),改代码;
 * - start:构建成功但容器没有运行起来(启动就崩溃),改代码;
 * - command:命令执行失败(迁移脚本出错),改代码;
 * - platform:部署平台本身的问题(超时等),不是代码的问题,不要改代码
 */
export type FailureReason = "build" | "start" | "command" | "platform";

export type CommandResult = { ok: true } | { ok: false; reason: FailureReason; logs: string };

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
  /**
   * 让应用的域名指向这个端口,并挂上登录网关。已有的域名端口不对或没挂网关时会更新,
   * 所以每次发布都可以调用;没有变化时什么都不做
   */
  attachDomain(input: { appId: string; host: string; port: number }): Promise<void>;
  /** 写入登录网关的配置(Traefik 中间件),服务启动时调用。authAddress 是 Traefik 能访问到的 /authz 地址 */
  ensureGateway(input: { authAddress: string }): Promise<void>;
  /** 合并写入:只更新传入的变量,保留已有的其他变量 */
  setEnv(appId: string, env: Record<string, string>): Promise<void>;
  /** 上传代码包并构建部署,结束后才返回 */
  /**
   * 部署一个代码包。databaseId 是应用的数据库:网络隔离时数据库要和应用一起挪进应用自己的网络,
   * 回滚也要传(回滚不经过建库那一步)
   */
  deploy(appId: string, archive: Archive, options?: { databaseId?: string }): Promise<CommandResult>;
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
  /**
   * 管理员删除应用时:彻底删除数据库,连同数据卷和服务器上的迁移前备份,数据无法恢复。
   * 可以重复调用:中途失败后再调用一次会把剩下的做完,已经删掉的不报错
   */
  deleteDatabase(databaseId: string): Promise<void>;
  /** 删除部署平台上的项目;应用和数据库要先删掉。已经删掉的不报错 */
  deleteProject(projectId: string): Promise<void>;
  /**
   * 网络隔离:让网关(Traefik)接入这些应用的网络。启动时和之后定时调用,网关容器被重建后据此恢复。
   * 返回接入的网络数,以及需要提醒管理员的问题(如 Traefik 管理接口没关)
   */
  ensureGatewayNetworks(appNames: string[]): Promise<{ networks: number; warnings: string[] }>;
  /** 删除应用自己的网络(管理员删除应用时,应用和数据库删掉之后)。已经删掉的不报错 */
  deleteAppNetwork(name: string): Promise<void>;
}

/** 代码包存储:每次上传保存一份,部署和回滚时取回,按保留规则清理 */
export interface ArchiveStore {
  save(appName: string, version: string, zip: Buffer): Promise<void>;
  read(appName: string, version: string): Promise<Buffer | undefined>;
  /** 应用现有的全部代码包及保存时间 */
  list(appName: string): Promise<{ version: string; savedAt: Date }[]>;
  /** 删除一个代码包;不存在时不报错 */
  remove(appName: string, version: string): Promise<void>;
  /** 删除应用的全部代码包(管理员删除应用时);没有时不报错 */
  removeAll(appName: string): Promise<void>;
}

export interface Finding {
  file?: string;
  detail: string;
}

/** 发布前密钥扫描(gitleaks) */
export interface Scanner {
  scan(zip: Buffer): Promise<Finding[]>;
}

/**
 * 健康检查结果。没通过时带上最后一次的结果,让 agent 分得清是没有响应、路径不对,还是接口报错:
 * status 是 HTTP 状态码,0 表示连不上或超时
 */
export type HealthResult = { ok: true } | { ok: false; status: number };

export interface HealthChecker {
  check(host: string, path: string): Promise<HealthResult>;
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
  departmentNameOf(departmentId: string): Promise<string | undefined>;
}

export interface Adapters {
  platform: DeployPlatform;
  archives: ArchiveStore;
  scanner: Scanner;
  health: HealthChecker;
  notifier: Notifier;
  directory: Directory;
}
