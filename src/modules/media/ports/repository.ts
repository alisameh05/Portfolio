import type { StableId, Result, Rejection } from "@shared/domain";
import type { MediaAsset, MediaVariant } from "../domain/index.js";

export interface MediaRepositoryPort {
  getMediaAssetById(
    id: StableId<"MediaAsset">,
  ): Promise<Result<MediaAsset, Rejection>>;

  saveMediaAsset(
    asset: MediaAsset,
  ): Promise<Result<MediaAsset, Rejection>>;
}

export interface MediaStoragePort {
  generateUploadUrl(
    assetId: StableId<"MediaAsset">,
    mimeType: string,
  ): Promise<Result<{ uploadUrl: string; storageReference: string }, Rejection>>;

  getDeliveryUrl(
    storageReference: string,
  ): Promise<Result<string, Rejection>>;
}

export interface MediaScannerPort {
  scanAsset(
    storageReference: string,
  ): Promise<Result<{ isClean: boolean; reason?: string }, Rejection>>;
}
