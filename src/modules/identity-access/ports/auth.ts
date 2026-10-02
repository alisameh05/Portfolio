import type { Result, Rejection, StableId } from "@shared/domain";
import type {
  OwnerIdentity,
  PseudonymousPurpose,
  MeasurementConsent,
  FunctionalIdentityOperation,
  PseudonymousToken,
} from "../domain/index.js";

/**
 * Verified Owner session input. The adapter validates signature, algorithm,
 * issuer, audience, expiry, and required subject/session claims against
 * trusted provider identity records before constructing the stable Owner
 * actor. Raw Supabase/JWT/cookie/request objects never cross this seam.
 */
export interface VerifyOwnerSessionInput {
  readonly sessionToken: string;
  readonly expectedPurpose: "owner_session";
}

interface IssuePseudonymousTokenInputBase {
  readonly ttlSeconds: number;
  readonly consent: MeasurementConsent;
}

export type IssuePseudonymousTokenInput =
  | (IssuePseudonymousTokenInputBase & {
      readonly purpose: "visitor_functional";
      readonly interaction: FunctionalIdentityOperation;
    })
  | (IssuePseudonymousTokenInputBase & {
      readonly purpose: "visitor_measurement";
    });

export interface VerifyPseudonymousTokenInput {
  readonly tokenString: string;
  readonly expectedPurpose: PseudonymousPurpose;
  /** Current consent is checked on every Measurement token use. */
  readonly consent: MeasurementConsent;
}

export interface VerifiedPseudonymousToken {
  readonly subject: StableId<string>;
  readonly purpose: PseudonymousPurpose;
}

export interface AuthProviderPort {
  verifyOwnerSession(
    input: VerifyOwnerSessionInput,
  ): Promise<Result<OwnerIdentity, Rejection>>;

  getOwnerAllowlist(): Promise<Result<readonly string[], Rejection>>;
}

export interface CryptoPort {
  issuePseudonymousToken(
    input: IssuePseudonymousTokenInput,
  ): Promise<Result<PseudonymousToken, Rejection>>;

  verifyPseudonymousToken(
    input: VerifyPseudonymousTokenInput,
  ): Promise<Result<VerifiedPseudonymousToken, Rejection>>;
}
