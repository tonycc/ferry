import { desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { AuthStore, PasswordRecord, PersonalToken, Session } from "../auth/store";
import * as schema from "./schema";

export class PostgresAuthStore implements AuthStore {
  constructor(private readonly db: PostgresJsDatabase<typeof schema>) {}

  async getPassword(userId: string) {
    const [row] = await this.db.select().from(schema.userPasswords).where(eq(schema.userPasswords.userId, userId));
    return row && toPassword(row);
  }

  async savePassword(p: PasswordRecord) {
    const row = { ...p, updatedBy: p.updatedBy ?? null };
    await this.db
      .insert(schema.userPasswords)
      .values(row)
      .onConflictDoUpdate({
        target: schema.userPasswords.userId,
        set: { hash: row.hash, mustChange: row.mustChange, updatedAt: row.updatedAt, updatedBy: row.updatedBy },
      });
  }

  async listPasswords() {
    return (await this.db.select().from(schema.userPasswords)).map(toPassword);
  }

  async deletePassword(userId: string) {
    await this.db.delete(schema.userPasswords).where(eq(schema.userPasswords.userId, userId));
  }

  async saveSession(s: Session) {
    await this.db.insert(schema.sessions).values(s).onConflictDoNothing();
  }

  async getSession(tokenHash: string) {
    const [row] = await this.db.select().from(schema.sessions).where(eq(schema.sessions.tokenHash, tokenHash));
    return row;
  }

  async deleteSession(tokenHash: string) {
    await this.db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, tokenHash));
  }

  async deleteSessionsOf(userId: string) {
    await this.db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
  }

  async saveToken(t: PersonalToken) {
    const row = { ...t, lastUsedAt: t.lastUsedAt ?? null, revokedAt: t.revokedAt ?? null };
    await this.db
      .insert(schema.personalTokens)
      .values(row)
      .onConflictDoUpdate({ target: schema.personalTokens.id, set: { lastUsedAt: row.lastUsedAt, revokedAt: row.revokedAt } });
  }

  async getTokenByHash(tokenHash: string) {
    const [row] = await this.db.select().from(schema.personalTokens).where(eq(schema.personalTokens.tokenHash, tokenHash));
    return row && toToken(row);
  }

  async listTokens(userId: string) {
    const rows = await this.db
      .select()
      .from(schema.personalTokens)
      .where(eq(schema.personalTokens.userId, userId))
      .orderBy(desc(schema.personalTokens.createdAt));
    return rows.map(toToken);
  }
}

function toPassword(row: typeof schema.userPasswords.$inferSelect): PasswordRecord {
  return { ...row, updatedBy: row.updatedBy ?? undefined };
}

function toToken(row: typeof schema.personalTokens.$inferSelect): PersonalToken {
  return { ...row, lastUsedAt: row.lastUsedAt ?? undefined, revokedAt: row.revokedAt ?? undefined };
}
