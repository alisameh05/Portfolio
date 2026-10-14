import type { StableId, Result, Rejection } from "@shared/domain";
import { err } from "@shared/domain";
import type {
  MediaRepositoryPort,
  MediaStoragePort,
  MediaScannerPort,
  MediaProcessorPort,
  MediaObjectStoragePort,
  TrustedMediaScannerPort,
} from "../ports/index.js";
import type { MediaAsset } from "../domain/index.js";

export { createUploadCapabilityVault } from "./upload-capability-vault.js";
export { createPostgresMediaUploadIntentRepository } from "./postgres-upload-intents.js";
export { createPostgresMediaProcessingRepository } from "./postgres-processing.js";
export { createPostgresMediaAcceptanceRepository } from "./postgres-acceptance.js";
export { createPostgresMediaDeliveryRepository } from "./postgres-delivery.js";
export { createPostgresMediaRejectionRepository } from "./postgres-rejection.js";
export { createPostgresOwnerMediaAggregateRepository } from "./postgres-owner-aggregate.js";

/**
 * Stub repository adapter for Phase 1 skeleton.
 * Business implementation and persistence are deferred to later phases.
 */
export class StubMediaRepository implements MediaRepositoryPort {
  async getMediaAssetById(
    _id: StableId<"MediaAsset">,
  ): Promise<Result<MediaAsset, Rejection>> {
    return err({ kind: "not_found", code: "MEDIA_ASSET_NOT_FOUND" });
  }

  async saveMediaAsset(
    _asset: MediaAsset,
  ): Promise<Result<MediaAsset, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "PERSISTENCE_NOT_IMPLEMENTED" });
  }
}

export class StubMediaStorage implements MediaStoragePort {
  async generateUploadUrl(
    _assetId: StableId<"MediaAsset">,
    _mimeType: string,
  ): Promise<Result<{ uploadUrl: string; storageReference: string }, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "STORAGE_NOT_IMPLEMENTED" });
  }

  async getDeliveryUrl(
    _storageReference: string,
  ): Promise<Result<string, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "STORAGE_NOT_IMPLEMENTED" });
  }
}

export class StubMediaScanner implements MediaScannerPort {
  async scanAsset(
    _storageReference: string,
  ): Promise<Result<{ isClean: boolean; reason?: string }, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "SCANNER_NOT_IMPLEMENTED" });
  }
}

/** Fail-closed Phase 6 storage adapter seam. */
export class StubMediaObjectStorage implements MediaObjectStoragePort {
  async generateUploadTarget(
    _assetId: StableId<"MediaAsset">,
    _mimeType: string,
  ): Promise<Result<{
    readonly uploadUrl: string;
    readonly objectId: StableId<"MediaObject">;
    readonly expiresAt: string;
  }, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "STORAGE_NOT_IMPLEMENTED" });
  }

  async getDeliveryTarget(_input: Parameters<MediaObjectStoragePort["getDeliveryTarget"]>[0]) {
    return err({ kind: "temporarily_unavailable" as const, code: "STORAGE_NOT_IMPLEMENTED" });
  }
}

/** Fail-closed Phase 6 scanner seam; raw provider diagnostics stay private. */
export class StubTrustedMediaScanner implements TrustedMediaScannerPort {
  async scanObject(_objectId: StableId<"MediaObject">) {
    return err({ kind: "temporarily_unavailable" as const, code: "SCANNER_NOT_IMPLEMENTED" });
  }
}

export class StubMediaProcessor implements MediaProcessorPort {
  async processAsset(_input: Parameters<MediaProcessorPort["processAsset"]>[0]) {
    return err({ kind: "temporarily_unavailable" as const, code: "PROCESSOR_NOT_IMPLEMENTED" });
  }
}
