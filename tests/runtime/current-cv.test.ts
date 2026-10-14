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
import { createBoundedCurrentCvRateLimit } from "../../src/runtime/http/current-cv-rate-limit.js";
import type { CurrentCvRateLimitCheck } from "../../src/runtime/http/current-cv-rate-limit.js";
import { sanitizeEvidenceOutput } from "../../scripts/phase4-gate-support.mjs";

const SIGNED_URL = "https://storage.example/signed/current-cv?token=fake";

function getCvRequest(query = "locale=en&disposition=inline", options?: { inboundTrace?: string }): Request {
  const headers: Record<string, string> = {};
  if (options?.inboundTrace !== undefined) {
    headers["x-request-id"] = options.inboundTrace;
  }
  return new Request(`https://example.com/api/v1/cv/current?${query}`, { headers });
}

const allowCurrentCvRequests: CurrentCvRateLimitCheck = { async check() { return { allowed: true }; } };
type TestCurrentCvDeps = Omit<Parameters<typeof handleGetCurrentCv>[1], "rateLimit"> & { rateLimit?: CurrentCvRateLimitCheck };
function handleCurrentCv(request: Request, deps: TestCurrentCvDeps): Promise<Response> {
  return handleGetCurrentCv(request, { ...deps, rateLimit: deps.rateLimit ?? allowCurrentCvRequests });
}

