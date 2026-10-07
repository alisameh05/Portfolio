import { describe, expect, it } from "vitest";

import { unsafeStableId, type ActorContext } from "../../src/shared/domain/index.js";
import type { TransactionContext } from "../../src/runtime/ports.js";
import type { OperationsPersistencePorts, SafeResultEnvelope } from "../../src/modules/portability-operations/application/persistence.js";
import {
  createContentAuthoringService,
  type ContentAuthoringRecord,
  type ContentAuthoringRepository,
} from "../../src/modules/content-publishing/application/authoring.js";
import type { CreateDraftPayload } from "../../src/modules/content-publishing/domain/index.js";
import type { PublicProjectContentView } from "../../src/modules/content-publishing/application/authoring.js";

const OWNER_ID = unsafeStableId<"Owner">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea1");
const PORTFOLIO_ID = unsafeStableId<"Portfolio">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea2");
const ACTOR: ActorContext = { kind: "owner", ownerId: OWNER_ID, sessionId: "session-test" };

function uuid(index: number): string {
  return `0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e${String(index).padStart(2, "0")}`;
}

function createHarness() {
  const records = new Map<string, ContentAuthoringRecord>();
  const publicProjects = new Map<string, PublicProjectContentView>();
  const events: unknown[] = [];
  let id = 10;
  const repository: ContentAuthoringRepository = {
    async projectExists(projectId) {
      return projectId.endsWith("91");
    },
    async create(input) {
      const revision = {
        revisionId: input.revisionId,
        contentId: input.contentId,
        contentType: input.payload.contentType,
        locale: input.payload.locale,
        sequence: 1,
        aggregateVersion: 1,
        evidenceSnapshotVersion: 1,
        title: input.payload.title,
        summary: input.payload.summary,
        body: input.payload.body,
        payload: input.payload,
        savedAt: input.savedAt,
        reviewed: false,
      };
      const record: ContentAuthoringRecord = {
        contentId: input.contentId,
        portfolioId: input.portfolioId,
        ownerId: input.ownerId,
        contentType: input.payload.contentType,
        lifecycle: "draft",
        candidateSlug: input.candidateSlug,
        aggregateVersion: 1,
        revisions: [revision],
      };
      records.set(input.contentId, record);
      return { ok: true, value: record };
    },
    async get(contentId, scope) {
      const record = records.get(contentId);
      if (!record || record.portfolioId !== scope.portfolioId || record.ownerId !== scope.ownerId) {
        return { ok: false, error: { kind: "not_found", code: "CONTENT_NOT_FOUND" } };
      }
      return { ok: true, value: record };
    },
    async appendRevision(input) {
      const prior = records.get(input.contentId);
      if (!prior) return { ok: false, error: { kind: "not_found", code: "CONTENT_NOT_FOUND" } };
      if (prior.aggregateVersion !== input.expectedVersion) {
        return { ok: false, error: { kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion: prior.aggregateVersion } };
      }
      const sequence = 1 + Math.max(0, ...prior.revisions.filter((revision) => revision.locale === input.payload.locale).map((revision) => revision.sequence));
      const revision = {
        revisionId: input.revisionId,
        contentId: input.contentId,
        contentType: prior.contentType,
        locale: input.payload.locale,
        sequence,
        aggregateVersion: prior.aggregateVersion + 1,
        evidenceSnapshotVersion: prior.aggregateVersion + 1,
        title: input.payload.title,
        summary: input.payload.summary,
        body: input.payload.body,
        payload: input.payload,
        savedAt: input.savedAt,
        reviewed: false,
      };
      const updated = { ...prior, aggregateVersion: prior.aggregateVersion + 1, revisions: [...prior.revisions, revision] };
      records.set(input.contentId, updated);
      return { ok: true, value: { record: updated, revision } };
    },
    async appendReview(input) {
      const prior = records.get(input.contentId);
      if (!prior) return { ok: false, error: { kind: "not_found", code: "CONTENT_NOT_FOUND" } };
      if (prior.aggregateVersion !== input.expectedVersion) return { ok: false, error: { kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion: prior.aggregateVersion } };
      const revisions = prior.revisions.map((revision) => revision.revisionId === input.revisionId
        ? { ...revision, reviewed: true, reviewDecision: input.decision, latestReview: {
          reviewId: input.reviewId, revisionId: input.revisionId, contentId: input.contentId, contentType: prior.contentType,
          locale: input.locale, snapshotHash: input.snapshotHash, evidenceVersion: input.evidenceVersion,
          reviewerId: input.reviewerId, reviewSequence: 1, decision: input.decision, findings: input.findings, reviewedAt: input.reviewedAt,
        } }
        : revision);
      records.set(input.contentId, { ...prior, aggregateVersion: prior.aggregateVersion + 1, revisions });
      return { ok: true, value: { aggregateVersion: prior.aggregateVersion + 1 } };
    },
    async publishProjectLanguage(input) {
      const prior = records.get(input.contentId);
      if (!prior) return { ok: false, error: { kind: "not_found", code: "CONTENT_NOT_FOUND" } };
      if (prior.aggregateVersion !== input.expectedVersion) return { ok: false, error: { kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion: prior.aggregateVersion } };
      const publishedAt = "2026-10-07T12:00:00.000Z";
      const currentSlug = prior.candidateSlug ?? "project";
      const artifacts = new Map((input.payload.evidence?.artifacts ?? []).map((artifact) => [artifact.id, artifact]));
      publicProjects.set(`${currentSlug}:${input.locale}`, {
        contentId: input.contentId, contentType: "project", locale: input.locale, revisionId: input.revisionId,
        routeIdentity: input.routeIdentity, currentSlug, title: input.payload.title, summary: input.payload.summary, body: input.payload.body,
        firstPublishedAt: publishedAt, publishedAt,
        caseStudy: input.payload.caseStudy as PublicProjectContentView["caseStudy"],
        claims: (input.payload.evidence?.claims ?? []).map((claim) => ({ text: claim.text, artifacts: claim.artifactIds.map((id) => {
          const artifact = artifacts.get(id)!;
          return { title: artifact.title, ...(artifact.destinationUrl === undefined ? {} : { destinationUrl: artifact.destinationUrl }), ...(artifact.mediaAssetId === undefined ? {} : { mediaAssetId: artifact.mediaAssetId }) };
        }) })),
        externalLinks: (input.payload.externalLinks ?? []).filter((link) => input.locale === "en" || link.isAvailableInArabic).map(({ label, destination }) => ({ label, destination })),
      });
      records.set(input.contentId, { ...prior, lifecycle: "published", aggregateVersion: prior.aggregateVersion + 1,
        publications: [...(prior.publications ?? []).filter((publication) => publication.locale !== input.locale), { locale: input.locale, revisionId: input.revisionId, publishedAt }] });
      return { ok: true, value: { aggregateVersion: prior.aggregateVersion + 1, revisionId: input.revisionId, locale: input.locale,
        routeIdentity: input.routeIdentity, currentSlug, firstPublishedAt: publishedAt, publishedAt } };
    },
    async getPublicProjectBySlug(input) {
      const project = publicProjects.get(`${input.slug}:${input.locale}`);
      return project === undefined
        ? { ok: false, error: { kind: "not_found", code: "PUBLIC_CONTENT_NOT_FOUND" } }
        : { ok: true, value: project };
    },
    async listHistory(input) {
      const record = records.get(input.contentId);
      if (!record || record.portfolioId !== input.scope.portfolioId || record.ownerId !== input.scope.ownerId) {
        return { ok: false, error: { kind: "not_found", code: "CONTENT_NOT_FOUND" } };
      }
      const selected = record.revisions.filter((revision) =>
        (input.locale === undefined || revision.locale === input.locale) &&
        (input.after === undefined || revision.locale > input.after.locale || revision.locale === input.after.locale && revision.sequence > input.after.sequence));
      return { ok: true, value: {
        entries: selected.slice(0, input.limit).map((revision) => ({ revisionId: revision.revisionId, locale: revision.locale, sequence: revision.sequence, savedAt: revision.savedAt, ...(revision.reviewDecision === undefined ? {} : { reviewDecision: revision.reviewDecision }) })),
        hasMore: selected.length > input.limit,
      } };
    },
  };

  const cache = new Map<string, { requestHash: string; result: SafeResultEnvelope }>();
  const operations = {
    transactions: { async run(callback: (context: TransactionContext) => unknown) { return await callback({ kind: "transaction" }); } },
    idempotency: {
      async execute(input: { operationScope: string; actorScope: string; key: string; requestHash: string }, effect: (context: TransactionContext) => Promise<SafeResultEnvelope>) {
        const key = `${input.operationScope}:${input.actorScope}:${input.key}`;
        const saved = cache.get(key);
        if (saved) return saved.requestHash === input.requestHash ? { kind: "replayed" as const, result: saved.result } : { kind: "conflict" as const };
        const result = await effect({ kind: "transaction" });
        cache.set(key, { requestHash: input.requestHash, result });
        return { kind: "executed" as const, result };
      },
    },
    outbox: { async append(_context: TransactionContext, event: unknown) { events.push(event); } },
    jobs: {} as OperationsPersistencePorts["jobs"],
  } as OperationsPersistencePorts;
  const service = createContentAuthoringService({
    repository,
    operations,
    scope: { ownerId: OWNER_ID, portfolioId: PORTFOLIO_ID },
    clock: { now: () => "2026-10-05T08:00:00.000Z" },
    ids: { generate: () => uuid(id++) },
  });
  return { service, records, events };
}

