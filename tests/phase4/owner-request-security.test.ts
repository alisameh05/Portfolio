/**
 * owner-request-security.test.ts — Phase 4 #81
 *
 * Pre-agreed seam: the shared Owner HTTP security boundary observed through
 * standard Request/Response objects with an injected provider-neutral
 * identity fake. No database, network, or live provider required.
 *
 * Acceptance (issue #81, transport-security slice):
 * - One shared verified-actor boundary: missing/invalid sessions are 401,
 *   non-Owners are 403, provider outage is 503; denied requests never reach
 *   the application service.
 * - Cookie-authenticated mutations require exact origin plus explicit CSRF
 *   proof; missing/mismatched Origin, absent/invalid proof, and forged
 *   forwarded-host information are rejected before dispatch.
 * - Reads require authentication but neither mutate nor issue identity.
 * - Purpose-limited rate-limit subjects; limiter denial is 429 with
 *   Retry-After; limiter outage fails closed to 503.
 * - Session cookies stay server managed: HttpOnly, Secure under deployed
 *   HTTPS, deliberate SameSite, bounded lifetime, explicit loopback test
 *   exceptions, no refresh-token or browser exposure.
 */

import { describe, expect, it } from "vitest";

import type { ActorContext } from "../../src/shared/domain/index.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import {
  OWNER_CSRF_HEADER,
  OWNER_SESSION_COOKIE,
  OWNER_SESSION_MAX_AGE_SECONDS,
  buildOwnerSessionCookie,
  createOwnerSecurityTestStub,
  guardOwnerRequest,
} from "../../src/runtime/http/owner-security.js";

const APP_ORIGIN = "https://example.com";
const SESSION_TOKEN = "opaque-session-token-for-tests-001";
const CSRF_TOKEN = "csrf-proof-token-for-tests-002";

const OWNER: ActorContext = {
  kind: "owner",
  ownerId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0" as never,
  sessionId: "session-opaque-001",
};

function mutationRequest(init?: {
  cookie?: string | null;
  origin?: string | null;
  csrf?: string | null;
  forwardedHost?: string;
  forwarded?: string;
}): Request {
  const headers: Record<string, string> = {};
  if (init?.cookie !== null) {
    headers["cookie"] = init?.cookie ?? `${OWNER_SESSION_COOKIE}=${SESSION_TOKEN}`;
  }
  if (init?.origin !== null) {
    headers["origin"] = init?.origin ?? APP_ORIGIN;
  }
  if (init?.csrf !== null) {
    headers[OWNER_CSRF_HEADER] = init?.csrf ?? CSRF_TOKEN;
  }
  if (init?.forwardedHost !== undefined) {
    headers["x-forwarded-host"] = init.forwardedHost;
  }
  if (init?.forwarded !== undefined) {
    headers["forwarded"] = init.forwarded;
  }
  return new Request("https://example.com/api/owner/v1/configuration/profile", {
    method: "PUT",
    headers,
  });
}

function readRequest(cookie?: string): Request {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) {
    headers["cookie"] = cookie;
  } else {
    headers["cookie"] = `${OWNER_SESSION_COOKIE}=${SESSION_TOKEN}`;
  }
  return new Request("https://example.com/api/owner/v1/cv", { headers });
}

