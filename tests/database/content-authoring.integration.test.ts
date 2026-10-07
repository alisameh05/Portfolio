import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContentAuthoringService } from "../../src/modules/content-publishing/application/authoring.js";
import { createPostgresContentAuthoringRepository } from "../../src/modules/content-publishing/adapters/postgres-authoring.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPortfolioSettingsService } from "../../src/modules/portfolio-configuration/application/settings-service.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createStableId, type IdempotencyKey, type StableId } from "../../src/shared/domain/index.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";
import { sql } from "kysely";
import { resolvePostgresTransaction } from "../../src/shared/adapters/postgres/runtime.js";

const DATABASE_URL = process.env["PHASE5_CONTENT_AUTHORING_DATABASE_URL"];
if (process.env["PHASE5_REQUIRE_CONTENT_AUTHORING"] === "1" && !DATABASE_URL) {
  throw new Error("PHASE5_CONTENT_AUTHORING_DATABASE_URL_REQUIRED");
}
const describeDatabase = DATABASE_URL === undefined ? describe.skip : describe;
function quotedRole(name: string): string {
  if (!/^phase5_authoring_[a-z0-9_]+$/.test(name)) throw new Error("PHASE5_CONTENT_AUTHORING_ROLE_INVALID");
  return '"' + name + '"';
}

