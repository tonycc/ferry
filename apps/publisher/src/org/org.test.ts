import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MemoryDirectory } from "../adapters/directory";
import { AuditLog } from "../audit/log";
import { MemoryAuditStore } from "../audit/store";
import { canAccess } from "../authz/decide";
import { createIdentity } from "../identity";
import { storeCases, type StoreCase } from "../test/stores";
import { Organization } from "./service";
import { validateSnapshot, type OrgSnapshot } from "./snapshot";
import type { OrgStore } from "./store";

/** 公司 → 财务部 → 应付组;公司 → 销售部。Admin 在控制台设为管理员 */
function org(overrides: Partial<OrgSnapshot> = {}): OrgSnapshot {
  return {
    departments: [
      { id: "dingtalk:root", parentId: null, name: "公司" },
      { id: "dingtalk:finance", parentId: "dingtalk:root", name: "财务部" },
      { id: "dingtalk:finance-ap", parentId: "dingtalk:finance", name: "应付组" },
      { id: "dingtalk:sales", parentId: "dingtalk:root", name: "销售部" },
    ],
    users: [
      { id: "dingtalk:alice", name: "Alice", active: true, departmentIds: ["dingtalk:finance-ap"], mobile: "13800000001" },
      { id: "dingtalk:bob", name: "Bob", active: true, departmentIds: ["dingtalk:finance"], mobile: "13800000002" },
      { id: "dingtalk:carol", name: "Carol", active: true, departmentIds: ["dingtalk:sales"], jobNumber: "C003" },
      { id: "dingtalk:admin", name: "Admin", active: true, departmentIds: ["dingtalk:root"], mobile: "13800000005", isAdmin: true },
    ],
    ...overrides,
  };
}

describe("validateSnapshot", () => {
  it("正常的组织架构没有问题", () => {
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
  ])("%s 时有问题", (_, snapshot, problem) => {
    expect(validateSnapshot(snapshot).join("\n")).toContain(problem);
  });
});

let storeCase: StoreCase;