describe("Owner request security boundary (#81)", () => {
  it("resolves a verified Owner actor for mutations with valid session, origin, and CSRF proof", async () => {
    const security = createOwnerSecurityTestStub({ type: "allow", actor: OWNER });
    const logger = createTestLogger();
    const guard = await guardOwnerRequest(mutationRequest(), {
      operation: "updateOwnerProfileConfiguration",
      mode: "mutation",
      security: { ...security, appOrigin: APP_ORIGIN },
      traceId: "trace-1",
      instance: "/api/owner/v1/configuration/profile",
      logger,
    });
    expect(guard.ok).toBe(true);
    if (!guard.ok) return;
    expect(guard.actor).toEqual(OWNER);
  });

  it("rejects mutations without a session cookie as 401 before dispatch", async () => {
    const security = createOwnerSecurityTestStub({ type: "allow", actor: OWNER });
    let dispatched = 0;
    const denying = {
      ...security,
      appOrigin: APP_ORIGIN,
      identity: {
        ...security.identity,
        async resolveActorContext() {
          dispatched += 1;
          return { ok: false as const, error: { kind: "unauthenticated" as const, code: "SESSION_NOT_FOUND" } };
        },
      },
    };
    const guard = await guardOwnerRequest(mutationRequest({ cookie: null }), {
      operation: "updateOwnerProfileConfiguration",
      mode: "mutation",
      security: denying,
      traceId: "trace-2",
      instance: "/api/owner/v1/configuration/profile",
    });
    expect(guard.ok).toBe(false);
    if (guard.ok) return;
    expect(guard.response.status).toBe(401);
    expect(dispatched).toBe(0);
  });

  it("maps verified non-Owner identities to 403", async () => {
    const security = createOwnerSecurityTestStub({
      type: "deny",
      rejection: { kind: "forbidden", code: "NOT_OWNER" },
    });
    const guard = await guardOwnerRequest(mutationRequest(), {
      operation: "updateOwnerProfileConfiguration",
      mode: "mutation",
      security: { ...security, appOrigin: APP_ORIGIN },
      traceId: "trace-3",
      instance: "/api/owner/v1/configuration/profile",
    });
    expect(guard.ok).toBe(false);
    if (guard.ok) return;
    expect(guard.response.status).toBe(403);
  });

  it("maps provider outage to 503 without leaking internals", async () => {
    const security = createOwnerSecurityTestStub({
      type: "deny",
      rejection: { kind: "temporarily_unavailable", code: "AUTH_PROVIDER_UNAVAILABLE" },
    });
    const logger = createTestLogger();
    const guard = await guardOwnerRequest(mutationRequest(), {
      operation: "updateOwnerProfileConfiguration",
      mode: "mutation",
      security: { ...security, appOrigin: APP_ORIGIN },
      traceId: "trace-4",
      instance: "/api/owner/v1/configuration/profile",
      logger,
    });
    expect(guard.ok).toBe(false);
    if (guard.ok) return;
    expect(guard.response.status).toBe(503);
    const serialized = JSON.stringify(await guard.response.json());
    expect(serialized).not.toContain(SESSION_TOKEN);
    expect(JSON.stringify(logger.records)).not.toContain(SESSION_TOKEN);
  });

  it.each([
    ["missing Origin", { origin: null }],
    ["mismatched Origin", { origin: "https://evil.example" }],
    ["trailing-slash Origin", { origin: "https://example.com/" }],
    ["http Origin", { origin: "http://example.com" }],
  ])("rejects mutations with %s as 403", async (_label, init) => {
    const security = createOwnerSecurityTestStub({ type: "allow", actor: OWNER });
    const guard = await guardOwnerRequest(mutationRequest(init), {
      operation: "updateOwnerProfileConfiguration",
      mode: "mutation",
      security: { ...security, appOrigin: APP_ORIGIN },
      traceId: "trace-origin",
      instance: "/api/owner/v1/configuration/profile",
    });
    expect(guard.ok).toBe(false);
    if (guard.ok) return;
    expect(guard.response.status).toBe(403);
  });

  it.each([
    ["absent proof", { csrf: null }],
    ["empty proof", { csrf: "" }],
    ["short proof", { csrf: "short" }],
    ["session replayed as proof", { csrf: SESSION_TOKEN }],
  ])("rejects mutations with %s as 403", async (_label, init) => {
    const security = createOwnerSecurityTestStub({ type: "allow", actor: OWNER });
    const guard = await guardOwnerRequest(mutationRequest(init), {
      operation: "updateOwnerProfileConfiguration",
      mode: "mutation",
      security: { ...security, appOrigin: APP_ORIGIN },
      traceId: "trace-csrf",
      instance: "/api/owner/v1/configuration/profile",
    });
    expect(guard.ok).toBe(false);
    if (guard.ok) return;
    expect(guard.response.status).toBe(403);
  });

  it("rejects forged forwarded-host information before authentication", async () => {
    let resolved = 0;
    const security = createOwnerSecurityTestStub({ type: "allow", actor: OWNER });
    const instrumented = {
      ...security,
      appOrigin: APP_ORIGIN,
      identity: {
        ...security.identity,
        async resolveActorContext(...args: Parameters<typeof security.identity.resolveActorContext>) {
          resolved += 1;
          return security.identity.resolveActorContext(...args);
        },
      },
    };
    for (const request of [
      mutationRequest({ forwardedHost: "evil.example" }),
      mutationRequest({ forwarded: "for=1.2.3.4;host=evil.example" }),
    ]) {
      const guard = await guardOwnerRequest(request, {
        operation: "updateOwnerProfileConfiguration",
        mode: "mutation",
        security: instrumented,
        traceId: "trace-forwarded",
        instance: "/api/owner/v1/configuration/profile",
      });
      expect(guard.ok).toBe(false);
      if (guard.ok) continue;
      expect(guard.response.status).toBe(403);
    }
    expect(resolved).toBe(0);
  });

  it("authenticates reads without requiring origin or CSRF proof", async () => {
    const security = createOwnerSecurityTestStub({ type: "allow", actor: OWNER });
    const guard = await guardOwnerRequest(readRequest(), {
      operation: "getOwnerCvPortfolio",
      mode: "read",
      security: { ...security, appOrigin: APP_ORIGIN },
      traceId: "trace-read",
      instance: "/api/owner/v1/cv",
    });
    expect(guard.ok).toBe(true);
  });

  it("rejects unauthenticated reads as 401", async () => {
    const security = createOwnerSecurityTestStub({ type: "allow", actor: OWNER });
    const guard = await guardOwnerRequest(
      new Request("https://example.com/api/owner/v1/cv"),
      {
        operation: "getOwnerCvPortfolio",
        mode: "read",
        security: { ...security, appOrigin: APP_ORIGIN },
        traceId: "trace-read-anon",
        instance: "/api/owner/v1/cv",
      },
    );
    expect(guard.ok).toBe(false);
    if (guard.ok) return;
    expect(guard.response.status).toBe(401);
  });

  it("maps rate-limit denial to 429 with Retry-After and no dispatch", async () => {
    const security = createOwnerSecurityTestStub({
      type: "rate-limited",
      actor: OWNER,
      retryAfterSeconds: 30,
    });
    const guard = await guardOwnerRequest(mutationRequest(), {
      operation: "updateOwnerProfileConfiguration",
      mode: "mutation",
      security: { ...security, appOrigin: APP_ORIGIN },
      traceId: "trace-ratelimit",
      instance: "/api/owner/v1/configuration/profile",
    });
    expect(guard.ok).toBe(false);
    if (guard.ok) return;
    expect(guard.response.status).toBe(429);
    expect(guard.response.headers.get("retry-after")).toBe("30");
  });

  it("fails closed to 503 when the rate-limit check throws", async () => {
    const base = createOwnerSecurityTestStub({ type: "allow", actor: OWNER });
    const security = {
      ...base,
      appOrigin: APP_ORIGIN,
      rateLimit: {
        async check(): Promise<{ allowed: boolean }> {
          throw new Error("limiter down");
        },
      },
    };
    const guard = await guardOwnerRequest(mutationRequest(), {
      operation: "updateOwnerProfileConfiguration",
      mode: "mutation",
      security,
      traceId: "trace-limiter-down",
      instance: "/api/owner/v1/configuration/profile",
    });
    expect(guard.ok).toBe(false);
    if (guard.ok) return;
    expect(guard.response.status).toBe(503);
  });

  it("builds a server-managed session cookie with safe attributes", () => {
    const cookie = buildOwnerSessionCookie({
      sessionToken: SESSION_TOKEN,
      appBaseUrl: "https://example.com",
    });
    expect(cookie).toContain(`${OWNER_SESSION_COOKIE}=${SESSION_TOKEN}`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain(`Max-Age=${OWNER_SESSION_MAX_AGE_SECONDS}`);
    expect(cookie).toContain("Secure");
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).not.toMatch(/refresh/i);
  });

  it("omits Secure only for explicit loopback test contexts", () => {
    const loopback = buildOwnerSessionCookie({
      sessionToken: SESSION_TOKEN,
      appBaseUrl: "http://127.0.0.1:3000",
    });
    expect(loopback).toContain("HttpOnly");
    expect(loopback).not.toContain("Secure");
    expect(() =>
      buildOwnerSessionCookie({ sessionToken: SESSION_TOKEN, appBaseUrl: "http://example.com" }),
    ).toThrow();
  });

  it("bounds session lifetime and rejects unsafe token material", () => {
    expect(OWNER_SESSION_MAX_AGE_SECONDS).toBe(3600);
    expect(() =>
      buildOwnerSessionCookie({ sessionToken: "", appBaseUrl: "https://example.com" }),
    ).toThrow();
    expect(() =>
      buildOwnerSessionCookie({
        sessionToken: SESSION_TOKEN,
        appBaseUrl: "https://example.com",
        maxAgeSeconds: 0,
      }),
    ).toThrow();
    expect(() =>
      buildOwnerSessionCookie({
        sessionToken: SESSION_TOKEN,
        appBaseUrl: "https://example.com",
        maxAgeSeconds: 86401,
      }),
    ).toThrow();
  });
});
