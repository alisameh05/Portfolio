/**
 * owner-moderation.test.ts — Phase 2 #32
 *
 * Seam under test (pre-agreed): the Owner Feedback Moderation HTTP adapter
 * observed through standard Request and Response objects with an injected
 * application fake.
 *
 * Acceptance (issue #32, moderation slice):
 * - Exactly one handwritten adapter covers Feedback Moderation retrieval,
 *   approval, rejection, and suppression; each validates path, headers, and
 *   body with generated strict validators before dispatch.
 * - Each handler constructs one operation-specific command or query and
 *   invokes one injected application interface exactly once.
 * - Deterministic fakes exercise contract-valid successes and every declared
 *   rejection without implementing Moderation, retention, persistence,
 *   identity, or authorization behavior.
 * - Production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED
 *   for all four operations.
 */

import { describe, expect, it } from "vitest";

import {
  zApproveOwnerFeedbackResponse,
  zGetOwnerFeedbackModerationResponse,
  zProblem,
  zRejectOwnerFeedbackResponse,
  zSuppressOwnerFeedbackResponse,
} from "../../src/contracts/http/owner/v1/generated/zod.gen.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import {
  createOwnerModerationTestFake,
  createProductionOwnerModerationService,
} from "../../src/runtime/fakes/owner-moderation.js";
import {
  handleApproveOwnerFeedback,
  handleGetOwnerFeedbackModeration,
  handleRejectOwnerFeedback,
  handleSuppressOwnerFeedback,
} from "../../src/runtime/http/owner-moderation.js";
import { ownerTestSecurity, withOwnerTestAuth } from "./owner-test-auth.js";

const FEEDBACK_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec0";
const IDEMPOTENCY_KEY = "test-key-123";
const IF_MATCH = '"2"';

function getRequest(feedbackId: string = FEEDBACK_ID, inboundTrace?: string): Request {
  const headers: Record<string, string> = withOwnerTestAuth({});
  if (inboundTrace !== undefined) {
    headers["x-request-id"] = inboundTrace;
  }
  return new Request(`https://example.com/api/owner/v1/feedback/${feedbackId}`, {
    method: "GET",
    headers,
  });
}

function postRequest(
  url: string,
  options?: {
    idempotencyKey?: string | null;
    ifMatch?: string | null;
    body?: unknown;
    rawBody?: string;
  },
): Request {
  const headers: Record<string, string> = withOwnerTestAuth({ "content-type": "application/json" });
  if (options?.idempotencyKey !== null) {
    headers["Idempotency-Key"] = options?.idempotencyKey ?? IDEMPOTENCY_KEY;
  }
  if (options?.ifMatch !== null) {
    headers["If-Match"] = options?.ifMatch ?? IF_MATCH;
  }
  const init: RequestInit = { method: "POST", headers };
  if (options?.rawBody !== undefined) {
    init.body = options.rawBody;
  } else {
    init.body = JSON.stringify(options?.body ?? {});
  }
  return new Request(url, init);
}

const approveUrl = `https://example.com/api/owner/v1/feedback/${FEEDBACK_ID}/commands/approve`;
const rejectUrl = `https://example.com/api/owner/v1/feedback/${FEEDBACK_ID}/commands/reject`;
const suppressUrl = `https://example.com/api/owner/v1/feedback/${FEEDBACK_ID}/commands/suppress`;
const decisionBody = { reason: "Meets the public-display policy." };

