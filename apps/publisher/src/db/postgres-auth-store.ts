import { and, desc, eq, gte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { AuthStore, LoginChallenge, PersonalToken, Session } from "../auth/store";
import * as schema from "./schema";

export class PostgresAuthStore implements AuthStore {
  constructor(private readonly db: PostgresJsDatabase<typeof schema>) {}

  async saveChallenge(c: LoginChallenge) {
    const row = { ...c, usedAt: c.usedAt ?? null };
    await this.db
      .insert(schema.loginChallenges)
      .values(row)
      .onConflictDoUpdate({ target: schema.loginChallenges.id, set: { attempts: row.attempts, usedAt: row.usedAt } });
  }

  async getChallenge(id: string) {
    const [row] = await this.db.select().from(schema.loginChallenges).where(eq(schema.loginChallenges.id, id));
    return row && toChallenge(row);
  }

  async listChallengesSince(userId: string, since: Date) {
    const rows = await this.db
      .select()
      .from(schema.loginChallenges)
      .where(and(eq(schema.loginChallenges.userId, userId), gte(schema.loginChallenges.createdAt, since)))
      .orderBy(desc(schema.loginChallenges.createdAt));
    return rows.map(toChallenge);
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

function toChallenge(row: typeof schema.loginChallenges.$inferSelect): LoginChallenge {
  return { ...row, usedAt: row.usedAt ?? undefined };
}

function toToken(row: typeof schema.personalTokens.$inferSelect): PersonalToken {
  return { ...row, lastUsedAt: row.lastUsedAt ?? undefined, revokedAt: row.revokedAt ?? undefined };
}
