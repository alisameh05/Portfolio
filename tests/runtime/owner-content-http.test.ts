import { describe, expect, it } from "vitest";
import { unsafeStableId } from "../../src/shared/domain/index.js";
import type { PublishLanguageVersionCommand } from "../../src/modules/content-publishing/application/service.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import { createOwnerPublicationTestFake } from "../../src/runtime/fakes/owner-publication.js";
import type { ContentAuthoringService } from "../../src/modules/content-publishing/application/authoring.js";
import {
  handleCreateOwnerContent,
} from "../../src/runtime/http/owner-content-authoring.js";
import {
  handleGetOwnerContentAggregate,
  handleHideOwnerContent,
  handlePublishOwnerContentLanguage,
  handleSaveOwnerContentRevision,
} from "../../src/runtime/http/owner-publication.js";
import {
  handleGetOwnerContentHistory,
  handlePreviewOwnerContentRevision,
  handleReviewOwnerContentRevision,
} from "../../src/runtime/http/owner-content-review.js";
import { ownerTestSecurity, withOwnerTestAuth } from "./owner-test-auth.js";

const CONTENT_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea1";
const REVISION_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea2";
const CONTENT = {
  contentId: CONTENT_ID,
  aggregateVersion: 1,
  contentType: "project",
  lifecycle: "draft",
  publicRoute: {
    identity: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea7",
    canonicalSlug: "route-current",
    redirects: [{ fromSlug: "route-before", toSlug: "route-current" }],
    history: [{ sequence: 1, fromSlug: "route-before", toSlug: "route-current", changedAt: "2026-10-08T00:00:00.000Z" }],
  },
  routeHistory: [{ sequence: 1, fromSlug: "route-before", toSlug: "route-current", changedAt: "2026-10-08T00:00:00.000Z" }],
  localizedStreams: { en: { revisionCount: 1, currentPublishedRevisionId: null } },
  revisions: [{ revisionId: REVISION_ID, locale: "en", sequence: 1, reviewed: false }],
};

