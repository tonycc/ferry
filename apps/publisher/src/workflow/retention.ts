import type { ArchiveStore } from "../adapters/types";
import { isTerminal } from "./states";
import type { Store } from "./store";

/**
 * 清理一个应用不再需要的代码包,返回删掉的版本。保留:
 * - 线上版本:健康检查失败时自动回滚要用;
 * - 最近两个不同的上线版本(当前线上和它之前的一个):手动回滚要用;
 * - 还在进行中的发布用到的版本;
 * - 最近 graceMs 内上传的:可能刚上传、还没调用发布。
 */
export async function pruneArchives(
  store: Store,
  archives: ArchiveStore,
  appName: string,
  options: { now: Date; graceMs: number },
): Promise<string[]> {
  const app = await store.getApp(appName);
  if (!app) return [];
  // 从新到旧排列且不读 error.logs 大字段
  const releases = await store.listReleaseSummaries(appName);

  const keep = new Set<string>();
  if (app.liveVersion) keep.add(app.liveVersion);
  const liveVersions: string[] = [];
  for (const release of releases) {
    if (release.state !== "LIVE" || liveVersions.includes(release.version)) continue;
    liveVersions.push(release.version);
    if (liveVersions.length === 2) break;
  }
  for (const version of liveVersions) keep.add(version);
  for (const release of releases) if (!isTerminal(release.state)) keep.add(release.version);

  const removed: string[] = [];
  for (const { version, savedAt } of await archives.list(appName)) {
    if (keep.has(version)) continue;
    if (options.now.getTime() - savedAt.getTime() < options.graceMs) continue;
    await archives.remove(appName, version);
    removed.push(version);
  }
  return removed;
}
