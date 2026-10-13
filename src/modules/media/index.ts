/**
 * media module public interface.
 *
 * This barrel is the single public import surface for the Media module.
 * Other modules must never deep-import internal paths.
 */

export type {
  MediaSafetyStatus,
  MediaAcceptanceStatus,
  MediaFileKind,
  MediaAccessibilityMetadata,
  MediaVariant,
  MediaObjectVariant,
  MediaAsset,
  MediaDeliveryReference,
  MediaAssetAcceptedEvent,
  MediaAssetRejectedEvent,
} from "./domain/index.js";
export { MEDIA_PROCESSING_POLICY, effectiveMediaProcessingLimits } from "./domain/index.js";

export type {
  CreateUploadIntentCommand,
  RecordProcessingCommand,
  AcceptMediaAssetCommand,
  RejectMediaAssetCommand,
  GetMediaDeliveryReferenceQuery,
  MediaService,
  MediaApplicationService,
} from "./application/index.js";
export {
  createMediaUploadIntentApplicationService,
  createMediaProcessingApplicationService,
  createMediaAcceptanceApplicationService,
  createMediaDeliveryApplicationService,
  createMediaRejectionApplicationService,
} from "./application/index.js";
export type { MediaProcessingApplicationService, MediaProcessingRepositoryPort, MediaProcessingStoragePort, TrustedByteScannerPort, PdfProcessorPort, VideoProcessorPort, MediaProcessingOutputVariant, MediaImageProcessorPort, MediaImageVariant, MediaDigestPort, RecordMediaProcessingCommand, MediaAcceptanceApplicationService, MediaAcceptanceRepositoryFact, MediaAcceptanceRepositoryPort, MediaRejectionApplicationService, MediaRejectionRepositoryInput, MediaRejectionRepositoryPort, MediaRejectionUsagePort, MediaRejectionUsageQuery } from "./application/index.js";
export type {
  CreateMediaUploadIntentCommand,
  PreparedUploadTarget,
  MediaUploadTargetPort,
  MediaUploadIntentApplicationService,
  MediaUploadIntentServiceDependencies,
} from "./application/index.js";

export type {
  GetOwnerMediaAggregateQuery,
  CreateOwnerMediaUploadIntentApplicationCommand,
  RecordOwnerMediaProcessingApplicationCommand,
  OwnerMediaAccessibility,
  AcceptOwnerMediaAssetApplicationCommand,
  RejectOwnerMediaAssetApplicationCommand,
  OwnerMediaProcessingView,
  OwnerMediaDecisionView,
  OwnerMediaAggregateView,
  OwnerMediaUploadIntentView,
  OwnerMediaCommandReceipt,
  OwnerMediaApplicationService,
  GetMediaAcceptanceFactsQuery,
  GetAcceptedPdfSnapshotQuery,
  AcceptedPdfSnapshot,
  AcceptedPdfSnapshotResult,
  MediaAcceptanceFact,
  GetMediaUsageQuery,
  MediaUsage,
  MediaDeliveryPurpose,
  MediaDeliveryLocale,
  ResolveMediaDeliveryQuery,
  MediaDeliveryLocation,
  MediaDeliveryVariant,
  MediaDeliveryCandidate,
  MediaDeliveryCandidateVariant,
  MediaDeliveryRepositoryPort,
  MediaDeliveryUsePort,
  MediaDeliveryStoragePort,
  MediaDeliveryApplicationService,
  MediaReadApplicationService,
} from "./application/index.js";

export type {
  MediaRepositoryPort,
  MediaStoragePort,
  MediaScannerPort,
  MediaProcessorPort,
  MediaObjectStoragePort,
  TrustedMediaScannerPort,
} from "./ports/index.js";
export { createPostgresMediaProcessingRepository, createPostgresMediaAcceptanceRepository, createPostgresMediaDeliveryRepository, createPostgresMediaRejectionRepository } from "./adapters/index.js";
export type {
  SealedUploadCapability,
  UploadIntentReceiptRecord,
  UploadIntentReservationInput,
  UploadIntentReservation,
  CompleteUploadIntentInput,
  ExpiredUploadIntentCleanup,
  MediaUploadIntentRepositoryPort,
  UploadCapabilityVaultPort,
} from "./ports/index.js";
