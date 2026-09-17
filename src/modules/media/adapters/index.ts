import type { StableId, Result, Rejection } from "@shared/domain";
import { err } from "@shared/domain";
import type {
  MediaRepositoryPort,
  MediaStoragePort,
  MediaScannerPort,
} from "../ports/index.js";
import type { MediaAsset } from "../domain/index.js";

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
