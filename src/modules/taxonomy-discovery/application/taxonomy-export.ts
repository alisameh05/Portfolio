import { err, ok, type Rejection, type Result, type StableId } from "../../../shared/domain/index.js";
import type { TransactionContext } from "../../../runtime/ports.js";
import type { ContentTaxonomyExportAssignmentReader } from "../../content-publishing/index.js";

export type TaxonomyOwnerExportKind = "category" | "ai-ml-domain" | "technology" | "project-type";
export type TaxonomyOwnerExportState = "active" | "retired" | "merged";

export interface TaxonomyOwnerExportScope {
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
}

export interface TaxonomyOwnerExportTaxonomyFacts {
  readonly taxonomyId: StableId<"Taxonomy">;
  readonly aggregateVersion: number;
  readonly kind: TaxonomyOwnerExportKind;
  readonly values: readonly {
    readonly valueId: StableId<"TaxonomyValue">;
    readonly name: string;
    readonly state: TaxonomyOwnerExportState;
    readonly valueVersion: number;
    readonly mergedIntoValueId?: StableId<"TaxonomyValue">;
  }[];
  readonly evolutionHistory: readonly {
    readonly valueId: StableId<"TaxonomyValue">;
    readonly transitionSequence: number;
    readonly action: "created" | "renamed" | "retired" | "merged";
    readonly previousName: string | null;
    readonly name: string;
    readonly state: TaxonomyOwnerExportState;
    readonly changedAt: string;
    readonly mergedIntoValueId?: StableId<"TaxonomyValue">;
  }[];
}

export interface TaxonomyOwnerExportRepository {
  readOwnerTaxonomiesForExport(
    scope: TaxonomyOwnerExportScope,
    context: TransactionContext,
  ): Promise<Result<{ readonly capturedAt: string; readonly taxonomies: readonly TaxonomyOwnerExportTaxonomyFacts[] }, Rejection>>;
}

export interface TaxonomyOwnerExportRecord extends TaxonomyOwnerExportTaxonomyFacts {
  readonly assignments: readonly {
    readonly targetId: StableId<"Project">;
    readonly taxonomyValueId: StableId<"TaxonomyValue">;
    readonly assignedAt: string;
  }[];
  readonly assignmentHistory: readonly {
    readonly targetId: StableId<"Project">;
    readonly taxonomyValueId: StableId<"TaxonomyValue">;
    readonly sequence: number;
    readonly projectVersion: number;
    readonly changedAt: string;
  }[];
}

export interface TaxonomyOwnerExportSnapshot {
  readonly capturedAt: string;
  readonly taxonomies: readonly TaxonomyOwnerExportRecord[];
}

export interface TaxonomyOwnerExportSnapshotReader {
  readOwnerExportSnapshot(
    scope: TaxonomyOwnerExportScope,
    context: TransactionContext,
  ): Promise<Result<TaxonomyOwnerExportSnapshot, Rejection>>;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Taxonomy-owned snapshot reader; assignment bytes come through Content's read-only port. */
export function createTaxonomyOwnerExportSnapshotReader(input: {
  readonly repository: TaxonomyOwnerExportRepository;
  readonly assignments: ContentTaxonomyExportAssignmentReader;
}): TaxonomyOwnerExportSnapshotReader {
  return {
    async readOwnerExportSnapshot(scope, context) {
      const taxonomyResult = await input.repository.readOwnerTaxonomiesForExport(scope, context);
      if (!taxonomyResult.ok) return taxonomyResult;
      const assignmentResult = await input.assignments.readOwnerExportAssignments(scope, context);
      if (!assignmentResult.ok) return assignmentResult;

      const records = new Map<string, {
        facts: TaxonomyOwnerExportTaxonomyFacts;
        assignments: TaxonomyOwnerExportRecord["assignments"][number][];
        assignmentHistory: TaxonomyOwnerExportRecord["assignmentHistory"][number][];
        valueIds: Set<string>;
      }>();
      for (const taxonomy of taxonomyResult.value.taxonomies) {
        const valueIds = new Set(taxonomy.values.map((value) => value.valueId));
        if (valueIds.size !== taxonomy.values.length || records.has(taxonomy.taxonomyId)) {
          return err({ kind: "temporarily_unavailable", code: "TAXONOMY_EXPORT_SOURCE_INVALID" });
        }
        for (const value of taxonomy.values) {
          if (value.mergedIntoValueId !== undefined && (!valueIds.has(value.mergedIntoValueId) || value.mergedIntoValueId === value.valueId)) {
            return err({ kind: "temporarily_unavailable", code: "TAXONOMY_EXPORT_MAPPING_INVALID" });
          }
        }
        records.set(taxonomy.taxonomyId, { facts: taxonomy, assignments: [], assignmentHistory: [], valueIds });
      }
      for (const assignment of assignmentResult.value.assignments) {
        const taxonomy = records.get(assignment.taxonomyId);
        if (taxonomy === undefined || !taxonomy.valueIds.has(assignment.valueId)) {
          return err({ kind: "temporarily_unavailable", code: "TAXONOMY_EXPORT_ASSIGNMENT_DANGLING" });
        }
        taxonomy.assignments.push({
          targetId: assignment.projectId,
          taxonomyValueId: assignment.valueId,
          assignedAt: assignment.assignedAt,
        });
      }
      for (const assignment of assignmentResult.value.history) {
        const taxonomy = records.get(assignment.taxonomyId);
        if (taxonomy === undefined || !taxonomy.valueIds.has(assignment.valueId)) {
          return err({ kind: "temporarily_unavailable", code: "TAXONOMY_EXPORT_HISTORY_DANGLING" });
        }
        taxonomy.assignmentHistory.push({
          targetId: assignment.projectId,
          taxonomyValueId: assignment.valueId,
          sequence: assignment.sequence,
          projectVersion: assignment.projectVersion,
          changedAt: assignment.changedAt,
        });
      }
      const taxonomies = [...records.values()].map(({ facts, assignments, assignmentHistory }) => ({
        ...facts,
        values: [...facts.values].sort((left, right) => compare(left.valueId, right.valueId)),
        evolutionHistory: [...facts.evolutionHistory].sort((left, right) =>
          compare(left.valueId, right.valueId) || left.transitionSequence - right.transitionSequence,
        ),
        assignments: assignments.sort((left, right) =>
          compare(left.targetId, right.targetId) || compare(left.taxonomyValueId, right.taxonomyValueId),
        ),
        assignmentHistory: assignmentHistory.sort((left, right) =>
          compare(left.targetId, right.targetId) || left.sequence - right.sequence,
        ),
      }));
      taxonomies.sort((left, right) => compare(left.taxonomyId, right.taxonomyId));
      return ok({ capturedAt: taxonomyResult.value.capturedAt, taxonomies });
    },
  };
}
