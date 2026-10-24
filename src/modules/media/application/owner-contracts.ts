import type {
  ActorContext,
  IdempotencyKey,
  Rejection,
  Result,
  StableId,
} from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import type { MediaAccessibilityMetadata, MediaAsset } from "../domain/index.js";

/** Safe Owner reads and commands for the five existing Media operations. */
export interface GetOwnerMediaAggregateQuery {
  readonly actor: ActorContext;
  readonly mediaId: StableId<string>;
}

export interface CreateOwnerMediaUploadIntentApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly kind: "image" | "video" | "document";
  readonly originalFileName: string;
  readonly declaredMediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface RecordOwnerMediaProcessingApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly mediaId: StableId<string>;
  readonly result: "passed" | "failed";
  readonly detectedMediaType: string;
  readonly detectedByteLength: number;
  readonly sha256: string;
  readonly findings?: ReadonlyArray<string>;
}

export type OwnerMediaAccessibility =
  | { readonly kind: "described-image"; readonly altText: string }
  | { readonly kind: "decorative-image" }
  | { readonly kind: "video"; readonly summary: string }
  | { readonly kind: "document"; readonly summary: string };

export interface AcceptOwnerMediaAssetApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly mediaId: StableId<string>;
  readonly accessibility: OwnerMediaAccessibility;
}

export interface RejectOwnerMediaAssetApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly mediaId: StableId<string>;
  readonly reason: string;
}

export interface OwnerMediaProcessingView {
  readonly result: "passed" | "failed";
  readonly detectedMediaType: string;
  readonly detectedByteLength: number;
  readonly sha256: string;
  /** Sanitized policy finding codes only; never raw scanner output. */
  readonly findings: ReadonlyArray<string>;
  readonly recordedAt: string;
}

export interface OwnerMediaDecisionView {
  readonly decision: "accepted" | "rejected";
  readonly decidedAt: string;
  readonly reason?: string;
}

export interface OwnerMediaAggregateView {
  readonly mediaId: StableId<string>;
  readonly aggregateVersion: number;
  readonly kind: "image" | "video" | "document";
  readonly originalFileName: string;
  readonly declaredMediaType: string;
  readonly byteLength: number;
  readonly state: "upload-pending" | "processing" | "processed" | "accepted" | "rejected";
  /** Newest-first, at most 100 retained attempts; true means older rows exist. */
  readonly processingHistory: ReadonlyArray<OwnerMediaProcessingView>;
  /** Additive metadata preserves compatibility with clients that ignore it. */
  readonly processingHistoryTruncated?: boolean;
  /** Newest-first, at most 100 retained decisions; true means older rows exist. */
  readonly decisionHistory: ReadonlyArray<OwnerMediaDecisionView>;
  /** Additive metadata preserves compatibility with clients that ignore it. */
  readonly decisionHistoryTruncated?: boolean;
}

/** Complete Media-owned metadata needed for a portable Media export. Storage identities stay private to assembly. */
export interface OwnerMediaExportAsset {
  readonly mediaId: StableId<"MediaAsset">;
  readonly objectId: StableId<"MediaObject">;
  /** Private assembly hint for the immutable source object or an accepted output variant. */
  readonly source: "original" | "variant";
  /** Required only for the original upload's provider path; never serialized into the export. */
  readonly uploadIntentId?: StableId<"MediaUploadIntent">;
  readonly variantName: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface OwnerMediaExportRecord {
  readonly mediaId: StableId<"MediaAsset">;
  readonly value: Readonly<Record<string, unknown>>;
}

export interface OwnerMediaExportSnapshot {
  readonly capturedAt: string;
  readonly records: readonly OwnerMediaExportRecord[];
  readonly assets: readonly OwnerMediaExportAsset[];
}

export interface OwnerMediaExportSnapshotReaderPort {
  readOwnerMediaExportSnapshot(
    scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> },
    context: TransactionContext,
  ): Promise<Result<OwnerMediaExportSnapshot, Rejection>>;
  revalidateOwnerMediaExportSnapshot(
    scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> },
    mediaVersions: ReadonlyMap<StableId<"MediaAsset">, number>,
    context?: TransactionContext,
  ): Promise<Result<boolean, Rejection>>;
}

