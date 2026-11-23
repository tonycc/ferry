import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { OrgSnapshot } from "../org/snapshot";
import { EMPTY_ORG, type OrgStore } from "../org/store";
import * as schema from "./schema";

type Db = PostgresJsDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** 修改组织架构时持有的咨询锁:Ferry 和命令行是两个进程,靠它排队 */
const ORG_LOCK = 0x6f7267; // "org"

export class PostgresOrgStore implements OrgStore {
  constructor(private readonly db: Db) {}

  async load(): Promise<OrgSnapshot | undefined> {
    return read(this.db);
  }

  async update(change: (current: OrgSnapshot) => OrgSnapshot): Promise<OrgSnapshot> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${ORG_LOCK})`);
      const next = change((await read(tx)) ?? structuredClone(EMPTY_ORG));
      await tx.delete(schema.orgUsers);
      await tx.delete(schema.orgDepartments);
      for (let i = 0; i < next.departments.length; i += 500) {
        await tx.insert(schema.orgDepartments).values(next.departments.slice(i, i + 500));
      }
      for (let i = 0; i < next.users.length; i += 500) {
        await tx.insert(schema.orgUsers).values(
          next.users.slice(i, i + 500).map((u) => ({
            id: u.id,
            name: u.name,
            active: u.active,
            departmentIds: u.departmentIds,
            jobNumber: u.jobNumber ?? null,
            mobile: u.mobile ?? null,
            isAdmin: u.isAdmin ?? false,
          })),
        );
      }
      return next;
    });
  }
}

async function read(db: Db | Tx): Promise<OrgSnapshot | undefined> {
  const [departments, users] = await Promise.all([db.select().from(schema.orgDepartments), db.select().from(schema.orgUsers)]);
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
      ...(u.isAdmin ? { isAdmin: true } : {}),
    })),
  };
}
