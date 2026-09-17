import type { StableId, Result, Rejection, ActorContext } from "@shared/domain";
import type { CvVersion } from "../domain/index.js";

export interface RegisterCvCandidateCommand {
  readonly actor: ActorContext;
  readonly mediaAssetId: StableId<"MediaAsset">;
}

export interface AcceptCvVersionCommand {
  readonly actor: ActorContext;
  readonly cvVersionId: StableId<"CvVersion">;
}

export interface ActivateCvVersionCommand {
  readonly actor: ActorContext;
  readonly cvVersionId: StableId<"CvVersion">;
}

export interface GetCurrentCvQuery {
  readonly actor: ActorContext;
}

export interface DownloadCurrentCvQuery {
  readonly actor: ActorContext;
}

export interface CvPortfolioService {
  registerCandidate(
    command: RegisterCvCandidateCommand,
  ): Promise<Result<CvVersion, Rejection>>;

  acceptVersion(
    command: AcceptCvVersionCommand,
  ): Promise<Result<CvVersion, Rejection>>;

  activateCurrentCv(
    command: ActivateCvVersionCommand,
  ): Promise<Result<CvVersion, Rejection>>;

  getCurrentCv(
    query: GetCurrentCvQuery,
  ): Promise<Result<CvVersion, Rejection>>;

  downloadCurrentCv(
    query: DownloadCurrentCvQuery,
  ): Promise<Result<{ downloadUrl: string }, Rejection>>;
}
