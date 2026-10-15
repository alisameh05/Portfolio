import { sql } from "kysely";
import type { StableId } from "@shared/domain";
import { resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { ProjectInteractionEligibilityPort, ProjectInteractionFacts, ContentMeasurementPublicFactsPort } from "../application/interaction-facts.js";
import type { ContentKind } from "../domain/index.js";

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

/** Transaction-bound public facts for consented Measurement intake. */
export function createPostgresContentMeasurementPublicFacts(scope: { portfolioId: StableId<"Portfolio">; ownerId: StableId<"Owner"> }): Pick<ContentMeasurementPublicFactsPort, "getRouteFacts" | "hasRetainedPublicRoute"> {
  return {
    async getRouteFacts(input, tx) {
      if (input.portfolioId !== scope.portfolioId) return { ok: false, error: { kind: "not_found", code: "PUBLIC_ROUTE_UNAVAILABLE" } };
      const db = resolvePostgresTransaction(tx);
      await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
        set_config('shipwithali.owner_id', ${scope.ownerId}, true)`.execute(db);
      const result = await sql<{ route_identity: string; content_id: string; content_type: string; published: boolean }>`
        select r.route_identity::text, r.content_id::text, r.content_type,
          (i.lifecycle = 'published' and exists (
            select 1 from content.language_publications p
             where p.portfolio_id = r.portfolio_id and p.content_id = r.content_id
               and p.route_identity = r.route_identity and p.locale = ${input.locale}
          )) as published
          from content.public_routes r
          join content.items i on i.content_id = r.content_id and i.portfolio_id = r.portfolio_id
         where r.portfolio_id = ${scope.portfolioId}::uuid and r.route_identity = ${input.routeId}::uuid
         for share of i
      `.execute(db);
      const row = result.rows[0];
      if (!row || !["project", "achievement", "testimonial"].includes(row.content_type)) {
        return { ok: false, error: { kind: "not_found", code: "PUBLIC_ROUTE_UNAVAILABLE" } };
      }
      return { ok: true, value: { routeId: row.route_identity as StableId<"PublicRoute">,
        projectId: row.content_type === "project" ? row.content_id as StableId<"Project"> : null,
        contentType: row.content_type as ContentKind, published: row.published } };
    },
    async hasRetainedPublicRoute(input, tx) {
      if (input.portfolioId !== scope.portfolioId) return { ok: true, value: false };
      const db = resolvePostgresTransaction(tx);
      await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
        set_config('shipwithali.owner_id', ${scope.ownerId}, true)`.execute(db);
      const result = await sql<{ retained: boolean }>`select exists (
        select 1 from content.public_routes where portfolio_id = ${scope.portfolioId}::uuid
          and route_identity = ${input.routeId}::uuid
      ) as retained`.execute(db);
      return { ok: true, value: result.rows[0]?.retained === true };
    },
  };
}
