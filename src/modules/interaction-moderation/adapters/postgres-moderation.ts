import { sql } from "kysely";
import type { StableId } from "@shared/domain";
import { resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { ModerationRepositoryPort, RetainedModerationDecision } from "../application/moderation.js";
import type { Feedback, PublicFeedbackView } from "../domain/index.js";

interface FeedbackRow {
  feedback_id: StableId<"Feedback">; portfolio_id: StableId<"Portfolio">; project_id: StableId<"Project">;
  locale: "en" | "ar"; author_name: string; paragraph: string; moderation_state: Feedback["moderationState"];
  aggregate_version: string; submitted_at: Date;
}
export function createPostgresModerationRepository(): ModerationRepositoryPort {
  return {
    async getFeedback(scope, id, lock, tx) {
      const db = resolvePostgresTransaction(tx);
      if (lock) await sql`select pg_advisory_xact_lock(hashtextextended(${id}::text, 205))`.execute(db);
      await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
        set_config('shipwithali.owner_id', ${scope.ownerId}, true), set_config('shipwithali.feedback_access', 'owner', true)`.execute(db);
      const rows = await sql<FeedbackRow>`select feedback_id, portfolio_id, project_id, locale, author_name, paragraph, moderation_state, aggregate_version, submitted_at
        from interaction.feedback where portfolio_id = ${scope.portfolioId}::uuid and feedback_id = ${id}::uuid\n          and text_erased_at is null ${lock ? sql`for update` : sql``}`.execute(db);
      const r = rows.rows[0];
      if (!r) return null;
      const version = Number(r.aggregate_version);
      if (!Number.isSafeInteger(version) || version < 1) throw new Error("INVALID_FEEDBACK_VERSION");
      return { id: r.feedback_id, portfolioId: r.portfolio_id, projectId: r.project_id, locale: r.locale,
        authorName: r.author_name, comment: r.paragraph, moderationState: r.moderation_state, aggregateVersion: version, submittedAt: r.submitted_at.toISOString() };
    },
    async history(id, tx) {
      const rows = await sql<{ decision_id: RetainedModerationDecision["id"]; sequence: string; decision: RetainedModerationDecision["decision"]; reason: string; owner_id: RetainedModerationDecision["ownerId"]; decided_at: Date }>`
        select decision_id, sequence, decision, reason, owner_id, decided_at from interaction.moderation_decisions
        where feedback_id = ${id}::uuid and owner_id is not null order by sequence`.execute(resolvePostgresTransaction(tx));
      return rows.rows.map(r => ({ id: r.decision_id, sequence: Number(r.sequence), decision: r.decision, reason: r.reason, ownerId: r.owner_id, decidedAt: r.decided_at.toISOString() }));
    },
    async decide(feedback, decision, tx) {
      const db = resolvePostgresTransaction(tx);
      await sql`insert into interaction.moderation_decisions (decision_id,portfolio_id,feedback_id,sequence,decision,reason,owner_id,decided_at)
        values (${decision.id}::uuid,${feedback.portfolioId}::uuid,${feedback.id}::uuid,${decision.sequence},${decision.decision},${decision.reason},${decision.ownerId}::uuid,${decision.decidedAt}::timestamptz)`.execute(db);
      const updated = await sql`update interaction.feedback set moderation_state = ${decision.decision}, aggregate_version = aggregate_version + 1,
        approved_at = case when ${decision.decision} = 'approved' then ${decision.decidedAt}::timestamptz else approved_at end
        where portfolio_id = ${feedback.portfolioId}::uuid and feedback_id = ${feedback.id}::uuid
          and moderation_state = ${decision.decision === "suppressed" ? "approved" : "pending"} and aggregate_version = ${feedback.aggregateVersion}`.execute(db);
      if (updated.numAffectedRows !== 1n) throw new Error("MODERATION_UPDATE_FAILED");
    },
    async approved(input, tx) {
      const db = resolvePostgresTransaction(tx);
      await sql`select set_config('shipwithali.portfolio_id', ${input.portfolioId}, true),
        set_config('shipwithali.feedback_access', 'public', true)`.execute(db);
      const rows = await sql<{ feedback_id: PublicFeedbackView["feedbackId"]; project_id: PublicFeedbackView["projectId"]; locale: "en" | "ar"; author_name: string; paragraph: string; displayed_at: string }>`
        select feedback_id,project_id,locale,author_name,paragraph,
          to_char(approved_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as displayed_at from interaction.feedback
        where portfolio_id = ${input.portfolioId}::uuid and project_id = ${input.projectId}::uuid and locale = ${input.locale}
          and moderation_state = 'approved'
          ${input.cursor ? sql`and (approved_at,feedback_id) < (${input.cursor.displayedAt}::timestamptz,${input.cursor.feedbackId}::uuid)` : sql``}
          order by approved_at desc,feedback_id desc limit ${input.limit + 1}`.execute(db);
      const items = rows.rows.slice(0, input.limit).map(r => ({ feedbackId: r.feedback_id, projectId: r.project_id, locale: r.locale,
        authorName: r.author_name, paragraph: r.paragraph, displayedAt: r.displayed_at.replace(/(\.\d{3})000Z$/, "$1Z") }));
      const last = items.at(-1);
      return { items, nextCursor: rows.rows.length > input.limit && last ? { displayedAt: last.displayedAt, feedbackId: last.feedbackId } : null };
    },
  };
}
