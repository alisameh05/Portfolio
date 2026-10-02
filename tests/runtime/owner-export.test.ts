/**
 * owner-export.test.ts — Phase 2 #32
 *
 * Seam under test (pre-agreed): the Owner export HTTP adapter observed
 * through standard Request and Response objects with an injected
 * application fake.
 *
 * Acceptance (issue #32, export slice):
 * - Exactly one handwritten adapter covers Owner export request, status
 *   retrieval, and download; each validates every declared path, query,
 *   header, and body input before dispatch (including the Idempotency-Key
 *   header where required).
 * - Each handler constructs one operation-specific command or query and
 *   invokes one injected application interface exactly once.
 * - Deterministic fakes exercise contract-valid successes and every declared
 *   rejection without implementing export generation, storage, identity, or
 *   authorization behavior.
 * - Export download fakes exercise only declared response shapes and do not
 *   access storage or expose signed URLs in captured logs and failures.
 * - Production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED
 *   for all three operations.
 */

import { describe, expect, it } from "vitest";

import {
  zGetOwnerExportResponse,
  zProblem,
  zRequestOwnerExportResponse,
} from "../../src/contracts/http/owner/v1/generated/zod.gen.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import {
  createOwnerExportTestFake,
  createProductionOwnerExportService,
  OWNER_EXPORT_FILENAME,
  OWNER_EXPORT_ID,
  OWNER_EXPORT_SCHEMA_VERSION,
} from "../../src/runtime/fakes/owner-export.js";
import {
  handleDownloadOwnerExport,
  handleGetOwnerExport,
  handleRequestOwnerExport,
  OWNER_EXPORT_MEDIA_TYPE,
} from "../../src/runtime/http/owner-export.js";
import { ownerTestSecurity, withOwnerTestAuth } from "./owner-test-auth.js";

const EXPORT_ID = OWNER_EXPORT_ID;
const IDEMPOTENCY_KEY = "test-key-123";

function requestExportRequest(
  options?: {
    idempotencyKey?: string | null;
    body?: unknown;
    rawBody?: string;
  },
  inboundTrace?: string,
): Request {
  const headers: Record<string, string> = withOwnerTestAuth({ "content-type": "application/json" });
  if (options?.idempotencyKey !== null) {
    headers["Idempotency-Key"] = options?.idempotencyKey ?? IDEMPOTENCY_KEY;
  }
  if (inboundTrace !== undefined) {
    headers["x-request-id"] = inboundTrace;
  }
  const init: RequestInit = { method: "POST", headers };
  if (options?.rawBody !== undefined) {
    init.body = options.rawBody;
  } else {
    init.body = JSON.stringify(options?.body ?? {});
  }
  return new Request("https://example.com/api/owner/v1/exports", init);
}

function getRequest(exportId: string = EXPORT_ID, inboundTrace?: string): Request {
  const headers: Record<string, string> = withOwnerTestAuth({});
  if (inboundTrace !== undefined) {
    headers["x-request-id"] = inboundTrace;
  }
  return new Request(`https://example.com/api/owner/v1/exports/${exportId}`, {
    method: "GET",
    headers,
  });
}

function downloadRequest(exportId: string = EXPORT_ID, inboundTrace?: string): Request {
  const headers: Record<string, string> = withOwnerTestAuth({});
  if (inboundTrace !== undefined) {
    headers["x-request-id"] = inboundTrace;
  }
  return new Request(`https://example.com/api/owner/v1/exports/${exportId}/download`, {
    method: "GET",
    headers,
  });
}

const requestBody = { includedScopes: ["portfolio-content", "taxonomy"] };

