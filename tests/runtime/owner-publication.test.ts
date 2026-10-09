/**
 * owner-publication.test.ts — Phase 2 #30
 *
 * Seam under test (pre-agreed): the Owner Publication HTTP adapter observed
 * through standard Request and Response objects with an injected application
 * fake.
 *
 * Acceptance (issue #30, publication slice):
 * - Exactly one handwritten adapter covers content aggregate retrieval,
 *   Revision saving, Language-version publication, hide, archive, and
 *   restore; each validates path, headers, and body with generated strict
 *   validators before dispatch.
 * - Each handler constructs one operation-specific command or query and
 *   invokes one injected application interface exactly once.
 * - Deterministic fakes exercise contract-valid successes and every declared
 *   rejection without implementing publication, lifecycle, evidence, route,
 *   Taxonomy, persistence, or authorization rules.
 * - Production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED
 *   for all six operations.
 */

import { describe, expect, it } from "vitest";

import {
  zArchiveOwnerContentResponse,
  zGetOwnerContentAggregateResponse,
  zHideOwnerContentResponse,
  zProblem,
  zPublishOwnerContentLanguageResponse,
  zRestoreOwnerContentResponse,
  zSaveOwnerContentRevisionResponse,
} from "../../src/contracts/http/owner/v1/generated/zod.gen.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import {
  createOwnerPublicationTestFake,
  createProductionOwnerPublicationService,
} from "../../src/runtime/fakes/owner-publication.js";
import {
  handleArchiveOwnerContent,
  handleGetOwnerContentAggregate,
  handleHideOwnerContent,
  handlePublishOwnerContentLanguage,
  handleRestoreOwnerContent,
  handleSaveOwnerContentRevision,
} from "../../src/runtime/http/owner-publication.js";
import { ownerTestSecurity, withOwnerTestAuth } from "./owner-test-auth.js";

const CONTENT_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea1";
const REVISION_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea5";
const IDEMPOTENCY_KEY = "test-key-123";
const IF_MATCH = '"2"';

const REVISION_BODY = {
  locale: "en",
  title: "Evidence-led portfolio",
  summary: "A contract-first portfolio case study.",
  body: "The work and its supporting evidence are described here.",
};

const PUBLISH_BODY = { locale: "en", revisionId: REVISION_ID };

function getRequest(contentId: string = CONTENT_ID, inboundTrace?: string): Request {
  const headers: Record<string, string> = withOwnerTestAuth({});
  if (inboundTrace !== undefined) {
    headers["x-request-id"] = inboundTrace;
  }
  return new Request(`https://example.com/api/owner/v1/content/${contentId}`, {
    method: "GET",
    headers,
  });
}

function postRequest(
  contentId: string,
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
  return new Request(`https://example.com/api/owner/v1/content/${contentId}/${suffix}`, init);
}

