import { describe, expect, it } from "vitest";
import { err, ok } from "../../src/shared/domain/index.js";
import type { IdentityAccessService } from "../../src/modules/identity-access/index.js";
import {
  issueFunctionalIdentityForInteraction,
  verifyFunctionalIdentityForInteraction,
} from "../../src/modules/interaction-moderation/index.js";

const projectId = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0" as never;
const visitor = { kind: "visitor", consent: "denied" } as const;

describe("functional identity interaction orchestration (#82)", () => {
  it("does not issue or expose functional identity when Project interaction authorization denies", async () => {
    let issueCalls = 0;
    const identityAccess = {
      async issuePseudonymousToken() {
        issueCalls += 1;
        return ok({ tokenString: "opaque", expiresAt: "2030-01-01T00:00:00.000Z", purpose: "visitor_functional", keyVersion: 1 });
      },
      async verifyPseudonymousToken() {
        return ok({ purpose: "visitor_functional", subject: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0" as never });
      },
    } satisfies Pick<IdentityAccessService, "issuePseudonymousToken" | "verifyPseudonymousToken">;
    const authorization = { async authorize() { return ok(false); } };
    const deps = { identityAccess, authorization };

    await expect(issueFunctionalIdentityForInteraction(deps, {
      actor: visitor, projectId, interaction: "reaction", ttlSeconds: 60,
    })).resolves.toMatchObject({ ok: false, error: { code: "FUNCTIONAL_INTERACTION_NOT_PERMITTED" } });
    expect(issueCalls).toBe(0);

    await expect(verifyFunctionalIdentityForInteraction(deps, {
      tokenString: "opaque", projectId, interaction: "reaction", consent: "denied",
    })).resolves.toMatchObject({ ok: false, error: { code: "FUNCTIONAL_INTERACTION_NOT_PERMITTED" } });
  });

  it("stops before issuance when the Project authorization dependency fails", async () => {
    let issueCalls = 0;
    const identityAccess = {
      async issuePseudonymousToken() {
        issueCalls += 1;
        return err({ kind: "temporarily_unavailable", code: "CRYPTO_UNAVAILABLE" });
      },
      async verifyPseudonymousToken() {
        return err({ kind: "unauthenticated", code: "INVALID_TOKEN" });
      },
    } satisfies Pick<IdentityAccessService, "issuePseudonymousToken" | "verifyPseudonymousToken">;
    const deps = {
      identityAccess,
      authorization: { async authorize() { return err({ kind: "temporarily_unavailable", code: "PROJECT_POLICY_UNAVAILABLE" }); } },
    };

    await expect(issueFunctionalIdentityForInteraction(deps, {
      actor: visitor, projectId, interaction: "rating", ttlSeconds: 60,
    })).resolves.toMatchObject({ ok: false, error: { code: "PROJECT_POLICY_UNAVAILABLE" } });
    expect(issueCalls).toBe(0);
  });

  it("returns the Visitor actor only after current Project interaction authorization succeeds", async () => {
    const identityAccess = {
      async issuePseudonymousToken() {
        return ok({ tokenString: "opaque", expiresAt: "2030-01-01T00:00:00.000Z", purpose: "visitor_functional", keyVersion: 1 });
      },
      async verifyPseudonymousToken() {
        return ok({ purpose: "visitor_functional", subject: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0" as never });
      },
    } satisfies Pick<IdentityAccessService, "issuePseudonymousToken" | "verifyPseudonymousToken">;
    const deps = {
      identityAccess,
      authorization: { async authorize() { return ok(true); } },
    };
    await expect(verifyFunctionalIdentityForInteraction(deps, {
      tokenString: "opaque", projectId, interaction: "rating", consent: "unknown",
    })).resolves.toMatchObject({
      ok: true,
      value: { kind: "visitor", consent: "unknown", functionalId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0" },
    });
  });
});