function createService() {
  const calls: { create: unknown[]; get: unknown[]; save: unknown[]; preview: unknown[]; review: unknown[]; history: unknown[]; publish: unknown[]; hide: unknown[]; archive: unknown[]; restore: unknown[] } = { create: [], get: [], save: [], preview: [], review: [], history: [], publish: [], hide: [], archive: [], restore: [] };
  const service: ContentAuthoringService = {
    async createContent(command) {
      calls.create.push(command);
      return { ok: true, value: { contentId: unsafeStableId<string>(CONTENT_ID), aggregateVersion: 1, revisionId: unsafeStableId<"Revision">(REVISION_ID), outcome: "content-created" } };
    },
    async getOwnerContentAggregate(query) {
      calls.get.push(query);
      return { ok: true, value: CONTENT as never };
    },
    async saveRevision(command) {
      calls.save.push(command);
      return { ok: true, value: { aggregateId: unsafeStableId<string>(CONTENT_ID), aggregateVersion: 2, revisionId: unsafeStableId<"Revision">(REVISION_ID), outcome: "revision-saved" } };
    },
    async previewRevision(query) {
      calls.preview.push(query);
      return { ok: true, value: { contentId: unsafeStableId<string>(CONTENT_ID), revisionId: unsafeStableId<"Revision">(REVISION_ID), locale: "en", sequence: 1, title: "Atlas", summary: "Private", body: "Private preview", snapshotHash: "a".repeat(64), evidenceVersion: 1, review: null } };
    },
    async reviewRevision(command) {
      calls.review.push(command);
      return { ok: true, value: { aggregateId: unsafeStableId<string>(CONTENT_ID), aggregateVersion: 2, outcome: "revision-reviewed", revisionId: unsafeStableId<"Revision">(REVISION_ID), reviewId: unsafeStableId<"ContentReview">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea3") } };
    },
    async publishLanguageVersion(command: PublishLanguageVersionCommand) {
      calls.publish.push(command);
      return { ok: true as const, value: { aggregateId: unsafeStableId<string>(CONTENT_ID), aggregateVersion: 3, outcome: "language-published" as const,
        revisionId: unsafeStableId<"Revision">(REVISION_ID), locale: command.locale, currentSlug: "atlas", routeIdentity: unsafeStableId<"PublicRoute">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea4"),
        firstPublishedAt: "2026-10-07T12:00:00.000Z", publishedAt: "2026-10-07T12:00:00.000Z" } };
    },
    async correctCandidateSlug(command) { return { ok: true, value: { aggregateId: command.projectId, aggregateVersion: command.expectedVersion + 1, outcome: "candidate-slug-corrected", slug: command.candidateSlug } }; },
    async changePublicSlug(command) { return { ok: true, value: { aggregateId: command.projectId, aggregateVersion: command.expectedVersion + 1, outcome: "public-slug-changed", slug: command.newSlug } }; },
    async hideContent(command) {
      calls.hide.push(command);
      return { ok: true, value: { aggregateId: unsafeStableId<string>(CONTENT_ID), aggregateVersion: 4, outcome: "content-hidden" } };
    },
    async archiveContent(command) {
      calls.archive.push(command);
      return { ok: true, value: { aggregateId: unsafeStableId<string>(CONTENT_ID), aggregateVersion: 4, outcome: "content-archived" } };
    },
    async restoreContent(command) {
      calls.restore.push(command);
      return { ok: true, value: { aggregateId: unsafeStableId<string>(CONTENT_ID), aggregateVersion: 4, outcome: "content-restored" } };
    },
    async getPublicProject() { return { ok: false as const, error: { kind: "not_found" as const, code: "PUBLIC_CONTENT_NOT_FOUND" } }; },
    async resolvePublicProjectRoute() { return { ok: false as const, error: { kind: "not_found" as const, code: "PUBLIC_CONTENT_NOT_FOUND" } }; },
    async getPublicTestimonials() { return { ok: true as const, value: [] }; },
    async getPublicAchievementTimeline() { return { ok: true as const, value: [] }; },
    async getContentHistory(query) {
      calls.history.push(query);
      return { ok: true, value: { entries: [{ revisionId: unsafeStableId<"Revision">(REVISION_ID), locale: "en", sequence: 1, savedAt: "2026-10-05T08:00:00.000Z", reviewDecision: "accepted" }], routeHistory: [{ sequence: 1, fromSlug: "route-before", toSlug: "route-current", changedAt: "2026-10-08T00:00:00.000Z" }], nextCursor: null } };
    },
    async listProjectStatusValues() { return { ok: true as const, value: [] }; },
    async getProjectOwnerView() { return { ok: false as const, error: { kind: "not_found" as const, code: "PROJECT_NOT_FOUND" } }; },
    async getProjectStatusHistory() { return { ok: true as const, value: [] }; },
    async createProjectStatusValue() { return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "UNAVAILABLE" } }; },
    async renameProjectStatusValue() { return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "UNAVAILABLE" } }; },
    async retireProjectStatusValue() { return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "UNAVAILABLE" } }; },
    async changeProjectStatus() { return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "UNAVAILABLE" } }; },
    async setProjectFeatured() { return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "UNAVAILABLE" } }; },
  };
  return { calls, service };
}

