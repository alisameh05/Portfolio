/**
 * media module public interface.
 *
 * This barrel is the single public import surface for the Media module.
 * Other modules must never deep-import internal paths.
 */

export type {
  MediaSafetyStatus,
  MediaAcceptanceStatus,
  MediaAccessibilityMetadata,
  MediaVariant,
  MediaAsset,
  MediaDeliveryReference,
  MediaAssetAcceptedEvent,
  MediaAssetRejectedEvent,
} from "./domain/index.js";

export type {
  CreateUploadIntentCommand,
  RecordProcessingCommand,
  AcceptMediaAssetCommand,
  RejectMediaAssetCommand,
  GetMediaDeliveryReferenceQuery,
  MediaService,
} from "./application/index.js";

export type {
  MediaRepositoryPort,
  MediaStoragePort,
  MediaScannerPort,
} from "./ports/index.js";
