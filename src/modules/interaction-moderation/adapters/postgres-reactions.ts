import { sql } from "kysely";
import { resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { Reaction } from "../domain/index.js";
import type { ReactionRepositoryPort } from "../application/reactions.js";

export function createPostgresReactionRepository(): ReactionRepositoryPort {
  return {
    async lockCurrent(input, tx) {
      const db = resolvePostgresTransaction(tx);
      await sql`select set_config('shipwithali.portfolio_id', ${input.portfolioId}, true),
        set_config('shipwithali.functional_id', ${input.visitorId}, true)`.execute(db);
      await sql`select pg_advisory_xact_lock(hashtextextended(${input.portfolioId + ":" + input.projectId + ":" + input.visitorId}, 190))`.execute(db);
      const result = await sql<Reaction>`select portfolio_id as "portfolioId", project_id as "projectId", visitor_id as "visitorId",
        kind, updated_at as "updatedAt" from interaction.reactions where portfolio_id = ${input.portfolioId}::uuid
        and project_id = ${input.projectId}::uuid and visitor_id = ${input.visitorId}::uuid for update`.execute(db);
      const row = result.rows[0];
      return row ? { ...row, updatedAt: new Date(row.updatedAt).toISOString() } : null;
    },
    async save(row, tx) {
      await sql`insert into interaction.reactions (portfolio_id, project_id, visitor_id, kind, updated_at)
        values (${row.portfolioId}::uuid, ${row.projectId}::uuid, ${row.visitorId}::uuid, ${row.kind}, ${row.updatedAt}::timestamptz)
        on conflict (portfolio_id, project_id, visitor_id) do update set kind = excluded.kind, updated_at = excluded.updated_at`
        .execute(resolvePostgresTransaction(tx));
    },
  };
}
