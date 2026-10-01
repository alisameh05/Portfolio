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
