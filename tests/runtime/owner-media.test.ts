/**
 * owner-media.test.ts — Phase 2 #31
 *
 * Seam under test (pre-agreed): the Owner Media HTTP adapter observed
 * through standard Request and Response objects with an injected application
 * fake.
 *
 * Acceptance (issue #31, media slice):
 * - Exactly one handwritten adapter covers Media aggregate retrieval, upload
 *   intent creation, processing-result recording, acceptance, and rejection;
 *   each validates path, headers, and body with generated strict validators
 *   before dispatch.
 * - Each handler constructs one operation-specific command or query and
 *   invokes one injected application interface exactly once.
 * - Deterministic fakes exercise contract-valid successes and every declared
 *   rejection without touching storage or implementing scanning, processing,
 *   acceptance, or delivery rules.
 * - Declared upload references stay provider-neutral and never expose signed
 *   secrets in logs or errors.
 * - Production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED
 *   for all five operations.
 */

import { describe, expect, it } from "vitest";

import {
  zAcceptOwnerMediaAssetResponse,
  zCreateOwnerMediaUploadIntentResponse,
  zGetOwnerMediaAggregateResponse,
  zProblem,
  zRecordOwnerMediaProcessingResponse,
  zRejectOwnerMediaAssetResponse,
} from "../../src/contracts/http/owner/v1/generated/zod.gen.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import {
  createOwnerMediaTestFake,
  createProductionOwnerMediaService,
  OWNER_MEDIA_ID,
  OWNER_MEDIA_UPLOAD_INTENT_ID,
} from "../../src/runtime/fakes/owner-media.js";
import {
  handleAcceptOwnerMediaAsset,
  handleCreateOwnerMediaUploadIntent,
  handleGetOwnerMediaAggregate,
  handleRecordOwnerMediaProcessing,
  handleRejectOwnerMediaAsset,
} from "../../src/runtime/http/owner-media.js";
import { OWNER_TEST_ACTOR, ownerTestSecurity, withOwnerTestAuth } from "./owner-test-auth.js";
import { createMediaUploadIntentApplicationService } from "../../src/modules/media/application/upload-intent.js";
import { err, ok, type StableId } from "../../src/shared/domain/index.js";

const MEDIA_ID = OWNER_MEDIA_ID;
const IDEMPOTENCY_KEY = "test-key-123";
const IF_MATCH = '"2"';
const SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function getRequest(mediaId: string = MEDIA_ID, inboundTrace?: string): Request {
  const headers: Record<string, string> = withOwnerTestAuth({});
  if (inboundTrace !== undefined) {
    headers["x-request-id"] = inboundTrace;
  }
  return new Request(`https://example.com/api/owner/v1/media/${mediaId}`, {
    method: "GET",
    headers,
  });
}

function postRequest(
  url: string,
  options?: {
    idempotencyKey?: string | null | undefined;
    ifMatch?: string | null | undefined;
    body?: unknown;
    rawBody?: string | undefined;
  },
): Request {
  const headers: Record<string, string> = withOwnerTestAuth({ "content-type": "application/json" });
  if (options?.idempotencyKey !== null) {
    headers["Idempotency-Key"] = options?.idempotencyKey ?? IDEMPOTENCY_KEY;
  }
  if (options?.ifMatch !== undefined && options.ifMatch !== null) {
    headers["If-Match"] = options.ifMatch;
  }
  const init: RequestInit = { method: "POST", headers };
  if (options?.rawBody !== undefined) {
    init.body = options.rawBody;
  } else if (options?.body !== undefined) {
    init.body = JSON.stringify(options.body);
  } else {
    init.body = JSON.stringify({});
  }
  return new Request(url, init);
}

function intentRequest(options?: {
  idempotencyKey?: string | null | undefined;
  body?: unknown;
  rawBody?: string | undefined;
}): Request {
  return postRequest("https://example.com/api/owner/v1/media/upload-intents", {
    ...options,
    ifMatch: undefined,
  });
}

function commandRequest(
  url: string,
  options?: { idempotencyKey?: string | null | undefined; ifMatch?: string | null | undefined; body?: unknown; rawBody?: string | undefined },
): Request {
  return postRequest(url, {
    idempotencyKey: options?.idempotencyKey,
    ifMatch: options?.ifMatch === undefined ? IF_MATCH : options.ifMatch,
    body: options?.body,
    rawBody: options?.rawBody,
  });
}

