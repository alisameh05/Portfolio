/**
 * identity-access module public interface.
 *
 * This barrel is the single public import surface for the Identity and Access module.
 * Other modules must never deep-import internal paths.
 */

export type {
  Role,
  Permission,
  OwnerIdentity,
  PseudonymousPurpose,
  FunctionalIdentityOperation,
  MeasurementConsent,
  PseudonymousToken,
} from "./domain/index.js";
export { FUNCTIONAL_IDENTITY_OPERATIONS, isFunctionalIdentityOperation } from "./domain/index.js";

export type {
  ResolveActorContextQuery,
  AuthorizeOperationQuery,
  IssuePseudonymousTokenCommand,
  VerifyPseudonymousTokenQuery,
  VerifiedPseudonymousIdentity,
  IdentityAccessService,
} from "./application/index.js";
export {
  OWNER_SCOPED_PERMISSION,
  createIdentityAccessService,
  decideAuthorization,
  requiredPermissionForOwnerOperation,
} from "./application/index.js";
export type { IdentityAccessServiceDeps } from "./application/index.js";

export type {
  VerifyOwnerSessionInput,
  IssuePseudonymousTokenInput,
  VerifyPseudonymousTokenInput,
  VerifiedPseudonymousToken,
  AuthProviderPort,
  CryptoPort,
  OwnerRateLimitCheck,
} from "./ports/index.js";

export type { ConsentEvidencePayload, ConsentEvidenceCryptoPort } from "./ports/consent.js";