describe("Owner Publication aggregate retrieval (#30)", () => {
  it("retrieves the aggregate once and returns the declared view", async () => {
    const fake = createOwnerPublicationTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleGetOwnerContentAggregate(
      getRequest(),
      { contentId: CONTENT_ID },
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(fake.calls.getOwnerContentAggregate).toHaveLength(1);
    expect(fake.calls.saveOwnerContentRevision).toHaveLength(0);
    const query = fake.calls.getOwnerContentAggregate[0] as { contentId: string };
    expect(query.contentId).toBe(CONTENT_ID);
    const body = (await response.json()) as unknown;
    expect(zGetOwnerContentAggregateResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      contentId: CONTENT_ID,
      aggregateVersion: 1,
      contentType: "project",
      lifecycle: "draft",
      publicRoute: null,
      routeHistory: [],
      localizedStreams: {
        en: { revisionCount: 1, currentPublishedRevisionId: null },
      },
      revisions: [
        { revisionId: REVISION_ID, locale: "en", sequence: 1, reviewed: false },
      ],
      publicationHistory: [],
    });
  });

  it.each([["invalid contentId", "not-a-uuid"]])(
    "rejects %s as 400 before dispatch",
    async (_label, contentId) => {
      const fake = createOwnerPublicationTestFake({ type: "success" });
      const response = await handleGetOwnerContentAggregate(
        getRequest(contentId),
        { contentId },
        { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
      );
      expect(response.status).toBe(400);
      expect(fake.calls.getOwnerContentAggregate).toHaveLength(0);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("validation");
    },
  );

  it.each([
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
    ["not_found", { kind: "not_found", code: "CONTENT_NOT_FOUND" }, 404, "not_found"],
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
      const fake = createOwnerPublicationTestFake({ type: "rejection", rejection });
      const logger = createTestLogger();
      const response = await handleGetOwnerContentAggregate(
        getRequest(),
        { contentId: CONTENT_ID },
        { service: fake, security: ownerTestSecurity(), logger },
      );
      expect(response.status).toBe(status);
      expect(fake.calls.getOwnerContentAggregate).toHaveLength(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it("fails safely when fake output is contract-invalid", async () => {
    const fake = createOwnerPublicationTestFake({ type: "invalid-success" });
    const response = await handleGetOwnerContentAggregate(
      getRequest(),
      { contentId: CONTENT_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(500);
  });

  it("uses a server-generated trace identifier shared by Problem Details and logs", async () => {
    const fake = createOwnerPublicationTestFake({
      type: "rejection",
      rejection: { kind: "not_found", code: "CONTENT_NOT_FOUND" },
    });
    const logger = createTestLogger();
    const first = await handleGetOwnerContentAggregate(
      getRequest(CONTENT_ID, "inbound-attacker-value"),
      { contentId: CONTENT_ID },
      { service: fake, security: ownerTestSecurity(), logger },
    );
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody["traceId"]).not.toBe("inbound-attacker-value");
    const logged = (logger.records[0] as { fields: Record<string, unknown> }).fields;
    expect(logged["traceId"]).toBe(firstBody["traceId"]);
  });
});

describe("Owner Publication commands (#30)", () => {
  it("saves a Revision once and returns the declared 201 receipt", async () => {
    const fake = createOwnerPublicationTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleSaveOwnerContentRevision(
      postRequest(CONTENT_ID, "revisions", { body: REVISION_BODY }),
      { contentId: CONTENT_ID },
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(201);
    expect(fake.calls.saveOwnerContentRevision).toHaveLength(1);
    const command = fake.calls.saveOwnerContentRevision[0] as {
      contentId: string;
      locale: string;
      title: string;
      expectedVersion: number;
      idempotencyKey: string;
    };
    expect(command.contentId).toBe(CONTENT_ID);
    expect(command.locale).toBe("en");
    expect(command.title).toBe(REVISION_BODY.title);
    expect(command.expectedVersion).toBe(2);
    expect(command.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    const body = (await response.json()) as unknown;
    expect(zSaveOwnerContentRevisionResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: CONTENT_ID,
      aggregateVersion: 3,
      outcome: "revision-saved",
      revisionId: REVISION_ID,
    });
  });

  it("publishes a Language version once and returns the declared receipt", async () => {
    const fake = createOwnerPublicationTestFake({ type: "success" });
    const response = await handlePublishOwnerContentLanguage(
      postRequest(CONTENT_ID, "commands/publish-language", { body: PUBLISH_BODY }),
      { contentId: CONTENT_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.publishOwnerContentLanguage).toHaveLength(1);
    const body = (await response.json()) as unknown;
    expect(zPublishOwnerContentLanguageResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: CONTENT_ID,
      aggregateVersion: 3,
      outcome: "language-published",
    });
  });

  it("hides content once and returns the declared receipt", async () => {
    const fake = createOwnerPublicationTestFake({ type: "success" });
    const response = await handleHideOwnerContent(
      postRequest(CONTENT_ID, "commands/hide", { body: { reason: "Outdated draft" } }),
      { contentId: CONTENT_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.hideOwnerContent).toHaveLength(1);
    const body = (await response.json()) as unknown;
    expect(zHideOwnerContentResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: CONTENT_ID,
      aggregateVersion: 3,
      outcome: "content-hidden",
    });
  });

  it("archives content once and returns the declared receipt", async () => {
    const fake = createOwnerPublicationTestFake({ type: "success" });
    const response = await handleArchiveOwnerContent(
      postRequest(CONTENT_ID, "commands/archive", { body: {} }),
      { contentId: CONTENT_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.archiveOwnerContent).toHaveLength(1);
    const body = (await response.json()) as unknown;
    expect(zArchiveOwnerContentResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: CONTENT_ID,
      aggregateVersion: 3,
      outcome: "content-archived",
    });
  });

  it("restores content once and returns the declared receipt", async () => {
    const fake = createOwnerPublicationTestFake({ type: "success" });
    const response = await handleRestoreOwnerContent(
      postRequest(CONTENT_ID, "commands/restore", { body: {} }),
      { contentId: CONTENT_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.restoreOwnerContent).toHaveLength(1);
    const body = (await response.json()) as unknown;
    expect(zRestoreOwnerContentResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: CONTENT_ID,
      aggregateVersion: 3,
      outcome: "content-restored",
    });
  });

  it.each([
    ["malformed JSON", "revisions", { rawBody: "{not-json" }, undefined],
    ["missing Idempotency-Key", "revisions", { idempotencyKey: null, body: REVISION_BODY }, undefined],
    ["missing If-Match", "commands/publish-language", { ifMatch: null, body: PUBLISH_BODY }, undefined],
    ["invalid If-Match", "commands/hide", { ifMatch: '"0"', body: {} }, undefined],
    ["invalid contentId", "commands/archive", { body: {} }, "not-a-uuid"],
    ["absent body fields", "revisions", { body: {} }, undefined],
    ["invalid locale enum", "revisions", { body: { ...REVISION_BODY, locale: "xx" } }, undefined],
    ["out-of-range title", "revisions", { body: { ...REVISION_BODY, title: "" } }, undefined],
    ["unknown closed-shape property", "commands/publish-language", { body: { ...PUBLISH_BODY, extra: "nope" } }, undefined],
    ["out-of-shape body", "commands/restore", { body: [] }, undefined],
  ] as Array<[string, string, Record<string, unknown>, string | undefined]>)(
    "rejects command %s %s as 400 before dispatch",
    async (_kind, suffix, options, contentId) => {
      const fake = createOwnerPublicationTestFake({ type: "success" });
      const handlers: Record<string, typeof handleSaveOwnerContentRevision> = {
        revisions: handleSaveOwnerContentRevision,
        "commands/publish-language": handlePublishOwnerContentLanguage as never,
        "commands/hide": handleHideOwnerContent as never,
        "commands/archive": handleArchiveOwnerContent as never,
        "commands/restore": handleRestoreOwnerContent as never,
      };
      const handler = handlers[suffix] as (
        request: Request,
        params: { contentId: string },
        deps: {
          service: ReturnType<typeof createOwnerPublicationTestFake>;
          security: ReturnType<typeof ownerTestSecurity>;
          logger?: ReturnType<typeof createTestLogger>;
        },
      ) => Promise<Response>;
      const resolvedContentId = (contentId as string | undefined) ?? CONTENT_ID;
      const response = await handler(
        postRequest(resolvedContentId, suffix, options),
        { contentId: resolvedContentId },
        { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
      );
      expect(response.status).toBe(400);
      const totalCalls =
        fake.calls.saveOwnerContentRevision.length +
        fake.calls.publishOwnerContentLanguage.length +
        fake.calls.hideOwnerContent.length +
        fake.calls.archiveOwnerContent.length +
        fake.calls.restoreOwnerContent.length;
      expect(totalCalls).toBe(0);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body["code"]).toBe("validation");
    },
  );

  it.each([
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
    ["not_found", { kind: "not_found", code: "CONTENT_NOT_FOUND" }, 404, "not_found"],
    ["conflict", { kind: "conflict", code: "IDEMPOTENCY_CONFLICT" }, 409, "conflict"],
    ["precondition_failed", { kind: "precondition_failed", code: "VERSION_MISMATCH" }, 412, "failed_precondition"],
    ["validation", { kind: "validation", code: "REVISION_REJECTED" }, 422, "unprocessable"],
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
      const fake = createOwnerPublicationTestFake({ type: "rejection", rejection });
      const response = await handleSaveOwnerContentRevision(
        postRequest(CONTENT_ID, "revisions", { body: REVISION_BODY }),
        { contentId: CONTENT_ID },
        { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
      );
      expect(response.status).toBe(status);
      expect(fake.calls.saveOwnerContentRevision).toHaveLength(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it("translates publish forbidden and hide validation without provider auth", async () => {
    const forbidden = createOwnerPublicationTestFake({
      type: "rejection",
      rejection: { kind: "forbidden", code: "OWNER_FORBIDDEN" },
    });
    const publish = await handlePublishOwnerContentLanguage(
      postRequest(CONTENT_ID, "commands/publish-language", { body: PUBLISH_BODY }),
      { contentId: CONTENT_ID },
      { service: forbidden, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(publish.status).toBe(403);

    const invalid = createOwnerPublicationTestFake({
      type: "rejection",
      rejection: { kind: "validation", code: "PUBLISH_REJECTED" },
    });
    const hide = await handleHideOwnerContent(
      postRequest(CONTENT_ID, "commands/hide", { body: {} }),
      { contentId: CONTENT_ID },
      { service: invalid, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(hide.status).toBe(422);
  });

  it("fails safely when command fake output is contract-invalid", async () => {
    const fake = createOwnerPublicationTestFake({ type: "invalid-success" });
    const response = await handleSaveOwnerContentRevision(
      postRequest(CONTENT_ID, "revisions", { body: REVISION_BODY }),
      { contentId: CONTENT_ID },
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(500);
  });

  it("production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED for all six operations", async () => {
    const service = createProductionOwnerPublicationService();
    const logger = createTestLogger();
    const responses = [
      await handleGetOwnerContentAggregate(getRequest(), { contentId: CONTENT_ID }, { service, security: ownerTestSecurity(), logger }),
      await handleSaveOwnerContentRevision(
        postRequest(CONTENT_ID, "revisions", { body: REVISION_BODY }),
        { contentId: CONTENT_ID },
        { service, security: ownerTestSecurity(), logger },
      ),
      await handlePublishOwnerContentLanguage(
        postRequest(CONTENT_ID, "commands/publish-language", { body: PUBLISH_BODY }),
        { contentId: CONTENT_ID },
        { service, security: ownerTestSecurity(), logger },
      ),
      await handleHideOwnerContent(
        postRequest(CONTENT_ID, "commands/hide", { body: {} }),
        { contentId: CONTENT_ID },
        { service, security: ownerTestSecurity(), logger },
      ),
      await handleArchiveOwnerContent(
        postRequest(CONTENT_ID, "commands/archive", { body: {} }),
        { contentId: CONTENT_ID },
        { service, security: ownerTestSecurity(), logger },
      ),
      await handleRestoreOwnerContent(
        postRequest(CONTENT_ID, "commands/restore", { body: {} }),
        { contentId: CONTENT_ID },
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
    const owner = { kind: "owner", ownerId: CONTENT_ID, sessionId: "s" } as const;
    const directCalls = [
      service.getOwnerContentAggregate({ actor: owner as never, contentId: CONTENT_ID as never }),
      service.saveOwnerContentRevision({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        contentId: CONTENT_ID as never,
        locale: "en",
        title: "t",
        summary: "s",
        body: "b",
      }),
      service.publishOwnerContentLanguage({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        contentId: CONTENT_ID as never,
        locale: "en",
        revisionId: REVISION_ID as never,
      }),
      service.hideOwnerContent({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        contentId: CONTENT_ID as never,
      }),
      service.archiveOwnerContent({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        contentId: CONTENT_ID as never,
      }),
      service.restoreOwnerContent({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 2,
        contentId: CONTENT_ID as never,
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
      async getOwnerContentAggregate(): Promise<never> {
        throw new Error("boom postgres://user:pass@host/db token=tok_123 /app/secret.ts");
      },
      async saveOwnerContentRevision(): Promise<never> {
        throw new Error("unreachable");
      },
      async publishOwnerContentLanguage(): Promise<never> {
        throw new Error("unreachable");
      },
      async hideOwnerContent(): Promise<never> {
        throw new Error("unreachable");
      },
      async archiveOwnerContent(): Promise<never> {
        throw new Error("unreachable");
      },
      async restoreOwnerContent(): Promise<never> {
        throw new Error("unreachable");
      },
    };
    const response = await handleGetOwnerContentAggregate(
      getRequest(),
      { contentId: CONTENT_ID },
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