export interface OwnerMediaUploadIntentView {
  readonly mediaId: StableId<string>;
  readonly aggregateVersion: 1;
  readonly outcome: "media-upload-intent-created";
  readonly uploadIntentId: StableId<string>;
  readonly uploadTarget: string;
  readonly expiresAt: string;
}

export interface OwnerMediaCommandReceipt {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome:
    | "media-processing-recorded"
    | "media-accepted"
    | "media-rejected";
}

export interface OwnerMediaApplicationService {
  getOwnerMediaAggregate(
    query: GetOwnerMediaAggregateQuery,
  ): Promise<Result<OwnerMediaAggregateView, Rejection>>;
  createOwnerMediaUploadIntent(
    command: CreateOwnerMediaUploadIntentApplicationCommand,
  ): Promise<Result<OwnerMediaUploadIntentView, Rejection>>;
  recordOwnerMediaProcessing(
    command: RecordOwnerMediaProcessingApplicationCommand,
  ): Promise<Result<OwnerMediaCommandReceipt, Rejection>>;
  acceptOwnerMediaAsset(
    command: AcceptOwnerMediaAssetApplicationCommand,
  ): Promise<Result<OwnerMediaCommandReceipt, Rejection>>;
  rejectOwnerMediaAsset(
    command: RejectOwnerMediaAssetApplicationCommand,
  ): Promise<Result<OwnerMediaCommandReceipt, Rejection>>;
}

export interface OwnerMediaAggregateRepositoryPort {
  getOwnerMediaAggregate(input: {
    readonly ownerId: StableId<"Owner">;
    readonly mediaId: StableId<"MediaAsset">;
  }): Promise<Result<OwnerMediaAggregateView, Rejection>>;
}

/** Complete, consistent acceptance facts read through the caller's transaction. */
export interface GetMediaAcceptanceFactsQuery {
  readonly ownerId: StableId<"Owner">;
  readonly mediaAssetIds: ReadonlyArray<StableId<"MediaAsset">>;
  readonly intendedUse: "supporting-artifact" | "decorative";
}

export interface MediaAcceptanceFact {
  readonly mediaAssetId: StableId<"MediaAsset">;
  readonly ownerId: StableId<"Owner">;
  readonly assetVersion: number;
  readonly accepted: boolean;
  readonly safe: boolean;
  readonly suitable: boolean;
  readonly accessible: boolean;
  readonly consistencyVersion: string;
}

/** Immutable accepted PDF identity returned only for a current eligible Media asset. */
export interface GetAcceptedPdfSnapshotQuery {
  readonly ownerId: StableId<"Owner">;
  readonly mediaAssetId: StableId<"MediaAsset">;
}

export interface AcceptedPdfSnapshot {
  readonly mediaAssetId: StableId<"MediaAsset">;
  readonly ownerId: StableId<"Owner">;
  readonly assetVersion: number;
  readonly decisionId: StableId<"MediaDecision">;
  readonly objectId: StableId<"MediaObject">;
  readonly sha256: string;
  readonly objectVersion: string;
}

export type AcceptedPdfSnapshotResult =
  | { readonly status: "not-eligible" }
  | { readonly status: "not-pdf" }
  | { readonly status: "accepted"; readonly snapshot: AcceptedPdfSnapshot };

export interface GetMediaUsageQuery {
  readonly ownerId: StableId<string>;
  readonly mediaAssetId: StableId<string>;
}

export interface MediaUsage {
  readonly hasVisibleContentReference: boolean;
  readonly isCurrentCv: boolean;
}

export type MediaDeliveryPurpose = "project" | "profile" | "current-cv";
export type MediaDeliveryLocale = "en" | "ar";

