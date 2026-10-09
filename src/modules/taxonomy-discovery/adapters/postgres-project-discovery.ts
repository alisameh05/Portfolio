import { sql } from "kysely";
import type { ProjectDiscoveryProjectionPort, ProjectTaxonomyAssignmentFactsPort, ContentAuthoringScope } from "../../content-publishing/index.js";
import type { TransactionContext } from "../../../runtime/ports.js";
import { err, type Rejection, type Result, type StableId } from "../../../shared/domain/index.js";
import { PostgresInfrastructureError, resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";

/** Writes the minimum localized Discovery card facts in Content's transaction. */
export function createPostgresProjectDiscoveryProjectionWriter(): ProjectDiscoveryProjectionPort & ProjectTaxonomyAssignmentFactsPort {
  return {
    async writePublishedProjectLocale(input, transaction: TransactionContext): Promise<void> {
      const executor = resolvePostgresTransaction(transaction);
      await sql`
        select set_config('shipwithali.portfolio_id', ${input.portfolioId}, true),
               set_config('shipwithali.owner_id', ${input.ownerId}, true)
      `.execute(executor);
      await sql`
        insert into taxonomy.project_discovery_locales (
          content_id, portfolio_id, locale, revision_id, route_identity, title, slug,
          first_published_at, published_at, status_value_id, featured
        ) values (
          ${input.contentId}::uuid, ${input.portfolioId}::uuid, ${input.locale}, ${input.revisionId}::uuid,
          ${input.routeIdentity}::uuid, ${input.title}, ${input.slug},
          ${input.firstPublishedAt}::timestamptz, ${input.publishedAt}::timestamptz,
          (select status_value_id from content.items where content_id = ${input.contentId}::uuid and portfolio_id = ${input.portfolioId}::uuid),
          (select featured from content.items where content_id = ${input.contentId}::uuid and portfolio_id = ${input.portfolioId}::uuid)
        )
        on conflict (content_id, locale) do update set
          revision_id = excluded.revision_id,
          route_identity = excluded.route_identity,
          title = excluded.title,
          slug = excluded.slug,
          status_value_id = excluded.status_value_id,
          featured = excluded.featured,
          published_at = excluded.published_at
      `.execute(executor);
      await sql`
        insert into taxonomy.project_discovery_taxonomy_values (
          portfolio_id, content_id, locale, taxonomy_id, value_id, kind, label, first_published_at
        )
        select assignment.portfolio_id, assignment.content_id, ${input.locale}, assignment.taxonomy_id,
               assignment.value_id, root.kind, value.label, ${input.firstPublishedAt}::timestamptz
          from content.project_taxonomy_assignments assignment
          join taxonomy.roots root on root.portfolio_id = assignment.portfolio_id and root.taxonomy_id = assignment.taxonomy_id
          join taxonomy.taxonomy_values value on value.portfolio_id = assignment.portfolio_id
            and value.taxonomy_id = assignment.taxonomy_id and value.value_id = assignment.value_id
         where assignment.portfolio_id = ${input.portfolioId}::uuid and assignment.content_id = ${input.contentId}::uuid
        on conflict (portfolio_id, content_id, locale, value_id) do update set
          taxonomy_id = excluded.taxonomy_id, kind = excluded.kind, label = excluded.label,
          first_published_at = excluded.first_published_at
      `.execute(executor);
    },
    async updateProjectRouteSlug(input, transaction: TransactionContext): Promise<void> {
      const executor = resolvePostgresTransaction(transaction);
      const currentRows = await sql<{ locale: string }>`
        select locale from taxonomy.project_discovery_locales
         where content_id = ${input.contentId}::uuid
           and route_identity = ${input.routeIdentity}::uuid
         for update
      `.execute(executor);
      const expected = new Set(input.expectedLocales);
      if (currentRows.rows.length !== expected.size || currentRows.rows.some((row) => !expected.has(row.locale as "en" | "ar"))) {
        throw new PostgresInfrastructureError();
      }
      if (expected.size === 0) return;
      const updated = await sql<{ locale: string }>`
        update taxonomy.project_discovery_locales
           set slug = ${input.slug}
         where content_id = ${input.contentId}::uuid
           and route_identity = ${input.routeIdentity}::uuid
         returning locale
      `.execute(executor);
      if (updated.rows.length !== expected.size || updated.rows.some((row) => !expected.has(row.locale as "en" | "ar"))) {
        throw new PostgresInfrastructureError();
      }
    },
    async getValueFacts(input: { readonly valueId: StableId<"TaxonomyValue">; readonly scope: ContentAuthoringScope }, transaction: TransactionContext): Promise<Result<{
      readonly taxonomyId: StableId<"Taxonomy">; readonly taxonomyKind: "category" | "ai-ml-domain" | "technology" | "project-type"; readonly label: string; readonly eligible: boolean;
    }, Rejection>> {
      const executor = resolvePostgresTransaction(transaction);
      try {
        await sql`select set_config('shipwithali.portfolio_id', ${input.scope.portfolioId}, true),
                         set_config('shipwithali.owner_id', ${input.scope.ownerId}, true)`.execute(executor);
        const owner = await sql<{ taxonomy_id: string }>`
          select taxonomy_id::text from taxonomy.taxonomy_values
           where portfolio_id = ${input.scope.portfolioId}::uuid and value_id = ${input.valueId}::uuid
        `.execute(executor);
        const taxonomyId = owner.rows[0]?.taxonomy_id;
        if (taxonomyId === undefined) return err({ kind: "validation", code: "TAXONOMY_VALUE_NOT_FOUND" });
        const root = await sql<{ kind: string }>`
          select kind from taxonomy.roots
           where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${taxonomyId}::uuid
           for share
        `.execute(executor);
        const rootRow = root.rows[0];
        if (rootRow === undefined) return err({ kind: "validation", code: "TAXONOMY_VALUE_NOT_FOUND" });
        if (rootRow.kind !== "category" && rootRow.kind !== "ai-ml-domain" && rootRow.kind !== "technology" && rootRow.kind !== "project-type") throw new PostgresInfrastructureError();
        const selected = await sql<{ label: string; state: string }>`
          select label, state from taxonomy.taxonomy_values
           where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${taxonomyId}::uuid and value_id = ${input.valueId}::uuid
           for share
        `.execute(executor);
        const row = selected.rows[0];
        if (row === undefined) return err({ kind: "validation", code: "TAXONOMY_VALUE_NOT_FOUND" });
        return { ok: true, value: { taxonomyId: taxonomyId as StableId<"Taxonomy">, taxonomyKind: rootRow.kind, label: row.label, eligible: row.state === "active" } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },
    async updateProjectDiscoveryTaxonomyValue(input: { readonly projectId: StableId<"Project">; readonly valueId: StableId<"TaxonomyValue">; readonly scope: ContentAuthoringScope }, transaction: TransactionContext): Promise<void> {
      const executor = resolvePostgresTransaction(transaction);
      try {
        await sql`select set_config('shipwithali.portfolio_id', ${input.scope.portfolioId}, true),
                         set_config('shipwithali.owner_id', ${input.scope.ownerId}, true)`.execute(executor);
        await sql`
          insert into taxonomy.project_discovery_taxonomy_values (
            portfolio_id, content_id, locale, taxonomy_id, value_id, kind, label, first_published_at
          )
          select discovery.portfolio_id, discovery.content_id, discovery.locale, assignment.taxonomy_id,
                 assignment.value_id, root.kind, value.label, discovery.first_published_at
            from content.project_taxonomy_assignments assignment
            join taxonomy.roots root on root.portfolio_id = assignment.portfolio_id and root.taxonomy_id = assignment.taxonomy_id
            join taxonomy.taxonomy_values value on value.portfolio_id = assignment.portfolio_id
              and value.taxonomy_id = assignment.taxonomy_id and value.value_id = assignment.value_id
            join taxonomy.project_discovery_locales discovery on discovery.portfolio_id = assignment.portfolio_id
              and discovery.content_id = assignment.content_id
           where assignment.portfolio_id = ${input.scope.portfolioId}::uuid and assignment.content_id = ${input.projectId}::uuid
             and assignment.value_id = ${input.valueId}::uuid
          on conflict (portfolio_id, content_id, locale, value_id) do update set
            taxonomy_id = excluded.taxonomy_id, kind = excluded.kind, label = excluded.label,
            first_published_at = excluded.first_published_at
        `.execute(executor);
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },
    async mergeProjectDiscoveryTaxonomyValue(input, transaction: TransactionContext): Promise<void> {
      const executor = resolvePostgresTransaction(transaction);
      try {
        await sql`select set_config('shipwithali.portfolio_id', ${input.scope.portfolioId}, true),
                         set_config('shipwithali.owner_id', ${input.scope.ownerId}, true)`.execute(executor);
        await sql`
          insert into taxonomy.project_discovery_taxonomy_values as current_facet (
            portfolio_id, content_id, locale, taxonomy_id, value_id, kind, label, first_published_at
          )
          select source.portfolio_id, source.content_id, source.locale, assignment.taxonomy_id,
                 assignment.value_id, root.kind, value.label, source.first_published_at
            from taxonomy.project_discovery_taxonomy_values source
            join content.project_taxonomy_assignments assignment
              on assignment.portfolio_id = source.portfolio_id and assignment.content_id = source.content_id
             and assignment.value_id = ${input.targetValueId}::uuid
            join taxonomy.roots root
              on root.portfolio_id = assignment.portfolio_id and root.taxonomy_id = assignment.taxonomy_id
            join taxonomy.taxonomy_values value
              on value.portfolio_id = assignment.portfolio_id and value.taxonomy_id = assignment.taxonomy_id
             and value.value_id = assignment.value_id
           where source.portfolio_id = ${input.scope.portfolioId}::uuid
             and source.content_id = ${input.projectId}::uuid and source.value_id = ${input.sourceValueId}::uuid
          on conflict (portfolio_id, content_id, locale, value_id) do update set
            taxonomy_id = excluded.taxonomy_id, kind = excluded.kind, label = excluded.label,
            first_published_at = least(current_facet.first_published_at, excluded.first_published_at)
        `.execute(executor);
        await sql`
          delete from taxonomy.project_discovery_taxonomy_values
           where portfolio_id = ${input.scope.portfolioId}::uuid and content_id = ${input.projectId}::uuid
             and value_id = ${input.sourceValueId}::uuid
        `.execute(executor);
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },
  };
}
