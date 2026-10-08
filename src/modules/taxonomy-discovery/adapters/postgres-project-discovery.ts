import { sql } from "kysely";
import type { ProjectDiscoveryProjectionPort } from "../../content-publishing/index.js";
import type { TransactionContext } from "../../../runtime/ports.js";
import { PostgresInfrastructureError, resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";

/** Writes the minimum localized Discovery card facts in Content's transaction. */
export function createPostgresProjectDiscoveryProjectionWriter(): ProjectDiscoveryProjectionPort {
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
  };
}
