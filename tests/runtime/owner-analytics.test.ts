/**
 * owner-analytics.test.ts — Phase 2 #32
 *
 * Seam under test (pre-agreed): the Owner Analytics goal HTTP adapter
 * observed through standard Request and Response objects with an injected
 * application fake.
 *
 * Acceptance (issue #32, analytics slice):
 * - Exactly one handwritten adapter covers Analytics goal retrieval,
 *   version creation, and version activation; each validates path, headers,
 *   and body with generated strict validators before dispatch.
 * - Each handler constructs one operation-specific command or query and
 *   invokes one injected application interface exactly once.
 * - Deterministic fakes exercise contract-valid successes and every declared
 *   rejection without implementing goal, measurement, retention, identity,
 *   or authorization behavior.
 * - Production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED
 *   for all three operations.
 */

import { describe, expect, it } from "vitest";

import {
  zActivateOwnerAnalyticsGoalVersionResponse,
  zCreateOwnerAnalyticsGoalVersionResponse,
  zGetOwnerAnalyticsGoalResponse,
  zProblem,
} from "../../src/contracts/http/owner/v1/generated/zod.gen.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import {
  createOwnerAnalyticsTestFake,
  createProductionOwnerAnalyticsService,
  OWNER_ANALYTICS_VERSION_ID,
} from "../../src/runtime/fakes/owner-analytics.js";
import {
  handleActivateOwnerAnalyticsGoalVersion,
  handleCreateOwnerAnalyticsGoalVersion,
  handleGetOwnerAnalyticsGoal,
} from "../../src/runtime/http/owner-analytics.js";
import {
  ownerTestSecurity,
  withOwnerTestAuth,
} from "./owner-test-auth.js";

const GOAL_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ed0";
const VERSION_ID = OWNER_ANALYTICS_VERSION_ID;
const IDEMPOTENCY_KEY = "test-key-123";
const IF_MATCH = '"2"';

