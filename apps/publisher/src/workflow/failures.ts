import type { Manifest } from "@ferry/manifest";
import type { FailureReason, Finding } from "../adapters/types";

/**
 * 把部署平台和健康检查的失败结果翻译成写给 agent 的错误:类型、说明、修复提示,以及改代码能不能解决。
 * 分类只依据适配器报告的原因和状态码,不去猜日志内容。
 */
export interface FailureInfo {
  /** agent 改代码后重新发布是否可能解决 */
  fixable: boolean;
  type: string;
  message: string;
  hint: string;
}

const PLATFORM: FailureInfo = {
  fixable: false,
  type: "platform_error",
  message: "部署平台出了问题,这不是代码的问题",
  hint: "不要修改代码。把情况告诉用户,请平台管理员检查部署平台;平台恢复后重新发布即可",
};

/** 构建或部署失败 */
export function deployFailure(reason: FailureReason, manifest: Manifest): FailureInfo {
  switch (reason) {
    case "build":
      return {
        fixable: true,
        type: "build_failed",
        message: "构建失败(按 Dockerfile 构建镜像时出错)",
        hint:
          "看 logs 末尾的报错修复后重新发布。常见原因:TypeScript 类型错误(logs 里有 文件(行,列): error TS…," +
          "本地可以先运行 npx tsc --noEmit 检查)、package.json 里的依赖名或版本号不存在、" +
          "Dockerfile 里 COPY 的文件不在代码包里、构建命令写错",
      };
    case "start":
      return {
        fixable: true,
        type: "start_failed",
        message: "构建成功,但应用一启动就退出了,没有运行起来。logs 是应用启动时的输出",
        hint:
          "在 logs 里找应用退出前的报错并修复。常见原因:Dockerfile 的 CMD 指向的文件不存在、" +
          "代码 import 了 package.json 里没有的依赖、启动时查询了还不存在的表。" +
          "注意发布顺序是先启动新代码、再执行迁移:应用启动时不能依赖这次迁移才建的表或字段," +
          "启动阶段不要查询业务表,或者查询失败时只记日志、不要退出;只是把建表语句加进 migrations 解决不了启动崩溃。" +
          `应用要一直运行并监听 PORT(本应用是 ${manifest.port})`,
      };
    case "command":
      return {
        fixable: true,
        type: "build_failed",
        message: "部署命令执行失败",
        hint: "看 logs 里的报错修复后重新发布",
      };
    case "platform":
      return PLATFORM;
  }
}

/** 迁移命令失败 */
export function migrationFailure(reason: FailureReason, manifest: Manifest): FailureInfo {
  if (reason === "platform") return PLATFORM;
  return {
    fixable: true,
    type: "migration_failed",
    message: `数据库迁移命令(${manifest.migrate})执行失败`,
    hint:
      "数据库在迁移前已备份。看 logs 里的报错修复后重新发布:SQL 写错了就改 SQL;" +
      "提示找不到脚本或命令,就改 app.yaml 的 migrate,让它指向代码包里确实存在的命令。" +
      "迁移必须可以重复执行(每次发布都会跑一遍),已经执行成功的迁移文件不要再改。" +
      "logs 里如果是找不到容器,说明应用启动后又退出了,按应用启动失败处理:看 get_app_logs",
  };
}

/** 健康检查没通过。status 是最后一次请求的 HTTP 状态码,0 表示连不上或超时 */
export function healthFailure(status: number, manifest: Manifest): FailureInfo {
  const path = manifest.healthcheck;
  const port = manifest.port;
  const base = { fixable: true, type: "healthcheck_failed" };
  if (status === 0 || status === 502 || status === 503 || status === 504) {
    return {
      ...base,
      message:
        status === 0
          ? `健康检查 ${path} 没有响应(连不上或超时)`
          : `健康检查 ${path} 返回 ${status}:应用容器在运行,但端口 ${port} 上没有程序接受连接`,
      hint:
        `应用必须监听 PORT 环境变量给的端口(本应用是 ${port},即 app.yaml 的 port),并且监听所有网卡:` +
        "不要把端口写死,也不要只监听 127.0.0.1 或 localhost(Node.js 写 server.listen(port) 即可)。" +
        `另外确认 ${path} 能在几秒内返回`,
    };
  }
  if (status === 404) {
    return {
      ...base,
      message: `健康检查路径 ${path} 返回 404:应用在运行,但没有这个路径`,
      hint: `把 app.yaml 的 healthcheck 改成应用实际提供的健康检查路径,或者在应用里加上 ${path},正常时返回 200`,
    };
  }
  if (status >= 500) {
    return {
      ...base,
      message: `健康检查 ${path} 返回 ${status}:应用在运行,但健康检查接口出错`,
      hint: "看 logs 里健康检查请求出错的原因并修复。常见原因:查询了还不存在的表或字段(建表要写在 migrations 里)",
    };
  }
  return {
    ...base,
    message: `健康检查 ${path} 返回 ${status},不是 200`,
    hint: `让 ${path} 在应用正常时返回 200,不要重定向,也不要要求登录`,
  };
}

