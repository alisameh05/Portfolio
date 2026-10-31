/**
 * owner-session-auth.test.ts — Phase 4 #80
 *
 * Pre-agreed seam: the verified Owner session adapter observed through the
 * provider-neutral AuthProviderPort, with deterministic HMAC fixtures and
 * injected trusted provider-identity/revocation lookups. No live GitHub
 * exchange, production secret, remote Auth, or database required.
 *
 * Acceptance (issue #80):
 * - Verify HS256/ES256 signature, allowed algorithm/key, issuer, audience,
 *   expiry, and standard sub/session_id claims plus trusted GitHub provider identity
 *   before constructing the stable Owner actor.
 * - OWNER_GITHUB_SUBJECTS matches immutable subjects from trusted records;
 *   spoofed username/email/metadata, caller Owner IDs, non-GitHub, and
 *   non-Owners are rejected.
 * - Missing/invalid sessions are unauthenticated (401 semantics), verified
 *   non-Owners are forbidden (403), provider timeout/outage is
 *   temporarily_unavailable (503).
 * - Allowlist removal denies continued access; revocation/expiry is enforced
 *   even for otherwise valid JWTs; results stay provider-neutral with no
 *   secret leakage.
 */

import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { err, ok, type ActorContext } from "../../src/shared/domain/index.js";
import { decideAuthorization } from "../../src/modules/identity-access/application/policy.js";
import { guardOwnerRequest } from "../../src/runtime/http/owner-security.js";
import { createTestLogger } from "../../src/runtime/ports.js";

import {
  SupabaseOwnerSessionAdapter,
  type OwnerSessionAdapterDeps,
} from "../../src/modules/identity-access/adapters/supabase-auth.js";
import { createOwnerAuthConfig } from "../../src/modules/identity-access/adapters/auth-config.js";

const ISSUER = "http://127.0.0.1:54321/auth/v1";
const AUDIENCE = "shipwithali-portfolio";
const KID = "test-key-1";
const SECRET = "test-hmac-secret-with-at-least-32-bytes!!";
const OWNER_SUBJECT = "github-subject-immutable-001";
const STABLE_OWNER_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0";
const FIXED_NOW = 1_769_000_000;

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function mintToken(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  secret = SECRET,
): string {
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: OWNER_SUBJECT,
    session_id: "session-opaque-001",
    iss: ISSUER,
    aud: AUDIENCE,
    exp: FIXED_NOW + 600,
    iat: FIXED_NOW - 60,
    provider: "github",
    ...overrides,
  };
}

function validHeader(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { alg: "HS256", kid: KID, typ: "JWT", ...overrides };
}

function depsWith(overrides: Partial<OwnerSessionAdapterDeps> = {}): OwnerSessionAdapterDeps {
  return {
    issuer: ISSUER,
    audience: AUDIENCE,
    allowedAlgorithms: ["HS256"],
    signingKeys: new Map([[KID, SECRET]]),
    ownerAllowlist: [OWNER_SUBJECT],
    stableOwnerId: STABLE_OWNER_ID,
    nowSeconds: () => FIXED_NOW,
    resolveProviderIdentity: async (subject: string) =>
      subject === OWNER_SUBJECT ? { provider: "github", subject } : null,
    isSessionRevoked: async () => false,
    ...overrides,
  };
}

