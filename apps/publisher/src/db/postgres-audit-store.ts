import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { AuditAction, AuditEvent, AuditQuery, AuditStore, NewAuditEvent } from "../audit/store";
import * as schema from "./schema";

const t = schema.auditEvents;

export class PostgresAuditStore implements AuditStore {
  constructor(private readonly db: PostgresJsDatabase<typeof schema>) {}

  async append(e: NewAuditEvent) {
    await this.db.insert(t).values({
      at: e.at,
      actorId: e.actorId ?? null,
      actorName: e.actorName ?? null,
      action: e.action,
      appName: e.appName ?? null,
      appOwnerId: e.appOwnerId ?? null,
      detail: e.detail,
    });
  }

  async list(q: AuditQuery): Promise<AuditEvent[]> {
    const where: SQL[] = [];
    if (q.appName !== undefined) where.push(eq(t.appName, q.appName));
    if (q.actorId !== undefined) where.push(eq(t.actorId, q.actorId));
    if (q.action !== undefined) where.push(eq(t.action, q.action));
    if (q.beforeId !== undefined) where.push(lt(t.id, q.beforeId));
    const rows = await this.db
      .select()
      .from(t)
      .where(and(...where))
      .orderBy(desc(t.id))
      .limit(q.limit);
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      actorId: r.actorId ?? undefined,
      actorName: r.actorName ?? undefined,
      action: r.action as AuditAction,
      appName: r.appName ?? undefined,
      appOwnerId: r.appOwnerId ?? undefined,
      detail: r.detail as Record<string, unknown>,
    }));
  }
}