export interface ResolveMediaDeliveryQuery {
  readonly mediaAssetId: StableId<"MediaAsset">;
  readonly purpose: MediaDeliveryPurpose;
  readonly locale: MediaDeliveryLocale;
}

export interface MediaDeliveryVariant {
  readonly objectId: StableId<"MediaObject">;
  readonly name: string;
  readonly url: string;
  readonly expiresAt: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly width?: number;
  readonly height?: number;
  readonly codec?: string;
}

export interface MediaDeliveryLocation {
  readonly mediaAssetId: StableId<"MediaAsset">;
  readonly purpose: MediaDeliveryPurpose;
  readonly locale: MediaDeliveryLocale;
  /** Opaque short-lived bearer capabilities; never persisted as an identity. */
  readonly variants: ReadonlyArray<MediaDeliveryVariant>;
  readonly accessibility: MediaAccessibilityMetadata;
}

export interface MediaDeliveryCandidate {
  readonly mediaAssetId: StableId<"MediaAsset">;
  readonly ownerId: StableId<"Owner">;
  readonly assetVersion: number;
  readonly accessibility: MediaAccessibilityMetadata;
  readonly variants: ReadonlyArray<MediaDeliveryCandidateVariant>;
}

export interface MediaDeliveryCandidateVariant {
  readonly objectId: StableId<"MediaObject">;
  readonly name: string;
  readonly mimeType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly objectVersion: string;
  readonly width?: number;
  readonly height?: number;
  readonly codec?: string;
}

export interface MediaDeliveryRepositoryPort {
  getEligibleDeliveryCandidate(
    query: ResolveMediaDeliveryQuery & { readonly ownerId: StableId<"Owner"> },
    transaction: TransactionContext,
  ): Promise<Result<MediaDeliveryCandidate, Rejection>>;
}

export interface MediaDeliveryUsePort {
  isCurrentlyUsed(
    query: ResolveMediaDeliveryQuery,
    transaction: TransactionContext,
  ): Promise<Result<boolean, Rejection>>;
}

export interface MediaDeliveryStoragePort {
  createSignedDeliveryTarget(input: {
    readonly mediaAssetId: StableId<"MediaAsset">;
    readonly purpose: MediaDeliveryPurpose;
    readonly locale: MediaDeliveryLocale;
    readonly variant: MediaDeliveryCandidateVariant;
  }): Promise<Result<{ readonly url: string; readonly expiresAt: string }, Rejection>>;
}

export interface MediaDeliveryApplicationService {
  resolveDelivery(query: ResolveMediaDeliveryQuery): Promise<Result<MediaDeliveryLocation, Rejection>>;
}

export interface MediaReadApplicationService {
  /** Returns one complete fact per distinct requested same-Owner ID. */
  getAcceptanceFacts(
    query: GetMediaAcceptanceFactsQuery,
    transaction: TransactionContext,
  ): Promise<Result<ReadonlyArray<MediaAcceptanceFact>, Rejection>>;
  /** Reads the exact immutable PDF snapshot behind the current accepted decision. */
  getAcceptedPdfSnapshot(
    query: GetAcceptedPdfSnapshotQuery,
    transaction: TransactionContext,
  ): Promise<Result<AcceptedPdfSnapshotResult, Rejection>>;
  /** Bounded Storage existence check for the exact immutable accepted PDF object. */
  preflightAcceptedPdfObject(input: {
    readonly portfolioId: StableId<"Portfolio">;
    readonly snapshot: AcceptedPdfSnapshot;
  }): Promise<Result<void, Rejection>>;
  getUsage(query: GetMediaUsageQuery): Promise<Result<MediaUsage, Rejection>>;
  resolveDelivery(
    query: ResolveMediaDeliveryQuery,
  ): Promise<Result<MediaDeliveryLocation, Rejection>>;
  /** Kept as a typed bridge while feature tickets replace fail-closed wiring. */
  getMediaAsset(
    mediaAssetId: StableId<"MediaAsset">,
  ): Promise<Result<MediaAsset, Rejection>>;
}
