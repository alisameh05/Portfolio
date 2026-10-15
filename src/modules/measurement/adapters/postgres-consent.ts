import { sql } from "kysely";
import type { StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import { resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { ConsentRepositoryPort, CurrentConsent } from "../application/consent.js";

async function scoped(portfolioId: StableId<"Portfolio">, tx: TransactionContext) {
  const db = resolvePostgresTransaction(tx);
  await sql`select set_config('shipwithali.portfolio_id', ${portfolioId}, true)`.execute(db);
  return db;
}
export function createPostgresConsentRepository(): ConsentRepositoryPort {
  return {
    async lock(portfolioId, consentId, tx) {
      const db = await scoped(portfolioId, tx);
      // Covers missing-row creation as well as existing-row updates with one lock protocol.
      await sql`select pg_advisory_xact_lock(hashtextextended(${portfolioId + ":" + consentId}, 189))`.execute(db);
      const result = await sql<CurrentConsent>`select consent_id as "consentId", portfolio_id as "portfolioId",
        subject, state, notice_version as "noticeVersion", revision, recorded_at as "recordedAt",
        evidence_expires_at as "evidenceExpiresAt" from measurement.consents
        where portfolio_id = ${portfolioId}::uuid and consent_id = ${consentId}::uuid for update`.execute(db);
      const row = result.rows[0];
      if (!row) return null;
      return { ...row, recordedAt: new Date(row.recordedAt).toISOString(), evidenceExpiresAt: new Date(row.evidenceExpiresAt).toISOString() };
    },
    async save(record, tx) {
      const db = await scoped(record.portfolioId, tx);
      await sql`insert into measurement.consents (portfolio_id, consent_id, subject, state, notice_version, revision, recorded_at, evidence_expires_at)
        values (${record.portfolioId}::uuid, ${record.consentId}::uuid, ${record.subject}::uuid, ${record.state}, ${record.noticeVersion},
          ${record.revision}, ${record.recordedAt}::timestamptz, ${record.evidenceExpiresAt}::timestamptz)
        on conflict (portfolio_id, consent_id) do update set subject = excluded.subject, state = excluded.state,
          notice_version = excluded.notice_version, revision = excluded.revision, recorded_at = excluded.recorded_at,
          evidence_expires_at = excluded.evidence_expires_at`.execute(db);
      // No subjects, event payloads, cookies, or client identifiers in history.
      await sql`insert into measurement.consent_history (portfolio_id, consent_id, revision, state, notice_version, recorded_at)
        values (${record.portfolioId}::uuid, ${record.consentId}::uuid, ${record.revision}, ${record.state},
          ${record.noticeVersion}, ${record.recordedAt}::timestamptz)`.execute(db);
    },
  };
}
