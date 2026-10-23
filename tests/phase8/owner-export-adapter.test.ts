/**
 * owner-export-adapter.test.ts — Phase 8 #238 Owner export HTTP adapter acceptance.
 *
 * The three existing Owner export operations observed through standard
 * Request and Response objects with a provider-neutral application service
 * whose store fake matches identities exactly.
 *
 * Criteria covered here:
 * - AC06: the verified Owner allowlist and explicit Portfolio scope gate every
 *   adapter dispatch; unauthenticated, denied-session, forwarded-host, origin,
 *   CSRF, and rate-limited requests never reach any application operation; a
 *   non-owner or cross-Portfolio read never reveals protected existence (the
 *   same `not_found` problem as an unknown export).
 * - AC08: every success response carries the declared private/no-store
 *   headers, response bodies validate against the generated Owner v1
 *   schemas, malformed ids, keys, and bodies reject before dispatch, and
 *   rate-limited responses carry Retry-After.
 */
import { describe, expect, it } from "vitest";

import {
  zGetOwnerExportResponse,
  zProblem,
  zRequestOwnerExportResponse,
} from "../../src/contracts/http/owner/v1/generated/zod.gen.js";
import {
  createOwnerExportTestFake,
  OWNER_EXPORT_ID,
  OWNER_EXPORT_SCHEMA_VERSION,
} from "../../src/runtime/fakes/owner-export.js";
import {
  handleDownloadOwnerExport,
  handleGetOwnerExport,
  handleRequestOwnerExport,
  OWNER_EXPORT_MEDIA_TYPE,
  type OwnerExportAdapterDeps,
} from "../../src/runtime/http/owner-export.js";
import {
  OWNER_CSRF_HEADER,
  OWNER_PRIVATE_RESPONSE_HEADERS,
  createOwnerSecurityTestStub,
  type OwnerRequestSecurity,
} from "../../src/runtime/http/owner-security.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import {
  createOwnerExportService,
  type LeasedJobStorePort,
  type OperationsPersistencePorts,
  type OwnerExportApplicationService,
  type OwnerExportReservationInput,
  type OwnerExportServiceDependencies,
  type OwnerExportStorePort,
  type PersistedOwnerExport,
} from "../../src/modules/portability-operations/index.js";
import { unsafeStableId, type StableId } from "../../src/shared/domain/index.js";
import { OWNER_TEST_ACTOR, OWNER_TEST_ORIGIN, OWNER_TEST_SESSION_TOKEN, ownerTestSecurity, withOwnerTestAuth } from "../runtime/owner-test-auth.js";

const IDEMPOTENCY_KEY = "phase8-adapter-key-001";
const PORTFOLIO_ID = unsafeStableId<"Portfolio">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ee1");
const FOREIGN_PORTFOLIO_ID = unsafeStableId<"Portfolio">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ee9");
const FOREIGN_OWNER_ID = unsafeStableId<"Owner">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7eb5");
const PERSISTED_ARTIFACT_ID = unsafeStableId<"OwnerExportArtifact">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec7");

/** {@link OwnerTestActor} security stub (allow path) plus exact application origin. */
function security(): OwnerRequestSecurity {
  return ownerTestSecurity();
}

/** Exact-triple store fake: protected existence is only addressable in scope. */
function scopedStore(persisted: readonly PersistedOwnerExport[]): OwnerExportStorePort & { reservations: OwnerExportReservationInput[] } {
  const reservations: OwnerExportReservationInput[] = [];
  return {
    reservations,
    async reserveOwnerExport(input) {
      reservations.push(input);
    },
    async findOwnerExport(input) {
      return persisted.find((row) =>
        row.exportId === input.exportId &&
        row.portfolioId === input.portfolioId &&
        row.ownerId === input.ownerId) ?? null;
    },
    async applyOwnerExportTransition() {
      return { ok: true as const, value: { kind: "stale" as const } };
    },
  };
}