function request(method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/api/owner/v1/content", {
    method,
    headers: withOwnerTestAuth({ "content-type": "application/json", ...headers }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("Owner content authoring HTTP adapters", () => {
  it("creates Draft content without an If-Match header and dispatches one validated command", async () => {
    const fake = createService();
    const response = await handleCreateOwnerContent(
      request("POST", { contentType: "project", locale: "en", title: "Atlas Search", summary: "A draft.", body: "Draft only.", candidateSlug: "atlas-search",
        evidence: { artifacts: [{ id: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea3", title: "Demo", mediaAssetId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea4" }] },
        externalLinks: [{ id: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea5", label: "Project site", destination: "https://example.com/project", isAvailableInArabic: true }],
      }, { "idempotency-key": "create-project-1" }),
      { service: fake.service, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(201);
    expect(fake.calls.create).toHaveLength(1);
    expect(fake.calls.create[0]).toMatchObject({ payload: { evidence: { artifacts: [{ mediaAssetId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea4" }] }, externalLinks: [{ destination: "https://example.com/project" }] } });
    expect(await response.json()).toEqual({ contentId: CONTENT_ID, aggregateVersion: 1, revisionId: REVISION_ID, outcome: "content-created" });
  });

  it("dispatches a minimal Testimonial through the existing strict Owner content boundary", async () => {
    const fake = createService();
    const response = await handleCreateOwnerContent(
      request("POST", { contentType: "testimonial", locale: "en", title: "Stored feedback", summary: "A reviewed quote.",
        body: "The release clarified our workflow.", authorName: "Product lead", quote: "The release clarified our workflow.",
        association: { type: "profile" } }, { "idempotency-key": "create-testimonial-1" }),
      { service: fake.service, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(201);
    expect(fake.calls.create).toHaveLength(1);
    expect(fake.calls.create[0]).toMatchObject({
      payload: { contentType: "testimonial", authorName: "Product lead", quote: "The release clarified our workflow.", association: { type: "profile" } },
    });
  });

  it("rejects unknown draft fields before dispatch", async () => {
    const fake = createService();
    const response = await handleCreateOwnerContent(
      request("POST", { contentType: "project", locale: "en", title: "Atlas Search", summary: "A draft.", body: "Draft.", candidateSlug: "atlas-search", private: true }),
      { service: fake.service, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(400);
    expect(fake.calls.create).toHaveLength(0);
  });

  it("inspects a scoped aggregate and saves a Revision using the declared precondition headers", async () => {
    const fake = createService();
    const publicationFake = createOwnerPublicationTestFake({ type: "success" });
    const get = await handleGetOwnerContentAggregate(
      request("GET"),
      { contentId: CONTENT_ID },
      { service: publicationFake, contentAuthoring: fake.service, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ routeHistory: [{ sequence: 1, fromSlug: "route-before", toSlug: "route-current" }] });
    expect(fake.calls.get).toHaveLength(1);
    const save = await handleSaveOwnerContentRevision(
      request("POST", { locale: "ar", title: "بحث", summary: "مسودة", body: "نص أولي", draftData: { contentType: "project", caseStudy: { outcomes: ["مخرجات"] },
        evidence: { artifacts: [{ id: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea3", title: "Arabic demo", mediaAssetId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea4" }] },
        externalLinks: [{ id: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea5", label: "موقع المشروع", destination: "https://example.com/project-ar", isAvailableInArabic: true }],
      } }, { "idempotency-key": "save-1", "if-match": '"1"' }),
      { contentId: CONTENT_ID },
      { service: publicationFake, contentAuthoring: fake.service, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(save.status).toBe(201);
    expect(fake.calls.save).toHaveLength(1);
    expect(fake.calls.save[0]).toMatchObject({ expectedVersion: 1, locale: "ar", body: "نص أولي", draftData: { contentType: "project", caseStudy: { outcomes: ["مخرجات"] },
      evidence: { artifacts: [{ mediaAssetId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea4" }] }, externalLinks: [{ destination: "https://example.com/project-ar" }] } });
  });

  it("publishes through the PostgreSQL-backed Content facade and returns the new ETag", async () => {
    const fake = createService();
    const publicationFake = createOwnerPublicationTestFake({ type: "success" });
    const response = await handlePublishOwnerContentLanguage(
      request("POST", { locale: "en", revisionId: REVISION_ID }, { "idempotency-key": "publish-1", "if-match": '"2"' }),
      { contentId: CONTENT_ID },
      { service: publicationFake, contentAuthoring: fake.service, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"3"');
    expect(await response.json()).toEqual({ aggregateId: CONTENT_ID, aggregateVersion: 3, outcome: "language-published" });
    expect(fake.calls.publish).toMatchObject([{ contentId: CONTENT_ID, expectedVersion: 2, locale: "en", revisionId: REVISION_ID }]);
    expect(publicationFake.calls.publishOwnerContentLanguage).toHaveLength(0);
  });

  it("passes the server trace ID to lifecycle events separately from the idempotency key", async () => {
    const fake = createService();
    const publicationFake = createOwnerPublicationTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleHideOwnerContent(
      request("POST", { reason: "Temporary review." }, {
        "idempotency-key": "hide-key-1", "if-match": '"3"', "x-request-id": "inbound-trace-1",
      }),
      { contentId: CONTENT_ID },
      { service: publicationFake, contentAuthoring: fake.service, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(200);
    const command = fake.calls.hide[0] as { readonly correlationId: string; readonly idempotencyKey: string };
    expect(command.idempotencyKey).toBe("hide-key-1");
    expect(command.correlationId).not.toBe(command.idempotencyKey);
    expect(logger.records.find((record) => record.event === "request.completed")?.fields["traceId"])
      .toBe(command.correlationId);
  });

  it("serves private non-indexable previews and returns a bounded Owner history page", async () => {
    const fake = createService();
    const logger = createTestLogger();
    const preview = await handlePreviewOwnerContentRevision(
      request("GET"), { contentId: CONTENT_ID, revisionId: REVISION_ID },
      { service: fake.service, security: ownerTestSecurity(), logger },
    );
    expect(preview.status).toBe(200);
    expect(preview.headers.get("cache-control")).toBe("private, no-store");
    expect(preview.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await preview.json()).toMatchObject({ snapshotHash: "a".repeat(64), evidenceVersion: 1, review: null });
    expect(fake.calls.preview).toHaveLength(1);

    const history = await handleGetOwnerContentHistory(
      request("GET", undefined, { accept: "application/json" }), { contentId: CONTENT_ID },
      { service: fake.service, security: ownerTestSecurity(), logger },
    );
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ entries: [{ revisionId: REVISION_ID, reviewDecision: "accepted" }], routeHistory: [{ sequence: 1, fromSlug: "route-before", toSlug: "route-current" }], nextCursor: null });
    expect(fake.calls.history[0]).toMatchObject({ limit: 25 });
    expect(JSON.stringify(logger.records)).not.toContain("Private preview");
  });

  it("records an exact-snapshot review through strict contract and concurrency validation", async () => {
    const fake = createService();
    const logger = createTestLogger();
    const review = await handleReviewOwnerContentRevision(
      request("POST", { locale: "en", snapshotHash: "a".repeat(64), evidenceVersion: 1, decision: "accepted", findings: ["Keep review notes private."] }, { "idempotency-key": "review-1", "if-match": '"1"' }),
      { contentId: CONTENT_ID, revisionId: REVISION_ID },
      { service: fake.service, security: ownerTestSecurity(), logger },
    );
    expect(review.status).toBe(200);
    expect(await review.json()).toMatchObject({ aggregateVersion: 2, outcome: "revision-reviewed" });
    expect(fake.calls.review[0]).toMatchObject({ expectedVersion: 1, locale: "en", snapshotHash: "a".repeat(64), evidenceVersion: 1, decision: "accepted" });
    const malformed = await handleReviewOwnerContentRevision(
      request("POST", { locale: "en", snapshotHash: "wrong", evidenceVersion: 1, decision: "accepted", findings: [] }, { "idempotency-key": "review-2", "if-match": '"1"' }),
      { contentId: CONTENT_ID, revisionId: REVISION_ID },
      { service: fake.service, security: ownerTestSecurity(), logger },
    );
    expect(malformed.status).toBe(400);
    expect(fake.calls.review).toHaveLength(1);
    expect(JSON.stringify(logger.records)).not.toContain("Keep review notes private.");
  });
});
