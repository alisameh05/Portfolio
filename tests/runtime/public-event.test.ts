/**
 * public-event.test.ts — Phase 2 #28
 *
 * Seam under test (pre-agreed): the Public event HTTP adapter observed
 * through standard Request and Response objects with an injected
 * application fake.
 *
 * Acceptance (issue #28):
 * - The Public event adapter validates headers and body with generated
 *   strict validators before dispatch, rejects unknown properties for
 *   closed shapes, constructs one command, and invokes one injected
 *   application interface exactly once.
 * - Deterministic test fakes can produce every declared success and
 *   rejection, and successful output is validated before a
 *   contract-declared response is emitted.
 * - Production composition fails closed with the declared 503 response and
 *   stable RUNTIME_NOT_IMPLEMENTED code rather than fabricating a result.
 * - Invalid transport input never calls the application fake.
 * - Every request receives a server-generated correlation identifier; the
 *   same value appears in Problem Details and structured log events.
 */

import { describe, expect, it } from "vitest";

import {
  zPostPublicEventResponse,
  zProblem,
} from "../../src/contracts/http/v1/generated/zod.gen.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import {
  createProductionPublicEventService,
  createPublicEventTestFake,
} from "../../src/runtime/fakes/public-event.js";
import { handlePostPublicEvent as rawHandlePostPublicEvent } from "../../src/runtime/http/public-event.js";

// Explicit edge fake keeps transport/rejection tests independent of real crypto tests.
const handlePostPublicEvent: typeof rawHandlePostPublicEvent = (request, deps) => rawHandlePostPublicEvent(request, {
  ...deps, consent: { async verifyEvidence(query) { return { ok: true, value: {
    purpose: "measurement", subject: EVENT_ID as never, portfolioId: PROJECT_ID as never, consentId: EVENT_ID as never,
    noticeVersion: query.noticeVersion, revision: 1, issuedAt: "2026-10-14T12:00:00.000Z", expiresAt: "2026-11-13T12:00:00.000Z",
  } }; } },
});
const IDEMPOTENCY_KEY = "test-key-123";
const PROJECT_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e8f";
const ROUTE_IDENTITY = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e93";
const EVENT_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e92";

function validContext() {
  return {
    occurredAt: "2026-09-17T12:00:00.000Z",
    locale: "en",
    consentVersion: "2026-09",
    pageRouteIdentity: ROUTE_IDENTITY,
    referrerClass: "professional",
    deviceClass: "desktop",
    countryCode: "EG",
  };
}

function postEventRequest(options?: {
  idempotencyKey?: string | null;
  body?: unknown;
  rawBody?: string;
  inboundTrace?: string;
  cookie?: string;
}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", cookie: "sw_analytics_consent=test-evidence" };
  if (options?.idempotencyKey !== null) {
    headers["Idempotency-Key"] = options?.idempotencyKey ?? IDEMPOTENCY_KEY;
  }
  if (options?.inboundTrace !== undefined) {
    headers["x-request-id"] = options.inboundTrace;
  }
  if (options?.cookie !== undefined) {
    headers["cookie"] = options.cookie;
  }
  const init: RequestInit = { method: "POST", headers };
  if (options?.rawBody !== undefined) {
    init.body = options.rawBody;
  } else if (options?.body !== undefined) {
    init.body = options.body === null ? "" : JSON.stringify(options.body);
  } else {
    init.body = JSON.stringify({ action: "project-viewed", projectId: PROJECT_ID, context: validContext() });
  }
  return new Request("https://example.com/api/v1/events", init);
}

