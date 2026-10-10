import type { Rejection, Result, StableId } from "@shared/domain";

export interface SealedUploadCapability {
  readonly version: 1;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authenticationTag: string;
}

export interface UploadIntentReceiptRecord {
  readonly mediaId: StableId<"MediaAsset">;
  readonly uploadIntentId: StableId<"MediaUploadIntent">;
  readonly expiresAt: string;
}

export interface UploadIntentReservationInput {
  readonly ownerId: StableId<"Owner">;
  readonly portfolioId: StableId<"Portfolio">;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly mediaId: StableId<"MediaAsset">;
  readonly uploadIntentId: StableId<"MediaUploadIntent">;
  readonly mediaObjectId: StableId<"MediaObject">;
  readonly reservationExpiresAt: string;
}

export type UploadIntentReservation =
  | { readonly kind: "reserved" }
  | {
      readonly kind: "replay";
      readonly receipt: UploadIntentReceiptRecord;
      readonly capability: SealedUploadCapability;
    }
  | { readonly kind: "in-progress" }
  | { readonly kind: "conflict" };

export interface CompleteUploadIntentInput extends UploadIntentReservationInput {
  readonly kind: "image" | "video" | "document";
  readonly originalFileName: string;
  readonly declaredMediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly expiresAt: string;
  readonly uploadTarget: SealedUploadCapability;
}

export interface ExpiredUploadIntentCleanup {
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
  readonly idempotencyKeyHash: string;
  readonly mediaId: StableId<"MediaAsset">;
  readonly uploadIntentId: StableId<"MediaUploadIntent">;
  readonly mediaObjectId: StableId<"MediaObject">;
}

/** Scoped Media-owned persistence for exact upload-intent replay. */
export interface MediaUploadIntentRepositoryPort {
  reserve(input: UploadIntentReservationInput): Promise<Result<UploadIntentReservation, Rejection>>;
  complete(input: CompleteUploadIntentInput): Promise<Result<void, Rejection>>;
  abandon(input: UploadIntentReservationInput): Promise<void>;
  listExpiredAbandoned(input: {
    readonly ownerId: StableId<"Owner">;
    readonly portfolioId: StableId<"Portfolio">;
    readonly now: string;
    readonly limit: number;
  }): Promise<Result<ReadonlyArray<ExpiredUploadIntentCleanup>, Rejection>>;
  markCompensated(input: ExpiredUploadIntentCleanup): Promise<Result<void, Rejection>>;
}

/** Adapter-confined authenticated encryption for replayable bearer targets. */
export interface UploadCapabilityVaultPort {
  isAvailable(): boolean;
  seal(plaintext: string, associatedData: string): SealedUploadCapability;
  open(value: SealedUploadCapability, associatedData: string): string;
}
