import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArchiveStore } from "./types";

/** 内存实现,测试用 */
export class MemoryArchiveStore implements ArchiveStore {
  private readonly archives = new Map<string, Buffer>();

  async save(appName: string, version: string, zip: Buffer): Promise<void> {
    this.archives.set(`${appName}/${version}`, zip);
  }

  async read(appName: string, version: string): Promise<Buffer | undefined> {
    return this.archives.get(`${appName}/${version}`);
  }
}

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/;

/**
 * 把代码包存在本地目录:<dir>/<应用名>/<版本>.zip。
 * TODO: 目前只增不减。应当只保留线上版本和上一个版本,其余定期清理。
 */
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

  private path(appName: string, version: string): string {
    // 两段都由服务自己生成和校验过,这里再拦一次,防止拼出目录之外的路径
    if (!SAFE_SEGMENT.test(appName) || !SAFE_SEGMENT.test(version)) {
      throw new Error("代码包路径不合法");
    }
    return join(this.dir, appName, `${version}.zip`);
  }
}
