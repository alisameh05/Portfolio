import type { Rejection, Result, StableId } from "../../../shared/domain/index.js";
import type { TransactionContext } from "../../../runtime/ports.js";

export interface ContentTaxonomyExportScope {
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
}

export interface ContentTaxonomyExportAssignments {
  readonly assignments: readonly {
    readonly taxonomyId: StableId<"Taxonomy">;
    readonly projectId: StableId<"Project">;
    readonly valueId: StableId<"TaxonomyValue">;
    readonly assignedAt: string;
  }[];
  readonly history: readonly {
    readonly taxonomyId: StableId<"Taxonomy">;
    readonly projectId: StableId<"Project">;
    readonly sequence: number;
    readonly valueId: StableId<"TaxonomyValue">;
    readonly projectVersion: number;
    readonly changedAt: string;
  }[];
}

/** Content-owned read seam for the assignment facts included in a Taxonomy export. */
export interface ContentTaxonomyExportAssignmentReader {
  readOwnerExportAssignments(
    scope: ContentTaxonomyExportScope,
    context: TransactionContext,
  ): Promise<Result<ContentTaxonomyExportAssignments, Rejection>>;
}
