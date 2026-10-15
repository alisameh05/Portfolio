import { sql } from "kysely";
import { resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { InteractionSummaryRepositoryPort } from "../application/public-summary.js";

/** Safe aggregate views do not grant the runtime access to other voters' rows. */
export function createPostgresInteractionSummaryRepository(): InteractionSummaryRepositoryPort {
  return {
    async read(input, tx) {
      const db = resolvePostgresTransaction(tx);
      await sql`select set_config('shipwithali.portfolio_id', ${input.portfolioId}, true),
        set_config('shipwithali.summary_project_id', ${input.projectId}, true),
        set_config('shipwithali.summary_locale', ${input.locale}, true),
        set_config('shipwithali.feedback_access', 'public', true)`.execute(db);
      const result = await sql<{ likes: string; dislikes: string; raters: string; average: string | null; approved: string; as_of: Date }>`
        select r.likes, r.dislikes, v.raters, v.average,
          (select count(*) from interaction.feedback where portfolio_id = ${input.portfolioId}::uuid
            and project_id = ${input.projectId}::uuid and locale = ${input.locale} and moderation_state = 'approved') as approved,
          statement_timestamp() as as_of
        from interaction.current_reaction_counts r cross join interaction.current_rating_summary v`.execute(db);
      const row = result.rows[0];
      if (!row) throw new Error("SUMMARY_MISSING");
      if ([row.likes, row.dislikes, row.raters, row.approved].map(Number).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error("SUMMARY_COUNT_INVALID");
      return { likesCount: Number(row.likes), dislikesCount: Number(row.dislikes), ratingCount: Number(row.raters),
        approvedFeedbackCount: Number(row.approved), asOf: row.as_of.toISOString(),
        ...(row.average === null ? {} : { averageRating: Number(row.average) }) };
    },
  };
}
