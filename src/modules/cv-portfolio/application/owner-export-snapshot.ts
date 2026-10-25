import type { Rejection, Result, StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";

/** Immutable Media acceptance binding captured when a CV version was accepted. */
export interface OwnerCvAcceptedMediaSnapshot {
  readonly mediaAssetVersion: number;
  readonly mediaDecisionId: StableId<"MediaDecision">;
  readonly mediaObjectId: StableId<"MediaObject">;
  readonly sha256: string;
  readonly objectVersion: string;
}

export interface OwnerCvExportVersion {
  readonly versionId: StableId<"CvVersion">;
  readonly mediaId: StableId<"MediaAsset">;
  readonly locale: "en";
  readonly label: string;
  readonly state: "registered" | "accepted";
  readonly isCurrent: boolean;
  readonly versionNumber: number;
  readonly registeredAt: string;
  readonly acceptedAt?: string;
  /** Private CV-to-Media binding. It is never serialized into portable records. */
  readonly acceptedMediaSnapshot?: OwnerCvAcceptedMediaSnapshot;
}

export interface OwnerCvExportAcceptance {
  readonly approvalId: StableId<"CvAcceptance">;
  readonly versionId: StableId<"CvVersion">;
  readonly acceptedAt: string;
}

export interface OwnerCvExportActivation {
  readonly activationId: StableId<"CvActivation">;
  readonly versionId: StableId<"CvVersion">;
  readonly activatedAt: string;
}

/** Bounded, source-owned facts needed to reconstruct CV versions and Current CV. */
export interface OwnerCvExportSnapshot {
  readonly capturedAt: string;
  readonly aggregateVersion: number;
  readonly currentVersionId: StableId<"CvVersion"> | null;
  readonly versions: readonly OwnerCvExportVersion[];
  readonly versionsTruncated: boolean;
  readonly acceptanceHistory: readonly OwnerCvExportAcceptance[];
  readonly acceptanceHistoryTruncated: boolean;
  readonly activationHistory: readonly OwnerCvExportActivation[];
  readonly activationHistoryTruncated: boolean;
}

/** Purpose-bound read-only CV application seam used during an export snapshot. */
export interface OwnerCvExportSnapshotReaderPort {
  readOwnerCvExportSnapshot(
    scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> },
    context: TransactionContext,
  ): Promise<Result<OwnerCvExportSnapshot, Rejection>>;
}
