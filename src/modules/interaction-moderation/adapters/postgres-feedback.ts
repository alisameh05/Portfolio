import { sql } from "kysely";
import { resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { FeedbackSubmissionRepositoryPort } from "../application/feedback.js";

export function createPostgresFeedbackSubmissionRepository(): FeedbackSubmissionRepositoryPort {
  return {
    async insert(row, tx) {
      const db = resolvePostgresTransaction(tx);
      await sql`select set_config('shipwithali.portfolio_id', ${row.portfolioId}, true)`.execute(db);
      await sql`insert into interaction.feedback (feedback_id, portfolio_id, project_id, locale, author_name, paragraph, moderation_state, aggregate_version, submitted_at)
        values (${row.id}::uuid, ${row.portfolioId}::uuid, ${row.projectId}::uuid, ${row.locale}, ${row.authorName}, ${row.comment},
          ${row.moderationState}, ${row.aggregateVersion}, ${row.submittedAt}::timestamptz)`.execute(db);
    },
  };
}