/** 密钥扫描规则(adapters/gitleaks.toml):应用自己的 PostgreSQL,和 Ferry 不支持连接的别的系统 */
const POSTGRES_RULE = "postgres-connection-string-password";
const OTHER_SYSTEM_RULE = "connection-string-password";

/** 日志里最多列出几处,太多时 agent 改完前面的再发布一次就能看到剩下的 */
const MAX_LISTED_FINDINGS = 30;

/**
 * 密钥扫描发现了硬编码的密钥。按密钥种类给出 agent 能执行的修复方法:
 * Ferry 只会给应用注入 DATABASE_URL 和 PORT,还不能给应用配置别的密钥(第三方 API key、群机器人 webhook 等),
 * 所以这类密钥只能让功能在没有密钥时关闭,并告诉用户。
 */
export function scanFailure(findings: Finding[], manifest: Manifest): FailureInfo & { logs: string } {
  const listed = findings.slice(0, MAX_LISTED_FINDINGS).map((f) => {
    const where = f.file ? (f.line ? `${f.file}:${f.line}` : f.file) : "(位置未知)";
    return `${where}  ${f.detail}${f.rule ? `(规则 ${f.rule})` : ""}`;
  });
  if (findings.length > MAX_LISTED_FINDINGS) listed.push(`……还有 ${findings.length - MAX_LISTED_FINDINGS} 处`);

  const rules = new Set(findings.map((f) => f.rule));
  const hasPostgres = rules.has(POSTGRES_RULE);
  const hasOtherSystem = rules.has(OTHER_SYSTEM_RULE);
  const hasOther = findings.some((f) => f.rule !== POSTGRES_RULE && f.rule !== OTHER_SYSTEM_RULE);
  const parts = [
    "代码包里不能有任何密钥:代码、配置文件、.env 文件都不行,也不要用编码、拆分字符串等写法绕过扫描(gitleaks:allow 注释不起作用)。",
  ];
  if (hasPostgres) {
    parts.push(
      manifest.database === "postgres"
        ? "PostgreSQL 连接串:应用自己的数据库连接串由 Ferry 注入在环境变量 DATABASE_URL 里,改为直接使用 process.env.DATABASE_URL,不要自己拼连接串。"
        : "PostgreSQL 连接串:要用数据库就在 app.yaml 里写 database: postgres,Ferry 会建库并把连接串注入环境变量 DATABASE_URL,代码里用 process.env.DATABASE_URL。",
      "连的如果是别的系统的 PostgreSQL(不是本应用自己的库),Ferry 目前不支持,去掉这部分功能并告诉用户。",
    );
  }
  if (hasOtherSystem) {
    parts.push(
      "MySQL、Redis、MongoDB、消息队列等的连接串:不要换成 DATABASE_URL(那是本应用自己的 PostgreSQL),Ferry 目前不支持连接这些系统。" +
        "数据要存在本应用的 PostgreSQL 里(app.yaml 写 database: postgres);连接别的系统的功能按下面的办法处理。",
    );
  }
  if (hasOther || hasOtherSystem) {
    parts.push(
      "第三方 API key、群机器人 webhook、令牌、私钥、别的系统的连接串等:Ferry 目前还不能给应用配置这类密钥。" +
        "删掉代码里的密钥,改为从环境变量读取(如 process.env.DINGTALK_WEBHOOK),读不到时只关闭这个功能、应用照常运行,不要报错退出;" +
        "然后重新发布,并告诉用户这个功能要等平台支持配置密钥后才能用。",
    );
  }
  parts.push(
    "扫到的如果不是真的密钥(示例值、测试数据),换成明显的占位符(如 xxx)。" +
      "如果是真的密钥,提醒用户到对应平台作废它并重新生成,因为它已经随代码包上传过。",
  );
  return {
    fixable: true,
    type: "scan_failed",
    message: `代码里发现了 ${findings.length} 处硬编码的密钥,发布已停止`,
    logs: listed.join("\n"),
    hint: parts.join(""),
  };
}
