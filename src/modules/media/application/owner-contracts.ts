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
  readonly processingHistory: ReadonlyArray<OwnerMediaProcessingView>;
  readonly decisionHistory: ReadonlyArray<OwnerMediaDecisionView>;
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
  readonly mediaAssetId: StableId<string>;
  readonly purpose: MediaDeliveryPurpose;
  readonly locale: MediaDeliveryLocale;
}

export interface MediaDeliveryLocation {
  readonly mediaAssetId: StableId<"MediaAsset">;
  readonly purpose: MediaDeliveryPurpose;
  readonly locale: MediaDeliveryLocale;
  /** Opaque provider-neutral delivery location; never persisted as an identity. */
  readonly url: string;
  readonly expiresAt: string;
  readonly mimeType: string;
  readonly accessibility: MediaAccessibilityMetadata;
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
