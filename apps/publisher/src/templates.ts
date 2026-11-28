import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库里的模板目录。员工的 agent 拿不到这个仓库,通过 MCP 工具 get_template 取模板 */
export const DEFAULT_TEMPLATES_DIR = fileURLToPath(new URL("../../../packages/templates", import.meta.url));

export interface TemplateSummary {
  name: string;
  /** 模板 README.md 标题后的第一段 */
  description: string;
}

export interface TemplateFile {
  path: string;
  content: string;
}

const NAME = /^[a-z][a-z0-9-]*$/;
/** 不发给 agent 的文件:依赖目录和隐藏文件 */
const SKIP = (name: string) => name === "node_modules" || name.startsWith(".");

/**
 * 应用模板:每个子目录一个模板。每次调用都读磁盘,改了模板不用重启;模板都很小。
 */
export class TemplateLibrary {
  constructor(private readonly dir: string = DEFAULT_TEMPLATES_DIR) {}

  async names(): Promise<string[]> {
    const entries = await readdir(this.dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && NAME.test(e.name)).map((e) => e.name).sort();
  }

  async list(): Promise<TemplateSummary[]> {
    return Promise.all(
      (await this.names()).map(async (name) => ({
        name,
        description: firstParagraph(await readFile(join(this.dir, name, "README.md"), "utf8").catch(() => "")),
      })),
    );
  }

  /** 模板受信任的官方 Dockerfile 文本;没有这个模板时返回 undefined */
  async dockerfile(name: string): Promise<string | undefined> {
    if (!(await this.names()).includes(name)) return undefined;
    const content = await readFile(join(this.dir, name, "Dockerfile"), "utf8").catch(() => {
      throw new Error(`读取平台模板 ${name} 的 Dockerfile 失败`);
    });
    if (!content.trim()) throw new Error(`平台模板 ${name} 的 Dockerfile 为空`);
    return content;
  }

  /** 模板的全部文件;没有这个模板时返回 undefined */
  async get(name: string): Promise<TemplateFile[] | undefined> {
    if (!(await this.names()).includes(name)) return undefined;
    const files: TemplateFile[] = [];
    const walk = async (rel: string): Promise<void> => {
      for (const entry of await readdir(join(this.dir, name, rel), { withFileTypes: true })) {
        if (SKIP(entry.name)) continue;
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) files.push({ path, content: await readFile(join(this.dir, name, path), "utf8") });
      }
    };
    await walk("");
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }
}

function firstParagraph(markdown: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() && !line.startsWith("#"));
  if (start < 0) return "";
  const end = lines.findIndex((line, i) => i > start && !line.trim());
  return lines
    .slice(start, end < 0 ? undefined : end)
    .join(" ")
    .trim();
}