describe("GET Current CV adapter (#28)", () => {
  it("redacts private diagnostics before evidence export", () => {
    const signedUrl = "https://storage.example/download/current-cv?token=signed-url-sentinel";
    const scannerDump = "scanner-output-sentinel";
    const originalFilename = "../../private/current-cv.pdf";
    const cvBytes = "%PDF-private-bytes-sentinel";
    const providerMapping = "provider-user-sentinel";
    const workspace = "C:\\runner\\workspace";
    const temporary = "C:\\runner\\tmp";
    const diagnostic = [
      "postgresql://user:db-secret-sentinel@db.example/private",
      "Bearer auth-token-sentinel",
      signedUrl,
      scannerDump,
      originalFilename,
      cvBytes,
      providerMapping,
      workspace,
      temporary,
    ].join(" ");
    const safe = sanitizeEvidenceOutput(diagnostic, {
      workspace,
      temporary,
      secrets: [signedUrl, scannerDump, originalFilename, cvBytes, providerMapping],
    });
    for (const value of ["db-secret-sentinel", "auth-token-sentinel", signedUrl, scannerDump,
      originalFilename, cvBytes, providerMapping, workspace, temporary]) {
      expect(safe).not.toContain(value);
    }
  });

  it("dispatches once and returns the declared 307 redirect without storage", async () => {
    const fake = createCurrentCvTestFake({ type: "redirect" });
    const logger = createTestLogger();
    const response = await handleCurrentCv(getCvRequest(), {
      service: fake, logger, allowedRedirectOrigins: ["https://storage.example"],
    });
    expect(response.status).toBe(307);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ locale: "en", disposition: "inline" });
    expect(response.headers.get("location")).toBe(SIGNED_URL);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const logged = logger.records.find((record) => record.event === "request.completed");
    expect(logged).toBeDefined();
    expect((logged as { fields: Record<string, unknown> }).fields["status"]).toBe(307);
  });

  it("binds the requested attachment disposition to the application query", async () => {
    const fake = createCurrentCvTestFake({ type: "redirect" });
    const response = await handleCurrentCv(
      getCvRequest("locale=en&disposition=attachment"),
      { service: fake, allowedRedirectOrigins: ["https://storage.example"] },
    );
    expect(response.status).toBe(307);
    expect(fake.calls[0]).toMatchObject({ locale: "en", disposition: "attachment" });
  });

  it("streams the declared PDF branch with no-store and safe disposition", async () => {
    const fake = createCurrentCvTestFake({
      type: "stream",
      chunks: [new Uint8Array([37, 80]), new Uint8Array([68, 70])],
    });
    const response = await handleCurrentCv(
      getCvRequest("locale=en&disposition=attachment"),
      { service: fake },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="cv.pdf"');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([37, 80, 68, 70]);
  });

  it("limits repeated client requests before application dispatch and sends Retry-After", async () => {
    const fake = createCurrentCvTestFake({ type: "stream", chunks: [new Uint8Array([37, 80, 68, 70, 45])] });
    const limiter = createBoundedCurrentCvRateLimit({
      clientKey: (request) => request.headers.get("x-test-client") ?? "",
      maxRequests: 1,
      windowSeconds: 60,
      now: () => 1_000,
    });
    const request = () => new Request("https://example.com/api/v1/cv/current?locale=en", {
      headers: { "x-test-client": "client-a" },
    });
    const first = await handleCurrentCv(request(), { service: fake, rateLimit: limiter });
    const second = await handleCurrentCv(request(), { service: fake, rateLimit: limiter });
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("60");
    expect(fake.calls).toHaveLength(1);
  });

  it("fails closed when the hosting rate limiter is unavailable", async () => {
    const fake = createCurrentCvTestFake({ type: "stream", chunks: [] });
    const response = await handleCurrentCv(getCvRequest(), {
      service: fake, rateLimit: { async check() { throw new Error("limiter offline"); } },
    });
    expect(response.status).toBe(503);
    expect(fake.calls).toHaveLength(0);
    expect(JSON.stringify(await response.json())).not.toContain("limiter offline");
  });

  it("returns a truthful 503 when Current CV delivery is unavailable", async () => {
    const fake = createCurrentCvTestFake({ type: "rejection", rejection: {
      kind: "temporarily_unavailable", code: "CURRENT_CV_STORAGE_UNAVAILABLE",
    } });
    const response = await handleCurrentCv(getCvRequest(), { service: fake });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "temporarily_unavailable" });
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
    const response = await handleCurrentCv(getCvRequest(query), { service: fake, logger });
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
      const response = await handleCurrentCv(getCvRequest(), { service: fake, logger });
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
    const response = await handleCurrentCv(getCvRequest(), { service: fake, logger });
    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("internal_error");
  });

  it.each([
    ["unlisted origin", "https://evil.example/cv.pdf"],
    ["insecure URL", "http://storage.example/cv.pdf"],
  ])("rejects a redirect with %s", async (_label, downloadUrl) => {
    const fake = createCurrentCvTestFake({ type: "redirect", downloadUrl });
    const logger = createTestLogger();
    const response = await handleCurrentCv(getCvRequest(), {
      service: fake, logger, allowedRedirectOrigins: ["https://storage.example"],
    });
    expect(response.status).toBe(500);
    const serialized = JSON.stringify(await response.json());
    expect(JSON.parse(serialized).code).toBe("internal_error");
    expect(serialized).not.toContain(downloadUrl);
    expect(JSON.stringify(logger.records)).not.toContain(downloadUrl);
  });

  it("production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED", async () => {
    const service = createProductionCurrentCvService();
    const direct = await service.downloadCurrentCv({
      actor: { kind: "visitor", consent: "unknown" },
      locale: "en",
      disposition: "inline",
    });
    expect(direct.ok).toBe(false);
    if (!direct.ok) {
      expect(direct.error.kind).toBe("temporarily_unavailable");
      expect(direct.error.code).toBe("RUNTIME_NOT_IMPLEMENTED");
    }
    const logger = createTestLogger();
    const response = await handleCurrentCv(getCvRequest(), { service, logger });
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
    const first = await handleCurrentCv(getCvRequest("locale=en", { inboundTrace: "inbound-attacker-value" }), {
      service: fake,
      logger,
    });
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody["traceId"]).not.toBe("inbound-attacker-value");
    const logged = (logger.records[0] as { fields: Record<string, unknown> }).fields;
    expect(logged["traceId"]).toBe(firstBody["traceId"]);

    const secondLogger = createTestLogger();
    const second = await handleCurrentCv(getCvRequest(), { service: fake, logger: secondLogger });
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
    const response = await handleCurrentCv(getCvRequest(), { service: throwing, logger });
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
