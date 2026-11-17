import type { DokployClient } from "./dokploy-client";
import type { Archive, CommandResult, DeployPlatform } from "./types";

/**
 * 对接真实 Dokploy 的实现 —— 目前全部未实现。
 *
 * 每个方法旁标了大概对应的 Dokploy 接口,但接口名和参数随版本变化
 * (例如新版本在项目下增加了“环境”一层),没有对着真实实例核对过,
 * 所以这里故意不写猜测的调用。实现步骤:
 *   1. 从你的 Dokploy 实例导出 OpenAPI 文档;
 *   2. 在 dokploy-client.ts 里生成带类型的封装;
 *   3. 逐个替换下面的 notImplemented。
 */
export class DokployPlatform implements DeployPlatform {
  constructor(private readonly client: DokployClient) {}

  /** 参考 project.create */
  createProject(_name: string): Promise<string> {
    return this.notImplemented("createProject");
  }

  /** 参考 application.create,再配置构建方式 */
  createApp(_input: { projectId: string; name: string; port: number }): Promise<string> {
    return this.notImplemented("createApp");
  }

  /** 参考 postgres.create 和 postgres.deploy */
  createDatabase(_input: { projectId: string; name: string }): Promise<{ databaseId: string; connectionUrl: string }> {
    return this.notImplemented("createDatabase");
  }

  /** 参考 domain.create */
  attachDomain(_input: { appId: string; host: string; port: number }): Promise<void> {
    return this.notImplemented("attachDomain");
  }

  /** 参考 application.saveEnvironment;注意它是整体覆盖,需要先读出再合并 */
  setEnv(_appId: string, _env: Record<string, string>): Promise<void> {
    return this.notImplemented("setEnv");
  }

  /**
   * 参考 application.dropDeployment:以表单上传 applicationId 和 zip,触发部署(源码中已确认存在),
   * 然后轮询部署记录直到结束。尚未确认这个接口能否用 API key 调用。
   */
  deploy(_appId: string, _archive: Archive): Promise<CommandResult> {
    return this.notImplemented("deploy");
  }

  /** Dokploy 没有直接的“执行命令”接口,可能要通过部署前命令或一次性任务实现 */
  runCommand(_appId: string, _command: string): Promise<CommandResult> {
    return this.notImplemented("runCommand");
  }

  /** 参考备份相关接口(backup.*) */
  backupDatabase(_databaseId: string): Promise<string> {
    return this.notImplemented("backupDatabase");
  }

  getLogs(_appId: string, _lines: number): Promise<string> {
    return this.notImplemented("getLogs");
  }

  /** 对应 application.stop(已在 Dokploy 源码中确认存在) */
  stopApp(_appId: string): Promise<void> {
    return this.notImplemented("stopApp");
  }

  /** 对应 application.start(已在 Dokploy 源码中确认存在) */
  startApp(_appId: string): Promise<void> {
    return this.notImplemented("startApp");
  }

  private notImplemented(method: string): Promise<never> {
    void this.client;
    return Promise.reject(new Error(`DokployPlatform.${method} 尚未实现`));
  }
}