describe("verified GitHub Owner sessions (#80)", () => {
  it("resolves a valid Owner session to a stable provider-neutral actor", async () => {
    const adapter = new SupabaseOwnerSessionAdapter(depsWith());
    const token = mintToken(validHeader(), validPayload());
    const result = await adapter.verifyOwnerSession({
      sessionToken: token,
      expectedPurpose: "owner_session",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.githubSubject).toBe(OWNER_SUBJECT);
    expect(result.value.ownerId).toBe(STABLE_OWNER_ID);
    expect(result.value.sessionId).toBe("session-opaque-001");
    // Provider-neutral: no JWT/Supabase shapes leak into the identity.
    expect(JSON.stringify(result.value)).not.toMatch(/supabase|jwt|cookie|token/i);
  });

  it("rejects forged signatures as unauthenticated", async () => {
    const adapter = new SupabaseOwnerSessionAdapter(depsWith());
    const token = mintToken(validHeader(), validPayload(), "wrong-secret-value-00000000000000");
    const result = await adapter.verifyOwnerSession({
      sessionToken: token,
      expectedPurpose: "owner_session",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unauthenticated");
  });

  it("rejects disallowed algorithms and unknown keys as unauthenticated", async () => {
    const adapter = new SupabaseOwnerSessionAdapter(depsWith());
    const noneAlg = mintToken({ alg: "none", kid: KID }, validPayload());
    const noneResult = await adapter.verifyOwnerSession({
      sessionToken: noneAlg,
      expectedPurpose: "owner_session",
    });
    expect(noneResult.ok).toBe(false);
    if (!noneResult.ok) expect(noneResult.error.kind).toBe("unauthenticated");

    const unknownKid = mintToken({ alg: "HS256", kid: "unknown" }, validPayload());
    const kidResult = await adapter.verifyOwnerSession({
      sessionToken: unknownKid,
      expectedPurpose: "owner_session",
    });
    expect(kidResult.ok).toBe(false);
    if (!kidResult.ok) expect(kidResult.error.kind).toBe("unauthenticated");
  });

  it("rejects wrong issuer, audience, expired, and malformed sessions as unauthenticated", async () => {
    const adapter = new SupabaseOwnerSessionAdapter(depsWith());
    for (const payload of [
      validPayload({ iss: "https://evil.example/issuer" }),
      validPayload({ aud: "wrong-audience" }),
      validPayload({ exp: FIXED_NOW - 10 }),
      validPayload({ sub: undefined, session_id: undefined }),
      validPayload({ session_id: undefined, sid: "bespoke-session" }),
    ]) {
      const token = mintToken(validHeader(), JSON.parse(JSON.stringify(payload)));
      const result = await adapter.verifyOwnerSession({
        sessionToken: token,
        expectedPurpose: "owner_session",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe("unauthenticated");
    }
    const malformed = await adapter.verifyOwnerSession({
      sessionToken: "not-a-jwt",
      expectedPurpose: "owner_session",
    });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.kind).toBe("unauthenticated");
  });

  it("rejects non-object JWT segments without throwing", async () => {
    const adapter = new SupabaseOwnerSessionAdapter(depsWith());
    for (const value of [null, [], "string", 42]) {
      for (const segment of ["header", "payload"]) {
        const header = base64url(JSON.stringify(segment === "header" ? value : validHeader()));
        const payload = base64url(JSON.stringify(segment === "payload" ? value : validPayload()));
        const result = await adapter.verifyOwnerSession({ sessionToken: `${header}.${payload}.signature`, expectedPurpose: "owner_session" });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.code).toBe("SESSION_MALFORMED");
      }
    }
  });

  it("verifies ES256 and rejects public-key HMAC confusion and wrong curves", async () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const publicKey = pair.publicKey.export({ format: "pem", type: "spki" }).toString();
    const encoded = `${base64url(JSON.stringify(validHeader({ alg: "ES256" })))}.${base64url(JSON.stringify(validPayload()))}`;
    const token = `${encoded}.${sign("sha256", Buffer.from(encoded), { key: pair.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    const adapter = new SupabaseOwnerSessionAdapter(depsWith({ allowedAlgorithms: ["HS256", "ES256"], signingKeys: new Map([[KID, publicKey]]) }));
    expect((await adapter.verifyOwnerSession({ sessionToken: token, expectedPurpose: "owner_session" })).ok).toBe(true);
    expect((await adapter.verifyOwnerSession({ sessionToken: mintToken(validHeader(), validPayload(), publicKey), expectedPurpose: "owner_session" })).ok).toBe(false);
    const wrong = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    const wrongToken = `${encoded}.${sign("sha256", Buffer.from(encoded), { key: wrong.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
    const wrongAdapter = new SupabaseOwnerSessionAdapter(depsWith({ allowedAlgorithms: ["ES256"], signingKeys: new Map([[KID, wrong.publicKey.export({ format: "pem", type: "spki" }).toString()]]) }));
    expect((await wrongAdapter.verifyOwnerSession({ sessionToken: wrongToken, expectedPurpose: "owner_session" })).ok).toBe(false);
  });

  it("ignores spoofed username/email/metadata and caller Owner IDs", async () => {
    const adapter = new SupabaseOwnerSessionAdapter(depsWith());
    const token = mintToken(
      validHeader(),
      validPayload({
        user_name: "attacker",
        email: "attacker@example.com",
        user_metadata: { role: "owner" },
        ownerId: "forged-owner-id",
      }),
    );
    const result = await adapter.verifyOwnerSession({
      sessionToken: token,
      expectedPurpose: "owner_session",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Authority comes only from the trusted subject record, never spoofable claims.
    expect(result.value.githubSubject).toBe(OWNER_SUBJECT);
    expect(result.value.ownerId).toBe(STABLE_OWNER_ID);
  });

  it("rejects non-GitHub identities and verified non-Owners as forbidden", async () => {
    const nonGithub = new SupabaseOwnerSessionAdapter(
      depsWith({
        resolveProviderIdentity: async () => ({ provider: "google", subject: OWNER_SUBJECT }),
      }),
    );
    const nonGithubResult = await nonGithub.verifyOwnerSession({
      sessionToken: mintToken(validHeader(), validPayload()),
      expectedPurpose: "owner_session",
    });
    expect(nonGithubResult.ok).toBe(false);
    if (!nonGithubResult.ok) expect(nonGithubResult.error.kind).toBe("forbidden");

    const nonOwnerSubject = "github-subject-not-allowlisted";
    const nonOwner = new SupabaseOwnerSessionAdapter(
      depsWith({
        resolveProviderIdentity: async (subject: string) => ({ provider: "github", subject }),
      }),
    );
    const nonOwnerResult = await nonOwner.verifyOwnerSession({
      sessionToken: mintToken(validHeader(), validPayload({ sub: nonOwnerSubject })),
      expectedPurpose: "owner_session",
    });
    expect(nonOwnerResult.ok).toBe(false);
    if (!nonOwnerResult.ok) expect(nonOwnerResult.error.kind).toBe("forbidden");
  });

  it("denies continued access after allowlist removal", async () => {
    const token = mintToken(validHeader(), validPayload());
    const before = new SupabaseOwnerSessionAdapter(depsWith({ ownerAllowlist: [OWNER_SUBJECT] }));
    const beforeResult = await before.verifyOwnerSession({
      sessionToken: token,
      expectedPurpose: "owner_session",
    });
    expect(beforeResult.ok).toBe(true);

    const after = new SupabaseOwnerSessionAdapter(depsWith({ ownerAllowlist: [] }));
    const afterResult = await after.verifyOwnerSession({
      sessionToken: token,
      expectedPurpose: "owner_session",
    });
    expect(afterResult.ok).toBe(false);
    if (!afterResult.ok) expect(afterResult.error.kind).toBe("forbidden");
  });

  it("enforces revocation and expiry even for otherwise valid JWTs", async () => {
    const revoked = new SupabaseOwnerSessionAdapter(
      depsWith({ isSessionRevoked: async () => true }),
    );
    const revokedResult = await revoked.verifyOwnerSession({
      sessionToken: mintToken(validHeader(), validPayload()),
      expectedPurpose: "owner_session",
    });
    expect(revokedResult.ok).toBe(false);
    if (!revokedResult.ok) expect(revokedResult.error.kind).toBe("unauthenticated");
  });

  it("maps provider outages safely without exposing provider errors or identity subjects", async () => {
    const syntheticSubject = "synthetic-github-subject-secret-integrated-89";
    const syntheticProviderError = `synthetic-oauth-auth-error-secret:${syntheticSubject}`;
    const failing = new SupabaseOwnerSessionAdapter(
      depsWith({
        ownerAllowlist: [syntheticSubject],
        resolveProviderIdentity: async () => {
          throw new Error(syntheticProviderError);
        },
      }),
    );
    const adapterResult = await failing.verifyOwnerSession({
      sessionToken: mintToken(validHeader(), validPayload({ sub: syntheticSubject })),
      expectedPurpose: "owner_session",
    });
    expect(adapterResult.ok).toBe(false);
    if (!adapterResult.ok) {
      expect(adapterResult.error).toEqual({ kind: "temporarily_unavailable", code: "AUTH_PROVIDER_UNAVAILABLE" });
      expect(JSON.stringify(adapterResult.error)).not.toContain(syntheticProviderError);
      expect(JSON.stringify(adapterResult.error)).not.toContain(syntheticSubject);
    }
    const sessionToken = mintToken(validHeader(), validPayload({ sub: syntheticSubject }));
    const logger = createTestLogger();
    const guardResult = await guardOwnerRequest(
      new Request("https://example.com/api/owner/v1/configuration/profile", {
        method: "PUT",
        headers: {
          cookie: `sw_owner_session=${sessionToken}`,
          origin: "https://example.com",
          "x-csrf-token": "synthetic-csrf-proof",
        },
        body: JSON.stringify({ displayName: "Test", headline: "Test", bio: "Test" }),
      }),
      {
        operation: "updateOwnerProfileConfiguration",
        mode: "mutation",
        security: {
          appOrigin: "https://example.com",
          rateLimit: { async check() { return { allowed: true }; } },
          identity: {
            async resolveActorContext(query) {
              const verified = await failing.verifyOwnerSession(query);
              if (!verified.ok) return err(verified.error);
              const actor: ActorContext = {
                kind: "owner",
                ownerId: verified.value.ownerId,
                sessionId: verified.value.sessionId,
              };
              return ok(actor);
            },
            async authorizeOperation(query) {
              return decideAuthorization(query);
            },
          },
        },
        traceId: "integrated-auth-failure-trace",
        instance: "/api/owner/v1/configuration/profile",
        logger,
      },
    );
    expect(guardResult.ok).toBe(false);
    if (!guardResult.ok) {
      expect(guardResult.response.status).toBe(503);
      const problem = await guardResult.response.json();
      expect(problem.code).toBe("temporarily_unavailable");
      expect(JSON.stringify(problem)).not.toContain(syntheticProviderError);
      expect(JSON.stringify(problem)).not.toContain(syntheticSubject);
    }
    const logs = JSON.stringify(logger.records);
    expect(logs).not.toContain(syntheticProviderError);
    expect(logs).not.toContain(syntheticSubject);
  });

  it("validates Owner auth configuration with redacted diagnostics", () => {
    const config = createOwnerAuthConfig({
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_JWT_ISSUER: ISSUER,
      SUPABASE_JWT_AUDIENCE: AUDIENCE,
      OWNER_GITHUB_SUBJECTS: OWNER_SUBJECT,
    });
    expect(config.ownerAllowlist).toEqual([OWNER_SUBJECT]);

    try {
      createOwnerAuthConfig({
        SUPABASE_URL: "",
        SUPABASE_JWT_ISSUER: ISSUER,
        SUPABASE_JWT_AUDIENCE: AUDIENCE,
        OWNER_GITHUB_SUBJECTS: OWNER_SUBJECT,
      });
      expect.unreachable("missing SUPABASE_URL must fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("SUPABASE_URL");
      expect(message).not.toContain(SECRET);
    }

    const secretLike = "super-secret-subject-value-abc123";
    try {
      createOwnerAuthConfig({
        SUPABASE_URL: "http://127.0.0.1:54321",
        SUPABASE_JWT_ISSUER: ISSUER,
        SUPABASE_JWT_AUDIENCE: AUDIENCE,
        OWNER_GITHUB_SUBJECTS: `not an email@, ${secretLike} `,
      });
      expect.unreachable("malformed allowlist must fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("OWNER_GITHUB_SUBJECTS");
      expect(message).not.toContain(secretLike);
    }
  });

  it("keeps raw session material and secrets out of rejection payloads", async () => {
    const adapter = new SupabaseOwnerSessionAdapter(depsWith());
    const token = mintToken(validHeader(), validPayload());
    const result = await adapter.verifyOwnerSession({
      sessionToken: token,
      expectedPurpose: "owner_session",
    });
    expect(result.ok).toBe(true);
    const bad = await adapter.verifyOwnerSession({
      sessionToken: "malformed",
      expectedPurpose: "owner_session",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(JSON.stringify(bad.error)).not.toContain(SECRET);
      expect(JSON.stringify(bad.error)).not.toContain(token.slice(0, 16));
    }
  });
});
