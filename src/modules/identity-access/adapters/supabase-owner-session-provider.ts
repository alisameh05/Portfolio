import { createPublicKey, type JsonWebKey } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../../shared/adapters/postgres/database.generated.js";
import type { OwnerAuthConfig } from "./auth-config.js";
import type { AuthProviderPort } from "../ports/index.js";
import { SupabaseOwnerSessionAdapter, type TrustedProviderIdentity } from "./supabase-auth.js";
import { err } from "@shared/domain";

interface JwkSet { readonly keys?: readonly Record<string, unknown>[]; }
interface SessionIdentityRow { readonly provider: string; readonly subject: string; readonly owner_id: string; }
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Production Auth consumer: trusted Supabase signing keys plus narrow live Auth/PostgreSQL checks. */
export function createSupabaseOwnerSessionProvider(input: {
  readonly config: OwnerAuthConfig;
  readonly stableOwnerId: string;
  readonly database: Kysely<DB>;
  readonly request?: typeof fetch;
  readonly nowSeconds?: () => number;
  readonly cacheMilliseconds?: number;
}): AuthProviderPort {
  const endpoint = new URL(input.config.supabaseUrl);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("OWNER_AUTH_ENDPOINT_INVALID");
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, "")}/auth/v1/.well-known/jwks.json`;
  const request = input.request ?? fetch;
  const cacheMilliseconds = Number.isSafeInteger(input.cacheMilliseconds) &&
    input.cacheMilliseconds! >= 1_000 && input.cacheMilliseconds! <= 900_000
    ? input.cacheMilliseconds!
    : 300_000;

  let cachedKeys: ReadonlyMap<string, string> | undefined;
  let expiresAt = 0;
  let pendingKeys: Promise<ReadonlyMap<string, string>> | undefined;

  async function signingKeys(force = false): Promise<ReadonlyMap<string, string>> {
    if (!force && cachedKeys !== undefined && Date.now() < expiresAt) return cachedKeys;
    if (pendingKeys !== undefined) return pendingKeys;
    pendingKeys = (async () => {
      const response = await request(endpoint, {
        method: "GET", redirect: "error", cache: "no-store", credentials: "omit",
        headers: { accept: "application/json" }, signal: AbortSignal.timeout(2_000),
      });
      if (response.status !== 200) throw new Error("OWNER_AUTH_KEYS_UNAVAILABLE");
      const contentLength = response.headers.get("content-length");
      if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > 131_072)) {
        throw new Error("OWNER_AUTH_KEYS_INVALID");
      }
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > 131_072) throw new Error("OWNER_AUTH_KEYS_INVALID");
      const body = JSON.parse(text) as JwkSet;
      const keys = new Map<string, string>();
      for (const key of body.keys ?? []) {
        if (key["kty"] !== "EC" || key["crv"] !== "P-256" || typeof key["kid"] !== "string" ||
            key["kid"].length === 0 || (key["alg"] !== undefined && key["alg"] !== "ES256")) continue;
        const pem = createPublicKey({ key: key as JsonWebKey, format: "jwk" })
          .export({ type: "spki", format: "pem" }).toString();
        keys.set(key["kid"], pem);
      }
      if (keys.size === 0) throw new Error("OWNER_AUTH_KEYS_UNAVAILABLE");
      cachedKeys = keys;
      expiresAt = Date.now() + cacheMilliseconds;
      return keys;
    })().finally(() => { pendingKeys = undefined; });
    return pendingKeys;
  }

  async function sessionIdentity(userId: string, sessionId: string): Promise<TrustedProviderIdentity | null> {
    if (!UUID_PATTERN.test(userId) || !UUID_PATTERN.test(sessionId)) return null;
    const result = await sql<SessionIdentityRow>`
      select provider, subject, owner_id::text as owner_id
      from identity_access.resolve_owner_session_identity(${userId}::uuid, ${sessionId}::uuid)
    `.execute(input.database);
    const row = result.rows[0];
    return row === undefined ? null : { provider: row.provider, subject: row.subject, ownerId: row.owner_id };
  }

  const base = {
    issuer: input.config.issuer,
    audience: input.config.audience,
    allowedAlgorithms: ["ES256"],
    ownerAllowlist: input.config.ownerAllowlist,
    stableOwnerId: input.stableOwnerId,
    nowSeconds: input.nowSeconds ?? (() => Math.floor(Date.now() / 1000)),
    resolveProviderIdentity: sessionIdentity,
    async isSessionRevoked(sessionId: string): Promise<boolean> {
      if (!UUID_PATTERN.test(sessionId)) return true;
      const result = await sql<{ readonly active: boolean }>`
        select identity_access.owner_session_is_active(${sessionId}::uuid) as active
      `.execute(input.database);
      return result.rows[0]?.active !== true;
    },
  };

  return {
    async verifyOwnerSession(session) {
      try {
        let keys = await signingKeys();
        let verified = await new SupabaseOwnerSessionAdapter({ ...base, signingKeys: keys }).verifyOwnerSession(session);
        if (!verified.ok && verified.error.code === "UNKNOWN_SIGNING_KEY") {
          keys = await signingKeys(true);
          verified = await new SupabaseOwnerSessionAdapter({ ...base, signingKeys: keys }).verifyOwnerSession(session);
        }
        return verified;
      } catch {
        return err({ kind: "temporarily_unavailable", code: "AUTH_PROVIDER_UNAVAILABLE" });
      }
    },
    async getOwnerAllowlist() {
      return { ok: true, value: [...input.config.ownerAllowlist] };
    },
  };
}
