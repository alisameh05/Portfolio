import { sql } from "kysely";
import { err, ok, parseStableId } from "../../../shared/domain/index.js";
import type { ContentTaxonomyExportAssignmentReader } from "../application/taxonomy-export.js";
import { PostgresInfrastructureError, resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";

const MAX_TAXONOMY_EXPORT_ROWS = 100_000;

function utc(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new PostgresInfrastructureError();
  return parsed.toISOString();
}

/** Reads Content-owned current assignments and their immutable history under the export purpose. */
export function createPostgresContentTaxonomyExportAssignmentReader(): ContentTaxonomyExportAssignmentReader {
  return {
    async readOwnerExportAssignments(scope, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
                         set_config('shipwithali.owner_id', ${scope.ownerId}, true),
                         set_config('shipwithali.worker_purpose', 'content.owner-export', true)`.execute(executor);
        const current = await sql<{
          taxonomy_id: string;
          content_id: string;
          value_id: string;
          assigned_at: Date | string;
        }>`
          select taxonomy_id::text, content_id::text, value_id::text, assigned_at
            from content.project_taxonomy_assignments
           where portfolio_id = ${scope.portfolioId}::uuid
           order by taxonomy_id, content_id, value_id
           limit ${MAX_TAXONOMY_EXPORT_ROWS + 1}
        `.execute(executor);
        const history = await sql<{
          taxonomy_id: string;
          content_id: string;
          sequence: number;
          value_id: string;
          aggregate_version: number;
          changed_at: Date | string;
        }>`
          select taxonomy_id::text, content_id::text, sequence, value_id::text,
                 aggregate_version, changed_at
            from content.project_taxonomy_assignment_history
           where portfolio_id = ${scope.portfolioId}::uuid
           order by taxonomy_id, content_id, sequence
           limit ${MAX_TAXONOMY_EXPORT_ROWS + 1}
        `.execute(executor);
        if (current.rows.length > MAX_TAXONOMY_EXPORT_ROWS || history.rows.length > MAX_TAXONOMY_EXPORT_ROWS) {
          return err({ kind: "temporarily_unavailable", code: "TAXONOMY_EXPORT_LIMIT_EXCEEDED" });
        }
        const assignments = current.rows.map((row) => {
          const taxonomyId = parseStableId("Taxonomy", row.taxonomy_id);
          const projectId = parseStableId("Project", row.content_id);
          const valueId = parseStableId("TaxonomyValue", row.value_id);
          if (!taxonomyId.ok || !projectId.ok || !valueId.ok) throw new PostgresInfrastructureError();
          return { taxonomyId: taxonomyId.value, projectId: projectId.value, valueId: valueId.value, assignedAt: utc(row.assigned_at) };
        });
        const assignmentHistory = history.rows.map((row) => {
          const taxonomyId = parseStableId("Taxonomy", row.taxonomy_id);
          const projectId = parseStableId("Project", row.content_id);
          const valueId = parseStableId("TaxonomyValue", row.value_id);
          if (!taxonomyId.ok || !projectId.ok || !valueId.ok || !Number.isSafeInteger(row.sequence) || row.sequence < 1 ||
              !Number.isSafeInteger(row.aggregate_version) || row.aggregate_version < 1) {
            throw new PostgresInfrastructureError();
          }
          return {
            taxonomyId: taxonomyId.value,
            projectId: projectId.value,
            sequence: row.sequence,
            valueId: valueId.value,
            projectVersion: row.aggregate_version,
            changedAt: utc(row.changed_at),
          };
        });
        return ok({ assignments, history: assignmentHistory });
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },
  };
}
