import type { StableId } from "@shared/domain";

export type Role = "owner" | "visitor" | "system";

export type Permission =
  | "read:public"
  | "write:owner"
  | "admin:all"
  | "job:execute";

/**
 * Verified stable Owner identity. `githubSubject` is the immutable GitHub
 * subject from trusted provider identity records — never a mutable
 * username/email, user-editable metadata, or caller-supplied Owner ID.
 * `ownerId` is the stable domain identity; `sessionId` is the opaque
 * provider-neutral session reference. No Supabase/JWT/cookie type enters.
 */
export interface OwnerIdentity {
  readonly ownerId: StableId<"Owner">;
  readonly githubSubject: string;
  readonly sessionId: string;
}

export type PseudonymousPurpose = "visitor_functional" | "visitor_measurement";

/** Only interactions whose current value is deduplicated need functional identity. */
export const FUNCTIONAL_IDENTITY_OPERATIONS = Object.freeze(["reaction", "rating"] as const);
export type FunctionalIdentityOperation = (typeof FUNCTIONAL_IDENTITY_OPERATIONS)[number];

export function isFunctionalIdentityOperation(
  value: unknown,
): value is FunctionalIdentityOperation {
  return FUNCTIONAL_IDENTITY_OPERATIONS.includes(value as FunctionalIdentityOperation);
}

/**
 * Current Measurement consent as seen by identity issuance/verification.
 * Functional identity in `ActorContext` remains independent of this value
 * per ADR-0015; Measurement issuance/use requires `granted`.
 */
export type MeasurementConsent = "granted" | "denied" | "unknown";

export interface PseudonymousToken {
  readonly tokenString: string;
  readonly expiresAt: string;
  readonly purpose: PseudonymousPurpose;
  readonly keyVersion: number;
}
