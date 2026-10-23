import type {
  Rejection,
  Result,
  StableId,
} from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import type { ExportStatus, ExportScope } from "../domain/index.js";
import type { OwnerExportPackageManifest } from "./service.js";
import type { SafeErrorCode } from "./persistence.js";

/** Durable five-state identity and lifecycle facts for one Owner export request. */
export interface PersistedOwnerExport {
  readonly exportId: StableId<"OwnerExport">;
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
  readonly includedScopes: readonly ExportScope[];
  readonly status: ExportStatus;
  readonly schemaVersion: string;
  readonly requestedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly expiredAt?: string;
  /** Uppercase persistence machine code; the transport maps it explicitly. */
  readonly failureCode?: SafeErrorCode;
  readonly integrityManifest?: OwnerExportPackageManifest;
  readonly artifactId?: StableId<"OwnerExportArtifact">;
}

export interface OwnerExportReservationInput {
  readonly exportId: StableId<"OwnerExport">;
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
  readonly includedScopes: readonly ExportScope[];
  readonly schemaVersion: string;
  readonly requestedAt: string;
}

/** A stale or impossible transition never wins; the carrier reports why it did not apply. */
export type OwnerExportTransitionOutcome =
  | { readonly kind: "applied"; readonly result: PersistedOwnerExport }
  | { readonly kind: "stale" };

export interface OwnerExportTransitionInput {
  readonly exportId: StableId<"OwnerExport">;
  readonly fromStatus: ExportStatus;
  readonly toStatus: ExportStatus;
  /** Optimistic guard: the writer's expected existing aggregate version. */
  readonly expectedAggregateVersion: number;
  readonly transitionedAt: string;
  readonly actingJobId: StableId<"Job">;
  readonly failureCode?: SafeErrorCode;
  readonly integrityManifest?: OwnerExportPackageManifest;
  readonly artifactId?: StableId<"OwnerExportArtifact">;
}

/**
 * Module-owned persistence seam for the durable Owner export request rows.
 * The atomic request transaction reserves exactly one export row here and one
 * assembly job through the single shared leased queue; inspection reads break
 * nothing, and the guarded transitions worker slice owns real completion.
 */
export interface OwnerExportStorePort {
  reserveOwnerExport(
    input: OwnerExportReservationInput,
    context: TransactionContext,
  ): Promise<void>;
  findOwnerExport(input: {
    readonly exportId: StableId<"OwnerExport">;
    readonly portfolioId: StableId<"Portfolio">;
    readonly ownerId: StableId<"Owner">;
  }): Promise<PersistedOwnerExport | null>;
  /** Applies the guarded transition in one transaction; readiness also emits the produced event. */
  applyOwnerExportTransition(
    input: OwnerExportTransitionInput,
  ): Promise<Result<OwnerExportTransitionOutcome, Rejection>>;
}
