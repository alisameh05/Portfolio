/**
 * owner-security.ts — Phase 4 #81 shared verified-actor boundary.
 *
 * One shared guard for the current Owner HTTP entrypoints. It
 * replaces the deterministic Phase 2 placeholder Owner construction that lived
 * in every owner adapter: handlers resolve the verified Owner actor here and
 * never fabricate one.
 *
 * Ordered behavior per request:
 * 1. Reject forged forwarded-host information (`x-forwarded-host` or a
 *    `forwarded` header carrying `host=`) with 403 before authentication,
 *    dispatch, ledger replay, or database effects. The deployment terminates
 *    TLS and sets Host directly; forwarded values are never trusted for
 *    origin decisions.
 * 2. Extract the `sw_owner_session` cookie. Missing or empty material is 401.
 * 3. Resolve the opaque session token through the injected Identity and
 *    Access service (`owner_session` purpose). Rejections preserve their
 *    declared mapping (401/403/503); transport carries no session material.
 * 4. Authorize the resolved actor for the owner-scoped operation on every
 *    request — application access and idempotency replay included, not just
 *    login. Reads neither mutate nor issue identity: this guard is pure
 *    verification.
 * 5. Verify exact Origin and CSRF proof for mutations before rate limiting.
 *    denial is 429 with `Retry-After`, limiter outage fails closed to 503.
 *    No new anti-abuse subsystem or Redis is introduced: the existing
 *    `rate_limited` rejection seam carries the verdict.
 * 6. Mutations additionally require an exact `Origin` match against the
 *    configured application origin plus an explicit valid CSRF proof
 *    (`x-csrf-token`: 8–256 visible ASCII characters, never the session
 *    token itself). SameSite alone is insufficient.
 *
 * Session cookies stay server managed: `HttpOnly`, `Secure` under deployed
 * HTTPS, deliberate `SameSite=Lax` (top-level OAuth callback navigation
 * works; cross-site mutations still face exact-origin plus CSRF proof),
 * host-only (no `Domain`), bounded `Max-Age` (default 3600s), and no
 * refresh-token or browser exposure. Plain HTTP is permitted only for
 * explicit loopback test contexts (`localhost`, `127.0.0.1`, `::1`).
 * Refresh mints a new session; expiry and revocation are enforced by the
 * identity adapter on every resolution.
 *
 * Uses only the standard Web Request/Response plus provider-neutral domain
 * and Identity and Access contracts — no Next.js, Supabase, or provider
 * types cross this seam.
 */

import type {
  ActorContext,
  Rejection,
  Result,
} from "../../shared/domain/index.js";
import { err, ok } from "../../shared/domain/index.js";
import type { OwnerRateLimitCheck } from "../../modules/identity-access/index.js";

export const OWNER_PRIVATE_RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;
import {
  decideAuthorization,
  requiredPermissionForOwnerOperation,
  type IdentityAccessService,
} from "../../modules/identity-access/index.js";
import type { Logger } from "../ports.js";
import {
  internalErrorProblem,
  rejectionToProblem,
} from "./problem.js";

/** Server-managed Owner session cookie name (declared `OwnerSession` scheme). */
export const OWNER_SESSION_COOKIE = "sw_owner_session";

/** Explicit CSRF proof header required for cookie-authenticated mutations. */
export const OWNER_CSRF_HEADER = "x-csrf-token";

/** Bounded Owner session lifetime in seconds (matches local `jwt_expiry`). */
export const OWNER_SESSION_MAX_AGE_SECONDS = 3600;

const CSRF_PROOF_PATTERN = /^[\x21-\x7E]{8,256}$/;

/**
 * Injected security dependencies. The composition root supplies the exact
 * configured application origin and the Identity and Access service; tests
 * inject deterministic fakes. Rate limiting is required and has no
 * default-allow behavior.
 */
export interface OwnerRequestSecurity {
  readonly appOrigin: string;
  readonly identity: Pick<
    IdentityAccessService,
    "resolveActorContext" | "authorizeOperation"
  >;
  readonly rateLimit: OwnerRateLimitCheck;
}

export type OwnerGuardMode = "mutation" | "read";

export interface OwnerGuardOptions {
  readonly operation: string;
  readonly mode: OwnerGuardMode;
  readonly security: OwnerRequestSecurity;
  readonly traceId: string;
  readonly instance: string;
  readonly logger?: Logger | undefined;
}

export type OwnerGuardResult =
  | { readonly ok: true; readonly actor: ActorContext }
  | { readonly ok: false; readonly response: Response };

function forbiddenResponse(
  code: string,
  traceId: string,
  instance: string,
  logger: Logger | undefined,
): Response {
  const rejection: Rejection = { kind: "forbidden", code };
  const response = rejectionToProblem(rejection, traceId, instance);
  logger?.warn("request.rejected", { traceId, status: response.status, code });
  return response;
}

