import type { ApplicationRequestContext } from "@shared/application";
import type { Result, Rejection, StableId, VisitorActor } from "@shared/domain";
import type { TransactionRunner } from "../../../runtime/ports.js";
import type { ProjectInteractionEligibilityPort } from "../../content-publishing/index.js";
import type { FunctionalIdentityOperation, IdentityAccessService, PseudonymousToken } from "../../identity-access/index.js";

export interface FunctionalInteractionContextPort {
  prepare(input: ApplicationRequestContext & { readonly projectId: StableId<"Project">; readonly interaction: FunctionalIdentityOperation;
    readonly consent: VisitorActor["consent"]; readonly tokenString?: string }): Promise<Result<{ readonly actor: VisitorActor; readonly issued?: PseudonymousToken }, Rejection>>;
}
/** Preflight authorizes before crypto issuance or exposing a verified actor.
 * The mutation independently locks/rechecks Content before any committed effect. */
export function createFunctionalInteractionContext(deps: {
  readonly portfolioId: StableId<"Portfolio">;
  readonly transactions: TransactionRunner;
  readonly content: ProjectInteractionEligibilityPort;
  readonly identity: Pick<IdentityAccessService, "issuePseudonymousToken" | "verifyPseudonymousToken">;
}): FunctionalInteractionContextPort {
  return {
    async prepare(input) {
      if (input.scope.kind !== "portfolio" || input.scope.portfolioId !== deps.portfolioId ||
        (input.interaction !== "reaction" && input.interaction !== "rating")) return { ok: false, error: { kind: "forbidden", code: "FUNCTIONAL_INTERACTION_NOT_PERMITTED" } };
      try {
        const authorized = await deps.transactions.run(async tx => {
          const facts = await deps.content.getProjectInteractionFacts({ portfolioId: deps.portfolioId, projectId: input.projectId }, tx);
          return facts.ok && facts.value.projectId === input.projectId && facts.value.portfolioId === deps.portfolioId &&
            facts.value.lifecycle === "published" && facts.value.publishedLocales.length > 0;
        });
        if (!authorized) return { ok: false, error: { kind: "not_found", code: "PROJECT_UNAVAILABLE" } };
        let issued: PseudonymousToken | undefined;
        if (input.tokenString === undefined) {
          const result = await deps.identity.issuePseudonymousToken({ purpose: "visitor_functional", interaction: input.interaction,
            consent: input.consent, ttlSeconds: 30 * 86400 });
          if (!result.ok) return result;
          issued = result.value;
        }
        const verified = await deps.identity.verifyPseudonymousToken({ expectedPurpose: "visitor_functional", interaction: input.interaction,
          tokenString: input.tokenString ?? issued!.tokenString, consent: input.consent });
        // Public functional operation declares 403, not Owner-session 401.
        if (!verified.ok) return { ok: false, error: verified.error.kind === "unauthenticated"
          ? { kind: "forbidden", code: "INVALID_FUNCTIONAL_TOKEN" } : verified.error };
        if (verified.value.purpose !== "visitor_functional") return { ok: false, error: { kind: "forbidden", code: "WRONG_TOKEN_PURPOSE" } };
        return { ok: true, value: { actor: { kind: "visitor", consent: input.consent, functionalId: verified.value.subject },
          ...(issued === undefined ? {} : { issued }) } };
      } catch { return { ok: false, error: { kind: "temporarily_unavailable", code: "FUNCTIONAL_IDENTITY_UNAVAILABLE" } }; }
    },
  };
}
