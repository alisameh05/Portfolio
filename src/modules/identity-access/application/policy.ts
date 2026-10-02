import type {
  ActorContext,
  Rejection,
  Result,
  StableId,
} from "@shared/domain";
import { assertNeverActor, err, ok } from "@shared/domain";
import type { Permission } from "../domain/index.js";
import { isFunctionalIdentityOperation } from "../domain/index.js";
import type { AuthProviderPort, CryptoPort } from "../ports/index.js";
import type {
  AuthorizeOperationQuery,
  IdentityAccessService,
  IssuePseudonymousTokenCommand,
  ResolveActorContextQuery,
  VerifiedPseudonymousIdentity,
  VerifyPseudonymousTokenQuery,
} from "./service.js";
import type { PseudonymousToken } from "../domain/index.js";

/**
 * policy.ts — Phase 4 #81 operation-specific actor authorization.
 *
 * Every existing Owner HTTP entrypoint requires owner-scoped access. The
 * policy reads only the closed `ActorContext` kind (plus the trusted System
 * purpose allowlist below); caller-supplied privilege claims, mutable roles,
 * and permission arrays on the actor object are never consulted, so forged
 * privileged contexts cannot escalate.
 *
 * - `admin:all` is never a bypass: requesting it is always forbidden.
 * - Visitor actors may use `read:public` only; owner-scoped operations deny
 *   them with `OWNER_REQUIRED`.
 * - System actors may use `job:execute` only for an allowlisted trusted
 *   purpose. No purpose is allowlisted in Phase 4, so job triggering stays
 *   unavailable and later-phase services remain fail closed.
 * - Reads neither mutate nor issue identity: this decision function is pure.
 */

export const OWNER_SCOPED_PERMISSION: Permission = "write:owner";

/**
 * Required permission for an Owner entrypoint operation. All thirty-nine
 * existing Owner operations are owner-scoped; the operation identifier
 * selects the permission explicitly so future operations can diverge without
 * changing call sites. Unknown operation identifiers fail closed to the
 * owner-scoped permission.
 */
export function requiredPermissionForOwnerOperation(
  _operationId: string,
): Permission {
  return OWNER_SCOPED_PERMISSION;
}

function forbidden(code: string): Rejection {
  return { kind: "forbidden", code };
}

/**
 * Pure operation authorization over the provider-neutral actor. Synchronous
 * and side-effect free: authorization never mutates state nor issues
 * identity material.
 */
export function decideAuthorization(
  query: AuthorizeOperationQuery,
): Result<boolean, Rejection> {
  if (query.requiredPermission === "admin:all") {
    return err(forbidden("ADMIN_BYPASS_DENIED"));
  }
  switch (query.actor.kind) {
    case "owner":
      if (
        query.requiredPermission === "write:owner" ||
        query.requiredPermission === "read:public"
      ) {
        return ok(true);
      }
      return err(forbidden("OPERATION_NOT_PERMITTED"));
    case "visitor":
      if (query.requiredPermission === "read:public") {
        return ok(true);
      }
      return err(forbidden("OWNER_REQUIRED"));
    case "system":
      if (query.requiredPermission === "job:execute") {
        return err(forbidden("JOB_TRIGGER_UNAVAILABLE"));
      }
      return err(forbidden("OWNER_REQUIRED"));
    default:
      return err(forbidden(assertNeverActor(query.actor)));
  }
}

export interface IdentityAccessServiceDeps {
  readonly auth: AuthProviderPort;
  readonly crypto: CryptoPort;
}

/**
 * Provider-neutral Identity and Access application service (#81 slice).
 *
 * Session resolution delegates to the injected `AuthProviderPort` (verified
 * Supabase sessions in production, deterministic fixtures in tests) and maps
 * the verified `OwnerIdentity` to the stable domain `OwnerActor`. Raw
 * session material never leaves the adapter. Authorization delegates to the
 * pure policy above on every call, so allowlist removal denies continued
 * access and replay — not just login. Pseudonymous issuance/verification
 * stays fail closed for ticket #82.
 */
export function createIdentityAccessService(
  deps: IdentityAccessServiceDeps,
): IdentityAccessService {
  return {
    async resolveActorContext(
      query: ResolveActorContextQuery,
    ): Promise<Result<ActorContext, Rejection>> {
      const verified = await deps.auth.verifyOwnerSession({
        sessionToken: query.sessionToken,
        expectedPurpose: query.expectedPurpose,
      });
      if (!verified.ok) {
        return err(verified.error);
      }
      const actor: ActorContext = {
        kind: "owner",
        ownerId: verified.value.ownerId as StableId<"Owner">,
        sessionId: verified.value.sessionId,
      };
      return ok(actor);
    },

    async authorizeOperation(
      query: AuthorizeOperationQuery,
    ): Promise<Result<boolean, Rejection>> {
      return decideAuthorization(query);
    },

    async issuePseudonymousToken(
      command: IssuePseudonymousTokenCommand,
    ): Promise<Result<PseudonymousToken, Rejection>> {
      if (
        command.purpose === "visitor_measurement" &&
        command.consent !== "granted"
      ) {
        return err({ kind: "forbidden", code: "MEASUREMENT_CONSENT_REQUIRED" });
      }
      if (
        command.purpose === "visitor_functional" &&
        !isFunctionalIdentityOperation(command.interaction)
      ) {
        return err({ kind: "forbidden", code: "FUNCTIONAL_IDENTITY_NOT_REQUIRED" });
      }
      return deps.crypto.issuePseudonymousToken(command);
    },

    async verifyPseudonymousToken(
      query: VerifyPseudonymousTokenQuery,
    ): Promise<Result<VerifiedPseudonymousIdentity, Rejection>> {
      if (
        query.expectedPurpose === "visitor_measurement" &&
        query.consent !== "granted"
      ) {
        return err({ kind: "forbidden", code: "MEASUREMENT_CONSENT_REQUIRED" });
      }
      const verified = await deps.crypto.verifyPseudonymousToken(query);
      if (!verified.ok) return err(verified.error);
      if (verified.value.purpose !== query.expectedPurpose) {
        return err({ kind: "unauthenticated", code: "WRONG_TOKEN_PURPOSE" });
      }
      if (verified.value.purpose === "visitor_functional") {
        return ok({
          purpose: "visitor_functional",
          actor: {
            kind: "visitor",
            functionalId: verified.value.subject as StableId<"FunctionalVisitor">,
            consent: query.consent,
          },
        });
      }
      return ok({
        purpose: "visitor_measurement",
        subject: verified.value.subject as StableId<"MeasurementVisitor">,
      });
    },
  };
}
