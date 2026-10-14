/**
 * reaction.test.ts — Phase 2 #26
 *
 * Seam under test (pre-agreed): the Reaction HTTP adapter observed through
 * standard Request and Response objects with an injected application fake.
 *
 * Acceptance (issue #26):
 * - The Reaction adapter validates path, headers, and body with generated
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
  zPutProjectReactionResponse,
  zProblem,
} from "../../src/contracts/http/v1/generated/zod.gen.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import {
  createProductionReactionService,
  createReactionTestFake,
} from "../../src/runtime/fakes/reaction.js";
import { handlePutProjectReaction } from "../../src/runtime/http/reaction.js";

const PROJECT_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e8f";
const IDEMPOTENCY_KEY = "test-key-123";

function putReactionRequest(options?: {
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
  const init: RequestInit = { method: "PUT", headers };
  if (options?.rawBody !== undefined) {
    init.body = options.rawBody;
  } else if (options?.body !== undefined) {
    init.body = JSON.stringify(options.body);
  } else {
    init.body = JSON.stringify({ reaction: "like" });
  }
  return new Request(`https://example.com/api/v1/projects/${projectId}/reaction`, init);
}

describe("PUT Reaction adapter (#26)", () => {
  it("dispatches once and returns the contract-declared success response", async () => {
    const fake = createReactionTestFake({ type: "success", reaction: "like" });
    const logger = createTestLogger();
    const response = await handlePutProjectReaction(
      putReactionRequest(),
      { projectId: PROJECT_ID },
      { service: fake, logger },
    );
    expect(response.status).toBe(200);
    expect(fake.calls).toHaveLength(1);
    const command = fake.calls[0] as { projectId: string; kind: string; idempotencyKey: string };
    expect(command.projectId).toBe(PROJECT_ID);
    expect(command.kind).toBe("like");
    expect(command.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    const body = (await response.json()) as unknown;
    expect(zPutProjectReactionResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({ projectId: PROJECT_ID, reaction: "like" });
  });

  it.each([
    ["malformed JSON", { rawBody: "{not-json" }],
    ["missing Idempotency-Key", { idempotencyKey: null }],
    ["invalid projectId", { projectId: "not-a-uuid" }],
    ["absent reaction", { body: {} }],
    ["invalid enum", { body: { reaction: "love" } }],
    ["out-of-shape body", { body: [] }],
    ["unknown closed-shape property", { body: { reaction: "like", extra: "nope" } }],
  ])("rejects %s as 400 before dispatch", async (_label, options) => {
    const fake = createReactionTestFake({ type: "success", reaction: "like" });
    const logger = createTestLogger();
    const response = await handlePutProjectReaction(
      putReactionRequest(options),
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
    ["forbidden", { kind: "forbidden", code: "REACTION_FORBIDDEN" }, 403, "forbidden"],
    ["not_found", { kind: "not_found", code: "PROJECT_NOT_FOUND" }, 404, "not_found"],
    ["conflict", { kind: "conflict", code: "IDEMPOTENCY_CONFLICT" }, 409, "conflict"],
    ["validation", { kind: "validation", code: "REACTION_REJECTED" }, 422, "unprocessable"],
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
      const fake = createReactionTestFake({ type: "rejection", rejection });
      const logger = createTestLogger();
      const response = await handlePutProjectReaction(
        putReactionRequest(),
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
    const fake = createReactionTestFake({ type: "invalid-success" });
    const logger = createTestLogger();
    const response = await handlePutProjectReaction(
      putReactionRequest(),
      { projectId: PROJECT_ID },
      { service: fake, logger },
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("internal_error");
  });

  it("accepts an injected clock and logs the stable rejection code", async () => {
    const fixedNow = "2026-09-20T12:00:00.000Z";
    const fake = createReactionTestFake({ type: "success", reaction: "dislike" }, {
      now: () => fixedNow,
    });
    const logger = createTestLogger();
    const response = await handlePutProjectReaction(
      putReactionRequest({ body: { reaction: "dislike" } }),
      { projectId: PROJECT_ID },
      { service: fake, logger },
    );
    expect(response.status).toBe(200);

    const rejecting = createReactionTestFake({
      type: "rejection",
      rejection: { kind: "temporarily_unavailable", code: "RUNTIME_NOT_IMPLEMENTED" },
    });
    const rejectLogger = createTestLogger();
    await handlePutProjectReaction(
      putReactionRequest(),
      { projectId: PROJECT_ID },
      { service: rejecting, logger: rejectLogger },
    );
    const fields = (rejectLogger.records[0] as { fields: Record<string, unknown> }).fields;
    expect(fields["code"]).toBe("RUNTIME_NOT_IMPLEMENTED");
    expect(fields["status"]).toBe(503);
  });

  it("production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED", async () => {
    const service = createProductionReactionService();
    const direct = await service.submitReaction({ scope: { kind: "unconfigured" }, correlationId: "direct-test",
      actor: { kind: "visitor", consent: "unknown" },
      idempotencyKey: IDEMPOTENCY_KEY as never,
      projectId: PROJECT_ID as never,
      kind: "like",
    });
    expect(direct.ok).toBe(false);
    if (!direct.ok) {
      expect(direct.error.kind).toBe("temporarily_unavailable");
      expect(direct.error.code).toBe("RUNTIME_NOT_IMPLEMENTED");
    }
    const logger = createTestLogger();
    const response = await handlePutProjectReaction(
      putReactionRequest(),
      { projectId: PROJECT_ID },
      { service, logger },
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("temporarily_unavailable");
    expect(zProblem.safeParse(body).success).toBe(true);
  });

  it("uses a server-generated trace identifier shared by Problem Details and logs", async () => {
    const fake = createReactionTestFake({
      type: "rejection",
      rejection: { kind: "not_found", code: "PROJECT_NOT_FOUND" },
    });
    const logger = createTestLogger();
    const first = await handlePutProjectReaction(
      putReactionRequest({ inboundTrace: "inbound-attacker-value" }),
      { projectId: PROJECT_ID },
      { service: fake, logger },
    );
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody["traceId"]).not.toBe("inbound-attacker-value");
    const logged = (logger.records[0] as { fields: Record<string, unknown> }).fields;
    expect(logged["traceId"]).toBe(firstBody["traceId"]);

    const secondLogger = createTestLogger();
    const second = await handlePutProjectReaction(
      putReactionRequest(),
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
      async submitReaction(): Promise<never> {
        throw new Error("boom postgres://user:pass@host/db token=tok_123 /app/secret.ts");
      },
    };
    const response = await handlePutProjectReaction(
      putReactionRequest(),
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
