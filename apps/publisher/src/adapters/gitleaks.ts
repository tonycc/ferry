import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zipEntryNames } from "../zip";
import type { Finding, Scanner } from "./types";

/**
 * Ferry 的 gitleaks 配置文件:gitleaks 默认规则(去掉了几条会放过员工代码的全局豁免),加上 Ferry 自己的规则。
 * 每次扫描都用 --config 指定它,代码包里自带的 .gitleaks.toml 不起作用。说明见文件开头
 */
export const GITLEAKS_CONFIG_PATH = fileURLToPath(new URL("./gitleaks.toml", import.meta.url));

/** 打开嵌套压缩包的层数:代码包本身算一层,里面的 zip、tar.gz 等再往下两层 */
const MAX_ARCHIVE_DEPTH = 3;

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
 * 用 gitleaks 扫描代码包(任务 3.1)。gitleaks 直接读 zip,不用解压,也会打开代码包里嵌套的压缩包。
 * 代码包要先写成文件:gitleaks 从标准输入读时不会打开 zip。
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
      const { code, stderr } = await run(
        this.binary,
        [
          "dir",
          "app.zip",
          "--config",
          GITLEAKS_CONFIG_PATH,
          "--max-archive-depth",
          String(MAX_ARCHIVE_DEPTH),
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
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: 10 * 1024 * 1024 },
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