describe("Owner Feedback Moderation retrieval (#32)", () => {
  it("retrieves the moderation view once and returns the declared view", async () => {
    const fake = createOwnerModerationTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleGetOwnerFeedbackModeration(
      getRequest(),
      { feedbackId: FEEDBACK_ID },
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.getOwnerFeedbackModeration).toHaveLength(1);
    expect(fake.calls.approveOwnerFeedback).toHaveLength(0);
    const query = fake.calls.getOwnerFeedbackModeration[0] as { feedbackId: string };
    expect(query.feedbackId).toBe(FEEDBACK_ID);
    const body = (await response.json()) as unknown;
    expect(zGetOwnerFeedbackModerationResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      feedbackId: FEEDBACK_ID,
      aggregateVersion: 1,
      state: "pending",
      authorName: "Ada Lovelace",
      paragraph:
        "The case study explained the trade-offs clearly and linked supporting evidence.",
      submittedAt: "2026-09-22T00:00:00.000Z",
      decisionHistory: [],
    });
  });

  it.each([["invalid feedbackId", "not-a-uuid"]])(
    "rejects %s as 400 before dispatch",
    async (_label, feedbackId) => {
      const fake = createOwnerModerationTestFake({ type: "success" });
      const response = await handleGetOwnerFeedbackModeration(
        getRequest(feedbackId),
        { feedbackId },
        { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
      );
      expect(response.status).toBe(400);
      expect(fake.calls.getOwnerFeedbackModeration).toHaveLength(0);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("validation");
    },
  );

  it.each([
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
    ["not_found", { kind: "not_found", code: "FEEDBACK_NOT_FOUND" }, 404, "not_found"],
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
    "translates %s rejection to %i",
    async (_label, rejection, status, problemCode) => {
      const fake = createOwnerModerationTestFake({ type: "rejection", rejection });
      const logger = createTestLogger();
      const response = await handleGetOwnerFeedbackModeration(
        getRequest(),
        { feedbackId: FEEDBACK_ID },
        { service: fake, security: ownerTestSecurity(), logger },
      );
      expect(response.status).toBe(status);
      expect(fake.calls.getOwnerFeedbackModeration).toHaveLength(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it("fails safely when fake output is contract-invalid", async () => {
    const fake = createOwnerModerationTestFake({ type: "invalid-success" });
    const response = await handleGetOwnerFeedbackModeration(
      getRequest(),
      { feedbackId: FEEDBACK_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(500);
  });

  it("uses a server-generated trace identifier shared by Problem Details and logs", async () => {
    const fake = createOwnerModerationTestFake({
      type: "rejection",
      rejection: { kind: "not_found", code: "FEEDBACK_NOT_FOUND" },
    });
    const logger = createTestLogger();
    const first = await handleGetOwnerFeedbackModeration(
      getRequest(FEEDBACK_ID, "inbound-attacker-value"),
      { feedbackId: FEEDBACK_ID },
      { service: fake, security: ownerTestSecurity(), logger },
    );
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody["traceId"]).not.toBe("inbound-attacker-value");
    const logged = (logger.records[0] as { fields: Record<string, unknown> }).fields;
    expect(logged["traceId"]).toBe(firstBody["traceId"]);
  });
});

describe("Owner Feedback approval, rejection, and suppression (#32)", () => {
  it.each([
    ["approve", approveUrl, "feedback-approved", zApproveOwnerFeedbackResponse],
    ["reject", rejectUrl, "feedback-rejected", zRejectOwnerFeedbackResponse],
    ["suppress", suppressUrl, "feedback-suppressed", zSuppressOwnerFeedbackResponse],
  ] as const)(
    "%s constructs one command, dispatches once, and returns the declared receipt",
    async (_label, url, outcome, responseValidator) => {
      const fake = createOwnerModerationTestFake({ type: "success" });
      const logger = createTestLogger();
      const handler =
        _label === "approve"
          ? handleApproveOwnerFeedback
          : _label === "reject"
            ? handleRejectOwnerFeedback
            : handleSuppressOwnerFeedback;
      const response = await handler(
        postRequest(url, { body: decisionBody }),
        { feedbackId: FEEDBACK_ID },
        { service: fake, security: ownerTestSecurity(), logger },
      );
      expect(response.status).toBe(200);
      const allCalls = [
        ...fake.calls.approveOwnerFeedback,
        ...fake.calls.rejectOwnerFeedback,
        ...fake.calls.suppressOwnerFeedback,
      ];
      expect(allCalls).toHaveLength(1);
      const command = allCalls[0] as {
        feedbackId: string;
        expectedVersion: number;
        idempotencyKey: string;
        reason: string;
      };
      expect(command.feedbackId).toBe(FEEDBACK_ID);
      expect(command.expectedVersion).toBe(2);
      expect(command.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    expect(command).toMatchObject({ scope: { kind: "unconfigured" }, correlationId: expect.any(String) });
      expect(command.reason).toBe(decisionBody.reason);
      const body = (await response.json()) as unknown;
      expect(responseValidator.safeParse(body).success).toBe(true);
      expect(body).toEqual({
        aggregateId: FEEDBACK_ID,
        aggregateVersion: 3,
        outcome,
      });
    },
  );

  it.each([
    ["missing Idempotency-Key", { idempotencyKey: null }, approveUrl],
    ["missing If-Match", { ifMatch: null }, approveUrl],
    ["malformed If-Match", { ifMatch: "2" }, rejectUrl],
    ["malformed JSON", { rawBody: "{not-json" }, suppressUrl],
    ["missing reason", { body: {} }, approveUrl],
    ["unknown property", { body: { reason: "x", extra: "nope" } }, rejectUrl],
    ["empty reason", { body: { reason: "" } }, suppressUrl],
  ])("rejects %s as 400 before dispatch", async (_label, options, url) => {
    const fake = createOwnerModerationTestFake({ type: "success" });
    const handler = url === approveUrl
      ? handleApproveOwnerFeedback
      : url === rejectUrl
        ? handleRejectOwnerFeedback
        : handleSuppressOwnerFeedback;
    const response = await handler(
      postRequest(url, options as { body?: unknown; rawBody?: string }),
      { feedbackId: FEEDBACK_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(400);
    expect([
      ...fake.calls.approveOwnerFeedback,
      ...fake.calls.rejectOwnerFeedback,
      ...fake.calls.suppressOwnerFeedback,
    ]).toHaveLength(0);
  });

  it("rejects an invalid feedbackId as 400 before dispatch", async () => {
    const fake = createOwnerModerationTestFake({ type: "success" });
    const response = await handleApproveOwnerFeedback(
      postRequest(approveUrl, { body: decisionBody }),
      { feedbackId: "not-a-uuid" },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(400);
    expect(fake.calls.approveOwnerFeedback).toHaveLength(0);
  });

  it.each([
    ["validation", { kind: "validation", code: "FEEDBACK_REJECTED" }, 422, "unprocessable"],
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
    ["not_found", { kind: "not_found", code: "FEEDBACK_NOT_FOUND" }, 404, "not_found"],
    ["conflict", { kind: "conflict", code: "FEEDBACK_CONFLICT" }, 409, "conflict"],
    ["precondition_failed", { kind: "precondition_failed", code: "VERSION_MISMATCH" }, 412, "failed_precondition"],
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
    "translates command %s rejection to %i",
    async (_label, rejection, status, problemCode) => {
      const fake = createOwnerModerationTestFake({ type: "rejection", rejection });
      const handlers = [
        () =>
          handleApproveOwnerFeedback(
            postRequest(approveUrl, { body: decisionBody }),
            { feedbackId: FEEDBACK_ID },
            { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
          ),
        () =>
          handleRejectOwnerFeedback(
            postRequest(rejectUrl, { body: decisionBody }),
            { feedbackId: FEEDBACK_ID },
            { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
          ),
        () =>
          handleSuppressOwnerFeedback(
            postRequest(suppressUrl, { body: decisionBody }),
            { feedbackId: FEEDBACK_ID },
            { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
          ),
      ];
      for (const run of handlers) {
        const response = await run();
        expect(response.status).toBe(status);
        const body = (await response.json()) as Record<string, unknown>;
        expect(body["code"]).toBe(problemCode);
        if (status === 429) {
          expect(response.headers.get("retry-after")).toBe("30");
        }
      }
    },
  );

  it("keeps unauthenticated and forbidden distinct across approve and suppress", async () => {
    const unauthenticated = createOwnerModerationTestFake({
      type: "rejection",
      rejection: { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" },
    });
    const approve = await handleApproveOwnerFeedback(
      postRequest(approveUrl, { body: decisionBody }),
      { feedbackId: FEEDBACK_ID },
      { service: unauthenticated, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(approve.status).toBe(401);

    const forbidden = createOwnerModerationTestFake({
      type: "rejection",
      rejection: { kind: "forbidden", code: "OWNER_FORBIDDEN" },
    });
    const suppress = await handleSuppressOwnerFeedback(
      postRequest(suppressUrl, { body: decisionBody }),
      { feedbackId: FEEDBACK_ID },
      { service: forbidden, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(suppress.status).toBe(403);

    const invalid = createOwnerModerationTestFake({
      type: "rejection",
      rejection: { kind: "validation", code: "FEEDBACK_REJECTED" },
    });
    const reject = await handleRejectOwnerFeedback(
      postRequest(rejectUrl, { body: decisionBody }),
      { feedbackId: FEEDBACK_ID },
      { service: invalid, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(reject.status).toBe(422);
  });

  it("fails safely when command fake output is contract-invalid", async () => {
    const fake = createOwnerModerationTestFake({ type: "invalid-success" });
    const response = await handleApproveOwnerFeedback(
      postRequest(approveUrl, { body: decisionBody }),
      { feedbackId: FEEDBACK_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(500);
  });

  it("production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED for all four operations", async () => {
    const service = createProductionOwnerModerationService();
    const logger = createTestLogger();
    const responses = [
      await handleGetOwnerFeedbackModeration(getRequest(), { feedbackId: FEEDBACK_ID }, { service, security: ownerTestSecurity(), logger }),
      await handleApproveOwnerFeedback(
        postRequest(approveUrl, { body: decisionBody }),
        { feedbackId: FEEDBACK_ID },
        { service, security: ownerTestSecurity(), logger },
      ),
      await handleRejectOwnerFeedback(
        postRequest(rejectUrl, { body: decisionBody }),
        { feedbackId: FEEDBACK_ID },
        { service, security: ownerTestSecurity(), logger },
      ),
      await handleSuppressOwnerFeedback(
        postRequest(suppressUrl, { body: decisionBody }),
        { feedbackId: FEEDBACK_ID },
        { service, security: ownerTestSecurity(), logger },
      ),
    ];
    expect(responses).toHaveLength(4);
    for (const response of responses) {
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe("temporarily_unavailable");
    }
    const owner = { kind: "owner", ownerId: FEEDBACK_ID, sessionId: "s" } as const;
    const directCalls = [
      service.getOwnerFeedbackModeration({ scope: { kind: "unconfigured" }, correlationId: "direct-test", actor: owner as never, feedbackId: FEEDBACK_ID as never }),
      service.approveOwnerFeedback({ scope: { kind: "unconfigured" }, correlationId: "direct-test",
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        feedbackId: FEEDBACK_ID as never,
        reason: decisionBody.reason,
      }),
      service.rejectOwnerFeedback({ scope: { kind: "unconfigured" }, correlationId: "direct-test",
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        feedbackId: FEEDBACK_ID as never,
        reason: decisionBody.reason,
      }),
      service.suppressOwnerFeedback({ scope: { kind: "unconfigured" }, correlationId: "direct-test",
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        feedbackId: FEEDBACK_ID as never,
        reason: decisionBody.reason,
      }),
    ];
    for (const direct of await Promise.all(directCalls)) {
      expect(direct.ok).toBe(false);
      if (!direct.ok) {
        expect(direct.error.kind).toBe("temporarily_unavailable");
        expect(direct.error.code).toBe("RUNTIME_NOT_IMPLEMENTED");
      }
    }
  });

  it("maps unexpected exceptions to generic 500 without leaking secrets", async () => {
    const logger = createTestLogger();
    const throwing = {
      async getOwnerFeedbackModeration(): Promise<never> {
        throw new Error("boom postgres://user:pass@host/db token=tok_123 /app/secret.ts");
      },
      async approveOwnerFeedback(): Promise<never> {
        throw new Error("unreachable");
      },
      async rejectOwnerFeedback(): Promise<never> {
        throw new Error("unreachable");
      },
      async suppressOwnerFeedback(): Promise<never> {
        throw new Error("unreachable");
      },
    };
    const response = await handleGetOwnerFeedbackModeration(
      getRequest(),
      { feedbackId: FEEDBACK_ID },
      { service: throwing, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(500);
    const serialized = JSON.stringify(await response.json());
    for (const leak of ["postgres://", "tok_123", "/app/secret.ts", "boom"]) {
      expect(serialized).not.toContain(leak);
    }
    expect(JSON.stringify(logger.records)).not.toContain("postgres://");
  });
});
