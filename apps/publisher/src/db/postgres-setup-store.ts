import { eq, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { CertificateInfo, InstanceSettings, SetupStore } from "../setup/store";
import * as schema from "./schema";

const settingsTable = schema.instanceSettings;
const sessionsTable = schema.setupSessions;

export class PostgresSetupStore implements SetupStore {
  constructor(private readonly db: PostgresJsDatabase<typeof schema>) {}

  async getSettings(): Promise<InstanceSettings> {
    const [row] = await this.db.select().from(settingsTable).where(eq(settingsTable.id, 1));
    if (!row) return {};
    const cert = row.certificate as { id: string; notAfter: string; domains: string[] } | null;
    const certificate: CertificateInfo | undefined = cert
      ? { id: cert.id, notAfter: new Date(cert.notAfter), domains: cert.domains }
      : undefined;
    return {
      publicUrl: row.publicUrl ?? undefined,
      appsDomain: row.appsDomain ?? undefined,
      appsUrlScheme: row.appsUrlScheme === "http" || row.appsUrlScheme === "https" ? row.appsUrlScheme : undefined,
      certificate,
      setupCodeHash: row.setupCodeHash ?? undefined,
      setupCompletedAt: row.setupCompletedAt ?? undefined,
    };
  }

  async setSetupCodeHash(hash: string) {
    await this.db
      .insert(settingsTable)
      .values({ id: 1, setupCodeHash: hash, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settingsTable.id, set: { setupCodeHash: hash, updatedAt: new Date() } });
  }

  async createSession(tokenHash: string, expiresAt: Date) {
    await this.db.insert(sessionsTable).values({ tokenHash, expiresAt });
  }

  async sessionExpiry(tokenHash: string) {
    const [row] = await this.db.select().from(sessionsTable).where(eq(sessionsTable.tokenHash, tokenHash));
    return row?.expiresAt;
  }

  async deleteExpiredSessions(now: Date) {
    await this.db.delete(sessionsTable).where(lte(sessionsTable.expiresAt, now));
  }
}
