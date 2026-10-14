import { sql } from "kysely";
import type { StableId } from "@shared/domain";
import { resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { ProjectInteractionEligibilityPort, ProjectInteractionFacts } from "../application/interaction-facts.js";

/** Content root lock is the same lock acquired by lifecycle and publication.
 * Its separate locale read runs after lock acquisition, under READ COMMITTED,
 * so a waiting request observes the newly committed publication facts. */
export function createPostgresProjectInteractionFacts(scope: { portfolioId: StableId<"Portfolio">; ownerId: StableId<"Owner"> }): ProjectInteractionEligibilityPort {
  return {
    async getProjectInteractionFacts(input, tx) {
      if (input.portfolioId !== scope.portfolioId) return { ok: false, error: { kind: "not_found", code: "PROJECT_UNAVAILABLE" } };
      const db = resolvePostgresTransaction(tx);
      await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
        set_config('shipwithali.owner_id', ${scope.ownerId}, true)`.execute(db);
      const roots = await sql<{ lifecycle: ProjectInteractionFacts["lifecycle"]; content_type: string }>`select lifecycle, content_type
        from content.items where portfolio_id = ${scope.portfolioId}::uuid and content_id = ${input.projectId}::uuid for share`.execute(db);
      const root = roots.rows[0];
      if (!root || root.content_type !== "project") return { ok: false, error: { kind: "not_found", code: "PROJECT_UNAVAILABLE" } };
      const locales = await sql<{ locale: "en" | "ar" }>`select locale from content.language_publications
        where portfolio_id = ${scope.portfolioId}::uuid and content_id = ${input.projectId}::uuid order by locale`.execute(db);
      return { ok: true, value: { ...input, lifecycle: root.lifecycle, publishedLocales: locales.rows.map(r => r.locale) } };
    },
  };
}
