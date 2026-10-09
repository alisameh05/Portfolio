import { sql } from "kysely";
import type { ContentTaxonomyAssignmentsPort, ContentAuthoringScope, ProjectTaxonomyAssignmentFactsPort } from "../application/index.js";
import type { TransactionContext } from "../../../runtime/ports.js";
import type { StableId } from "../../../shared/domain/index.js";
import { PostgresInfrastructureError, resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";

/** Content-owned assignment migration used by Taxonomy's synchronous merge coordinator. */
export function createPostgresContentTaxonomyAssignmentsPort(input: {
  readonly scope: ContentAuthoringScope;
  readonly discovery: ProjectTaxonomyAssignmentFactsPort;
}): ContentTaxonomyAssignmentsPort {
  return {
    async listAssignmentHistory(taxonomyId, limit, transaction) {
      const executor = resolvePostgresTransaction(transaction);
      try {
        await setScope(executor, input.scope);
        const rows = await sql<{ content_id: string; value_id: string; aggregate_version: number; changed_at: Date | string }>`
          select history.content_id::text, history.value_id::text, history.aggregate_version, history.changed_at
            from content.project_taxonomy_assignment_history as history
           where history.portfolio_id = ${input.scope.portfolioId}::uuid
             and history.taxonomy_id = ${taxonomyId}::uuid
           order by history.changed_at desc, history.content_id, history.sequence desc
           limit ${limit}
        `.execute(executor);
        return rows.rows.map((row) => ({
          projectId: row.content_id as StableId<"Project">,
          valueId: row.value_id as StableId<"TaxonomyValue">,
          aggregateVersion: row.aggregate_version,
          changedAt: row.changed_at instanceof Date ? row.changed_at.toISOString() : new Date(row.changed_at).toISOString(),
        }));
      } catch {
        throw new PostgresInfrastructureError();
      }
    },
    async listProjectsWithValue(valueId, limit, transaction) {
      const executor = resolvePostgresTransaction(transaction);
      try {
        await setScope(executor, input.scope);
        const rows = await sql<{ content_id: string }>`
          select content_id::text
            from content.project_taxonomy_assignments
           where portfolio_id = ${input.scope.portfolioId}::uuid and value_id = ${valueId}::uuid
           order by content_id
           limit ${limit}
        `.execute(executor);
        return { ok: true, value: rows.rows.map((row) => row.content_id as StableId<"Project">) };
      } catch {
        throw new PostgresInfrastructureError();
      }
    },
    async migrateProjectValues(command, transaction) {
      const executor = resolvePostgresTransaction(transaction);
      try {
        await setScope(executor, input.scope);
        // The caller already holds the Taxonomy root and both value locks. Project
        // roots are then locked in ascending ID order by the coordinator.
        const selected = await sql<{ content_type: string; aggregate_version: number }>`
          select content_type, aggregate_version from content.items
           where content_id = ${command.projectId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
           for update
        `.execute(executor);
        const project = selected.rows[0];
        if (project === undefined || project.content_type !== "project") {
          return { ok: false, error: { kind: "not_found", code: "PROJECT_NOT_FOUND" } };
        }
        if (!Number.isSafeInteger(project.aggregate_version) || project.aggregate_version < 1) throw new PostgresInfrastructureError();
        const source = await sql<{ taxonomy_id: string }>`
          select taxonomy_id::text from content.project_taxonomy_assignments
           where portfolio_id = ${input.scope.portfolioId}::uuid and content_id = ${command.projectId}::uuid
             and value_id = ${command.sourceValueId}::uuid
        `.execute(executor);
        const taxonomyId = source.rows[0]?.taxonomy_id;
        if (taxonomyId === undefined) return { ok: true, value: { aggregateVersion: project.aggregate_version, changed: false } };
        const targetExists = await sql<{ value_id: string }>`
          select value_id::text from content.project_taxonomy_assignments
           where portfolio_id = ${input.scope.portfolioId}::uuid and content_id = ${command.projectId}::uuid
             and value_id = ${command.targetValueId}::uuid
        `.execute(executor);
        await sql`
          delete from content.project_taxonomy_assignments
           where portfolio_id = ${input.scope.portfolioId}::uuid and content_id = ${command.projectId}::uuid
             and value_id = ${command.sourceValueId}::uuid
        `.execute(executor);
        if (targetExists.rows.length === 0) {
          await sql`
            insert into content.project_taxonomy_assignments (portfolio_id, content_id, taxonomy_id, value_id)
            values (${input.scope.portfolioId}::uuid, ${command.projectId}::uuid, ${taxonomyId}::uuid, ${command.targetValueId}::uuid)
          `.execute(executor);
        }
        const updated = await sql<{ aggregate_version: number; changed_at: Date | string }>`
          update content.items set aggregate_version = aggregate_version + 1, updated_at = transaction_timestamp()
           where content_id = ${command.projectId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
           returning aggregate_version, updated_at as changed_at
        `.execute(executor);
        const next = updated.rows[0];
        if (next === undefined || !Number.isSafeInteger(next.aggregate_version)) throw new PostgresInfrastructureError();
        const history = await sql<{ sequence: number }>`
          select coalesce(max(sequence), 0)::integer + 1 as sequence
            from content.project_taxonomy_assignment_history
           where portfolio_id = ${input.scope.portfolioId}::uuid and content_id = ${command.projectId}::uuid
        `.execute(executor);
        const sequence = history.rows[0]?.sequence;
        if (!Number.isSafeInteger(sequence) || sequence === undefined) throw new PostgresInfrastructureError();
        await sql`
          insert into content.project_taxonomy_assignment_history (
            portfolio_id, content_id, sequence, taxonomy_id, value_id, aggregate_version, actor_id, changed_at
          ) values (
            ${input.scope.portfolioId}::uuid, ${command.projectId}::uuid, ${sequence}, ${taxonomyId}::uuid,
            ${command.targetValueId}::uuid, ${next.aggregate_version}, ${command.actorId}::uuid,
            ${next.changed_at}::timestamptz
          )
        `.execute(executor);
        await input.discovery.mergeProjectDiscoveryTaxonomyValue({
          projectId: command.projectId,
          sourceValueId: command.sourceValueId,
          targetValueId: command.targetValueId,
          scope: input.scope,
        }, transaction);
        return { ok: true, value: { aggregateVersion: next.aggregate_version, changed: true } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },
  };
}

async function setScope(executor: ReturnType<typeof resolvePostgresTransaction>, scope: ContentAuthoringScope): Promise<void> {
  await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
                   set_config('shipwithali.owner_id', ${scope.ownerId}, true)`.execute(executor);
}
