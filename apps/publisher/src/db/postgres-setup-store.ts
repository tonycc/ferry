import { eq, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { CertificateInfo, InstanceAddress, InstanceSettings, SetupStore, WizardState } from "../setup/store";
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
      wizard: readWizard(row.wizardState),
    };
  }

  /** 单行表:没有这一行就插入,有就更新 */
  private async upsert(values: Partial<typeof settingsTable.$inferInsert>) {
    const set = { ...values, updatedAt: new Date() };
    await this.db.insert(settingsTable).values({ id: 1, ...set }).onConflictDoUpdate({ target: settingsTable.id, set });
  }

  async saveWizard(state: WizardState) {
    const { handoff, ...rest } = state;
    await this.upsert({
      wizardState: { ...rest, ...(handoff ? { handoff: { tokenHash: handoff.tokenHash, expiresAt: handoff.expiresAt.toISOString() } } : {}) },
    });
  }

  async setCertificate(certificate: CertificateInfo | undefined) {
    await this.upsert({
      certificate: certificate ? { id: certificate.id, notAfter: certificate.notAfter.toISOString(), domains: certificate.domains } : null,
    });
  }

  async setAddress(address: InstanceAddress) {
    await this.upsert(address);
  }

  async clearAddress() {
    await this.upsert({ publicUrl: null, appsDomain: null, appsUrlScheme: null });
  }

  async markCompleted(at: Date) {
    await this.upsert({ setupCompletedAt: at });
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

function readWizard(value: unknown): WizardState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as WizardState & { handoff?: { tokenHash: string; expiresAt: string | Date } };
  return {
    ...(raw.domain ? { domain: raw.domain } : {}),
    ...(raw.certificateSkipped ? { certificateSkipped: true } : {}),
    ...(raw.httpConfirmed ? { httpConfirmed: true } : {}),
    ...(raw.admin ? { admin: raw.admin } : {}),
    ...(raw.selfCheck === "passed" || raw.selfCheck === "skipped" ? { selfCheck: raw.selfCheck } : {}),
    ...(raw.handoff ? { handoff: { tokenHash: raw.handoff.tokenHash, expiresAt: new Date(raw.handoff.expiresAt) } } : {}),
  };
}
