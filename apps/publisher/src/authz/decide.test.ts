import { describe, expect, it } from "vitest";
import { MemoryDirectory } from "../adapters/directory";
import { canAccess } from "./decide";

/**
 * 组织架构:
 * company(根)
 * ├── finance
 * │   └── finance-ap
 * │       └── finance-ap-east
 * ├── sales
 * └── ops
 */
function org() {
  const dir = new MemoryDirectory();
  dir.setDepartment("company", null);
  dir.setDepartment("finance", "company");
  dir.setDepartment("finance-ap", "finance");
  dir.setDepartment("finance-ap-east", "finance-ap");
  dir.setDepartment("sales", "company");
  dir.setDepartment("ops", "company");
  // 负责人同时在应付组和运营部
  dir.setUserDepartments("alice", ["finance-ap", "ops"]);
  return dir;
}

const viewer = (id: string, ...departments: string[]) => ({ id, departments });
const app = (visibility: "self" | "department" | "company") => ({ ownerId: "alice", visibility });

describe("canAccess", () => {
  it("self: 只有负责人能访问", async () => {
    const dir = org();
    expect(await canAccess(app("self"), viewer("alice"), dir)).toBe(true);
    expect(await canAccess(app("self"), viewer("bob", "finance-ap"), dir)).toBe(false);
  });

  it("company: 所有人都能访问,包括不在组织架构里的人", async () => {
    expect(await canAccess(app("company"), viewer("carol"), org())).toBe(true);
  });

  describe("department", () => {
    it("和负责人任一部门相同就能访问", async () => {
      const dir = org();
      expect(await canAccess(app("department"), viewer("bob", "finance-ap"), dir)).toBe(true);
      expect(await canAccess(app("department"), viewer("dan", "ops"), dir)).toBe(true);
      expect(await canAccess(app("department"), viewer("erin", "sales", "ops"), dir)).toBe(true);
    });

    it("负责人部门的上级部门能访问,逐级向上", async () => {
      expect(await canAccess(app("department"), viewer("frank", "finance"), org())).toBe(true);
    });

    it("下级部门、平级部门不能访问", async () => {
      const dir = org();
      expect(await canAccess(app("department"), viewer("gina", "finance-ap-east"), dir)).toBe(false);
      expect(await canAccess(app("department"), viewer("hank", "sales"), dir)).toBe(false);
    });

    it("根部门不算上级:直接挂在根部门下的人不能访问", async () => {
      expect(await canAccess(app("department"), viewer("ceo", "company"), org())).toBe(false);
    });

    it("按负责人当前的部门判断:调岗后立即生效", async () => {
      const dir = org();
      dir.setUserDepartments("alice", ["sales"]);
      expect(await canAccess(app("department"), viewer("bob", "finance-ap"), dir)).toBe(false);
      expect(await canAccess(app("department"), viewer("hank", "sales"), dir)).toBe(true);
    });

    it("没有部门的访问者、不在组织架构里的负责人:都不放行", async () => {
      const dir = org();
      expect(await canAccess(app("department"), viewer("ivy"), dir)).toBe(false);
      const orphan = { ownerId: "ghost", visibility: "department" as const };
      expect(await canAccess(orphan, viewer("bob", "finance-ap"), dir)).toBe(false);
    });

    it("部门数据有环时不会死循环", async () => {
      const dir = new MemoryDirectory();
      dir.setDepartment("a", "b");
      dir.setDepartment("b", "a");
      dir.setUserDepartments("alice", ["a"]);
      expect(await canAccess(app("department"), viewer("bob", "b"), dir)).toBe(true);
      expect(await canAccess(app("department"), viewer("carol", "c"), dir)).toBe(false);
    });
  });
});
