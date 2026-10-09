import { sql } from "kysely";
import type { PublicDiscoveryReader, PublicDiscoveryReadQuery } from "../application/public-discovery.js";
import type { ProjectDiscoveryCard, ProjectDiscoveryFacet } from "../domain/index.js";
import type { TransactionContext } from "../../../runtime/ports.js";
import type { Rejection, Result, StableId } from "../../../shared/domain/index.js";
import { err } from "../../../shared/domain/index.js";
import { PostgresInfrastructureError, resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";

export interface PublicDiscoveryScope {
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
}

interface ProjectRow {
  readonly project_id: string;
  readonly locale: "en" | "ar";
  readonly title: string;
  readonly summary: string;
  readonly slug: string;
  readonly first_published_at: Date | string;
  readonly featured: boolean;
  readonly taxonomy_values: unknown;
}

interface FacetRow {
  readonly taxonomy_id: string;
  readonly value_id: string;
  readonly kind: ProjectDiscoveryFacet["kind"];
  readonly label: string;
  readonly project_count: number;
}

function parseDate(value: Date | string): string {
  const parsed = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  if (!Number.isFinite(Date.parse(parsed))) throw new PostgresInfrastructureError();
  return parsed;
}

function parseTaxonomyValues(value: unknown): ProjectDiscoveryCard["taxonomyValues"] {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) throw new PostgresInfrastructureError();
  return parsed.map((row) => {
    if (typeof row !== "object" || row === null) throw new PostgresInfrastructureError();
    const item = row as Record<string, unknown>;
    if (typeof item["id"] !== "string" || typeof item["taxonomyId"] !== "string" || typeof item["label"] !== "string") throw new PostgresInfrastructureError();
    return { id: item["id"] as StableId<"TaxonomyValue">, taxonomyId: item["taxonomyId"] as StableId<"Taxonomy">,
      label: item["label"] };
  });
}

