import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArchiveStore } from "./types";

/** 内存实现,测试用 */
export class MemoryArchiveStore implements ArchiveStore {
  private readonly archives = new Map<string, { zip: Buffer; savedAt: Date }>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async save(appName: string, version: string, zip: Buffer): Promise<void> {
    this.archives.set(`${appName}/${version}`, { zip, savedAt: this.now() });
  }

  async read(appName: string, version: string): Promise<Buffer | undefined> {
    return this.archives.get(`${appName}/${version}`)?.zip;
  }

  async list(appName: string): Promise<{ version: string; savedAt: Date }[]> {
    const prefix = `${appName}/`;
    return [...this.archives.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, { savedAt }]) => ({ version: key.slice(prefix.length), savedAt }));
  }

  async remove(appName: string, version: string): Promise<void> {
    this.archives.delete(`${appName}/${version}`);
  }

  async removeAll(appName: string): Promise<void> {
    for (const { version } of await this.list(appName)) this.archives.delete(`${appName}/${version}`);
  }
}

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/** 把代码包存在本地目录:<dir>/<应用名>/<版本>.zip。保存时间取文件的修改时间 */
export class FsArchiveStore implements ArchiveStore {
  constructor(private readonly dir: string) {}

  async save(appName: string, version: string, zip: Buffer): Promise<void> {
    const file = this.path(appName, version);
    await mkdir(join(this.dir, appName), { recursive: true });
    await writeFile(file, zip);
  }

  async read(appName: string, version: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.path(appName, version));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  async list(appName: string): Promise<{ version: string; savedAt: Date }[]> {
    const dir = join(this.dir, this.segment(appName));
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const result: { version: string; savedAt: Date }[] = [];
    for (const name of names) {
      if (!name.endsWith(".zip")) continue;
      const version = name.slice(0, -".zip".length);
      if (!SAFE_SEGMENT.test(version)) continue;
      result.push({ version, savedAt: (await stat(join(dir, name))).mtime });
    }
    return result;
  }

  async remove(appName: string, version: string): Promise<void> {
    await rm(this.path(appName, version), { force: true });
  }

  async removeAll(appName: string): Promise<void> {
    await rm(join(this.dir, this.segment(appName)), { recursive: true, force: true });
  }

  private path(appName: string, version: string): string {
    return join(this.dir, this.segment(appName), `${this.segment(version)}.zip`);
  }

  /** 两段都由服务自己生成和校验过,这里再拦一次,防止拼出目录之外的路径 */
  private segment(value: string): string {
    if (!SAFE_SEGMENT.test(value)) throw new Error("代码包路径不合法");
    return value;
  }
}
