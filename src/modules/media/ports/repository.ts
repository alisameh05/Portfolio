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
  /** @deprecated Use MediaObjectStoragePort for Phase 6 workflows. */
  generateUploadUrl(
    assetId: StableId<"MediaAsset">,
    mimeType: string,
  ): Promise<Result<{ uploadUrl: string; storageReference: string }, Rejection>>;

  getDeliveryUrl(
    storageReference: string,
  ): Promise<Result<string, Rejection>>;
}

export interface MediaScannerPort {
  /** @deprecated Use TrustedMediaScannerPort for Phase 6 workflows. */
  scanAsset(
    storageReference: string,
  ): Promise<Result<{ isClean: boolean; reason?: string }, Rejection>>;
}

export interface MediaObjectStoragePort {
  generateUploadTarget(
    assetId: StableId<"MediaAsset">,
    mimeType: string,
  ): Promise<Result<{
    readonly uploadUrl: string;
    readonly objectId: StableId<"MediaObject">;
    readonly expiresAt: string;
  }, Rejection>>;
  getDeliveryTarget(input: {
    readonly objectId: StableId<"MediaObject">;
    readonly purpose: "project" | "profile" | "current-cv";
    readonly locale: "en" | "ar";
  }): Promise<Result<{ readonly url: string; readonly expiresAt: string; readonly mimeType: string }, Rejection>>;
}

export interface TrustedMediaScannerPort {
  scanObject(
    objectId: StableId<"MediaObject">,
  ): Promise<Result<{
    readonly verdict: "clean" | "unsafe" | "inconclusive";
    readonly evidenceId: string;
  }, Rejection>>;
}

export interface MediaProcessorPort {
  processAsset(input: {
    readonly objectId: StableId<"MediaObject">;
    readonly kind: "image" | "video" | "document";
    readonly detectedMimeType: string;
    readonly byteSize: number;
    readonly sha256: string;
  }): Promise<Result<{
    readonly sourceObjectId: StableId<"MediaObject">;
    readonly sourceSha256: string;
    readonly variants: readonly import("../domain/index.js").MediaObjectVariant[];
    readonly toolVersion: string;
    readonly policyVersion: string;
  }, Rejection>>;
}
