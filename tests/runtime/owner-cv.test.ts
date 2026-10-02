/**
 * owner-cv.test.ts — Phase 2 #31
 *
 * Seam under test (pre-agreed): the Owner CV Portfolio HTTP adapter observed
 * through standard Request and Response objects with an injected application
 * fake.
 *
 * Acceptance (issue #31, CV slice):
 * - Exactly one handwritten adapter covers CV Portfolio retrieval and CV
 *   version registration, acceptance, and activation; each validates every
 *   declared path, header, and body input with generated strict validators
 *   before dispatch (accept and activate declare no body).
 * - Each handler constructs one operation-specific command or query and
 *   invokes one injected application interface exactly once.
 * - Deterministic fakes exercise contract-valid successes and every declared
 *   rejection without implementing registration, acceptance, or Current CV
 *   rules.
 * - Production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED
 *   for all four operations.
 */

import { describe, expect, it } from "vitest";

import {
  zAcceptOwnerCvVersionResponse,
  zActivateOwnerCvVersionResponse,
  zGetOwnerCvPortfolioResponse,
  zProblem,
  zRegisterOwnerCvVersionResponse,
} from "../../src/contracts/http/owner/v1/generated/zod.gen.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import {
  createOwnerCvTestFake,
  createProductionOwnerCvService,
  OWNER_CV_MEDIA_ID,
  OWNER_CV_VERSION_ID,
} from "../../src/runtime/fakes/owner-cv.js";
import {
  handleAcceptOwnerCvVersion,
  handleActivateOwnerCvVersion,
  handleGetOwnerCvPortfolio,
  handleRegisterOwnerCvVersion,
} from "../../src/runtime/http/owner-cv.js";
import { ownerTestSecurity, withOwnerTestAuth } from "./owner-test-auth.js";

const VERSION_ID = OWNER_CV_VERSION_ID;
const MEDIA_ID = OWNER_CV_MEDIA_ID;
const IDEMPOTENCY_KEY = "test-key-123";
const IF_MATCH = '"2"';

