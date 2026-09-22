/**
 * current-cv.test.ts — Phase 2 #28
 *
 * Seam under test (pre-agreed): the Current CV HTTP adapter observed
 * through standard Request and Response objects with an injected
 * application fake.
 *
 * Acceptance (issue #28):
 * - The Current CV adapter validates query inputs with generated strict
 *   validators before dispatch, constructs one query, and invokes one
 *   injected application interface exactly once.
 * - The adapter exercises the declared redirect shape without accessing
 *   storage; successful fake output is validated before the declared
 *   response is emitted, and invalid fake output fails safely.
 * - Production composition fails closed with the declared 503 response and
 *   stable RUNTIME_NOT_IMPLEMENTED code rather than fabricating a stream
 *   or redirect.
 * - Invalid transport input never calls the application fake.
 * - Every request receives a server-generated correlation identifier; the
 *   same value appears in Problem Details and structured log events.
 */

import { describe, expect, it } from "vitest";

import { zProblem } from "../../src/contracts/http/v1/generated/zod.gen.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import {
  createProductionCurrentCvService,
  createCurrentCvTestFake,
} from "../../src/runtime/fakes/current-cv.js";
import { handleGetCurrentCv } from "../../src/runtime/http/current-cv.js";

const SIGNED_URL = "https://storage.example/signed/current-cv?token=fake";

function getCvRequest(query = "locale=en&disposition=inline", options?: { inboundTrace?: string }): Request {
  const headers: Record<string, string> = {};
  if (options?.inboundTrace !== undefined) {
    headers["x-request-id"] = options.inboundTrace;
  }
  return new Request(`https://example.com/api/v1/cv/current?${query}`, { headers });
}

describe("GET Current CV adapter (#28)", () => {
  it("dispatches once and returns the declared 307 redirect without storage", async () => {
    const fake = createCurrentCvTestFake({ type: "redirect" });
    const logger = createTestLogger();
    const response = await handleGetCurrentCv(getCvRequest(), { service: fake, logger });
    expect(response.status).toBe(307);
    expect(fake.calls).toHaveLength(1);
    expect(response.headers.get("location")).toBe(SIGNED_URL);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const logged = logger.records.find((record) => record.event === "request.completed");
    expect(logged).toBeDefined();
    expect((logged as { fields: Record<string, unknown> }).fields["status"]).toBe(307);
  });

  it.each([
    ["missing locale", "disposition=inline"],
    ["invalid locale", "locale=ar"],
    ["invalid disposition", "locale=en&disposition=preview"],
    ["unknown closed-shape property", "locale=en&extra=nope"],
    ["duplicate query key", "locale=en&locale=en"],
  ])("rejects %s as 400 before dispatch", async (_label, query) => {
    const fake = createCurrentCvTestFake({ type: "redirect" });
    const logger = createTestLogger();
    const response = await handleGetCurrentCv(getCvRequest(query), { service: fake, logger });
    expect(response.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
    const body = (await response.json()) as Record<string, unknown>;
    expect(zProblem.safeParse(body).success).toBe(true);
    expect(body["code"]).toBe("validation");
  });

  it.each([
    ["not_found", { kind: "not_found", code: "CV_NOT_FOUND" }, 404, "not_found"],
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
      const fake = createCurrentCvTestFake({ type: "rejection", rejection });
      const logger = createTestLogger();
      const response = await handleGetCurrentCv(getCvRequest(), { service: fake, logger });
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
    const fake = createCurrentCvTestFake({ type: "invalid-redirect" });
    const logger = createTestLogger();
    const response = await handleGetCurrentCv(getCvRequest(), { service: fake, logger });
    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("internal_error");
  });

  it("production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED", async () => {
    const service = createProductionCurrentCvService();
    const direct = await service.downloadCurrentCv({
      actor: { kind: "visitor", consent: "unknown" },
    });
    expect(direct.ok).toBe(false);
    if (!direct.ok) {
      expect(direct.error.kind).toBe("temporarily_unavailable");
      expect(direct.error.code).toBe("RUNTIME_NOT_IMPLEMENTED");
    }
    const logger = createTestLogger();
    const response = await handleGetCurrentCv(getCvRequest(), { service, logger });
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("temporarily_unavailable");
    expect(zProblem.safeParse(body).success).toBe(true);
  });

  it("uses a server-generated trace identifier shared by Problem Details and logs", async () => {
    const fake = createCurrentCvTestFake({
      type: "rejection",
      rejection: { kind: "not_found", code: "CV_NOT_FOUND" },
    });
    const logger = createTestLogger();
    const first = await handleGetCurrentCv(getCvRequest("locale=en", { inboundTrace: "inbound-attacker-value" }), {
      service: fake,
      logger,
    });
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody["traceId"]).not.toBe("inbound-attacker-value");
    const logged = (logger.records[0] as { fields: Record<string, unknown> }).fields;
    expect(logged["traceId"]).toBe(firstBody["traceId"]);

    const secondLogger = createTestLogger();
    const second = await handleGetCurrentCv(getCvRequest(), { service: fake, logger: secondLogger });
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody["traceId"]).not.toBe(firstBody["traceId"]);
  });

  it("maps unexpected exceptions to generic 500 without leaking secrets", async () => {
    const logger = createTestLogger();
    const throwing = {
      calls: [] as unknown[],
      async downloadCurrentCv(): Promise<never> {
        throw new Error("boom postgres://user:pass@host/db token=tok_123 /app/secret.ts");
      },
    };
    const response = await handleGetCurrentCv(getCvRequest(), { service: throwing, logger });
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
