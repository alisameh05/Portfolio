import type { Result, Rejection, ActorContext } from "@shared/domain";
import type {
  Permission,
  PseudonymousToken,
} from "../domain/index.js";

export interface ResolveActorContextQuery {
  readonly authorizationHeader?: string;
  readonly clientToken?: string;
}

export interface AuthorizeOperationQuery {
  readonly actor: ActorContext;
  readonly requiredPermission: Permission;
}

export interface IssuePseudonymousTokenCommand {
  readonly actor: ActorContext;
  readonly subject: string;
  readonly purpose: "visitor_functional" | "visitor_measurement";
  readonly ttlSeconds: number;
}

export interface VerifyPseudonymousTokenQuery {
  readonly tokenString: string;
}

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
  ): Promise<Result<{ subject: string; purpose: string }, Rejection>>;
}