export function createPostgresPublicDiscoveryReader(scope: PublicDiscoveryScope): PublicDiscoveryReader {
  return {
    async read(query: PublicDiscoveryReadQuery, context: TransactionContext): Promise<Result<{
      readonly entries: readonly ProjectDiscoveryCard[];
      readonly facets: readonly ProjectDiscoveryFacet[];
    }, Rejection>> {
      const executor = resolvePostgresTransaction(context);
      try {
        await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
                         set_config('shipwithali.owner_id', ${scope.ownerId}, true)`.execute(executor);

        if (query.taxonomyValueId !== undefined) {
          const selected = await sql<{ value_id: string }>`
            select value.value_id::text
              from taxonomy.taxonomy_values value
              join taxonomy.roots root on root.portfolio_id = value.portfolio_id and root.taxonomy_id = value.taxonomy_id
             where value.portfolio_id = ${scope.portfolioId}::uuid
               and value.value_id = ${query.taxonomyValueId}::uuid
               and value.state in ('active', 'retired')
               and root.kind in ('category', 'ai-ml-domain', 'technology', 'project-type')
          `.execute(executor);
          // Unknown and foreign IDs deliberately have the same response.
          if (selected.rows[0] === undefined) return err({ kind: "validation", code: "INVALID_DISCOVERY_FILTER" });
        }

        const afterAt = query.after?.firstPublishedAt ?? null;
        const afterId = query.after?.projectId ?? null;
        const projectRows = await sql<ProjectRow>`
          select discovery.content_id::text as project_id, discovery.locale, discovery.title,
                 public_project.summary, discovery.slug, discovery.first_published_at, discovery.featured,
                 coalesce((
                   select jsonb_agg(jsonb_build_object(
                     'id', facet.value_id::text, 'taxonomyId', facet.taxonomy_id::text,
                     'label', facet.label
                   ) order by facet.kind, facet.value_id)
                     from taxonomy.project_discovery_taxonomy_values facet
                    where facet.portfolio_id = discovery.portfolio_id and facet.content_id = discovery.content_id
                      and facet.locale = discovery.locale
                 ), '[]'::jsonb) as taxonomy_values
            from taxonomy.project_discovery_locales discovery
            join content.items item on item.content_id = discovery.content_id
              and item.portfolio_id = discovery.portfolio_id and item.content_type = 'project' and item.lifecycle = 'published'
            join content.language_publications publication on publication.content_id = discovery.content_id
              and publication.portfolio_id = discovery.portfolio_id and publication.locale = discovery.locale
              and publication.revision_id = discovery.revision_id and publication.route_identity = discovery.route_identity
            join content.public_project_locales public_project on public_project.content_id = publication.content_id
              and public_project.portfolio_id = publication.portfolio_id and public_project.locale = publication.locale
              and public_project.revision_id = publication.revision_id and public_project.route_identity = publication.route_identity
           where discovery.portfolio_id = ${scope.portfolioId}::uuid and discovery.locale = ${query.locale}
             and (${query.taxonomyValueId ?? null}::uuid is null or exists (
               select 1 from taxonomy.project_discovery_taxonomy_values selected_facet
                where selected_facet.portfolio_id = discovery.portfolio_id
                  and selected_facet.content_id = discovery.content_id and selected_facet.locale = discovery.locale
                  and selected_facet.value_id = ${query.taxonomyValueId ?? null}::uuid
             ))
             and (${afterAt}::timestamptz is null or
               (discovery.first_published_at, discovery.content_id) < (${afterAt}::timestamptz, ${afterId}::uuid))
           order by discovery.first_published_at desc, discovery.content_id desc
           limit ${query.limit}
        `.execute(executor);

        const facetRows = await sql<FacetRow>`
          select facet.taxonomy_id::text as taxonomy_id, facet.value_id::text as value_id,
                 facet.kind, facet.label, count(distinct discovery.content_id)::int as project_count
            from taxonomy.project_discovery_taxonomy_values facet
            join taxonomy.project_discovery_locales discovery on discovery.portfolio_id = facet.portfolio_id
              and discovery.content_id = facet.content_id and discovery.locale = facet.locale
            join content.items item on item.content_id = discovery.content_id
              and item.portfolio_id = discovery.portfolio_id and item.content_type = 'project' and item.lifecycle = 'published'
            join content.language_publications publication on publication.content_id = discovery.content_id
              and publication.portfolio_id = discovery.portfolio_id and publication.locale = discovery.locale
              and publication.revision_id = discovery.revision_id and publication.route_identity = discovery.route_identity
            join content.public_project_locales public_project on public_project.content_id = publication.content_id
              and public_project.portfolio_id = publication.portfolio_id and public_project.locale = publication.locale
              and public_project.revision_id = publication.revision_id and public_project.route_identity = publication.route_identity
           where facet.portfolio_id = ${scope.portfolioId}::uuid and facet.locale = ${query.locale}
           group by facet.taxonomy_id, facet.value_id, facet.kind, facet.label
           order by facet.kind, facet.label, facet.value_id
        `.execute(executor);

        const entries: ProjectDiscoveryCard[] = projectRows.rows.map((row) => ({
          projectId: row.project_id as StableId<"Project">,
          locale: row.locale,
          title: row.title,
          summary: row.summary,
          slug: row.slug,
          firstPublishedAt: parseDate(row.first_published_at),
          taxonomyValues: parseTaxonomyValues(row.taxonomy_values),
          isFeatured: row.featured,
        }));
        const facets: ProjectDiscoveryFacet[] = facetRows.rows.map((row) => ({
          taxonomyId: row.taxonomy_id as StableId<"Taxonomy">,
          valueId: row.value_id as StableId<"TaxonomyValue">,
          kind: row.kind,
          label: row.label,
          projectCount: row.project_count,
        }));
        return { ok: true, value: { entries, facets } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },
  };
}
