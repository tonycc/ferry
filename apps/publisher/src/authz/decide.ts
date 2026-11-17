import type { Visibility } from "@ferry/manifest";
import type { Directory } from "../adapters/types";

export interface AccessTarget {
  ownerId: string;
  visibility: Visibility;
}

export interface Viewer {
  id: string;
  departments: readonly string[];
}

/**
 * 登录网关对每个请求调用:这个人能不能访问这个应用。
 *
 * “本部门可见”按负责人当前所在的部门判断(不是创建应用时的部门),访问者满足其一即可:
 * - 和负责人至少有一个部门相同;
 * - 在负责人任一部门的上级部门里(逐级向上,不含根部门)。
 */
export async function canAccess(app: AccessTarget, viewer: Viewer, directory: Directory): Promise<boolean> {
  if (app.ownerId === viewer.id) return true;
  switch (app.visibility) {
    case "self":
      return false;
    case "company":
      return true;
    case "department": {
      if (viewer.departments.length === 0) return false;
      const scope = new Set<string>();
      for (const dept of await directory.departmentsOf(app.ownerId)) {
        scope.add(dept);
        for (const ancestor of await directory.ancestorsOf(dept)) scope.add(ancestor);
      }
      return viewer.departments.some((dept) => scope.has(dept));
    }
  }
}
