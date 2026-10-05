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

const OWNER_ID = unsafeStableId<"Owner">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea1");
const PORTFOLIO_ID = unsafeStableId<"Portfolio">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea2");
const ACTOR: ActorContext = { kind: "owner", ownerId: OWNER_ID, sessionId: "session-test" };

function uuid(index: number): string {
  return `0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e${String(index).padStart(2, "0")}`;
}

function createHarness() {
  const records = new Map<string, ContentAuthoringRecord>();
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
  it.each([
    ["project", { contentType: "project", candidateSlug: "atlas-search", caseStudy: { problem: "A draft problem." } }],
    ["achievement", { contentType: "achievement", achievedOn: "2025-04-12", evidence: { claims: [{ claimId: unsafeStableId<"EvidenceClaim">(uuid(90)), text: "A draft claim.", artifactIds: [] }] } }],
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

  it("records an explicit profile association when a Testimonial has no Project", async () => {
    const { service, records } = createHarness();
    const created = await service.createContent({
      actor: ACTOR, idempotencyKey: "profile-testimonial" as never, correlationId: "profile-testimonial",
      payload: { contentType: "testimonial", locale: "en", title: "Profile feedback", summary: "Draft.", body: "Private." },
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
});