describeDatabase("Content authoring production PostgreSQL invariants", () => {
  let admin: Client;
  let database: ReturnType<typeof createPostgresRuntimeDatabase>;
  let loginRole: string;
  let operations: ReturnType<typeof createPostgresOperationsPersistence>;
  const repository = createPostgresContentAuthoringRepository();

  beforeAll(async () => {
    admin = new Client({ connectionString: DATABASE_URL! });
    await admin.connect();
    loginRole = "phase5_authoring_" + process.pid + "_" + randomBytes(3).toString("hex");
    const password = randomBytes(32).toString("hex");
    await admin.query("create role " + quotedRole(loginRole) + " login password '" + password +
      "' nosuperuser nocreatedb nocreaterole noreplication nobypassrls");
    await admin.query("grant shipwithali_application to " + quotedRole(loginRole));
    const url = new URL(DATABASE_URL!);
    url.username = loginRole;
    url.password = password;
    database = createPostgresRuntimeDatabase(url.toString(), { max: 8 });
    operations = createPostgresOperationsPersistence(database.database);
  }, 30_000);

  afterAll(async () => {
    if (database !== undefined) await database.resource.close();
    if (admin !== undefined) {
      let cleanupFailed = false;
      try { await admin.query("alter role " + quotedRole(loginRole) + " nologin"); } catch { cleanupFailed = true; }
      try { await admin.query("drop role if exists " + quotedRole(loginRole)); } catch { cleanupFailed = true; }
      await admin.end();
      if (cleanupFailed) throw new Error("PHASE5_CONTENT_AUTHORING_ROLE_CLEANUP_FAILED");
    }
  });

  async function configuredScope() {
    const scope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    const provisioner = createPortfolioSettingsService({
      repository: createPostgresPortfolioSettingsRepository(), transactions: database.transactions, scope,
    });
    const result = await provisioner.provision({
      profile: { displayName: "Integration Owner", headline: "Content author", bio: "Private integration fixture." },
      contactChannels: [],
      globalCta: { label: "Contact", destination: "https://example.com/contact", unavailableFallback: "Unavailable" },
    });
    expect(result.ok).toBe(true);
    return scope;
  }

  function service(
    scope: { portfolioId: StableId<"Portfolio">; ownerId: StableId<"Owner"> },
    selectedOperations = operations,
    clock?: { now(): string },
  ) {
    return createContentAuthoringService({ repository, operations: selectedOperations, scope, ...(clock === undefined ? {} : { clock }) });
  }
  const key = (value: string) => value as IdempotencyKey;
  const actor = (ownerId: StableId<"Owner">) => ({ kind: "owner" as const, ownerId, sessionId: "authoring-integration" });

  it("creates all Draft kinds, saves both locales, and keeps typed snapshots private and unreviewed", async () => {
    const scope = await configuredScope();
    const content = service(scope);
    const owner = actor(scope.ownerId);
    const projectArtifactId = createStableId("SupportingArtifact");
    const projectMediaId = createStableId("MediaAsset");
    const projectLinkId = createStableId("ExternalLink");
    const achievementArtifactId = createStableId("SupportingArtifact");
    const achievementMediaId = createStableId("MediaAsset");
    const cases = [
      {
        type: "project" as const, key: "all-project",
        payload: {
          contentType: "project" as const, locale: "en" as const, title: "Atlas Search", summary: "Search rollout.", body: "English project body.",
          caseStudy: { problem: "Discovery was slow.", outcomes: ["Found items faster."] },
          evidence: { claims: [{ claimId: createStableId("EvidenceClaim"), text: "The demo supports the rollout.", artifactIds: [projectArtifactId] }],
            artifacts: [{ id: projectArtifactId, title: "Project demo", mediaAssetId: projectMediaId, destinationUrl: "https://example.com/demo" }] },
          externalLinks: [{ id: projectLinkId, label: "Live demo", destination: "https://example.com/project", isAvailableInArabic: true }],
        },
        draftData: {
          contentType: "project" as const,
          evidence: { artifacts: [{ id: projectArtifactId, title: "Arabic project demo", mediaAssetId: projectMediaId }] },
          externalLinks: [{ id: projectLinkId, label: "النسخة التجريبية", destination: "https://example.com/project-ar", isAvailableInArabic: true }],
        },
      },
      {
        type: "achievement" as const, key: "all-achievement",
        payload: { contentType: "achievement" as const, locale: "en" as const, title: "Service milestone", summary: "Reduced errors.", body: "English achievement body.", achievedOn: "2026-09-15", evidence: {
          claims: [{ claimId: createStableId("EvidenceClaim"), text: "Error rate fell.", artifactIds: [achievementArtifactId] }],
          artifacts: [{ id: achievementArtifactId, title: "Internal evidence", mediaAssetId: achievementMediaId, destinationUrl: "https://example.com/evidence" }],
        } },
        draftData: { contentType: "achievement" as const, evidence: { artifacts: [{ id: achievementArtifactId, title: "الدليل الداخلي", mediaAssetId: achievementMediaId }] } },
      },
      {
        type: "testimonial" as const, key: "all-testimonial",
        payload: { contentType: "testimonial" as const, locale: "en" as const, title: "Customer feedback", summary: "A short statement.", body: "English testimonial body.", authorName: "Product lead", quote: "The release clarified our workflow." },
      },
    ];
    const receipts = [];
    for (const item of cases) {
      const payload = item.type === "testimonial"
        ? { ...item.payload, relatedProjectId: receipts[0]?.contentId as StableId<"Project"> }
        : item.payload;
      const created = await content.createContent({ actor: owner, idempotencyKey: key(item.key), correlationId: item.key, payload });
      expect(created.ok).toBe(true);
      if (!created.ok) continue;
      receipts.push(created.value);
      expect(created.value.aggregateVersion).toBe(1);
      const saved = await content.saveRevision({
        actor: owner, contentId: created.value.contentId, expectedVersion: 1,
        idempotencyKey: key(item.key + "-ar"), correlationId: item.key + "-ar",
        locale: "ar", title: "مسودة", summary: "ملخص أولي", body: "نص عربي أولي",
        ...(item.type === "testimonial" ? {} : { draftData: item.draftData }),
      });
      expect(saved).toMatchObject({ ok: true, value: { aggregateVersion: 2 } });
      const aggregate = await content.getOwnerContentAggregate({ actor: owner, contentId: created.value.contentId });
      expect(aggregate).toMatchObject({ ok: true, value: { lifecycle: "draft", aggregateVersion: 2 } });
    }
    expect(receipts).toHaveLength(3);
    const persisted = await admin.query(
      "select item.content_type, item.lifecycle, item.candidate_slug, item.aggregate_version, " +
      "count(revision.revision_id)::int as revisions, " +
      "jsonb_agg(jsonb_build_object('locale', revision.locale, 'reviewed', revision.reviewed, 'payload', revision.payload) order by revision.locale) as snapshots " +
      "from content.items item join content.revisions revision using (content_id, portfolio_id, content_type) " +
      "where item.portfolio_id = $1::uuid group by item.content_type, item.lifecycle, item.candidate_slug, item.aggregate_version",
      [scope.portfolioId],
    );
    expect(persisted.rows).toHaveLength(3);
    for (const row of persisted.rows) {
      expect(row.lifecycle).toBe("draft");
      expect(row.aggregate_version).toBe(2);
      expect(row.revisions).toBe(2);
      expect(row.snapshots.map((snapshot: { locale: string }) => snapshot.locale).sort()).toEqual(["ar", "en"]);
      expect(row.snapshots.every((snapshot: { reviewed: boolean }) => !snapshot.reviewed)).toBe(true);
    }
    expect(persisted.rows.find((row) => row.content_type === "project")?.candidate_slug).toBe("atlas-search");
    const projectSnapshots = persisted.rows.find((row) => row.content_type === "project")?.snapshots;
    expect(projectSnapshots?.find((snapshot: { locale: string }) => snapshot.locale === "en")?.payload)
      .toMatchObject({ evidence: { claims: [{ artifactIds: [projectArtifactId] }], artifacts: [{ mediaAssetId: projectMediaId }] }, externalLinks: [{ id: projectLinkId }] });
    expect(projectSnapshots?.find((snapshot: { locale: string }) => snapshot.locale === "ar")?.payload)
      .toMatchObject({ evidence: { artifacts: [{ mediaAssetId: projectMediaId }] }, externalLinks: [{ destination: "https://example.com/project-ar" }] });
    const achievementSnapshots = persisted.rows.find((row) => row.content_type === "achievement")?.snapshots;
    expect(achievementSnapshots?.find((snapshot: { locale: string }) => snapshot.locale === "en")?.payload.evidence)
      .toMatchObject({ claims: [{ artifactIds: [achievementArtifactId] }], artifacts: [{ mediaAssetId: achievementMediaId }] });
    expect(achievementSnapshots?.find((snapshot: { locale: string }) => snapshot.locale === "ar")?.payload.evidence.artifacts)
      .toMatchObject([{ mediaAssetId: achievementMediaId }]);
    expect(persisted.rows.find((row) => row.content_type === "testimonial")?.snapshots[1].payload.association)
      .toEqual({ type: "project", projectId: receipts[0]?.contentId });
    const events = await admin.query(
      "select event_type, count(*)::int as count from operations.outbox_events where aggregate_id = any($1::uuid[]) group by event_type",
      [receipts.map((receipt) => receipt.contentId)],
    );
    expect(Object.fromEntries(events.rows.map((row) => [row.event_type, row.count]))).toEqual({
      "content.created.v1": 3,
      "content.revision_saved.v1": 6,
    });
  }, 30_000);

  it("persists an explicitly selected profile association for a Testimonial", async () => {
    const scope = await configuredScope();
    const content = service(scope);
    const created = await content.createContent({
      actor: actor(scope.ownerId), idempotencyKey: key("explicit-profile-testimonial"), correlationId: "explicit-profile-testimonial",
      payload: { contentType: "testimonial", locale: "en", title: "Profile feedback", summary: "Draft.", body: "Stored quote.", association: { type: "profile" } },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const persisted = await admin.query(
      "select payload->'association' as association from content.revisions where content_id = $1::uuid and portfolio_id = $2::uuid",
      [created.value.contentId, scope.portfolioId],
    );
    expect(persisted.rows).toEqual([{ association: { type: "profile" } }]);
  }, 30_000);

  it("orders revision history by locale stream sequence when saved timestamps regress", async () => {
    const scope = await configuredScope();
    const timestamps = [
      "2026-10-07T00:00:00.000Z", "2026-10-07T00:00:00.000Z",
      "2026-10-03T00:00:00.000Z", "2026-10-07T00:00:00.000Z",
      "2026-10-04T00:00:00.000Z", "2026-10-07T00:00:00.000Z",
    ];
    const content = service(scope, operations, { now: () => timestamps.shift() ?? "2026-10-04T00:00:00.000Z" });
    const artifactId = createStableId("SupportingArtifact");
    const created = await content.createContent({
      actor: actor(scope.ownerId), idempotencyKey: key("revision-order-create"), correlationId: "revision-order-create",
      payload: {
        contentType: "project", locale: "en", title: "Revision order", summary: "Initial.", body: "Initial.",
        evidence: { artifacts: [{ id: artifactId, title: "First evidence" }] },
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const second = await content.saveRevision({
      actor: actor(scope.ownerId), contentId: created.value.contentId, expectedVersion: 1,
      idempotencyKey: key("revision-order-second"), correlationId: "revision-order-second",
      locale: "en", title: "Revision two", summary: "Updated.", body: "Updated.",
      draftData: { contentType: "project", evidence: { artifacts: [{ id: artifactId, title: "Latest evidence" }] } },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    const beforeThird = await content.getOwnerContentAggregate({ actor: actor(scope.ownerId), contentId: created.value.contentId });
    expect(beforeThird).toMatchObject({
      ok: true,
      value: { revisions: [{ sequence: 1 }, { sequence: 2 }] },
    });

    const third = await content.saveRevision({
      actor: actor(scope.ownerId), contentId: created.value.contentId, expectedVersion: 2,
      idempotencyKey: key("revision-order-third"), correlationId: "revision-order-third",
      locale: "en", title: "Revision three", summary: "Updated again.", body: "Updated again.",
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    const afterThird = await content.getOwnerContentAggregate({ actor: actor(scope.ownerId), contentId: created.value.contentId });
    expect(afterThird).toMatchObject({
      ok: true,
      value: { revisions: [{ sequence: 1 }, { sequence: 2 }, { sequence: 3 }] },
    });
    const latestSnapshot = await admin.query(
      "select payload from content.revisions where content_id = $1::uuid and locale = 'en' and stream_sequence = 3",
      [created.value.contentId],
    );
    expect(latestSnapshot.rows[0]?.payload).toMatchObject({
      evidence: { artifacts: [{ id: artifactId, title: "Latest evidence" }] },
    });
  }, 30_000);

  it("serializes same-key and stale-version races and preserves the original replay receipt", async () => {
    const scope = await configuredScope();
    const content = service(scope);
    const owner = actor(scope.ownerId);
    const input = {
      actor: owner, idempotencyKey: key("same-race-create"), correlationId: "same-race-create",
      payload: { contentType: "project" as const, locale: "en" as const, title: "Race", summary: "Race test.", body: "Race test body." },
    };
    const [left, right] = await Promise.all([content.createContent(input), content.createContent(input)]);
    expect(left).toEqual(right);
    expect(left.ok).toBe(true);
    if (!left.ok) return;
    expect(await content.createContent(input)).toEqual(left);
    expect(await content.createContent({ ...input, payload: { ...input.payload, title: "Changed intent" } }))
      .toMatchObject({ ok: false, error: { kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" } });
    const save = (title: string, keyValue: string) => content.saveRevision({
      actor: owner, contentId: left.value.contentId, expectedVersion: 1, idempotencyKey: key(keyValue),
      correlationId: keyValue, locale: "en", title, summary: "Concurrent update.", body: "Only one can commit.",
    });
    const results = await Promise.all([save("First writer", "save-race-a"), save("Second writer", "save-race-b")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toHaveLength(1);
    expect(await content.createContent(input)).toEqual(left);
    const aggregate = await content.getOwnerContentAggregate({ actor: owner, contentId: left.value.contentId });
    expect(aggregate).toMatchObject({ ok: true, value: { aggregateVersion: 2, revisions: [{}, {}] } });
  }, 30_000);

  it("persists immutable exact-snapshot reviews atomically and does not transfer them to later Revisions", async () => {
    const scope = await configuredScope();
    const content = service(scope);
    const owner = actor(scope.ownerId);
    const created = await content.createContent({
      actor: owner, idempotencyKey: key("review-integration-create"), correlationId: "review-integration-create",
      payload: { contentType: "achievement", locale: "en", title: "Award", summary: "Private review.", body: "Evidence is internal." },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const preview = await content.previewRevision({ actor: owner, contentId: created.value.contentId, revisionId: created.value.revisionId });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const command = {
      actor: owner, contentId: created.value.contentId, revisionId: created.value.revisionId,
      expectedVersion: 1, idempotencyKey: key("review-integration-accept"), correlationId: "review-integration-accept",
      locale: "en" as const, snapshotHash: preview.value.snapshotHash, evidenceVersion: preview.value.evidenceVersion,
      decision: "accepted" as const, findings: ["Internal evidence checked."],
    };
    const reviewed = await content.reviewRevision(command);
    expect(reviewed).toMatchObject({ ok: true, value: { aggregateVersion: 2, outcome: "revision-reviewed" } });
    expect(await content.reviewRevision(command)).toEqual(reviewed);
    expect(await content.reviewRevision({ ...command, decision: "rejected", findings: ["Different intent."] }))
      .toMatchObject({ ok: false, error: { kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" } });
    if (!reviewed.ok) return;
    const selected = await admin.query(
      "select review_id::text, content_type, locale, review_sequence, snapshot_hash, evidence_version, reviewer_id::text, decision, findings, reviewed_at " +
      "from content.revision_reviews where review_id = $1::uuid",
      [reviewed.value.reviewId],
    );
    expect(selected.rows).toMatchObject([{
      review_id: reviewed.value.reviewId,
      content_type: "achievement", locale: "en", review_sequence: 1,
      snapshot_hash: preview.value.snapshotHash, evidence_version: 1, reviewer_id: scope.ownerId,
      decision: "accepted", findings: ["Internal evidence checked."],
    }]);
    await expect(admin.query("update content.revision_reviews set decision = 'rejected' where review_id = $1::uuid", [reviewed.value.reviewId]))
      .rejects.toMatchObject({ code: "55000" });
    await expect(admin.query("delete from content.revision_reviews where review_id = $1::uuid", [reviewed.value.reviewId]))
      .rejects.toMatchObject({ code: "55000" });
    const secondReview = await content.reviewRevision({
      ...command, expectedVersion: 2, idempotencyKey: key("review-integration-reject"), correlationId: "review-integration-reject",
      decision: "rejected", findings: ["Needs more evidence."],
    });
    expect(secondReview).toMatchObject({ ok: true, value: { aggregateVersion: 3 } });
    const staleReview = await content.reviewRevision({
      ...command, expectedVersion: 2, idempotencyKey: key("review-integration-stale"), correlationId: "review-integration-stale",
      decision: "accepted", findings: ["Stale decision."],
    });
    expect(staleReview).toMatchObject({ ok: false, error: { kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion: 3 } });
    const foreignOwnerId = createStableId("Owner");
    expect(await content.previewRevision({ actor: actor(foreignOwnerId), contentId: created.value.contentId, revisionId: created.value.revisionId }))
      .toMatchObject({ ok: false, error: { kind: "forbidden", code: "OWNER_REQUIRED" } });
    expect(await content.reviewRevision({
      ...command, actor: actor(foreignOwnerId), idempotencyKey: key("review-integration-foreign"), correlationId: "review-integration-foreign",
    })).toMatchObject({ ok: false, error: { kind: "forbidden", code: "OWNER_REQUIRED" } });
    const reviewHistory = await admin.query(
      "select review_sequence, decision from content.revision_reviews where revision_id = $1::uuid order by review_sequence",
      [created.value.revisionId],
    );
    expect(reviewHistory.rows).toEqual([{ review_sequence: 1, decision: "accepted" }, { review_sequence: 2, decision: "rejected" }]);
    await database.database.transaction().execute(async (transaction) => {
      await sql`
        select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
               set_config('shipwithali.owner_id', ${foreignOwnerId}, true)
      `.execute(transaction);
      const hidden = await sql<{ review_id: string }>`
        select review_id::text from content.revision_reviews where review_id = ${reviewed.value.reviewId}::uuid
      `.execute(transaction);
      expect(hidden.rows).toHaveLength(0);
    });
    const visible = await content.previewRevision({ actor: owner, contentId: created.value.contentId, revisionId: created.value.revisionId });
    expect(visible).toMatchObject({ ok: true, value: { review: { decision: "rejected", findings: ["Needs more evidence."], snapshotHash: preview.value.snapshotHash } } });
    const outbox = await admin.query(
      "select payload from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'content.revision_reviewed.v1'",
      [created.value.contentId],
    );
    expect(outbox.rows).toHaveLength(2);
    expect(JSON.stringify(outbox.rows[0]?.payload)).not.toContain("Internal evidence checked.");

    const saved = await content.saveRevision({
      actor: owner, contentId: created.value.contentId, expectedVersion: 3,
      idempotencyKey: key("review-integration-save"), correlationId: "review-integration-save",
      locale: "en", title: "Award updated", summary: "New snapshot.", body: "New evidence is not approved.",
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(await content.previewRevision({ actor: owner, contentId: created.value.contentId, revisionId: saved.value.revisionId }))
      .toMatchObject({ ok: true, value: { evidenceVersion: 4, review: null } });
    const wrongHash = await content.reviewRevision({
      ...command, revisionId: saved.value.revisionId, expectedVersion: 4,
      idempotencyKey: key("review-integration-wrong-hash"), correlationId: "review-integration-wrong-hash",
    });
    expect(wrongHash).toMatchObject({ ok: false, error: { kind: "conflict", code: "REVISION_SNAPSHOT_MISMATCH" } });
    const grants = await admin.query(
      "select has_table_privilege('anon', 'content.revision_reviews', 'select') anon_read, " +
      "has_table_privilege('authenticated', 'content.revision_reviews', 'select') authenticated_read, " +
      "has_table_privilege('shipwithali_worker', 'content.revision_reviews', 'select') worker_read",
    );
    expect(grants.rows[0]).toEqual({ anon_read: false, authenticated_read: false, worker_read: false });
  }, 30_000);

  it("rolls back the aggregate version, review, idempotency receipt, and event when review outbox append fails", async () => {
    const scope = await configuredScope();
    const created = await service(scope).createContent({
      actor: actor(scope.ownerId), idempotencyKey: key("review-rollback-create"), correlationId: "review-rollback-create",
      payload: { contentType: "achievement", locale: "en", title: "Rollback review", summary: "Review atomically.", body: "No false review." },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const content = service(scope);
    const preview = await content.previewRevision({ actor: actor(scope.ownerId), contentId: created.value.contentId, revisionId: created.value.revisionId });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const failingOperations = {
      ...operations,
      outbox: { ...operations.outbox, async append() { throw new Error("simulated review event failure"); } },
    };
    const failingReview = createContentAuthoringService({ repository, operations: failingOperations, scope });
    await expect(failingReview.reviewRevision({
      actor: actor(scope.ownerId), contentId: created.value.contentId, revisionId: created.value.revisionId,
      expectedVersion: 1, idempotencyKey: key("review-rollback-key"), correlationId: "review-rollback-key",
      locale: "en", snapshotHash: preview.value.snapshotHash, evidenceVersion: preview.value.evidenceVersion,
      decision: "accepted", findings: ["Must roll back."],
    })).rejects.toThrow();
    const keyHash = createHash("sha256").update("review-rollback-key").digest("hex");
    const persisted = await admin.query(
      "select (select aggregate_version from content.items where content_id = $1::uuid) aggregate_version, " +
      "(select count(*)::int from content.revision_reviews where content_id = $1::uuid) reviews, " +
      "(select count(*)::int from operations.idempotency_records where key_hash = $2) receipts, " +
      "(select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'content.revision_reviewed.v1') review_events",
      [created.value.contentId, keyHash],
    );
    expect(persisted.rows[0]).toEqual({ aggregate_version: 1, reviews: 0, receipts: 0, review_events: 0 });
  }, 30_000);

  it("does not allow a Testimonial association to disclose or reference another Portfolio's Project", async () => {
    const portfolio = await configuredScope();
    const otherPortfolio = await configuredScope();
    const foreignProject = await service(otherPortfolio).createContent({
      actor: actor(otherPortfolio.ownerId), idempotencyKey: key("foreign-project-create"), correlationId: "foreign-project-create",
      payload: { contentType: "project", locale: "en", title: "Private project", summary: "Other portfolio.", body: "Must not be linked." },
    });
    expect(foreignProject.ok).toBe(true);
    if (!foreignProject.ok) return;
    const rejected = await service(portfolio).createContent({
      actor: actor(portfolio.ownerId), idempotencyKey: key("foreign-testimonial-create"), correlationId: "foreign-testimonial-create",
      payload: {
        contentType: "testimonial", locale: "en", title: "Private testimonial", summary: "Draft only.", body: "No cross-portfolio link.",
        relatedProjectId: foreignProject.value.contentId as StableId<"Project">,
      },
    });
    expect(rejected).toMatchObject({ ok: false, error: { kind: "validation", code: "RELATED_PROJECT_UNAVAILABLE" } });
    const roots = await admin.query("select count(*)::int as count from content.items where portfolio_id = $1::uuid", [portfolio.portfolioId]);
    expect(roots.rows[0].count).toBe(0);
  }, 30_000);

  it("rolls back the root, Revision, receipt, and outbox when the event append fails", async () => {
    const scope = await configuredScope();
    const generated: string[] = [];
    const ids = createSystemIdGenerator();
    const failingOperations = {
      ...operations,
      outbox: { ...operations.outbox, async append() { throw new Error("simulated outbox failure"); } },
    };
    const content = createContentAuthoringService({
      repository, operations: failingOperations, scope,
      ids: { generate(kind) { const id = ids.generate(kind); if (kind === "Content") generated.push(id); return id; } },
    });
    await expect(content.createContent({
      actor: actor(scope.ownerId), idempotencyKey: key("rollback-create"), correlationId: "rollback-create",
      payload: { contentType: "achievement", locale: "en", title: "Rollback", summary: "Rollback test.", body: "Must not persist." },
    })).rejects.toThrow();
    const keyHash = createHash("sha256").update("rollback-create").digest("hex");
    const result = await admin.query(
      "select (select count(*)::int from content.items where content_id = $1::uuid) roots, " +
      "(select count(*)::int from content.revisions where content_id = $1::uuid) revisions, " +
      "(select count(*)::int from operations.idempotency_records where key_hash = $2) receipts, " +
      "(select count(*)::int from operations.outbox_events where aggregate_id = $1) events",
      [generated[0], keyHash],
    );
    expect(result.rows[0]).toEqual({ roots: 0, revisions: 0, receipts: 0, events: 0 });
  }, 30_000);

  it("rejects overwrite, duplicate sequencing, and cross-Portfolio reparenting while denying public roles", async () => {
    const scope = await configuredScope();
    const otherScope = await configuredScope();
    const created = await service(scope).createContent({
      actor: actor(scope.ownerId), idempotencyKey: key("immutable-create"), correlationId: "immutable-create",
      payload: { contentType: "achievement", locale: "en", title: "Immutable", summary: "Snapshot.", body: "Never rewritten." },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    for (const statement of [
      "update content.revisions set title = 'rewritten' where revision_id = $1::uuid",
      "delete from content.revisions where revision_id = $1::uuid",
    ]) await expect(admin.query(statement, [created.value.revisionId])).rejects.toMatchObject({ code: "55000" });
    await expect(admin.query(
      "insert into content.revisions (revision_id, content_id, portfolio_id, content_type, locale, stream_sequence, aggregate_version, title, summary, body, payload, reviewed, saved_at) " +
      "select $1::uuid, content_id, portfolio_id, content_type, locale, stream_sequence, aggregate_version, title, summary, body, payload, false, saved_at from content.revisions where revision_id = $2::uuid",
      [createStableId("Revision"), created.value.revisionId],
    )).rejects.toMatchObject({ code: "23505" });
    await expect(admin.query(
      "insert into content.revisions (revision_id, content_id, portfolio_id, content_type, locale, stream_sequence, aggregate_version, title, summary, body, payload, reviewed, saved_at) " +
      "select $1::uuid, content_id, $2::uuid, content_type, locale, 2, aggregate_version, title, summary, body, payload, false, saved_at from content.revisions where revision_id = $3::uuid",
      [createStableId("Revision"), otherScope.portfolioId, created.value.revisionId],
    )).rejects.toMatchObject({ code: "23503" });

    const grants = await admin.query(
      "select has_table_privilege('anon', 'content.items', 'select') anon_root, " +
      "has_table_privilege('anon', 'content.revisions', 'select') anon_revision, " +
      "has_table_privilege('authenticated', 'content.items', 'select') authenticated_root, " +
      "has_table_privilege('shipwithali_worker', 'content.revisions', 'select') worker_revision, " +
      "has_table_privilege('shipwithali_backup', 'content.items', 'select') backup_root",
    );
    expect(grants.rows[0]).toEqual({ anon_root: false, anon_revision: false, authenticated_root: false, worker_revision: false, backup_root: false });
    const unscoped = await database.transactions.run((context) => sql.raw(
      "select (select count(*)::integer from content.items) roots, (select count(*)::integer from content.revisions) revisions",
    ).execute(resolvePostgresTransaction(context)));
    expect(unscoped.rows[0]).toEqual({ roots: 0, revisions: 0 });
  }, 30_000);
});
