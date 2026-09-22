/**
 * owner-taxonomy.test.ts — Phase 2 #30
 *
 * Seam under test (pre-agreed): the Owner Taxonomy HTTP adapter observed
 * through standard Request and Response objects with an injected application
 * fake.
 *
 * Acceptance (issue #30, taxonomy slice):
 * - Exactly one handwritten adapter covers Taxonomy aggregate retrieval and
 *   Taxonomy-value creation, rename, retirement, and merge; each validates
 *   path, headers, and body with generated strict validators before dispatch.
 * - Each handler constructs one operation-specific command or query and
 *   invokes one injected application interface exactly once.
 * - Deterministic fakes exercise contract-valid successes and every declared
 *   rejection without implementing Taxonomy, persistence, or authorization
 *   rules.
 * - Production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED
 *   for all five operations.
 */

import { describe, expect, it } from "vitest";

import {
  zCreateOwnerTaxonomyValueResponse,
  zGetOwnerTaxonomyAggregateResponse,
  zMergeOwnerTaxonomyValueResponse,
  zProblem,
  zRenameOwnerTaxonomyValueResponse,
  zRetireOwnerTaxonomyValueResponse,
} from "../../src/contracts/http/owner/v1/generated/zod.gen.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import {
  createOwnerTaxonomyTestFake,
  createProductionOwnerTaxonomyService,
} from "../../src/runtime/fakes/owner-taxonomy.js";
import {
  handleCreateOwnerTaxonomyValue,
  handleGetOwnerTaxonomyAggregate,
  handleMergeOwnerTaxonomyValue,
  handleRenameOwnerTaxonomyValue,
  handleRetireOwnerTaxonomyValue,
} from "../../src/runtime/http/owner-taxonomy.js";

const TAXONOMY_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7eb0";
const VALUE_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7eb1";
const TARGET_VALUE_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7eb2";
const IDEMPOTENCY_KEY = "test-key-123";
const IF_MATCH = '"2"';

