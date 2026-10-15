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
export function createPostgresContentMeasurementPublicFacts(scope: { portfolioId: StableId<"Portfolio">; ownerId: StableId<"Owner"> }): ContentMeasurementPublicFactsPort {
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
    async getRelatedProjectFact(input, tx) {
      if (input.portfolioId !== scope.portfolioId || input.sourceProjectId === input.targetProjectId) {
        return { ok: true, value: false };
      }
      const db = resolvePostgresTransaction(tx);
      await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
        set_config('shipwithali.owner_id', ${scope.ownerId}, true)`.execute(db);
      const result = await sql<{ source_id: string }>`
        select source.content_id::text as source_id
          from content.items source
          join content.items target on target.portfolio_id = source.portfolio_id
          join content.project_relationship_views relation
            on relation.portfolio_id = source.portfolio_id
           and relation.project_id = source.content_id and relation.related_project_id = target.content_id
          join content.language_publications source_locale
            on source_locale.portfolio_id = source.portfolio_id and source_locale.content_id = source.content_id
           and source_locale.locale = ${input.locale}
          join content.language_publications target_locale
            on target_locale.portfolio_id = target.portfolio_id and target_locale.content_id = target.content_id
           and target_locale.locale = ${input.locale}
         where source.portfolio_id = ${scope.portfolioId}::uuid
           and source.content_id = ${input.sourceProjectId}::uuid and source.content_type = 'project' and source.lifecycle = 'published'
           and target.content_id = ${input.targetProjectId}::uuid and target.content_type = 'project' and target.lifecycle = 'published'
         for share of source, target
      `.execute(db);
      return { ok: true, value: result.rows.length === 1 };
    },
    async getTestimonialFact(input, tx) {
      if (input.portfolioId !== scope.portfolioId) return { ok: true, value: false };
      const db = resolvePostgresTransaction(tx);
      await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
        set_config('shipwithali.owner_id', ${scope.ownerId}, true)`.execute(db);
      const result = input.projectId === undefined
        ? await sql<{ testimonial_id: string }>`
            select item.content_id::text as testimonial_id
              from content.items item
              join content.testimonial_language_publications publication
                on publication.portfolio_id = item.portfolio_id and publication.content_id = item.content_id
               and publication.locale = ${input.locale}
              join content.public_testimonial_locales projection
                on projection.portfolio_id = publication.portfolio_id and projection.content_id = publication.content_id
               and projection.locale = publication.locale and projection.revision_id = publication.revision_id
             where item.portfolio_id = ${scope.portfolioId}::uuid and item.content_id = ${input.testimonialId}::uuid
               and item.content_type = 'testimonial' and item.lifecycle = 'published'
               and projection.association_type = 'profile' and projection.project_id is null
             for share of item
          `.execute(db)
        : await sql<{ testimonial_id: string }>`
            select item.content_id::text as testimonial_id
              from content.items item
              join content.testimonial_language_publications publication
                on publication.portfolio_id = item.portfolio_id and publication.content_id = item.content_id
               and publication.locale = ${input.locale}
              join content.public_testimonial_locales projection
                on projection.portfolio_id = publication.portfolio_id and projection.content_id = publication.content_id
               and projection.locale = publication.locale and projection.revision_id = publication.revision_id
              join content.items project on project.portfolio_id = item.portfolio_id
               and project.content_id = projection.project_id and project.content_type = 'project' and project.lifecycle = 'published'
              join content.language_publications project_locale on project_locale.portfolio_id = project.portfolio_id
               and project_locale.content_id = project.content_id and project_locale.locale = publication.locale
             where item.portfolio_id = ${scope.portfolioId}::uuid and item.content_id = ${input.testimonialId}::uuid
               and item.content_type = 'testimonial' and item.lifecycle = 'published'
               and projection.association_type = 'project' and projection.project_id = ${input.projectId}::uuid
             for share of item, project
          `.execute(db);
      return { ok: true, value: result.rows.length === 1 };
    },
    async getExternalProjectLinkFact(input, tx) {
      if (input.portfolioId !== scope.portfolioId) return { ok: true, value: false };
      const db = resolvePostgresTransaction(tx);
      await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
        set_config('shipwithali.owner_id', ${scope.ownerId}, true)`.execute(db);
      const result = await sql<{ configured: boolean }>`
        select exists (
          select 1
            from content.items item
            join content.public_project_locales projection
              on projection.portfolio_id = item.portfolio_id and projection.content_id = item.content_id
             and projection.locale = ${input.locale}
            join content.language_publications publication
              on publication.portfolio_id = projection.portfolio_id and publication.content_id = projection.content_id
             and publication.locale = projection.locale and publication.revision_id = projection.revision_id
            cross join lateral jsonb_array_elements(projection.external_links) link
           where item.portfolio_id = ${scope.portfolioId}::uuid
             and item.content_id = ${input.projectId}::uuid and item.content_type = 'project' and item.lifecycle = 'published'
             and (${input.destination} = 'github-repository'
               and (link->>'destination') ~* '^https://(www\.)?github\.com/[^/?#]+/[^/?#]+/?([?#].*)?$'
               or ${input.destination} = 'live-demo'
               and (link->>'destination') !~* '^https://(www\.)?github\.com/')
        ) as configured
      `.execute(db);
      return { ok: true, value: result.rows[0]?.configured === true };
    },
  };
}
