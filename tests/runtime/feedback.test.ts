/**
 * feedback.test.ts — Phase 2 #28
 *
 * Seam under test (pre-agreed): the Feedback HTTP adapter observed through
 * standard Request and Response objects with an injected application fake.
 *
 * Acceptance (issue #28):
 * - The Feedback adapter validates path, headers, and body with generated
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
  zPostProjectFeedbackResponse,
  zProblem,
} from "../../src/contracts/http/v1/generated/zod.gen.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import {
  createProductionFeedbackService,
  createFeedbackTestFake,
} from "../../src/runtime/fakes/feedback.js";
import { handlePostProjectFeedback } from "../../src/runtime/http/feedback.js";

const PROJECT_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e8f";
const FEEDBACK_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e91";
const IDEMPOTENCY_KEY = "test-key-123";

function postFeedbackRequest(options?: {
  projectId?: string;
  idempotencyKey?: string | null;
  body?: unknown;
  rawBody?: string;
  inboundTrace?: string;
}): Request {
  const projectId = options?.projectId ?? PROJECT_ID;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options?.idempotencyKey !== null) {
    headers["Idempotency-Key"] = options?.idempotencyKey ?? IDEMPOTENCY_KEY;
  }
  if (options?.inboundTrace !== undefined) {
    headers["x-request-id"] = options.inboundTrace;
  }
  const init: RequestInit = { method: "POST", headers };
  if (options?.rawBody !== undefined) {
    init.body = options.rawBody;
  } else if (options?.body !== undefined) {
    init.body = JSON.stringify(options.body);
  } else {
    init.body = JSON.stringify({
      name: "Ada",
      paragraph: "Clear explanation of the engineering tradeoffs.",
      locale: "en",
    });
  }
  return new Request(`https://example.com/api/v1/projects/${projectId}/feedback`, init);
}

describe("POST Feedback adapter (#28)", () => {
  it("dispatches once and returns the contract-declared 201 receipt", async () => {
    const fake = createFeedbackTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handlePostProjectFeedback(
      postFeedbackRequest(),
      { projectId: PROJECT_ID },
      { service: fake, logger },
    );
    expect(response.status).toBe(201);
    expect(fake.calls).toHaveLength(1);
    const command = fake.calls[0] as {
      projectId: string;
      authorName: string;
      comment: string;
      idempotencyKey: string;
    };
    expect(command.projectId).toBe(PROJECT_ID);
    expect(command.authorName).toBe("Ada");
    expect(command.comment).toBe("Clear explanation of the engineering tradeoffs.");
    expect(command.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    const body = (await response.json()) as unknown;
    expect(zPostProjectFeedbackResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({ feedbackId: FEEDBACK_ID, projectId: PROJECT_ID, status: "pending" });
  });

  it.each([
    ["malformed JSON", { rawBody: "{not-json" }],
    ["missing Idempotency-Key", { idempotencyKey: null }],
    ["invalid projectId", { projectId: "not-a-uuid" }],
    ["absent body fields", { body: {} }],
    ["empty name", { body: { name: "", paragraph: "Valid paragraph.", locale: "en" } }],
    ["empty paragraph", { body: { name: "Ada", paragraph: "", locale: "en" } }],
    ["invalid enum", { body: { name: "Ada", paragraph: "Valid.", locale: "xx" } }],
    ["out-of-shape body", { body: [] }],
    ["unknown closed-shape property", { body: { name: "Ada", paragraph: "Valid.", locale: "en", extra: "nope" } }],
  ])("rejects %s as 400 before dispatch", async (_label, options) => {
    const fake = createFeedbackTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handlePostProjectFeedback(
      postFeedbackRequest(options),
      { projectId: (options as { projectId?: string }).projectId ?? PROJECT_ID },
      { service: fake, logger },
    );
    expect(response.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
    const body = (await response.json()) as Record<string, unknown>;
    expect(zProblem.safeParse(body).success).toBe(true);
    expect(body["code"]).toBe("validation");
  });

  it.each([
    ["forbidden", { kind: "forbidden", code: "FEEDBACK_FORBIDDEN" }, 403, "forbidden"],
    ["not_found", { kind: "not_found", code: "PROJECT_NOT_FOUND" }, 404, "not_found"],
    ["conflict", { kind: "conflict", code: "IDEMPOTENCY_CONFLICT" }, 409, "conflict"],
    ["validation", { kind: "validation", code: "FEEDBACK_REJECTED" }, 422, "unprocessable"],
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
      const fake = createFeedbackTestFake({ type: "rejection", rejection });
      const logger = createTestLogger();
      const response = await handlePostProjectFeedback(
        postFeedbackRequest(),
        { projectId: PROJECT_ID },
        { service: fake, logger },
      );
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
    const fake = createFeedbackTestFake({ type: "invalid-success" });
    const logger = createTestLogger();
    const response = await handlePostProjectFeedback(
      postFeedbackRequest(),
      { projectId: PROJECT_ID },
      { service: fake, logger },
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("internal_error");
  });

  it("production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED", async () => {
    const service = createProductionFeedbackService();
    const direct = await service.submitFeedback({ scope: { kind: "unconfigured" }, correlationId: "direct-test",
      actor: { kind: "visitor", consent: "unknown" },
      idempotencyKey: IDEMPOTENCY_KEY as never,
      projectId: PROJECT_ID as never,
      authorName: "Ada",
      comment: "Clear explanation.",
      locale: "en",
    });
    expect(direct.ok).toBe(false);
    if (!direct.ok) {
      expect(direct.error.kind).toBe("temporarily_unavailable");
      expect(direct.error.code).toBe("RUNTIME_NOT_IMPLEMENTED");
    }
    const logger = createTestLogger();
    const response = await handlePostProjectFeedback(
      postFeedbackRequest(),
      { projectId: PROJECT_ID },
      { service, logger },
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("temporarily_unavailable");
    expect(zProblem.safeParse(body).success).toBe(true);
  });

  it("uses a server-generated trace identifier shared by Problem Details and logs", async () => {
    const fake = createFeedbackTestFake({
      type: "rejection",
      rejection: { kind: "not_found", code: "PROJECT_NOT_FOUND" },
    });
    const logger = createTestLogger();
    const first = await handlePostProjectFeedback(
      postFeedbackRequest({ inboundTrace: "inbound-attacker-value" }),
      { projectId: PROJECT_ID },
      { service: fake, logger },
    );
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody["traceId"]).not.toBe("inbound-attacker-value");
    const logged = (logger.records[0] as { fields: Record<string, unknown> }).fields;
    expect(logged["traceId"]).toBe(firstBody["traceId"]);

    const secondLogger = createTestLogger();
    const second = await handlePostProjectFeedback(
      postFeedbackRequest(),
      { projectId: PROJECT_ID },
      { service: fake, logger: secondLogger },
    );
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody["traceId"]).not.toBe(firstBody["traceId"]);
  });

  it("maps unexpected exceptions to generic 500 without leaking secrets", async () => {
    const logger = createTestLogger();
    const throwing = {
      calls: [] as unknown[],
      async submitFeedback(): Promise<never> {
        throw new Error("boom postgres://user:pass@host/db token=tok_123 /app/secret.ts");
      },
    };
    const response = await handlePostProjectFeedback(
      postFeedbackRequest(),
      { projectId: PROJECT_ID },
      { service: throwing, logger },
    );
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
