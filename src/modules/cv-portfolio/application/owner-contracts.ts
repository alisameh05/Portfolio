import type {
  ActorContext,
  IdempotencyKey,
  Rejection,
  Result,
  StableId,
} from "@shared/domain";
import type { CurrentCvDisposition } from "../domain/index.js";
import type { TransactionContext } from "../../../runtime/ports.js";

/** Owner view distinguishes retained registrations from accepted CV versions. */
export interface GetOwnerCvPortfolioQuery {
  readonly actor: ActorContext;
}

export interface RegisterOwnerCvVersionApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly mediaId: StableId<string>;
  readonly locale: "en";
  readonly label: string;
}

export interface AcceptOwnerCvVersionApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly versionId: StableId<string>;
}

export interface ActivateOwnerCvVersionApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly versionId: StableId<string>;
}

export interface GetCurrentCvMediaUsageQuery {
  readonly ownerId: StableId<"Owner">;
  readonly mediaAssetId: StableId<"MediaAsset">;
  readonly transaction: TransactionContext;
}

export interface OwnerCvVersionView {
  readonly versionId: StableId<string>;
  readonly mediaId: StableId<string>;
  readonly locale: "en";
  readonly label: string;
  readonly state: "registered" | "accepted";
  readonly isCurrent: boolean;
}

export interface OwnerCvActivationView {
  readonly versionId: StableId<string>;
  readonly activatedAt: string;
}

export interface OwnerCvPortfolioView {
  readonly aggregateVersion: number;
  readonly currentVersionId: StableId<string> | null;
  readonly versions: ReadonlyArray<OwnerCvVersionView>;
  readonly activationHistory: ReadonlyArray<OwnerCvActivationView>;
}

export interface RegisterOwnerCvVersionReceipt {
  readonly versionId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome: "cv-version-registered";
}

export interface OwnerCvCommandReceipt {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome: "cv-version-accepted" | "current-cv-activated";
}

export interface OwnerCvApplicationService {
  getOwnerCvPortfolio(
    query: GetOwnerCvPortfolioQuery,
  ): Promise<Result<OwnerCvPortfolioView, Rejection>>;
  registerOwnerCvVersion(
    command: RegisterOwnerCvVersionApplicationCommand,
  ): Promise<Result<RegisterOwnerCvVersionReceipt, Rejection>>;
  acceptOwnerCvVersion(
    command: AcceptOwnerCvVersionApplicationCommand,
  ): Promise<Result<OwnerCvCommandReceipt, Rejection>>;
  activateOwnerCvVersion(
    command: ActivateOwnerCvVersionApplicationCommand,
  ): Promise<Result<OwnerCvCommandReceipt, Rejection>>;
  getCurrentCvMediaUsage(
    query: GetCurrentCvMediaUsageQuery,
  ): Promise<Result<boolean, Rejection>>;
}

/** Initial root view is available before the first CV registration. */
export interface CvPortfolioRootView {
  readonly aggregateVersion: number;
  readonly currentVersionId: StableId<"CvVersion"> | null;
  readonly registeredVersionCount: number;
}

/** Locale and disposition remain explicit at the public application boundary. */
export interface CurrentCvDownloadQuery {
  readonly actor: ActorContext;
  readonly locale: "en";
  readonly disposition: CurrentCvDisposition;
}

export type CurrentCvDelivery =
  | {
      readonly kind: "stream";
      readonly bytes: AsyncIterable<Uint8Array>;
      readonly disposition: CurrentCvDisposition;
    }
  | {
      readonly kind: "redirect";
      readonly downloadUrl: string;
      readonly expiresAt: string;
      readonly disposition: CurrentCvDisposition;
    };

export interface CvPortfolioApplicationService extends OwnerCvApplicationService {
  getRoot(
    query: GetOwnerCvPortfolioQuery,
  ): Promise<Result<CvPortfolioRootView, Rejection>>;
  downloadCurrentCv(
    query: CurrentCvDownloadQuery,
  ): Promise<Result<CurrentCvDelivery, Rejection>>;
}
