import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import type { Result, Rejection, StableId } from "@shared/domain";
import { err, ok } from "@shared/domain";
import type {
  AuthProviderPort,
  VerifyOwnerSessionInput,
} from "../ports/index.js";
import type { OwnerIdentity } from "../domain/index.js";

/**
 * supabase-auth.ts — Phase 4 #80 verified Owner session adapter.
 *
 * Resolves a real verified session linked to an allowlisted immutable GitHub
 * subject into a stable provider-neutral Owner actor using deterministic
 * local adapter fixtures. Raw Supabase/JWT/cookie/request objects never cross
 * the port seam; only the opaque session token enters and only OwnerIdentity
 * leaves.
 *
 * Verification order (fail closed):
 * 1. JWT shape (three segments, JSON header/payload).
 * 2. Allowed algorithm and known signing key.
 * 3. HS256 HMAC or ES256 P-256 signature against an injected trusted key.
 * 4. Expiry against the injected clock (bounded refresh/expiry semantics:
 *    `exp` must be in the future; refresh is a new token, never an extension
 *    of an expired one).
 * 5. Exact issuer/audience match.
 * 6. Standard Supabase subject/session claims (`sub`, `session_id`), with
 *    owner_session bound by this dedicated adapter and trusted identity lookup.
 * 7. Sensitive-session revocation check: a revoked `session_id` denies even with a
 *    valid signature — parsing a JWT alone never overrides revocation policy.
 * 8. Trusted provider identity record: provider must be `github` with a
 *    matching immutable subject. Mutable username/email, user-editable
 *    metadata, and caller-supplied Owner IDs are never read for authority.
 * 9. Current Owner allowlist recheck (removal denies continued access,
 *    including replay authorization).
 *
 * Outcome mapping preserves declared semantics: missing/invalid sessions are
 * `unauthenticated` (401), verified non-Owners and non-GitHub identities are
 * `forbidden` (403), provider timeout/outage is `temporarily_unavailable`
 * (503). Rejection payloads carry only stable codes — never session material,
 * subjects, or secrets.
 *
 * Local fixtures use HS256 with injected keys so deterministic tests need no
 * live GitHub exchange, production secret, or remote Auth changes. Production
 * Supabase ES256 JWTs use injected PEM public keys resolved from trusted JWKS
 * by the provider consumer. Key-set resolution stays outside domain and
 * application code.
 */

export interface TrustedProviderIdentity {
  readonly provider: string;
  readonly subject: string;
}

export interface OwnerSessionAdapterDeps {
  readonly issuer: string;
  readonly audience: string;
  readonly allowedAlgorithms: readonly string[];
  readonly signingKeys: ReadonlyMap<string, string>;
  readonly ownerAllowlist: readonly string[];
  readonly stableOwnerId: string;
  readonly nowSeconds: () => number;
  readonly resolveProviderIdentity: (
    subject: string,
  ) => Promise<TrustedProviderIdentity | null>;
  readonly isSessionRevoked: (sessionId: string) => Promise<boolean>;
}

interface JwtHeader {
  readonly alg: unknown;
  readonly kid: unknown;
}

interface JwtPayload {
  readonly sub: unknown;
  readonly session_id: unknown;
  readonly iss: unknown;
  readonly aud: unknown;
  readonly exp: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unauthenticated(code: string): Rejection {
  return { kind: "unauthenticated", code };
}

function forbidden(code: string): Rejection {
  return { kind: "forbidden", code };
}

function unavailable(code: string): Rejection {
  return { kind: "temporarily_unavailable", code };
}

function decodeSegment(segment: string): unknown {
  const json = Buffer.from(segment, "base64url").toString("utf8");
  return JSON.parse(json) as unknown;
}

function signaturesEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "base64url");
  const actualBytes = Buffer.from(actual, "base64url");
  if (expectedBytes.length !== actualBytes.length) {
    return false;
  }
  return timingSafeEqual(expectedBytes, actualBytes);
}

export class SupabaseOwnerSessionAdapter implements AuthProviderPort {
  private readonly deps: OwnerSessionAdapterDeps;

  constructor(deps: OwnerSessionAdapterDeps) {
    this.deps = deps;
  }