describe("Owner export request (#32)", () => {
  it("requests an export once and returns the declared 202 receipt", async () => {
    const fake = createOwnerExportTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleRequestOwnerExport(
      requestExportRequest({ body: requestBody }),
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(202);
    expect(fake.calls.requestOwnerExport).toHaveLength(1);
    expect(fake.calls.getOwnerExport).toHaveLength(0);
    const command = fake.calls.requestOwnerExport[0] as unknown as {
      includedScopes: string[];
      idempotencyKey: string;
    };
    expect(command.includedScopes).toEqual(["portfolio-content", "taxonomy"]);
    expect(command.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    const body = (await response.json()) as unknown;
    expect(zRequestOwnerExportResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      exportId: EXPORT_ID,
      outcome: "owner-export-requested",
      state: "requested",
    });
  });

  it.each([
    ["missing Idempotency-Key", { idempotencyKey: null, body: requestBody }],
    ["malformed JSON", { rawBody: "{not-json" }],
    ["missing includedScopes", { body: {} }],
    ["empty includedScopes", { body: { includedScopes: [] } }],
    ["unknown scope", { body: { includedScopes: ["nope"] } }],
    ["unknown property", { body: { includedScopes: ["taxonomy"], extra: "nope" } }],
  ])("rejects %s as 400 before dispatch", async (_label, options) => {
    const fake = createOwnerExportTestFake({ type: "success" });
    const response = await handleRequestOwnerExport(
      requestExportRequest(options as { body?: unknown; rawBody?: string }),
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(400);
    expect(fake.calls.requestOwnerExport).toHaveLength(0);
  });

  it.each([
    ["validation", { kind: "validation", code: "EXPORT_REJECTED" }, 422, "unprocessable"],
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
    ["conflict", { kind: "conflict", code: "EXPORT_CONFLICT" }, 409, "conflict"],
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
      const fake = createOwnerExportTestFake({ type: "rejection", rejection });
      const response = await handleRequestOwnerExport(
        requestExportRequest({ body: requestBody }),
        { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
      );
      expect(response.status).toBe(status);
      expect(fake.calls.requestOwnerExport).toHaveLength(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it("fails safely when fake output is contract-invalid", async () => {
    const fake = createOwnerExportTestFake({ type: "invalid-success" });
    const response = await handleRequestOwnerExport(
      requestExportRequest({ body: requestBody }),
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(500);
  });
});

describe("Owner export status retrieval (#32)", () => {
  it("retrieves the export once and returns the declared view", async () => {
    const fake = createOwnerExportTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleGetOwnerExport(
      getRequest(),
      { exportId: EXPORT_ID },
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.getOwnerExport).toHaveLength(1);
    const query = fake.calls.getOwnerExport[0] as { exportId: string };
    expect(query.exportId).toBe(EXPORT_ID);
    const body = (await response.json()) as unknown;
    expect(zGetOwnerExportResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      exportId: EXPORT_ID,
      state: "requested",
      schemaVersion: OWNER_EXPORT_SCHEMA_VERSION,
      requestedAt: "2026-09-22T00:00:00.000Z",
      includedScopes: ["portfolio-content", "taxonomy"],
      publicEventDataCoverage: { mode: "excluded" },
      downloadAvailable: false,
    });
  });

  it("rejects an invalid exportId as 400 before dispatch", async () => {
    const fake = createOwnerExportTestFake({ type: "success" });
    const response = await handleGetOwnerExport(
      getRequest("not-a-uuid"),
      { exportId: "not-a-uuid" },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(400);
    expect(fake.calls.getOwnerExport).toHaveLength(0);
  });

  it.each([
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
    ["not_found", { kind: "not_found", code: "EXPORT_NOT_FOUND" }, 404, "not_found"],
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
      const fake = createOwnerExportTestFake({ type: "rejection", rejection });
      const response = await handleGetOwnerExport(
        getRequest(),
        { exportId: EXPORT_ID },
        { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
      );
      expect(response.status).toBe(status);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it("fails safely when fake output is contract-invalid", async () => {
    const fake = createOwnerExportTestFake({ type: "invalid-success" });
    const response = await handleGetOwnerExport(
      getRequest(),
      { exportId: EXPORT_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(500);
  });

  it("uses a server-generated trace identifier shared by Problem Details and logs", async () => {
    const fake = createOwnerExportTestFake({
      type: "rejection",
      rejection: { kind: "not_found", code: "EXPORT_NOT_FOUND" },
    });
    const logger = createTestLogger();
    const first = await handleGetOwnerExport(
      getRequest(EXPORT_ID, "inbound-attacker-value"),
      { exportId: EXPORT_ID },
      { service: fake, security: ownerTestSecurity(), logger },
    );
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody["traceId"]).not.toBe("inbound-attacker-value");
    const logged = (logger.records[0] as { fields: Record<string, unknown> }).fields;
    expect(logged["traceId"]).toBe(firstBody["traceId"]);
  });
});

describe("Owner export download (#32)", () => {
  it("downloads the package once with the declared media type and headers", async () => {
    const fake = createOwnerExportTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleDownloadOwnerExport(
      downloadRequest(),
      { exportId: EXPORT_ID },
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.downloadOwnerExport).toHaveLength(1);
    const query = fake.calls.downloadOwnerExport[0] as { exportId: string };
    expect(query.exportId).toBe(EXPORT_ID);
    expect(response.headers.get("content-type")).toBe(OWNER_EXPORT_MEDIA_TYPE);
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${OWNER_EXPORT_FILENAME}"`,
    );
    expect(response.headers.get("x-shipwithali-export-schema-version")).toBe(
      OWNER_EXPORT_SCHEMA_VERSION,
    );
    const payload = new Uint8Array(await response.arrayBuffer());
    expect(payload.byteLength).toBeGreaterThan(0);
    const text = new TextDecoder().decode(payload);
    expect(text).toContain(EXPORT_ID);
    expect(text).not.toContain("signed");
    expect(text).not.toContain("token");
  });

  it("rejects an invalid exportId as 400 before dispatch", async () => {
    const fake = createOwnerExportTestFake({ type: "success" });
    const response = await handleDownloadOwnerExport(
      downloadRequest("not-a-uuid"),
      { exportId: "not-a-uuid" },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(400);
    expect(fake.calls.downloadOwnerExport).toHaveLength(0);
  });

  it.each([
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
    ["not_found", { kind: "not_found", code: "EXPORT_NOT_FOUND" }, 404, "not_found"],
    ["conflict", { kind: "conflict", code: "EXPORT_NOT_READY" }, 409, "conflict"],
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
      const fake = createOwnerExportTestFake({ type: "rejection", rejection });
      const response = await handleDownloadOwnerExport(
        downloadRequest(),
        { exportId: EXPORT_ID },
        { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
      );
      expect(response.status).toBe(status);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it("fails safely when the download fake output is contract-invalid", async () => {
    const fake = createOwnerExportTestFake({ type: "invalid-success" });
    const logger = createTestLogger();
    const response = await handleDownloadOwnerExport(
      downloadRequest(),
      { exportId: EXPORT_ID },
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(zProblem.safeParse(body).success).toBe(true);
    expect(JSON.stringify(body)).not.toContain("signed");
    expect(JSON.stringify(body)).not.toContain("tok_123");
  });

  it("keeps unauthenticated and forbidden distinct and never exposes signed URLs", async () => {
    const unauthenticated = createOwnerExportTestFake({
      type: "rejection",
      rejection: { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" },
    });
    const denied = await handleDownloadOwnerExport(
      downloadRequest(),
      { exportId: EXPORT_ID },
      { service: unauthenticated, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(denied.status).toBe(401);

    const forbidden = createOwnerExportTestFake({
      type: "rejection",
      rejection: { kind: "forbidden", code: "OWNER_FORBIDDEN" },
    });
    const logger = createTestLogger();
    const blocked = await handleDownloadOwnerExport(
      downloadRequest(),
      { exportId: EXPORT_ID },
      { service: forbidden, security: ownerTestSecurity(), logger },
    );
    expect(blocked.status).toBe(403);
    expect(JSON.stringify(logger.records)).not.toContain("signed");
  });

  it("production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED for all three operations", async () => {
    const service = createProductionOwnerExportService();
    const logger = createTestLogger();
    const responses = [
      await handleRequestOwnerExport(
        requestExportRequest({ body: requestBody }),
        { service, security: ownerTestSecurity(), logger },
      ),
      await handleGetOwnerExport(getRequest(), { exportId: EXPORT_ID }, { service, security: ownerTestSecurity(), logger }),
      await handleDownloadOwnerExport(
        downloadRequest(),
        { exportId: EXPORT_ID },
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
    const owner = { kind: "owner", ownerId: EXPORT_ID, sessionId: "s" } as const;
    const directCalls = [
      service.requestOwnerExport({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        includedScopes: ["taxonomy"] as never,
      }),
      service.getOwnerExport({ actor: owner as never, exportId: EXPORT_ID as never }),
      service.downloadOwnerExport({ actor: owner as never, exportId: EXPORT_ID as never }),
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
      async requestOwnerExport(): Promise<never> {
        throw new Error("boom postgres://user:pass@host/db token=tok_123 /app/secret.ts");
      },
      async getOwnerExport(): Promise<never> {
        throw new Error("unreachable");
      },
      async downloadOwnerExport(): Promise<never> {
        throw new Error("unreachable");
      },
    };
    const response = await handleRequestOwnerExport(
      requestExportRequest({ body: requestBody }),
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
