import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { OrgSnapshot } from "../org/snapshot";
import type { OrgStore } from "../org/store";
import * as schema from "./schema";

export class PostgresOrgStore implements OrgStore {
  constructor(private readonly db: PostgresJsDatabase<typeof schema>) {}

  async load(): Promise<OrgSnapshot | undefined> {
    const [departments, users] = await Promise.all([
      this.db.select().from(schema.orgDepartments),
      this.db.select().from(schema.orgUsers),
    ]);
    if (departments.length === 0 && users.length === 0) return undefined;
    return {
      departments: departments.map((d) => ({ id: d.id, parentId: d.parentId ?? null, name: d.name })),
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        active: u.active,
        departmentIds: u.departmentIds as string[],
        ...(u.jobNumber ? { jobNumber: u.jobNumber } : {}),
        ...(u.mobile ? { mobile: u.mobile } : {}),
      })),
    };
  }

  async save(snapshot: OrgSnapshot): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(schema.orgUsers);
      await tx.delete(schema.orgDepartments);
      for (let i = 0; i < snapshot.departments.length; i += 500) {
        await tx.insert(schema.orgDepartments).values(snapshot.departments.slice(i, i + 500));
      }
      for (let i = 0; i < snapshot.users.length; i += 500) {
        await tx.insert(schema.orgUsers).values(
          snapshot.users.slice(i, i + 500).map((u) => ({ ...u, jobNumber: u.jobNumber ?? null, mobile: u.mobile ?? null })),
        );
      }
    });
  }
}
