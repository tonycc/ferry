import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipEntryNames } from "../zip";
import type { Finding, Scanner } from "./types";

/**
 * Ferry 自己的 gitleaks 配置:gitleaks 自带的几百条规则,加上国内常见、自带规则里没有的几种。
 * 每次扫描都用 --config 指定它,代码包里自带的 .gitleaks.toml 不起作用。
 */
export const GITLEAKS_CONFIG = `
title = "ferry"

[extend]
useDefault = true

[[rules]]
id = "connection-string-password"
description = "数据库或消息队列的连接串里写了密码"
regex = '''(?i)\\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\\+srv)?|rediss?|amqps?|mssql|sqlserver)://[^\\s:@/'"\`]*:([^\\s@/'"\`]{3,})@[^\\s/'"\`]+'''
secretGroup = 1
keywords = ["postgres", "mysql", "mariadb", "mongodb", "redis", "amqp", "mssql", "sqlserver"]
[[rules.allowlists]]
# 模板字符串里的变量、明显的占位符
regexes = ['''^\\$\\{?[A-Za-z_]''', '''(?i)^(?:x+|\\*+|<[^>]*>|\\{[^}]*\\}|\\[[^\\]]*\\]|password|passwd|pass|pwd|secret|changeme|example|your[_-]?password)$''']

[[rules]]
id = "dingtalk-robot-webhook"
description = "钉钉群机器人 webhook(含 access_token)"
regex = '''oapi\\.dingtalk\\.com/robot/send\\?access_token=([a-f0-9]{64})'''
secretGroup = 1
keywords = ["oapi.dingtalk.com"]

[[rules]]
id = "wecom-robot-webhook"
description = "企业微信群机器人 webhook(含 key)"
regex = '''qyapi\\.weixin\\.qq\\.com/cgi-bin/webhook/send\\?key=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'''
secretGroup = 1
keywords = ["qyapi.weixin.qq.com"]

[[rules]]
id = "feishu-robot-webhook"
description = "飞书群机器人 webhook"
regex = '''open\\.(?:feishu\\.cn|larksuite\\.com)/open-apis/bot/v2/hook/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'''
secretGroup = 1
keywords = ["open.feishu.cn", "open.larksuite.com"]

[[rules]]
id = "sk-api-key"
description = "sk- 开头的大模型 API key(DeepSeek、通义千问、Kimi、OpenAI 等)"
regex = '''\\b(sk-[A-Za-z0-9_-]{32,})\\b'''
secretGroup = 1
entropy = 3.5
keywords = ["sk-"]
`;

/** gitleaks 发现密钥时的退出码;用一个不常见的值,和 gitleaks 自己出错(退出码 1)区分开 */
const LEAKS_EXIT_CODE = 7;

export interface GitleaksScannerOptions {
  /** gitleaks 可执行文件,默认在 PATH 里找 */
  binary?: string;
  /** 单次扫描的最长时间 */
  timeoutMs?: number;
}

interface GitleaksFinding {
  RuleID: string;
  Description: string;
  File: string;
  StartLine: number;
}

/**
 * 用 gitleaks 扫描代码包(任务 3.1)。gitleaks 直接读 zip,不用解压。
 *
 * - 结果里不带密钥原文(--redact),因为发布记录会存进数据库、显示在控制台上。
 * - 忽略代码里的 gitleaks:allow 注释和代码包自带的 .gitleaks.toml、.gitleaksignore,
 *   这些都由提交代码的一方控制。误报由平台管理员调整上面的配置解决。
 * - 扫描本身出了问题(找不到 gitleaks、超时、报告读不出来)时抛出异常,发布按平台问题失败,不会当作没有密钥放行。
 */
export class GitleaksScanner implements Scanner {
  private readonly binary: string;
  private readonly timeoutMs: number;

  constructor(options: GitleaksScannerOptions = {}) {
    this.binary = options.binary ?? "gitleaks";
    this.timeoutMs = options.timeoutMs ?? 120_000;
  }

  /** 启动时调用:确认 gitleaks 能运行,返回版本号 */
  async version(): Promise<string> {
    const { stdout } = await run(this.binary, ["version"], { timeoutMs: 10_000 });
    return stdout.trim();
  }

  async scan(zip: Buffer): Promise<Finding[]> {
    // gitleaks 读不出的 zip 会被当作普通文件,结果是“没有发现密钥”;所以先自己确认是合法 zip
    if (!zipEntryNames(zip)) throw new Error("代码包不是合法的 zip,无法做密钥扫描");

    // 每次扫描用一个新的临时目录,也作为 gitleaks 的工作目录:它默认读工作目录下的 .gitleaksignore
    const dir = await mkdtemp(join(tmpdir(), "ferry-scan-"));
    try {
      await writeFile(join(dir, "app.zip"), zip);
      await writeFile(join(dir, "ferry.toml"), GITLEAKS_CONFIG);
      const { code, stderr } = await run(
        this.binary,
        [
          "dir",
          "app.zip",
          "--config",
          "ferry.toml",
          "--max-archive-depth",
          "1",
          "--redact",
          "--ignore-gitleaks-allow",
          "--no-banner",
          "--no-color",
          "--log-level",
          "error",
          "--report-format",
          "json",
          "--report-path",
          "report.json",
          "--exit-code",
          String(LEAKS_EXIT_CODE),
          // 不用 gitleaks 自己的 --timeout:没验证过它到时后的退出码,可能当作扫描完成。超时由这里杀掉进程,按出错处理
        ],
        { cwd: dir, timeoutMs: this.timeoutMs },
      );
      if (code !== 0 && code !== LEAKS_EXIT_CODE) {
        throw new Error(`密钥扫描出错(gitleaks 退出码 ${code}):${stderr.trim().slice(-500)}`);
      }
      const report = JSON.parse(await readFile(join(dir, "report.json"), "utf8")) as GitleaksFinding[];
      if (!Array.isArray(report)) throw new Error("密钥扫描的报告格式不对");
      if (code === LEAKS_EXIT_CODE && report.length === 0) {
        throw new Error("密钥扫描报告发现了密钥,但报告里没有内容");
      }
      return report.map((f) => ({
        // 文件名形如 app.zip!src/config.ts
        file: f.File.slice(f.File.indexOf("!") + 1),
        line: f.StartLine,
        rule: f.RuleID,
        detail: f.Description,
      }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

function run(
  binary: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  // 去掉会覆盖 --config 优先级以外配置的环境变量,确保只用 Ferry 的配置
  const env = { ...process.env };
  delete env.GITLEAKS_CONFIG;
  delete env.GITLEAKS_CONFIG_TOML;
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { cwd: options.cwd, env, timeout: options.timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr });
        const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
        if (typeof code === "number") return resolve({ code, stdout, stderr });
        if (code === "ENOENT") return reject(new Error(`找不到 gitleaks(${binary}),无法做密钥扫描`));
        if (err.killed) return reject(new Error("密钥扫描超时"));
        reject(err);
      },
    );
  });
}
