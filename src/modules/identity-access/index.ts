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
  PseudonymousToken,
} from "./domain/index.js";

export type {
  ResolveActorContextQuery,
  AuthorizeOperationQuery,
  IssuePseudonymousTokenCommand,
  VerifyPseudonymousTokenQuery,
  IdentityAccessService,
} from "./application/index.js";

export type {
  AuthProviderPort,
  CryptoPort,
} from "./ports/index.js";
