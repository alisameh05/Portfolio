import type { StableId, Result, Rejection } from "@shared/domain";
import type { CvVersion } from "../domain/index.js";

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
  getDownloadUrl(
    mediaAssetId: StableId<"MediaAsset">,
  ): Promise<Result<string, Rejection>>;
}
