import { describe, expect, it } from "vitest";
import { err } from "../../src/shared/domain/index.js";
import type { AuthProviderPort } from "../../src/modules/identity-access/ports/index.js";
import {
  createIdentityAccessService,
} from "../../src/modules/identity-access/application/policy.js";
import {
  createPseudonymousIdentityConfig,
  AesGcmPseudonymousTokenAdapter,
  PseudonymousIdentityConfigError,
} from "../../src/modules/identity-access/adapters/index.js";
import type { PseudonymousConfigEnv } from "../../src/modules/identity-access/adapters/index.js";

const key = (fill: number) => Buffer.alloc(32, fill).toString("base64url");

function config(overrides: Record<string, string> = {}) {
  return createPseudonymousIdentityConfig({
    FUNCTIONAL_ID_HASH_KEY: key(1),
    FUNCTIONAL_ID_HASH_KEY_VERSION: "1",
    MEASUREMENT_ID_HASH_KEY: key(2),
    MEASUREMENT_ID_HASH_KEY_VERSION: "1",
    ...overrides,
  });
}

function adapter(
  identityConfig = config(),
  now: () => number = () => 1_800_000_000,
  onRandom: () => void = () => undefined,
) {
  let randomCounter = 0;
  return new AesGcmPseudonymousTokenAdapter({
    config: identityConfig,
    nowSeconds: now,
    randomBytes(size) {
      randomCounter += 1;
      onRandom();
      return Uint8Array.from({ length: size }, (_, index) => (randomCounter * 41 + index) & 0xff);
    },
  });
}

const auth: AuthProviderPort = {
  async verifyOwnerSession() {
    return err({ kind: "unauthenticated", code: "SESSION_NOT_FOUND" });
  },
  async getOwnerAllowlist() {
    return err({ kind: "temporarily_unavailable", code: "AUTH_PROVIDER_UNAVAILABLE" });
  },
};

function service(crypto: AesGcmPseudonymousTokenAdapter) {
  return createIdentityAccessService({ auth, crypto });
}

function functionalCommand(
  consent: "granted" | "denied" | "unknown",
  interaction: "reaction" | "rating" = "reaction",
) {
  return {
    purpose: "visitor_functional" as const,
    interaction,
    ttlSeconds: 3600,
    consent,
  };
}