describe("Content authoring application service", () => {
  it("reviews the exact immutable Revision snapshot, replays safely, and keeps a saved Revision unreviewed", async () => {
    const { service, records, events } = createHarness();
    const created = await service.createContent({
      actor: ACTOR,
      idempotencyKey: "review-create" as never,
      correlationId: "review-create",
      payload: { contentType: "project", locale: "en", title: "Reviewed", summary: "Exact snapshot.", body: "Private evidence review." },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const initial = records.get(created.value.contentId)?.revisions[0];
    if (initial === undefined) throw new Error("expected initial Revision");
    const preview = await service.previewRevision({ actor: ACTOR, contentId: created.value.contentId, revisionId: initial.revisionId });
    expect(preview).toMatchObject({ ok: true, value: { locale: "en", evidenceVersion: 1, title: "Reviewed", review: null } });
    if (!preview.ok) return;
    expect(preview.value.snapshotHash).toMatch(/^[0-9a-f]{64}$/);

    const command = {
      actor: ACTOR, contentId: created.value.contentId, revisionId: initial.revisionId,
      expectedVersion: 1, idempotencyKey: "review-once" as never, correlationId: "review-once",
      locale: "en" as const, snapshotHash: preview.value.snapshotHash, evidenceVersion: preview.value.evidenceVersion,
      decision: "accepted" as const, findings: ["Evidence checked privately."],
    };
    const reviewed = await service.reviewRevision(command);
    expect(reviewed).toMatchObject({ ok: true, value: { aggregateVersion: 2, outcome: "revision-reviewed", revisionId: initial.revisionId } });
    expect(events.at(-1)).toMatchObject({ payload: { type: "content.revision_reviewed.v1", value: { decision: "accepted" } } });
    if (!reviewed.ok) return;
    expect(await service.reviewRevision(command)).toEqual(reviewed);
    expect(events.filter((event) => (event as { payload?: { type?: string } }).payload?.type === "content.revision_reviewed.v1")).toHaveLength(1);
    const inspected = await service.previewRevision({ actor: ACTOR, contentId: created.value.contentId, revisionId: initial.revisionId });
    expect(inspected).toMatchObject({ ok: true, value: { review: { reviewId: reviewed.value.reviewId, decision: "accepted", findings: ["Evidence checked privately."] } } });
    const reviewedRecord = records.get(created.value.contentId);
    if (reviewedRecord === undefined) throw new Error("expected reviewed content");
    records.set(created.value.contentId, {
      ...reviewedRecord,
      revisions: reviewedRecord.revisions.map((revision) => revision.revisionId === initial.revisionId
        ? { ...revision, latestReview: { ...revision.latestReview!, evidenceVersion: revision.evidenceSnapshotVersion + 1 } }
        : revision),
    });
    expect(await service.previewRevision({ actor: ACTOR, contentId: created.value.contentId, revisionId: initial.revisionId }))
      .toMatchObject({ ok: false, error: { kind: "temporarily_unavailable", code: "CONTENT_REVIEW_INTEGRITY_FAILED" } });
    records.set(created.value.contentId, reviewedRecord);

    const saved = await service.saveRevision({
      actor: ACTOR, contentId: created.value.contentId, expectedVersion: 2,
      idempotencyKey: "review-followup-save" as never, correlationId: "review-followup-save",
      locale: "en", title: "Updated", summary: "New snapshot.", body: "This does not inherit approval.",
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const nextPreview = await service.previewRevision({ actor: ACTOR, contentId: created.value.contentId, revisionId: saved.value.revisionId });
    expect(nextPreview).toMatchObject({ ok: true, value: { title: "Updated", evidenceVersion: 3, review: null } });
    expect(records.get(created.value.contentId)?.revisions.map((revision) => revision.reviewed)).toEqual([true, false]);
  });

  it("rejects a wrong snapshot hash, locale, or stale root version without recording a review", async () => {
    const { service, records, events } = createHarness();
    const created = await service.createContent({
      actor: ACTOR, idempotencyKey: "review-invalid-create" as never, correlationId: "review-invalid-create",
      payload: { contentType: "achievement", locale: "en", title: "Review target", summary: "Draft.", body: "Private." },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const revision = records.get(created.value.contentId)?.revisions[0];
    if (revision === undefined) throw new Error("expected initial Revision");
    const preview = await service.previewRevision({ actor: ACTOR, contentId: created.value.contentId, revisionId: revision.revisionId });
    if (!preview.ok) throw new Error("expected Owner preview");
    const base = {
      actor: ACTOR, contentId: created.value.contentId, revisionId: revision.revisionId,
      expectedVersion: 1, idempotencyKey: "review-invalid" as never, correlationId: "review-invalid",
      locale: "en" as const, snapshotHash: preview.value.snapshotHash, evidenceVersion: preview.value.evidenceVersion,
      decision: "rejected" as const, findings: ["Needs more evidence."],
    };
    expect(await service.reviewRevision({ ...base, snapshotHash: "0".repeat(64) })).toMatchObject({ ok: false, error: { kind: "conflict", code: "REVISION_SNAPSHOT_MISMATCH" } });
    expect(await service.reviewRevision({ ...base, idempotencyKey: "review-invalid-locale" as never, locale: "ar" })).toMatchObject({ ok: false, error: { kind: "validation", code: "REVISION_LOCALE_MISMATCH" } });
    expect(records.get(created.value.contentId)?.aggregateVersion).toBe(1);
    expect(events.some((event) => (event as { payload?: { type?: string } }).payload?.type === "content.revision_reviewed.v1")).toBe(false);
    expect(await service.previewRevision({ actor: { kind: "visitor", consent: "unknown" }, contentId: created.value.contentId, revisionId: revision.revisionId }))
      .toMatchObject({ ok: false, error: { kind: "forbidden", code: "OWNER_REQUIRED" } });
    expect(await service.previewRevision({ actor: ACTOR, contentId: created.value.contentId, revisionId: unsafeStableId<"Revision">(uuid(99)) }))
      .toMatchObject({ ok: false, error: { kind: "not_found", code: "REVISION_NOT_FOUND" } });
  });

  it("returns bounded history pages with stable locale-sequence cursors and current review facts", async () => {
    const { service } = createHarness();
    const created = await service.createContent({
      actor: ACTOR, idempotencyKey: "history-create" as never, correlationId: "history-create",
      payload: { contentType: "project", locale: "en", title: "History one", summary: "First.", body: "First." },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    let expectedVersion = 1;
    for (const [index, title] of ["History two", "History three"].entries()) {
      const saved = await service.saveRevision({
        actor: ACTOR, contentId: created.value.contentId, expectedVersion,
        idempotencyKey: `history-save-${index}` as never, correlationId: `history-save-${index}`,
        locale: "en", title, summary: `Revision ${index + 2}.`, body: `Body ${index + 2}.`,
      });
      expect(saved.ok).toBe(true);
      if (!saved.ok) return;
      expectedVersion = saved.value.aggregateVersion;
    }
    const first = await service.getContentHistory({ actor: ACTOR, contentId: created.value.contentId, locale: "en", limit: 1 });
    expect(first).toMatchObject({ ok: true, value: { entries: [{ locale: "en", sequence: 1 }], nextCursor: "en:1" } });
    if (!first.ok || first.value.nextCursor === null) return;
    const second = await service.getContentHistory({ actor: ACTOR, contentId: created.value.contentId, locale: "en", limit: 1, cursor: first.value.nextCursor });
    expect(second).toMatchObject({ ok: true, value: { entries: [{ locale: "en", sequence: 2 }], nextCursor: "en:2" } });
    expect(await service.getContentHistory({ actor: ACTOR, contentId: created.value.contentId, locale: "ar", limit: 1, cursor: "en:1" }))
      .toMatchObject({ ok: false, error: { kind: "validation", code: "CONTENT_HISTORY_CURSOR_SCOPE_MISMATCH" } });
  });

  it.each([
    ["project", { contentType: "project", candidateSlug: "atlas-search", caseStudy: { problem: "A draft problem." }, evidence: { artifacts: [{ id: unsafeStableId<"SupportingArtifact">(uuid(92)), title: "Demo", mediaAssetId: unsafeStableId<"MediaAsset">(uuid(93)) }] }, externalLinks: [{ id: unsafeStableId<"ExternalLink">(uuid(94)), label: "Project site", destination: "https://example.com/project", isAvailableInArabic: true }] }],
    ["achievement", { contentType: "achievement", achievedOn: "2025-04-12", evidence: { claims: [{ claimId: unsafeStableId<"EvidenceClaim">(uuid(90)), text: "A draft claim.", artifactIds: [] }], artifacts: [{ id: unsafeStableId<"SupportingArtifact">(uuid(92)), title: "Proof", mediaAssetId: unsafeStableId<"MediaAsset">(uuid(93)) }] } }],
    ["testimonial", { contentType: "testimonial", authorName: "Reviewer", quote: "A draft quote.", relatedProjectId: unsafeStableId<"Project">(uuid(91)) }],
  ] as const)("creates a private %s Draft with its typed initial Revision", async (kind, details) => {
    const { service, records, events } = createHarness();
    const payload = {
      ...details,
      locale: "en",
      title: "Atlas Search",
      summary: "A short draft.",
      body: "Draft only.",
    } as CreateDraftPayload;
    const result = await service.createContent({ actor: ACTOR, idempotencyKey: "create-1" as never, correlationId: "trace-1", payload });
    expect(result).toMatchObject({ ok: true, value: { outcome: "content-created", aggregateVersion: 1 } });
    const record = records.get(result.ok ? result.value.contentId : "");
    expect(record).toMatchObject({ contentType: kind, lifecycle: "draft", aggregateVersion: 1, revisions: [{ locale: "en", sequence: 1, reviewed: false }] });
    expect(record?.revisions[0]?.payload).toMatchObject(payload);
    if (kind === "testimonial") {
      expect(record?.revisions[0]?.payload).toMatchObject({ association: { type: "project", projectId: uuid(91) } });
    }
    if (kind === "project") {
      expect(record?.revisions[0]?.payload).toMatchObject({ evidence: { artifacts: [{ mediaAssetId: uuid(93) }] }, externalLinks: [{ destination: "https://example.com/project" }] });
    }
    if (kind === "achievement") {
      expect(record?.revisions[0]?.payload).toMatchObject({ evidence: { artifacts: [{ mediaAssetId: uuid(93) }] } });
    }
    expect(record?.candidateSlug).toBe(kind === "project" ? "atlas-search" : null);
    expect(events).toHaveLength(2);
  });

  it("generates a safe candidate slug and saves a new locale Revision with increasing version and stream sequence", async () => {
    const { service, records } = createHarness();
    const created = await service.createContent({
      actor: ACTOR,
      idempotencyKey: "create-2" as never,
      correlationId: "trace-2",
      payload: { contentType: "project", locale: "en", title: "R&D / Café Search", summary: "Draft.", body: "Initial." },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(records.get(created.value.contentId)?.candidateSlug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const saved = await service.saveRevision({
      actor: ACTOR,
      contentId: created.value.contentId,
      expectedVersion: 1,
      idempotencyKey: "save-2" as never,
      correlationId: "trace-3",
      locale: "ar",
      title: "بحث",
      summary: "مسودة.",
      body: "المحتوى.",
    });
    expect(saved).toMatchObject({ ok: true, value: { aggregateVersion: 2, outcome: "revision-saved" } });
    expect(records.get(created.value.contentId)?.aggregateVersion).toBe(2);
    const inspected = await service.getOwnerContentAggregate({ actor: ACTOR, contentId: created.value.contentId });
    expect(inspected).toMatchObject({ ok: true, value: { localizedStreams: { en: { revisionCount: 1 }, ar: { revisionCount: 1 } }, revisions: [{ locale: "en", sequence: 1 }, { locale: "ar", sequence: 1 }] } });
  });

  it("rejects unknown Save draft-data keys before appending a Revision", async () => {
    const { service, records } = createHarness();
    const created = await service.createContent({
      actor: ACTOR, idempotencyKey: "strict-save-create" as never, correlationId: "strict-save-create",
      payload: { contentType: "project", locale: "en", title: "Project", summary: "Draft.", body: "Private." },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const result = await service.saveRevision({
      actor: ACTOR, contentId: created.value.contentId, expectedVersion: 1,
      idempotencyKey: "strict-save-unknown-key" as never, correlationId: "strict-save-unknown-key",
      locale: "en", title: "Updated", summary: "Updated.", body: "Private.",
      draftData: { contentType: "project", unexpected: "must not be dropped" } as never,
    });
    expect(result).toEqual({ ok: false, error: { kind: "validation", code: "INVALID_CONTENT_DRAFT" } });
    expect(records.get(created.value.contentId)?.aggregateVersion).toBe(1);
    expect(records.get(created.value.contentId)?.revisions).toHaveLength(1);
  });

  it("records an explicit profile association when a Testimonial has no Project", async () => {
    const { service, records } = createHarness();
    const created = await service.createContent({
      actor: ACTOR, idempotencyKey: "profile-testimonial" as never, correlationId: "profile-testimonial",
      payload: { contentType: "testimonial", locale: "en", title: "Profile feedback", summary: "Draft.", body: "Private.", association: { type: "profile" } },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(records.get(created.value.contentId)?.revisions[0]?.payload)
      .toMatchObject({ association: { type: "profile" } });
  });

  it("returns the same creation receipt for an exact retry and rejects a different owner before ledger access", async () => {
    const { service, records } = createHarness();
    const command = {
      actor: ACTOR,
      idempotencyKey: "same-key" as never,
      correlationId: "trace-4",
      payload: { contentType: "achievement" as const, locale: "ar" as const, title: "تكريم", summary: "مسودة", body: "محتوى" },
    };
    const first = await service.createContent(command);
    const replay = await service.createContent(command);
    expect(replay).toEqual(first);
    expect(records.size).toBe(1);
    const unauthorized = await service.createContent({ ...command, actor: { kind: "visitor", consent: "denied" } });
    expect(unauthorized).toEqual({ ok: false, error: { kind: "forbidden", code: "OWNER_REQUIRED" } });
    expect(records.size).toBe(1);
  });

  it("replays an Arabic-only Project create when its candidate slug is generated", async () => {
    const { service, records } = createHarness();
    const command = {
      actor: ACTOR,
      idempotencyKey: "arabic-project-replay" as never,
      correlationId: "arabic-project-replay",
      payload: { contentType: "project" as const, locale: "ar" as const, title: "مشروع جديد", summary: "مسودة", body: "محتوى المشروع" },
    };

    const first = await service.createContent(command);
    const replay = await service.createContent(command);

    expect(first).toEqual(replay);
    expect(records.size).toBe(1);
    if (first.ok) expect(records.get(first.value.contentId)?.candidateSlug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it("requires an explicit Testimonial association and persists the selected Profile choice", async () => {
    const { service, records } = createHarness();
    const omitted = await service.createContent({
      actor: ACTOR, idempotencyKey: "testimonial-association-missing" as never, correlationId: "testimonial-association-missing",
      payload: { contentType: "testimonial", locale: "en", title: "Feedback", summary: "Draft.", body: "Stored quote." },
    });
    expect(omitted).toEqual({ ok: false, error: { kind: "validation", code: "INVALID_CONTENT_DRAFT" } });
    expect(records.size).toBe(0);

    const selected = await service.createContent({
      actor: ACTOR, idempotencyKey: "testimonial-profile-association" as never, correlationId: "testimonial-profile-association",
      payload: { contentType: "testimonial", locale: "en", title: "Feedback", summary: "Draft.", body: "Stored quote.", association: { type: "profile" } },
    });
    expect(selected.ok).toBe(true);
    if (selected.ok) expect(records.get(selected.value.contentId)?.revisions[0]?.payload).toMatchObject({ association: { type: "profile" } });
    expect(records.size).toBe(1);
  });

  it("publishes only an accepted complete Project snapshot and serves the requested locale without fallback", async () => {
    const { service, records, events } = createHarness();
    const artifactId = unsafeStableId<"SupportingArtifact">(uuid(95));
    const command = {
      actor: ACTOR, idempotencyKey: "publish-project-create" as never, correlationId: "publish-project-create",
      payload: {
        contentType: "project" as const, locale: "en" as const, title: "Atlas Search", summary: "A published summary.", body: "Public case study.",
        caseStudy: { problem: "Discovery took too long.", ownerRole: "Designed the search workflow.", contributions: ["Built the index."],
          outcomes: ["Qualitative testing found items faster."], lessons: "Index quality matters." },
        evidence: { claims: [{ claimId: unsafeStableId<"EvidenceClaim">(uuid(96)), text: "The demo shows the workflow.", artifactIds: [artifactId] }],
          artifacts: [{ id: artifactId, title: "Public demo", destinationUrl: "https://example.com/demo" }] },
        externalLinks: [
          { id: unsafeStableId<"ExternalLink">(uuid(97)), label: "English demo", destination: "https://example.com/en", isAvailableInArabic: false },
        ],
      },
    };
    const created = await service.createContent(command);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const preview = await service.previewRevision({ actor: ACTOR, contentId: created.value.contentId, revisionId: created.value.revisionId });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const reviewed = await service.reviewRevision({ actor: ACTOR, contentId: created.value.contentId, revisionId: created.value.revisionId,
      expectedVersion: 1, idempotencyKey: "publish-project-review" as never, correlationId: "publish-project-review", locale: "en",
      snapshotHash: preview.value.snapshotHash, evidenceVersion: preview.value.evidenceVersion, decision: "accepted", findings: [] });
    expect(reviewed).toMatchObject({ ok: true, value: { aggregateVersion: 2 } });
    const publish = { actor: ACTOR, contentId: created.value.contentId, expectedVersion: 2,
      idempotencyKey: "publish-project-language" as never, correlationId: "publish-project-language", locale: "en" as const, revisionId: created.value.revisionId };
    const first = await service.publishLanguageVersion(publish);
    expect(first).toMatchObject({ ok: true, value: { aggregateVersion: 3, outcome: "language-published", currentSlug: "atlas-search", locale: "en" } });
    expect(await service.publishLanguageVersion(publish)).toEqual(first);
    expect(await service.publishLanguageVersion({ ...publish, locale: "ar" })).toMatchObject({ ok: false, error: { kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" } });
    expect(await service.getPublicProject({ slug: "atlas-search", locale: "ar" })).toMatchObject({ ok: false, error: { kind: "not_found", code: "PUBLIC_CONTENT_NOT_FOUND" } });
    const publicProject = await service.getPublicProject({ slug: "atlas-search", locale: "en" });
    expect(publicProject).toMatchObject({ ok: true, value: { title: "Atlas Search", caseStudy: { problem: "Discovery took too long." },
      claims: [{ text: "The demo shows the workflow.", artifacts: [{ title: "Public demo", destinationUrl: "https://example.com/demo" }] }],
      externalLinks: [{ label: "English demo", destination: "https://example.com/en" }] } });
    expect(JSON.stringify(publicProject)).not.toMatch(/review|findings|signedUrl|providerKey/i);
    expect(records.get(created.value.contentId)).toMatchObject({ lifecycle: "published", aggregateVersion: 3,
      publications: [{ locale: "en", revisionId: created.value.revisionId }] });
    expect(events.filter((event) => (event as { payload?: { type?: string } }).payload?.type === "content.language_version_published.v1")).toHaveLength(1);
  });

  it("fails closed for unresolved Media facts and rejects reviewed placeholder evidence without public side effects", async () => {
    const { service, records, events } = createHarness();
    const artifactId = unsafeStableId<"SupportingArtifact">(uuid(98));
    const mediaId = unsafeStableId<"MediaAsset">(uuid(99));
    const created = await service.createContent({ actor: ACTOR, idempotencyKey: "publish-media-create" as never, correlationId: "publish-media-create",
      payload: { contentType: "project", locale: "en", title: "Media case", summary: "Summary.", body: "Body.",
        caseStudy: { problem: "Problem.", ownerRole: "Role.", contributions: ["Work."], outcomes: ["Qualitative outcome."], lessons: "Lesson." },
        evidence: { claims: [{ claimId: unsafeStableId<"EvidenceClaim">(uuid(90)), text: "The clip demonstrates the result.", artifactIds: [artifactId] }],
          artifacts: [{ id: artifactId, title: "Unresolved media", mediaAssetId: mediaId }] } } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const preview = await service.previewRevision({ actor: ACTOR, contentId: created.value.contentId, revisionId: created.value.revisionId });
    if (!preview.ok) return;
    await service.reviewRevision({ actor: ACTOR, contentId: created.value.contentId, revisionId: created.value.revisionId, expectedVersion: 1,
      idempotencyKey: "publish-media-review" as never, correlationId: "publish-media-review", locale: "en", snapshotHash: preview.value.snapshotHash,
      evidenceVersion: preview.value.evidenceVersion, decision: "accepted", findings: [] });
    const result = await service.publishLanguageVersion({ actor: ACTOR, contentId: created.value.contentId, expectedVersion: 2,
      idempotencyKey: "publish-media-attempt" as never, correlationId: "publish-media-attempt", locale: "en", revisionId: created.value.revisionId });
    expect(result).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable", code: "MEDIA_ACCEPTANCE_UNAVAILABLE" } });
    expect(records.get(created.value.contentId)).toMatchObject({ lifecycle: "draft", aggregateVersion: 2 });
    expect(events.filter((event) => (event as { payload?: { type?: string } }).payload?.type === "content.language_version_published.v1")).toHaveLength(0);
  });

  it.each([
    ["unknown content kind", { contentType: "bogus" }],
    ["malformed Project case study", { contentType: "project", caseStudy: "bad" }],
    ["malformed Achievement evidence", { contentType: "achievement", evidence: "bad" }],
    ["malformed evidence claim", { contentType: "achievement", evidence: { claims: [{ claimId: uuid(90), text: "Claim", artifactIds: "bad" }] } }],
    ["malformed media identity", { contentType: "project", evidence: { artifacts: [{ id: uuid(90), title: "Bad asset", mediaAssetId: "not-a-stable-id" }] } }],
    ["unsafe external link", { contentType: "project", externalLinks: [{ id: uuid(90), label: "Run this", destination: "javascript:alert(1)", isAvailableInArabic: true }] }],
    ["unknown Project payload key", { contentType: "project", executable: { run: true } }],
    ["unknown case study key", { contentType: "project", caseStudy: { problem: "Problem.", extra: "unsafe snapshot data" } }],
    ["unknown evidence claim key", { contentType: "achievement", evidence: { claims: [{ claimId: uuid(90), text: "Claim", artifactIds: [], injected: true }] } }],
    ["unknown evidence artifact key", { contentType: "achievement", evidence: { artifacts: [{ id: uuid(90), title: "Proof", command: "run" }] } }],
    ["unknown external link key", { contentType: "project", externalLinks: [{ id: uuid(90), label: "Link", destination: "https://example.com", isAvailableInArabic: true, script: "run" }] }],
    ["unknown Testimonial association key", { contentType: "testimonial", association: { type: "profile", extra: "unexpected" } }],
  ])("rejects %s at the application boundary before persistence", async (_label, typedData) => {
    const { service, records } = createHarness();
    const result = await service.createContent({
      actor: ACTOR,
      idempotencyKey: "malformed-authoring" as never,
      correlationId: "malformed-authoring",
      payload: { ...typedData, locale: "en", title: "Valid title", summary: "Valid summary", body: "Valid body" } as unknown as CreateDraftPayload,
    });

    expect(result).toEqual({ ok: false, error: { kind: "validation", code: "INVALID_CONTENT_DRAFT" } });
    expect(records.size).toBe(0);
  });
});