function serviceForStore(store: OwnerExportStorePort): OwnerExportApplicationService {
  const operations = {
    transactions: { async run(callback: (context: { kind: "transaction" }) => unknown) { return callback({ kind: "transaction" }); } },
    idempotency: {
      async execute(
        _input: { requestHash: string },
        effect: (context: { kind: "transaction" }) => Promise<Record<string, unknown>>,
      ): Promise<unknown> {
        const result = await effect({ kind: "transaction" });
        return { kind: "executed", result };
      },
    },
    outbox: { async append() {} },
    jobs: { async enqueue() {} } as unknown as LeasedJobStorePort,
  } as unknown as OperationsPersistencePorts;
  const dependencies: OwnerExportServiceDependencies = {
    operations,
    exports: store,
    clock: { now: () => "2026-10-23T09:00:00.000Z" },
    ids: { generate: () => unsafeStableId<"OwnerExport">("0196a1b2-7c3d-7e11-9f22-000000000070") },
  };
  return createOwnerExportService(dependencies);
}

/**
 * One real Owner export row owned by a foreign Owner in a foreign Portfolio:
 * the adapter's own portfolio and verifiable session must not reach it.
 */
function serviceWithForeignReadyExport(): { service: OwnerExportApplicationService; exportId: string } {
  const exportId = unsafeStableId<"OwnerExport">(OWNER_EXPORT_ID);
  const persisted: readonly PersistedOwnerExport[] = [{
    exportId,
    portfolioId: FOREIGN_PORTFOLIO_ID,
    ownerId: FOREIGN_OWNER_ID,
    includedScopes: ["portfolio-content"],
    status: "ready",
    schemaVersion: OWNER_EXPORT_SCHEMA_VERSION,
    requestedAt: "2026-10-23T08:00:00.000Z",
    completedAt: "2026-10-23T08:01:00.000Z",
    integrityManifest: {
      packageFormat: "shipwithali-owner-export",
      schemaVersion: OWNER_EXPORT_SCHEMA_VERSION,
      createdAt: "2026-10-23T08:01:00.000Z",
      algorithm: "sha-256",
      digest: "a".repeat(64),
      includedScopes: ["portfolio-content"],
      publicEventDataCoverage: { mode: "excluded" },
      entries: [{
        path: "portfolio-content/projects.ndjson",
        scope: "portfolio-content",
        mediaType: "application/x-ndjson",
        recordSchema: "urn:shipwithali:owner-export-schema:portfolio-content:1.0",
        schemaPath: "schemas/portfolio-content.schema.json",
        schemaVersion: OWNER_EXPORT_SCHEMA_VERSION,
        digest: "b".repeat(64),
        recordCount: 1,
      }],
    },
    artifactId: PERSISTED_ARTIFACT_ID,
  }];
  return { service: serviceForStore(scopedStore(persisted)), exportId };
}

function deps(
  service: OwnerExportAdapterDeps["service"],
  securityOverride?: OwnerRequestSecurity,
  portfolioId?: StableId<"Portfolio">,
): OwnerExportAdapterDeps {
  return { service, security: securityOverride ?? security(), portfolioId: portfolioId ?? PORTFOLIO_ID, logger: createTestLogger() };
}

function postRequest(options: {
  body?: unknown;
  idempotencyKey?: string | null;
  headers?: Record<string, string>;
  includeAuth?: boolean;
} = {}): Request {
  const base = options.includeAuth === false
    ? { "content-type": "application/json" }
    : withOwnerTestAuth({ "content-type": "application/json" });
  // Explicit overrides win over auth defaults, so origin/CSRF rejections are
  // reachable from transport-level fakes.
  const headers = { ...base, ...(options.headers ?? {}) };
  if (options.idempotencyKey !== null && !("Idempotency-Key" in headers)) {
    headers["Idempotency-Key"] = options.idempotencyKey ?? IDEMPOTENCY_KEY;
  }
  if (options.idempotencyKey === null) {
    delete headers["Idempotency-Key"];
  }
  return new Request("https://example.com/api/owner/v1/exports", {
    method: "POST",
    headers,
    body: JSON.stringify(options.body ?? { includedScopes: ["portfolio-content", "taxonomy"] }),
  });
}

