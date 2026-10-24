import type {
  Rejection,
  Result,
  StableId,
} from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import type { ExportStatus, ExportScope } from "../domain/index.js";
import type { OwnerExportPackageManifest } from "./service.js";
import type { OwnerExportAssemblySnapshot } from "./owner-export-package.js";
import type { SafeErrorCode } from "./persistence.js";

/** Durable five-state identity and lifecycle facts for one Owner export request. */
export interface PersistedOwnerExport {
  readonly exportId: StableId<"OwnerExport">;
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
  readonly includedScopes: readonly ExportScope[];
  readonly status: ExportStatus;
  readonly schemaVersion: string;
  readonly aggregateVersion: number;
  readonly requestedAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly expiredAt?: string;
  /** Uppercase persistence machine code; the transport maps it explicitly. */
  readonly failureCode?: SafeErrorCode;
  readonly integrityManifest?: OwnerExportPackageManifest;
  readonly artifactId?: StableId<"OwnerExportArtifact">;
  readonly snapshot?: OwnerExportAssemblySnapshot;
  readonly candidateArtifactId?: StableId<"OwnerExportArtifact">;
  readonly candidateSha256?: string;
  readonly candidateContentLength?: number;
  readonly artifactSha256?: string;
  readonly artifactContentLength?: number;
  readonly expiresAt?: string;
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
  /** Current shared-queue lease token fences every lifecycle transition. */
  readonly leaseToken?: string;
  readonly transitionedAt: string;
  readonly actingJobId: StableId<"Job">;
  readonly failureCode?: SafeErrorCode;
  readonly integrityManifest?: OwnerExportPackageManifest;
  readonly artifactId?: StableId<"OwnerExportArtifact">;
  readonly expiresAt?: string;
  /** Internal readiness fence run in the same transaction as the ready transition. */
  readonly precondition?: (context: TransactionContext) => Promise<boolean>;
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
  /** Snapshot checkpoints survive process loss; each write must verify the live queue lease. */
  saveOwnerExportSnapshot(input: {
    readonly exportId: StableId<"OwnerExport">;
    readonly actingJobId: StableId<"Job">;
    readonly leaseToken: string;
    readonly snapshot: OwnerExportAssemblySnapshot;
  }): Promise<Result<"saved" | "stale", Rejection>>;
  saveOwnerExportCandidate(input: {
    readonly exportId: StableId<"OwnerExport">;
    readonly actingJobId: StableId<"Job">;
    readonly leaseToken: string;
    readonly artifactId: StableId<"OwnerExportArtifact">;
    readonly sha256: string;
    readonly contentLength: number;
  }): Promise<Result<"saved" | "stale", Rejection>>;
  /** Applies the guarded transition in one transaction; readiness also emits the produced event. */
  applyOwnerExportTransition(
    input: OwnerExportTransitionInput,
  ): Promise<Result<OwnerExportTransitionOutcome, Rejection>>;
}
