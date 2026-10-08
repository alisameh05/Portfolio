import { sql } from "kysely";
import { err, type StableId } from "../../../shared/domain/index.js";
import type { TaxonomyOwnerRepository, TaxonomyOwnerScope, TaxonomyKind } from "../application/owner-taxonomies.js";
import type { TransactionContext } from "../../../runtime/ports.js";
import { PostgresInfrastructureError, resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";

function validKind(kind: string): kind is TaxonomyKind {
  return kind === "category" || kind === "ai-ml-domain" || kind === "technology" || kind === "project-type";
}
function setScope(context: TransactionContext, scope: TaxonomyOwnerScope) {
  const executor = resolvePostgresTransaction(context);
  return sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
                     set_config('shipwithali.owner_id', ${scope.ownerId}, true)`.execute(executor);
}

export function createPostgresTaxonomyOwnerRepository(): TaxonomyOwnerRepository {
  return {
    async getOwnerTaxonomy(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setScope(context, input.scope);
        const root = await sql<{ taxonomy_id: string; kind: string; aggregate_version: number }>`
          select taxonomy_id::text, kind, aggregate_version from taxonomy.roots
           where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${input.taxonomyId}::uuid
        `.execute(executor);
        const row = root.rows[0];
        if (row === undefined) return err({ kind: "not_found", code: "TAXONOMY_NOT_FOUND" });
        if (!validKind(row.kind) || !Number.isSafeInteger(row.aggregate_version) || row.aggregate_version < 1) throw new PostgresInfrastructureError();
        const values = await sql<{ value_id: string; label: string; state: string; merged_into_value_id: string | null }>`
          select value_id::text, label, state, merged_into_value_id::text
            from taxonomy.taxonomy_values
           where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${input.taxonomyId}::uuid
           order by normalized_label, value_id
        `.execute(executor);
        return { ok: true, value: {
          taxonomyId: row.taxonomy_id as StableId<"Taxonomy">,
          aggregateVersion: row.aggregate_version,
          kind: row.kind,
          values: values.rows.map((value) => {
            if (value.state !== "active" && value.state !== "retired" && value.state !== "merged") throw new PostgresInfrastructureError();
            if ((value.state === "merged") !== (value.merged_into_value_id !== null)) throw new PostgresInfrastructureError();
            return {
              valueId: value.value_id as StableId<"TaxonomyValue">,
              name: value.label,
              state: value.state,
              ...(value.merged_into_value_id === null ? {} : { mergedIntoValueId: value.merged_into_value_id as StableId<"TaxonomyValue"> }),
            };
          }),
        } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },
    async createValue(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setScope(context, input.scope);
        const selected = await sql<{ kind: string; aggregate_version: number }>`
          select kind, aggregate_version from taxonomy.roots
           where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${input.taxonomyId}::uuid
           for update
        `.execute(executor);
        const root = selected.rows[0];
        if (root === undefined) return err({ kind: "not_found", code: "TAXONOMY_NOT_FOUND" });
        if (!validKind(root.kind) || !Number.isSafeInteger(root.aggregate_version)) throw new PostgresInfrastructureError();
        if (root.aggregate_version !== input.expectedVersion) return err({ kind: "precondition_failed", code: "TAXONOMY_VERSION_MISMATCH", currentVersion: root.aggregate_version });
        const inserted = await sql<{ value_id: string }>`
          insert into taxonomy.taxonomy_values (portfolio_id, taxonomy_id, value_id, label)
          values (${input.scope.portfolioId}::uuid, ${input.taxonomyId}::uuid, ${input.valueId}::uuid, ${input.name})
          on conflict (portfolio_id, taxonomy_id, normalized_label) do nothing
          returning value_id::text
        `.execute(executor);
        if (inserted.rows[0] === undefined) return err({ kind: "conflict", code: "TAXONOMY_VALUE_NAME_ALREADY_EXISTS" });
        const updated = await sql<{ aggregate_version: number; changed_at: Date | string }>`
          update taxonomy.roots set aggregate_version = aggregate_version + 1, updated_at = transaction_timestamp()
           where portfolio_id = ${input.scope.portfolioId}::uuid and taxonomy_id = ${input.taxonomyId}::uuid
           returning aggregate_version, updated_at as changed_at
        `.execute(executor);
        const next = updated.rows[0];
        if (next === undefined) throw new PostgresInfrastructureError();
        const createdAt = next.changed_at instanceof Date ? next.changed_at.toISOString() : new Date(next.changed_at).toISOString();
        if (!Number.isFinite(Date.parse(createdAt))) throw new PostgresInfrastructureError();
        await sql`
          insert into taxonomy.value_history (
            portfolio_id, taxonomy_id, value_id, transition_sequence, action, previous_label, label, state, aggregate_version, changed_at
          ) values (${input.scope.portfolioId}::uuid, ${input.taxonomyId}::uuid, ${input.valueId}::uuid, 1,
                    'created', null, ${input.name}, 'active', 1, ${createdAt}::timestamptz)
        `.execute(executor);
        return { ok: true, value: { aggregateVersion: next.aggregate_version } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },
  };
}
