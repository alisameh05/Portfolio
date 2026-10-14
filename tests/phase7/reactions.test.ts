import { describe, expect, it } from "vitest";
import { createReactionApplicationService } from "../../src/modules/interaction-moderation/application/reactions.js";
import { createStableId } from "../../src/shared/domain/index.js";
import { createFunctionalPseudonymousIdentityConfig, AesGcmPseudonymousTokenAdapter } from "../../src/modules/identity-access/adapters/index.js";

describe("Reaction application boundary", () => {
  it("rejects unconfigured scope before any identity or persistence effect", async () => {
    const service = createReactionApplicationService({} as never);
    expect(await service.submitReaction({ scope: { kind: "unconfigured" }, correlationId: "test",
      actor: { kind: "visitor", consent: "unknown" }, projectId: createStableId("Project"),
      kind: "like", idempotencyKey: "reaction-test-key" as never })).toMatchObject({ ok: false });
  });
  it("functional-only crypto refuses Measurement issuance/use and rejects configured cross-purpose key reuse", async () => {
    const secret = Buffer.alloc(32, 17).toString("base64url");
    const env = { FUNCTIONAL_ID_HASH_KEY: secret, FUNCTIONAL_ID_HASH_KEY_VERSION: "1" };
    const crypto = new AesGcmPseudonymousTokenAdapter({ config: createFunctionalPseudonymousIdentityConfig(env), nowSeconds: () => 1791979200 });
    const issued = await crypto.issuePseudonymousToken({ purpose: "visitor_functional", interaction: "reaction", consent: "denied", ttlSeconds: 3600 });
    expect(issued.ok).toBe(true); if (!issued.ok) throw new Error("issuance");
    expect((await crypto.verifyPseudonymousToken({ expectedPurpose: "visitor_functional", tokenString: issued.value.tokenString, consent: "unknown" })).ok).toBe(true);
    expect((await crypto.issuePseudonymousToken({ purpose: "visitor_measurement", consent: "granted", ttlSeconds: 3600 })).ok).toBe(false);
    expect((await crypto.verifyPseudonymousToken({ expectedPurpose: "visitor_measurement", tokenString: issued.value.tokenString, consent: "granted" })).ok).toBe(false);
    expect(() => createFunctionalPseudonymousIdentityConfig({ ...env, MEASUREMENT_ID_HASH_KEY: secret })).toThrow("distinct purpose-specific secrets");
    expect(() => createFunctionalPseudonymousIdentityConfig({ ...env, MEASUREMENT_ID_HASH_PREVIOUS_KEYS: "1:" + secret })).toThrow("distinct purpose-specific secrets");
  });
});
