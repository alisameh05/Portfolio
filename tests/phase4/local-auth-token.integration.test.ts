import { createPublicKey, randomUUID, type JsonWebKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SupabaseOwnerSessionAdapter } from "../../src/modules/identity-access/adapters/supabase-auth.js";

// Invoke through npm run phase4:focus:local-auth. Only that runner provisions
// the isolated stack and supplies ephemeral credentials. Never use remote Auth.
const required = process.env['PHASE4_REQUIRE_LOCAL_AUTH'] === "1";
describe.skipIf(!required)("real local Supabase access token", () => {
  it("accepts emitted session claims, rejects tampering, removal and revocation", async () => {
    const base = process.env['PHASE4_LOCAL_AUTH_URL'];
    const anon = process.env['PHASE4_LOCAL_AUTH_ANON_KEY'];
    const service = process.env['PHASE4_LOCAL_AUTH_SERVICE_ROLE_KEY'];
    if (!base || !anon || !service) throw new Error("LOCAL_AUTH_ENV_REQUIRED");
    const url = new URL(base);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "56321") {
      throw new Error("LOCAL_AUTH_ENDPOINT_NOT_ISOLATED");
    }
    async function request(path: string, key: string, body?: unknown, method = "POST") {
      const response = await fetch(`${base}/auth/v1${path}`, {
        method, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: body === undefined ? null : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`LOCAL_AUTH_HTTP_FAILED:${path.split("/")[1]}:${response.status}`);
      return method === "DELETE" ? null : await response.json() as Record<string, unknown>;
    }
    const email = `auth-${randomUUID()}@example.test`;
    const user = await request("/admin/users", service, { email, email_confirm: true });
    if (typeof user?.['id'] !== "string") throw new Error("LOCAL_AUTH_USER_REQUIRED");
    const userId = user['id'];
    try {
      // Admin-generated one-time link: no password login, signup or live GitHub.
      const link = await request("/admin/generate_link", service, { type: "magiclink", email });
      if (typeof link?.['hashed_token'] !== "string") throw new Error("LOCAL_AUTH_LINK_REQUIRED");
      const session = await request("/verify", anon, { type: "magiclink", token_hash: link['hashed_token'] });
      if (typeof session?.['access_token'] !== "string") throw new Error("LOCAL_AUTH_TOKEN_REQUIRED");
      const token = session['access_token'];
      const [headerSegment, payloadSegment, signature] = token.split(".");
      const header = JSON.parse(Buffer.from(headerSegment!, "base64url").toString()) as Record<string, unknown>;
      const claims = JSON.parse(Buffer.from(payloadSegment!, "base64url").toString()) as Record<string, unknown>;
      expect(claims['sub'] === userId).toBe(true);
      expect(typeof claims['session_id'] === "string").toBe(true);
      expect(claims['sid'] === undefined && claims['purpose'] === undefined).toBe(true);
      expect(header['alg'] === "ES256", "LOCAL_AUTH_TOKEN_ALGORITHM").toBe(true);
      const jwks = await request("/.well-known/jwks.json", anon, undefined, "GET");
      if (!Array.isArray(jwks?.['keys'])) throw new Error("LOCAL_AUTH_JWKS_REQUIRED");
      const trustedKeys = new Map<string, string>();
      for (const jwk of jwks['keys'] as Record<string, unknown>[]) {
        if (typeof jwk['kid'] === "string" && jwk['kty'] === "EC" && jwk['crv'] === "P-256") {
          trustedKeys.set(jwk['kid'], createPublicKey({ key: jwk as JsonWebKey, format: "jwk" }).export({ format: "pem", type: "spki" }).toString());
        }
      }
      const deps = {
        issuer: `${base}/auth/v1`, audience: "authenticated", allowedAlgorithms: ["ES256"],
        signingKeys: trustedKeys,
        ownerAllowlist: [userId], stableOwnerId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0",
        nowSeconds: () => Math.floor(Date.now() / 1000),
        // Trusted GitHub identity/revocation seams remain controlled fixtures;
        // this test proves actual Auth token compatibility, not GitHub OAuth.
        resolveProviderIdentity: async (subject: string) => ({ provider: "github", subject }),
        isSessionRevoked: async () => false,
      };
      const input = { sessionToken: token, expectedPurpose: "owner_session" as const };
      const accepted = await new SupabaseOwnerSessionAdapter(deps).verifyOwnerSession(input);
      expect(accepted.ok, "LOCAL_AUTH_ADAPTER_ACCEPTANCE").toBe(true);
      if (accepted.ok) expect(accepted.value.sessionId === claims['session_id']).toBe(true);
      const altered = `${headerSegment}.${payloadSegment}.${signature!.startsWith("A") ? "B" : "A"}${signature!.slice(1)}`;
      const forged = await new SupabaseOwnerSessionAdapter(deps).verifyOwnerSession({ ...input, sessionToken: altered });
      expect(!forged.ok && forged.error.kind === "unauthenticated").toBe(true);
      const removed = await new SupabaseOwnerSessionAdapter({ ...deps, ownerAllowlist: [] }).verifyOwnerSession(input);
      expect(!removed.ok && removed.error.kind === "forbidden").toBe(true);
      const revoked = await new SupabaseOwnerSessionAdapter({ ...deps, isSessionRevoked: async () => true }).verifyOwnerSession(input);
      expect(!revoked.ok && revoked.error.kind === "unauthenticated").toBe(true);
    } finally {
      await request(`/admin/users/${userId}`, service, undefined, "DELETE");
    }
  }, 60_000);
});
