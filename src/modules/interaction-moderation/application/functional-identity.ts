import type { Result, Rejection, StableId, VisitorActor } from "@shared/domain";
import type {
  FunctionalIdentityOperation,
  IdentityAccessService,
  PseudonymousToken,
} from "../../identity-access/index.js";

/** Project eligibility stays in Interaction and Moderation, which owns the
 * reaction/rating use case. Identity and Access remains provider focused. */
export interface FunctionalInteractionAuthorizationPort {
  authorize(input: {
    readonly actor: VisitorActor;
    readonly projectId: StableId<"Project">;
    readonly interaction: FunctionalIdentityOperation;
  }): Promise<Result<boolean, Rejection>>;
}

export interface FunctionalIdentityOrchestrationDeps {
  readonly identityAccess: Pick<IdentityAccessService, "issuePseudonymousToken" | "verifyPseudonymousToken">;
  readonly authorization: FunctionalInteractionAuthorizationPort;
}

function denied(): Result<never, Rejection> {
  return { ok: false, error: { kind: "forbidden", code: "FUNCTIONAL_INTERACTION_NOT_PERMITTED" } };
}

/** Issue a functional token only after the owning interaction policy permits it. */
export async function issueFunctionalIdentityForInteraction(
  deps: FunctionalIdentityOrchestrationDeps,
  input: {
    readonly actor: VisitorActor;
    readonly projectId: StableId<"Project">;
    readonly interaction: FunctionalIdentityOperation;
    readonly ttlSeconds: number;
  },
): Promise<Result<PseudonymousToken, Rejection>> {
  const permitted = await deps.authorization.authorize(input);
  if (!permitted.ok) return { ok: false, error: permitted.error };
  if (!permitted.value) return denied();
  return deps.identityAccess.issuePseudonymousToken({
    purpose: "visitor_functional",
    interaction: input.interaction,
    ttlSeconds: input.ttlSeconds,
    consent: input.actor.consent,
  });
}

/** Verify and expose a functional actor only after current interaction policy permits use. */
export async function verifyFunctionalIdentityForInteraction(
  deps: FunctionalIdentityOrchestrationDeps,
  input: {
    readonly tokenString: string;
    readonly projectId: StableId<"Project">;
    readonly interaction: FunctionalIdentityOperation;
    readonly consent: VisitorActor["consent"];
  },
): Promise<Result<VisitorActor, Rejection>> {
  const verified = await deps.identityAccess.verifyPseudonymousToken({
    tokenString: input.tokenString,
    expectedPurpose: "visitor_functional",
    interaction: input.interaction,
    consent: input.consent,
  });
  if (!verified.ok) return { ok: false, error: verified.error };
  if (verified.value.purpose !== "visitor_functional") {
    return { ok: false, error: { kind: "unauthenticated", code: "WRONG_TOKEN_PURPOSE" } };
  }
  const actor: VisitorActor = {
    kind: "visitor",
    functionalId: verified.value.subject,
    consent: input.consent,
  };
  const permitted = await deps.authorization.authorize({
    actor,
    projectId: input.projectId,
    interaction: input.interaction,
  });
  if (!permitted.ok) return { ok: false, error: permitted.error };
  if (!permitted.value) return denied();
  return { ok: true, value: actor };
}
