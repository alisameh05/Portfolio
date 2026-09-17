import type { StableId, Result, Rejection } from "@shared/domain";
import { err } from "@shared/domain";
import type { CvRepositoryPort, CvStoragePort } from "../ports/index.js";
import type { CvVersion } from "../domain/index.js";

/**
 * Stub repository adapter for Phase 1 skeleton.
 * Business implementation and persistence are deferred to later phases.
 */
export class StubCvRepository implements CvRepositoryPort {
  async getCurrentCv(): Promise<Result<CvVersion, Rejection>> {
    return err({ kind: "not_found", code: "CURRENT_CV_NOT_FOUND" });
  }

  async getCvVersionById(
    _id: StableId<"CvVersion">,
  ): Promise<Result<CvVersion, Rejection>> {
    return err({ kind: "not_found", code: "CV_VERSION_NOT_FOUND" });
  }

  async saveCvVersion(
    _cvVersion: CvVersion,
  ): Promise<Result<CvVersion, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "PERSISTENCE_NOT_IMPLEMENTED" });
  }

  async setCurrentCv(
    _id: StableId<"CvVersion">,
  ): Promise<Result<CvVersion, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "PERSISTENCE_NOT_IMPLEMENTED" });
  }
}

export class StubCvStorage implements CvStoragePort {
  async getDownloadUrl(
    _mediaAssetId: StableId<"MediaAsset">,
  ): Promise<Result<string, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "STORAGE_NOT_IMPLEMENTED" });
  }
}