function unauthenticatedResponse(
  code: string,
  traceId: string,
  instance: string,
  logger: Logger | undefined,
): Response {
  const rejection: Rejection = { kind: "unauthenticated", code };
  const response = rejectionToProblem(rejection, traceId, instance);
  logger?.warn("request.rejected", { traceId, status: response.status, code });
  return response;
}

function hasForwardedHost(request: Request, appOrigin: string): boolean {
  const explicit = request.headers.get("x-forwarded-host");
  if (explicit !== null && explicit.trim() !== "") {
    // Next.js adds x-forwarded-host from Host when the ingress did not supply
    // it. Accept that normalized value only when all three authorities agree:
    // the configured application origin, the request URL, and Host. A client
    // supplied conflicting value remains rejected.
    try {
      const expectedHost = new URL(appOrigin).host.toLowerCase();
      const forwardedHost = explicit.trim().toLowerCase();
      const requestHost = new URL(request.url).host.toLowerCase();
      const hostHeader = request.headers.get("host")?.trim().toLowerCase();
      if (forwardedHost !== expectedHost || requestHost !== expectedHost || hostHeader !== expectedHost) return true;
    } catch {
      return true;
    }
  }
  const forwarded = request.headers.get("forwarded");
  if (forwarded !== null && /(?:^|[;,])\s*host\s*=/i.test(forwarded)) {
    return true;
  }
  return false;
}

