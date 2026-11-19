import { mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "@ferry/manifest";
import { afterEach, describe, expect, it } from "vitest";
import { FsArchiveStore, MemoryArchiveStore } from "../adapters/archive-store";
import { pruneArchives } from "./retention";
import type { ReleaseState } from "./states";
import { MemoryStore } from "./store";

const parsed = parseManifest("name: ledger\ntemplate: node-postgres\n");
if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
const manifest = parsed.manifest;
const HOUR = 3600_000;
const ZIP = Buffer.from("PK\x03\x04");

async function setup(releases: [version: string, state: ReleaseState][], liveVersion?: string) {
  const store = new MemoryStore();
  let clock = new Date("2026-11-17T00:00:00Z");
  const archives = new MemoryArchiveStore(() => clock);
  await store.createApp({
    name: "ledger",
    ownerId: "dingtalk:alice",
    visibility: "self",
    host: "ledger.apps.test",
    platform: {},
    liveVersion,
    createdAt: clock,
  });
  let n = 0;
  for (const [version, state] of releases) {
    await archives.save("ledger", version, ZIP);
    await store.saveRelease({
      id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
      kind: "publish",
      appName: "ledger",
      ownerId: "dingtalk:alice",
      version,
      manifest,
      state,
      history: [],
      createdAt: new Date(clock.getTime() + n),
    });
  }
  const later = (hours: number) => {
    clock = new Date(clock.getTime() + hours * HOUR);
    return clock;
  };
  const remaining = async () => (await archives.list("ledger")).map((a) => a.version).sort();
  return { store, archives, later, remaining };
}

describe("pruneArchives", () => {
  it("保留线上版本和它之前的上线版本,删掉更早的和失败的", async () => {
    const { store, archives, later, remaining } = await setup(
      [
        ["v1", "LIVE"],
        ["v2", "FAILED_FIXABLE"],
        ["v3", "LIVE"],
        ["v4", "ROLLED_BACK"],
        ["v5", "LIVE"],
      ],
      "v5",
    );
    const removed = await pruneArchives(store, archives, "ledger", { now: later(25), graceMs: 24 * HOUR });
    expect(removed.sort()).toEqual(["v1", "v2", "v4"]);
    expect(await remaining()).toEqual(["v3", "v5"]);
  });

  it("手动回滚到旧版本后,线上版本仍然保留", async () => {
    // v3 上线后又手动回滚到 v1:线上是 v1,最近两个上线版本是 v3 和 v2
    const { store, archives, later, remaining } = await setup(
      [
        ["v1", "LIVE"],
        ["v2", "LIVE"],
        ["v3", "LIVE"],
      ],
      "v1",
    );
    await pruneArchives(store, archives, "ledger", { now: later(25), graceMs: 24 * HOUR });
    expect(await remaining()).toEqual(["v1", "v2", "v3"]);
  });

  it("进行中的发布、刚上传还没发布的代码包都不删", async () => {
    const { store, archives, later, remaining } = await setup(
      [
        ["v1", "LIVE"],
        ["v2", "BUILDING"],
      ],
      "v1",
    );
    later(25);
    await archives.save("ledger", "v3-uploaded", ZIP);
    await pruneArchives(store, archives, "ledger", { now: later(1), graceMs: 24 * HOUR });
    expect(await remaining()).toEqual(["v1", "v2", "v3-uploaded"]);
  });

  it("应用不存在时什么都不做", async () => {
    const { store, archives, later, remaining } = await setup([["v1", "FAILED"]]);
    expect(await pruneArchives(store, archives, "crm", { now: later(25), graceMs: 0 })).toEqual([]);
    expect(await remaining()).toEqual(["v1"]);
  });
});

describe("FsArchiveStore", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("列出代码包和保存时间,删除后读不到;删除不存在的不报错", async () => {
    dir = await mkdtemp(join(tmpdir(), "ferry-archives-"));
    const archives = new FsArchiveStore(dir);
    await archives.save("ledger", "v1", ZIP);
    await archives.save("ledger", "v2", ZIP);
    const old = new Date("2026-11-01T00:00:00Z");
    await utimes(join(dir, "ledger", "v1.zip"), old, old);

    const listed = await archives.list("ledger");
    expect(listed.map((a) => a.version).sort()).toEqual(["v1", "v2"]);
    expect(listed.find((a) => a.version === "v1")?.savedAt.toISOString()).toBe(old.toISOString());

    await archives.remove("ledger", "v1");
    await archives.remove("ledger", "v1");
    expect(await archives.read("ledger", "v1")).toBeUndefined();
    expect(await archives.list("crm")).toEqual([]);
    await expect(archives.remove("../etc", "v1")).rejects.toThrow("代码包路径不合法");

    // 删除应用的全部代码包:连目录一起删掉,别的应用不受影响
    await archives.save("crm", "v1", ZIP);
    await archives.removeAll("ledger");
    await archives.removeAll("ledger");
    expect((await readdir(dir)).sort()).toEqual(["crm"]);
    expect(await archives.list("ledger")).toEqual([]);
    await expect(archives.removeAll("../etc")).rejects.toThrow("代码包路径不合法");
  });
});
