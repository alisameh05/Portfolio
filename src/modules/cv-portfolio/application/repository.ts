import type { IdempotencyKey, Rejection, Result, StableId } from "@shared/domain";
import type {
  OwnerCvCommandReceipt,
  OwnerCvPortfolioView,
  RegisterOwnerCvVersionReceipt,
} from "./owner-contracts.js";

export interface RegisterCvPortfolioVersionInput {
  readonly ownerId: StableId<"Owner">;
  readonly idempotencyKey: IdempotencyKey;
  readonly requestHash: string;
  readonly expectedVersion: number;
  readonly mediaId: StableId<string>;
  readonly locale: "en";
  readonly label: string;
  readonly versionId: StableId<"CvVersion">;
}

export interface AcceptCvPortfolioVersionInput {
  readonly ownerId: StableId<"Owner">;
  readonly idempotencyKey: IdempotencyKey;
  readonly requestHash: string;
  readonly expectedVersion: number;
  readonly versionId: StableId<"CvVersion">;
}

/** Persistence boundary for the Owner CV Portfolio registration workflow. */
export interface CvPortfolioRepositoryPort {
  /** Creates the configured empty root once, then returns bounded safe views. */
  getOwnerCvPortfolio(
    ownerId: StableId<"Owner">,
  ): Promise<Result<OwnerCvPortfolioView, Rejection>>;
  /** Validates Media facts and commits registration, root version, receipt and event atomically. */
  registerOwnerCvVersion(
    input: RegisterCvPortfolioVersionInput,
  ): Promise<Result<RegisterOwnerCvVersionReceipt, Rejection>>;
  /** Revalidates the immutable Media snapshot and atomically records CV approval. */
  acceptOwnerCvVersion(
    input: AcceptCvPortfolioVersionInput,
  ): Promise<Result<OwnerCvCommandReceipt, Rejection>>;
}
