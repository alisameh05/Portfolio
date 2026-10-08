/**
 * owner-project.test.ts — Phase 2 #29
 *
 * Seam under test (pre-agreed): the Owner Project HTTP adapter observed
 * through standard Request and Response objects with an injected application
 * fake.
 *
 * Acceptance (issue #29, project slice):
 * - Exactly one handwritten adapter covers Project aggregate retrieval,
 *   public-slug change, status change, Featured change, relationship
 *   creation, and Taxonomy-value assignment; each validates path, headers,
 *   and body with generated strict validators before dispatch.
 * - Each handler constructs one operation-specific command or query and
 *   invokes one injected application interface exactly once.
 * - Deterministic fakes exercise contract-valid successes and every declared
 *   rejection without real identity, authorization, persistence, or domain
 *   behavior; structurally invalid input is 400 before dispatch while typed
 *   business validation is 422 via the shared rejection mapper.
 * - Owner unauthenticated and forbidden are exercised through fakes; no
 *   Supabase session, cookie, or allowlist implementation exists.
 * - Production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED
 *   for all six operations.
 */

import { describe, expect, it } from "vitest";

import {
  zGetOwnerProjectAggregateResponse,
  zProblem,
  zChangeOwnerProjectStatusResponse,
  zSetOwnerProjectFeaturedResponse,
  zChangeOwnerProjectPublicSlugResponse,
  zCorrectOwnerProjectCandidateSlugResponse,
  zRelateOwnerProjectsResponse,
  zAssignOwnerProjectTaxonomyValueResponse,
} from "../../src/contracts/http/owner/v1/generated/zod.gen.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import {
  createOwnerProjectTestFake,
  createProductionOwnerProjectService,
} from "../../src/runtime/fakes/owner-project.js";
import {
  handleAssignOwnerProjectTaxonomyValue,
  handleChangeOwnerProjectPublicSlug,
  handleCorrectOwnerProjectCandidateSlug,
  handleChangeOwnerProjectStatus,
  handleGetOwnerProjectAggregate,
  handleRelateOwnerProjects,
  handleSetOwnerProjectFeatured,
} from "../../src/runtime/http/owner-project.js";
import { ownerTestSecurity, withOwnerTestAuth } from "./owner-test-auth.js";

const PROJECT_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e8f";
const RELATED_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e90";
const VALUE_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e91";
const STATUS_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e92";
const IDEMPOTENCY_KEY = "test-key-123";
const IF_MATCH = '"2"';

function getRequest(projectId: string = PROJECT_ID, inboundTrace?: string): Request {
  const headers: Record<string, string> = withOwnerTestAuth({});
  if (inboundTrace !== undefined) {
    headers["x-request-id"] = inboundTrace;
  }
  return new Request(`https://example.com/api/owner/v1/projects/${projectId}`, {
    method: "GET",
    headers,
  });
}

function postRequest(
  projectId: string,
  suffix: string,
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
  return new Request(
    `https://example.com/api/owner/v1/projects/${projectId}/commands/${suffix}`,
    init,
  );
}

