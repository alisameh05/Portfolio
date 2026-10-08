import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContentAuthoringService } from "../../src/modules/content-publishing/application/authoring.js";
import { createPostgresContentAuthoringRepository } from "../../src/modules/content-publishing/adapters/postgres-authoring.js";
import { createPostgresProjectDiscoveryProjectionWriter } from "../../src/modules/taxonomy-discovery/adapters/index.js";
import { createPostgresTaxonomyOwnerRepository } from "../../src/modules/taxonomy-discovery/adapters/index.js";
import { createTaxonomyOwnerService } from "../../src/modules/taxonomy-discovery/application/owner-taxonomies.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPortfolioSettingsService } from "../../src/modules/portfolio-configuration/application/settings-service.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createStableId, type IdempotencyKey, type StableId } from "../../src/shared/domain/index.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";
import { sql } from "kysely";
import { resolvePostgresTransaction } from "../../src/shared/adapters/postgres/runtime.js";
import type { ProjectDraftPayload } from "../../src/modules/content-publishing/domain/index.js";
import type { ProjectTaxonomyAssignmentFactsPort } from "../../src/modules/content-publishing/application/authoring.js";

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
    mediaAcceptance?: import("../../src/modules/content-publishing/application/service.js").MediaAcceptancePort,
    taxonomyAssignments?: ProjectTaxonomyAssignmentFactsPort,
  ) {
    const discoveryProjection = createPostgresProjectDiscoveryProjectionWriter();
    return createContentAuthoringService({ repository, operations: selectedOperations, scope,
      discoveryProjection, taxonomyAssignments: taxonomyAssignments ?? discoveryProjection, ...(clock === undefined ? {} : { clock }),
      ...(mediaAcceptance === undefined ? {} : { mediaAcceptance }) });
  }
  const key = (value: string) => value as IdempotencyKey;
  const actor = (ownerId: StableId<"Owner">) => ({ kind: "owner" as const, ownerId, sessionId: "authoring-integration" });

  async function createReviewedProject(
    scope: { portfolioId: StableId<"Portfolio">; ownerId: StableId<"Owner"> },
    title: string,
    idempotencyPrefix: string,
    locale: "en" | "ar" = "en",
    options: {
      readonly slug?: string;
      readonly mediaAssetId?: StableId<"MediaAsset">;
      readonly service?: ReturnType<typeof service>;
      readonly reviewDecision?: "accepted" | "rejected";
      readonly transformPayload?: (payload: ProjectDraftPayload) => ProjectDraftPayload;
    } = {},
  ) {
    const content = options.service ?? service(scope);
    const artifactId = createStableId("SupportingArtifact");
    const basePayload: ProjectDraftPayload = {
      contentType: "project" as const, locale, title, summary: `${title} summary`, body: `${title} public body`,
      ...(options.slug === undefined ? {} : { candidateSlug: options.slug }),
      caseStudy: { problem: "A clear problem statement.", ownerRole: "Led the implementation.",
        contributions: ["Built the service."], outcomes: ["Qualitative user feedback improved."], lessons: "Measure the user workflow." },
      evidence: { claims: [{ claimId: createStableId("EvidenceClaim"), text: "The supporting demo shows this workflow.", artifactIds: [artifactId] }],
        artifacts: [{ id: artifactId, title: "Project demo", destinationUrl: "https://example.com/demo",
          ...(options.mediaAssetId === undefined ? {} : { mediaAssetId: options.mediaAssetId }) }] },
      externalLinks: [{ id: createStableId("ExternalLink"), label: locale === "en" ? "English demo" : "Arabic demo",
        destination: locale === "en" ? "https://example.com/en" : "https://example.com/ar", isAvailableInArabic: locale === "ar" }],
    };
    const payload = options.transformPayload?.(basePayload) ?? basePayload;
    const created = await content.createContent({ actor: actor(scope.ownerId), idempotencyKey: key(`${idempotencyPrefix}-create`),
      correlationId: `${idempotencyPrefix}-create`, payload });
    if (!created.ok) throw new Error(`PROJECT_CREATE_FAILED:${created.error.code}`);
    const preview = await content.previewRevision({ actor: actor(scope.ownerId), contentId: created.value.contentId, revisionId: created.value.revisionId });
    if (!preview.ok) throw new Error(`PROJECT_PREVIEW_FAILED:${preview.error.code}`);
    const reviewed = await content.reviewRevision({ actor: actor(scope.ownerId), contentId: created.value.contentId,
      revisionId: created.value.revisionId, expectedVersion: created.value.aggregateVersion, idempotencyKey: key(`${idempotencyPrefix}-review`),
      correlationId: `${idempotencyPrefix}-review`, locale, snapshotHash: preview.value.snapshotHash, evidenceVersion: preview.value.evidenceVersion,
      decision: options.reviewDecision ?? "accepted", findings: [] });
    if (!reviewed.ok) throw new Error(`PROJECT_REVIEW_FAILED:${reviewed.error.code}`);
    return { content, contentId: created.value.contentId, revisionId: created.value.revisionId,
      aggregateVersion: reviewed.value.aggregateVersion, payload };
  }

  async function createReviewedTestimonial(
    scope: { portfolioId: StableId<"Portfolio">; ownerId: StableId<"Owner"> },
    idempotencyPrefix: string,
    association: { readonly type: "profile" } | { readonly type: "project"; readonly projectId: StableId<"Project"> },
    options: { readonly authorName?: string | null; readonly quote?: string | null; readonly reviewDecision?: "accepted" | "rejected" } = {},
  ) {
    const content = service(scope);
    const payload = {
      contentType: "testimonial" as const,
      locale: "en" as const,
      title: "Stored testimonial",
      summary: "Owner reviewed quote.",
      body: "The stored quote remains the only public claim.",
      ...(options.authorName === null ? {} : { authorName: options.authorName ?? "Product lead" }),
      ...(options.quote === null ? {} : { quote: options.quote ?? "The release clarified our workflow." }),
      association,
    };
    const created = await content.createContent({ actor: actor(scope.ownerId), idempotencyKey: key(`${idempotencyPrefix}-create`),
      correlationId: `${idempotencyPrefix}-create`, payload });
    if (!created.ok) throw new Error(`TESTIMONIAL_CREATE_FAILED:${created.error.code}`);
    const preview = await content.previewRevision({ actor: actor(scope.ownerId), contentId: created.value.contentId, revisionId: created.value.revisionId });
    if (!preview.ok) throw new Error(`TESTIMONIAL_PREVIEW_FAILED:${preview.error.code}`);
    const reviewed = await content.reviewRevision({ actor: actor(scope.ownerId), contentId: created.value.contentId,
      revisionId: created.value.revisionId, expectedVersion: created.value.aggregateVersion, idempotencyKey: key(`${idempotencyPrefix}-review`),
      correlationId: `${idempotencyPrefix}-review`, locale: "en", snapshotHash: preview.value.snapshotHash,
      evidenceVersion: preview.value.evidenceVersion, decision: options.reviewDecision ?? "accepted", findings: [] });
    if (!reviewed.ok) throw new Error(`TESTIMONIAL_REVIEW_FAILED:${reviewed.error.code}`);
    return { content, contentId: created.value.contentId, revisionId: created.value.revisionId,
      aggregateVersion: reviewed.value.aggregateVersion, payload };
  }

  async function createReviewedAchievement(
    scope: { portfolioId: StableId<"Portfolio">; ownerId: StableId<"Owner"> },
    title: string,
    achievedOn: string,
    idempotencyPrefix: string,
    proof?: { artifactId: StableId<"SupportingArtifact">; destinationUrl: string },
  ) {
    const content = service(scope);
    const payload = {
      contentType: "achievement" as const, locale: "en" as const, title,
      summary: "A career milestone.", body: `Public account of ${title}.`, achievedOn,
      ...(proof === undefined ? {} : { evidence: {
        claims: [{ claimId: createStableId("EvidenceClaim"), text: `${title} is supported by its public record.`, artifactIds: [proof.artifactId] }],
        artifacts: [{ id: proof.artifactId, title: `${title} public record`, destinationUrl: proof.destinationUrl }],
      } }),
    };
    const created = await content.createContent({ actor: actor(scope.ownerId), idempotencyKey: key(`${idempotencyPrefix}-create`),
      correlationId: `${idempotencyPrefix}-create`, payload });
    if (!created.ok) throw new Error(`ACHIEVEMENT_CREATE_FAILED:${created.error.code}`);
    const preview = await content.previewRevision({ actor: actor(scope.ownerId), contentId: created.value.contentId, revisionId: created.value.revisionId });
    if (!preview.ok) throw new Error(`ACHIEVEMENT_PREVIEW_FAILED:${preview.error.code}`);
    const reviewed = await content.reviewRevision({ actor: actor(scope.ownerId), contentId: created.value.contentId,
      revisionId: created.value.revisionId, expectedVersion: 1, idempotencyKey: key(`${idempotencyPrefix}-review`),
      correlationId: `${idempotencyPrefix}-review`, locale: "en", snapshotHash: preview.value.snapshotHash,
      evidenceVersion: preview.value.evidenceVersion, decision: "accepted", findings: ["Private internal verification notes must remain owner-only."] });
    if (!reviewed.ok) throw new Error(`ACHIEVEMENT_REVIEW_FAILED:${reviewed.error.code}`);
    return { content, contentId: created.value.contentId, revisionId: created.value.revisionId, aggregateVersion: reviewed.value.aggregateVersion, payload };
  }

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
    const latest = Date.now() + 10 * 24 * 60 * 60 * 1_000;
    const timestamps = [
      latest, latest,
      latest - 4 * 24 * 60 * 60 * 1_000, latest,
      latest - 3 * 24 * 60 * 60 * 1_000, latest,
    ].map((timestamp) => new Date(timestamp).toISOString());
    const content = service(scope, operations, { now: () => timestamps.shift() ?? new Date(latest).toISOString() });
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
    await expect(admin.query(
      "insert into content.revision_reviews (review_id, content_id, portfolio_id, content_type, revision_id, locale, review_sequence, snapshot_hash, evidence_version, reviewer_id, decision, findings, reviewed_at) " +
      "values ($1::uuid, $2::uuid, $3::uuid, 'achievement', $4::uuid, 'ar', 3, $5, 1, $6::uuid, 'accepted', '[]'::jsonb, now())",
      [createStableId("ContentReview"), created.value.contentId, scope.portfolioId, created.value.revisionId, preview.value.snapshotHash, scope.ownerId],
    )).rejects.toMatchObject({ code: "23503" });
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
    const failingReview = createContentAuthoringService({ repository, operations: failingOperations, scope,
      discoveryProjection: createPostgresProjectDiscoveryProjectionWriter() });
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

  it("publishes English and Arabic independently, preserves first publication time, history, and the last valid projection", async () => {
    const scope = await configuredScope();
    const content = service(scope);
    const english = await createReviewedProject(scope, "English first project", "publication-locales", "en", { service: content });
    const firstCommand = { actor: actor(scope.ownerId), contentId: english.contentId,
      expectedVersion: english.aggregateVersion, idempotencyKey: key("publication-en-first"), correlationId: "publication-en-first",
      locale: "en" as const, revisionId: english.revisionId };
    const first = await content.publishLanguageVersion(firstCommand);
    expect(first).toMatchObject({ ok: true, value: { aggregateVersion: 3, currentSlug: "english-first-project" } });
    if (!first.ok) return;
    expect(await content.getPublicProject({ slug: "english-first-project", locale: "ar" }))
      .toMatchObject({ ok: false, error: { kind: "not_found", code: "PUBLIC_CONTENT_NOT_FOUND" } });

    const arabicDraft = await content.saveRevision({ actor: actor(scope.ownerId), contentId: english.contentId,
      expectedVersion: first.value.aggregateVersion, idempotencyKey: key("publication-ar-save"), correlationId: "publication-ar-save",
      locale: "ar", title: "مشروع البحث", summary: "ملخص عربي", body: "دراسة حالة عربية",
      draftData: { contentType: "project", caseStudy: english.payload.caseStudy, evidence: english.payload.evidence,
        externalLinks: (english.payload.externalLinks ?? []).map((link) => ({ ...link, label: "Arabic demo", destination: "https://example.com/ar", isAvailableInArabic: true })) } });
    expect(arabicDraft.ok).toBe(true);
    if (!arabicDraft.ok) return;
    const arabicPreview = await content.previewRevision({ actor: actor(scope.ownerId), contentId: english.contentId, revisionId: arabicDraft.value.revisionId });
    expect(arabicPreview.ok).toBe(true);
    if (!arabicPreview.ok) return;
    const arabicReview = await content.reviewRevision({ actor: actor(scope.ownerId), contentId: english.contentId,
      revisionId: arabicDraft.value.revisionId, expectedVersion: arabicDraft.value.aggregateVersion, idempotencyKey: key("publication-ar-review"),
      correlationId: "publication-ar-review", locale: "ar", snapshotHash: arabicPreview.value.snapshotHash,
      evidenceVersion: arabicPreview.value.evidenceVersion, decision: "accepted", findings: [] });
    expect(arabicReview.ok).toBe(true);
    if (!arabicReview.ok) return;
    const second = await content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: english.contentId,
      expectedVersion: arabicReview.value.aggregateVersion, idempotencyKey: key("publication-ar-first"), correlationId: "publication-ar-first",
      locale: "ar", revisionId: arabicDraft.value.revisionId });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.firstPublishedAt).toBe(first.value.firstPublishedAt);
    expect(await content.getPublicProject({ slug: "english-first-project", locale: "ar" }))
      .toMatchObject({ ok: true, value: { title: "مشروع البحث", externalLinks: [{ label: "Arabic demo" }] } });

    const nextEnglish = await content.saveRevision({ actor: actor(scope.ownerId), contentId: english.contentId,
      expectedVersion: second.value.aggregateVersion, idempotencyKey: key("publication-en-replacement-save"), correlationId: "publication-en-replacement-save",
      locale: "en", title: "English replacement", summary: "New summary", body: "New body",
      draftData: { contentType: "project", caseStudy: english.payload.caseStudy, evidence: english.payload.evidence, externalLinks: english.payload.externalLinks } });
    expect(nextEnglish.ok).toBe(true);
    if (!nextEnglish.ok) return;
    const beforeReplacement = await content.getPublicProject({ slug: "english-first-project", locale: "en" });
    expect(beforeReplacement).toMatchObject({ ok: true, value: { title: "English first project" } });
    const nextPreview = await content.previewRevision({ actor: actor(scope.ownerId), contentId: english.contentId, revisionId: nextEnglish.value.revisionId });
    if (!nextPreview.ok) return;
    const nextReview = await content.reviewRevision({ actor: actor(scope.ownerId), contentId: english.contentId, revisionId: nextEnglish.value.revisionId,
      expectedVersion: nextEnglish.value.aggregateVersion, idempotencyKey: key("publication-en-replacement-review"), correlationId: "publication-en-replacement-review",
      locale: "en", snapshotHash: nextPreview.value.snapshotHash, evidenceVersion: nextPreview.value.evidenceVersion, decision: "accepted", findings: [] });
    if (!nextReview.ok) return;
    const replacement = await content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: english.contentId,
      expectedVersion: nextReview.value.aggregateVersion, idempotencyKey: key("publication-en-replacement"), correlationId: "publication-en-replacement",
      locale: "en", revisionId: nextEnglish.value.revisionId });
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;
    expect(replacement.value.routeIdentity).toBe(first.value.routeIdentity);
    expect(replacement.value.firstPublishedAt).toBe(first.value.firstPublishedAt);
    expect(await content.getPublicProject({ slug: "english-first-project", locale: "en" }))
      .toMatchObject({ ok: true, value: { title: "English replacement", summary: "New summary" } });
    expect(await content.publishLanguageVersion(firstCommand)).toEqual(first);
    const history = await admin.query("select locale, count(*)::int as publications from content.publication_history where content_id = $1::uuid group by locale order by locale", [english.contentId]);
    expect(history.rows).toEqual([{ locale: "ar", publications: 1 }, { locale: "en", publications: 2 }]);
    const discovery = await admin.query(
      "select locale, title, slug, first_published_at = $2::timestamptz as shared_first_publish_time " +
      "from taxonomy.project_discovery_locales where content_id = $1::uuid order by locale",
      [english.contentId, first.value.firstPublishedAt],
    );
    expect(discovery.rows).toEqual([
      { locale: "ar", title: "مشروع البحث", slug: "english-first-project", shared_first_publish_time: true },
      { locale: "en", title: "English replacement", slug: "english-first-project", shared_first_publish_time: true },
    ]);
  }, 30_000);

  it("corrects candidate collisions and resolves A to B to C to A directly under one durable route identity", async () => {
    const scope = await configuredScope();
    const content = service(scope);
    const owner = actor(scope.ownerId);
    const first = await createReviewedProject(scope, "Durable route", "route-durable", "en", { service: content, slug: "route-a" });
    const published = await content.publishLanguageVersion({ actor: owner, contentId: first.contentId,
      expectedVersion: first.aggregateVersion, idempotencyKey: key("route-durable-publish"), correlationId: "route-durable-publish",
      locale: "en", revisionId: first.revisionId });
    expect(published.ok).toBe(true);
    if (!published.ok || published.value.routeIdentity === null || published.value.routeIdentity === undefined) return;
    const routeIdentity = published.value.routeIdentity;
    let version = published.value.aggregateVersion;
    let firstChange: Awaited<ReturnType<typeof content.changePublicSlug>> | undefined;
    for (const [index, slug] of ["route-b", "route-c", "route-a"].entries()) {
      const changed = await content.changePublicSlug({ actor: owner, projectId: first.contentId as StableId<"Project">,
        expectedVersion: version, idempotencyKey: key(`route-durable-change-${index}`), correlationId: `route-durable-change-${index}`, newSlug: slug });
      expect(changed.ok).toBe(true);
      if (!changed.ok) return;
      if (index === 0) firstChange = changed;
      version = changed.value.aggregateVersion;
      const resolution = await content.resolvePublicProjectRoute({ slug: "route-b", locale: "en" });
      if (index === 0) expect(resolution).toMatchObject({ ok: true, value: { type: "canonical", content: { currentSlug: slug, routeIdentity } } });
      else expect(resolution).toMatchObject({ ok: true, value: { type: "redirect", statusCode: 308, routeIdentity, fromSlug: "route-b", toSlug: slug, location: `/projects/${slug}` } });
    }
    if (firstChange === undefined) return;
    expect(await content.changePublicSlug({ actor: owner, projectId: first.contentId as StableId<"Project">,
      expectedVersion: first.aggregateVersion + 1, idempotencyKey: key("route-durable-change-0"), correlationId: "route-durable-change-0", newSlug: "route-b" }))
      .toEqual(firstChange);
    expect(await content.changePublicSlug({ actor: owner, projectId: first.contentId as StableId<"Project">,
      expectedVersion: first.aggregateVersion + 1, idempotencyKey: key("route-durable-change-0"), correlationId: "route-durable-change-0", newSlug: "different-intent" }))
      .toMatchObject({ ok: false, error: { kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" } });
    const aggregate = await content.getOwnerContentAggregate({ actor: owner, contentId: first.contentId });
    expect(aggregate.ok).toBe(true);
    if (!aggregate.ok) return;
    expect(aggregate.value).toMatchObject({ aggregateVersion: version, publicRoute: {
      identity: routeIdentity, canonicalSlug: "route-a", redirects: [
        { fromSlug: "route-b", toSlug: "route-a" }, { fromSlug: "route-c", toSlug: "route-a" },
      ], history: [
        { sequence: 1, fromSlug: "route-a", toSlug: "route-b" },
        { sequence: 2, fromSlug: "route-b", toSlug: "route-c" },
        { sequence: 3, fromSlug: "route-c", toSlug: "route-a" },
      ],
    }, routeHistory: [
      { sequence: 1, fromSlug: "route-a", toSlug: "route-b" },
      { sequence: 2, fromSlug: "route-b", toSlug: "route-c" },
      { sequence: 3, fromSlug: "route-c", toSlug: "route-a" },
    ] });
    expect(await content.getContentHistory({ actor: owner, contentId: first.contentId, limit: 25 }))
      .toMatchObject({ ok: true, value: { routeHistory: [
        { sequence: 1, fromSlug: "route-a", toSlug: "route-b" },
        { sequence: 2, fromSlug: "route-b", toSlug: "route-c" },
        { sequence: 3, fromSlug: "route-c", toSlug: "route-a" },
      ] } });
    expect(await content.getProjectOwnerView({ actor: owner, projectId: first.contentId as StableId<"Project"> }))
      .toMatchObject({ ok: true, value: { publicRoute: { history: [
        { sequence: 1, fromSlug: "route-a", toSlug: "route-b" },
        { sequence: 2, fromSlug: "route-b", toSlug: "route-c" },
        { sequence: 3, fromSlug: "route-c", toSlug: "route-a" },
      ] } } });

    const collision = await createReviewedProject(scope, "Candidate conflict", "route-candidate-collision", "en", { service: content, slug: "route-a" });
    const rejected = await content.publishLanguageVersion({ actor: owner, contentId: collision.contentId,
      expectedVersion: collision.aggregateVersion, idempotencyKey: key("route-candidate-collision-publish"), correlationId: "route-candidate-collision-publish",
      locale: "en", revisionId: collision.revisionId });
    expect(rejected).toMatchObject({ ok: false, error: { kind: "conflict", code: "PUBLIC_SLUG_CONFLICT" } });
    const corrected = await content.correctCandidateSlug({ actor: owner, projectId: collision.contentId as StableId<"Project">,
      expectedVersion: collision.aggregateVersion, candidateSlug: "route-candidate-fixed",
      idempotencyKey: key("route-candidate-correction"), correlationId: "route-candidate-correction" });
    expect(corrected).toMatchObject({ ok: true, value: { outcome: "candidate-slug-corrected", slug: "route-candidate-fixed" } });
    if (!corrected.ok) return;
    const correctedPublication = await content.publishLanguageVersion({ actor: owner, contentId: collision.contentId,
      expectedVersion: corrected.value.aggregateVersion, idempotencyKey: key("route-candidate-fixed-publish"), correlationId: "route-candidate-fixed-publish",
      locale: "en", revisionId: collision.revisionId });
    expect(correctedPublication).toMatchObject({ ok: true, value: { currentSlug: "route-candidate-fixed" } });

    const neverPublished = await createReviewedProject(scope, "Archived candidate", "archived-candidate-original", "en", { service: content });
    const archivedCandidate = await content.archiveContent({ actor: owner, contentId: neverPublished.contentId,
      expectedVersion: neverPublished.aggregateVersion, idempotencyKey: key("route-archived-candidate-archive"),
      correlationId: "route-archived-candidate-archive" });
    expect(archivedCandidate).toMatchObject({ ok: true, value: { outcome: "content-archived" } });
    if (!archivedCandidate.ok) return;
    const archivedCorrection = await content.correctCandidateSlug({ actor: owner, projectId: neverPublished.contentId as StableId<"Project">,
      expectedVersion: archivedCandidate.value.aggregateVersion, candidateSlug: "archived-candidate-corrected",
      idempotencyKey: key("route-archived-candidate-correct"), correlationId: "route-archived-candidate-correct" });
    expect(archivedCorrection).toMatchObject({ ok: true, value: { outcome: "candidate-slug-corrected", slug: "archived-candidate-corrected" } });
    const archivedCandidateRows = await admin.query(
      "select item.lifecycle, item.candidate_slug, (select count(*)::int from content.public_routes route where route.content_id = item.content_id) routes, " +
      "(select count(*)::int from content.public_route_reservations reservation where reservation.content_id = item.content_id) reservations " +
      "from content.items item where item.content_id = $1::uuid", [neverPublished.contentId],
    );
    expect(archivedCandidateRows.rows[0]).toEqual({ lifecycle: "archived", candidate_slug: "archived-candidate-corrected", routes: 0, reservations: 0 });
    const hijack = await content.changePublicSlug({ actor: owner, projectId: first.contentId as StableId<"Project">,
      expectedVersion: version, idempotencyKey: key("route-hijack"), correlationId: "route-hijack", newSlug: "route-candidate-fixed" });
    expect(hijack).toMatchObject({ ok: false, error: { kind: "conflict", code: "PUBLIC_SLUG_CONFLICT" } });
    expect(await content.getOwnerContentAggregate({ actor: owner, contentId: first.contentId }))
      .toMatchObject({ ok: true, value: { aggregateVersion: version, publicRoute: { canonicalSlug: "route-a" } } });

    const hiddenLocale = await content.resolvePublicProjectRoute({ slug: "route-c", locale: "ar" });
    expect(hiddenLocale).toMatchObject({ ok: false, error: { kind: "not_found", code: "PUBLIC_CONTENT_NOT_FOUND" } });
    expect(await content.changePublicSlug({ actor: owner, projectId: first.contentId as StableId<"Project">, expectedVersion: version,
      idempotencyKey: key("route-open-redirect"), correlationId: "route-open-redirect", newSlug: "https://evil.example" }))
      .toMatchObject({ ok: false, error: { kind: "validation", code: "INVALID_PUBLIC_PROJECT_SLUG" } });
    const routeRows = await admin.query("select normalized_slug, is_current from content.public_route_reservations where route_identity = $1::uuid order by normalized_slug", [routeIdentity]);
    expect(routeRows.rows).toEqual([
      { normalized_slug: "route-a", is_current: true }, { normalized_slug: "route-b", is_current: false }, { normalized_slug: "route-c", is_current: false },
    ]);
    await admin.query("update content.items set lifecycle = 'hidden', aggregate_version = aggregate_version + 1 where content_id = $1::uuid", [first.contentId]);
    expect(await content.resolvePublicProjectRoute({ slug: "route-a", locale: "en" }))
      .toMatchObject({ ok: false, error: { kind: "not_found", code: "PUBLIC_CONTENT_NOT_FOUND" } });
    expect(await content.resolvePublicProjectRoute({ slug: "route-b", locale: "en" }))
      .toMatchObject({ ok: false, error: { kind: "not_found", code: "PUBLIC_CONTENT_NOT_FOUND" } });

    const race = await createReviewedProject(scope, "Route publication race", "route-publication-race", "en", { service: content, slug: "route-race" });
    const raceEnglishPublished = await content.publishLanguageVersion({ actor: owner, contentId: race.contentId,
      expectedVersion: race.aggregateVersion, idempotencyKey: key("route-race-english-publish"), correlationId: "route-race-english-publish",
      locale: "en", revisionId: race.revisionId });
    expect(raceEnglishPublished.ok).toBe(true);
    if (!raceEnglishPublished.ok) return;
    const arabicDraft = await content.saveRevision({ actor: owner, contentId: race.contentId, expectedVersion: raceEnglishPublished.value.aggregateVersion,
      idempotencyKey: key("route-race-arabic-save"), correlationId: "route-race-arabic-save", locale: "ar",
      title: "سباق المسار", summary: "نسخة مستقلة.", body: "محتوى عربي." });
    expect(arabicDraft.ok).toBe(true);
    if (!arabicDraft.ok) return;
    const arabicPreview = await content.previewRevision({ actor: owner, contentId: race.contentId, revisionId: arabicDraft.value.revisionId });
    expect(arabicPreview.ok).toBe(true);
    if (!arabicPreview.ok) return;
    const arabicReview = await content.reviewRevision({ actor: owner, contentId: race.contentId, revisionId: arabicDraft.value.revisionId,
      expectedVersion: arabicDraft.value.aggregateVersion, idempotencyKey: key("route-race-arabic-review"), correlationId: "route-race-arabic-review",
      locale: "ar", snapshotHash: arabicPreview.value.snapshotHash, evidenceVersion: arabicPreview.value.evidenceVersion,
      decision: "accepted", findings: [] });
    expect(arabicReview.ok).toBe(true);
    if (!arabicReview.ok) return;
    const [racePublish, raceRename] = await Promise.all([
      content.publishLanguageVersion({ actor: owner, contentId: race.contentId, expectedVersion: arabicReview.value.aggregateVersion,
        idempotencyKey: key("route-race-arabic-publish"), correlationId: "route-race-arabic-publish", locale: "ar", revisionId: arabicDraft.value.revisionId }),
      content.changePublicSlug({ actor: owner, projectId: race.contentId as StableId<"Project">,
        expectedVersion: arabicReview.value.aggregateVersion, idempotencyKey: key("route-race-rename"),
        correlationId: "route-race-rename", newSlug: "route-race-renamed" }),
    ]);
    expect([racePublish.ok, raceRename.ok].filter(Boolean)).toHaveLength(1);
    const failedRace = racePublish.ok ? raceRename : racePublish;
    expect(failedRace).toMatchObject({ ok: false, error: { kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH" } });
  }, 30_000);

  it.each(["hidden", "archived"] as const)("changes retained Project routes while %s and restores matching discovery", async (lifecycle) => {
    const scope = await configuredScope();
    const content = service(scope);
    const owner = actor(scope.ownerId);
    const project = await createReviewedProject(scope, `Route ${lifecycle}`, `route-retained-${lifecycle}`, "en", { service: content, slug: `route-${lifecycle}-before` });
    const published = await content.publishLanguageVersion({ actor: owner, contentId: project.contentId,
      expectedVersion: project.aggregateVersion, idempotencyKey: key(`route-retained-${lifecycle}-publish`),
      correlationId: `route-retained-${lifecycle}-publish`, locale: "en", revisionId: project.revisionId });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const lifecycleChange = lifecycle === "hidden"
      ? await content.hideContent({ actor: owner, contentId: project.contentId, expectedVersion: published.value.aggregateVersion,
        idempotencyKey: key(`route-retained-${lifecycle}-hide`), correlationId: `route-retained-${lifecycle}-hide` })
      : await content.archiveContent({ actor: owner, contentId: project.contentId, expectedVersion: published.value.aggregateVersion,
        idempotencyKey: key(`route-retained-${lifecycle}-archive`), correlationId: `route-retained-${lifecycle}-archive` });
    expect(lifecycleChange.ok).toBe(true);
    if (!lifecycleChange.ok) return;
    const changed = await content.changePublicSlug({ actor: owner, projectId: project.contentId as StableId<"Project">,
      expectedVersion: lifecycleChange.value.aggregateVersion, idempotencyKey: key(`route-retained-${lifecycle}-rename`),
      correlationId: `route-retained-${lifecycle}-rename`, newSlug: `route-${lifecycle}-after` });
    expect(changed).toMatchObject({ ok: true, value: { outcome: "public-slug-changed", slug: `route-${lifecycle}-after` } });
    if (!changed.ok) return;
    expect(await content.resolvePublicProjectRoute({ slug: `route-${lifecycle}-before`, locale: "en" }))
      .toMatchObject({ ok: false, error: { kind: "not_found", code: "PUBLIC_CONTENT_NOT_FOUND" } });
    expect(await content.resolvePublicProjectRoute({ slug: `route-${lifecycle}-after`, locale: "en" }))
      .toMatchObject({ ok: false, error: { kind: "not_found", code: "PUBLIC_CONTENT_NOT_FOUND" } });
    const restored = await content.restoreContent({ actor: owner, contentId: project.contentId, expectedVersion: changed.value.aggregateVersion,
      idempotencyKey: key(`route-retained-${lifecycle}-restore`), correlationId: `route-retained-${lifecycle}-restore` });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(await content.resolvePublicProjectRoute({ slug: `route-${lifecycle}-after`, locale: "en" }))
      .toMatchObject({ ok: true, value: { type: "canonical", content: { currentSlug: `route-${lifecycle}-after` } } });
    expect(await content.resolvePublicProjectRoute({ slug: `route-${lifecycle}-before`, locale: "en" }))
      .toMatchObject({ ok: true, value: { type: "redirect", toSlug: `route-${lifecycle}-after` } });
    const projection = await admin.query(
      "select locale, slug from taxonomy.project_discovery_locales where content_id = $1::uuid order by locale", [project.contentId],
    );
    expect(projection.rows).toEqual([{ locale: "en", slug: `route-${lifecycle}-after` }]);
  }, 30_000);

  it("rolls back route reservations, immutable history, projections, receipt, and event when outbox append fails", async () => {
    const scope = await configuredScope();
    const content = service(scope);
    const owner = actor(scope.ownerId);
    const project = await createReviewedProject(scope, "Route rollback", "route-rollback", "en", { service: content, slug: "route-rollback-before" });
    const published = await content.publishLanguageVersion({ actor: owner, contentId: project.contentId,
      expectedVersion: project.aggregateVersion, idempotencyKey: key("route-rollback-publish"), correlationId: "route-rollback-publish",
      locale: "en", revisionId: project.revisionId });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const failingOperations = {
      ...operations,
      outbox: { ...operations.outbox, async append() { throw new Error("route outbox fault"); } },
    };
    const failingContent = service(scope, failingOperations);
    const routeChangeKeyHash = createHash("sha256").update("route-rollback-rename").digest("hex");
    await expect(failingContent.changePublicSlug({ actor: owner, projectId: project.contentId as StableId<"Project">,
      expectedVersion: published.value.aggregateVersion, idempotencyKey: key("route-rollback-rename"),
      correlationId: "route-rollback-rename", newSlug: "route-rollback-after" })).rejects.toThrow();
    const aggregate = await content.getOwnerContentAggregate({ actor: owner, contentId: project.contentId });
    expect(aggregate).toMatchObject({ ok: true, value: { aggregateVersion: published.value.aggregateVersion, publicRoute: {
      canonicalSlug: "route-rollback-before", redirects: [], history: [],
    } } });
    const persisted = await admin.query(
      "select (select count(*)::int from content.public_route_reservations where content_id = $1::uuid and normalized_slug = 'route-rollback-after') attempted_reservation, " +
      "(select count(*)::int from content.public_route_history where content_id = $1::uuid) history, " +
      "(select count(*)::int from taxonomy.project_discovery_locales where content_id = $1::uuid and slug = 'route-rollback-after') projection, " +
      "(select count(*)::int from operations.idempotency_records where key_hash = $2) receipts, " +
      "(select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'content.public_route_changed.v1') events",
      [project.contentId, routeChangeKeyHash],
    );
    expect(persisted.rows[0]).toEqual({ attempted_reservation: 0, history: 0, projection: 0, receipts: 0, events: 0 });
  }, 30_000);

  it("rolls back a route change when an eligible Discovery projection is missing", async () => {
    const scope = await configuredScope();
    const content = service(scope);
    const owner = actor(scope.ownerId);
    const project = await createReviewedProject(scope, "Missing route projection", "route-projection-missing", "en", {
      service: content, slug: "route-projection-before",
    });
    const published = await content.publishLanguageVersion({ actor: owner, contentId: project.contentId,
      expectedVersion: project.aggregateVersion, idempotencyKey: key("route-projection-publish"),
      correlationId: "route-projection-publish", locale: "en", revisionId: project.revisionId });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    await admin.query("delete from taxonomy.project_discovery_locales where content_id = $1::uuid", [project.contentId]);

    await expect(content.changePublicSlug({ actor: owner, projectId: project.contentId as StableId<"Project">,
      expectedVersion: published.value.aggregateVersion, idempotencyKey: key("route-projection-rename"),
      correlationId: "route-projection-rename", newSlug: "route-projection-after" })).rejects.toThrow();

    const keyHash = createHash("sha256").update("route-projection-rename").digest("hex");
    const state = await admin.query(
      "select (select aggregate_version from content.items where content_id = $1::uuid) aggregate_version, " +
      "(select current_slug from content.public_routes where content_id = $1::uuid) current_slug, " +
      "(select count(*)::int from content.public_route_reservations where content_id = $1::uuid and normalized_slug = 'route-projection-after') attempted_reservation, " +
      "(select count(*)::int from content.public_route_history where content_id = $1::uuid) history, " +
      "(select count(*)::int from operations.idempotency_records where key_hash = $2) receipts, " +
      "(select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'content.public_route_changed.v1') events",
      [project.contentId, keyHash],
    );
    expect(state.rows[0]).toEqual({ aggregate_version: published.value.aggregateVersion, current_slug: "route-projection-before",
      attempted_reservation: 0, history: 0, receipts: 0, events: 0 });
  }, 30_000);

  it("publishes minimal Testimonials with explicit associations, localized review, and visibility-safe projections", async () => {
    const scope = await configuredScope();
    const profile = await createReviewedTestimonial(scope, "profile-testimonial", { type: "profile" });
    const profilePublished = await profile.content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: profile.contentId,
      expectedVersion: profile.aggregateVersion, idempotencyKey: key("profile-testimonial-publish"), correlationId: "profile-testimonial-publish",
      locale: "en", revisionId: profile.revisionId });
    expect(profilePublished).toMatchObject({ ok: true, value: { aggregateVersion: 3, outcome: "language-published" } });
    if (!profilePublished.ok) return;
    expect(profilePublished.value).not.toHaveProperty("routeIdentity");
    expect(profilePublished.value).not.toHaveProperty("currentSlug");
    const profileEntries = await profile.content.getPublicTestimonials({ locale: "en", association: { type: "profile" } });
    expect(profileEntries).toMatchObject({ ok: true, value: [{ authorName: "Product lead", quote: "The release clarified our workflow.", association: { type: "profile" } }] });
    if (profileEntries.ok) {
      expect(Object.keys(profileEntries.value[0] ?? {}).sort()).toEqual(["association", "authorName", "contentId", "locale", "publishedAt", "quote", "revisionId"]);
    }
    expect(await profile.content.getPublicTestimonials({ locale: "ar", association: { type: "profile" } }))
      .toMatchObject({ ok: true, value: [] });

    const incomplete = await createReviewedTestimonial(scope, "incomplete-testimonial", { type: "profile" }, { authorName: null, quote: null });
    const incompletePublication = await incomplete.content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: incomplete.contentId,
      expectedVersion: incomplete.aggregateVersion, idempotencyKey: key("incomplete-testimonial-publish"), correlationId: "incomplete-testimonial-publish",
      locale: "en", revisionId: incomplete.revisionId });
    expect(incompletePublication).toMatchObject({ ok: false, error: { kind: "validation", code: "TESTIMONIAL_PUBLICATION_REQUIREMENTS_NOT_MET" } });
    const incompleteState = await admin.query(
      "select (select lifecycle from content.items where content_id = $1::uuid) lifecycle, " +
      "(select count(*)::int from content.testimonial_language_publications where content_id = $1::uuid) pointers, " +
      "(select count(*)::int from content.public_testimonial_locales where content_id = $1::uuid) projections",
      [incomplete.contentId],
    );
    expect(incompleteState.rows[0]).toEqual({ lifecycle: "draft", pointers: 0, projections: 0 });

    const project = await createReviewedProject(scope, "Unpublished associated project", "testimonial-associated-project");
    const associated = await createReviewedTestimonial(scope, "project-testimonial", {
      type: "project", projectId: project.contentId as StableId<"Project">,
    });
    const associatedPublished = await associated.content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: associated.contentId,
      expectedVersion: associated.aggregateVersion, idempotencyKey: key("project-testimonial-publish"), correlationId: "project-testimonial-publish",
      locale: "en", revisionId: associated.revisionId });
    expect(associatedPublished.ok).toBe(true);
    expect(await associated.content.getPublicTestimonials({ locale: "en", association: { type: "project", projectId: project.contentId as StableId<"Project"> } }))
      .toMatchObject({ ok: true, value: [] });

    const projectPublished = await project.content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: project.contentId,
      expectedVersion: project.aggregateVersion, idempotencyKey: key("testimonial-project-publish"), correlationId: "testimonial-project-publish",
      locale: "en", revisionId: project.revisionId });
    expect(projectPublished.ok).toBe(true);
    const projectEntries = await associated.content.getPublicTestimonials({ locale: "en", association: { type: "project", projectId: project.contentId as StableId<"Project"> } });
    expect(projectEntries).toMatchObject({ ok: true, value: [{ authorName: "Product lead", quote: "The release clarified our workflow.", association: { type: "project", projectId: project.contentId } }] });

    const changed = await profile.content.saveRevision({ actor: actor(scope.ownerId), contentId: profile.contentId,
      expectedVersion: profilePublished.value.aggregateVersion, idempotencyKey: key("profile-testimonial-change"), correlationId: "profile-testimonial-change",
      locale: "en", title: "Updated quote", summary: "Changed stored text.", body: "A changed private body.",
      draftData: { contentType: "testimonial", authorName: "Product lead", quote: "The updated release clarified our workflow.", association: { type: "profile" } } });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    const unreviewedReplacement = await profile.content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: profile.contentId,
      expectedVersion: changed.value.aggregateVersion, idempotencyKey: key("profile-testimonial-unreviewed-publish"),
      correlationId: "profile-testimonial-unreviewed-publish", locale: "en", revisionId: changed.value.revisionId });
    expect(unreviewedReplacement).toMatchObject({ ok: false, error: { kind: "validation", code: "ACCEPTED_REVISION_REVIEW_REQUIRED" } });
    expect(await profile.content.getPublicTestimonials({ locale: "en", association: { type: "profile" } }))
      .toMatchObject({ ok: true, value: [{ quote: "The release clarified our workflow." }] });
    const changedPreview = await profile.content.previewRevision({ actor: actor(scope.ownerId), contentId: profile.contentId, revisionId: changed.value.revisionId });
    if (!changedPreview.ok) return;
    const changedReview = await profile.content.reviewRevision({ actor: actor(scope.ownerId), contentId: profile.contentId,
      revisionId: changed.value.revisionId, expectedVersion: changed.value.aggregateVersion, idempotencyKey: key("profile-testimonial-change-review"),
      correlationId: "profile-testimonial-change-review", locale: "en", snapshotHash: changedPreview.value.snapshotHash,
      evidenceVersion: changedPreview.value.evidenceVersion, decision: "accepted", findings: [] });
    if (!changedReview.ok) return;
    const changedPublished = await profile.content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: profile.contentId,
      expectedVersion: changedReview.value.aggregateVersion, idempotencyKey: key("profile-testimonial-change-publish"),
      correlationId: "profile-testimonial-change-publish", locale: "en", revisionId: changed.value.revisionId });
    expect(changedPublished.ok).toBe(true);
    expect(await profile.content.getPublicTestimonials({ locale: "en", association: { type: "profile" } }))
      .toMatchObject({ ok: true, value: [{ quote: "The updated release clarified our workflow." }] });
    const audit = await admin.query(
      "select count(*)::int as history, (select count(*)::int from content.testimonial_language_publications where content_id = $1::uuid) as pointers, " +
      "(select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'content.testimonial_language_version_published.v1') as events " +
      "from content.testimonial_publication_history where content_id = $1::uuid and locale = 'en'",
      [profile.contentId],
    );
    expect(audit.rows[0]).toEqual({ history: 2, pointers: 1, events: 2 });
  }, 30_000);

  it("rejects invalid evidence, review, and Media facts without creating public state", async () => {
    const scope = await configuredScope();
    const rejectedMediaFacts = {
      async getAcceptanceFacts(query: { ownerId: StableId<"Owner">; mediaAssetIds: readonly StableId<"MediaAsset">[] }) {
        return { ok: true as const, value: { consistencyVersion: "media-rejected-1", facts: query.mediaAssetIds.map((mediaAssetId) => ({
          mediaAssetId, ownerId: query.ownerId, accepted: false, safe: true, suitable: true, accessible: true, version: 1,
        })) } };
      },
    };
    const cases: readonly {
      readonly name: string;
      readonly options?: Parameters<typeof createReviewedProject>[4];
      readonly expected: { readonly kind: string; readonly code: string };
    }[] = [
      {
        name: "dangling evidence reference",
        options: { transformPayload: (payload) => ({
          ...payload,
          evidence: { ...payload.evidence!, claims: payload.evidence!.claims!.map((claim) => ({
            ...claim, artifactIds: [createStableId("SupportingArtifact")],
          })) },
        }) },
        expected: { kind: "validation", code: "PROJECT_PUBLICATION_REQUIREMENTS_NOT_MET" },
      },
      {
        name: "unsupported artifact",
        options: { transformPayload: (payload) => ({
          ...payload,
          evidence: { ...payload.evidence!, artifacts: payload.evidence!.artifacts!.map(({ id, title }) => ({ id, title })) },
        }) },
        expected: { kind: "validation", code: "PROJECT_PUBLICATION_REQUIREMENTS_NOT_MET" },
      },
      {
        name: "fabricated placeholder",
        options: { transformPayload: (payload) => ({ ...payload,
          caseStudy: { ...payload.caseStudy!, problem: "TODO: add the actual project problem" } }) },
        expected: { kind: "validation", code: "PROJECT_PUBLICATION_REQUIREMENTS_NOT_MET" },
      },
      {
        name: "rejected owner review",
        options: { reviewDecision: "rejected" },
        expected: { kind: "validation", code: "ACCEPTED_REVISION_REVIEW_REQUIRED" },
      },
      {
        name: "unresolved Media facts",
        options: { mediaAssetId: createStableId("MediaAsset") },
        expected: { kind: "temporarily_unavailable", code: "MEDIA_ACCEPTANCE_UNAVAILABLE" },
      },
      {
        name: "rejected Media facts",
        options: { mediaAssetId: createStableId("MediaAsset"), service: service(scope, operations, undefined, rejectedMediaFacts) },
        expected: { kind: "validation", code: "MEDIA_ACCEPTANCE_FACTS_INVALID" },
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const prefix = `publication-rejected-case-${index}`;
      const project = await createReviewedProject(scope, `Rejected case ${index}`, prefix, "en", testCase.options);
      const result = await project.content.publishLanguageVersion({
        actor: actor(scope.ownerId), contentId: project.contentId, expectedVersion: project.aggregateVersion,
        idempotencyKey: key(`${prefix}-publish`), correlationId: `${prefix}-publish`, locale: "en", revisionId: project.revisionId,
      });

      expect(result, testCase.name).toMatchObject({ ok: false, error: testCase.expected });
      const keyHash = createHash("sha256").update(`${prefix}-publish`).digest("hex");
      const state = await admin.query(
        "select (select lifecycle from content.items where content_id = $1::uuid) lifecycle, " +
        "(select count(*)::int from content.public_routes where content_id = $1::uuid) routes, " +
        "(select count(*)::int from content.language_publications where content_id = $1::uuid) pointers, " +
        "(select count(*)::int from content.publication_history where content_id = $1::uuid) history, " +
        "(select count(*)::int from content.public_project_locales where content_id = $1::uuid) content_projection, " +
        "(select count(*)::int from taxonomy.project_discovery_locales where content_id = $1::uuid) discovery_projection, " +
        "(select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'content.language_version_published.v1') events, " +
        "(select result_envelope->'receipt' from operations.idempotency_records where key_hash = $2) receipt",
        [project.contentId, keyHash],
      );
      expect(state.rows[0], testCase.name).toEqual({
        lifecycle: "draft", routes: 0, pointers: 0, history: 0, content_projection: 0,
        discovery_projection: 0, events: 0, receipt: null,
      });
    }
  }, 30_000);

  it("publishes reviewed Achievements with internal or public evidence into a locale-specific ordered Timeline", async () => {
    const scope = await configuredScope();
    const content = service(scope);
    const internal = await createReviewedAchievement(scope, "Internal milestone", "2025-04-15", "timeline-internal");
    const publicProof = await createReviewedAchievement(scope, "Public milestone", "2025-04-15", "timeline-public", {
      artifactId: createStableId("SupportingArtifact"), destinationUrl: "https://example.com/achievement-proof",
    });
    const later = await createReviewedAchievement(scope, "Later milestone", "2026-01-02", "timeline-later");
    for (const [achievement, prefix] of [[internal, "timeline-internal"], [publicProof, "timeline-public"], [later, "timeline-later"]] as const) {
      const command = { actor: actor(scope.ownerId), contentId: achievement.contentId,
        expectedVersion: achievement.aggregateVersion, idempotencyKey: key(`${prefix}-publish`), correlationId: `${prefix}-publish`,
        locale: "en" as const, revisionId: achievement.revisionId };
      const published = await achievement.content.publishLanguageVersion(command);
      expect(published).toMatchObject({ ok: true, value: { aggregateVersion: achievement.aggregateVersion + 1, currentSlug: null, routeIdentity: null } });
      expect(await achievement.content.publishLanguageVersion(command)).toEqual(published);
      const stale = await achievement.content.publishLanguageVersion({ ...command, idempotencyKey: key(`${prefix}-stale`),
        correlationId: `${prefix}-stale` });
      expect(stale).toMatchObject({ ok: false, error: { kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH" } });
    }

    expect(await content.getPublicAchievementTimeline({ locale: "ar", limit: 10 })).toEqual({ ok: true, value: [] });
    const english = await content.getPublicAchievementTimeline({ locale: "en", limit: 10 });
    expect(english.ok).toBe(true);
    if (!english.ok) return;
    expect(english.value.map((entry) => entry.title)).toEqual(["Internal milestone", "Public milestone", "Later milestone"]);
    expect(english.value.slice(0, 2).map((entry) => entry.contentId)).toEqual([internal.contentId, publicProof.contentId].sort());
    expect(english.value[0]).toMatchObject({ achievedOn: "2025-04-15", artifacts: [] });
    expect(english.value[1]?.artifacts).toEqual([{ title: "Public milestone public record", destinationUrl: "https://example.com/achievement-proof" }]);
    expect(JSON.stringify(english.value)).not.toMatch(/Private internal verification notes|findings|reviewerId|decision|verified_internal/i);

    const saved = await content.saveRevision({ actor: actor(scope.ownerId), contentId: internal.contentId, expectedVersion: 3,
      idempotencyKey: key("timeline-internal-save"), correlationId: "timeline-internal-save", locale: "en",
      title: "Internal milestone revised", summary: "A newer draft.", body: "This newer draft must remain private." });
    expect(saved).toMatchObject({ ok: true, value: { aggregateVersion: 4 } });
    if (!saved.ok) return;
    const afterDraft = await content.getPublicAchievementTimeline({ locale: "en", limit: 10 });
    expect(afterDraft.ok).toBe(true);
    if (!afterDraft.ok) return;
    const unchanged = afterDraft.value.find((entry) => entry.contentId === internal.contentId);
    expect(unchanged).toMatchObject({ revisionId: internal.revisionId, body: "Public account of Internal milestone." });

    const preview = await content.previewRevision({ actor: actor(scope.ownerId), contentId: internal.contentId, revisionId: saved.value.revisionId });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const reviewed = await content.reviewRevision({ actor: actor(scope.ownerId), contentId: internal.contentId, revisionId: saved.value.revisionId,
      expectedVersion: saved.value.aggregateVersion, idempotencyKey: key("timeline-internal-replacement-review"),
      correlationId: "timeline-internal-replacement-review", locale: "en", snapshotHash: preview.value.snapshotHash,
      evidenceVersion: preview.value.evidenceVersion, decision: "accepted", findings: ["Private replacement review note."] });
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    const replacement = { actor: actor(scope.ownerId), contentId: internal.contentId, expectedVersion: reviewed.value.aggregateVersion,
      idempotencyKey: key("timeline-internal-replacement-publish"), correlationId: "timeline-internal-replacement-publish",
      locale: "en" as const, revisionId: saved.value.revisionId };
    const replaced = await content.publishLanguageVersion(replacement);
    expect(replaced).toMatchObject({ ok: true, value: { aggregateVersion: 6 } });
    expect(await content.publishLanguageVersion(replacement)).toEqual(replaced);
    const updatedTimeline = await content.getPublicAchievementTimeline({ locale: "en", limit: 10 });
    expect(updatedTimeline.ok).toBe(true);
    if (!updatedTimeline.ok) return;
    expect(updatedTimeline.value.find((entry) => entry.contentId === internal.contentId)).toMatchObject({
      revisionId: saved.value.revisionId, title: "Internal milestone revised", body: "This newer draft must remain private.",
    });
    const history = await admin.query(
      "select count(*)::int as count, count(route_identity)::int as routed from content.publication_history where content_id = $1::uuid and locale = 'en'",
      [internal.contentId],
    );
    expect(history.rows[0]).toEqual({ count: 2, routed: 0 });
    const project = await createReviewedProject(scope, "Timeline route invariant", "timeline-project-route");
    const projectPublication = await project.content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: project.contentId,
      expectedVersion: project.aggregateVersion, idempotencyKey: key("timeline-project-route-publish"),
      correlationId: "timeline-project-route-publish", locale: "en", revisionId: project.revisionId });
    expect(projectPublication.ok).toBe(true);
    if (!projectPublication.ok) return;
    await expect(admin.query(
      "update content.language_publications set route_identity = null where content_id = $1::uuid and locale = 'en'",
      [project.contentId],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(admin.query(
      "insert into content.publication_history (content_id, portfolio_id, content_type, locale, publication_sequence, revision_id, review_id, route_identity, published_at, media_facts_version) " +
        "select content_id, portfolio_id, content_type, locale, publication_sequence + 1, revision_id, review_id, null, published_at, media_facts_version " +
        "from content.publication_history where content_id = $1::uuid and locale = 'en' limit 1",
      [project.contentId],
    )).rejects.toMatchObject({ code: "23514" });
    const projectRoute = await admin.query(
      "select count(route_identity)::int as pointers from content.language_publications where content_id = $1::uuid",
      [project.contentId],
    );
    expect(projectRoute.rows[0]).toEqual({ pointers: 1 });
    expect(await content.getPublicAchievementTimeline({ locale: "en", limit: 101 })).toMatchObject({
      ok: false, error: { code: "INVALID_ACHIEVEMENT_TIMELINE_QUERY" },
    });
  });

  it("rejects placeholder text in every public Achievement field before publication", async () => {
    const scope = await configuredScope();
    const content = service(scope);
    const cases = [
      { field: "title", text: "TODO: verify this milestone" },
      { field: "summary", text: "Fake metric: 100% improvement" },
      { field: "body", text: "TBD pending real evidence" },
    ] as const;
    for (const [index, testCase] of cases.entries()) {
      const prefix = `achievement-placeholder-${index}`;
      const created = await content.createContent({ actor: actor(scope.ownerId), idempotencyKey: key(`${prefix}-create`),
        correlationId: `${prefix}-create`, payload: { contentType: "achievement", locale: "en",
          title: testCase.field === "title" ? testCase.text : `Milestone ${index}`,
          summary: testCase.field === "summary" ? testCase.text : "A career milestone.",
          body: testCase.field === "body" ? testCase.text : "A public account of the milestone.", achievedOn: "2025-04-15" } });
      expect(created.ok).toBe(true);
      if (!created.ok) continue;
      const publication = await content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: created.value.contentId,
        expectedVersion: 1, idempotencyKey: key(`${prefix}-publish`), correlationId: `${prefix}-publish`,
        locale: "en", revisionId: created.value.revisionId });
      expect(publication, testCase.field).toMatchObject({ ok: false, error: {
        kind: "validation", code: "ACHIEVEMENT_PUBLICATION_REQUIREMENTS_NOT_MET",
      } });
    }
  }, 30_000);

  it("preserves the last valid locale and both projections when a replacement is rejected", async () => {
    const scope = await configuredScope();
    const content = service(scope);
    const initial = await createReviewedProject(scope, "Last valid project", "publication-last-valid", "en", { service: content });
    const first = await content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: initial.contentId,
      expectedVersion: initial.aggregateVersion, idempotencyKey: key("publication-last-valid-first"),
      correlationId: "publication-last-valid-first", locale: "en", revisionId: initial.revisionId });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const priorPublic = await content.getPublicProject({ slug: "last-valid-project", locale: "en" });
    const priorDiscovery = await admin.query(
      "select revision_id::text, title, slug from taxonomy.project_discovery_locales where content_id = $1::uuid and locale = 'en'",
      [initial.contentId],
    );
    const saved = await content.saveRevision({ actor: actor(scope.ownerId), contentId: initial.contentId,
      expectedVersion: first.value.aggregateVersion, idempotencyKey: key("publication-last-valid-save"),
      correlationId: "publication-last-valid-save", locale: "en", title: "Unpublishable replacement",
      summary: "New summary candidate", body: "New body candidate",
      draftData: { contentType: "project", caseStudy: { ...initial.payload.caseStudy!, problem: "TODO: replace before publication" },
        evidence: initial.payload.evidence, externalLinks: initial.payload.externalLinks } });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const preview = await content.previewRevision({ actor: actor(scope.ownerId), contentId: initial.contentId, revisionId: saved.value.revisionId });
    if (!preview.ok) return;
    const review = await content.reviewRevision({ actor: actor(scope.ownerId), contentId: initial.contentId,
      revisionId: saved.value.revisionId, expectedVersion: saved.value.aggregateVersion,
      idempotencyKey: key("publication-last-valid-replacement-review"), correlationId: "publication-last-valid-replacement-review",
      locale: "en", snapshotHash: preview.value.snapshotHash, evidenceVersion: preview.value.evidenceVersion,
      decision: "accepted", findings: [] });
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    const rejected = await content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: initial.contentId,
      expectedVersion: review.value.aggregateVersion, idempotencyKey: key("publication-last-valid-rejected"),
      correlationId: "publication-last-valid-rejected", locale: "en", revisionId: saved.value.revisionId });
    expect(rejected).toMatchObject({ ok: false, error: { kind: "validation", code: "PROJECT_PUBLICATION_REQUIREMENTS_NOT_MET" } });
    expect(await content.getPublicProject({ slug: "last-valid-project", locale: "en" })).toEqual(priorPublic);
    const current = await admin.query(
      "select publication.revision_id::text as published_revision, projection.revision_id::text as content_revision, " +
      "discovery.revision_id::text as discovery_revision, projection.title as content_title, discovery.title as discovery_title " +
      "from content.language_publications publication " +
      "join content.public_project_locales projection using (content_id, portfolio_id, locale) " +
      "join taxonomy.project_discovery_locales discovery using (content_id, portfolio_id, locale) " +
      "where publication.content_id = $1::uuid and publication.locale = 'en'",
      [initial.contentId],
    );
    expect(current.rows).toEqual([{ published_revision: initial.revisionId, content_revision: initial.revisionId,
      discovery_revision: initial.revisionId, content_title: "Last valid project", discovery_title: "Last valid project" }]);
    expect(priorDiscovery.rows).toEqual([{ revision_id: initial.revisionId, title: "Last valid project", slug: "last-valid-project" }]);
  }, 30_000);

  it("reserves a first Project route atomically when two content items race for the same slug", async () => {
    const scope = await configuredScope();
    const content = service(scope);
    const left = await createReviewedProject(scope, "Race left", "publication-route-race-left", "en", { slug: "shared-project-route", service: content });
    const right = await createReviewedProject(scope, "Race right", "publication-route-race-right", "en", { slug: "shared-project-route", service: content });
    const publish = (project: typeof left, keySuffix: string) => content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: project.contentId,
      expectedVersion: project.aggregateVersion, idempotencyKey: key(`publication-route-race-${keySuffix}`), correlationId: `publication-route-race-${keySuffix}`,
      locale: "en", revisionId: project.revisionId });
    const results = await Promise.all([publish(left, "left"), publish(right, "right")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([{ error: { kind: "conflict", code: "PUBLIC_SLUG_CONFLICT" } }]);
    const routeCounts = await admin.query(
      "select (select count(*)::int from content.public_routes where current_slug = 'shared-project-route') routes, " +
      "(select count(*)::int from content.public_route_reservations where normalized_slug = 'shared-project-route') reservations, " +
      "(select count(*)::int from content.public_project_locales where content_id in ($1::uuid, $2::uuid)) projections, " +
      "(select count(*)::int from taxonomy.project_discovery_locales where content_id in ($1::uuid, $2::uuid)) discovery",
      [left.contentId, right.contentId],
    );
    expect(routeCounts.rows[0]).toEqual({ routes: 1, reservations: 1, projections: 1, discovery: 1 });
    const loser = results[0]?.ok ? right : left;
    const loserKey = results[0]?.ok ? "publication-route-race-right" : "publication-route-race-left";
    const loserKeyHash = createHash("sha256").update(loserKey).digest("hex");
    const loserState = await admin.query(
      "select (select count(*)::int from content.public_routes where content_id = $1::uuid) routes, " +
      "(select count(*)::int from content.public_route_reservations where content_id = $1::uuid) reservations, " +
      "(select count(*)::int from content.public_project_locales where content_id = $1::uuid) content_projection, " +
      "(select count(*)::int from taxonomy.project_discovery_locales where content_id = $1::uuid) discovery_projection, " +
      "(select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'content.language_version_published.v1') events, " +
      "(select result_envelope from operations.idempotency_records where key_hash = $2) outcome",
      [loser.contentId, loserKeyHash],
    );
    expect(loserState.rows[0]).toEqual({
      routes: 0, reservations: 0, content_projection: 0, discovery_projection: 0, events: 0,
      outcome: { status: "rejected", kind: "conflict", code: "PUBLIC_SLUG_CONFLICT" },
    });
  }, 30_000);

  it("serializes simultaneous locale publication on one aggregate and allows the other locale to publish next", async () => {
    const scope = await configuredScope();
    const content = service(scope);
    const english = await createReviewedProject(scope, "Locale race", "publication-locale-race", "en", { service: content });
    const arabicDraft = await content.saveRevision({ actor: actor(scope.ownerId), contentId: english.contentId,
      expectedVersion: english.aggregateVersion, idempotencyKey: key("publication-locale-race-ar-save"), correlationId: "publication-locale-race-ar-save",
      locale: "ar", title: "سباق اللغة", summary: "ملخص", body: "دراسة حالة",
      draftData: { contentType: "project", caseStudy: english.payload.caseStudy, evidence: english.payload.evidence,
        externalLinks: (english.payload.externalLinks ?? []).map((link) => ({ ...link, isAvailableInArabic: true })) } });
    expect(arabicDraft.ok).toBe(true);
    if (!arabicDraft.ok) return;
    const enPreview = await content.previewRevision({ actor: actor(scope.ownerId), contentId: english.contentId, revisionId: english.revisionId });
    if (!enPreview.ok) return;
    const enReview = await content.reviewRevision({ actor: actor(scope.ownerId), contentId: english.contentId, revisionId: english.revisionId,
      expectedVersion: arabicDraft.value.aggregateVersion, idempotencyKey: key("publication-locale-race-en-review"), correlationId: "publication-locale-race-en-review",
      locale: "en", snapshotHash: enPreview.value.snapshotHash, evidenceVersion: enPreview.value.evidenceVersion, decision: "accepted", findings: [] });
    if (!enReview.ok) return;
    const arPreview = await content.previewRevision({ actor: actor(scope.ownerId), contentId: english.contentId, revisionId: arabicDraft.value.revisionId });
    if (!arPreview.ok) return;
    const arReview = await content.reviewRevision({ actor: actor(scope.ownerId), contentId: english.contentId, revisionId: arabicDraft.value.revisionId,
      expectedVersion: enReview.value.aggregateVersion, idempotencyKey: key("publication-locale-race-ar-review"), correlationId: "publication-locale-race-ar-review",
      locale: "ar", snapshotHash: arPreview.value.snapshotHash, evidenceVersion: arPreview.value.evidenceVersion, decision: "accepted", findings: [] });
    if (!arReview.ok) return;
    const publish = (locale: "en" | "ar", revisionId: StableId<"Revision">, keySuffix: string) => content.publishLanguageVersion({
      actor: actor(scope.ownerId), contentId: english.contentId, expectedVersion: arReview.value.aggregateVersion,
      idempotencyKey: key(`publication-locale-race-${keySuffix}`), correlationId: `publication-locale-race-${keySuffix}`, locale, revisionId,
    });
    const attempts = await Promise.all([publish("en", english.revisionId, "en"), publish("ar", arabicDraft.value.revisionId, "ar")]);
    expect(attempts.filter((result) => result.ok)).toHaveLength(1);
    expect(attempts.filter((result) => !result.ok)).toMatchObject([{ error: { kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH" } }]);
    const winnerIndex = attempts.findIndex((result) => result.ok);
    const loserLocale = winnerIndex === 0 ? "ar" : "en";
    const loserRevision = winnerIndex === 0 ? arabicDraft.value.revisionId : english.revisionId;
    const winner = attempts[winnerIndex];
    if (!winner?.ok) return;
    const retried = await content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: english.contentId,
      expectedVersion: winner.value.aggregateVersion, idempotencyKey: key("publication-locale-race-retry"), correlationId: "publication-locale-race-retry",
      locale: loserLocale, revisionId: loserRevision });
    expect(retried.ok).toBe(true);
    if (retried.ok) expect(retried.value.firstPublishedAt).toBe(winner.value.firstPublishedAt);
    expect(await content.getPublicProject({ slug: "locale-race", locale: "en" })).toMatchObject({ ok: true });
    expect(await content.getPublicProject({ slug: "locale-race", locale: "ar" })).toMatchObject({ ok: true });
  }, 30_000);

  it("rolls back route, pointer, projection, success receipt, and event after injected writes fail", async () => {
    const scope = await configuredScope();
    const project = await createReviewedProject(scope, "Publication rollback", "publication-rollback");
    const schema = "phase5_publication_failure_probe";
    await admin.query(`create schema ${schema}`);
    try {
      await admin.query(`create table ${schema}.targets (table_name text primary key)`);
      await admin.query(`create function ${schema}.fail_write() returns trigger language plpgsql security definer set search_path = pg_catalog, ${schema} as $$ begin
        if exists (select 1 from ${schema}.targets where table_name = tg_table_name) then
          raise exception 'SIMULATED_PUBLICATION_WRITE_FAILURE';
        end if;
        return new;
      end $$`);
      for (const table of ["language_publications", "public_project_locales", "project_discovery_locales", "idempotency_records", "outbox_events"]) {
        const qualified = table === "idempotency_records" || table === "outbox_events" ? `operations.${table}`
          : table === "project_discovery_locales" ? `taxonomy.${table}` : `content.${table}`;
        const event = table === "idempotency_records" ? "before update" : "before insert or update";
        await admin.query(`create trigger fail_publication_write_${table} ${event} on ${qualified} for each row execute function ${schema}.fail_write()`);
      }
      for (const [index, table] of ["language_publications", "public_project_locales", "project_discovery_locales", "outbox_events", "idempotency_records"].entries()) {
        const keyValue = `publication-rollback-${table}`;
        await admin.query(`insert into ${schema}.targets (table_name) values ($1)`, [table]);
        await expect(service(scope).publishLanguageVersion({ actor: actor(scope.ownerId), contentId: project.contentId,
          expectedVersion: project.aggregateVersion, idempotencyKey: key(keyValue), correlationId: keyValue,
          locale: "en", revisionId: project.revisionId })).rejects.toThrow();
        await admin.query(`delete from ${schema}.targets where table_name = $1`, [table]);
        const keyHash = createHash("sha256").update(keyValue).digest("hex");
        const state = await admin.query(
          "select (select lifecycle from content.items where content_id = $1::uuid) lifecycle, " +
          "(select count(*)::int from content.public_routes where content_id = $1::uuid) routes, " +
          "(select count(*)::int from content.language_publications where content_id = $1::uuid) pointers, " +
          "(select count(*)::int from content.publication_history where content_id = $1::uuid) history, " +
          "(select count(*)::int from content.public_project_locales where content_id = $1::uuid) projections, " +
          "(select count(*)::int from taxonomy.project_discovery_locales where content_id = $1::uuid) discovery, " +
          "(select count(*)::int from operations.idempotency_records where key_hash = $2) receipts, " +
          "(select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'content.language_version_published.v1') events",
          [project.contentId, keyHash],
        );
        expect(state.rows[0], `failure injection ${index}: ${table}`).toEqual({ lifecycle: "draft", routes: 0, pointers: 0, history: 0, projections: 0, discovery: 0, receipts: 0, events: 0 });
      }
    } finally {
      await admin.query(`drop schema if exists ${schema} cascade`);
    }
  }, 30_000);

  it("uses fixture-only accepted Media facts and fails closed when production facts are unresolved", async () => {
    const scope = await configuredScope();
    const mediaId = createStableId("MediaAsset");
    const fixturePort = { async getAcceptanceFacts(query: { ownerId: StableId<"Owner">; mediaAssetIds: readonly StableId<"MediaAsset">[] }) {
      return { ok: true as const, value: { consistencyVersion: "media-snapshot-17", facts: query.mediaAssetIds.map((mediaAssetId) => ({
        mediaAssetId, ownerId: query.ownerId, accepted: true, safe: true, suitable: true, accessible: true, version: 17,
      })) } };
    } };
    const fixtureService = service(scope, operations, undefined, fixturePort);
    const project = await createReviewedProject(scope, "Media fixture", "publication-media-fixture", "en", { mediaAssetId: mediaId, service: fixtureService });
    const published = await fixtureService.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: project.contentId,
      expectedVersion: project.aggregateVersion, idempotencyKey: key("publication-media-fixture-publish"), correlationId: "publication-media-fixture-publish",
      locale: "en", revisionId: project.revisionId });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const persistedFacts = await admin.query("select media_facts_version from content.publication_history where content_id = $1::uuid", [project.contentId]);
    expect(persistedFacts.rows).toEqual([{ media_facts_version: "media-snapshot-17" }]);
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
      repository, operations: failingOperations, scope, discoveryProjection: createPostgresProjectDiscoveryProjectionWriter(),
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

  it("hides, archives, and restores all three content kinds through atomic owner lifecycle commands", async () => {
    const scope = await configuredScope();
    const owner = actor(scope.ownerId);

    const project = await createReviewedProject(scope, "Lifecycle Project", "lifecycle-project");
    const projectPublished = await project.content.publishLanguageVersion({ actor: owner, contentId: project.contentId,
      expectedVersion: project.aggregateVersion, idempotencyKey: key("lifecycle-project-publish"), correlationId: "lifecycle-project-publish",
      locale: "en", revisionId: project.revisionId });
    expect(projectPublished.ok).toBe(true);
    if (!projectPublished.ok) return;
    const originalFirstPublishedAt = projectPublished.value.firstPublishedAt;
    expect(await project.content.getPublicProject({ slug: "lifecycle-project", locale: "en" })).toMatchObject({ ok: true });
    const projectHidden = await project.content.hideContent({ actor: owner, contentId: project.contentId,
      expectedVersion: projectPublished.value.aggregateVersion, idempotencyKey: key("lifecycle-project-hide"), correlationId: "lifecycle-project-hide",
      reason: "Temporarily withdrawn for review." });
    expect(projectHidden).toMatchObject({ ok: true, value: { aggregateVersion: 4, outcome: "content-hidden" } });
    expect(await project.content.getPublicProject({ slug: "lifecycle-project", locale: "en" }))
      .toMatchObject({ ok: false, error: { kind: "not_found", code: "PUBLIC_CONTENT_NOT_FOUND" } });
    const projectArchived = await project.content.archiveContent({ actor: owner, contentId: project.contentId,
      expectedVersion: 4, idempotencyKey: key("lifecycle-project-archive"), correlationId: "lifecycle-project-archive" });
    expect(projectArchived).toMatchObject({ ok: true, value: { aggregateVersion: 5, outcome: "content-archived" } });
    const projectRestored = await project.content.restoreContent({ actor: owner, contentId: project.contentId,
      expectedVersion: 5, idempotencyKey: key("lifecycle-project-restore"), correlationId: "lifecycle-project-restore" });
    expect(projectRestored).toMatchObject({ ok: true, value: { aggregateVersion: 6, outcome: "content-restored" } });
    const projectAfterRestore = await project.content.getPublicProject({ slug: "lifecycle-project", locale: "en" });
    expect(projectAfterRestore).toMatchObject({ ok: true, value: { title: "Lifecycle Project", firstPublishedAt: originalFirstPublishedAt } });
    const projectHistory = await admin.query(
      "select previous_lifecycle, lifecycle, aggregate_version, reason from content.lifecycle_history where content_id = $1::uuid order by transition_sequence",
      [project.contentId],
    );
    expect(projectHistory.rows).toEqual([
      { previous_lifecycle: "draft", lifecycle: "published", aggregate_version: 3, reason: null },
      { previous_lifecycle: "published", lifecycle: "hidden", aggregate_version: 4, reason: "Temporarily withdrawn for review." },
      { previous_lifecycle: "hidden", lifecycle: "archived", aggregate_version: 5, reason: null },
      { previous_lifecycle: "archived", lifecycle: "published", aggregate_version: 6, reason: null },
    ]);
    const retainedProjectRows = await admin.query(
      "select (select count(*)::int from content.publication_history where content_id = $1::uuid) publications, " +
      "(select count(*)::int from content.public_routes where content_id = $1::uuid) routes, " +
      "(select count(*)::int from content.public_route_reservations where content_id = $1::uuid) reservations, " +
      "(select count(*)::int from taxonomy.project_discovery_locales where content_id = $1::uuid) discovery",
      [project.contentId],
    );
    expect(retainedProjectRows.rows[0]).toEqual({ publications: 1, routes: 1, reservations: 1, discovery: 1 });

    const achievement = await createReviewedAchievement(scope, "Lifecycle Achievement", "2026-10-01", "lifecycle-achievement");
    const achievementPublished = await achievement.content.publishLanguageVersion({ actor: owner, contentId: achievement.contentId,
      expectedVersion: achievement.aggregateVersion, idempotencyKey: key("lifecycle-achievement-publish"), correlationId: "lifecycle-achievement-publish",
      locale: "en", revisionId: achievement.revisionId });
    expect(achievementPublished.ok).toBe(true);
    if (!achievementPublished.ok) return;
    expect(await achievement.content.getPublicAchievementTimeline({ locale: "en", limit: 10 }))
      .toMatchObject({ ok: true, value: expect.arrayContaining([expect.objectContaining({ contentId: achievement.contentId })]) });
    const achievementHidden = await achievement.content.hideContent({ actor: owner, contentId: achievement.contentId,
      expectedVersion: achievementPublished.value.aggregateVersion, idempotencyKey: key("lifecycle-achievement-hide"), correlationId: "lifecycle-achievement-hide" });
    expect(achievementHidden.ok).toBe(true);
    const hiddenTimeline = await achievement.content.getPublicAchievementTimeline({ locale: "en", limit: 10 });
    expect(hiddenTimeline.ok && hiddenTimeline.value.some((entry) => entry.contentId === achievement.contentId)).toBe(false);
    const achievementRestored = await achievement.content.restoreContent({ actor: owner, contentId: achievement.contentId,
      expectedVersion: achievementHidden.ok ? achievementHidden.value.aggregateVersion : 0,
      idempotencyKey: key("lifecycle-achievement-restore"), correlationId: "lifecycle-achievement-restore" });
    expect(achievementRestored.ok).toBe(true);
    expect(await achievement.content.getPublicAchievementTimeline({ locale: "en", limit: 10 }))
      .toMatchObject({ ok: true, value: expect.arrayContaining([expect.objectContaining({ contentId: achievement.contentId })]) });

    const testimonial = await createReviewedTestimonial(scope, "lifecycle-testimonial", { type: "profile" });
    const testimonialPublished = await testimonial.content.publishLanguageVersion({ actor: owner, contentId: testimonial.contentId,
      expectedVersion: testimonial.aggregateVersion, idempotencyKey: key("lifecycle-testimonial-publish"), correlationId: "lifecycle-testimonial-publish",
      locale: "en", revisionId: testimonial.revisionId });
    expect(testimonialPublished.ok).toBe(true);
    if (!testimonialPublished.ok) return;
    expect(await testimonial.content.getPublicTestimonials({ locale: "en", association: { type: "profile" } }))
      .toMatchObject({ ok: true, value: expect.arrayContaining([expect.objectContaining({ contentId: testimonial.contentId })]) });
    const testimonialHidden = await testimonial.content.hideContent({ actor: owner, contentId: testimonial.contentId,
      expectedVersion: testimonialPublished.value.aggregateVersion, idempotencyKey: key("lifecycle-testimonial-hide"), correlationId: "lifecycle-testimonial-hide" });
    expect(testimonialHidden.ok).toBe(true);
    const hiddenTestimonials = await testimonial.content.getPublicTestimonials({ locale: "en", association: { type: "profile" } });
    expect(hiddenTestimonials.ok && hiddenTestimonials.value.some((entry) => entry.contentId === testimonial.contentId)).toBe(false);
    const testimonialArchived = await testimonial.content.archiveContent({ actor: owner, contentId: testimonial.contentId,
      expectedVersion: testimonialHidden.ok ? testimonialHidden.value.aggregateVersion : 0,
      idempotencyKey: key("lifecycle-testimonial-archive"), correlationId: "lifecycle-testimonial-archive" });
    expect(testimonialArchived.ok).toBe(true);
    const testimonialRestored = await testimonial.content.restoreContent({ actor: owner, contentId: testimonial.contentId,
      expectedVersion: testimonialArchived.ok ? testimonialArchived.value.aggregateVersion : 0,
      idempotencyKey: key("lifecycle-testimonial-restore"), correlationId: "lifecycle-testimonial-restore" });
    expect(testimonialRestored.ok).toBe(true);
    expect(await testimonial.content.getPublicTestimonials({ locale: "en", association: { type: "profile" } }))
      .toMatchObject({ ok: true, value: expect.arrayContaining([expect.objectContaining({ contentId: testimonial.contentId })]) });

    const lifecycleEvents = await admin.query(
      "select event_type, count(*)::int as count from operations.outbox_events where aggregate_id = any($1::uuid[]) " +
      "and event_type in ('content.content_hidden.v1', 'content.content_archived.v1', 'content.content_restored.v1') group by event_type",
      [[project.contentId, achievement.contentId, testimonial.contentId]],
    );
    expect(Object.fromEntries(lifecycleEvents.rows.map((row) => [row.event_type, row.count]))).toEqual({
      "content.content_archived.v1": 2,
      "content.content_hidden.v1": 3,
      "content.content_restored.v1": 3,
    });
  }, 60_000);

  it("revalidates each exact locale publication before restore and changes none when one Media fact fails", async () => {
    const scope = await configuredScope();
    let invalidLocale: "en" | "ar" | null = null;
    const mediaId = createStableId("MediaAsset");
    const mediaAcceptance = {
      async getAcceptanceFacts(query: { readonly ownerId: StableId<"Owner">; readonly mediaAssetIds: readonly StableId<"MediaAsset">[]; readonly locale: "en" | "ar" }) {
        return { ok: true as const, value: {
          consistencyVersion: `media-${query.locale}-v1`,
          facts: query.mediaAssetIds.map((mediaAssetId) => ({ mediaAssetId, ownerId: query.ownerId,
            accepted: query.locale !== invalidLocale, safe: true, suitable: true, accessible: true, version: 1 })),
        } };
      },
    };
    const content = service(scope, operations, undefined, mediaAcceptance);
    const project = await createReviewedProject(scope, "Bilingual Lifecycle", "bilingual-lifecycle", "en", {
      service: content, mediaAssetId: mediaId,
    });
    const englishPublished = await content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: project.contentId,
      expectedVersion: project.aggregateVersion, idempotencyKey: key("bilingual-lifecycle-en-publish"), correlationId: "bilingual-lifecycle-en-publish",
      locale: "en", revisionId: project.revisionId });
    expect(englishPublished.ok).toBe(true);
    if (!englishPublished.ok) return;
    const arabicDraft = await content.saveRevision({ actor: actor(scope.ownerId), contentId: project.contentId,
      expectedVersion: englishPublished.value.aggregateVersion, idempotencyKey: key("bilingual-lifecycle-ar-save"), correlationId: "bilingual-lifecycle-ar-save",
      locale: "ar", title: "مشروع ثنائي اللغة", summary: "ملخص عربي", body: "دراسة الحالة العربية",
      draftData: { contentType: "project", caseStudy: project.payload.caseStudy, evidence: project.payload.evidence } });
    expect(arabicDraft.ok).toBe(true);
    if (!arabicDraft.ok) return;
    const arabicPreview = await content.previewRevision({ actor: actor(scope.ownerId), contentId: project.contentId, revisionId: arabicDraft.value.revisionId });
    expect(arabicPreview.ok).toBe(true);
    if (!arabicPreview.ok) return;
    const arabicReview = await content.reviewRevision({ actor: actor(scope.ownerId), contentId: project.contentId,
      revisionId: arabicDraft.value.revisionId, expectedVersion: arabicDraft.value.aggregateVersion,
      idempotencyKey: key("bilingual-lifecycle-ar-review"), correlationId: "bilingual-lifecycle-ar-review", locale: "ar",
      snapshotHash: arabicPreview.value.snapshotHash, evidenceVersion: arabicPreview.value.evidenceVersion, decision: "accepted", findings: [] });
    expect(arabicReview.ok).toBe(true);
    if (!arabicReview.ok) return;
    const arabicPublished = await content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: project.contentId,
      expectedVersion: arabicReview.value.aggregateVersion, idempotencyKey: key("bilingual-lifecycle-ar-publish"), correlationId: "bilingual-lifecycle-ar-publish",
      locale: "ar", revisionId: arabicDraft.value.revisionId });
    expect(arabicPublished.ok).toBe(true);
    if (!arabicPublished.ok) return;

    const originalEnglishPreview = await content.previewRevision({ actor: actor(scope.ownerId), contentId: project.contentId, revisionId: project.revisionId });
    expect(originalEnglishPreview.ok).toBe(true);
    if (!originalEnglishPreview.ok) return;
    const newerRejectedReview = await content.reviewRevision({ actor: actor(scope.ownerId), contentId: project.contentId,
      revisionId: project.revisionId, expectedVersion: arabicPublished.value.aggregateVersion,
      idempotencyKey: key("bilingual-lifecycle-en-re-review"), correlationId: "bilingual-lifecycle-en-re-review", locale: "en",
      snapshotHash: originalEnglishPreview.value.snapshotHash, evidenceVersion: originalEnglishPreview.value.evidenceVersion,
      decision: "rejected", findings: ["Recheck before the next publication."] });
    expect(newerRejectedReview.ok).toBe(true);
    if (!newerRejectedReview.ok) return;
    const newerDraft = await content.saveRevision({ actor: actor(scope.ownerId), contentId: project.contentId,
      expectedVersion: newerRejectedReview.value.aggregateVersion, idempotencyKey: key("bilingual-lifecycle-en-latest-draft"),
      correlationId: "bilingual-lifecycle-en-latest-draft", locale: "en", title: "Later unpublished edit",
      summary: "Not selected for restore.", body: "Restore must keep the accepted pointer.",
      draftData: { contentType: "project", caseStudy: project.payload.caseStudy, evidence: project.payload.evidence } });
    expect(newerDraft.ok).toBe(true);
    if (!newerDraft.ok) return;
    const hidden = await content.hideContent({ actor: actor(scope.ownerId), contentId: project.contentId,
      expectedVersion: newerDraft.value.aggregateVersion, idempotencyKey: key("bilingual-lifecycle-hide"), correlationId: "bilingual-lifecycle-hide" });
    expect(hidden.ok).toBe(true);
    if (!hidden.ok) return;

    const unavailableMediaRestore = await service(scope).restoreContent({ actor: actor(scope.ownerId), contentId: project.contentId,
      expectedVersion: hidden.value.aggregateVersion, idempotencyKey: key("bilingual-lifecycle-restore-unavailable"),
      correlationId: "bilingual-lifecycle-restore-unavailable" });
    expect(unavailableMediaRestore).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable", code: "MEDIA_ACCEPTANCE_UNAVAILABLE" } });
    expect(await content.getOwnerContentAggregate({ actor: actor(scope.ownerId), contentId: project.contentId }))
      .toMatchObject({ ok: true, value: { lifecycle: "hidden", aggregateVersion: hidden.value.aggregateVersion } });

    invalidLocale = "en";
    const rejectedRestore = await content.restoreContent({ actor: actor(scope.ownerId), contentId: project.contentId,
      expectedVersion: hidden.value.aggregateVersion, idempotencyKey: key("bilingual-lifecycle-restore-rejected"),
      correlationId: "bilingual-lifecycle-restore-rejected" });
    expect(rejectedRestore).toMatchObject({ ok: false, error: { kind: "validation", code: "MEDIA_ACCEPTANCE_FACTS_INVALID" } });
    const afterRejectedRestore = await content.getOwnerContentAggregate({ actor: actor(scope.ownerId), contentId: project.contentId });
    expect(afterRejectedRestore).toMatchObject({ ok: true, value: { lifecycle: "hidden", aggregateVersion: hidden.value.aggregateVersion } });
    expect(await content.getPublicProject({ slug: "bilingual-lifecycle", locale: "en" }))
      .toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(await content.getPublicProject({ slug: "bilingual-lifecycle", locale: "ar" }))
      .toMatchObject({ ok: false, error: { kind: "not_found" } });
    const pointerRows = await admin.query("select locale, revision_id::text from content.language_publications where content_id = $1::uuid order by locale", [project.contentId]);
    expect(pointerRows.rows).toEqual([
      { locale: "ar", revision_id: arabicDraft.value.revisionId },
      { locale: "en", revision_id: project.revisionId },
    ]);

    invalidLocale = null;
    const restored = await content.restoreContent({ actor: actor(scope.ownerId), contentId: project.contentId,
      expectedVersion: hidden.value.aggregateVersion, idempotencyKey: key("bilingual-lifecycle-restore-valid"),
      correlationId: "bilingual-lifecycle-restore-valid" });
    expect(restored.ok).toBe(true);
    expect(await content.getPublicProject({ slug: "bilingual-lifecycle", locale: "en" }))
      .toMatchObject({ ok: true, value: { title: "Bilingual Lifecycle" } });
    expect(await content.getPublicProject({ slug: "bilingual-lifecycle", locale: "ar" }))
      .toMatchObject({ ok: true, value: { title: "مشروع ثنائي اللغة" } });
    const aggregate = await content.getOwnerContentAggregate({ actor: actor(scope.ownerId), contentId: project.contentId });
    expect(aggregate).toMatchObject({ ok: true, value: { lifecycle: "published", localizedStreams: {
      en: { currentPublishedRevisionId: project.revisionId }, ar: { currentPublishedRevisionId: arabicDraft.value.revisionId },
    } } });
  }, 60_000);

  it("rejects restore of never-published Archived content but allows explicit first publication and safe retries", async () => {
    const scope = await configuredScope();
    const project = await createReviewedProject(scope, "Explicit First Publication", "explicit-first-publication");
    const owner = actor(scope.ownerId);
    const archived = await project.content.archiveContent({ actor: owner, contentId: project.contentId,
      expectedVersion: project.aggregateVersion, idempotencyKey: key("explicit-first-archive"), correlationId: "explicit-first-archive" });
    expect(archived).toMatchObject({ ok: true, value: { aggregateVersion: 3, outcome: "content-archived" } });
    if (!archived.ok) return;
    const restoreNeverPublished = await project.content.restoreContent({ actor: owner, contentId: project.contentId,
      expectedVersion: archived.value.aggregateVersion, idempotencyKey: key("explicit-first-restore-rejected"), correlationId: "explicit-first-restore-rejected" });
    expect(restoreNeverPublished).toMatchObject({ ok: false, error: { kind: "validation", code: "CONTENT_NOT_PREVIOUSLY_PUBLISHED" } });
    const firstPublish = await project.content.publishLanguageVersion({ actor: owner, contentId: project.contentId,
      expectedVersion: archived.value.aggregateVersion, idempotencyKey: key("explicit-first-publish"), correlationId: "explicit-first-publish",
      locale: "en", revisionId: project.revisionId });
    expect(firstPublish).toMatchObject({ ok: true, value: { aggregateVersion: 4, currentSlug: "explicit-first-publication" } });
    if (!firstPublish.ok) return;
    const hiddenCommand = { actor: owner, contentId: project.contentId, expectedVersion: firstPublish.value.aggregateVersion,
      idempotencyKey: key("lifecycle-replay-hide"), correlationId: "lifecycle-replay-hide" };
    const hidden = await project.content.hideContent(hiddenCommand);
    expect(hidden).toMatchObject({ ok: true, value: { aggregateVersion: 5, outcome: "content-hidden" } });
    if (!hidden.ok) return;
    const archivedAgain = await project.content.archiveContent({ actor: owner, contentId: project.contentId,
      expectedVersion: hidden.value.aggregateVersion, idempotencyKey: key("lifecycle-replay-archive"), correlationId: "lifecycle-replay-archive" });
    expect(archivedAgain).toMatchObject({ ok: true, value: { aggregateVersion: 6 } });
    if (!archivedAgain.ok) return;
    expect(await project.content.hideContent({ ...hiddenCommand, correlationId: "lifecycle-replay-hide-retry" })).toEqual(hidden);
    const beforeNoop = await admin.query("select count(*)::int as count from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'content.content_archived.v1'", [project.contentId]);
    const archivedNoop = await project.content.archiveContent({ actor: owner, contentId: project.contentId,
      expectedVersion: archivedAgain.value.aggregateVersion, idempotencyKey: key("lifecycle-archive-noop"), correlationId: "lifecycle-archive-noop" });
    expect(archivedNoop).toMatchObject({ ok: true, value: { aggregateVersion: archivedAgain.value.aggregateVersion, outcome: "content-archived" } });
    const afterNoop = await admin.query("select count(*)::int as count from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'content.content_archived.v1'", [project.contentId]);
    expect(afterNoop.rows[0].count).toBe(beforeNoop.rows[0].count);
    const hideArchived = await project.content.hideContent({ actor: owner, contentId: project.contentId,
      expectedVersion: archivedAgain.value.aggregateVersion, idempotencyKey: key("lifecycle-invalid-hide-archived"), correlationId: "lifecycle-invalid-hide-archived" });
    expect(hideArchived).toMatchObject({ ok: false, error: { kind: "validation", code: "CONTENT_LIFECYCLE_TRANSITION_NOT_ALLOWED" } });
    const restored = await project.content.restoreContent({ actor: owner, contentId: project.contentId,
      expectedVersion: archivedAgain.value.aggregateVersion, idempotencyKey: key("lifecycle-replay-restore"), correlationId: "lifecycle-replay-restore" });
    expect(restored).toMatchObject({ ok: true, value: { aggregateVersion: 7, outcome: "content-restored" } });
    const afterRestoreArchive = await project.content.archiveContent({ actor: owner, contentId: project.contentId,
      expectedVersion: restored.ok ? restored.value.aggregateVersion : 0, idempotencyKey: key("lifecycle-replay-archive-again"), correlationId: "lifecycle-replay-archive-again" });
    expect(afterRestoreArchive.ok).toBe(true);
    expect(await project.content.restoreContent({ actor: owner, contentId: project.contentId,
      expectedVersion: archivedAgain.value.aggregateVersion, idempotencyKey: key("lifecycle-replay-restore"), correlationId: "lifecycle-replay-restore-retry" })).toEqual(restored);
  }, 60_000);

  it("rolls back lifecycle state, history, and the receipt when the lifecycle outbox append fails", async () => {
    const scope = await configuredScope();
    const project = await createReviewedProject(scope, "Lifecycle Rollback", "lifecycle-rollback");
    const published = await project.content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: project.contentId,
      expectedVersion: project.aggregateVersion, idempotencyKey: key("lifecycle-rollback-publish"), correlationId: "lifecycle-rollback-publish",
      locale: "en", revisionId: project.revisionId });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const failingOutbox = {
      ...operations.outbox,
      async append(...args: Parameters<typeof operations.outbox.append>) {
        const [, input] = args;
        if (input.payload.type === "content.content_hidden.v1") throw new Error("simulated lifecycle outbox failure");
        return await operations.outbox.append(...args);
      },
    };
    const failingOperations = { ...operations, outbox: failingOutbox };
    const failingService = service(scope, failingOperations);
    await expect(failingService.hideContent({ actor: actor(scope.ownerId), contentId: project.contentId,
      expectedVersion: published.value.aggregateVersion, idempotencyKey: key("lifecycle-rollback-hide"), correlationId: "lifecycle-rollback-hide" })).rejects.toThrow();
    const root = await admin.query("select lifecycle, aggregate_version from content.items where content_id = $1::uuid", [project.contentId]);
    expect(root.rows[0]).toEqual({ lifecycle: "published", aggregate_version: published.value.aggregateVersion });
    const hash = createHash("sha256").update("lifecycle-rollback-hide").digest("hex");
    const savedReceipt = await admin.query("select count(*)::int as count from operations.idempotency_records where key_hash = $1", [hash]);
    expect(savedReceipt.rows[0].count).toBe(0);
    const history = await admin.query("select count(*)::int as count from content.lifecycle_history where content_id = $1::uuid and lifecycle = 'hidden'", [project.contentId]);
    const events = await admin.query("select count(*)::int as count from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'content.content_hidden.v1'", [project.contentId]);
    expect(history.rows[0].count).toBe(0);
    expect(events.rows[0].count).toBe(0);
  }, 60_000);

  it("rejects overwrite, duplicate sequencing, and cross-Portfolio reparenting while denying public roles", async () => {
    const scope = await configuredScope();
    const otherScope = await configuredScope();
    const content = service(scope);
    const created = await content.createContent({
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
    const archived = await content.archiveContent({ actor: actor(scope.ownerId), contentId: created.value.contentId,
      expectedVersion: created.value.aggregateVersion, idempotencyKey: key("immutable-archive"), correlationId: "immutable-archive" });
    expect(archived).toMatchObject({ ok: true, value: { aggregateVersion: 2, outcome: "content-archived" } });
    await expect(admin.query(
      "update content.lifecycle_history set reason = 'rewritten' where content_id = $1::uuid and transition_sequence = 1",
      [created.value.contentId],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(admin.query(
      "delete from content.lifecycle_history where content_id = $1::uuid and transition_sequence = 1",
      [created.value.contentId],
    )).rejects.toMatchObject({ code: "55000" });

    const grants = await admin.query(
      "select has_table_privilege('anon', 'content.items', 'select') anon_root, " +
      "has_table_privilege('anon', 'content.revisions', 'select') anon_revision, " +
      "has_table_privilege('authenticated', 'content.items', 'select') authenticated_root, " +
      "has_table_privilege('shipwithali_worker', 'content.revisions', 'select') worker_revision, " +
      "has_table_privilege('shipwithali_backup', 'content.items', 'select') backup_root, " +
      "has_table_privilege('anon', 'content.public_project_locales', 'select') anon_projection, " +
      "has_table_privilege('anon', 'content.public_testimonial_locales', 'select') anon_testimonial_projection, " +
      "has_table_privilege('authenticated', 'content.testimonial_language_publications', 'select') authenticated_testimonial_publication, " +
      "has_table_privilege('shipwithali_worker', 'content.testimonial_publication_history', 'select') worker_testimonial_history, " +
      "has_table_privilege('shipwithali_backup', 'content.public_testimonial_locales', 'select') backup_testimonial_projection, " +
      "has_table_privilege('shipwithali_application', 'content.public_testimonial_locales', 'select') app_testimonial_projection, " +
      "has_table_privilege('anon', 'content.lifecycle_history', 'select') anon_lifecycle_history, " +
      "has_table_privilege('authenticated', 'content.lifecycle_history', 'select') authenticated_lifecycle_history, " +
      "has_table_privilege('shipwithali_worker', 'content.lifecycle_history', 'select') worker_lifecycle_history, " +
      "has_table_privilege('shipwithali_backup', 'content.lifecycle_history', 'select') backup_lifecycle_history, " +
      "has_table_privilege('shipwithali_application', 'content.lifecycle_history', 'select') app_lifecycle_read, " +
      "has_table_privilege('shipwithali_application', 'content.lifecycle_history', 'insert') app_lifecycle_insert, " +
      "has_table_privilege('shipwithali_application', 'content.lifecycle_history', 'update') app_lifecycle_update, " +
      "has_table_privilege('shipwithali_application', 'content.lifecycle_history', 'delete') app_lifecycle_delete, " +
      "has_column_privilege('shipwithali_application', 'content.public_testimonial_locales', 'quote', 'UPDATE') app_testimonial_quote_update, " +
      "has_table_privilege('anon', 'content.public_achievement_locales', 'select') anon_achievement_projection, " +
      "has_table_privilege('authenticated', 'content.public_achievement_locales', 'select') authenticated_achievement_projection, " +
      "has_table_privilege('shipwithali_worker', 'content.public_achievement_locales', 'select') worker_achievement_projection, " +
      "has_table_privilege('shipwithali_backup', 'content.public_achievement_locales', 'select') backup_achievement_projection, " +
      "has_table_privilege('anon', 'taxonomy.project_discovery_locales', 'select') anon_discovery_projection, " +
      "has_column_privilege('shipwithali_application', 'content.public_routes', 'current_slug', 'UPDATE') app_route_slug_update, " +
      "has_table_privilege('authenticated', 'content.public_routes', 'select') authenticated_routes, " +
      "has_table_privilege('shipwithali_worker', 'content.language_publications', 'select') worker_publication, " +
      "has_table_privilege('shipwithali_application', 'content.public_routes', 'select') app_routes, " +
      "has_table_privilege('shipwithali_application', 'content.public_route_reservations', 'select') app_reservations, " +
      "has_column_privilege('shipwithali_application', 'content.public_route_reservations', 'is_current', 'UPDATE') app_reservation_current_update, " +
      "has_table_privilege('shipwithali_application', 'content.public_route_history', 'select') app_route_history, " +
      "has_table_privilege('shipwithali_application', 'content.public_route_history', 'insert') app_route_history_insert",
    );
    expect(grants.rows[0]).toEqual({ anon_root: false, anon_revision: false, authenticated_root: false, worker_revision: false,
      backup_root: false, anon_projection: false, anon_testimonial_projection: false, authenticated_testimonial_publication: false,
      worker_testimonial_history: false, backup_testimonial_projection: false, app_testimonial_projection: true,
      app_testimonial_quote_update: true, anon_discovery_projection: false, app_route_slug_update: true,
      anon_achievement_projection: false, authenticated_achievement_projection: false,
      worker_achievement_projection: false, backup_achievement_projection: false,
      anon_lifecycle_history: false, authenticated_lifecycle_history: false, worker_lifecycle_history: false, backup_lifecycle_history: false,
      app_lifecycle_read: true, app_lifecycle_insert: true, app_lifecycle_update: false, app_lifecycle_delete: false,
      authenticated_routes: false, worker_publication: false, app_routes: true, app_reservations: true,
      app_reservation_current_update: true, app_route_history: true, app_route_history_insert: true });
    const lifecycleRls = await admin.query(
      "select relrowsecurity, relforcerowsecurity from pg_class where oid = 'content.lifecycle_history'::regclass",
    );
    expect(lifecycleRls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const unscoped = await database.transactions.run((context) => sql.raw(
      "select (select count(*)::integer from content.items) roots, (select count(*)::integer from content.revisions) revisions, " +
        "(select count(*)::integer from content.lifecycle_history) lifecycle_history",
    ).execute(resolvePostgresTransaction(context)));
    expect(unscoped.rows[0]).toEqual({ roots: 0, revisions: 0, lifecycle_history: 0 });
  }, 30_000);

  it("stores one canonical symmetric relationship, advances both roots, and replays its original safe receipt", async () => {
    const scope = await configuredScope();
    const left = await createReviewedProject(scope, "Relationship left", "relationship-left");
    const right = await createReviewedProject(scope, "Relationship right", "relationship-right");
    const command = { actor: actor(scope.ownerId), projectId: left.contentId as StableId<"Project">,
      relatedProjectId: right.contentId as StableId<"Project">, expectedVersion: left.aggregateVersion,
      idempotencyKey: key("relationship-left-right"), correlationId: "relationship-left-right" };
    const related = await left.content.relateProjects(command);
    expect(related).toMatchObject({ ok: true, value: { aggregateVersion: left.aggregateVersion + 1,
      relatedProjectAggregateVersion: right.aggregateVersion + 1, outcome: "project-related" } });
    if (!related.ok) return;

    const leftView = await left.content.getOwnerProjectRelationships({ actor: actor(scope.ownerId), projectId: left.contentId as StableId<"Project"> });
    const rightView = await right.content.getOwnerProjectRelationships({ actor: actor(scope.ownerId), projectId: right.contentId as StableId<"Project"> });
    expect(leftView).toMatchObject({ ok: true, value: { relatedProjectIds: [right.contentId] } });
    expect(rightView).toMatchObject({ ok: true, value: { relatedProjectIds: [left.contentId] } });
    const projectAggregate = await left.content.getProjectOwnerView({ actor: actor(scope.ownerId), projectId: left.contentId as StableId<"Project"> });
    expect(projectAggregate).toMatchObject({ ok: true, value: { relatedProjectIds: [right.contentId] } });
    const [leftId, rightId] = [left.contentId, right.contentId].sort();
    const pair = await admin.query("select left_project_id::text, right_project_id::text from content.project_relationships where portfolio_id = $1::uuid", [scope.portfolioId]);
    expect(pair.rows).toEqual([{ left_project_id: leftId, right_project_id: rightId }]);
    const views = await admin.query("select project_id::text, related_project_id::text from content.project_relationship_views where portfolio_id = $1::uuid order by project_id", [scope.portfolioId]);
    expect(views.rows).toEqual([{ project_id: leftId, related_project_id: rightId }, { project_id: rightId, related_project_id: leftId }]);
    const history = await admin.query("select action, initiating_project_id::text, related_project_id::text, initiating_aggregate_version, related_aggregate_version from content.project_relationship_history where portfolio_id = $1::uuid", [scope.portfolioId]);
    expect(history.rows).toEqual([{ action: "related", initiating_project_id: left.contentId, related_project_id: right.contentId,
      initiating_aggregate_version: related.value.aggregateVersion, related_aggregate_version: related.value.relatedProjectAggregateVersion }]);

    const archived = await right.content.archiveContent({ actor: actor(scope.ownerId), contentId: right.contentId,
      expectedVersion: related.value.relatedProjectAggregateVersion, idempotencyKey: key("relationship-archive-related"),
      correlationId: "relationship-archive-related" });
    expect(archived.ok).toBe(true);
    expect(await left.content.relateProjects(command)).toEqual(related);
    if (archived.ok) {
      const inverseDuplicate = await right.content.relateProjects({ actor: actor(scope.ownerId), projectId: right.contentId as StableId<"Project">,
        relatedProjectId: left.contentId as StableId<"Project">, expectedVersion: archived.value.aggregateVersion,
        idempotencyKey: key("relationship-inverse-duplicate"), correlationId: "relationship-inverse-duplicate" });
      expect(inverseDuplicate).toMatchObject({ ok: false, error: { kind: "conflict", code: "PROJECT_RELATIONSHIP_ALREADY_EXISTS" } });
    }
    const relationEvents = await admin.query("select event_type, payload from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'content.projects_related.v1'", [left.contentId]);
    expect(relationEvents.rows).toHaveLength(1);
    expect(relationEvents.rows[0]?.payload).toMatchObject({ projectId: left.contentId, relatedProjectId: right.contentId });
    await expect(admin.query("update content.project_relationship_history set action = 'rewritten' where portfolio_id = $1::uuid", [scope.portfolioId]))
      .rejects.toMatchObject({ code: "55000" });
    await expect(admin.query("delete from content.project_relationship_views where portfolio_id = $1::uuid", [scope.portfolioId]))
      .rejects.toMatchObject({ code: "55000" });
    const access = await admin.query("select has_table_privilege('anon', 'content.project_relationships', 'select') anon_pair, " +
      "has_table_privilege('authenticated', 'content.project_relationship_views', 'select') authenticated_view, " +
      "has_table_privilege('shipwithali_worker', 'content.project_relationship_history', 'select') worker_history, " +
      "has_table_privilege('shipwithali_application', 'content.project_relationship_views', 'select') app_view, " +
      "has_table_privilege('shipwithali_application', 'content.project_relationship_views', 'insert') app_view_insert, " +
      "has_table_privilege('shipwithali_application', 'content.project_relationship_views', 'update') app_view_update");
    expect(access.rows[0]).toEqual({ anon_pair: false, authenticated_view: false, worker_history: false,
      app_view: true, app_view_insert: true, app_view_update: false });
    const rls = await admin.query("select relrowsecurity, relforcerowsecurity from pg_class where oid = 'content.project_relationship_views'::regclass");
    expect(rls.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  }, 30_000);

  it("rejects self, foreign-scope, wrong-kind, and stale initiating Project relationships", async () => {
    const scope = await configuredScope();
    const otherScope = await configuredScope();
    const initiating = await createReviewedProject(scope, "Relationship initiating", "relationship-validation-a");
    const target = await createReviewedProject(scope, "Relationship target", "relationship-validation-b");
    const foreign = await createReviewedProject(otherScope, "Foreign relationship target", "relationship-validation-foreign");
    const self = await initiating.content.relateProjects({ actor: actor(scope.ownerId), projectId: initiating.contentId as StableId<"Project">,
      relatedProjectId: initiating.contentId as StableId<"Project">, expectedVersion: initiating.aggregateVersion,
      idempotencyKey: key("relationship-self"), correlationId: "relationship-self" });
    expect(self).toMatchObject({ ok: false, error: { kind: "validation", code: "INVALID_PROJECT_RELATIONSHIP_COMMAND" } });
    const foreignResult = await initiating.content.relateProjects({ actor: actor(scope.ownerId), projectId: initiating.contentId as StableId<"Project">,
      relatedProjectId: foreign.contentId as StableId<"Project">, expectedVersion: initiating.aggregateVersion,
      idempotencyKey: key("relationship-foreign"), correlationId: "relationship-foreign" });
    expect(foreignResult).toMatchObject({ ok: false, error: { kind: "validation", code: "RELATED_PROJECT_UNAVAILABLE" } });
    const testimonial = await createReviewedTestimonial(scope, "relationship-wrong-kind", { type: "profile" });
    const wrongKind = await initiating.content.relateProjects({ actor: actor(scope.ownerId), projectId: initiating.contentId as StableId<"Project">,
      relatedProjectId: testimonial.contentId as StableId<"Project">, expectedVersion: initiating.aggregateVersion,
      idempotencyKey: key("relationship-wrong-kind"), correlationId: "relationship-wrong-kind" });
    expect(wrongKind).toMatchObject({ ok: false, error: { kind: "validation", code: "CONTENT_TYPE_NOT_PROJECT" } });
    const stale = await initiating.content.relateProjects({ actor: actor(scope.ownerId), projectId: initiating.contentId as StableId<"Project">,
      relatedProjectId: target.contentId as StableId<"Project">, expectedVersion: initiating.aggregateVersion - 1,
      idempotencyKey: key("relationship-stale"), correlationId: "relationship-stale" });
    expect(stale).toMatchObject({ ok: false, error: { kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion: initiating.aggregateVersion } });
  }, 30_000);

  it("serializes inverse relationship races and rolls back both roots if the second update fails", async () => {
    const scope = await configuredScope();
    const first = await createReviewedProject(scope, "Relationship race first", "relationship-race-first");
    const second = await createReviewedProject(scope, "Relationship race second", "relationship-race-second");
    const firstCommand = { actor: actor(scope.ownerId), projectId: first.contentId as StableId<"Project">,
      relatedProjectId: second.contentId as StableId<"Project">, expectedVersion: first.aggregateVersion,
      idempotencyKey: key("relationship-race-forward"), correlationId: "relationship-race-forward" };
    const secondCommand = { actor: actor(scope.ownerId), projectId: second.contentId as StableId<"Project">,
      relatedProjectId: first.contentId as StableId<"Project">, expectedVersion: second.aggregateVersion,
      idempotencyKey: key("relationship-race-inverse"), correlationId: "relationship-race-inverse" };
    const race = await Promise.all([first.content.relateProjects(firstCommand), second.content.relateProjects(secondCommand)]);
    expect(race.filter((result) => result.ok)).toHaveLength(1);
    expect(race.filter((result) => !result.ok)).toHaveLength(1);
    const relationCount = await admin.query("select count(*)::integer as count from content.project_relationships where portfolio_id = $1::uuid", [scope.portfolioId]);
    expect(relationCount.rows[0]?.count).toBe(1);

    const rollbackFirst = await createReviewedProject(scope, "Relationship rollback first", "relationship-rollback-first");
    const rollbackSecond = await createReviewedProject(scope, "Relationship rollback second", "relationship-rollback-second");
    const failureId = [rollbackFirst.contentId, rollbackSecond.contentId].sort()[1]!;
    await admin.query("create function content.fail_relationship_root_update() returns trigger language plpgsql as $$ begin raise exception 'injected relationship root update failure'; end $$");
    await admin.query("create trigger fail_relationship_root_update before update on content.items for each row when (new.content_id = '" + failureId + "'::uuid) execute function content.fail_relationship_root_update()");
    const before = await admin.query("select content_id::text, aggregate_version from content.items where content_id = any($1::uuid[]) order by content_id", [[rollbackFirst.contentId, rollbackSecond.contentId]]);
    const failureCommand = { actor: actor(scope.ownerId), projectId: rollbackFirst.contentId as StableId<"Project">,
      relatedProjectId: rollbackSecond.contentId as StableId<"Project">, expectedVersion: rollbackFirst.aggregateVersion,
      idempotencyKey: key("relationship-rollback"), correlationId: "relationship-rollback" };
    await expect(rollbackFirst.content.relateProjects(failureCommand)).rejects.toThrow();
    await admin.query("drop trigger fail_relationship_root_update on content.items");
    await admin.query("drop function content.fail_relationship_root_update()");
    const after = await admin.query("select content_id::text, aggregate_version from content.items where content_id = any($1::uuid[]) order by content_id", [[rollbackFirst.contentId, rollbackSecond.contentId]]);
    expect(after.rows).toEqual(before.rows);
    const historyCount = await admin.query("select count(*)::integer as count from content.project_relationship_history where portfolio_id = $1::uuid", [scope.portfolioId]);
    expect(historyCount.rows[0]?.count).toBe(1);
    const rolledBackPair = await admin.query("select count(*)::integer as count from content.project_relationships where portfolio_id = $1::uuid and ((left_project_id = $2::uuid and right_project_id = $3::uuid) or (left_project_id = $3::uuid and right_project_id = $2::uuid))", [scope.portfolioId, rollbackFirst.contentId, rollbackSecond.contentId]);
    expect(rolledBackPair.rows[0]?.count).toBe(0);
    const rolledBackEvents = await admin.query("select count(*)::integer as count from operations.outbox_events where correlation_id = 'relationship-rollback' and event_type = 'content.projects_related.v1'");
    expect(rolledBackEvents.rows[0]?.count).toBe(0);
  }, 30_000);

  it("returns only currently published related Projects in the requested locale, ordered and bounded", async () => {
    const scope = await configuredScope();
    const source = await createReviewedProject(scope, "Related source", "related-public-source");
    const a = await createReviewedProject(scope, "Related A", "related-public-a");
    const b = await createReviewedProject(scope, "Related B", "related-public-b");
    const c = await createReviewedProject(scope, "Related C", "related-public-c");
    async function publish(project: Awaited<ReturnType<typeof createReviewedProject>>, prefix: string) {
      const result = await project.content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: project.contentId,
        expectedVersion: project.aggregateVersion, idempotencyKey: key(`${prefix}-publish`), correlationId: `${prefix}-publish`,
        locale: "en", revisionId: project.revisionId });
      expect(result.ok).toBe(true);
      return result;
    }
    const sourcePublication = await publish(source, "related-public-source");
    const aPublication = await publish(a, "related-public-a");
    await publish(b, "related-public-b");
    await publish(c, "related-public-c");
    expect(sourcePublication.ok && aPublication.ok).toBe(true);
    if (!sourcePublication.ok || !aPublication.ok) return;

    const firstRelation = await source.content.relateProjects({ actor: actor(scope.ownerId), projectId: source.contentId as StableId<"Project">,
      relatedProjectId: a.contentId as StableId<"Project">, expectedVersion: sourcePublication.value.aggregateVersion,
      idempotencyKey: key("related-public-link-a"), correlationId: "related-public-link-a" });
    expect(firstRelation.ok).toBe(true);
    if (!firstRelation.ok) return;
    const secondRelation = await source.content.relateProjects({ actor: actor(scope.ownerId), projectId: source.contentId as StableId<"Project">,
      relatedProjectId: b.contentId as StableId<"Project">, expectedVersion: firstRelation.value.aggregateVersion,
      idempotencyKey: key("related-public-link-b"), correlationId: "related-public-link-b" });
    expect(secondRelation.ok).toBe(true);
    if (!secondRelation.ok) return;
    const thirdRelation = await source.content.relateProjects({ actor: actor(scope.ownerId), projectId: source.contentId as StableId<"Project">,
      relatedProjectId: c.contentId as StableId<"Project">, expectedVersion: secondRelation.value.aggregateVersion,
      idempotencyKey: key("related-public-link-c"), correlationId: "related-public-link-c" });
    expect(thirdRelation.ok).toBe(true);
    if (!thirdRelation.ok) return;
    const equalTime = "2026-10-08T12:00:00.000Z";
    await admin.query("update content.items set first_published_at = $1::timestamptz where content_id = any($2::uuid[])",
      [equalTime, [a.contentId, b.contentId, c.contentId]]);
    const bounded = await source.content.getPublicRelatedProjects({ projectId: source.contentId as StableId<"Project">, locale: "en", limit: 2 });
    expect(bounded).toMatchObject({ ok: true, value: [{ projectId: c.contentId }, { projectId: b.contentId }] });
    const noArabicFallback = await source.content.getPublicRelatedProjects({ projectId: source.contentId as StableId<"Project">, locale: "ar" });
    expect(noArabicFallback).toEqual({ ok: true, value: [] });
    const hidden = await c.content.hideContent({ actor: actor(scope.ownerId), contentId: c.contentId,
      expectedVersion: thirdRelation.value.relatedProjectAggregateVersion, idempotencyKey: key("related-public-hide"),
      correlationId: "related-public-hide" });
    expect(hidden.ok).toBe(true);
    const afterWithdraw = await source.content.getPublicRelatedProjects({ projectId: source.contentId as StableId<"Project">, locale: "en", limit: 10 });
    expect(afterWithdraw).toMatchObject({ ok: true, value: [{ projectId: b.contentId }, { projectId: a.contentId }] });
  }, 30_000);

  it("keeps Project status identities, histories, Featured state, and published projections atomic", async () => {
    const scope = await configuredScope();
    const content = service(scope);
    const activeLabel = `Active ${randomBytes(4).toString("hex")}`;
    const shippedLabel = `Shipped ${randomBytes(4).toString("hex")}`;
    const researchLabel = `Research ${randomBytes(4).toString("hex")}`;
    const status = await content.createProjectStatusValue({ actor: actor(scope.ownerId), label: `  ${activeLabel}  `, idempotencyKey: key("status-active"), correlationId: "status-active" });
    expect(status).toMatchObject({ ok: true, value: { label: activeLabel, state: "active", aggregateVersion: 1 } });
    if (!status.ok) return;
    const duplicate = await content.createProjectStatusValue({ actor: actor(scope.ownerId), label: activeLabel.toLowerCase(), idempotencyKey: key("status-active-duplicate"), correlationId: "status-active-duplicate" });
    expect(duplicate).toMatchObject({ ok: false, error: { kind: "conflict", code: "PROJECT_STATUS_LABEL_ALREADY_EXISTS" } });
    const archived = await content.createProjectStatusValue({ actor: actor(scope.ownerId), label: "ARCHIVED", idempotencyKey: key("status-archived"), correlationId: "status-archived" });
    expect(archived).toMatchObject({ ok: false, error: { kind: "validation", code: "INVALID_PROJECT_STATUS_LABEL" } });

    const project = await createReviewedProject(scope, "Status lifecycle", "status-lifecycle", "en");
    const initial = await content.getProjectOwnerView({ actor: actor(scope.ownerId), projectId: project.contentId as StableId<"Project"> });
    expect(initial).toMatchObject({ ok: true, value: { aggregateVersion: 2, statusValueId: null, featured: false, publicRoute: null } });
    const assigned = await content.changeProjectStatus({ actor: actor(scope.ownerId), projectId: project.contentId as StableId<"Project">,
      statusValueId: status.value.valueId, expectedVersion: 2, idempotencyKey: key("status-select"), correlationId: "status-select" });
    expect(assigned).toMatchObject({ ok: true, value: { aggregateVersion: 3, outcome: "project-status-changed" } });
    const featured = await content.setProjectFeatured({ actor: actor(scope.ownerId), projectId: project.contentId as StableId<"Project">,
      featured: true, expectedVersion: 3, idempotencyKey: key("status-feature"), correlationId: "status-feature" });
    expect(featured).toMatchObject({ ok: true, value: { aggregateVersion: 4, outcome: "project-featured-changed" } });
    const published = await content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: project.contentId,
      locale: "en", revisionId: project.revisionId, expectedVersion: 4, idempotencyKey: key("status-publish"), correlationId: "status-publish" });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const publicationSnapshot = await admin.query(
      "select item.first_published_at, public.first_published_at as projection_first_published_at, public.published_at as projection_published_at, " +
      "publication.published_at as publication_published_at, publication.revision_id::text as publication_revision_id, " +
      "(select count(*)::int from content.revisions where content_id = item.content_id) revision_count " +
      "from content.items item join content.public_project_locales public using (content_id, portfolio_id) " +
      "join content.language_publications publication using (content_id, portfolio_id) " +
      "where item.content_id = $1::uuid and public.locale = 'en' and publication.locale = 'en'",
      [project.contentId],
    );
    const nextStatus = await content.createProjectStatusValue({ actor: actor(scope.ownerId), label: `Published ${randomBytes(4).toString("hex")}`,
      idempotencyKey: key("status-post-publish-create"), correlationId: "status-post-publish-create" });
    expect(nextStatus.ok).toBe(true);
    if (!nextStatus.ok) return;
    const postPublishStatus = await content.changeProjectStatus({ actor: actor(scope.ownerId), projectId: project.contentId as StableId<"Project">,
      statusValueId: nextStatus.value.valueId, expectedVersion: published.value.aggregateVersion,
      idempotencyKey: key("status-post-publish-select"), correlationId: "status-post-publish-select" });
    expect(postPublishStatus).toMatchObject({ ok: true, value: { aggregateVersion: published.value.aggregateVersion + 1 } });
    const postPublishFeatured = await content.setProjectFeatured({ actor: actor(scope.ownerId), projectId: project.contentId as StableId<"Project">,
      featured: false, expectedVersion: published.value.aggregateVersion + 1,
      idempotencyKey: key("status-post-publish-feature"), correlationId: "status-post-publish-feature" });
    expect(postPublishFeatured).toMatchObject({ ok: true, value: { aggregateVersion: published.value.aggregateVersion + 2 } });
    const publicationAfterStatusChanges = await admin.query(
      "select item.first_published_at, public.first_published_at as projection_first_published_at, public.published_at as projection_published_at, " +
      "publication.published_at as publication_published_at, publication.revision_id::text as publication_revision_id, " +
      "(select count(*)::int from content.revisions where content_id = item.content_id) revision_count " +
      "from content.items item join content.public_project_locales public using (content_id, portfolio_id) " +
      "join content.language_publications publication using (content_id, portfolio_id) " +
      "where item.content_id = $1::uuid and public.locale = 'en' and publication.locale = 'en'",
      [project.contentId],
    );
    expect(publicationAfterStatusChanges.rows[0]).toEqual(publicationSnapshot.rows[0]);

    const projected = await database.transactions.run(async (context) => {
      await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
                       set_config('shipwithali.owner_id', ${scope.ownerId}, true)`.execute(resolvePostgresTransaction(context));
      return await sql<{ status_value_id: string | null; featured: boolean; published_at: Date | string }>`
        select status_value_id::text, featured, published_at from taxonomy.project_discovery_locales
         where content_id = ${project.contentId}::uuid and portfolio_id = ${scope.portfolioId}::uuid and locale = 'en'
      `.execute(resolvePostgresTransaction(context));
    });
    expect(projected.rows).toHaveLength(1);
    expect(projected.rows[0]).toMatchObject({ status_value_id: nextStatus.value.valueId, featured: false });
    const noPriorityOrdering = await database.transactions.run(async (context) => {
      await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
                       set_config('shipwithali.owner_id', ${scope.ownerId}, true)`.execute(resolvePostgresTransaction(context));
      return await sql<{ status_value_id: string | null; featured: boolean }>`
        select status_value_id::text, featured from content.items
         where content_id = ${project.contentId}::uuid and portfolio_id = ${scope.portfolioId}::uuid
      `.execute(resolvePostgresTransaction(context));
    });
    expect(noPriorityOrdering.rows[0]).toEqual({ status_value_id: nextStatus.value.valueId, featured: false });

    const renamed = await content.renameProjectStatusValue({ actor: actor(scope.ownerId), valueId: status.value.valueId,
      label: shippedLabel, expectedVersion: 1, idempotencyKey: key("status-rename"), correlationId: "status-rename" });
    expect(renamed).toMatchObject({ ok: true, value: { valueId: status.value.valueId, label: shippedLabel, aggregateVersion: 2 } });
    const retired = await content.retireProjectStatusValue({ actor: actor(scope.ownerId), valueId: status.value.valueId,
      expectedVersion: 2, idempotencyKey: key("status-retire"), correlationId: "status-retire" });
    expect(retired).toMatchObject({ ok: true, value: { valueId: status.value.valueId, state: "retired", aggregateVersion: 3 } });
    const selectionAfterRetirement = await content.changeProjectStatus({ actor: actor(scope.ownerId), projectId: project.contentId as StableId<"Project">,
      statusValueId: status.value.valueId, expectedVersion: published.value.aggregateVersion + 2,
      idempotencyKey: key("status-select-retired"), correlationId: "status-select-retired" });
    expect(selectionAfterRetirement).toMatchObject({ ok: false, error: { kind: "validation", code: "PROJECT_STATUS_VALUE_NOT_ACTIVE" } });
    const retainedProject = await content.getProjectOwnerView({ actor: actor(scope.ownerId), projectId: project.contentId as StableId<"Project"> });
    expect(retainedProject).toMatchObject({ ok: true, value: { aggregateVersion: published.value.aggregateVersion + 2,
      statusValueId: nextStatus.value.valueId, featured: false } });
    const statusHistory = await content.getProjectStatusHistory({ actor: actor(scope.ownerId), valueId: status.value.valueId });
    expect(statusHistory).toMatchObject({ ok: true, value: [
      { operation: "created", label: activeLabel, state: "active", aggregateVersion: 1 },
      { operation: "renamed", previousLabel: activeLabel, label: shippedLabel, state: "active", aggregateVersion: 2 },
      { operation: "retired", previousLabel: shippedLabel, label: shippedLabel, state: "retired", aggregateVersion: 3 },
    ] });
    const historyRows = await database.transactions.run(async (context) => {
      await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
                       set_config('shipwithali.owner_id', ${scope.ownerId}, true)`.execute(resolvePostgresTransaction(context));
      return await sql<{ previous_value_id: string | null; current_value_id: string; aggregate_version: number }>`
        select previous_value_id::text, current_value_id::text, aggregate_version from content.project_status_history
         where content_id = ${project.contentId}::uuid and portfolio_id = ${scope.portfolioId}::uuid
      `.execute(resolvePostgresTransaction(context));
    });
    expect(historyRows.rows).toEqual([
      { previous_value_id: null, current_value_id: status.value.valueId, aggregate_version: 3 },
      { previous_value_id: status.value.valueId, current_value_id: nextStatus.value.valueId, aggregate_version: published.value.aggregateVersion + 1 },
    ]);

    const replay = await content.setProjectFeatured({ actor: actor(scope.ownerId), projectId: project.contentId as StableId<"Project">,
      featured: true, expectedVersion: 3, idempotencyKey: key("status-feature"), correlationId: "status-feature" });
    expect(replay).toMatchObject({ ok: true, value: { aggregateVersion: 4, outcome: "project-featured-changed" } });

    const research = await content.createProjectStatusValue({ actor: actor(scope.ownerId), label: researchLabel,
      idempotencyKey: key("status-race-create"), correlationId: "status-race-create" });
    expect(research.ok).toBe(true);
    if (!research.ok) return;
    const [selectedDuringRetirement, retiredDuringSelection] = await Promise.all([
      content.changeProjectStatus({ actor: actor(scope.ownerId), projectId: project.contentId as StableId<"Project">,
        statusValueId: research.value.valueId, expectedVersion: published.value.aggregateVersion + 2,
        idempotencyKey: key("status-race-select"), correlationId: "status-race-select" }),
      content.retireProjectStatusValue({ actor: actor(scope.ownerId), valueId: research.value.valueId, expectedVersion: 1,
        idempotencyKey: key("status-race-retire"), correlationId: "status-race-retire" }),
    ]);
    expect(retiredDuringSelection).toMatchObject({ ok: true, value: { state: "retired", aggregateVersion: 2 } });
    if (selectedDuringRetirement.ok) {
      const racedOwnerView = await content.getProjectOwnerView({ actor: actor(scope.ownerId), projectId: project.contentId as StableId<"Project"> });
      expect(racedOwnerView).toMatchObject({ ok: true, value: { aggregateVersion: published.value.aggregateVersion + 3, statusValueId: research.value.valueId } });
    } else {
      expect(selectedDuringRetirement).toMatchObject({ ok: false, error: { kind: "validation", code: "PROJECT_STATUS_VALUE_NOT_ACTIVE" } });
      const unchangedOwnerView = await content.getProjectOwnerView({ actor: actor(scope.ownerId), projectId: project.contentId as StableId<"Project"> });
      expect(unchangedOwnerView).toMatchObject({ ok: true, value: { aggregateVersion: published.value.aggregateVersion + 2,
        statusValueId: nextStatus.value.valueId } });
    }
  }, 30_000);

  it("keeps status and Featured mutations atomic when the outbox fails", async () => {
    const scope = await configuredScope();
    const content = service(scope);
    const status = await content.createProjectStatusValue({ actor: actor(scope.ownerId), label: "Atomic status",
      idempotencyKey: key("status-rollback-create"), correlationId: "status-rollback-create" });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    const project = await createReviewedProject(scope, "Atomic Project", "status-rollback-project");
    const published = await content.publishLanguageVersion({ actor: actor(scope.ownerId), contentId: project.contentId,
      locale: "en", revisionId: project.revisionId, expectedVersion: project.aggregateVersion,
      idempotencyKey: key("status-rollback-publish"), correlationId: "status-rollback-publish" });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const failingOperations = {
      ...operations,
      outbox: { ...operations.outbox, async append() { throw new Error("simulated project status event failure"); } },
    };
    const failingContent = createContentAuthoringService({ repository, operations: failingOperations, scope,
      discoveryProjection: createPostgresProjectDiscoveryProjectionWriter() });
    await expect(failingContent.changeProjectStatus({ actor: actor(scope.ownerId), projectId: project.contentId as StableId<"Project">,
      statusValueId: status.value.valueId, expectedVersion: published.value.aggregateVersion,
      idempotencyKey: key("status-rollback-select"), correlationId: "status-rollback-select" })).rejects.toThrow();
    await expect(failingContent.setProjectFeatured({ actor: actor(scope.ownerId), projectId: project.contentId as StableId<"Project">,
      featured: true, expectedVersion: published.value.aggregateVersion,
      idempotencyKey: key("status-rollback-feature"), correlationId: "status-rollback-feature" })).rejects.toThrow();

    const persisted = await admin.query(
      "select (select aggregate_version from content.items where content_id = $1::uuid) aggregate_version, " +
      "(select status_value_id::text from content.items where content_id = $1::uuid) status_value_id, " +
      "(select featured from content.items where content_id = $1::uuid) featured, " +
      "(select status_value_id::text from taxonomy.project_discovery_locales where content_id = $1::uuid and locale = 'en') projected_status, " +
      "(select featured from taxonomy.project_discovery_locales where content_id = $1::uuid and locale = 'en') projected_featured, " +
      "(select count(*)::int from content.project_status_history where content_id = $1::uuid) status_history, " +
      "(select count(*)::int from operations.idempotency_records where key_hash in ($2, $3)) receipts, " +
      "(select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type in ('content.project_status_changed.v1', 'content.project_featured_changed.v1')) events",
      [project.contentId, createHash("sha256").update("status-rollback-select").digest("hex"), createHash("sha256").update("status-rollback-feature").digest("hex")],
    );
    expect(persisted.rows[0]).toEqual({ aggregate_version: published.value.aggregateVersion, status_value_id: null,
      featured: false, projected_status: null, projected_featured: false, status_history: 0, receipts: 0, events: 0 });
  }, 30_000);

  it("scopes all status tables to one Portfolio and rejects status or Featured writes on Achievements", async () => {
    const scope = await configuredScope();
    const otherScope = await configuredScope();
    const content = service(scope);
    const status = await content.createProjectStatusValue({ actor: actor(scope.ownerId), label: "Scoped status",
      idempotencyKey: key("status-rls-create"), correlationId: "status-rls-create" });
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    const project = await createReviewedProject(scope, "Scoped Project", "status-rls-project");
    const assigned = await content.changeProjectStatus({ actor: actor(scope.ownerId), projectId: project.contentId as StableId<"Project">,
      statusValueId: status.value.valueId, expectedVersion: project.aggregateVersion,
      idempotencyKey: key("status-rls-assign"), correlationId: "status-rls-assign" });
    expect(assigned.ok).toBe(true);
    const readUnscopedRows = await database.transactions.run(async (context) => {
      await sql`select set_config('shipwithali.portfolio_id', ${otherScope.portfolioId}, true),
                       set_config('shipwithali.owner_id', ${otherScope.ownerId}, true)`.execute(resolvePostgresTransaction(context));
      return await sql<{ values: number; value_history: number; project_history: number }>`
        select
          (select count(*)::integer from content.project_status_values where value_id = ${status.value.valueId}::uuid) as values,
          (select count(*)::integer from content.project_status_value_history where value_id = ${status.value.valueId}::uuid) as value_history,
          (select count(*)::integer from content.project_status_history where content_id = ${project.contentId}::uuid) as project_history
      `.execute(resolvePostgresTransaction(context));
    });
    expect(readUnscopedRows.rows[0]).toEqual({ values: 0, value_history: 0, project_history: 0 });

    await expect(database.transactions.run(async (context) => {
      await sql`select set_config('shipwithali.portfolio_id', ${otherScope.portfolioId}, true),
                       set_config('shipwithali.owner_id', ${otherScope.ownerId}, true)`.execute(resolvePostgresTransaction(context));
      await sql`insert into content.project_status_values (value_id, portfolio_id, label)
        values (${createStableId("ProjectStatusValue")}::uuid, ${scope.portfolioId}::uuid, 'forged status')`
        .execute(resolvePostgresTransaction(context));
    })).rejects.toThrow();

    const achievement = await createReviewedAchievement(scope, "Status must stay on Projects", "2026-10-08", "status-rls-achievement");
    await expect(database.transactions.run(async (context) => {
      await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
                       set_config('shipwithali.owner_id', ${scope.ownerId}, true)`.execute(resolvePostgresTransaction(context));
      await sql`update content.items set featured = true where content_id = ${achievement.contentId}::uuid`
        .execute(resolvePostgresTransaction(context));
    })).rejects.toThrow();
    await expect(database.transactions.run(async (context) => {
      await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
                       set_config('shipwithali.owner_id', ${scope.ownerId}, true)`.execute(resolvePostgresTransaction(context));
      await sql`update content.items set status_value_id = ${status.value.valueId}::uuid where content_id = ${achievement.contentId}::uuid`
        .execute(resolvePostgresTransaction(context));
    })).rejects.toThrow();
    const restrictedGrants = await admin.query(
      "select " + ["content.project_status_values", "content.project_status_value_history", "content.project_status_history"].flatMap((table, index) =>
        ["anon", "authenticated", "shipwithali_worker", "shipwithali_backup"].map((role, roleIndex) =>
          `has_table_privilege('${role}', '${table}', 'select') as t${index}_r${roleIndex}, has_table_privilege('${role}', '${table}', 'insert') as t${index}_w${roleIndex}`,
        ),
      ).join(", "),
    );
    expect(Object.values(restrictedGrants.rows[0] as Record<string, boolean>).every((allowed) => !allowed)).toBe(true);
  }, 30_000);

  it("keeps the status registry within the strict Owner list response limit", async () => {
    const scope = await configuredScope();
    const seedValues = Array.from({ length: 100 }, (_, index) => [
      createStableId("ProjectStatusValue"), scope.portfolioId, `Status ${index}`,
    ]);
    const tuples = seedValues.map((_, index) => `($${index * 3 + 1}::uuid, $${index * 3 + 2}::uuid, $${index * 3 + 3})`).join(", ");
    await admin.query(`insert into content.project_status_values (value_id, portfolio_id, label) values ${tuples}`, seedValues.flat());
    const content = service(scope);
    const listed = await content.listProjectStatusValues({ actor: actor(scope.ownerId) });
    expect(listed).toMatchObject({ ok: true, value: expect.arrayContaining([expect.objectContaining({ state: "active" })]) });
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(100);
    const overflow = await content.createProjectStatusValue({ actor: actor(scope.ownerId), label: "Status 101",
      idempotencyKey: key("status-limit-overflow"), correlationId: "status-limit-overflow" });
    expect(overflow).toMatchObject({ ok: false, error: { kind: "conflict", code: "PROJECT_STATUS_VALUE_LIMIT_REACHED" } });
  }, 30_000);

  it("provisions stable Taxonomy roots and commits value creation, Project assignment, and discovery facts atomically", async () => {
    const scope = await configuredScope();
    const taxonomy = createTaxonomyOwnerService({
      repository: createPostgresTaxonomyOwnerRepository(),
      operations,
      scope,
      ids: createSystemIdGenerator(),
      clock: { now: () => new Date().toISOString() },
    });
    const technologyId = "01890f3e-7b2f-7cc0-98cf-5a2890378ef8" as StableId<"Taxonomy">;
    const root = await taxonomy.getOwnerTaxonomy({ actor: actor(scope.ownerId), taxonomyId: technologyId });
    expect(root).toMatchObject({ ok: true, value: { aggregateVersion: 1, kind: "technology", values: [] } });
    const roots = await admin.query("select kind from taxonomy.roots where portfolio_id = $1::uuid", [scope.portfolioId]);
    expect(roots.rows.map((row) => row.kind).sort()).toEqual(["ai-ml-domain", "category", "project-type", "technology"]);
    const created = await taxonomy.createOwnerTaxonomyValue({
      actor: actor(scope.ownerId), idempotencyKey: key("taxonomy-value-create"), taxonomyId: technologyId,
      expectedVersion: 1, name: "  TypeScript  ",
    });
    expect(created).toMatchObject({ ok: true, value: { aggregateId: technologyId, aggregateVersion: 2, outcome: "taxonomy-value-created" } });
    const replay = await taxonomy.createOwnerTaxonomyValue({
      actor: actor(scope.ownerId), idempotencyKey: key("taxonomy-value-create"), taxonomyId: technologyId,
      expectedVersion: 1, name: "TypeScript",
    });
    expect(replay).toEqual(created);
    const duplicateName = await taxonomy.createOwnerTaxonomyValue({
      actor: actor(scope.ownerId), idempotencyKey: key("taxonomy-value-duplicate-name"), taxonomyId: technologyId,
      expectedVersion: 2, name: "typescript",
    });
    expect(duplicateName).toMatchObject({ ok: false, error: { kind: "conflict", code: "TAXONOMY_VALUE_NAME_ALREADY_EXISTS" } });
    const staleRoot = await taxonomy.createOwnerTaxonomyValue({
      actor: actor(scope.ownerId), idempotencyKey: key("taxonomy-value-stale-root"), taxonomyId: technologyId,
      expectedVersion: 1, name: "Rust",
    });
    expect(staleRoot).toMatchObject({ ok: false, error: { kind: "precondition_failed", code: "TAXONOMY_VERSION_MISMATCH", currentVersion: 2 } });
    const aggregate = await taxonomy.getOwnerTaxonomy({ actor: actor(scope.ownerId), taxonomyId: technologyId });
    expect(aggregate).toMatchObject({ ok: true, value: { aggregateVersion: 2, values: [{ name: "TypeScript", state: "active" }] } });
    if (!aggregate.ok) return;
    const valueId = aggregate.value.values[0]!.valueId;

    const { content, contentId, revisionId, aggregateVersion } = await createReviewedProject(scope, "Taxonomy project", "taxonomy-assignment");
    const published = await content.publishLanguageVersion({
      actor: actor(scope.ownerId), contentId, expectedVersion: aggregateVersion, idempotencyKey: key("taxonomy-assignment-publish"),
      correlationId: "taxonomy-assignment-publish", locale: "en", revisionId,
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const assigned = await content.assignProjectTaxonomyValue({
      actor: actor(scope.ownerId), projectId: contentId as StableId<"Project">, valueId,
      expectedVersion: published.value.aggregateVersion, idempotencyKey: key("taxonomy-assignment"),
      correlationId: "taxonomy-assignment",
    });
    expect(assigned).toMatchObject({ ok: true, value: { aggregateVersion: published.value.aggregateVersion + 1, outcome: "taxonomy-value-assigned" } });
    const ownerView = await content.getProjectOwnerView({ actor: actor(scope.ownerId), projectId: contentId as StableId<"Project"> });
    expect(ownerView).toMatchObject({ ok: true, value: { taxonomyAssignments: [{ taxonomyId: technologyId, taxonomyKind: "technology", valueId }] } });
    const projection = await admin.query(
      "select kind, label from taxonomy.project_discovery_taxonomy_values where portfolio_id = $1::uuid and content_id = $2::uuid and locale = 'en' and value_id = $3::uuid",
      [scope.portfolioId, contentId, valueId],
    );
    expect(projection.rows).toEqual([{ kind: "technology", label: "TypeScript" }]);

    await admin.query("update taxonomy.taxonomy_values set state = 'retired' where portfolio_id = $1::uuid and value_id = $2::uuid", [scope.portfolioId, valueId]);
    const duplicate = await content.assignProjectTaxonomyValue({
      actor: actor(scope.ownerId), projectId: contentId as StableId<"Project">, valueId,
      expectedVersion: assigned.ok ? assigned.value.aggregateVersion : 0, idempotencyKey: key("taxonomy-assignment-duplicate"),
      correlationId: "taxonomy-assignment-duplicate",
    });
    expect(duplicate).toMatchObject({ ok: true, value: { aggregateVersion: assigned.ok ? assigned.value.aggregateVersion : -1 } });
    const counts = await admin.query(
      "select (select count(*)::int from content.project_taxonomy_assignments where portfolio_id = $1::uuid and content_id = $2::uuid) assignments, " +
      "(select count(*)::int from content.project_taxonomy_assignment_history where portfolio_id = $1::uuid and content_id = $2::uuid) history, " +
      "(select aggregate_version from content.items where portfolio_id = $1::uuid and content_id = $2::uuid) version",
      [scope.portfolioId, contentId],
    );
    expect(counts.rows[0]).toEqual({ assignments: 1, history: 1, version: assigned.ok ? assigned.value.aggregateVersion : -1 });

    const secondValue = await taxonomy.createOwnerTaxonomyValue({
      actor: actor(scope.ownerId), idempotencyKey: key("taxonomy-value-create-node"), taxonomyId: technologyId,
      expectedVersion: 2, name: "Node.js",
    });
    const thirdValue = await taxonomy.createOwnerTaxonomyValue({
      actor: actor(scope.ownerId), idempotencyKey: key("taxonomy-value-create-rust"), taxonomyId: technologyId,
      expectedVersion: 3, name: "Rust",
    });
    expect(secondValue.ok && thirdValue.ok).toBe(true);
    const valuesAfterCreate = await taxonomy.getOwnerTaxonomy({ actor: actor(scope.ownerId), taxonomyId: technologyId });
    if (!valuesAfterCreate.ok) return;
    const nodeId = valuesAfterCreate.value.values.find((value) => value.name === "Node.js")!.valueId;
    const rustId = valuesAfterCreate.value.values.find((value) => value.name === "Rust")!.valueId;
    const race = await Promise.all([
      content.assignProjectTaxonomyValue({
        actor: actor(scope.ownerId), projectId: contentId as StableId<"Project">, valueId: nodeId,
        expectedVersion: assigned.ok ? assigned.value.aggregateVersion : 0, idempotencyKey: key("taxonomy-assignment-race-node"),
        correlationId: "taxonomy-assignment-race-node",
      }),
      content.assignProjectTaxonomyValue({
        actor: actor(scope.ownerId), projectId: contentId as StableId<"Project">, valueId: rustId,
        expectedVersion: assigned.ok ? assigned.value.aggregateVersion : 0, idempotencyKey: key("taxonomy-assignment-race-rust"),
        correlationId: "taxonomy-assignment-race-rust",
      }),
    ]);
    expect(race.filter((result) => result.ok)).toHaveLength(1);
    expect(race.filter((result) => !result.ok && result.error.kind === "precondition_failed")).toHaveLength(1);

    const stale = await content.assignProjectTaxonomyValue({
      actor: actor(scope.ownerId), projectId: contentId as StableId<"Project">, valueId,
      expectedVersion: published.value.aggregateVersion, idempotencyKey: key("taxonomy-assignment-stale"),
      correlationId: "taxonomy-assignment-stale",
    });
    expect(stale).toMatchObject({ ok: false, error: { kind: "precondition_failed", code: "PROJECT_VERSION_MISMATCH" } });
  }, 30_000);

  it("rolls back assignment, Project version, history, and receipt when projection or outbox persistence fails", async () => {
    const scope = await configuredScope();
    const taxonomy = createTaxonomyOwnerService({ repository: createPostgresTaxonomyOwnerRepository(), operations, scope });
    const taxonomyId = "01890f3e-7b2f-7cc0-98cf-5a2890378ef8" as StableId<"Taxonomy">;
    const created = await taxonomy.createOwnerTaxonomyValue({
      actor: actor(scope.ownerId), idempotencyKey: key("taxonomy-rollback-create"),
      taxonomyId, expectedVersion: 1, name: "Rollback tech",
    });
    expect(created.ok).toBe(true);
    const view = await taxonomy.getOwnerTaxonomy({ actor: actor(scope.ownerId), taxonomyId });
    if (!view.ok) throw new Error("TAXONOMY_ROLLBACK_ROOT_MISSING");
    const valueId = view.value.values[0]!.valueId;
    const project = await createReviewedProject(scope, "Taxonomy rollback", "taxonomy-rollback");
    const published = await project.content.publishLanguageVersion({
      actor: actor(scope.ownerId), contentId: project.contentId, expectedVersion: project.aggregateVersion,
      idempotencyKey: key("taxonomy-rollback-publish"), correlationId: "taxonomy-rollback-publish",
      locale: "en", revisionId: project.revisionId,
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    const command = {
      actor: actor(scope.ownerId), projectId: project.contentId as StableId<"Project">, valueId,
      expectedVersion: published.value.aggregateVersion, idempotencyKey: key("taxonomy-rollback-assignment"),
      correlationId: "taxonomy-rollback-assignment",
    };
    const failingProjection = {
      ...createPostgresProjectDiscoveryProjectionWriter(),
      async updateProjectDiscoveryTaxonomyValue() { throw new Error("INJECTED_PROJECTION_FAILURE"); },
    };
    await expect(service(scope, operations, undefined, undefined, failingProjection).assignProjectTaxonomyValue(command)).rejects.toThrow();
    const failingOutbox = {
      ...operations,
      outbox: { ...operations.outbox, async append() { throw new Error("INJECTED_OUTBOX_FAILURE"); } },
    };
    await expect(service(scope, failingOutbox).assignProjectTaxonomyValue(command)).rejects.toThrow();
    const unchanged = await admin.query(
      "select item.aggregate_version, " +
      "(select count(*)::int from content.project_taxonomy_assignments a where a.portfolio_id = item.portfolio_id and a.content_id = item.content_id) assignments, " +
      "(select count(*)::int from content.project_taxonomy_assignment_history h where h.portfolio_id = item.portfolio_id and h.content_id = item.content_id) history " +
      "from content.items item where item.portfolio_id = $1::uuid and item.content_id = $2::uuid",
      [scope.portfolioId, project.contentId],
    );
    expect(unchanged.rows[0]).toMatchObject({
      aggregate_version: published.value.aggregateVersion, assignments: 0, history: 0,
    });
    const retry = await service(scope).assignProjectTaxonomyValue(command);
    expect(retry).toMatchObject({ ok: true, value: { aggregateVersion: published.value.aggregateVersion + 1 } });
  }, 30_000);

  it("renames and retires Taxonomy values while preserving assignments, public labels, and restoration", async () => {
    const scope = await configuredScope();
    const taxonomyId = "01890f3e-7b2f-7cc0-98cf-5a2890378ef8" as StableId<"Taxonomy">;
    const taxonomy = createTaxonomyOwnerService({ repository: createPostgresTaxonomyOwnerRepository(), operations, scope });
    const created = await taxonomy.createOwnerTaxonomyValue({
      actor: actor(scope.ownerId), idempotencyKey: key("taxonomy-evolution-create"), taxonomyId,
      expectedVersion: 1, name: "TypeScript",
    });
    expect(created).toMatchObject({ ok: true, value: { aggregateVersion: 2 } });
    const initial = await taxonomy.getOwnerTaxonomy({ actor: actor(scope.ownerId), taxonomyId });
    if (!initial.ok) throw new Error("TAXONOMY_EVOLUTION_ROOT_MISSING");
    const valueId = initial.value.values[0]!.valueId;

    const project = await createReviewedProject(scope, "Taxonomy history", "taxonomy-evolution-project");
    const published = await project.content.publishLanguageVersion({
      actor: actor(scope.ownerId), contentId: project.contentId, expectedVersion: project.aggregateVersion,
      idempotencyKey: key("taxonomy-evolution-publish"), correlationId: "taxonomy-evolution-publish",
      locale: "en", revisionId: project.revisionId,
    });
    if (!published.ok) throw new Error("TAXONOMY_EVOLUTION_PUBLISH_FAILED");
    const assignment = await project.content.assignProjectTaxonomyValue({
      actor: actor(scope.ownerId), projectId: project.contentId as StableId<"Project">, valueId,
      expectedVersion: published.value.aggregateVersion, idempotencyKey: key("taxonomy-evolution-assignment"),
      correlationId: "taxonomy-evolution-assignment",
    });
    if (!assignment.ok) throw new Error("TAXONOMY_EVOLUTION_ASSIGNMENT_FAILED");
    const originalProjection = await admin.query(
      "select label, first_published_at from taxonomy.project_discovery_taxonomy_values where portfolio_id = $1::uuid and content_id = $2::uuid and locale = 'en' and value_id = $3::uuid",
      [scope.portfolioId, project.contentId, valueId],
    );
    expect(originalProjection.rows).toHaveLength(1);

    const renameCommand = {
      actor: actor(scope.ownerId), idempotencyKey: key("taxonomy-evolution-rename"),
      taxonomyId, valueId, expectedVersion: 2, name: "TypeScript Next",
    };
    const failingOutbox = {
      ...operations,
      outbox: { ...operations.outbox, async append() { throw new Error("INJECTED_TAXONOMY_EVOLUTION_OUTBOX_FAILURE"); } },
    };
    await expect(createTaxonomyOwnerService({ repository: createPostgresTaxonomyOwnerRepository(), operations: failingOutbox, scope })
      .renameOwnerTaxonomyValue(renameCommand)).rejects.toThrow();
    const beforeRetry = await admin.query(
      "select root.aggregate_version, value.label, (select count(*)::int from taxonomy.value_history history where history.portfolio_id = value.portfolio_id and history.value_id = value.value_id) history_count " +
      "from taxonomy.roots root join taxonomy.taxonomy_values value on value.portfolio_id = root.portfolio_id and value.taxonomy_id = root.taxonomy_id " +
      "where root.portfolio_id = $1::uuid and value.value_id = $2::uuid",
      [scope.portfolioId, valueId],
    );
    expect(beforeRetry.rows[0]).toEqual({ aggregate_version: 2, label: "TypeScript", history_count: 1 });
    const renamed = await taxonomy.renameOwnerTaxonomyValue(renameCommand);
    expect(renamed).toMatchObject({ ok: true, value: { aggregateId: taxonomyId, aggregateVersion: 3, outcome: "taxonomy-value-renamed" } });
    expect(await taxonomy.renameOwnerTaxonomyValue(renameCommand)).toEqual(renamed);
    const differentIntent = await taxonomy.renameOwnerTaxonomyValue({ ...renameCommand, name: "A different name" });
    expect(differentIntent).toMatchObject({ ok: false, error: { kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" } });
    const staleRename = await taxonomy.renameOwnerTaxonomyValue({
      ...renameCommand, idempotencyKey: key("taxonomy-evolution-stale-rename"), expectedVersion: 2,
    });
    expect(staleRename).toMatchObject({ ok: false, error: { kind: "precondition_failed", code: "TAXONOMY_VERSION_MISMATCH", currentVersion: 3 } });
    const retired = await taxonomy.retireOwnerTaxonomyValue({
      actor: actor(scope.ownerId), idempotencyKey: key("taxonomy-evolution-retire"),
      valueId, expectedVersion: 3, reason: "No longer a current choice",
    });
    expect(retired).toMatchObject({ ok: true, value: { aggregateVersion: 4, outcome: "taxonomy-value-retired" } });
    const replayAfterEvolution = await taxonomy.renameOwnerTaxonomyValue(renameCommand);
    expect(replayAfterEvolution).toEqual(renamed);
    const current = await taxonomy.getOwnerTaxonomy({ actor: actor(scope.ownerId), taxonomyId });
    expect(current).toMatchObject({ ok: true, value: { aggregateVersion: 4, values: [{ valueId, name: "TypeScript Next", state: "retired" }] } });

    const history = await admin.query(
      "select action, previous_label, label, state, aggregate_version, actor_id, reason from taxonomy.value_history where portfolio_id = $1::uuid and value_id = $2::uuid order by transition_sequence",
      [scope.portfolioId, valueId],
    );
    expect(history.rows).toEqual([
      { action: "created", previous_label: null, label: "TypeScript", state: "active", aggregate_version: 1, actor_id: null, reason: null },
      { action: "renamed", previous_label: "TypeScript", label: "TypeScript Next", state: "active", aggregate_version: 3, actor_id: scope.ownerId, reason: null },
      { action: "retired", previous_label: "TypeScript Next", label: "TypeScript Next", state: "retired", aggregate_version: 4, actor_id: scope.ownerId, reason: "No longer a current choice" },
    ]);
    const retainedProjection = await admin.query(
      "select label, first_published_at from taxonomy.project_discovery_taxonomy_values where portfolio_id = $1::uuid and content_id = $2::uuid and locale = 'en' and value_id = $3::uuid",
      [scope.portfolioId, project.contentId, valueId],
    );
    expect(retainedProjection.rows).toEqual([{ label: "TypeScript Next", first_published_at: originalProjection.rows[0]!.first_published_at }]);

    const lateProject = await createReviewedProject(scope, "Retired value choice", "taxonomy-evolution-late-project");
    const latePublished = await lateProject.content.publishLanguageVersion({
      actor: actor(scope.ownerId), contentId: lateProject.contentId, expectedVersion: lateProject.aggregateVersion,
      idempotencyKey: key("taxonomy-evolution-late-publish"), correlationId: "taxonomy-evolution-late-publish",
      locale: "en", revisionId: lateProject.revisionId,
    });
    if (!latePublished.ok) throw new Error("TAXONOMY_EVOLUTION_LATE_PUBLISH_FAILED");
    const newAssignment = await lateProject.content.assignProjectTaxonomyValue({
      actor: actor(scope.ownerId), projectId: lateProject.contentId as StableId<"Project">, valueId,
      expectedVersion: latePublished.value.aggregateVersion, idempotencyKey: key("taxonomy-evolution-late-assignment"),
      correlationId: "taxonomy-evolution-late-assignment",
    });
    expect(newAssignment).toMatchObject({ ok: false, error: { kind: "validation", code: "TAXONOMY_VALUE_NOT_ACTIVE" } });

    const hidden = await project.content.hideContent({
      actor: actor(scope.ownerId), contentId: project.contentId, expectedVersion: assignment.value.aggregateVersion,
      idempotencyKey: key("taxonomy-evolution-hide"), correlationId: "taxonomy-evolution-hide",
    });
    if (!hidden.ok) throw new Error("TAXONOMY_EVOLUTION_HIDE_FAILED");
    const restored = await project.content.restoreContent({
      actor: actor(scope.ownerId), contentId: project.contentId, expectedVersion: hidden.value.aggregateVersion,
      idempotencyKey: key("taxonomy-evolution-restore"), correlationId: "taxonomy-evolution-restore",
    });
    expect(restored).toMatchObject({ ok: true, value: { aggregateVersion: hidden.value.aggregateVersion + 1 } });
  }, 30_000);

  it("serializes Taxonomy retirement against new assignments", async () => {
    const scope = await configuredScope();
    const taxonomyId = "01890f3e-7b2f-7cc0-98cf-5a2890378ef8" as StableId<"Taxonomy">;
    const taxonomy = createTaxonomyOwnerService({ repository: createPostgresTaxonomyOwnerRepository(), operations, scope });
    await taxonomy.createOwnerTaxonomyValue({
      actor: actor(scope.ownerId), idempotencyKey: key("taxonomy-retirement-race-create"), taxonomyId,
      expectedVersion: 1, name: "Race value",
    });
    const values = await taxonomy.getOwnerTaxonomy({ actor: actor(scope.ownerId), taxonomyId });
    if (!values.ok) throw new Error("TAXONOMY_RETIREMENT_RACE_ROOT_MISSING");
    const valueId = values.value.values[0]!.valueId;
    const project = await createReviewedProject(scope, "Assignment retirement race", "taxonomy-retirement-race-project");
    const published = await project.content.publishLanguageVersion({
      actor: actor(scope.ownerId), contentId: project.contentId, expectedVersion: project.aggregateVersion,
      idempotencyKey: key("taxonomy-retirement-race-publish"), correlationId: "taxonomy-retirement-race-publish",
      locale: "en", revisionId: project.revisionId,
    });
    if (!published.ok) throw new Error("TAXONOMY_RETIREMENT_RACE_PUBLISH_FAILED");
    const [assignment, retirement] = await Promise.all([
      project.content.assignProjectTaxonomyValue({
        actor: actor(scope.ownerId), projectId: project.contentId as StableId<"Project">, valueId,
        expectedVersion: published.value.aggregateVersion, idempotencyKey: key("taxonomy-retirement-race-assignment"),
        correlationId: "taxonomy-retirement-race-assignment",
      }),
      taxonomy.retireOwnerTaxonomyValue({
        actor: actor(scope.ownerId), idempotencyKey: key("taxonomy-retirement-race-retire"),
        valueId, expectedVersion: 2, reason: "Retired during assignment race",
      }),
    ]);
    expect(retirement).toMatchObject({ ok: true, value: { aggregateVersion: 3 } });
    expect(assignment.ok ? assignment.value.outcome : assignment.error.code).toMatch(/taxonomy-value-assigned|TAXONOMY_VALUE_NOT_ACTIVE/);
    const lateProject = await createReviewedProject(scope, "Post retirement assignment", "taxonomy-retirement-race-late");
    const latePublished = await lateProject.content.publishLanguageVersion({
      actor: actor(scope.ownerId), contentId: lateProject.contentId, expectedVersion: lateProject.aggregateVersion,
      idempotencyKey: key("taxonomy-retirement-race-late-publish"), correlationId: "taxonomy-retirement-race-late-publish",
      locale: "en", revisionId: lateProject.revisionId,
    });
    if (!latePublished.ok) throw new Error("TAXONOMY_RETIREMENT_RACE_LATE_PUBLISH_FAILED");
    const afterRetirement = await lateProject.content.assignProjectTaxonomyValue({
      actor: actor(scope.ownerId), projectId: lateProject.contentId as StableId<"Project">, valueId,
      expectedVersion: latePublished.value.aggregateVersion, idempotencyKey: key("taxonomy-retirement-race-late-assignment"),
      correlationId: "taxonomy-retirement-race-late-assignment",
    });
    expect(afterRetirement).toMatchObject({ ok: false, error: { kind: "validation", code: "TAXONOMY_VALUE_NOT_ACTIVE" } });
  }, 30_000);

  it("rejects foreign-scope Taxonomy values and non-Project assignment targets", async () => {
    const sourceScope = await configuredScope();
    const targetScope = await configuredScope();
    const taxonomyId = "01890f3e-7b2f-7cc0-98cf-5a2890378ef8" as StableId<"Taxonomy">;
    const sourceTaxonomy = createTaxonomyOwnerService({ repository: createPostgresTaxonomyOwnerRepository(), operations, scope: sourceScope });
    await sourceTaxonomy.createOwnerTaxonomyValue({
      actor: actor(sourceScope.ownerId), idempotencyKey: key("taxonomy-foreign-value"), taxonomyId, expectedVersion: 1, name: "Foreign",
    });
    const sourceValues = await sourceTaxonomy.getOwnerTaxonomy({ actor: actor(sourceScope.ownerId), taxonomyId });
    if (!sourceValues.ok) throw new Error("TAXONOMY_FOREIGN_SOURCE_MISSING");
    const foreignValueId = sourceValues.value.values[0]!.valueId;

    const targetProject = await createReviewedProject(targetScope, "Foreign assignment target", "taxonomy-foreign-target");
    const foreignAssignment = await targetProject.content.assignProjectTaxonomyValue({
      actor: actor(targetScope.ownerId), projectId: targetProject.contentId as StableId<"Project">,
      valueId: foreignValueId, expectedVersion: targetProject.aggregateVersion,
      idempotencyKey: key("taxonomy-foreign-assignment"), correlationId: "taxonomy-foreign-assignment",
    });
    expect(foreignAssignment).toMatchObject({ ok: false, error: { kind: "validation", code: "TAXONOMY_VALUE_NOT_FOUND" } });

    const targetTaxonomy = createTaxonomyOwnerService({ repository: createPostgresTaxonomyOwnerRepository(), operations, scope: targetScope });
    await targetTaxonomy.createOwnerTaxonomyValue({
      actor: actor(targetScope.ownerId), idempotencyKey: key("taxonomy-local-value"), taxonomyId, expectedVersion: 1, name: "Local",
    });
    const localValues = await targetTaxonomy.getOwnerTaxonomy({ actor: actor(targetScope.ownerId), taxonomyId });
    if (!localValues.ok) throw new Error("TAXONOMY_LOCAL_VALUE_MISSING");
    const localValueId = localValues.value.values[0]!.valueId;
    const achievement = await createReviewedAchievement(targetScope, "Not a Project", "2026-10-08", "taxonomy-wrong-kind");
    const wrongKind = await achievement.content.assignProjectTaxonomyValue({
      actor: actor(targetScope.ownerId), projectId: achievement.contentId as StableId<"Project">,
      valueId: localValueId, expectedVersion: achievement.aggregateVersion,
      idempotencyKey: key("taxonomy-wrong-kind"), correlationId: "taxonomy-wrong-kind",
    });
    expect(wrongKind).toMatchObject({ ok: false, error: { kind: "not_found", code: "PROJECT_NOT_FOUND" } });
  }, 30_000);
});