describe("purpose-separated Visitor identities (#82)", () => {
  it("issues independent random functional and Measurement identities behind the application interface", async () => {
    const crypto = adapter();
    const identities = service(crypto);
    const functional = await identities.issuePseudonymousToken({
      ...functionalCommand("denied", "rating"),
    });
    const measurement = await identities.issuePseudonymousToken({
      purpose: "visitor_measurement", ttlSeconds: 3600, consent: "granted",
    });
    expect(functional.ok).toBe(true);
    expect(measurement.ok).toBe(true);
    if (!functional.ok || !measurement.ok) return;
    const functionalSubject = await identities.verifyPseudonymousToken({
      tokenString: functional.value.tokenString,
      expectedPurpose: "visitor_functional",
      interaction: "rating",
      consent: "denied",
    });
    const measurementSubject = await identities.verifyPseudonymousToken({
      tokenString: measurement.value.tokenString,
      expectedPurpose: "visitor_measurement",
      consent: "granted",
    });
    expect(functionalSubject.ok && measurementSubject.ok).toBe(true);
    if (
      functionalSubject.ok && measurementSubject.ok &&
      functionalSubject.value.purpose === "visitor_functional" &&
      measurementSubject.value.purpose === "visitor_measurement"
    ) {
      expect(functionalSubject.value.purpose).toBe("visitor_functional");
      expect(functionalSubject.value.subject).toBeDefined();
      expect(measurementSubject.value.purpose).toBe("visitor_measurement");
      expect(functionalSubject.value.subject).not.toBe(measurementSubject.value.subject);
      expect("actor" in functionalSubject.value).toBe(false);
      expect("actor" in measurementSubject.value).toBe(false);
    }
    expect(functional.value.tokenString).not.toContain("visitor_functional");
    expect(measurement.value.tokenString).not.toContain("visitor_measurement");
  });

  it("lets functional identity work with denied or unknown consent, while reads issue none", async () => {
    let randomCalls = 0;
    const crypto = adapter(config(), undefined, () => { randomCalls += 1; });
    const identities = service(crypto);
    const read = await identities.authorizeOperation({
      actor: { kind: "visitor", consent: "unknown" },
      requiredPermission: "read:public",
    });
    expect(read.ok).toBe(true);
    expect(randomCalls).toBe(0);
    for (const consent of ["denied", "unknown"] as const) {
      const issued = await identities.issuePseudonymousToken({
        ...functionalCommand(consent), ttlSeconds: 60,
      });
      expect(issued.ok).toBe(true);
    }
    expect(randomCalls).toBe(4);
    const invalidIntent = await identities.issuePseudonymousToken({
      ...functionalCommand("unknown"), interaction: "browse", ttlSeconds: 60,
    } as never);
    expect(invalidIntent).toMatchObject({ ok: false, error: { code: "FUNCTIONAL_IDENTITY_NOT_REQUIRED" } });
    expect(randomCalls).toBe(4);
  });

  it("rejects invalid functional operations at runtime during verification", async () => {
    const crypto = adapter();
    const identities = service(crypto);
    const issued = await crypto.issuePseudonymousToken({
      purpose: "visitor_functional", interaction: "reaction", ttlSeconds: 60, consent: "unknown",
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    await expect(identities.verifyPseudonymousToken({
      tokenString: issued.value.tokenString,
      expectedPurpose: "visitor_functional",
      interaction: "browse",
      consent: "unknown",
    } as never)).resolves.toMatchObject({
      ok: false,
      error: { code: "FUNCTIONAL_IDENTITY_NOT_REQUIRED" },
    });
  });

  it("rejects Measurement issuance and use after denial, unknown consent, or withdrawal", async () => {
    const crypto = adapter();
    const identities = service(crypto);
    const issued = await identities.issuePseudonymousToken({
      purpose: "visitor_measurement", ttlSeconds: 3600, consent: "granted",
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    // A change from granted to denied models withdrawal; an unexpired token is unusable.
    for (const consent of ["denied", "unknown"] as const) {
      const result = await identities.verifyPseudonymousToken({
        tokenString: issued.value.tokenString,
        expectedPurpose: "visitor_measurement",
        consent,
      });
      expect(result).toMatchObject({ ok: false, error: { kind: "forbidden", code: "MEASUREMENT_CONSENT_REQUIRED" } });
    }
    await expect(crypto.issuePseudonymousToken({
      purpose: "visitor_measurement", ttlSeconds: 3600, consent: "unknown",
    })).resolves.toMatchObject({ ok: false });
    await expect(identities.issuePseudonymousToken({
      purpose: "visitor_measurement", ttlSeconds: 3600, consent: "denied",
    })).resolves.toMatchObject({ ok: false, error: { code: "MEASUREMENT_CONSENT_REQUIRED" } });
    await expect(identities.issuePseudonymousToken({
      purpose: "visitor_measurement", ttlSeconds: 3600, consent: "unknown",
    })).resolves.toMatchObject({ ok: false, error: { code: "MEASUREMENT_CONSENT_REQUIRED" } });
    await expect(crypto.verifyPseudonymousToken({
      tokenString: issued.value.tokenString,
      expectedPurpose: "visitor_measurement",
      consent: "denied",
    })).resolves.toMatchObject({ ok: false });
  });

  it("rejects altered, expired, unknown-key, and wrong-purpose tokens", async () => {
    let now = 1_800_000_000;
    const crypto = adapter(config(), () => now);
    const issued = await crypto.issuePseudonymousToken({
      purpose: "visitor_functional", interaction: "rating", ttlSeconds: 60, consent: "unknown",
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const parts = issued.value.tokenString.split(".");
    const tampered = [...parts];
    tampered[3] = `${tampered[3]?.slice(0, -1)}${tampered[3]?.endsWith("A") ? "B" : "A"}`;
    const invalids = [tampered.join("."), issued.value.tokenString];
    for (const [index, tokenString] of invalids.entries()) {
      const result = await crypto.verifyPseudonymousToken({
        tokenString,
        expectedPurpose: index === 0 ? "visitor_functional" : "visitor_measurement",
        consent: "granted",
      });
      expect(result.ok).toBe(false);
    }
    now += 61;
    await expect(crypto.verifyPseudonymousToken({
      tokenString: issued.value.tokenString,
      expectedPurpose: "visitor_functional",
      consent: "unknown",
    })).resolves.toMatchObject({ ok: false, error: { kind: "unauthenticated" } });
    const rotated = adapter(config({
      FUNCTIONAL_ID_HASH_KEY: key(3),
      FUNCTIONAL_ID_HASH_KEY_VERSION: "2",
    }), () => now - 61);
    await expect(rotated.verifyPseudonymousToken({
      tokenString: issued.value.tokenString,
      expectedPurpose: "visitor_functional",
      consent: "unknown",
    })).resolves.toMatchObject({ ok: false, error: { code: "UNKNOWN_TOKEN_KEY" } });
  });

  it("accepts previous keys during bounded rotation and retires them cleanly", async () => {
    for (const purpose of ["visitor_functional", "visitor_measurement"] as const) {
      const oldConfig = purpose === "visitor_functional"
        ? config()
        : config({ MEASUREMENT_ID_HASH_KEY: key(4) });
      const oldAdapter = adapter(oldConfig);
      const issued = await oldAdapter.issuePseudonymousToken(
        purpose === "visitor_functional"
          ? { purpose, interaction: "reaction", ttlSeconds: 120, consent: "granted" }
          : { purpose, ttlSeconds: 120, consent: "granted" },
      );
      expect(issued.ok).toBe(true);
      if (!issued.ok) continue;
      const newConfig = purpose === "visitor_functional"
        ? config({ FUNCTIONAL_ID_HASH_KEY: key(3), FUNCTIONAL_ID_HASH_KEY_VERSION: "2", FUNCTIONAL_ID_HASH_PREVIOUS_KEYS: `1:${key(1)}` })
        : config({ MEASUREMENT_ID_HASH_KEY: key(5), MEASUREMENT_ID_HASH_KEY_VERSION: "2", MEASUREMENT_ID_HASH_PREVIOUS_KEYS: `1:${key(4)}` });
      const duringRotation = adapter(newConfig);
      await expect(duringRotation.verifyPseudonymousToken({
        tokenString: issued.value.tokenString, expectedPurpose: purpose, consent: "granted",
      })).resolves.toMatchObject({ ok: true });
      const retiredConfig = purpose === "visitor_functional"
        ? config({ FUNCTIONAL_ID_HASH_KEY: key(3), FUNCTIONAL_ID_HASH_KEY_VERSION: "2" })
        : config({ MEASUREMENT_ID_HASH_KEY: key(5), MEASUREMENT_ID_HASH_KEY_VERSION: "2" });
      await expect(adapter(retiredConfig).verifyPseudonymousToken({
        tokenString: issued.value.tokenString, expectedPurpose: purpose, consent: "granted",
      })).resolves.toMatchObject({ ok: false, error: { code: "UNKNOWN_TOKEN_KEY" } });
    }
  });

  it("rejects reused secrets and malformed rotation config without exposing key values", () => {
    const secret = key(9);
    expect(() => config({ MEASUREMENT_ID_HASH_KEY: secret, FUNCTIONAL_ID_HASH_KEY: secret }))
      .toThrow(PseudonymousIdentityConfigError);
    const env: PseudonymousConfigEnv = {
      FUNCTIONAL_ID_HASH_KEY: secret,
      FUNCTIONAL_ID_HASH_KEY_VERSION: "2",
      FUNCTIONAL_ID_HASH_PREVIOUS_KEYS: `1:${secret}`,
      MEASUREMENT_ID_HASH_KEY: key(10),
      MEASUREMENT_ID_HASH_KEY_VERSION: "1",
    };
    try {
      createPseudonymousIdentityConfig(env);
      throw new Error("expected invalid reused key to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PseudonymousIdentityConfigError);
      expect((error as Error).message).not.toContain(secret);
    }
    expect(() => config({ FUNCTIONAL_ID_HASH_KEY: "too-short" })).toThrow(PseudonymousIdentityConfigError);
  });

  it("bounds lifetimes and returns no provider metadata with a verified signal", async () => {
    const crypto = adapter();
    const identities = service(crypto);
    await expect(identities.issuePseudonymousToken({
      ...functionalCommand("granted"), ttlSeconds: 30 * 24 * 60 * 60 + 1,
    })).resolves.toMatchObject({ ok: false, error: { kind: "validation" } });
    const issued = await identities.issuePseudonymousToken({
      purpose: "visitor_measurement", ttlSeconds: 60, consent: "granted",
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const verified = await identities.verifyPseudonymousToken({
      tokenString: issued.value.tokenString,
      expectedPurpose: "visitor_measurement",
      consent: "granted",
    });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(Object.keys(verified.value).sort()).toEqual(["purpose", "subject"]);
      expect(JSON.stringify(verified)).not.toMatch(/email|ip|github|supabase|crosswalk/i);
    }
  });
});