const recordUrl = `https://example.com/api/owner/v1/media/${MEDIA_ID}/commands/record-processing`;
const acceptUrl = `https://example.com/api/owner/v1/media/${MEDIA_ID}/commands/accept`;
const rejectUrl = `https://example.com/api/owner/v1/media/${MEDIA_ID}/commands/reject`;

const intentBody = {
  kind: "image",
  originalFileName: "portfolio-result.png",
  declaredMediaType: "image/png",
  byteLength: 204800,
  sha256: SHA256,
};

const recordBody = {
  result: "passed",
  detectedMediaType: "image/png",
  detectedByteLength: 204800,
  sha256: SHA256,
};

const acceptBody = {
  accessibilityMetadata: {
    kind: "described-image",
    altText: "Dashboard showing the validated portfolio result.",
  },
};

describe("Owner Media aggregate retrieval (#31)", () => {
  it("retrieves the aggregate once and returns the declared view", async () => {
    const fake = createOwnerMediaTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleGetOwnerMediaAggregate(
      getRequest(),
      { mediaId: MEDIA_ID },
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.getOwnerMediaAggregate).toHaveLength(1);
    expect(fake.calls.createOwnerMediaUploadIntent).toHaveLength(0);
    const query = fake.calls.getOwnerMediaAggregate[0] as { mediaId: string };
    expect(query.mediaId).toBe(MEDIA_ID);
    const body = (await response.json()) as unknown;
    expect(zGetOwnerMediaAggregateResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      mediaId: MEDIA_ID,
      aggregateVersion: 1,
      kind: "image",
      originalFileName: "portfolio-result.png",
      declaredMediaType: "image/png",
      byteLength: 204800,
      state: "upload-pending",
      processingHistory: [],
      decisionHistory: [],
    });
  });

  it.each([["invalid mediaId", "not-a-uuid"]])(
    "rejects %s as 400 before dispatch",
    async (_label, mediaId) => {
      const fake = createOwnerMediaTestFake({ type: "success" });
      const response = await handleGetOwnerMediaAggregate(
        getRequest(mediaId),
        { mediaId },
        { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
      );
      expect(response.status).toBe(400);
      expect(fake.calls.getOwnerMediaAggregate).toHaveLength(0);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("validation");
    },
  );

  it.each([
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
    ["not_found", { kind: "not_found", code: "MEDIA_NOT_FOUND" }, 404, "not_found"],
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
      const fake = createOwnerMediaTestFake({ type: "rejection", rejection });
      const logger = createTestLogger();
      const response = await handleGetOwnerMediaAggregate(
        getRequest(),
        { mediaId: MEDIA_ID },
        { service: fake, security: ownerTestSecurity(), logger },
      );
      expect(response.status).toBe(status);
      expect(fake.calls.getOwnerMediaAggregate).toHaveLength(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it("fails safely when fake output is contract-invalid", async () => {
    const fake = createOwnerMediaTestFake({ type: "invalid-success" });
    const response = await handleGetOwnerMediaAggregate(
      getRequest(),
      { mediaId: MEDIA_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(500);
  });

  it("uses a server-generated trace identifier shared by Problem Details and logs", async () => {
    const fake = createOwnerMediaTestFake({
      type: "rejection",
      rejection: { kind: "not_found", code: "MEDIA_NOT_FOUND" },
    });
    const logger = createTestLogger();
    const first = await handleGetOwnerMediaAggregate(
      getRequest(MEDIA_ID, "inbound-attacker-value"),
      { mediaId: MEDIA_ID },
      { service: fake, security: ownerTestSecurity(), logger },
    );
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody["traceId"]).not.toBe("inbound-attacker-value");
    const logged = (logger.records[0] as { fields: Record<string, unknown> }).fields;
    expect(logged["traceId"]).toBe(firstBody["traceId"]);
  });
});

describe("Owner Media upload intents (#31)", () => {
  it("creates an upload intent once and returns the declared 201 receipt", async () => {
    const fake = createOwnerMediaTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleCreateOwnerMediaUploadIntent(
      intentRequest({ body: intentBody }),
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(201);
    expect(fake.calls.createOwnerMediaUploadIntent).toHaveLength(1);
    const command = fake.calls.createOwnerMediaUploadIntent[0] as {
      kind: string;
      originalFileName: string;
      declaredMediaType: string;
      byteLength: number;
      sha256: string;
      idempotencyKey: string;
    };
    expect(command.kind).toBe("image");
    expect(command.originalFileName).toBe("portfolio-result.png");
    expect(command.declaredMediaType).toBe("image/png");
    expect(command.byteLength).toBe(204800);
    expect(command.sha256).toBe(SHA256);
    expect(command.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    const body = (await response.json()) as unknown;
    expect(zCreateOwnerMediaUploadIntentResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      mediaId: MEDIA_ID,
      aggregateVersion: 1,
      outcome: "media-upload-intent-created",
      uploadIntentId: OWNER_MEDIA_UPLOAD_INTENT_ID,
      uploadTarget: `https://uploads.example.invalid/intents/${OWNER_MEDIA_UPLOAD_INTENT_ID}`,
      expiresAt: "2026-09-22T01:00:00.000Z",
    });
  });

  it("keeps the declared upload reference provider-neutral and out of logs", async () => {
    const fake = createOwnerMediaTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleCreateOwnerMediaUploadIntent(
      intentRequest({ body: intentBody }),
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, unknown>;
    const target = String(body["uploadTarget"]);
    expect(target.startsWith("https://")).toBe(true);
    expect(target).not.toContain("token=");
    expect(target).not.toContain("signed");
    expect(JSON.stringify(logger.records)).not.toContain("uploads.example.invalid");
  });

  it.each([
    ["malformed JSON", { rawBody: "{not-json" }],
    ["missing Idempotency-Key", { idempotencyKey: null, body: intentBody }],
    ["absent body", { body: {} }],
    ["invalid kind", { body: { ...intentBody, kind: "audio" } }],
    ["invalid sha256", { body: { ...intentBody, sha256: "zzz" } }],
    ["unknown closed-shape property", { body: { ...intentBody, extra: "nope" } }],
    ["out-of-shape body", { rawBody: "[]" }],
  ] as Array<[string, Record<string, unknown>]>)(
    "rejects upload intent %s as 400 before dispatch",
    async (_kind, options) => {
      const fake = createOwnerMediaTestFake({ type: "success" });
      const response = await handleCreateOwnerMediaUploadIntent(
        intentRequest(options),
        { service: fake, security: ownerTestSecurity() },
      );
      expect(response.status).toBe(400);
      expect(fake.calls.createOwnerMediaUploadIntent).toHaveLength(0);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("validation");
    },
  );

  it.each([
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
    ["conflict", { kind: "conflict", code: "IDEMPOTENCY_CONFLICT" }, 409, "conflict"],
    ["validation", { kind: "validation", code: "MEDIA_REJECTED" }, 422, "unprocessable"],
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
    "translates upload intent %s rejection to %i",
    async (_label, rejection, status, problemCode) => {
      const fake = createOwnerMediaTestFake({ type: "rejection", rejection });
      const response = await handleCreateOwnerMediaUploadIntent(
        intentRequest({ body: intentBody }),
        { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
      );
      expect(response.status).toBe(status);
      expect(fake.calls.createOwnerMediaUploadIntent).toHaveLength(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it("routes zero-byte declarations to safe business validation instead of narrowing the transport contract", async () => {
    const fake = createOwnerMediaTestFake({ type: "success" });
    const ownerId = OWNER_TEST_ACTOR.kind === "owner" ? OWNER_TEST_ACTOR.ownerId : "" as never;
    const application = createMediaUploadIntentApplicationService({
      scope: {
        ownerId,
        portfolioId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea1" as StableId<"Portfolio">,
      },
      repository: {
        async reserve() { return ok({ kind: "reserved" as const }); },
        async complete() { return ok(undefined); },
        async abandon() {},
        async listExpiredAbandoned() { return ok([]); },
        async markCompensated() { return ok(undefined); },
      },
      target: {
        async prepare() { return err({ kind: "temporarily_unavailable" as const, code: "SHOULD_NOT_PREPARE" }); },
        async removeAbandoned() { return ok(undefined); },
      },
      vault: {
        isAvailable: () => true,
        seal: (plaintext) => ({ version: 1, nonce: "AA==", ciphertext: plaintext, authenticationTag: "AA==" }),
        open: (value) => value.ciphertext,
      },
      ids: { generate: () => "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec0" },
      clock: { now: () => "2026-10-10T19:00:00.000Z" },
    });
    const service = {
      ...fake,
      async createOwnerMediaUploadIntent(command: Parameters<typeof application.create>[0]) {
        return await application.create(command);
      },
    };
    const response = await handleCreateOwnerMediaUploadIntent(
      intentRequest({ body: { ...intentBody, byteLength: 0 } }),
      { service, security: ownerTestSecurity() },
    );
    expect(response.status).toBe(422);
    expect(fake.calls.createOwnerMediaUploadIntent).toHaveLength(0);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("unprocessable");
  });

  it("fails safely when intent fake output is contract-invalid", async () => {
    const fake = createOwnerMediaTestFake({ type: "invalid-success" });
    const response = await handleCreateOwnerMediaUploadIntent(
      intentRequest({ body: intentBody }),
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(500);
  });
});

describe("Owner Media processing, acceptance, and rejection (#31)", () => {
  it("records processing once and returns the declared receipt", async () => {
    const fake = createOwnerMediaTestFake({ type: "success" });
    const response = await handleRecordOwnerMediaProcessing(
      commandRequest(recordUrl, { body: recordBody }),
      { mediaId: MEDIA_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.recordOwnerMediaProcessing).toHaveLength(1);
    const command = fake.calls.recordOwnerMediaProcessing[0] as {
      mediaId: string;
      result: string;
      expectedVersion: number;
      idempotencyKey: string;
    };
    expect(command.mediaId).toBe(MEDIA_ID);
    expect(command.result).toBe("passed");
    expect(command.expectedVersion).toBe(2);
    expect(command.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    const body = (await response.json()) as unknown;
    expect(zRecordOwnerMediaProcessingResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: MEDIA_ID,
      aggregateVersion: 3,
      outcome: "media-processing-recorded",
    });
  });

  it("accepts a Media asset once and returns the declared receipt", async () => {
    const fake = createOwnerMediaTestFake({ type: "success" });
    const response = await handleAcceptOwnerMediaAsset(
      commandRequest(acceptUrl, { body: acceptBody }),
      { mediaId: MEDIA_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.acceptOwnerMediaAsset).toHaveLength(1);
    const command = fake.calls.acceptOwnerMediaAsset[0] as {
      mediaId: string;
      accessibility: Record<string, unknown>;
    };
    expect(command.mediaId).toBe(MEDIA_ID);
    expect(command.accessibility).toEqual(acceptBody.accessibilityMetadata);
    const body = (await response.json()) as unknown;
    expect(zAcceptOwnerMediaAssetResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: MEDIA_ID,
      aggregateVersion: 3,
      outcome: "media-accepted",
    });
  });

  it("rejects a Media asset once and returns the declared receipt", async () => {
    const fake = createOwnerMediaTestFake({ type: "success" });
    const response = await handleRejectOwnerMediaAsset(
      commandRequest(rejectUrl, { body: { reason: "Unsafe content detected." } }),
      { mediaId: MEDIA_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.rejectOwnerMediaAsset).toHaveLength(1);
    const body = (await response.json()) as unknown;
    expect(zRejectOwnerMediaAssetResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: MEDIA_ID,
      aggregateVersion: 3,
      outcome: "media-rejected",
    });
  });

  it.each([
    ["malformed JSON", "record", { rawBody: "{not-json" }, undefined],
    ["missing Idempotency-Key", "record", { idempotencyKey: null, body: recordBody }, undefined],
    ["missing If-Match", "accept", { ifMatch: null, body: acceptBody }, undefined],
    ["invalid If-Match", "reject", { ifMatch: '"0"', body: { reason: "Unsafe." } }, undefined],
    ["invalid path id", "record", { body: recordBody }, "not-a-uuid"],
    ["absent body", "accept", { body: {} }, undefined],
    ["invalid processing result", "record", { body: { ...recordBody, result: "maybe" } }, undefined],
    ["unknown closed-shape property", "accept", { body: { ...acceptBody, extra: "nope" } }, undefined],
    ["missing accessibility metadata", "accept", { body: {} }, undefined],
    ["empty rejection reason", "reject", { body: { reason: "" } }, undefined],
    ["out-of-shape body", "reject", { rawBody: "[]" }, undefined],
  ] as Array<[string, string, Record<string, unknown>, string | undefined]>)(
    "rejects media command %s %s as 400 before dispatch",
    async (_kind, op, options, pathOverride) => {
      const fake = createOwnerMediaTestFake({ type: "success" });
      const deps = { service: fake, security: ownerTestSecurity() };
      let response: Response;
      if (op === "record") {
        response = await handleRecordOwnerMediaProcessing(
          commandRequest(recordUrl, options),
          { mediaId: pathOverride ?? MEDIA_ID },
          deps,
        );
      } else if (op === "accept") {
        response = await handleAcceptOwnerMediaAsset(
          commandRequest(acceptUrl, options),
          { mediaId: pathOverride ?? MEDIA_ID },
          deps,
        );
      } else {
        response = await handleRejectOwnerMediaAsset(
          commandRequest(rejectUrl, options),
          { mediaId: pathOverride ?? MEDIA_ID },
          deps,
        );
      }
      expect(response.status).toBe(400);
      const totalCalls =
        fake.calls.recordOwnerMediaProcessing.length +
        fake.calls.acceptOwnerMediaAsset.length +
        fake.calls.rejectOwnerMediaAsset.length;
      expect(totalCalls).toBe(0);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("validation");
    },
  );

  const commandRejections = [
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
    ["not_found", { kind: "not_found", code: "MEDIA_NOT_FOUND" }, 404, "not_found"],
    ["conflict", { kind: "conflict", code: "IDEMPOTENCY_CONFLICT" }, 409, "conflict"],
    ["precondition_failed", { kind: "precondition_failed", code: "VERSION_MISMATCH" }, 412, "failed_precondition"],
    ["validation", { kind: "validation", code: "MEDIA_REJECTED" }, 422, "unprocessable"],
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

  async function dispatchMediaCommand(
    op: "record" | "accept" | "reject",
    fake: ReturnType<typeof createOwnerMediaTestFake>,
  ): Promise<Response> {
    const deps = { service: fake, security: ownerTestSecurity(), logger: createTestLogger() };
    if (op === "record") {
      return await handleRecordOwnerMediaProcessing(
        commandRequest(recordUrl, { body: recordBody }),
        { mediaId: MEDIA_ID },
        deps,
      );
    }
    if (op === "accept") {
      return await handleAcceptOwnerMediaAsset(
        commandRequest(acceptUrl, { body: acceptBody }),
        { mediaId: MEDIA_ID },
        deps,
      );
    }
    return await handleRejectOwnerMediaAsset(
      commandRequest(rejectUrl, { body: { reason: "Unsafe content detected." } }),
      { mediaId: MEDIA_ID },
      deps,
    );
  }

  function commandCallCount(
    fake: ReturnType<typeof createOwnerMediaTestFake>,
    op: "record" | "accept" | "reject",
  ): number {
    if (op === "record") return fake.calls.recordOwnerMediaProcessing.length;
    if (op === "accept") return fake.calls.acceptOwnerMediaAsset.length;
    return fake.calls.rejectOwnerMediaAsset.length;
  }

  it.each(commandRejections)(
    "translates record %s rejection to %i",
    async (_label, rejection, status, problemCode) => {
      const fake = createOwnerMediaTestFake({ type: "rejection", rejection });
      const response = await dispatchMediaCommand("record", fake);
      expect(response.status).toBe(status);
      expect(commandCallCount(fake, "record")).toBe(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it.each(commandRejections)(
    "translates accept %s rejection to %i",
    async (_label, rejection, status, problemCode) => {
      const fake = createOwnerMediaTestFake({ type: "rejection", rejection });
      const response = await dispatchMediaCommand("accept", fake);
      expect(response.status).toBe(status);
      expect(commandCallCount(fake, "accept")).toBe(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it.each(commandRejections)(
    "translates reject %s rejection to %i",
    async (_label, rejection, status, problemCode) => {
      const fake = createOwnerMediaTestFake({ type: "rejection", rejection });
      const response = await dispatchMediaCommand("reject", fake);
      expect(response.status).toBe(status);
      expect(commandCallCount(fake, "reject")).toBe(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it("translates accept forbidden and reject validation without provider auth", async () => {
    const forbidden = createOwnerMediaTestFake({
      type: "rejection",
      rejection: { kind: "forbidden", code: "OWNER_FORBIDDEN" },
    });
    const accepted = await handleAcceptOwnerMediaAsset(
      commandRequest(acceptUrl, { body: acceptBody }),
      { mediaId: MEDIA_ID },
      { service: forbidden, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(accepted.status).toBe(403);

    const invalid = createOwnerMediaTestFake({
      type: "rejection",
      rejection: { kind: "validation", code: "MEDIA_REJECTED" },
    });
    const rejected = await handleRejectOwnerMediaAsset(
      commandRequest(rejectUrl, { body: { reason: "Unsafe content detected." } }),
      { mediaId: MEDIA_ID },
      { service: invalid, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(rejected.status).toBe(422);
  });

  it("fails safely when command fake output is contract-invalid", async () => {
    const fake = createOwnerMediaTestFake({ type: "invalid-success" });
    const response = await handleRecordOwnerMediaProcessing(
      commandRequest(recordUrl, { body: recordBody }),
      { mediaId: MEDIA_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(500);
  });

  it("production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED for all five operations", async () => {
    const service = createProductionOwnerMediaService();
    const logger = createTestLogger();
    const responses = [
      await handleGetOwnerMediaAggregate(getRequest(), { mediaId: MEDIA_ID }, { service, security: ownerTestSecurity(), logger }),
      await handleCreateOwnerMediaUploadIntent(
        intentRequest({ body: intentBody }),
        { service, security: ownerTestSecurity(), logger },
      ),
      await handleRecordOwnerMediaProcessing(
        commandRequest(recordUrl, { body: recordBody }),
        { mediaId: MEDIA_ID },
        { service, security: ownerTestSecurity(), logger },
      ),
      await handleAcceptOwnerMediaAsset(
        commandRequest(acceptUrl, { body: acceptBody }),
        { mediaId: MEDIA_ID },
        { service, security: ownerTestSecurity(), logger },
      ),
      await handleRejectOwnerMediaAsset(
        commandRequest(rejectUrl, { body: { reason: "Unsafe content detected." } }),
        { mediaId: MEDIA_ID },
        { service, security: ownerTestSecurity(), logger },
      ),
    ];
    expect(responses).toHaveLength(5);
    for (const response of responses) {
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe("temporarily_unavailable");
    }
    const owner = { kind: "owner", ownerId: MEDIA_ID, sessionId: "s" } as const;
    const directCalls = [
      service.getOwnerMediaAggregate({ actor: owner as never, mediaId: MEDIA_ID as never }),
      service.createOwnerMediaUploadIntent({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        kind: "image" as const,
        originalFileName: "portfolio-result.png",
        declaredMediaType: "image/png",
        byteLength: 204800,
        sha256: SHA256,
      }),
      service.recordOwnerMediaProcessing({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        mediaId: MEDIA_ID as never,
        result: "passed" as const,
        detectedMediaType: "image/png",
        detectedByteLength: 204800,
        sha256: SHA256,
      }),
      service.acceptOwnerMediaAsset({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        mediaId: MEDIA_ID as never,
        accessibility: { kind: "decorative-image" as const },
      }),
      service.rejectOwnerMediaAsset({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        mediaId: MEDIA_ID as never,
        reason: "Unsafe content detected.",
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
      async getOwnerMediaAggregate(): Promise<never> {
        throw new Error("boom postgres://user:pass@host/db token=tok_123 /app/secret.ts signed?token=abc");
      },
      async createOwnerMediaUploadIntent(): Promise<never> {
        throw new Error("unreachable");
      },
      async recordOwnerMediaProcessing(): Promise<never> {
        throw new Error("unreachable");
      },
      async acceptOwnerMediaAsset(): Promise<never> {
        throw new Error("unreachable");
      },
      async rejectOwnerMediaAsset(): Promise<never> {
        throw new Error("unreachable");
      },
    };
    const response = await handleGetOwnerMediaAggregate(
      getRequest(),
      { mediaId: MEDIA_ID },
      { service: throwing, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(500);
    const serialized = JSON.stringify(await response.json());
    for (const leak of ["postgres://", "tok_123", "/app/secret.ts", "signed", "boom"]) {
      expect(serialized).not.toContain(leak);
    }
    expect(JSON.stringify(logger.records)).not.toContain("postgres://");
  });
});
