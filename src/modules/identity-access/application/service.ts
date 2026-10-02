import type {
  Result,
  Rejection,
  ActorContext,
  StableId,
} from "@shared/domain";
import type {
  Permission,
  FunctionalIdentityOperation,
  MeasurementConsent,
  PseudonymousToken,
} from "../domain/index.js";

/**
 * Provider-neutral Owner session resolution. `sessionToken` is the opaque
 * session material handed to the adapter; transport headers, cookies, JWTs,
 * and Supabase claims never cross this seam. `expectedPurpose` selects the
 * dedicated Owner verification operation; it is not a custom JWT claim.
 * `correlationId` threads safe diagnostics.
 */
export interface ResolveActorContextQuery {
  readonly sessionToken: string;
  readonly expectedPurpose: "owner_session";
  readonly correlationId?: string;
}

export interface AuthorizeOperationQuery {
  readonly actor: ActorContext;
  readonly requiredPermission: Permission;
}

/**
 * Purpose-limited Visitor signal issuance. The adapter generates the opaque
 * random subject; callers never supply it. Functional identity stays in its
 * existing `ActorContext` slot independent of Measurement consent;
 * Measurement issuance/use requires current `granted` consent.
 */
interface IssuePseudonymousTokenCommandBase {
  readonly ttlSeconds: number;
  readonly consent: MeasurementConsent;
  readonly correlationId?: string;
}

export type IssuePseudonymousTokenCommand =
  | (IssuePseudonymousTokenCommandBase & {
      readonly purpose: "visitor_functional";
      readonly interaction: FunctionalIdentityOperation;
    })
  | (IssuePseudonymousTokenCommandBase & {
      readonly purpose: "visitor_measurement";
    });

interface VerifyPseudonymousTokenQueryBase {
  readonly tokenString: string;
  /** Current consent is rechecked when a Measurement token is used. */
  readonly consent: MeasurementConsent;
}

export type VerifyPseudonymousTokenQuery =
  | (VerifyPseudonymousTokenQueryBase & {
      readonly expectedPurpose: "visitor_functional";
      readonly interaction: FunctionalIdentityOperation;
    })
  | (VerifyPseudonymousTokenQueryBase & {
      readonly expectedPurpose: "visitor_measurement";
    });

export type VerifiedPseudonymousIdentity =
  | {
      readonly purpose: "visitor_functional";
      /** The interaction orchestration builds a Visitor ActorContext only after Project authorization. */
      readonly subject: StableId<"FunctionalVisitor">;
    }
  | {
      readonly purpose: "visitor_measurement";
      readonly subject: StableId<"MeasurementVisitor">;
    };

export interface IdentityAccessService {
  resolveActorContext(
    query: ResolveActorContextQuery,
  ): Promise<Result<ActorContext, Rejection>>;

  authorizeOperation(
    query: AuthorizeOperationQuery,
  ): Promise<Result<boolean, Rejection>>;

  issuePseudonymousToken(
    command: IssuePseudonymousTokenCommand,
  ): Promise<Result<PseudonymousToken, Rejection>>;

  verifyPseudonymousToken(
    query: VerifyPseudonymousTokenQuery,
  ): Promise<Result<VerifiedPseudonymousIdentity, Rejection>>;
}
