import { isLoopbackHost, type Config } from "../config";
import type { InstanceSettings } from "./store";

/** Ferry 这次启动用的地址配置,以及是否已经完成初始化 */
export interface InstanceState {
  initialized: boolean;
  /** 浏览器和 agent 访问 Ferry 的地址;没有时只能本机访问(http://127.0.0.1:<PORT>) */
  publicUrl?: string;
  appsDomain: string;
  appsUrlScheme: "http" | "https";
}

/**
 * 环境变量优先,其次是设置向导写进数据库的配置(docs/setup-wizard.md“配置存在哪里、以哪个为准”)。
 *
 * 要看原始的环境变量:APPS_DOMAIN、APPS_URL_SCHEME 在 config.ts 里有默认值,解析后的配置总是有值,
 * 分不出是管理员设的还是默认的。
 *
 * 已初始化(满足任一条):
 * - 环境变量里设了 PUBLIC_URL:现有的部署方式,全靠 .env;
 * - 数据库里有向导完成的记录;
 * - 只在本机监听(本机开发的默认值):只有本机能访问,不需要向导。开发向导本身时设 SETUP_DEV=1 强制进入未初始化模式。
 */
export function resolveInstance(env: NodeJS.ProcessEnv, config: Config, settings: InstanceSettings): InstanceState {
  const fromEnv = (name: string) => (env[name]?.trim() ?? "") !== "";
  const initialized =
    fromEnv("PUBLIC_URL") ||
    settings.setupCompletedAt !== undefined ||
    (isLoopbackHost(config.HOST) && config.SETUP_DEV !== "1");
  return {
    initialized,
    publicUrl: config.PUBLIC_URL ?? settings.publicUrl,
    appsDomain: fromEnv("APPS_DOMAIN") ? config.APPS_DOMAIN : (settings.appsDomain ?? config.APPS_DOMAIN),
    appsUrlScheme: fromEnv("APPS_URL_SCHEME") ? config.APPS_URL_SCHEME : (settings.appsUrlScheme ?? config.APPS_URL_SCHEME),
  };
}

/** 不能这样启动时抛出说明原因的错误 */
export function checkInstance(state: InstanceState, config: Config): void {
  if (!state.initialized && !config.DATABASE_URL) {
    throw new Error(
      config.SETUP_DEV === "1"
        ? "SETUP_DEV=1 要配合 DATABASE_URL 使用:设置向导的进度存在数据库里,中途 Ferry 要重启一次"
        : `HOST=${config.HOST} 会接受其他机器的连接:要么设置 PUBLIC_URL(agent 和浏览器访问 Ferry 用的地址,如 https://ferry.corp.example),` +
            "要么设置 DATABASE_URL,用设置向导完成初始化;否则交给 agent 的上传地址是 127.0.0.1,别的机器或容器里的 agent 访问不到",
    );
  }
  if (state.initialized && !state.publicUrl && !isLoopbackHost(config.HOST)) {
    throw new Error(
      `HOST=${config.HOST} 会接受其他机器的连接,必须设置 PUBLIC_URL(agent 和浏览器访问 Ferry 用的地址,如 https://ferry.corp.example);` +
        "否则交给 agent 的上传地址是 127.0.0.1,别的机器或容器里的 agent 访问不到",
    );
  }
}
