import type { StableId, Result, Rejection, ActorContext } from "@shared/domain";
import type {
  MediaAsset,
  MediaAccessibilityMetadata,
  MediaVariant,
  MediaDeliveryReference,
} from "../domain/index.js";

export interface CreateUploadIntentCommand {
  readonly actor: ActorContext;
  readonly mimeType: string;
  readonly expectedByteSize: number;
}

export interface RecordProcessingCommand {
  readonly actor: ActorContext;
  readonly mediaAssetId: StableId<"MediaAsset">;
  readonly variants: readonly MediaVariant[];
}

export interface AcceptMediaAssetCommand {
  readonly actor: ActorContext;
  readonly mediaAssetId: StableId<"MediaAsset">;
  readonly accessibility: MediaAccessibilityMetadata;
}

export interface RejectMediaAssetCommand {
  readonly actor: ActorContext;
  readonly mediaAssetId: StableId<"MediaAsset">;
  readonly reason: string;
}

export interface GetMediaDeliveryReferenceQuery {
  readonly mediaAssetId: StableId<"MediaAsset">;
}

export interface MediaService {
  createUploadIntent(
    command: CreateUploadIntentCommand,
  ): Promise<Result<{ mediaAssetId: StableId<"MediaAsset">; uploadUrl: string }, Rejection>>;

  recordProcessing(
    command: RecordProcessingCommand,
  ): Promise<Result<MediaAsset, Rejection>>;

  acceptMediaAsset(
    command: AcceptMediaAssetCommand,
  ): Promise<Result<MediaAsset, Rejection>>;

  rejectMediaAsset(
    command: RejectMediaAssetCommand,
  ): Promise<Result<MediaAsset, Rejection>>;

  getMediaDeliveryReference(
    query: GetMediaDeliveryReferenceQuery,
  ): Promise<Result<MediaDeliveryReference, Rejection>>;
}
