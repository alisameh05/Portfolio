export type {
  ResolveActorContextQuery,
  AuthorizeOperationQuery,
  IssuePseudonymousTokenCommand,
  VerifyPseudonymousTokenQuery,
  VerifiedPseudonymousIdentity,
  IdentityAccessService,
} from "./service.js";
export {
  OWNER_SCOPED_PERMISSION,
  createIdentityAccessService,
  decideAuthorization,
  requiredPermissionForOwnerOperation,
} from "./policy.js";
export type { IdentityAccessServiceDeps } from "./policy.js";