describe("Owner Project aggregate retrieval (#29)", () => {
  it("retrieves the aggregate once and returns the declared view", async () => {
    const fake = createOwnerProjectTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleGetOwnerProjectAggregate(
      getRequest(),
      { projectId: PROJECT_ID },
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.getOwnerProjectAggregate).toHaveLength(1);
    expect(fake.calls.changeOwnerProjectStatus).toHaveLength(0);
    const query = fake.calls.getOwnerProjectAggregate[0] as { projectId: string };
    expect(query.projectId).toBe(PROJECT_ID);
    const body = (await response.json()) as unknown;
    expect(zGetOwnerProjectAggregateResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      projectId: PROJECT_ID,
      aggregateVersion: 1,
      statusValueId: null,
      featured: false,
      publicRoute: null,
      relatedProjectIds: [],
      taxonomyAssignments: [],
    });
  });

  it.each([["invalid projectId", "not-a-uuid"]])(
    "rejects %s as 400 before dispatch",
    async (_label, projectId) => {
      const fake = createOwnerProjectTestFake({ type: "success" });
      const response = await handleGetOwnerProjectAggregate(
        getRequest(projectId),
        { projectId },
        { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
      );
      expect(response.status).toBe(400);
      expect(fake.calls.getOwnerProjectAggregate).toHaveLength(0);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("validation");
    },
  );

  it.each([
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
    ["not_found", { kind: "not_found", code: "PROJECT_NOT_FOUND" }, 404, "not_found"],
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
      const fake = createOwnerProjectTestFake({ type: "rejection", rejection });
      const logger = createTestLogger();
      const response = await handleGetOwnerProjectAggregate(
        getRequest(),
        { projectId: PROJECT_ID },
        { service: fake, security: ownerTestSecurity(), logger },
      );
      expect(response.status).toBe(status);
      expect(fake.calls.getOwnerProjectAggregate).toHaveLength(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it("fails safely when fake output is contract-invalid", async () => {
    const fake = createOwnerProjectTestFake({ type: "invalid-success" });
    const response = await handleGetOwnerProjectAggregate(
      getRequest(),
      { projectId: PROJECT_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(500);
  });

  it("uses a server-generated trace identifier shared by Problem Details and logs", async () => {
    const fake = createOwnerProjectTestFake({
      type: "rejection",
      rejection: { kind: "not_found", code: "PROJECT_NOT_FOUND" },
    });
    const logger = createTestLogger();
    const first = await handleGetOwnerProjectAggregate(
      getRequest(PROJECT_ID, "inbound-attacker-value"),
      { projectId: PROJECT_ID },
      { service: fake, security: ownerTestSecurity(), logger },
    );
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody["traceId"]).not.toBe("inbound-attacker-value");
    const logged = (logger.records[0] as { fields: Record<string, unknown> }).fields;
    expect(logged["traceId"]).toBe(firstBody["traceId"]);
  });
});

describe("Owner Project commands (#29)", () => {
  it("changes status once and returns the declared receipt", async () => {
    const fake = createOwnerProjectTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleChangeOwnerProjectStatus(
      postRequest(PROJECT_ID, "change-status", { body: { statusValueId: STATUS_ID } }),
      { projectId: PROJECT_ID },
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.changeOwnerProjectStatus).toHaveLength(1);
    const command = fake.calls.changeOwnerProjectStatus[0] as {
      projectId: string;
      statusValueId: string;
      expectedVersion: number;
      idempotencyKey: string;
    };
    expect(command.projectId).toBe(PROJECT_ID);
    expect(command.statusValueId).toBe(STATUS_ID);
    expect(command.expectedVersion).toBe(2);
    expect(command.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    const body = (await response.json()) as unknown;
    expect(zChangeOwnerProjectStatusResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: PROJECT_ID,
      aggregateVersion: 3,
      outcome: "project-status-changed",
    });
  });

  it("sets Featured state once and returns the declared receipt", async () => {
    const fake = createOwnerProjectTestFake({ type: "success" });
    const response = await handleSetOwnerProjectFeatured(
      postRequest(PROJECT_ID, "set-featured", { body: { featured: true } }),
      { projectId: PROJECT_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.setOwnerProjectFeatured).toHaveLength(1);
    const body = (await response.json()) as unknown;
    expect(zSetOwnerProjectFeaturedResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: PROJECT_ID,
      aggregateVersion: 3,
      outcome: "project-featured-changed",
    });
  });

  it("changes the public slug once and returns the declared receipt", async () => {
    const fake = createOwnerProjectTestFake({ type: "success" });
    const response = await handleChangeOwnerProjectPublicSlug(
      postRequest(PROJECT_ID, "change-slug", { body: { slug: "evidence-led-portfolio" } }),
      { projectId: PROJECT_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.changeOwnerProjectPublicSlug).toHaveLength(1);
    const body = (await response.json()) as unknown;
    expect(zChangeOwnerProjectPublicSlugResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: PROJECT_ID,
      aggregateVersion: 3,
      outcome: "public-slug-changed",
    });
  });

  it("corrects a private candidate slug once through the authenticated Owner boundary", async () => {
    const fake = createOwnerProjectTestFake({ type: "success" });
    const response = await handleCorrectOwnerProjectCandidateSlug(
      postRequest(PROJECT_ID, "correct-candidate-slug", { body: { candidateSlug: "corrected-project" } }),
      { projectId: PROJECT_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.correctOwnerProjectCandidateSlug).toHaveLength(1);
    expect(fake.calls.correctOwnerProjectCandidateSlug[0]).toMatchObject({ projectId: PROJECT_ID, candidateSlug: "corrected-project", expectedVersion: 2 });
    expect(zCorrectOwnerProjectCandidateSlugResponse.safeParse(await response.json()).success).toBe(true);
  });

  it("relates Projects once and returns the declared receipt", async () => {
    const fake = createOwnerProjectTestFake({ type: "success" });
    const response = await handleRelateOwnerProjects(
      postRequest(PROJECT_ID, "relate-project", { body: { relatedProjectId: RELATED_ID } }),
      { projectId: PROJECT_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.relateOwnerProjects).toHaveLength(1);
    const body = (await response.json()) as unknown;
    expect(zRelateOwnerProjectsResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: PROJECT_ID,
      aggregateVersion: 3,
      outcome: "project-related",
    });
  });

  it("assigns a Taxonomy value once and returns the declared receipt", async () => {
    const fake = createOwnerProjectTestFake({ type: "success" });
    const response = await handleAssignOwnerProjectTaxonomyValue(
      postRequest(PROJECT_ID, "assign-taxonomy-value", { body: { valueId: VALUE_ID } }),
      { projectId: PROJECT_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.assignOwnerProjectTaxonomyValue).toHaveLength(1);
    const body = (await response.json()) as unknown;
    expect(zAssignOwnerProjectTaxonomyValueResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: PROJECT_ID,
      aggregateVersion: 3,
      outcome: "taxonomy-value-assigned",
    });
  });

  it.each([
    ["malformed JSON", "change-status", { rawBody: "{not-json" }, undefined],
    ["missing Idempotency-Key", "change-status", { idempotencyKey: null, body: { statusValueId: STATUS_ID } }, undefined],
    ["missing If-Match", "set-featured", { ifMatch: null, body: { featured: true } }, undefined],
    ["invalid If-Match", "change-slug", { ifMatch: '"0"', body: { slug: "valid-slug" } }, undefined],
    ["invalid projectId", "relate-project", { body: { relatedProjectId: RELATED_ID } }, "not-a-uuid"],
    ["absent body", "change-status", { body: {} }, undefined],
    ["invalid slug", "change-slug", { body: { slug: "Invalid_Slug!" } }, undefined],
    ["unknown closed-shape property", "set-featured", { body: { featured: true, extra: "nope" } }, undefined],
    ["out-of-shape body", "assign-taxonomy-value", { body: [] }, undefined],
  ] as Array<[string, string, Record<string, unknown>, string | undefined]>)(
    "rejects command %s %s as 400 before dispatch",
    async (_kind, suffix, options, projectId) => {
      const fake = createOwnerProjectTestFake({ type: "success" });
      const handlers: Record<string, typeof handleChangeOwnerProjectStatus> = {
        "change-status": handleChangeOwnerProjectStatus,
        "set-featured": handleSetOwnerProjectFeatured as never,
        "change-slug": handleChangeOwnerProjectPublicSlug as never,
        "correct-candidate-slug": handleCorrectOwnerProjectCandidateSlug as never,
        "relate-project": handleRelateOwnerProjects as never,
        "assign-taxonomy-value": handleAssignOwnerProjectTaxonomyValue as never,
      };
      const handler = handlers[suffix] as (
        request: Request,
        params: { projectId: string },
        deps: Parameters<typeof handleChangeOwnerProjectStatus>[2],
      ) => Promise<Response>;
      const resolvedProjectId = (projectId as string | undefined) ?? PROJECT_ID;
      const response = await handler(
        postRequest(resolvedProjectId, suffix, options),
        { projectId: resolvedProjectId },
        { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
      );
      expect(response.status).toBe(400);
      const totalCalls =
        fake.calls.changeOwnerProjectStatus.length +
        fake.calls.setOwnerProjectFeatured.length +
        fake.calls.changeOwnerProjectPublicSlug.length +
        fake.calls.relateOwnerProjects.length +
        fake.calls.assignOwnerProjectTaxonomyValue.length;
      expect(totalCalls).toBe(0);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("validation");
    },
  );

  it.each([
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
    ["not_found", { kind: "not_found", code: "PROJECT_NOT_FOUND" }, 404, "not_found"],
    ["conflict", { kind: "conflict", code: "IDEMPOTENCY_CONFLICT" }, 409, "conflict"],
    ["precondition_failed", { kind: "precondition_failed", code: "VERSION_MISMATCH" }, 412, "failed_precondition"],
    ["validation", { kind: "validation", code: "STATUS_REJECTED" }, 422, "unprocessable"],
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
      const fake = createOwnerProjectTestFake({ type: "rejection", rejection });
      const response = await handleChangeOwnerProjectStatus(
        postRequest(PROJECT_ID, "change-status", { body: { statusValueId: STATUS_ID } }),
        { projectId: PROJECT_ID },
        { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
      );
      expect(response.status).toBe(status);
      expect(fake.calls.changeOwnerProjectStatus).toHaveLength(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it("translates slug forbidden and assign validation without provider auth", async () => {
    const forbidden = createOwnerProjectTestFake({
      type: "rejection",
      rejection: { kind: "forbidden", code: "OWNER_FORBIDDEN" },
    });
    const slug = await handleChangeOwnerProjectPublicSlug(
      postRequest(PROJECT_ID, "change-slug", { body: { slug: "evidence-led-portfolio" } }),
      { projectId: PROJECT_ID },
      { service: forbidden, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(slug.status).toBe(403);

    const invalid = createOwnerProjectTestFake({
      type: "rejection",
      rejection: { kind: "validation", code: "TAXONOMY_REJECTED" },
    });
    const assign = await handleAssignOwnerProjectTaxonomyValue(
      postRequest(PROJECT_ID, "assign-taxonomy-value", { body: { valueId: VALUE_ID } }),
      { projectId: PROJECT_ID },
      { service: invalid, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(assign.status).toBe(422);
  });

  it("fails safely when command fake output is contract-invalid", async () => {
    const fake = createOwnerProjectTestFake({ type: "invalid-success" });
    const response = await handleChangeOwnerProjectStatus(
      postRequest(PROJECT_ID, "change-status", { body: { statusValueId: STATUS_ID } }),
      { projectId: PROJECT_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(500);
  });

  it("production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED for all six operations", async () => {
    const service = createProductionOwnerProjectService();
    const logger = createTestLogger();
    const responses = [
      await handleGetOwnerProjectAggregate(getRequest(), { projectId: PROJECT_ID }, { service, security: ownerTestSecurity(), logger }),
      await handleChangeOwnerProjectStatus(
        postRequest(PROJECT_ID, "change-status", { body: { statusValueId: STATUS_ID } }),
        { projectId: PROJECT_ID },
        { service, security: ownerTestSecurity(), logger },
      ),
      await handleSetOwnerProjectFeatured(
        postRequest(PROJECT_ID, "set-featured", { body: { featured: true } }),
        { projectId: PROJECT_ID },
        { service, security: ownerTestSecurity(), logger },
      ),
      await handleChangeOwnerProjectPublicSlug(
        postRequest(PROJECT_ID, "change-slug", { body: { slug: "evidence-led-portfolio" } }),
        { projectId: PROJECT_ID },
        { service, security: ownerTestSecurity(), logger },
      ),
      await handleRelateOwnerProjects(
        postRequest(PROJECT_ID, "relate-project", { body: { relatedProjectId: RELATED_ID } }),
        { projectId: PROJECT_ID },
        { service, security: ownerTestSecurity(), logger },
      ),
      await handleAssignOwnerProjectTaxonomyValue(
        postRequest(PROJECT_ID, "assign-taxonomy-value", { body: { valueId: VALUE_ID } }),
        { projectId: PROJECT_ID },
        { service, security: ownerTestSecurity(), logger },
      ),
    ];
    expect(responses).toHaveLength(6);
    for (const response of responses) {
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe("temporarily_unavailable");
    }
    const owner = { kind: "owner", ownerId: PROJECT_ID, sessionId: "s" } as const;
    const directCalls = [
      service.getOwnerProjectAggregate({ actor: owner as never, projectId: PROJECT_ID as never }),
      service.changeOwnerProjectStatus({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        projectId: PROJECT_ID as never,
        statusValueId: STATUS_ID as never,
        correlationId: "test-status",
      }),
      service.setOwnerProjectFeatured({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        projectId: PROJECT_ID as never,
        featured: true,
        correlationId: "test-featured",
      }),
      service.changeOwnerProjectPublicSlug({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        projectId: PROJECT_ID as never,
        slug: "evidence-led-portfolio",
        correlationId: "test-correlation",
      }),
      service.relateOwnerProjects({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        projectId: PROJECT_ID as never,
        relatedProjectId: RELATED_ID as never,
      }),
      service.assignOwnerProjectTaxonomyValue({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        projectId: PROJECT_ID as never,
        valueId: VALUE_ID as never,
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
      async getOwnerProjectAggregate(): Promise<never> {
        throw new Error("boom postgres://user:pass@host/db token=tok_123 /app/secret.ts");
      },
      async changeOwnerProjectStatus(): Promise<never> {
        throw new Error("unreachable");
      },
      async setOwnerProjectFeatured(): Promise<never> {
        throw new Error("unreachable");
      },
      async changeOwnerProjectPublicSlug(): Promise<never> {
        throw new Error("unreachable");
      },
      async correctOwnerProjectCandidateSlug(): Promise<never> { throw new Error("unreachable"); },
      async relateOwnerProjects(): Promise<never> {
        throw new Error("unreachable");
      },
      async assignOwnerProjectTaxonomyValue(): Promise<never> {
        throw new Error("unreachable");
      },
    };
    const response = await handleGetOwnerProjectAggregate(
      getRequest(),
      { projectId: PROJECT_ID },
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
