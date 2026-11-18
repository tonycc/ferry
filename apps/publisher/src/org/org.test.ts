import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryDirectory } from "../adapters/directory";
import { FileOrgSource } from "../adapters/org-file-source";
import { canAccess } from "../authz/decide";
import { createDevIdentity } from "../identity";
import { storeCases, type StoreCase } from "../test/stores";
import { mergeDeparted, validateSnapshot, type OrgSnapshot, type OrgSource } from "./snapshot";
import { MemoryOrgStore } from "./store";
import { OrgSync } from "./sync";

/** 公司 → 财务部 → 应付组;公司 → 销售部 */
function org(overrides: Partial<OrgSnapshot> = {}): OrgSnapshot {
  return {
    departments: [
      { id: "dingtalk:root", parentId: null, name: "公司" },
      { id: "dingtalk:finance", parentId: "dingtalk:root", name: "财务部" },
      { id: "dingtalk:finance-ap", parentId: "dingtalk:finance", name: "应付组" },
      { id: "dingtalk:sales", parentId: "dingtalk:root", name: "销售部" },
    ],
    users: [
      { id: "dingtalk:alice", name: "Alice", active: true, departmentIds: ["dingtalk:finance-ap"] },
      { id: "dingtalk:bob", name: "Bob", active: true, departmentIds: ["dingtalk:finance"] },
      { id: "dingtalk:carol", name: "Carol", active: true, departmentIds: ["dingtalk:sales"] },
    ],
    ...overrides,
  };
}

function many(n: number): OrgSnapshot {
  return org({
    users: Array.from({ length: n }, (_, i) => ({
      id: `dingtalk:u${i}`,
      name: `U${i}`,
      active: true,
      departmentIds: ["dingtalk:finance"],
    })),
  });
}

describe("validateSnapshot", () => {
  it("正常的快照没有问题", () => {
    expect(validateSnapshot(org())).toEqual([]);
  });

  it.each([
    ["没有在职人员", org({ users: [] }), "没有在职人员"],
    ["没有根部门", org({ departments: org().departments.filter((d) => d.parentId !== null) }), "没有根部门"],
    [
      "上级部门不存在",
      org({ departments: [...org().departments, { id: "dingtalk:x", parentId: "dingtalk:missing", name: "X" }] }),
      "上级部门 dingtalk:missing 不存在",
    ],
    [
      "有环",
      org({
        departments: [
          ...org().departments,
          { id: "dingtalk:a", parentId: "dingtalk:b", name: "A" },
          { id: "dingtalk:b", parentId: "dingtalk:a", name: "B" },
        ],
      }),
      "有环",
    ],
    ["ID 缺少前缀", org({ users: [{ id: "alice", name: "A", active: true, departmentIds: [] }] }), "缺少平台前缀"],
    [
      "人员所属部门不存在",
      org({ users: [{ id: "dingtalk:z", name: "Z", active: true, departmentIds: ["dingtalk:nope"] }] }),
      "所属的部门 dingtalk:nope 不存在",
    ],
  ])("%s 时拒绝", (_, snapshot, problem) => {
    expect(validateSnapshot(snapshot).join("\n")).toContain(problem);
  });

  it("在职人数一次减少过多时拒绝(超过 20% 且超过 10 人),少量离职不拒绝", () => {
    const previous = many(100);
    expect(validateSnapshot(many(79), previous).join()).toContain("减少过多");
    expect(validateSnapshot(many(85), previous)).toEqual([]);
    // 人少时,减少 20% 以上但不到 10 人,不拒绝
    expect(validateSnapshot(many(5), many(10))).toEqual([]);
  });
});

describe("mergeDeparted", () => {
  it("新快照里没有的人记为离职,保留原来的部门;已删掉的部门不保留", () => {
    const previous = org();
    const next = org({
      departments: org().departments.filter((d) => d.id !== "dingtalk:sales"),
      users: org().users.filter((u) => u.id === "dingtalk:bob"),
    });
    const { snapshot, departed } = mergeDeparted(next, previous);
    expect(departed).toBe(2);
    expect(snapshot.users.find((u) => u.id === "dingtalk:alice")).toMatchObject({ active: false, departmentIds: ["dingtalk:finance-ap"] });
    expect(snapshot.users.find((u) => u.id === "dingtalk:carol")).toMatchObject({ active: false, departmentIds: [] });
    expect(validateSnapshot(snapshot, previous)).toEqual([]);
  });

  it("数据源直接标记为离职、部门为空时,也保留原来的部门", () => {
    const next = org({
      users: org().users.map((u) => (u.id === "dingtalk:alice" ? { ...u, active: false, departmentIds: [] } : u)),
    });
    const { snapshot, departed } = mergeDeparted(next, org());
    expect(departed).toBe(1);
    expect(snapshot.users.find((u) => u.id === "dingtalk:alice")?.departmentIds).toEqual(["dingtalk:finance-ap"]);
  });
});

class StubSource implements OrgSource {
  next: OrgSnapshot | Error = org();
  calls = 0;
  async fetch(): Promise<OrgSnapshot> {
    this.calls++;
    await new Promise((r) => setTimeout(r, 5));
    if (this.next instanceof Error) throw this.next;
    return structuredClone(this.next);
  }
}

const quiet = { info: () => {}, error: () => {} };

let storeCase: StoreCase;

