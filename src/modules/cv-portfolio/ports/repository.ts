import type { StableId, Result, Rejection } from "@shared/domain";
import type { CvVersion } from "../domain/index.js";
import type { CurrentCvDisposition } from "../domain/index.js";

export interface CvRepositoryPort {
  getCurrentCv(): Promise<Result<CvVersion, Rejection>>;

  getCvVersionById(
    id: StableId<"CvVersion">,
  ): Promise<Result<CvVersion, Rejection>>;

  saveCvVersion(
    cvVersion: CvVersion,
  ): Promise<Result<CvVersion, Rejection>>;

  setCurrentCv(
    id: StableId<"CvVersion">,
  ): Promise<Result<CvVersion, Rejection>>;
}

export interface CvStoragePort {
  /** @deprecated Use CvCurrentDeliveryPort for Phase 6 workflows. */
  getDownloadUrl(
    mediaAssetId: StableId<"MediaAsset">,
  ): Promise<Result<string, Rejection>>;
}

export interface CvCurrentDeliveryPort {
  getDownloadTarget(
    mediaAssetId: StableId<"MediaAsset">,
    disposition: CurrentCvDisposition,
  ): Promise<Result<{ readonly url: string; readonly expiresAt: string }, Rejection>>;
  getStream(
    mediaAssetId: StableId<"MediaAsset">,
    disposition: CurrentCvDisposition,
  ): Promise<Result<AsyncIterable<Uint8Array>, Rejection>>;
}