function getRequest(taxonomyId: string = TAXONOMY_ID, inboundTrace?: string): Request {
  const headers: Record<string, string> = {};
  if (inboundTrace !== undefined) {
    headers["x-request-id"] = inboundTrace;
  }
  return new Request(`https://example.com/api/owner/v1/taxonomies/${taxonomyId}`, {
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
  const headers: Record<string, string> = { "content-type": "application/json" };
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

const taxonomyValuesUrl = `https://example.com/api/owner/v1/taxonomies/${TAXONOMY_ID}/values`;
const renameUrl = `https://example.com/api/owner/v1/taxonomy-values/${VALUE_ID}/commands/rename`;
const retireUrl = `https://example.com/api/owner/v1/taxonomy-values/${VALUE_ID}/commands/retire`;
const mergeUrl = `https://example.com/api/owner/v1/taxonomy-values/${VALUE_ID}/commands/merge`;

describe("Owner Taxonomy aggregate retrieval (#30)", () => {
  it("retrieves the aggregate once and returns the declared view", async () => {
    const fake = createOwnerTaxonomyTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleGetOwnerTaxonomyAggregate(
      getRequest(),
      { taxonomyId: TAXONOMY_ID },
      { service: fake, logger },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.getOwnerTaxonomyAggregate).toHaveLength(1);
    expect(fake.calls.createOwnerTaxonomyValue).toHaveLength(0);
    const query = fake.calls.getOwnerTaxonomyAggregate[0] as { taxonomyId: string };
    expect(query.taxonomyId).toBe(TAXONOMY_ID);
    const body = (await response.json()) as unknown;
    expect(zGetOwnerTaxonomyAggregateResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      taxonomyId: TAXONOMY_ID,
      aggregateVersion: 1,
      kind: "technology",
      values: [{ valueId: VALUE_ID, name: "TypeScript", state: "active" }],
    });
  });

  it.each([["invalid taxonomyId", "not-a-uuid"]])(
    "rejects %s as 400 before dispatch",
    async (_label, taxonomyId) => {
      const fake = createOwnerTaxonomyTestFake({ type: "success" });
      const response = await handleGetOwnerTaxonomyAggregate(
        getRequest(taxonomyId),
        { taxonomyId },
        { service: fake, logger: createTestLogger() },
      );
      expect(response.status).toBe(400);
      expect(fake.calls.getOwnerTaxonomyAggregate).toHaveLength(0);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("validation");
    },
  );

  it.each([
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
    ["not_found", { kind: "not_found", code: "TAXONOMY_NOT_FOUND" }, 404, "not_found"],
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
      const fake = createOwnerTaxonomyTestFake({ type: "rejection", rejection });
      const logger = createTestLogger();
      const response = await handleGetOwnerTaxonomyAggregate(
        getRequest(),
        { taxonomyId: TAXONOMY_ID },
        { service: fake, logger },
      );
      expect(response.status).toBe(status);
      expect(fake.calls.getOwnerTaxonomyAggregate).toHaveLength(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it("fails safely when fake output is contract-invalid", async () => {
    const fake = createOwnerTaxonomyTestFake({ type: "invalid-success" });
    const response = await handleGetOwnerTaxonomyAggregate(
      getRequest(),
      { taxonomyId: TAXONOMY_ID },
      { service: fake, logger: createTestLogger() },
    );
    expect(response.status).toBe(500);
  });

  it("uses a server-generated trace identifier shared by Problem Details and logs", async () => {
    const fake = createOwnerTaxonomyTestFake({
      type: "rejection",
      rejection: { kind: "not_found", code: "TAXONOMY_NOT_FOUND" },
    });
    const logger = createTestLogger();
    const first = await handleGetOwnerTaxonomyAggregate(
      getRequest(TAXONOMY_ID, "inbound-attacker-value"),
      { taxonomyId: TAXONOMY_ID },
      { service: fake, logger },
    );
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody["traceId"]).not.toBe("inbound-attacker-value");
    const logged = (logger.records[0] as { fields: Record<string, unknown> }).fields;
    expect(logged["traceId"]).toBe(firstBody["traceId"]);
  });
});

describe("Owner Taxonomy commands (#30)", () => {
  it("creates a Taxonomy value once and returns the declared 201 receipt", async () => {
    const fake = createOwnerTaxonomyTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleCreateOwnerTaxonomyValue(
      postRequest(taxonomyValuesUrl, { body: { name: "TypeScript" } }),
      { taxonomyId: TAXONOMY_ID },
      { service: fake, logger },
    );
    expect(response.status).toBe(201);
    expect(fake.calls.createOwnerTaxonomyValue).toHaveLength(1);
    const command = fake.calls.createOwnerTaxonomyValue[0] as {
      taxonomyId: string;
      name: string;
      expectedVersion: number;
      idempotencyKey: string;
    };
    expect(command.taxonomyId).toBe(TAXONOMY_ID);
    expect(command.name).toBe("TypeScript");
    expect(command.expectedVersion).toBe(2);
    expect(command.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    const body = (await response.json()) as unknown;
    expect(zCreateOwnerTaxonomyValueResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: TAXONOMY_ID,
      aggregateVersion: 3,
      outcome: "taxonomy-value-created",
    });
  });

  it("renames a Taxonomy value once and returns the declared receipt", async () => {
    const fake = createOwnerTaxonomyTestFake({ type: "success" });
    const response = await handleRenameOwnerTaxonomyValue(
      postRequest(renameUrl, { body: { name: "TypeScript Renamed" } }),
      { valueId: VALUE_ID },
      { service: fake, logger: createTestLogger() },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.renameOwnerTaxonomyValue).toHaveLength(1);
    const body = (await response.json()) as unknown;
    expect(zRenameOwnerTaxonomyValueResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: VALUE_ID,
      aggregateVersion: 3,
      outcome: "taxonomy-value-renamed",
    });
  });

  it("retires a Taxonomy value once and returns the declared receipt", async () => {
    const fake = createOwnerTaxonomyTestFake({ type: "success" });
    const response = await handleRetireOwnerTaxonomyValue(
      postRequest(retireUrl, { body: {} }),
      { valueId: VALUE_ID },
      { service: fake, logger: createTestLogger() },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.retireOwnerTaxonomyValue).toHaveLength(1);
    const body = (await response.json()) as unknown;
    expect(zRetireOwnerTaxonomyValueResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: VALUE_ID,
      aggregateVersion: 3,
      outcome: "taxonomy-value-retired",
    });
  });

  it("merges a Taxonomy value once and returns the declared receipt", async () => {
    const fake = createOwnerTaxonomyTestFake({ type: "success" });
    const response = await handleMergeOwnerTaxonomyValue(
      postRequest(mergeUrl, { body: { targetValueId: TARGET_VALUE_ID } }),
      { valueId: VALUE_ID },
      { service: fake, logger: createTestLogger() },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.mergeOwnerTaxonomyValue).toHaveLength(1);
    const body = (await response.json()) as unknown;
    expect(zMergeOwnerTaxonomyValueResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: VALUE_ID,
      aggregateVersion: 3,
      outcome: "taxonomy-value-merged",
    });
  });

  it.each([
    ["malformed JSON", "create", { rawBody: "{not-json" }, undefined, undefined],
    ["missing Idempotency-Key", "create", { idempotencyKey: null, body: { name: "TypeScript" } }, undefined, undefined],
    ["missing If-Match", "rename", { ifMatch: null, body: { name: "TypeScript" } }, undefined, undefined],
    ["invalid If-Match", "retire", { ifMatch: '"0"', body: {} }, undefined, undefined],
    ["invalid path id", "merge", { body: { targetValueId: TARGET_VALUE_ID } }, "not-a-uuid", undefined],
    ["absent body", "create", { body: {} }, undefined, undefined],
    ["out-of-range name", "rename", { body: { name: "" } }, undefined, undefined],
    ["unknown closed-shape property", "retire", { body: { reason: "stale", extra: "nope" } }, undefined, undefined],
    ["out-of-shape body", "merge", { body: [] }, undefined, undefined],
    ["invalid target id", "merge", { body: { targetValueId: "not-a-uuid" } }, undefined, undefined],
  ] as Array<[string, string, Record<string, unknown>, string | undefined, string | undefined]>)(
    "rejects command %s %s as 400 before dispatch",
    async (_kind, op, options, pathOverride) => {
      const fake = createOwnerTaxonomyTestFake({ type: "success" });
      const deps = { service: fake };
      let response: Response;
      if (op === "create") {
        response = await handleCreateOwnerTaxonomyValue(
          postRequest(taxonomyValuesUrl, options),
          { taxonomyId: TAXONOMY_ID },
          deps,
        );
      } else if (op === "rename") {
        response = await handleRenameOwnerTaxonomyValue(
          postRequest(renameUrl, options),
          { valueId: VALUE_ID },
          deps,
        );
      } else if (op === "retire") {
        response = await handleRetireOwnerTaxonomyValue(
          postRequest(retireUrl, options),
          { valueId: VALUE_ID },
          deps,
        );
      } else {
        const resolvedValueId = pathOverride ?? VALUE_ID;
        response = await handleMergeOwnerTaxonomyValue(
          postRequest(mergeUrl, options),
          { valueId: resolvedValueId },
          deps,
        );
      }
      expect(response.status).toBe(400);
      const totalCalls =
        fake.calls.createOwnerTaxonomyValue.length +
        fake.calls.renameOwnerTaxonomyValue.length +
        fake.calls.retireOwnerTaxonomyValue.length +
        fake.calls.mergeOwnerTaxonomyValue.length;
      expect(totalCalls).toBe(0);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("validation");
    },
  );

  it.each([
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
    ["not_found", { kind: "not_found", code: "TAXONOMY_NOT_FOUND" }, 404, "not_found"],
    ["conflict", { kind: "conflict", code: "IDEMPOTENCY_CONFLICT" }, 409, "conflict"],
    ["precondition_failed", { kind: "precondition_failed", code: "VERSION_MISMATCH" }, 412, "failed_precondition"],
    ["validation", { kind: "validation", code: "TAXONOMY_REJECTED" }, 422, "unprocessable"],
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
    "translates status %s rejection to %i",
    async (_label, rejection, status, problemCode) => {
      const fake = createOwnerTaxonomyTestFake({ type: "rejection", rejection });
      const response = await handleCreateOwnerTaxonomyValue(
        postRequest(taxonomyValuesUrl, { body: { name: "TypeScript" } }),
        { taxonomyId: TAXONOMY_ID },
        { service: fake, logger: createTestLogger() },
      );
      expect(response.status).toBe(status);
      expect(fake.calls.createOwnerTaxonomyValue).toHaveLength(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it("translates rename forbidden and merge validation without provider auth", async () => {
    const forbidden = createOwnerTaxonomyTestFake({
      type: "rejection",
      rejection: { kind: "forbidden", code: "OWNER_FORBIDDEN" },
    });
    const rename = await handleRenameOwnerTaxonomyValue(
      postRequest(renameUrl, { body: { name: "TypeScript Renamed" } }),
      { valueId: VALUE_ID },
      { service: forbidden, logger: createTestLogger() },
    );
    expect(rename.status).toBe(403);

    const invalid = createOwnerTaxonomyTestFake({
      type: "rejection",
      rejection: { kind: "validation", code: "TAXONOMY_REJECTED" },
    });
    const merge = await handleMergeOwnerTaxonomyValue(
      postRequest(mergeUrl, { body: { targetValueId: TARGET_VALUE_ID } }),
      { valueId: VALUE_ID },
      { service: invalid, logger: createTestLogger() },
    );
    expect(merge.status).toBe(422);
  });

  it("fails safely when command fake output is contract-invalid", async () => {
    const fake = createOwnerTaxonomyTestFake({ type: "invalid-success" });
    const response = await handleCreateOwnerTaxonomyValue(
      postRequest(taxonomyValuesUrl, { body: { name: "TypeScript" } }),
      { taxonomyId: TAXONOMY_ID },
      { service: fake, logger: createTestLogger() },
    );
    expect(response.status).toBe(500);
  });

  it("production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED for all five operations", async () => {
    const service = createProductionOwnerTaxonomyService();
    const logger = createTestLogger();
    const responses = [
      await handleGetOwnerTaxonomyAggregate(getRequest(), { taxonomyId: TAXONOMY_ID }, { service, logger }),
      await handleCreateOwnerTaxonomyValue(
        postRequest(taxonomyValuesUrl, { body: { name: "TypeScript" } }),
        { taxonomyId: TAXONOMY_ID },
        { service, logger },
      ),
      await handleRenameOwnerTaxonomyValue(
        postRequest(renameUrl, { body: { name: "TypeScript Renamed" } }),
        { valueId: VALUE_ID },
        { service, logger },
      ),
      await handleRetireOwnerTaxonomyValue(
        postRequest(retireUrl, { body: {} }),
        { valueId: VALUE_ID },
        { service, logger },
      ),
      await handleMergeOwnerTaxonomyValue(
        postRequest(mergeUrl, { body: { targetValueId: TARGET_VALUE_ID } }),
        { valueId: VALUE_ID },
        { service, logger },
      ),
    ];
    expect(responses).toHaveLength(5);
    for (const response of responses) {
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe("temporarily_unavailable");
    }
    const owner = { kind: "owner", ownerId: TAXONOMY_ID, sessionId: "s" } as const;
    const directCalls = [
      service.getOwnerTaxonomyAggregate({ actor: owner as never, taxonomyId: TAXONOMY_ID as never }),
      service.createOwnerTaxonomyValue({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        taxonomyId: TAXONOMY_ID as never,
        name: "TypeScript",
      }),
      service.renameOwnerTaxonomyValue({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        valueId: VALUE_ID as never,
        name: "TypeScript Renamed",
      }),
      service.retireOwnerTaxonomyValue({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        valueId: VALUE_ID as never,
      }),
      service.mergeOwnerTaxonomyValue({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        valueId: VALUE_ID as never,
        targetValueId: TARGET_VALUE_ID as never,
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
      async getOwnerTaxonomyAggregate(): Promise<never> {
        throw new Error("boom postgres://user:pass@host/db token=tok_123 /app/secret.ts");
      },
      async createOwnerTaxonomyValue(): Promise<never> {
        throw new Error("unreachable");
      },
      async renameOwnerTaxonomyValue(): Promise<never> {
        throw new Error("unreachable");
      },
      async retireOwnerTaxonomyValue(): Promise<never> {
        throw new Error("unreachable");
      },
      async mergeOwnerTaxonomyValue(): Promise<never> {
        throw new Error("unreachable");
      },
    };
    const response = await handleGetOwnerTaxonomyAggregate(
      getRequest(),
      { taxonomyId: TAXONOMY_ID },
      { service: throwing, logger },
    );
    expect(response.status).toBe(500);
    const serialized = JSON.stringify(await response.json());
    for (const leak of ["postgres://", "tok_123", "/app/secret.ts", "boom"]) {
      expect(serialized).not.toContain(leak);
    }
    expect(JSON.stringify(logger.records)).not.toContain("postgres://");
  });
});