describe("POST Public event adapter (#28)", () => {
  it("dispatches once and returns the contract-declared 202 receipt", async () => {
    const fake = createPublicEventTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handlePostPublicEvent(postEventRequest(), { service: fake, logger });
    expect(response.status).toBe(202);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ event: { action: "project-viewed", projectId: PROJECT_ID, context: validContext() }, idempotencyKey: IDEMPOTENCY_KEY, actor: { kind: "visitor" } });
    const body = (await response.json()) as unknown;
    expect(zPostPublicEventResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({ eventId: EVENT_ID, acceptedAt: expect.any(String) });
  });

  it("cookie presence alone cannot grant consent or dispatch an event", async () => {
    const fake = createPublicEventTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await rawHandlePostPublicEvent(postEventRequest({ cookie: "sw_analytics_consent=signed-value-123" }), { service: fake, logger });
    expect(response.status).toBe(403);
    expect(fake.calls).toHaveLength(0);
    expect(JSON.stringify(logger.records)).not.toContain("signed-value-123");
  });

  it.each([
    ["malformed JSON", { rawBody: "{not-json" }],
    ["missing Idempotency-Key", { idempotencyKey: null }],
    ["absent body", { body: null }],
    ["invalid enum", { body: { action: "project-liked", projectId: PROJECT_ID, context: validContext() } }],
    ["out-of-range value", { body: { action: "active-engagement-sampled", projectId: PROJECT_ID, activeMilliseconds: 50, context: validContext() } }],
    ["out-of-shape body", { body: [] }],
    ["unknown closed-shape property", { body: { action: "project-viewed", projectId: PROJECT_ID, context: validContext(), extra: "nope" } }],
    ["unknown context property", { body: { action: "project-viewed", projectId: PROJECT_ID, context: { ...validContext(), extra: "nope" } } }],
  ])("rejects %s as 400 before dispatch", async (_label, options) => {
    const fake = createPublicEventTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handlePostPublicEvent(postEventRequest(options), {
      service: fake,
      logger,
    });
    expect(response.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
    const body = (await response.json()) as Record<string, unknown>;
    expect(zProblem.safeParse(body).success).toBe(true);
    expect(body["code"]).toBe("validation");
  });

  it.each([
    ["forbidden", { kind: "forbidden", code: "EVENT_FORBIDDEN" }, 403, "forbidden"],
    ["conflict", { kind: "conflict", code: "IDEMPOTENCY_CONFLICT" }, 409, "conflict"],
    ["validation", { kind: "validation", code: "EVENT_REJECTED" }, 422, "unprocessable"],
    [
      "rate_limited",
      { kind: "rate_limited", code: "RATE_LIMIT_EXCEEDED", retryAfterSeconds: 30 },
      429,
      "rate_limited",
    ],
    [
      "temporarily_unavailable",
      { kind: "temporarily_unavailable", code: "DEPENDENCY_DOWN" },
      503,
      "temporarily_unavailable",
    ],
  ] as const)(
    "translates declared %s rejection to %i",
    async (_label, rejection, status, problemCode) => {
      const fake = createPublicEventTestFake({ type: "rejection", rejection });
      const logger = createTestLogger();
      const response = await handlePostPublicEvent(postEventRequest(), {
        service: fake,
        logger,
      });
      expect(response.status).toBe(status);
      expect(fake.calls).toHaveLength(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it("fails safely when fake output is contract-invalid", async () => {
    const fake = createPublicEventTestFake({ type: "invalid-success" });
    const logger = createTestLogger();
    const response = await handlePostPublicEvent(postEventRequest(), {
      service: fake,
      logger,
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("internal_error");
  });

  it("production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED", async () => {
    const service = createProductionPublicEventService();
    const direct = await service.ingestEvent({ scope: { kind: "unconfigured" }, correlationId: "direct-test",
      actor: { kind: "visitor", consent: "unknown" },
      idempotencyKey: IDEMPOTENCY_KEY as never,
      event: { action: "page-viewed", context: { ...validContext(), locale: "en", pageRouteIdentity: ROUTE_IDENTITY as never, deviceClass: "desktop", referrerClass: "professional" } },
    });
    expect(direct.ok).toBe(false);
    if (!direct.ok) {
      expect(direct.error.kind).toBe("temporarily_unavailable");
      expect(direct.error.code).toBe("RUNTIME_NOT_IMPLEMENTED");
    }
    const logger = createTestLogger();
    const response = await handlePostPublicEvent(postEventRequest(), {
      service,
      logger,
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("temporarily_unavailable");
    expect(zProblem.safeParse(body).success).toBe(true);
  });

  it("uses a server-generated trace identifier shared by Problem Details and logs", async () => {
    const fake = createPublicEventTestFake({
      type: "rejection",
      rejection: { kind: "conflict", code: "IDEMPOTENCY_CONFLICT" },
    });
    const logger = createTestLogger();
    const first = await handlePostPublicEvent(
      postEventRequest({ inboundTrace: "inbound-attacker-value" }),
      { service: fake, logger },
    );
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody["traceId"]).not.toBe("inbound-attacker-value");
    const logged = (logger.records[0] as { fields: Record<string, unknown> }).fields;
    expect(logged["traceId"]).toBe(firstBody["traceId"]);

    const secondLogger = createTestLogger();
    const second = await handlePostPublicEvent(postEventRequest(), {
      service: fake,
      logger: secondLogger,
    });
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody["traceId"]).not.toBe(firstBody["traceId"]);
  });

  it("maps unexpected exceptions to generic 500 without leaking secrets", async () => {
    const logger = createTestLogger();
    const throwing = {
      calls: [] as unknown[],
      async ingestEvent(): Promise<never> {
        throw new Error("boom postgres://user:pass@host/db token=tok_123 /app/secret.ts");
      },
    };
    const response = await handlePostPublicEvent(postEventRequest(), {
      service: throwing,
      logger,
    });
    expect(response.status).toBe(500);
    const serialized = JSON.stringify(await response.json());
    for (const leak of ["postgres://", "tok_123", "/app/secret.ts", "boom"]) {
      expect(serialized).not.toContain(leak);
    }
    const logs = JSON.stringify(logger.records);
    expect(logs).not.toContain("postgres://");
    expect(logs).not.toContain("tok_123");
    expect(logs).not.toContain("/app/secret.ts");
  });
});