describe.each(storeCases("ferry_test_org"))("人员和部门管理:$name", (c) => {
  beforeAll(() => c.init());
  beforeEach(async () => {
    storeCase = c;
    await c.reset();
  });
  afterAll(() => c.close());

  const ADMIN = "dingtalk:admin";

  /** 数据库里放好 org(),返回一个管理它的 Organization */
  async function setup(options: { fixedAdmins?: string[]; store?: OrgStore; idPrefix?: string } = {}) {
    const store = options.store ?? storeCase.createOrg();
    if (!options.store) await store.update(() => org());
    const directory = new MemoryDirectory();
    const auditStore = new MemoryAuditStore();
    const ended: string[] = [];
    let n = 0;
    const organization = new Organization(store, directory, new AuditLog(auditStore, directory), {
      fixedAdmins: new Set(options.fixedAdmins ?? []),
      onDeactivate: async (id) => void ended.push(id),
      newId: (kind) => `local:${options.idPrefix ?? ""}${kind}-${++n}`,
    });
    await organization.reload();
    const actions = async () => (await auditStore.list({ limit: 100 })).map((e) => e.action).reverse();
    return { store, directory, organization, ended, actions };
  }

  it("存进数据库后原样读回(包括管理员身份);没有数据时读到 undefined", async () => {
    const store = storeCase.createOrg();
    expect(await store.load()).toBeUndefined();
    await store.update(() => org());
    const loaded = await store.load();
    const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((a, b) => a.id.localeCompare(b.id));
    expect(byId(loaded!.departments)).toEqual(byId(org().departments));
    expect(byId(loaded!.users)).toEqual(byId(org().users));
  });

  it("修改出错时什么都不写", async () => {
    const { store, organization } = await setup();
    const before = await store.load();
    await expect(organization.createUser(ADMIN, { name: "Dan", mobile: "13800000001", departmentIds: ["dingtalk:sales"] })).rejects.toThrow(
      "手机号和在职的 Alice 重复",
    );
    expect(await store.load()).toEqual(before);
  });

  it("空的组织架构:命令行建第一个管理员,同时建最上级部门;同一个手机号再运行只设管理员", async () => {
    const store = storeCase.createOrg();
    const { directory, organization, actions } = await setup({ store });
    const first = await organization.bootstrapAdmin({ name: "Max", mobile: "+86 138-0000-0009", orgName: "示例公司" });
    expect(first.created).toBe(true);
    expect(await directory.findLogin("13800000009")).toBe(first.userId);
    expect(await directory.isAdmin(first.userId)).toBe(true);
    const view = await organization.view();
    expect(view.departments).toEqual([{ id: "local:department-2", parentId: null, name: "示例公司", memberCount: 1 }]);

    const again = await organization.bootstrapAdmin({ name: "Max", mobile: "13800000009" });
    expect(again).toEqual({ userId: first.userId, created: false });
    expect((await organization.view()).users).toHaveLength(1);
    expect(await actions()).toEqual(["user.create"]);
  });

  it("命令行把已有的人设为管理员", async () => {
    const { directory, organization } = await setup();
    expect(await organization.bootstrapAdmin({ name: "随便", mobile: "13800000002" })).toEqual({ userId: "dingtalk:bob", created: false });
    expect(await directory.isAdmin("dingtalk:bob")).toBe(true);
  });

  it("新建人员:马上能按手机号或工号找到,所属部门马上用于权限判定", async () => {
    const { directory, organization, actions } = await setup();
    const dan = await organization.createUser(ADMIN, { name: " Dan ", mobile: "138 0000 0006", jobNumber: "D006", departmentIds: ["dingtalk:finance"] });
    expect(dan).toMatchObject({ id: "local:user-1", name: "Dan", mobile: "13800000006", jobNumber: "D006", active: true });
    expect(await directory.findLogin("13800000006")).toBe(dan.id);
    expect(await directory.findLogin("d006")).toBe(dan.id);
    const app = { ownerId: "dingtalk:alice", visibility: "department" as const };
    expect(await canAccess(app, { id: dan.id, departments: await directory.departmentsOf(dan.id) }, directory)).toBe(true);
    expect(await actions()).toEqual(["user.create"]);
  });

  it.each([
    [{ name: "", mobile: "13800000006", departmentIds: ["dingtalk:sales"] }, "姓名不能为空"],
    [{ name: "Dan", departmentIds: ["dingtalk:sales"] }, "手机号和工号至少填一个"],
    [{ name: "Dan", mobile: "12345", departmentIds: ["dingtalk:sales"] }, "11 位"],
    [{ name: "Dan", mobile: "13800000006", departmentIds: [] }, "至少选一个部门"],
    [{ name: "Dan", mobile: "13800000006", departmentIds: ["dingtalk:nope"] }, "选的部门不存在"],
    [{ name: "Dan", jobNumber: "c003", departmentIds: ["dingtalk:sales"] }, "工号和在职的 Carol 重复"],
    [{ name: "Dan", jobNumber: "a b", departmentIds: ["dingtalk:sales"] }, "不能有空格"],
  ])("新建人员时检查输入:%o", async (input, message) => {
    const { organization } = await setup();
    await expect(organization.createUser(ADMIN, input)).rejects.toThrow(message);
  });

  it("修改人员:换部门后权限按新部门判定;可以清空手机号改用工号;记下改了哪些字段", async () => {
    const { directory, organization, store } = await setup();
    const app = { ownerId: "dingtalk:alice", visibility: "department" as const };
    const carol = async () => ({ id: "dingtalk:carol", departments: await directory.departmentsOf("dingtalk:carol") });
    expect(await canAccess(app, await carol(), directory)).toBe(false);
    await organization.updateUser(ADMIN, "dingtalk:carol", { name: "Carol", jobNumber: "C003", departmentIds: ["dingtalk:finance"] });
    expect(await canAccess(app, await carol(), directory)).toBe(true);

    await organization.updateUser(ADMIN, "dingtalk:bob", { name: "Bob", mobile: "", jobNumber: "B002", departmentIds: ["dingtalk:finance"] });
    const bob = (await store.load())!.users.find((u) => u.id === "dingtalk:bob")!;
    expect(bob.mobile).toBeUndefined();
    expect(await directory.findLogin("13800000002")).toBeUndefined();
    expect(await directory.findLogin("B002")).toBe("dingtalk:bob");
  });

  it("离职:不能登录、作废登录会话、保留部门(同事照常访问他的应用);不能把自己标为离职", async () => {
    const { directory, organization, ended, actions } = await setup();
    await expect(organization.deactivate(ADMIN, ADMIN)).rejects.toThrow("不能把自己标记为离职");
    await organization.deactivate(ADMIN, "dingtalk:alice");
    expect(await directory.isActive("dingtalk:alice")).toBe(false);
    expect(await directory.findLogin("13800000001")).toBeUndefined();
    expect(ended).toEqual(["dingtalk:alice"]);
    const app = { ownerId: "dingtalk:alice", visibility: "department" as const };
    expect(await canAccess(app, { id: "dingtalk:bob", departments: ["dingtalk:finance"] }, directory)).toBe(true);
    await expect(organization.deactivate(ADMIN, "dingtalk:alice")).rejects.toThrow("已经是离职状态");

    // 离职后手机号可以给新的人用;这时再恢复原来的人会冲突
    const newcomer = await organization.createUser(ADMIN, { name: "Ann", mobile: "13800000001", departmentIds: ["dingtalk:sales"] });
    await expect(organization.reactivate(ADMIN, "dingtalk:alice")).rejects.toThrow("手机号和在职的 Ann 重复");
    await organization.deactivate(ADMIN, newcomer.id);
    await organization.reactivate(ADMIN, "dingtalk:alice");
    expect(await directory.findLogin("13800000001")).toBe("dingtalk:alice");
    expect(await actions()).toEqual(["user.deactivate", "user.create", "user.deactivate", "user.reactivate"]);
  });

  it("管理员:控制台设的管理员马上生效;ADMIN_USERS 里的人不能取消;不能取消自己;离职的人不能设为管理员", async () => {
    const { directory, organization } = await setup({ fixedAdmins: ["dingtalk:carol"] });
    const identity = createIdentity({ directory, adminIds: new Set(["dingtalk:carol"]), devAuth: true, allowedOrigins: new Set() });
    const isAdmin = async (id: string) => (await identity({ method: "GET", headers: { "x-ferry-user": id } }, "api")).isAdmin;

    await organization.setAdmin(ADMIN, "dingtalk:bob", true);
    expect(await isAdmin("dingtalk:bob")).toBe(true);
    expect(directory.adminIds().sort()).toEqual([ADMIN, "dingtalk:bob"]);
    await organization.setAdmin(ADMIN, "dingtalk:bob", false);
    expect(await isAdmin("dingtalk:bob")).toBe(false);

    await expect(organization.setAdmin(ADMIN, "dingtalk:carol", false)).rejects.toThrow("ADMIN_USERS");
    expect(await isAdmin("dingtalk:carol")).toBe(true);
    await expect(organization.setAdmin(ADMIN, ADMIN, false)).rejects.toThrow("不能取消自己的管理员身份");

    await organization.deactivate(ADMIN, "dingtalk:alice");
    await expect(organization.setAdmin(ADMIN, "dingtalk:alice", true)).rejects.toThrow("已离职");
    // 离职的管理员不再算管理员,也不收告警
    await organization.setAdmin(ADMIN, "dingtalk:bob", true);
    await organization.deactivate(ADMIN, "dingtalk:bob");
    expect(await isAdmin("dingtalk:bob")).toBe(false);
    expect(directory.adminIds()).toEqual([ADMIN]);
  });

  it("部门:新建、改名、调整上级;同级不能重名;不能移到自己的下级下面;最上级部门不能移动", async () => {
    const { directory, organization, actions } = await setup();
    const team = await organization.createDepartment(ADMIN, { name: "核算组", parentId: "dingtalk:finance" });
    expect(await directory.departmentNameOf(team.id)).toBe("核算组");
    await expect(organization.createDepartment(ADMIN, { name: "核算组", parentId: "dingtalk:finance" })).rejects.toThrow("已经有叫“核算组”的部门");
    await expect(organization.createDepartment(ADMIN, { name: "X", parentId: null })).rejects.toThrow("要选上级部门");

    await expect(organization.updateDepartment(ADMIN, "dingtalk:finance", { name: "财务部", parentId: team.id })).rejects.toThrow(
      "不能把部门调整到它自己或它的下级部门下面",
    );
    await expect(organization.updateDepartment(ADMIN, "dingtalk:root", { name: "公司", parentId: "dingtalk:sales" })).rejects.toThrow(
      "最上级部门不能调整",
    );

    // 应付组调到销售部下面:Bob(财务部)不再是 Alice 的上级部门的人
    const app = { ownerId: "dingtalk:alice", visibility: "department" as const };
    const bob = { id: "dingtalk:bob", departments: ["dingtalk:finance"] };
    expect(await canAccess(app, bob, directory)).toBe(true);
    await organization.updateDepartment(ADMIN, "dingtalk:finance-ap", { name: "应付组", parentId: "dingtalk:sales" });
    expect(await canAccess(app, bob, directory)).toBe(false);

    await organization.updateDepartment(ADMIN, "dingtalk:root", { name: "示例公司", parentId: null });
    expect(await directory.departmentNameOf("dingtalk:root")).toBe("示例公司");
    expect(await actions()).toEqual(["department.create", "department.update", "department.update"]);
  });

  it("部门:有下级部门或有人(包括已离职的人)时不能删除;最上级部门不能删除", async () => {
    const { organization } = await setup();
    await expect(organization.deleteDepartment(ADMIN, "dingtalk:root")).rejects.toThrow("最上级部门不能删除");
    await expect(organization.deleteDepartment(ADMIN, "dingtalk:finance")).rejects.toThrow("还有下级部门");
    await organization.deactivate(ADMIN, "dingtalk:carol");
    await expect(organization.deleteDepartment(ADMIN, "dingtalk:sales")).rejects.toThrow("还有 1 人(其中 1 人已离职)");
    await organization.updateUser(ADMIN, "dingtalk:carol", { name: "Carol", jobNumber: "C003", departmentIds: ["dingtalk:root"] });
    await organization.deleteDepartment(ADMIN, "dingtalk:sales");
    expect((await organization.view()).departments.map((d) => d.id)).not.toContain("dingtalk:sales");
  });

  it("两个进程同时改:每次都基于数据库里最新的数据,不会用过时的内存数据覆盖别人刚写的", async () => {
    const store = storeCase.createOrg();
    await store.update(() => org());
    const ferry = await setup({ store });
    const cli = await setup({ store: storeCase.createOrg(), idPrefix: "cli-" });
    // 命令行(另一个进程)新建了一个人,Ferry 内存里还没有
    const fromCli = await cli.organization.createUser(undefined, { name: "Cli", mobile: "13800000007", departmentIds: ["dingtalk:sales"] });
    expect(await ferry.directory.isActive(fromCli.id)).toBe(false);
    // Ferry 接着在控制台上新建另一个人:命令行建的人还在,而且一起换进了 Ferry 的内存
    await ferry.organization.createUser(ADMIN, { name: "Web", mobile: "13800000008", departmentIds: ["dingtalk:sales"] });
    expect((await store.load())!.users.map((u) => u.name)).toEqual(expect.arrayContaining(["Cli", "Web"]));
    expect(await ferry.directory.isActive(fromCli.id)).toBe(true);
  });
});

describe("开发用身份", () => {
  it("部门从组织架构查,忽略请求头里的部门", async () => {
    const directory = new MemoryDirectory();
    directory.replace(org());
    const resolve = createIdentity({ directory, adminIds: new Set(["dingtalk:carol"]), devAuth: true, allowedOrigins: new Set() });
    const identity = (headers: Record<string, string>) => resolve({ method: "GET", headers }, "api");
    expect(await identity({ "x-ferry-user": "dingtalk:bob", "x-ferry-department": "dingtalk:sales" })).toEqual({
      id: "dingtalk:bob",
      departments: ["dingtalk:finance"],
      isAdmin: false,
    });
    expect((await identity({ "x-ferry-user": "dingtalk:carol" })).isAdmin).toBe(true);
    expect((await identity({ "x-ferry-user": "dingtalk:nobody" })).departments).toEqual([]);
    await expect(identity({})).rejects.toThrow("需要先登录");
  });
});