function portfolioRequest(inboundTrace?: string): Request {
  const headers: Record<string, string> = withOwnerTestAuth({});
  if (inboundTrace !== undefined) {
    headers["x-request-id"] = inboundTrace;
  }
  return new Request("https://example.com/api/owner/v1/cv", {
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

function commandRequest(url: string, includeBody = false): Request {
  const headers: Record<string, string> = withOwnerTestAuth({
    "Idempotency-Key": IDEMPOTENCY_KEY,
    "If-Match": IF_MATCH,
  });
  const init: RequestInit = { method: "POST", headers };
  if (includeBody) {
    init.body = JSON.stringify({});
  }
  return new Request(url, init);
}

const registerUrl = "https://example.com/api/owner/v1/cv/versions";
const acceptUrl = `https://example.com/api/owner/v1/cv/versions/${VERSION_ID}/commands/accept`;
const activateUrl = `https://example.com/api/owner/v1/cv/versions/${VERSION_ID}/commands/activate`;

const registerBody = { mediaId: MEDIA_ID, locale: "en", label: "CV September 2026" };

describe("Owner CV Portfolio retrieval (#31)", () => {
  it("retrieves the portfolio once and returns the declared view", async () => {
    const fake = createOwnerCvTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleGetOwnerCvPortfolio(portfolioRequest(), {
      service: fake,
      security: ownerTestSecurity(),
      logger,
    });
    expect(response.status).toBe(200);
    expect(fake.calls.getOwnerCvPortfolio).toHaveLength(1);
    expect(fake.calls.registerOwnerCvVersion).toHaveLength(0);
    const body = (await response.json()) as unknown;
    expect(zGetOwnerCvPortfolioResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateVersion: 2,
      currentVersionId: VERSION_ID,
      versions: [
        {
          versionId: VERSION_ID,
          mediaId: MEDIA_ID,
          locale: "en",
          label: "CV September 2026",
          state: "accepted",
          isCurrent: true,
        },
      ],
      activationHistory: [
        { versionId: VERSION_ID, activatedAt: "2026-09-22T00:00:00.000Z" },
      ],
    });
  });

  it.each([
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
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
    "translates %s rejection to %i",
    async (_label, rejection, status, problemCode) => {
      const fake = createOwnerCvTestFake({ type: "rejection", rejection });
      const logger = createTestLogger();
      const response = await handleGetOwnerCvPortfolio(portfolioRequest(), {
        service: fake,
        security: ownerTestSecurity(),
        logger,
      });
      expect(response.status).toBe(status);
      expect(fake.calls.getOwnerCvPortfolio).toHaveLength(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it("fails safely when fake output is contract-invalid", async () => {
    const fake = createOwnerCvTestFake({ type: "invalid-success" });
    const response = await handleGetOwnerCvPortfolio(portfolioRequest(), {
      service: fake,
      security: ownerTestSecurity(),
      logger: createTestLogger(),
    });
    expect(response.status).toBe(500);
  });

  it("uses a server-generated trace identifier shared by Problem Details and logs", async () => {
    const fake = createOwnerCvTestFake({
      type: "rejection",
      rejection: { kind: "not_found", code: "CV_NOT_FOUND" },
    });
    const logger = createTestLogger();
    const first = await handleGetOwnerCvPortfolio(portfolioRequest("inbound-attacker-value"), {
      service: fake,
      security: ownerTestSecurity(),
      logger,
    });
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody["traceId"]).not.toBe("inbound-attacker-value");
    const logged = (logger.records[0] as { fields: Record<string, unknown> }).fields;
    expect(logged["traceId"]).toBe(firstBody["traceId"]);
  });
});

describe("Owner CV version registration (#31)", () => {
  it("registers a CV version once and returns the declared 201 receipt", async () => {
    const fake = createOwnerCvTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleRegisterOwnerCvVersion(
      postRequest(registerUrl, { body: registerBody }),
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(201);
    expect(fake.calls.registerOwnerCvVersion).toHaveLength(1);
    const command = fake.calls.registerOwnerCvVersion[0] as {
      mediaId: string;
      locale: string;
      label: string;
      expectedVersion: number;
      idempotencyKey: string;
    };
    expect(command.mediaId).toBe(MEDIA_ID);
    expect(command.locale).toBe("en");
    expect(command.label).toBe("CV September 2026");
    expect(command.expectedVersion).toBe(2);
    expect(command.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    const body = (await response.json()) as unknown;
    expect(zRegisterOwnerCvVersionResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      versionId: VERSION_ID,
      aggregateVersion: 3,
      outcome: "cv-version-registered",
    });
  });

  it.each([
    ["malformed JSON", { rawBody: "{not-json" }],
    ["missing Idempotency-Key", { idempotencyKey: null, body: registerBody }],
    ["missing If-Match", { ifMatch: null, body: registerBody }],
    ["invalid If-Match", { ifMatch: '"0"', body: registerBody }],
    ["absent body", { body: {} }],
    ["invalid mediaId", { body: { ...registerBody, mediaId: "not-a-uuid" } }],
    ["invalid locale", { body: { ...registerBody, locale: "ar" } }],
    ["empty label", { body: { ...registerBody, label: "" } }],
    ["unknown closed-shape property", { body: { ...registerBody, extra: "nope" } }],
    ["out-of-shape body", { rawBody: "[]" }],
  ] as Array<[string, Record<string, unknown>]>)(
    "rejects registration %s as 400 before dispatch",
    async (_kind, options) => {
      const fake = createOwnerCvTestFake({ type: "success" });
      const response = await handleRegisterOwnerCvVersion(
        postRequest(registerUrl, options),
        { service: fake, security: ownerTestSecurity() },
      );
      expect(response.status).toBe(400);
      expect(fake.calls.registerOwnerCvVersion).toHaveLength(0);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("validation");
    },
  );

  it.each([
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
    ["not_found", { kind: "not_found", code: "MEDIA_NOT_FOUND" }, 404, "not_found"],
    ["conflict", { kind: "conflict", code: "IDEMPOTENCY_CONFLICT" }, 409, "conflict"],
    ["precondition_failed", { kind: "precondition_failed", code: "VERSION_MISMATCH" }, 412, "failed_precondition"],
    ["validation", { kind: "validation", code: "CV_REJECTED" }, 422, "unprocessable"],
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
    "translates registration %s rejection to %i",
    async (_label, rejection, status, problemCode) => {
      const fake = createOwnerCvTestFake({ type: "rejection", rejection });
      const response = await handleRegisterOwnerCvVersion(
        postRequest(registerUrl, { body: registerBody }),
        { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
      );
      expect(response.status).toBe(status);
      expect(fake.calls.registerOwnerCvVersion).toHaveLength(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it("fails safely when registration fake output is contract-invalid", async () => {
    const fake = createOwnerCvTestFake({ type: "invalid-success" });
    const response = await handleRegisterOwnerCvVersion(
      postRequest(registerUrl, { body: registerBody }),
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(500);
  });
});

describe("Owner CV version acceptance and activation (#31)", () => {
  it("accepts a CV version once without requiring a body", async () => {
    const fake = createOwnerCvTestFake({ type: "success" });
    const response = await handleAcceptOwnerCvVersion(
      commandRequest(acceptUrl),
      { versionId: VERSION_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.acceptOwnerCvVersion).toHaveLength(1);
    const command = fake.calls.acceptOwnerCvVersion[0] as {
      versionId: string;
      expectedVersion: number;
      idempotencyKey: string;
    };
    expect(command.versionId).toBe(VERSION_ID);
    expect(command.expectedVersion).toBe(2);
    expect(command.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    const body = (await response.json()) as unknown;
    expect(zAcceptOwnerCvVersionResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: VERSION_ID,
      aggregateVersion: 3,
      outcome: "cv-version-accepted",
    });
  });

  it("activates the Current CV once without requiring a body", async () => {
    const fake = createOwnerCvTestFake({ type: "success" });
    const response = await handleActivateOwnerCvVersion(
      commandRequest(activateUrl),
      { versionId: VERSION_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.activateOwnerCvVersion).toHaveLength(1);
    const body = (await response.json()) as unknown;
    expect(zActivateOwnerCvVersionResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: VERSION_ID,
      aggregateVersion: 3,
      outcome: "current-cv-activated",
    });
  });

  it.each([
    ["invalid path id", "accept", "not-a-uuid", undefined, undefined],
    ["missing Idempotency-Key", "accept", VERSION_ID, null, undefined],
    ["missing If-Match", "activate", VERSION_ID, undefined, null],
    ["invalid If-Match", "accept", VERSION_ID, undefined, '"0"'],
    ["malformed If-Match", "activate", VERSION_ID, undefined, "not-a-version"],
  ] as Array<[string, string, string, string | null | undefined, string | null | undefined]>)(
    "rejects version command %s %s as 400 before dispatch",
    async (_kind, op, versionId, idempotencyKey, ifMatch) => {
      const fake = createOwnerCvTestFake({ type: "success" });
      const headers: Record<string, string> = withOwnerTestAuth({});
      if (idempotencyKey !== null) {
        headers["Idempotency-Key"] = idempotencyKey ?? IDEMPOTENCY_KEY;
      }
      if (ifMatch !== null) {
        headers["If-Match"] = ifMatch ?? IF_MATCH;
      }
      const request = new Request(
        op === "accept" ? acceptUrl : activateUrl,
        { method: "POST", headers },
      );
      const deps = { service: fake, security: ownerTestSecurity() };
      const response =
        op === "accept"
          ? await handleAcceptOwnerCvVersion(request, { versionId }, deps)
          : await handleActivateOwnerCvVersion(request, { versionId }, deps);
      expect(response.status).toBe(400);
      const totalCalls =
        fake.calls.acceptOwnerCvVersion.length + fake.calls.activateOwnerCvVersion.length;
      expect(totalCalls).toBe(0);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("validation");
    },
  );

  const versionCommandRejections = [
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
    ["not_found", { kind: "not_found", code: "CV_NOT_FOUND" }, 404, "not_found"],
    ["conflict", { kind: "conflict", code: "IDEMPOTENCY_CONFLICT" }, 409, "conflict"],
    ["precondition_failed", { kind: "precondition_failed", code: "VERSION_MISMATCH" }, 412, "failed_precondition"],
    ["validation", { kind: "validation", code: "CV_REJECTED" }, 422, "unprocessable"],
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
  ] as const;

  it.each(versionCommandRejections)(
    "translates accept %s rejection to %i",
    async (_label, rejection, status, problemCode) => {
      const fake = createOwnerCvTestFake({ type: "rejection", rejection });
      const response = await handleAcceptOwnerCvVersion(
        commandRequest(acceptUrl),
        { versionId: VERSION_ID },
        { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
      );
      expect(response.status).toBe(status);
      expect(fake.calls.acceptOwnerCvVersion).toHaveLength(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it.each(versionCommandRejections)(
    "translates activate %s rejection to %i",
    async (_label, rejection, status, problemCode) => {
      const fake = createOwnerCvTestFake({ type: "rejection", rejection });
      const response = await handleActivateOwnerCvVersion(
        commandRequest(activateUrl),
        { versionId: VERSION_ID },
        { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
      );
      expect(response.status).toBe(status);
      expect(fake.calls.activateOwnerCvVersion).toHaveLength(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it("translates activate forbidden and validation without provider auth", async () => {
    const forbidden = createOwnerCvTestFake({
      type: "rejection",
      rejection: { kind: "forbidden", code: "OWNER_FORBIDDEN" },
    });
    const activate = await handleActivateOwnerCvVersion(
      commandRequest(activateUrl),
      { versionId: VERSION_ID },
      { service: forbidden, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(activate.status).toBe(403);

    const invalid = createOwnerCvTestFake({
      type: "rejection",
      rejection: { kind: "validation", code: "CV_REJECTED" },
    });
    const second = await handleActivateOwnerCvVersion(
      commandRequest(activateUrl),
      { versionId: VERSION_ID },
      { service: invalid, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(second.status).toBe(422);
  });

  it("fails safely when version-command fake output is contract-invalid", async () => {
    const fake = createOwnerCvTestFake({ type: "invalid-success" });
    const response = await handleAcceptOwnerCvVersion(
      commandRequest(acceptUrl),
      { versionId: VERSION_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(500);
  });

  it("production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED for all four operations", async () => {
    const service = createProductionOwnerCvService();
    const logger = createTestLogger();
    const responses = [
      await handleGetOwnerCvPortfolio(portfolioRequest(), { service, security: ownerTestSecurity(), logger }),
      await handleRegisterOwnerCvVersion(
        postRequest(registerUrl, { body: registerBody }),
        { service, security: ownerTestSecurity(), logger },
      ),
      await handleAcceptOwnerCvVersion(commandRequest(acceptUrl), { versionId: VERSION_ID }, { service, security: ownerTestSecurity(), logger }),
      await handleActivateOwnerCvVersion(commandRequest(activateUrl), { versionId: VERSION_ID }, { service, security: ownerTestSecurity(), logger }),
    ];
    expect(responses).toHaveLength(4);
    for (const response of responses) {
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe("temporarily_unavailable");
    }
    const owner = { kind: "owner", ownerId: VERSION_ID, sessionId: "s" } as const;
    const directCalls = [
      service.getOwnerCvPortfolio({ actor: owner as never }),
      service.registerOwnerCvVersion({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        mediaId: MEDIA_ID as never,
        locale: "en" as const,
        label: "CV September 2026",
      }),
      service.acceptOwnerCvVersion({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        versionId: VERSION_ID as never,
      }),
      service.activateOwnerCvVersion({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
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
      async getOwnerCvPortfolio(): Promise<never> {
        throw new Error("boom postgres://user:pass@host/db token=tok_123 /app/secret.ts CV content leak");
      },
      async registerOwnerCvVersion(): Promise<never> {
        throw new Error("unreachable");
      },
      async acceptOwnerCvVersion(): Promise<never> {
        throw new Error("unreachable");
      },
      async activateOwnerCvVersion(): Promise<never> {
        throw new Error("unreachable");
      },
    };
    const response = await handleGetOwnerCvPortfolio(portfolioRequest(), {
      service: throwing,
      security: ownerTestSecurity(),
      logger,
    });
    expect(response.status).toBe(500);
    const serialized = JSON.stringify(await response.json());
    for (const leak of ["postgres://", "tok_123", "/app/secret.ts", "CV content", "boom"]) {
      expect(serialized).not.toContain(leak);
    }
    expect(JSON.stringify(logger.records)).not.toContain("postgres://");
  });
});