function readRequest(path: string, headers?: Record<string, string>): Request {
  return new Request(`https://example.com/api/owner/v1/exports/${path}`, {
    method: "GET",
    headers: withOwnerTestAuth(headers ?? {}),
  });
}

describe("AC06: adapter envelope only dispatches verified owners in scope", () => {
  it("rejects requests without a session cookie as 401 before dispatch", async () => {
    const fake = createOwnerExportTestFake({ type: "success" });
    const shared = deps(fake);
    const post = await handleRequestOwnerExport(postRequest({ includeAuth: false }), shared);
    for (const path of [OWNER_EXPORT_ID, `${OWNER_EXPORT_ID}/download`] as const) {
      const response = await handleGetOwnerExport(
        new Request(`https://example.com/api/owner/v1/exports/${path}`, { method: "GET" }),
        { exportId: OWNER_EXPORT_ID },
        shared,
      );
      expect(response.status).toBe(401);
    }
    const get = await handleGetOwnerExport(
      new Request(`https://example.com/api/owner/v1/exports/${OWNER_EXPORT_ID}`, { method: "GET" }),
      { exportId: OWNER_EXPORT_ID },
      shared,
    );
    const download = await handleDownloadOwnerExport(
      new Request(`https://example.com/api/owner/v1/exports/${OWNER_EXPORT_ID}/download`, { method: "GET" }),
      { exportId: OWNER_EXPORT_ID },
      shared,
    );
    for (const [response, label] of [[post, "post"], [get, "get"], [download, "download"]] as const) {
      const parsed = zProblem.safeParse(await response.json());
      expect(parsed.success, label).toBe(true);
      expect(response.status, label).toBe(401);
    }
    expect(fake.calls.requestOwnerExport).toHaveLength(0);
    expect(fake.calls.getOwnerExport).toHaveLength(0);
    expect(fake.calls.downloadOwnerExport).toHaveLength(0);
  });

  it("rejects denied sessions and phases via declared rejections cheaply and early", async () => {
    const denied = { ...createOwnerSecurityTestStub({ type: "deny", rejection: { kind: "forbidden", code: "OWNER_SESSION_REVOKED" } }), appOrigin: OWNER_TEST_ORIGIN };
    const fake = createOwnerExportTestFake({ type: "success" });
    const response = await handleGetOwnerExport(readRequest(OWNER_EXPORT_ID), { exportId: OWNER_EXPORT_ID }, deps(fake, denied));
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("forbidden");
    expect(fake.calls.getOwnerExport).toHaveLength(0);
  });

  it("rejects forwarded host, origin mismatch, and CSRF proof mismatch as 403 before dispatch", async () => {
    const fake = createOwnerExportTestFake({ type: "success" });
    for (const forwarded of [{ "x-forwarded-host": "attacker.example" }, { forwarded: "host=attacker.example; for=192.0.2.1" }]) {
      const read = await handleGetOwnerExport(readRequest(OWNER_EXPORT_ID, forwarded), { exportId: OWNER_EXPORT_ID }, deps(fake));
      const mutation = await handleRequestOwnerExport(postRequest({ headers: forwarded }), deps(fake));
      expect(read.status).toBe(403);
      expect(mutation.status).toBe(403);
      const body = (await read.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("forbidden");
    }
    const originMismatch = await handleRequestOwnerExport(postRequest({ headers: { origin: "https://attacker.example" } }), deps(fake));
    expect(originMismatch.status).toBe(403);
    const missingProof = await handleRequestOwnerExport(postRequest({ headers: { [OWNER_CSRF_HEADER]: "" } }), deps(fake));
    expect(missingProof.status).toBe(403);
    const sessionAsProof = await handleRequestOwnerExport(
      postRequest({ headers: { [OWNER_CSRF_HEADER]: OWNER_TEST_SESSION_TOKEN } }),
      deps(fake),
    );
    expect(sessionAsProof.status).toBe(403);
    for (const response of [originMismatch, missingProof, sessionAsProof]) {
      expect(((await response.json()) as Record<string, unknown>)["code"]).toBe("forbidden");
    }
    // Reads stay untouched by the mutation-only origin/CSRF policy.
    const readAfter = await handleGetOwnerExport(readRequest(OWNER_EXPORT_ID), { exportId: OWNER_EXPORT_ID }, deps(fake));
    expect(readAfter.status).toBe(200);
    expect(fake.calls.requestOwnerExport).toHaveLength(0);
    expect(fake.calls.getOwnerExport).toHaveLength(1);
    expect(fake.calls.downloadOwnerExport).toHaveLength(0);
  });

  it("returns 429 with Retry-After and no dispatch when the rate limit denies", async () => {
    const limited = { ...createOwnerSecurityTestStub({ type: "rate-limited", actor: OWNER_TEST_ACTOR, retryAfterSeconds: 61 }), appOrigin: OWNER_TEST_ORIGIN };
    const fake = createOwnerExportTestFake({ type: "success" });
    const read = await handleGetOwnerExport(readRequest(OWNER_EXPORT_ID), { exportId: OWNER_EXPORT_ID }, deps(fake, limited));
    const mutation = await handleRequestOwnerExport(postRequest(), deps(fake, limited));
    expect(read.status).toBe(429);
    expect(mutation.status).toBe(429);
    expect(read.headers.get("retry-after")).toBe("61");
    expect(mutation.headers.get("retry-after")).toBe("61");
    expect(fake.calls.getOwnerExport).toHaveLength(0);
    expect(fake.calls.requestOwnerExport).toHaveLength(0);
  });

  it("never reveals protected existence for cross-owner and cross-portfolio reads", async () => {
    const { service } = serviceWithForeignReadyExport();
    const logger = createTestLogger();
    const shared: OwnerExportAdapterDeps = { service, security: ownerTestSecurity(), portfolioId: PORTFOLIO_ID, logger };
    // This adapter's configured Portfolio and verified session identity resolve
    // the query; the store holds only a row owned by a foreign Owner in a
    // foreign Portfolio, so both the "known elsewhere" export and an unknown id
    // must answer identically under this Owner scope.
    const knownElsewhere = await handleGetOwnerExport(
      readRequest(OWNER_EXPORT_ID),
      { exportId: OWNER_EXPORT_ID },
      shared,
    );
    const unknown = await handleGetOwnerExport(
      readRequest("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7efe"),
      { exportId: unsafeStableId<"OwnerExport">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7efe") },
      shared,
    );
    expect(knownElsewhere.status).toBe(404);
    expect(unknown.status).toBe(404);
    const prepared = await knownElsewhere.text(), unmatched = await unknown.text();
    const foreignProblem = JSON.parse(prepared) as Record<string, unknown>;
    const unknownProblem = JSON.parse(unmatched) as Record<string, unknown>;
    expect(foreignProblem["code"]).toBe(unknownProblem["code"]);
    expect(foreignProblem["status"]).toBe(unknownProblem["status"]);
    expect(foreignProblem["traceId"]).not.toBe(unknownProblem["traceId"]);
    // None of the problem bodies leaks the foreign Owner, Portfolio, or manifest.
    const serialized = prepared + unmatched;
    for (const leak of [FOREIGN_OWNER_ID, FOREIGN_PORTFOLIO_ID, "artifact", "manifest"]) {
      expect(serialized).not.toContain(leak);
    }
  });
});

describe("AC08: declared transport surface on success and failure", () => {
  it("sends every success response with the private no-store headers", async () => {
    const requested = await handleRequestOwnerExport(postRequest(), deps(createOwnerExportTestFake({ type: "success" })));
    const status = await handleGetOwnerExport(readRequest(OWNER_EXPORT_ID), { exportId: OWNER_EXPORT_ID }, deps(createOwnerExportTestFake({ type: "success" })));
    expect(requested.status).toBe(202);
    expect(zRequestOwnerExportResponse.safeParse(await requested.json()).success).toBe(true);
    expect(status.status).toBe(200);
    expect(zGetOwnerExportResponse.safeParse(await status.json()).success).toBe(true);
    for (const response of [requested, status]) {
      expect(response.headers.get("cache-control")).toBe(OWNER_PRIVATE_RESPONSE_HEADERS["Cache-Control"]);
      expect(response.headers.get("x-robots-tag")).toBe(OWNER_PRIVATE_RESPONSE_HEADERS["X-Robots-Tag"]);
    }
    const download = await handleDownloadOwnerExport(
      readRequest(`${OWNER_EXPORT_ID}/download`),
      { exportId: OWNER_EXPORT_ID },
      deps(createOwnerExportTestFake({ type: "success" })),
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe(OWNER_EXPORT_MEDIA_TYPE);
    expect(download.headers.get("cache-control")).toBe(OWNER_PRIVATE_RESPONSE_HEADERS["Cache-Control"]);
    expect(download.headers.get("x-robots-tag")).toBe(OWNER_PRIVATE_RESPONSE_HEADERS["X-Robots-Tag"]);
  });

  it("rejects malformed ids, missing keys, and unknown body properties before dispatch", async () => {
    const fake = createOwnerExportTestFake({ type: "success" });
    for (const exportId of ["not-a-uuid", "../download"] as const) {
      const response = await handleGetOwnerExport(readRequest(exportId), { exportId }, deps(fake));
      expect(response.status).toBe(400);
    }
    expect(fake.calls.getOwnerExport).toHaveLength(0);
    const missingKey = await handleRequestOwnerExport(postRequest({ idempotencyKey: null }), deps(fake));
    const emptyKey = await handleRequestOwnerExport(postRequest({ idempotencyKey: "" }), deps(fake));
    const unknownProperty = await handleRequestOwnerExport(
      postRequest({ body: { includedScopes: ["taxonomy"], extra: "nope" } }),
      deps(fake),
    );
    const unknownScope = await handleRequestOwnerExport(
      postRequest({ body: { includedScopes: ["taxonomy", "not-a-scope"] } }),
      deps(fake),
    );
    const empty = await handleRequestOwnerExport(postRequest({ body: { includedScopes: [] } }), deps(fake));
    for (const response of [missingKey, emptyKey, unknownProperty, unknownScope, empty]) {
      expect(response.status).toBe(400);
      expect(zProblem.safeParse(await response.clone().json()).success).toBe(true);
    }
    // Duplicates pass the transport contract and are canonically rejected at
    // the real application boundary as 422 before any durable effect.
    const duplicateService = serviceForStore(scopedStore([]));
    const duplicate = await handleRequestOwnerExport(
      postRequest({ body: { includedScopes: ["taxonomy", "taxonomy"] } }),
      deps(duplicateService),
    );
    expect(duplicate.status).toBe(422);
    expect(((await duplicate.json()) as Record<string, unknown>)["code"]).toBe("unprocessable");
    expect(fake.calls.requestOwnerExport).toHaveLength(0);
  });

  it("serializes declared rejections as strict Problem Details with Retry-After", async () => {
    for (const [rejection, status, problemCode, retry] of [
      [{ kind: "conflict", code: "IDEMPOTENCY_PAYLOAD_CONFLICT" }, 409, "conflict", false],
      [{ kind: "not_found", code: "OWNER_EXPORT_NOT_FOUND" }, 404, "not_found", false],
      [{ kind: "rate_limited", code: "RATE_LIMIT_EXCEEDED", retryAfterSeconds: 30 }, 429, "rate_limited", true],
      [{ kind: "temporarily_unavailable", code: "OWNER_EXPORT_PERSISTENCE_UNAVAILABLE" }, 503, "temporarily_unavailable", false],
    ] as const) {
      const fake = createOwnerExportTestFake({ type: "rejection", rejection });
      const response = await handleGetOwnerExport(readRequest(OWNER_EXPORT_ID), { exportId: OWNER_EXPORT_ID }, deps(fake));
      expect(response.status).toBe(status);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      expect(response.headers.get("retry-after"), String(status)).toBe(retry ? "30" : null);
    }
  });
});