describe.each(storeCases("ferry_test_org"))("组织架构同步:$name", (c) => {
  beforeAll(() => c.init());
  beforeEach(async () => {
    storeCase = c;
    await c.reset();
  });
  afterAll(() => c.close());

  it("保存后原样读回;没有同步过时读到 undefined", async () => {
    const store = storeCase.createOrg();
    expect(await store.load()).toBeUndefined();
    const snapshot = mergeDeparted(org({ users: org().users.slice(1) }), org()).snapshot;
    await store.save(snapshot);
    const loaded = await store.load();
    const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(loaded!.departments)).toEqual(byId(snapshot.departments));
    expect(byId(loaded!.users)).toEqual(byId(snapshot.users));
  });

  it("同步后可以按部门判定;重启后不等同步就能从数据库恢复", async () => {
    const source = new StubSource();
    const directory = new MemoryDirectory();
    const sync = new OrgSync(source, storeCase.createOrg(), directory, quiet);
    expect(await sync.run()).toMatchObject({ status: "applied", departments: 4, active: 3, departed: 0 });

    const app = { ownerId: "dingtalk:alice", visibility: "department" as const };
    const viewer = async (id: string, dir: MemoryDirectory) => ({ id, departments: await dir.departmentsOf(id) });
    expect(await canAccess(app, await viewer("dingtalk:bob", directory), directory)).toBe(true);

    // 模拟重启:新的内存组织架构,数据源暂时不可用
    const restarted = new MemoryDirectory();
    source.next = new Error("连不上数据源");
    const after = new OrgSync(source, storeCase.createOrg(), restarted, quiet);
    await after.init();
    expect(await after.run()).toMatchObject({ status: "failed" });
    // 上级部门(财务部)的人能访问,其他部门的人不能
    expect(await canAccess(app, await viewer("dingtalk:bob", restarted), restarted)).toBe(true);
    expect(await canAccess(app, await viewer("dingtalk:carol", restarted), restarted)).toBe(false);
  });

  it("有问题的快照整份拒绝,数据库和内存里都保留原来的数据", async () => {
    const source = new StubSource();
    const store = storeCase.createOrg();
    const directory = new MemoryDirectory();
    const sync = new OrgSync(source, store, directory, quiet);
    await sync.run();
    const before = await store.load();

    source.next = org({ users: [] });
    expect(await sync.run()).toMatchObject({ status: "rejected" });
    expect(await store.load()).toEqual(before);
    expect(await directory.departmentsOf("dingtalk:bob")).toEqual(["dingtalk:finance"]);
  });

  it("离职的负责人保留部门,同事照常访问他的应用", async () => {
    const source = new StubSource();
    const directory = new MemoryDirectory();
    const sync = new OrgSync(source, storeCase.createOrg(), directory, quiet);
    await sync.run();
    source.next = org({ users: org().users.filter((u) => u.id !== "dingtalk:alice") });
    expect(await sync.run()).toMatchObject({ status: "applied", departed: 1 });

    const app = { ownerId: "dingtalk:alice", visibility: "department" as const };
    const bob = { id: "dingtalk:bob", departments: await directory.departmentsOf("dingtalk:bob") };
    expect(await canAccess(app, bob, directory)).toBe(true);
  });

  it("同步不会并发执行:进行中再调用,返回同一次的结果", async () => {
    const source = new StubSource();
    const sync = new OrgSync(source, storeCase.createOrg(), new MemoryDirectory(), quiet);
    const [a, b] = await Promise.all([sync.run(), sync.run()]);
    expect(a).toBe(b);
    expect(source.calls).toBe(1);
  });
});

describe("没有配置数据源时", () => {
  it("不同步,也不改动内存里的组织架构", async () => {
    const directory = new MemoryDirectory();
    directory.setUserDepartments("dingtalk:bob", ["dingtalk:finance"]);
    const sync = new OrgSync(undefined, new MemoryOrgStore(), directory, quiet);
    await sync.init();
    expect(await sync.run()).toEqual({ status: "skipped" });
    expect(await directory.departmentsOf("dingtalk:bob")).toEqual(["dingtalk:finance"]);
  });
});

describe("FileOrgSource", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ferry-org-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("仓库里的示例组织架构可以读取并通过检查", async () => {
    const sample = fileURLToPath(new URL("../../../../infra/dev-org.json", import.meta.url));
    const snapshot = await new FileOrgSource(sample).fetch();
    expect(validateSnapshot(snapshot)).toEqual([]);
    expect(snapshot.users.every((u) => u.active)).toBe(true);
  });

  it("文件不是合法的 JSON 时,报错里不带文件内容", async () => {
    const file = join(dir, "broken.json");
    await writeFile(file, '{"users": [{"name": "张三"');
    const error = await new FileOrgSource(file).fetch().then(
      () => new Error("应当失败"),
      (e: Error) => e,
    );
    expect(error.message).toBe("组织架构文件不是合法的 JSON");
  });
});

describe("开发用身份", () => {
  it("部门从组织架构查,忽略请求头里的部门", async () => {
    const directory = new MemoryDirectory();
    directory.replace(org());
    const identity = createDevIdentity(new Set(["dingtalk:carol"]), directory);
    expect(await identity({ "x-ferry-user": "dingtalk:bob", "x-ferry-department": "dingtalk:sales" })).toEqual({
      id: "dingtalk:bob",
      departments: ["dingtalk:finance"],
      isAdmin: false,
    });
    expect((await identity({ "x-ferry-user": "dingtalk:carol" })).isAdmin).toBe(true);
    expect((await identity({ "x-ferry-user": "dingtalk:nobody" })).departments).toEqual([]);
    await expect(identity({})).rejects.toThrow("缺少身份信息");
  });
});