function getRequest(goalId: string = GOAL_ID, inboundTrace?: string): Request {
  const headers: Record<string, string> = withOwnerTestAuth({});
  if (inboundTrace !== undefined) {
    headers["x-request-id"] = inboundTrace;
  }
  return new Request(`https://example.com/api/owner/v1/analytics-goals/${goalId}`, {
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
  const headers: Record<string, string> = withOwnerTestAuth({
    "content-type": "application/json",
  });
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

const versionsUrl = `https://example.com/api/owner/v1/analytics-goals/${GOAL_ID}/versions`;
const activateUrl = `https://example.com/api/owner/v1/analytics-goals/${GOAL_ID}/commands/activate-version`;
const definitionBody = {
  definition: {
    name: "Project view to contact",
    steps: [{ action: "project-viewed" }, { action: "contact-channel-opened" }],
  },
};
const activateBody = { versionId: VERSION_ID };

describe("Owner Analytics goal retrieval (#32)", () => {
  it("retrieves the goal once and returns the declared view", async () => {
    const fake = createOwnerAnalyticsTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleGetOwnerAnalyticsGoal(
      getRequest(),
      { goalId: GOAL_ID },
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.getOwnerAnalyticsGoal).toHaveLength(1);
    expect(fake.calls.createOwnerAnalyticsGoalVersion).toHaveLength(0);
    const query = fake.calls.getOwnerAnalyticsGoal[0] as { goalId: string };
    expect(query.goalId).toBe(GOAL_ID);
    const body = (await response.json()) as unknown;
    expect(zGetOwnerAnalyticsGoalResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      goalId: GOAL_ID,
      aggregateVersion: 2,
      activeVersionId: VERSION_ID,
      versions: [
        {
          versionId: VERSION_ID,
          versionNumber: 1,
          definition: {
            name: "Project view to contact",
            steps: [{ action: "project-viewed" }, { action: "contact-channel-opened" }],
          },
          createdAt: "2026-09-22T00:00:00.000Z",
        },
      ],
      activationHistory: [{ versionId: VERSION_ID, activatedAt: "2026-09-22T00:00:00.000Z" }],
    });
  });

  it.each([["invalid goalId", "not-a-uuid"]])(
    "rejects %s as 400 before dispatch",
    async (_label, goalId) => {
      const fake = createOwnerAnalyticsTestFake({ type: "success" });
      const response = await handleGetOwnerAnalyticsGoal(
        getRequest(goalId),
        { goalId },
        { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
      );
      expect(response.status).toBe(400);
      expect(fake.calls.getOwnerAnalyticsGoal).toHaveLength(0);
    },
  );

  it.each([
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
    ["not_found", { kind: "not_found", code: "GOAL_NOT_FOUND" }, 404, "not_found"],
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
      const fake = createOwnerAnalyticsTestFake({ type: "rejection", rejection });
      const response = await handleGetOwnerAnalyticsGoal(
        getRequest(),
        { goalId: GOAL_ID },
        { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
      );
      expect(response.status).toBe(status);
      expect(fake.calls.getOwnerAnalyticsGoal).toHaveLength(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it("fails safely when fake output is contract-invalid", async () => {
    const fake = createOwnerAnalyticsTestFake({ type: "invalid-success" });
    const response = await handleGetOwnerAnalyticsGoal(
      getRequest(),
      { goalId: GOAL_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(500);
  });

  it("uses a server-generated trace identifier shared by Problem Details and logs", async () => {
    const fake = createOwnerAnalyticsTestFake({
      type: "rejection",
      rejection: { kind: "not_found", code: "GOAL_NOT_FOUND" },
    });
    const logger = createTestLogger();
    const first = await handleGetOwnerAnalyticsGoal(
      getRequest(GOAL_ID, "inbound-attacker-value"),
      { goalId: GOAL_ID },
      { service: fake, security: ownerTestSecurity(), logger },
    );
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody["traceId"]).not.toBe("inbound-attacker-value");
    const logged = (logger.records[0] as { fields: Record<string, unknown> }).fields;
    expect(logged["traceId"]).toBe(firstBody["traceId"]);
  });
});

describe("Owner Analytics goal version creation and activation (#32)", () => {
  it("creates a version once and returns the declared 201 receipt", async () => {
    const fake = createOwnerAnalyticsTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleCreateOwnerAnalyticsGoalVersion(
      postRequest(versionsUrl, { body: definitionBody }),
      { goalId: GOAL_ID },
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(201);
    expect(fake.calls.createOwnerAnalyticsGoalVersion).toHaveLength(1);
    const command = fake.calls.createOwnerAnalyticsGoalVersion[0] as unknown as {
      goalId: string;
      expectedVersion: number;
      idempotencyKey: string;
      definition: { name: string; steps: Array<{ action: string }> };
    };
    expect(command.goalId).toBe(GOAL_ID);
    expect(command.expectedVersion).toBe(2);
    expect(command.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    expect(command.definition).toEqual(definitionBody.definition);
    const body = (await response.json()) as unknown;
    expect(zCreateOwnerAnalyticsGoalVersionResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      goalId: GOAL_ID,
      versionId: VERSION_ID,
      aggregateVersion: 3,
      outcome: "analytics-goal-version-created",
    });
  });

  it("activates a version once and returns the declared receipt", async () => {
    const fake = createOwnerAnalyticsTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleActivateOwnerAnalyticsGoalVersion(
      postRequest(activateUrl, { body: activateBody }),
      { goalId: GOAL_ID },
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.activateOwnerAnalyticsGoalVersion).toHaveLength(1);
    const command = fake.calls.activateOwnerAnalyticsGoalVersion[0] as {
      goalId: string;
      versionId: string;
      expectedVersion: number;
      idempotencyKey: string;
    };
    expect(command.goalId).toBe(GOAL_ID);
    expect(command.versionId).toBe(VERSION_ID);
    expect(command.expectedVersion).toBe(2);
    expect(command.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    const body = (await response.json()) as unknown;
    expect(zActivateOwnerAnalyticsGoalVersionResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: GOAL_ID,
      aggregateVersion: 3,
      outcome: "analytics-goal-version-activated",
    });
  });

  it.each([
    ["missing Idempotency-Key", { idempotencyKey: null }, "create"],
    ["missing If-Match", { ifMatch: null }, "create"],
    ["malformed If-Match", { ifMatch: "2" }, "activate"],
    ["malformed JSON", { rawBody: "{not-json" }, "create"],
    ["missing definition", { body: {} }, "create"],
    ["empty steps", { body: { definition: { name: "x", steps: [] } } }, "create"],
    ["unknown action", { body: { definition: { name: "x", steps: [{ action: "nope" }] } } }, "create"],
    ["unknown property", { body: { versionId: VERSION_ID, extra: "nope" } }, "activate"],
    ["invalid versionId", { body: { versionId: "not-a-uuid" } }, "activate"],
  ])("rejects %s as 400 before dispatch", async (_label, options, which) => {
    const fake = createOwnerAnalyticsTestFake({ type: "success" });
    const url = which === "create" ? versionsUrl : activateUrl;
    const handler = which === "create"
      ? handleCreateOwnerAnalyticsGoalVersion
      : handleActivateOwnerAnalyticsGoalVersion;
    const response = await handler(
      postRequest(url, options as { body?: unknown; rawBody?: string }),
      { goalId: GOAL_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(400);
    expect([
      ...fake.calls.createOwnerAnalyticsGoalVersion,
      ...fake.calls.activateOwnerAnalyticsGoalVersion,
    ]).toHaveLength(0);
  });

  it("rejects an invalid goalId as 400 before dispatch", async () => {
    const fake = createOwnerAnalyticsTestFake({ type: "success" });
    const response = await handleCreateOwnerAnalyticsGoalVersion(
      postRequest(versionsUrl, { body: definitionBody }),
      { goalId: "not-a-uuid" },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(400);
    expect(fake.calls.createOwnerAnalyticsGoalVersion).toHaveLength(0);
  });

  it.each([
    ["validation", { kind: "validation", code: "GOAL_REJECTED" }, 422, "unprocessable"],
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
    ["not_found", { kind: "not_found", code: "GOAL_NOT_FOUND" }, 404, "not_found"],
    ["conflict", { kind: "conflict", code: "GOAL_CONFLICT" }, 409, "conflict"],
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
      for (const run of [
        () => {
          const fake = createOwnerAnalyticsTestFake({ type: "rejection", rejection });
          return handleCreateOwnerAnalyticsGoalVersion(
            postRequest(versionsUrl, { body: definitionBody }),
            { goalId: GOAL_ID },
            { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
          );
        },
        () => {
          const fake = createOwnerAnalyticsTestFake({ type: "rejection", rejection });
          return handleActivateOwnerAnalyticsGoalVersion(
            postRequest(activateUrl, { body: activateBody }),
            { goalId: GOAL_ID },
            { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
          );
        },
      ]) {
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

  it("fails safely when command fake output is contract-invalid", async () => {
    const fake = createOwnerAnalyticsTestFake({ type: "invalid-success" });
    const response = await handleCreateOwnerAnalyticsGoalVersion(
      postRequest(versionsUrl, { body: definitionBody }),
      { goalId: GOAL_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(500);
  });

  it("production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED for all three operations", async () => {
    const service = createProductionOwnerAnalyticsService();
    const logger = createTestLogger();
    const responses = [
      await handleGetOwnerAnalyticsGoal(getRequest(), { goalId: GOAL_ID }, { service, security: ownerTestSecurity(), logger }),
      await handleCreateOwnerAnalyticsGoalVersion(
        postRequest(versionsUrl, { body: definitionBody }),
        { goalId: GOAL_ID },
        { service, security: ownerTestSecurity(), logger },
      ),
      await handleActivateOwnerAnalyticsGoalVersion(
        postRequest(activateUrl, { body: activateBody }),
        { goalId: GOAL_ID },
        { service, security: ownerTestSecurity(), logger },
      ),
    ];
    expect(responses).toHaveLength(3);
    for (const response of responses) {
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe("temporarily_unavailable");
    }
    const owner = { kind: "owner", ownerId: GOAL_ID, sessionId: "s" } as const;
    const directCalls = [
      service.getOwnerAnalyticsGoal({ actor: owner as never, goalId: GOAL_ID as never }),
      service.createOwnerAnalyticsGoalVersion({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        goalId: GOAL_ID as never,
        definition: definitionBody.definition as never,
      }),
      service.activateOwnerAnalyticsGoalVersion({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        goalId: GOAL_ID as never,
        versionId: VERSION_ID as never,
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
      async getOwnerAnalyticsGoal(): Promise<never> {
        throw new Error("boom postgres://user:pass@host/db token=tok_123 /app/secret.ts");
      },
      async createOwnerAnalyticsGoalVersion(): Promise<never> {
        throw new Error("unreachable");
      },
      async activateOwnerAnalyticsGoalVersion(): Promise<never> {
        throw new Error("unreachable");
      },
    };
    const response = await handleGetOwnerAnalyticsGoal(
      getRequest(),
      { goalId: GOAL_ID },
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
