import { sql } from "kysely";
import type { StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import { resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type {
  FeedbackOwnerExportDecisionSource,
  FeedbackOwnerExportSnapshotReaderPort,
  FeedbackOwnerExportSourceRecord,
  FeedbackOwnerExportSourceSnapshot,
} from "../application/owner-export.js";

interface CapturedAtRow { captured_at: Date | string }
interface FeedbackRow {
  feedback_id: StableId<"Feedback">;
  project_id: StableId<"Project">;
  locale: "en" | "ar";
  aggregate_version: string | number;
  moderation_state: FeedbackOwnerExportSourceRecord["state"];
  author_name: string | null;
  paragraph: string | null;
  submitted_at: Date | string;
  text_erased_at: Date | string | null;
}
interface DecisionRow {
  feedback_id: StableId<"Feedback">;
  sequence: string | number;
  decision: FeedbackOwnerExportDecisionSource["decision"];
  reason: string | null;
  decided_at: Date | string;
}

function instant(value: Date | string): string {
  const parsed = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  if (!Number.isFinite(Date.parse(parsed))) throw new Error("FEEDBACK_OWNER_EXPORT_TIMESTAMP_INVALID");
  return parsed;
}

/** Interactions-owned export reads; no project visibility filter is applied to hidden or archived projects. */
export function createPostgresFeedbackOwnerExportSnapshotReader(): FeedbackOwnerExportSnapshotReaderPort {
  return {
    async readOwnerExportSnapshot(scope: { portfolioId: StableId<"Portfolio">; ownerId: StableId<"Owner"> }, transaction: TransactionContext): Promise<FeedbackOwnerExportSourceSnapshot> {
      const db = resolvePostgresTransaction(transaction);
      await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
        set_config('shipwithali.owner_id', ${scope.ownerId}, true),
        set_config('shipwithali.feedback_access', 'owner-export', true),
        set_config('shipwithali.worker_purpose', 'interaction.owner-export', true),
        -- SET LOCAL leaves this custom setting empty on pooled connections.
        -- The existing retention SELECT policy may still evaluate its cast.
        set_config('shipwithali.retention_now', transaction_timestamp()::text, true)`.execute(db);
      const captured = await sql<CapturedAtRow>`select transaction_timestamp() as captured_at`.execute(db);
      const capturedAtValue = captured.rows[0]?.captured_at;
      if (capturedAtValue === undefined) throw new Error("FEEDBACK_OWNER_EXPORT_CAPTURE_TIME_MISSING");
      const capturedAt = instant(capturedAtValue);
      const feedback = await sql<FeedbackRow>`select feedback_id, project_id, locale, aggregate_version, moderation_state,
          author_name, paragraph, submitted_at, text_erased_at
        from interaction.feedback where portfolio_id = ${scope.portfolioId}::uuid
        order by feedback_id`.execute(db);
      const ids = feedback.rows.map((row) => row.feedback_id);
      const decisions = ids.length === 0 ? [] : (await sql<DecisionRow>`select feedback_id, sequence, decision, reason, decided_at
        from interaction.moderation_decisions where portfolio_id = ${scope.portfolioId}::uuid
          and feedback_id = any(${ids}::uuid[]) order by feedback_id, sequence`.execute(db)).rows;
      const byFeedback = new Map<string, FeedbackOwnerExportDecisionSource[]>();
      for (const row of decisions) {
        const sequence = Number(row.sequence);
        if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("FEEDBACK_OWNER_EXPORT_DECISION_SEQUENCE_INVALID");
        const history = byFeedback.get(row.feedback_id) ?? [];
        history.push({ sequence, decision: row.decision, reason: row.reason, decidedAt: instant(row.decided_at) });
        byFeedback.set(row.feedback_id, history);
      }
      const records = feedback.rows.map((row): FeedbackOwnerExportSourceRecord => {
        const aggregateVersion = Number(row.aggregate_version);
        if (!Number.isSafeInteger(aggregateVersion) || aggregateVersion < 1) throw new Error("FEEDBACK_OWNER_EXPORT_VERSION_INVALID");
        return {
          feedbackId: row.feedback_id,
          projectId: row.project_id,
          locale: row.locale,
          aggregateVersion,
          state: row.moderation_state,
          authorName: row.author_name,
          paragraph: row.paragraph,
          submittedAt: instant(row.submitted_at),
          textErasedAt: row.text_erased_at === null ? null : instant(row.text_erased_at),
          decisions: byFeedback.get(row.feedback_id) ?? [],
        };
      });
      return { capturedAt, records };
    },
  };
}