  async verifyOwnerSession(
    input: VerifyOwnerSessionInput,
  ): Promise<Result<OwnerIdentity, Rejection>> {
    const parts = input.sessionToken.split(".");
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      return err(unauthenticated("SESSION_MALFORMED"));
    }
    const [encodedHeader, encodedPayload, signature] = parts as [
      string,
      string,
      string,
    ];

    let header: JwtHeader;
    let payload: JwtPayload;
    try {
      const decodedHeader = decodeSegment(encodedHeader);
      const decodedPayload = decodeSegment(encodedPayload);
      if (!isRecord(decodedHeader) || !isRecord(decodedPayload)) {
        return err(unauthenticated("SESSION_MALFORMED"));
      }
      header = decodedHeader as unknown as JwtHeader;
      payload = decodedPayload as unknown as JwtPayload;
    } catch {
      return err(unauthenticated("SESSION_MALFORMED"));
    }

    if (
      typeof header.alg !== "string" ||
      !["HS256", "ES256"].includes(header.alg) ||
      !this.deps.allowedAlgorithms.includes(header.alg)
    ) {
      return err(unauthenticated("UNSUPPORTED_ALGORITHM"));
    }
    if (typeof header.kid !== "string" || header.kid.length === 0) {
      return err(unauthenticated("UNKNOWN_SIGNING_KEY"));
    }
    const secret = this.deps.signingKeys.get(header.kid);
    if (secret === undefined) {
      return err(unauthenticated("UNKNOWN_SIGNING_KEY"));
    }

    let validSignature = false;
    try {
      if (header.alg === "HS256") {
        // Never interpret an asymmetric PEM public key as an HMAC secret.
        if (!secret.trimStart().startsWith("-----BEGIN")) {
          const expected = createHmac("sha256", secret).update(`${encodedHeader}.${encodedPayload}`).digest("base64url");
          validSignature = signaturesEqual(expected, signature);
        }
      } else {
        const key = createPublicKey(secret);
        if (key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") {
          validSignature = verify("sha256", Buffer.from(`${encodedHeader}.${encodedPayload}`),
            { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"));
        }
      }
    } catch {
      // Invalid trusted key material and malformed signatures fail closed.
    }
    if (!validSignature) {
      return err(unauthenticated("INVALID_SIGNATURE"));
    }

    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      return err(unauthenticated("SESSION_EXPIRED"));
    }
    if (payload.exp <= this.deps.nowSeconds()) {
      return err(unauthenticated("SESSION_EXPIRED"));
    }
    if (payload.iss !== this.deps.issuer || payload.aud !== this.deps.audience) {
      return err(unauthenticated("INVALID_CLAIMS"));
    }
    if (
      typeof payload.sub !== "string" ||
      payload.sub.length === 0 ||
      typeof payload.session_id !== "string" ||
      payload.session_id.length === 0 ||
      input.expectedPurpose !== "owner_session"
    ) {
      return err(unauthenticated("INVALID_CLAIMS"));
    }
    const subject = payload.sub;
    const sessionId = payload.session_id;

    let revoked: boolean;
    try {
      revoked = await this.deps.isSessionRevoked(sessionId);
    } catch {
      return err(unavailable("AUTH_PROVIDER_UNAVAILABLE"));
    }
    if (revoked) {
      return err(unauthenticated("SESSION_REVOKED"));
    }

    let identity: TrustedProviderIdentity | null;
    try {
      identity = await this.deps.resolveProviderIdentity(subject);
    } catch {
      return err(unavailable("AUTH_PROVIDER_UNAVAILABLE"));
    }
    if (
      identity === null ||
      identity.provider !== "github" ||
      identity.subject !== subject
    ) {
      return err(forbidden("UNTRUSTED_PROVIDER_IDENTITY"));
    }
    if (!this.deps.ownerAllowlist.includes(subject)) {
      return err(forbidden("NOT_OWNER"));
    }

    return ok({
      ownerId: this.deps.stableOwnerId as StableId<"Owner">,
      githubSubject: subject,
      sessionId,
    });
  }

  async getOwnerAllowlist(): Promise<Result<readonly string[], Rejection>> {
    return ok([...this.deps.ownerAllowlist]);
  }
}