function extractSessionToken(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (header === null || header.trim() === "") {
    return null;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (name !== OWNER_SESSION_COOKIE) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

function isValidCsrfProof(proof: string | null, sessionToken: string): boolean {
  if (proof === null || proof === "") {
    return false;
  }
  if (proof === sessionToken) {
    return false;
  }
  return CSRF_PROOF_PATTERN.test(proof);
}

/**
 * Shared verified-actor guard for Owner entrypoints. Denied requests return a
 * Problem Details response and must never reach application dispatch, ledger
 * replay, or database effects. Reads resolve and authorize the actor but never
 * mutate state or issue identity material.
 */
export async function guardOwnerRequest(
  request: Request,
  options: OwnerGuardOptions,
): Promise<OwnerGuardResult> {
  const { operation, mode, security, traceId, instance, logger } = options;

  if (hasForwardedHost(request, security.appOrigin)) {
    return {
      ok: false,
      response: forbiddenResponse("FORWARDED_HOST_REJECTED", traceId, instance, logger),
    };
  }

  const sessionToken = extractSessionToken(request);
  if (sessionToken === null) {
    return {
      ok: false,
      response: unauthenticatedResponse("SESSION_NOT_FOUND", traceId, instance, logger),
    };
  }

  let resolved: Result<ActorContext, Rejection>;
  try {
    resolved = await security.identity.resolveActorContext({
      sessionToken,
      expectedPurpose: "owner_session",
      correlationId: traceId,
    });
  } catch (error) {
    return { ok: false, response: internalErrorProblem(error, traceId, instance, logger) };
  }
  if (!resolved.ok) {
    const response = rejectionToProblem(resolved.error, traceId, instance);
    logger?.warn("request.rejected", {
      traceId,
      status: response.status,
      code: resolved.error.code,
    });
    return { ok: false, response };
  }
  if (resolved.value.kind !== "owner") {
    return {
      ok: false,
      response: forbiddenResponse("OWNER_REQUIRED", traceId, instance, logger),
    };
  }

  let authorized: Result<boolean, Rejection>;
  try {
    authorized = await security.identity.authorizeOperation({
      actor: resolved.value,
      requiredPermission: requiredPermissionForOwnerOperation(operation),
    });
  } catch (error) {
    return { ok: false, response: internalErrorProblem(error, traceId, instance, logger) };
  }
  if (!authorized.ok || authorized.value !== true) {
    const rejection: Rejection = !authorized.ok
      ? authorized.error
      : { kind: "forbidden", code: "OPERATION_NOT_PERMITTED" };
    const response = rejectionToProblem(rejection, traceId, instance);
    logger?.warn("request.rejected", {
      traceId,
      status: response.status,
      code: rejection.code,
    });
    return { ok: false, response };
  }

  if (mode === "mutation") {
    if (request.headers.get("origin") !== security.appOrigin) {
      return {
        ok: false,
        response: forbiddenResponse("CSRF_ORIGIN_MISMATCH", traceId, instance, logger),
      };
    }
    if (!isValidCsrfProof(request.headers.get(OWNER_CSRF_HEADER), sessionToken)) {
      return {
        ok: false,
        response: forbiddenResponse("CSRF_PROOF_INVALID", traceId, instance, logger),
      };
    }
  }

  let verdict: { readonly allowed: boolean; readonly retryAfterSeconds?: number };
  try {
    verdict = await security.rateLimit.check(`owner_session:${resolved.value.ownerId}:${operation}`);
  } catch {
    const rejection: Rejection = { kind: "temporarily_unavailable", code: "RATE_LIMIT_UNAVAILABLE" };
    const response = rejectionToProblem(rejection, traceId, instance);
    logger?.warn("request.rejected", { traceId, status: response.status, code: rejection.code });
    return { ok: false, response };
  }
  if (!verdict.allowed) {
    const retryAfterSeconds = Number.isSafeInteger(verdict.retryAfterSeconds) &&
      (verdict.retryAfterSeconds ?? 0) > 0
      ? Math.min(3600, verdict.retryAfterSeconds as number)
      : 60;
    const rejection: Rejection = { kind: "rate_limited", code: "RATE_LIMIT_EXCEEDED", retryAfterSeconds };
    const response = rejectionToProblem(rejection, traceId, instance);
    logger?.warn("request.rejected", { traceId, status: response.status, code: rejection.code });
    return { ok: false, response };
  }

  return { ok: true, actor: resolved.value };
}

export class OwnerSessionCookieError extends Error {
  constructor(reason: string) {
    super(`Invalid Owner session cookie: ${reason}.`);
    this.name = "OwnerSessionCookieError";
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const bare = normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
}

export interface OwnerSessionCookieParams {
  readonly sessionToken: string;
  readonly appBaseUrl: string;
  readonly maxAgeSeconds?: number | undefined;
}

/**
 * Build the server-managed `Set-Cookie` value for an Owner session.
 * `Secure` is set under deployed HTTPS; plain HTTP is accepted only for
 * explicit loopback test contexts. Never exposes refresh material and never
 * readable from browser script (`HttpOnly`).
 */
export function buildOwnerSessionCookie(params: OwnerSessionCookieParams): string {
  const token = params.sessionToken;
  if (token === "" || /[\s;,\x00-\x1F\x7F]/.test(token)) {
    throw new OwnerSessionCookieError("session token must be non-empty token-safe text");
  }
  let url: URL;
  try {
    url = new URL(params.appBaseUrl);
  } catch {
    throw new OwnerSessionCookieError("application origin must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OwnerSessionCookieError("application origin must use HTTP or HTTPS");
  }
  const secure = url.protocol === "https:";
  if (!secure && !isLoopbackHostname(url.hostname)) {
    throw new OwnerSessionCookieError("Secure transport is required outside loopback test contexts");
  }
  const maxAge = params.maxAgeSeconds ?? OWNER_SESSION_MAX_AGE_SECONDS;
  if (!Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > 86400) {
    throw new OwnerSessionCookieError("lifetime must be bounded between 1 and 86400 seconds");
  }
  const parts = [
    `${OWNER_SESSION_COOKIE}=${token}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

// ── Test support ─────────────────────────────────────────────────────────────

export type OwnerSecurityTestMode =
  | { readonly type: "allow"; readonly actor: ActorContext }
  | { readonly type: "deny"; readonly rejection: Rejection }
  | {
    readonly type: "rate-limited";
    readonly actor: ActorContext;
    readonly retryAfterSeconds?: number;
  };

/**
 * Deterministic test security boundary. Authorization delegates to the real
 * Identity and Access policy so forged contexts behave exactly as in
 * production; session resolution is stubbed per mode. The application origin
 * defaults to the shared test origin.
 */
export function createOwnerSecurityTestStub(
  mode: OwnerSecurityTestMode,
): OwnerRequestSecurity {
  switch (mode.type) {
    case "allow":
      return {
        appOrigin: "https://example.com",
        identity: {
          async resolveActorContext(): Promise<Result<ActorContext, Rejection>> {
            return ok(mode.actor);
          },
          async authorizeOperation(
            query,
          ): Promise<Result<boolean, Rejection>> {
            return decideAuthorization(query);
          },
        },
        rateLimit: { async check() { return { allowed: true }; } },
      };
    case "deny":
      return {
        appOrigin: "https://example.com",
        identity: {
          async resolveActorContext(): Promise<Result<ActorContext, Rejection>> {
            return err(mode.rejection);
          },
          async authorizeOperation(): Promise<Result<boolean, Rejection>> {
            return err(mode.rejection);
          },
        },
        rateLimit: { async check() { return { allowed: true }; } },
      };
    case "rate-limited":
      return {
        appOrigin: "https://example.com",
        identity: {
          async resolveActorContext(): Promise<Result<ActorContext, Rejection>> {
            return ok(mode.actor);
          },
          async authorizeOperation(
            query,
          ): Promise<Result<boolean, Rejection>> {
            return decideAuthorization(query);
          },
        },
        rateLimit: {
          async check() {
            return { allowed: false, retryAfterSeconds: mode.retryAfterSeconds ?? 30 };
          },
        },
      };
  }
}
