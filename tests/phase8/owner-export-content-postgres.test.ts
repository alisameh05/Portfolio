/**
 * Real module fixture for Owner content export acceptance (#241).
 *
 * The acceptance runner supplies an isolated PostgreSQL cluster and restricted
 * application, worker, and administration roles. Source records are created
 * through Content/Taxonomy application services; export capture runs through
 * the read-only Content-owned adapter.
 */
import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { createContentAuthoringService } from "../../src/modules/content-publishing/application/authoring.js";
import { createPostgresContentAuthoringRepository } from "../../src/modules/content-publishing/adapters/postgres-authoring.js";
import { createPostgresContentTaxonomyAssignmentsPort } from "../../src/modules/content-publishing/adapters/postgres-taxonomy-assignments.js";
import { createPostgresProjectDiscoveryProjectionWriter } from "../../src/modules/taxonomy-discovery/adapters/index.js";
import { createPostgresTaxonomyOwnerRepository } from "../../src/modules/taxonomy-discovery/adapters/index.js";
import { createTaxonomyOwnerService } from "../../src/modules/taxonomy-discovery/application/owner-taxonomies.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPortfolioSettingsService } from "../../src/modules/portfolio-configuration/application/settings-service.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createStableId, type StableId } from "../../src/shared/domain/index.js";
import { hashCanonicalRequest } from "../../src/shared/application/idempotency.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";
import { createOwnerExportSnapshotReader } from "../../src/runtime/adapters/owner-export-snapshot.js";
import { buildSelectedOwnerExportPackage, type OwnerExportSelectedSnapshot } from "../../src/modules/portability-operations/application/owner-export-package.js";
import { validateOwnerExportZip } from "../../scripts/owner-export/validator.mjs";

const APPLICATION_URL = process.env["PHASE8_OWNER_EXPORT_APPLICATION_URL"];
const WORKER_URL = process.env["PHASE8_OWNER_EXPORT_WORKER_URL"];
const ADMIN_URL = process.env["PHASE8_OWNER_EXPORT_ADMIN_URL"];
const enabled = Boolean(APPLICATION_URL && WORKER_URL && ADMIN_URL);

function storedEntry(bytes: Uint8Array, expectedName: string): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const compressedLength = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    const contentStart = nameStart + nameLength + extraLength;
    if (name === expectedName) return bytes.subarray(contentStart, contentStart + compressedLength);
    offset = contentStart + compressedLength;
  }
  throw new Error("PHASE8_OWNER_EXPORT_CONTENT_ENTRY_MISSING");
}

async function archiveBytes(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of content) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

describe.runIf(enabled)("Phase 8 #241 real Content module export fixture", () => {
  it("AC01–AC08 captures all retained facts, races consistently, and validates independent content-only and combined packages", async () => {
    if (!APPLICATION_URL || !WORKER_URL || !ADMIN_URL) throw new Error("PHASE8_OWNER_EXPORT_DATABASE_REQUIRED");
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const application = createPostgresRuntimeDatabase(APPLICATION_URL);
    const worker = createPostgresRuntimeDatabase(WORKER_URL);
    const scope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    const actor = { kind: "owner" as const, ownerId: scope.ownerId, sessionId: "phase8-owner-content-export" };
    const fixedTime = "2030-10-23T09:00:00.000Z";
    const clock = { now: () => fixedTime };
    const key = (value: string) => value as never;
    const operations = createPostgresOperationsPersistence(application.database);
    const repository = createPostgresContentAuthoringRepository();
    const discovery = createPostgresProjectDiscoveryProjectionWriter();
    const content = createContentAuthoringService({
      repository,
      operations,
      scope,
      discoveryProjection: discovery,
      taxonomyAssignments: discovery,
      clock,
    });
    const fixtureAggregateIds: string[] = [];
    const fixtureOwnedTables = [
      "content.public_project_locales", "content.public_testimonial_locales", "content.public_achievement_locales",
      "taxonomy.project_discovery_taxonomy_values", "taxonomy.project_discovery_locales",
      "content.public_route_history", "content.public_route_reservations", "content.publication_history",
      "content.testimonial_publication_history", "content.language_publications", "content.testimonial_language_publications",
      "content.revision_reviews", "content.lifecycle_history", "content.project_status_history",
      "content.project_status_value_history", "content.project_relationship_history", "content.project_relationship_views",
      "content.project_relationships", "content.project_taxonomy_assignment_history", "content.project_taxonomy_assignments",
      "content.revisions", "content.public_routes", "content.items", "content.project_status_values",
      "taxonomy.value_history", "taxonomy.taxonomy_values", "taxonomy.roots",
    ] as const;
    let taxonomyId: StableId<"Taxonomy"> | undefined;
    let thirdEnglishRevisionId: string | undefined;
    let projectFirstPublishedAt: string | undefined;
    let firstEnglishPublishedAt: string | undefined;
    let secondEnglishPublishedAt: string | undefined;
    let thirdEnglishPublishedAt: string | undefined;
    let arabicPublishedAt: string | undefined;
    let publishedTieFirstPublishedAt: string | undefined;
    const ownerScopeHash = await hashCanonicalRequest({ ownerId: scope.ownerId });
    let cleanupSucceeded = false;

    async function createReviewedProject(prefix: string, title: string, slug: string) {
      const artifactId = createStableId("SupportingArtifact");
      const payload = {
        contentType: "project" as const,
        locale: "en" as const,
        title,
        summary: title + " summary",
        body: title + " public account",
        candidateSlug: slug,
        caseStudy: {
          problem: "A real project problem.",
          ownerRole: "Led the implementation.",
          contributions: ["Built the service."],
          outcomes: ["Improved the workflow."],
          lessons: "Measure the workflow.",
        },
        evidence: {
          claims: [{ claimId: createStableId("EvidenceClaim"), text: "The supporting demo shows this workflow.", artifactIds: [artifactId] }],
          artifacts: [{ id: artifactId, title: "Project demo", destinationUrl: "https://example.test/demo" }],
        },
        externalLinks: [{ id: createStableId("ExternalLink"), label: "English demo", destination: "https://example.test/en", isAvailableInArabic: false }],
      };
      const created = await content.createContent({
        actor, idempotencyKey: key(prefix + "-create"), correlationId: prefix + "-create", payload,
      });
      if (!created.ok) throw new Error("PHASE8_OWNER_EXPORT_PROJECT_CREATE_FAILED:" + created.error.code);
      fixtureAggregateIds.push(created.value.contentId);
      const preview = await content.previewRevision({ actor, contentId: created.value.contentId, revisionId: created.value.revisionId });
      if (!preview.ok) throw new Error("PHASE8_OWNER_EXPORT_PROJECT_PREVIEW_FAILED:" + preview.error.code);
      const review = await content.reviewRevision({
        actor,
        contentId: created.value.contentId,
        revisionId: created.value.revisionId,
        expectedVersion: created.value.aggregateVersion,
        idempotencyKey: key(prefix + "-review-en-1"),
        correlationId: prefix + "-review-en-1",
        locale: "en",
        snapshotHash: preview.value.snapshotHash,
        evidenceVersion: preview.value.evidenceVersion,
        decision: "accepted",
        findings: [],
      });
      if (!review.ok) throw new Error("PHASE8_OWNER_EXPORT_PROJECT_REVIEW_FAILED:" + review.error.code);
      return { contentId: created.value.contentId, revisionId: created.value.revisionId, version: review.value.aggregateVersion, payload };
    }

    async function saveReviewedProjectRevision(
      project: Awaited<ReturnType<typeof createReviewedProject>>,
      prefix: string,
      locale: "en" | "ar",
      title: string,
    ) {
      const externalLinks = project.payload.externalLinks.map((link) => locale === "ar"
        ? { ...link, label: "عرض عربي", destination: "https://example.test/ar", isAvailableInArabic: true }
        : link);
      const saved = await content.saveRevision({
        actor,
        contentId: project.contentId,
        expectedVersion: project.version,
        idempotencyKey: key(prefix + "-save"),
        correlationId: prefix + "-save",
        locale,
        title,
        summary: title + " summary",
        body: title + " body",
        draftData: {
          contentType: "project",
          caseStudy: project.payload.caseStudy,
          evidence: project.payload.evidence,
          externalLinks,
        },
      });
      if (!saved.ok) throw new Error("PHASE8_OWNER_EXPORT_REVISION_SAVE_FAILED:" + saved.error.code);
      const preview = await content.previewRevision({ actor, contentId: project.contentId, revisionId: saved.value.revisionId });
      if (!preview.ok) throw new Error("PHASE8_OWNER_EXPORT_REVISION_PREVIEW_FAILED:" + preview.error.code);
      const review = await content.reviewRevision({
        actor,
        contentId: project.contentId,
        revisionId: saved.value.revisionId,
        expectedVersion: saved.value.aggregateVersion,
        idempotencyKey: key(prefix + "-review"),
        correlationId: prefix + "-review",
        locale,
        snapshotHash: preview.value.snapshotHash,
        evidenceVersion: preview.value.evidenceVersion,
        decision: "accepted",
        findings: [],
      });
      if (!review.ok) throw new Error("PHASE8_OWNER_EXPORT_REVISION_REVIEW_FAILED:" + review.error.code);
      project.version = review.value.aggregateVersion;
      return saved.value.revisionId;
    }

    async function capture(scopes: readonly ("portfolio-content" | "portfolio-configuration")[]) {
      const reader = createOwnerExportSnapshotReader({
        configuration: createPostgresPortfolioSettingsRepository(),
        content: repository,
        transactions: worker.transactions,
        capabilities: { async read() { return { currentCvAvailable: false, externalLinksAvailable: false }; } },
      });
      const result = await reader.capture({
        portfolioId: scope.portfolioId,
        ownerId: scope.ownerId,
        snapshotId: createStableId("OwnerExportArtifact"),
        includedScopes: scopes,
      });
      if (!result.ok || !("kind" in result.value)) throw new Error("PHASE8_OWNER_EXPORT_SNAPSHOT_CAPTURE_FAILED");
      return result.value;
    }

    async function queryContentCount(portfolioId: string, ownerId: string, purpose: string): Promise<number> {
      const probe = new Client({ connectionString: WORKER_URL });
      await probe.connect();
      try {
        await probe.query("begin");
        await probe.query(
          "select set_config('shipwithali.portfolio_id', $1, true), set_config('shipwithali.owner_id', $2, true), set_config('shipwithali.worker_purpose', $3, true)",
          [portfolioId, ownerId, purpose],
        );
        const result = await probe.query("select count(*)::int as count from content.items");
        await probe.query("rollback");
        return Number(result.rows[0]?.["count"] ?? 0);
      } finally {
        await probe.end();
      }
    }

    try {
      const settings = createPortfolioSettingsService({
        repository: createPostgresPortfolioSettingsRepository(),
        transactions: application.transactions,
        scope,
      });
      const configured = await settings.provision({
        profile: { displayName: "Export fixture", headline: "Engineer", bio: "Synthetic private profile." },
        contactChannels: [{ channel: "email", label: "Email", destination: "mailto:owner@example.test", availableLocales: ["en", "ar"] }],
        globalCta: { label: "Contact", destination: "https://example.test/contact", unavailableFallback: "Email the owner" },
      });
      if (!configured.ok) throw new Error("PHASE8_OWNER_EXPORT_CONFIGURATION_CREATE_FAILED:" + configured.error.code);

      const projectA = await createReviewedProject("phase8-content-route-a", "Route history project", "route-a");
      const projectB = await createReviewedProject("phase8-content-route-b", "Published tie project", "route-published");
      const related = await content.relateProjects({
        actor,
        projectId: projectA.contentId as never,
        relatedProjectId: projectB.contentId as never,
        expectedVersion: projectA.version,
        idempotencyKey: key("phase8-content-project-related"),
        correlationId: "phase8-content-project-related",
      });
      if (!related.ok) throw new Error("PHASE8_OWNER_EXPORT_RELATIONSHIP_FAILED:" + related.error.code);
      projectA.version = related.value.aggregateVersion;
      projectB.version = related.value.relatedProjectAggregateVersion;

      const status = await content.createProjectStatusValue({
        actor, label: "Shipped", idempotencyKey: key("phase8-content-status"), correlationId: "phase8-content-status",
      });
      if (!status.ok) throw new Error("PHASE8_OWNER_EXPORT_STATUS_CREATE_FAILED:" + status.error.code);
      fixtureAggregateIds.push(status.value.valueId);
      const changedStatus = await content.changeProjectStatus({
        actor, projectId: projectA.contentId as never, statusValueId: status.value.valueId, expectedVersion: projectA.version,
        idempotencyKey: key("phase8-content-status-assign"), correlationId: "phase8-content-status-assign",
      });
      if (!changedStatus.ok) throw new Error("PHASE8_OWNER_EXPORT_STATUS_ASSIGN_FAILED:" + changedStatus.error.code);
      projectA.version = changedStatus.value.aggregateVersion;
      const featured = await content.setProjectFeatured({
        actor, projectId: projectA.contentId as never, featured: true, expectedVersion: projectA.version,
        idempotencyKey: key("phase8-content-featured"), correlationId: "phase8-content-featured",
      });
      if (!featured.ok) throw new Error("PHASE8_OWNER_EXPORT_FEATURED_FAILED:" + featured.error.code);
      projectA.version = featured.value.aggregateVersion;

      const firstEnglish = await content.publishLanguageVersion({
        actor, contentId: projectA.contentId, locale: "en", revisionId: projectA.revisionId, expectedVersion: projectA.version,
        idempotencyKey: key("phase8-content-en-publish-1"), correlationId: "phase8-content-en-publish-1",
      });
      if (!firstEnglish.ok) throw new Error("PHASE8_OWNER_EXPORT_EN_PUBLISH_FAILED:" + firstEnglish.error.code);
      projectFirstPublishedAt = firstEnglish.value.firstPublishedAt;
      firstEnglishPublishedAt = firstEnglish.value.publishedAt;
      projectA.version = firstEnglish.value.aggregateVersion;

      const taxonomy = createTaxonomyOwnerService({
        repository: createPostgresTaxonomyOwnerRepository(),
        operations,
        scope,
        contentAssignments: createPostgresContentTaxonomyAssignmentsPort({ scope, discovery }),
        ids: createSystemIdGenerator(),
        clock,
      });
      const stableTaxonomyId = "01890f3e-7b2f-7cc0-98cf-5a2890378ef8" as never;
      const root = await taxonomy.getOwnerTaxonomy({ actor, taxonomyId: stableTaxonomyId });
      if (!root.ok) throw new Error("PHASE8_OWNER_EXPORT_TAXONOMY_ROOT_FAILED:" + root.error.code);
      taxonomyId = root.value.taxonomyId;
      const value = await taxonomy.createOwnerTaxonomyValue({
        actor, idempotencyKey: key("phase8-content-taxonomy-value"), taxonomyId,
        expectedVersion: root.value.aggregateVersion, name: "TypeScript",
      });
      if (!value.ok) throw new Error("PHASE8_OWNER_EXPORT_TAXONOMY_VALUE_FAILED:" + value.error.code);
      const populatedTaxonomy = await taxonomy.getOwnerTaxonomy({ actor, taxonomyId });
      if (!populatedTaxonomy.ok) throw new Error("PHASE8_OWNER_EXPORT_TAXONOMY_READ_FAILED");
      const taxonomyValue = populatedTaxonomy.value.values.find((entry) => entry.name === "TypeScript");
      if (taxonomyValue === undefined) throw new Error("PHASE8_OWNER_EXPORT_TAXONOMY_VALUE_MISSING");
      fixtureAggregateIds.push(taxonomyId, taxonomyValue.valueId);
      const assigned = await content.assignProjectTaxonomyValue({
        actor, projectId: projectA.contentId as never, valueId: taxonomyValue.valueId, expectedVersion: projectA.version,
        idempotencyKey: key("phase8-content-taxonomy-assign"), correlationId: "phase8-content-taxonomy-assign",
      });
      if (!assigned.ok) throw new Error("PHASE8_OWNER_EXPORT_TAXONOMY_ASSIGN_FAILED:" + assigned.error.code);
      projectA.version = assigned.value.aggregateVersion;

      const secondEnglishRevision = await saveReviewedProjectRevision(projectA, "phase8-content-en-revision-2", "en", "English revision two");
      const secondEnglish = await content.publishLanguageVersion({
        actor, contentId: projectA.contentId, locale: "en", revisionId: secondEnglishRevision, expectedVersion: projectA.version,
        idempotencyKey: key("phase8-content-en-publish-2"), correlationId: "phase8-content-en-publish-2",
      });
      if (!secondEnglish.ok) throw new Error("PHASE8_OWNER_EXPORT_EN_REPLACEMENT_FAILED:" + secondEnglish.error.code);
      secondEnglishPublishedAt = secondEnglish.value.publishedAt;
      projectA.version = secondEnglish.value.aggregateVersion;
      const arabicRevision = await saveReviewedProjectRevision(projectA, "phase8-content-ar-revision-1", "ar", "مشروع محفوظ");
      const arabic = await content.publishLanguageVersion({
        actor, contentId: projectA.contentId, locale: "ar", revisionId: arabicRevision, expectedVersion: projectA.version,
        idempotencyKey: key("phase8-content-ar-publish-1"), correlationId: "phase8-content-ar-publish-1",
      });
      if (!arabic.ok) throw new Error("PHASE8_OWNER_EXPORT_AR_PUBLISH_FAILED:" + arabic.error.code);
      arabicPublishedAt = arabic.value.publishedAt;
      projectA.version = arabic.value.aggregateVersion;
      for (const [index, slug] of ["route-b", "route-c"].entries()) {
        const changed = await content.changePublicSlug({
          actor, projectId: projectA.contentId as never, expectedVersion: projectA.version, newSlug: slug,
          idempotencyKey: key("phase8-content-route-change-" + index), correlationId: "phase8-content-route-change-" + index,
        });
        if (!changed.ok) throw new Error("PHASE8_OWNER_EXPORT_ROUTE_CHANGE_FAILED:" + changed.error.code);
        projectA.version = changed.value.aggregateVersion;
      }

      const publishedTieProject = await content.publishLanguageVersion({
        actor, contentId: projectB.contentId, locale: "en", revisionId: projectB.revisionId, expectedVersion: projectB.version,
        idempotencyKey: key("phase8-content-tie-project-publish"), correlationId: "phase8-content-tie-project-publish",
      });
      if (!publishedTieProject.ok) throw new Error("PHASE8_OWNER_EXPORT_TIE_PROJECT_PUBLISH_FAILED:" + publishedTieProject.error.code);
      publishedTieFirstPublishedAt = publishedTieProject.value.firstPublishedAt;
      projectB.version = publishedTieProject.value.aggregateVersion;

      const beforeRace = await worker.transactions.run(async (transaction) => {
        const before = await repository.readOwnerExportSnapshot(scope, transaction);
        if (!before.ok) throw new Error("PHASE8_OWNER_EXPORT_RACE_INITIAL_READ_FAILED");
        const prior = before.value.records.find((record) => record.contentId === projectA.contentId);
        if (!prior) throw new Error("PHASE8_OWNER_EXPORT_RACE_PROJECT_MISSING");
        const revisionThree = await saveReviewedProjectRevision(projectA, "phase8-content-en-revision-3", "en", "English revision three");
        thirdEnglishRevisionId = revisionThree;
        const replacement = await content.publishLanguageVersion({
          actor, contentId: projectA.contentId, locale: "en", revisionId: revisionThree, expectedVersion: projectA.version,
          idempotencyKey: key("phase8-content-en-publish-3"), correlationId: "phase8-content-en-publish-3",
        });
        if (!replacement.ok) throw new Error("PHASE8_OWNER_EXPORT_RACE_PUBLICATION_FAILED:" + replacement.error.code);
        thirdEnglishPublishedAt = replacement.value.publishedAt;
        projectA.version = replacement.value.aggregateVersion;
        const routeChange = await content.changePublicSlug({
          actor, projectId: projectA.contentId as never, expectedVersion: projectA.version, newSlug: "route-d",
          idempotencyKey: key("phase8-content-route-change-d"), correlationId: "phase8-content-route-change-d",
        });
        if (!routeChange.ok) throw new Error("PHASE8_OWNER_EXPORT_RACE_ROUTE_FAILED:" + routeChange.error.code);
        projectA.version = routeChange.value.aggregateVersion;
        const projectC = await createReviewedProject("phase8-content-route-c", "Racing relationship project", "route-racing");
        const changedRelationship = await content.relateProjects({
          actor, projectId: projectA.contentId as never, relatedProjectId: projectC.contentId as never,
          expectedVersion: projectA.version, idempotencyKey: key("phase8-content-project-related-c"),
          correlationId: "phase8-content-project-related-c",
        });
        if (!changedRelationship.ok) throw new Error("PHASE8_OWNER_EXPORT_RACE_RELATIONSHIP_FAILED:" + changedRelationship.error.code);
        projectA.version = changedRelationship.value.aggregateVersion;
        const after = await repository.readOwnerExportSnapshot(scope, transaction);
        if (!after.ok) throw new Error("PHASE8_OWNER_EXPORT_RACE_REPEAT_READ_FAILED");
        expect(after.value).toEqual(before.value);
        return prior;
      }, { isolationLevel: "repeatable read" });
      expect(beforeRace.publicRoute?.canonicalSlug).toBe("route-c");
      expect(beforeRace.publications.find((entry) => entry.locale === "en")?.publicationSequence).toBe(2);
      expect(beforeRace.relatedProjectIds).toEqual([projectB.contentId]);

      const testimonialCreated = await content.createContent({
        actor, idempotencyKey: key("phase8-content-testimonial-create"), correlationId: "phase8-content-testimonial-create",
        payload: {
          contentType: "testimonial", locale: "en", title: "Retained private reference",
          summary: "Draft association.", body: "This is not published.", authorName: "Synthetic source",
          quote: "A retained private quote.", association: { type: "project", projectId: projectA.contentId as never },
        },
      });
      if (!testimonialCreated.ok) throw new Error("PHASE8_OWNER_EXPORT_TESTIMONIAL_CREATE_FAILED:" + testimonialCreated.error.code);
      fixtureAggregateIds.push(testimonialCreated.value.contentId);
      const testimonialArabic = await content.saveRevision({
        actor, contentId: testimonialCreated.value.contentId, expectedVersion: testimonialCreated.value.aggregateVersion,
        idempotencyKey: key("phase8-content-testimonial-ar-save"), correlationId: "phase8-content-testimonial-ar-save",
        locale: "ar", title: "مرجع خاص", summary: "مسودة محفوظة", body: "نص عربي غير منشور",
      });
      if (!testimonialArabic.ok) throw new Error("PHASE8_OWNER_EXPORT_TESTIMONIAL_AR_SAVE_FAILED:" + testimonialArabic.error.code);

      const achievementCreated = await content.createContent({
        actor, idempotencyKey: key("phase8-content-achievement-create"), correlationId: "phase8-content-achievement-create",
        payload: {
          contentType: "achievement", locale: "en", title: "Preserved milestone",
          summary: "Achievement summary.", body: "Achievement body.", achievedOn: "2026-10-24",
        },
      });
      if (!achievementCreated.ok) throw new Error("PHASE8_OWNER_EXPORT_ACHIEVEMENT_CREATE_FAILED:" + achievementCreated.error.code);
      fixtureAggregateIds.push(achievementCreated.value.contentId);
      const achievementPreview = await content.previewRevision({
        actor, contentId: achievementCreated.value.contentId, revisionId: achievementCreated.value.revisionId,
      });
      if (!achievementPreview.ok) throw new Error("PHASE8_OWNER_EXPORT_ACHIEVEMENT_PREVIEW_FAILED:" + achievementPreview.error.code);
      const achievementReview = await content.reviewRevision({
        actor, contentId: achievementCreated.value.contentId, revisionId: achievementCreated.value.revisionId,
        expectedVersion: achievementCreated.value.aggregateVersion, idempotencyKey: key("phase8-content-achievement-review"),
        correlationId: "phase8-content-achievement-review", locale: "en",
        snapshotHash: achievementPreview.value.snapshotHash, evidenceVersion: achievementPreview.value.evidenceVersion,
        decision: "accepted", findings: ["Owner checked the retained record."],
      });
      if (!achievementReview.ok) throw new Error("PHASE8_OWNER_EXPORT_ACHIEVEMENT_REVIEW_FAILED:" + achievementReview.error.code);
      const achievementPublication = await content.publishLanguageVersion({
        actor, contentId: achievementCreated.value.contentId, locale: "en", revisionId: achievementCreated.value.revisionId,
        expectedVersion: achievementReview.value.aggregateVersion, idempotencyKey: key("phase8-content-achievement-publish"),
        correlationId: "phase8-content-achievement-publish",
      });
      if (!achievementPublication.ok) throw new Error("PHASE8_OWNER_EXPORT_ACHIEVEMENT_PUBLISH_FAILED:" + achievementPublication.error.code);
      const archivedAchievement = await content.archiveContent({
        actor, contentId: achievementCreated.value.contentId, expectedVersion: achievementPublication.value.aggregateVersion,
        idempotencyKey: key("phase8-content-achievement-archive"), correlationId: "phase8-content-achievement-archive",
      });
      if (!archivedAchievement.ok) throw new Error("PHASE8_OWNER_EXPORT_ACHIEVEMENT_ARCHIVE_FAILED:" + archivedAchievement.error.code);

      const hidden = await content.hideContent({
        actor, contentId: projectA.contentId, expectedVersion: projectA.version,
        idempotencyKey: key("phase8-content-project-hide"), correlationId: "phase8-content-project-hide",
        reason: "Retained privately after publication.",
      });
      if (!hidden.ok) throw new Error("PHASE8_OWNER_EXPORT_PROJECT_HIDE_FAILED:" + hidden.error.code);
      expect(await content.getPublicProject({ slug: "route-d", locale: "en" }))
        .toMatchObject({ ok: false, error: { kind: "not_found", code: "PUBLIC_CONTENT_NOT_FOUND" } });
      expect(await content.getPublicProject({ slug: "route-published", locale: "ar" }))
        .toMatchObject({ ok: false, error: { kind: "not_found", code: "PUBLIC_CONTENT_NOT_FOUND" } });
      expect(await content.getPublicProject({ slug: "route-published", locale: "en" })).toMatchObject({ ok: true });

      const contentOnly = await capture(["portfolio-content"]);
      const contentBuilt = await buildSelectedOwnerExportPackage({
        exportId: createStableId("OwnerExport"), snapshot: contentOnly as OwnerExportSelectedSnapshot,
      });
      const contentBytes = await archiveBytes(contentBuilt.content);
      const contentValidation = validateOwnerExportZip(contentBytes);
      const contentLines = new TextDecoder().decode(storedEntry(contentBytes, "records/portfolio-content.ndjson"))
        .trim().split("\n").map((line) => JSON.parse(line) as { scope: string; value: Record<string, any> });
      const projectRecord = contentLines.find((line) => line.value["contentId"] === projectA.contentId)?.value;
      expect(contentValidation.includedScopes).toEqual(["portfolio-content"]);
      expect(contentValidation.recordCounts).toEqual({ "portfolio-content": 5 });
      expect(contentLines.map((line) => line.value["contentType"]).sort()).toEqual(["achievement", "project", "project", "project", "testimonial"]);
      expect(contentLines.map((line) => line.value["contentType"])).not.toContain("lab");
      expect(projectRecord).toMatchObject({
        lifecycle: "hidden",
        projectStatus: { label: "Shipped", state: "active" },
        featured: true,
      });
      expect(projectRecord?.["revisions"]).toMatchObject([
        { locale: "en", sequence: 1, currentlyPublished: false, reviews: [{ decision: "accepted" }] },
        { locale: "en", sequence: 2, currentlyPublished: false, reviews: [{ decision: "accepted" }] },
        { locale: "en", sequence: 3, currentlyPublished: true, reviews: [{ decision: "accepted" }] },
        { locale: "ar", sequence: 1, currentlyPublished: true, reviews: [{ decision: "accepted" }] },
      ]);
      expect(projectRecord?.["publicDiscoveryOrder"]).toEqual({ firstPublishedAt: projectFirstPublishedAt, tieBreaker: "content-id-desc" });
      expect(projectRecord).toMatchObject({
        publicRoute: {
          canonicalSlug: "route-d",
          reservations: expect.arrayContaining([
            expect.objectContaining({ slug: "route-a", isCurrent: false }),
            expect.objectContaining({ slug: "route-b", isCurrent: false }),
            expect.objectContaining({ slug: "route-c", isCurrent: false }),
            expect.objectContaining({ slug: "route-d", isCurrent: true }),
          ]),
          history: [
            expect.objectContaining({ sequence: 1, fromSlug: "route-a", toSlug: "route-b" }),
            expect.objectContaining({ sequence: 2, fromSlug: "route-b", toSlug: "route-c" }),
            expect.objectContaining({ sequence: 3, fromSlug: "route-c", toSlug: "route-d" }),
          ],
        },
      });
      expect(projectRecord?.["publicationHistory"]).toEqual(expect.arrayContaining([
        expect.objectContaining({ locale: "en", sequence: 1, publishedAt: firstEnglishPublishedAt }),
        expect.objectContaining({ locale: "en", sequence: 2, publishedAt: secondEnglishPublishedAt }),
        expect.objectContaining({ locale: "en", sequence: 3, publishedAt: thirdEnglishPublishedAt }),
        expect.objectContaining({ locale: "ar", sequence: 1, publishedAt: arabicPublishedAt }),
      ]));
      expect(projectRecord?.["routeHistory"]).toEqual(expect.arrayContaining([
        expect.objectContaining({ fromSlug: "route-a", toSlug: "route-d" }),
        expect.objectContaining({ fromSlug: "route-b", toSlug: "route-d" }),
        expect.objectContaining({ fromSlug: "route-c", toSlug: "route-d" }),
      ]));
      expect(projectRecord).toMatchObject({
        relatedProjectIds: expect.arrayContaining([projectB.contentId]),
        relationshipHistory: expect.arrayContaining([expect.objectContaining({
          leftProjectId: expect.any(String), rightProjectId: expect.any(String), initiatingProjectId: projectA.contentId,
          relatedProjectId: expect.any(String), sequence: 1,
        })]),
        taxonomyAssignments: [{ taxonomyId, kind: "technology", valueId: taxonomyValue.valueId }],
        evidenceItems: [expect.objectContaining({ claim: "The supporting demo shows this workflow." })],
      });
      const projectRevisions = projectRecord?.["revisions"] as Array<{
        locale: string; sequence: number; revisionId: string; reviews: Array<{ reviewId: string }>;
      }> | undefined;
      expect(projectRecord?.["publications"]).toEqual(expect.arrayContaining([
        expect.objectContaining({ locale: "en", revisionId: thirdEnglishRevisionId, publicationSequence: 3, publishedAt: thirdEnglishPublishedAt }),
        expect.objectContaining({ locale: "ar", revisionId: arabicRevision, publicationSequence: 1, publishedAt: arabicPublishedAt }),
      ]));
      const currentEnglishRevision = projectRevisions?.find((revision) => revision.locale === "en" && revision.sequence === 3);
      const currentArabicRevision = projectRevisions?.find((revision) => revision.locale === "ar" && revision.sequence === 1);
      expect(projectRecord?.["publications"]).toEqual(expect.arrayContaining([
        expect.objectContaining({ locale: "en", reviewId: currentEnglishRevision?.reviews[0]?.reviewId }),
        expect.objectContaining({ locale: "ar", reviewId: currentArabicRevision?.reviews[0]?.reviewId }),
      ]));
      expect(projectRecord?.["publicRouteIdentity"]).toBe(projectRecord?.["publicRoute"]["identity"]);
      expect(projectRecord?.["publicRouteIdentity"]).toBe(beforeRace.publicRoute?.identity);
      expect(projectRecord?.["publicationHistory"].find((entry: { locale: string; sequence: number }) => entry.locale === "en" && entry.sequence === 3))
        .toMatchObject({ revisionId: projectRecord?.["revisions"].find((revision: { locale: string; sequence: number }) => revision.locale === "en" && revision.sequence === 3)?.revisionId });
      const publishedTieRecord = contentLines.find((line) => line.value["contentId"] === projectB.contentId)?.value;
      expect(publishedTieRecord?.["firstPublishedAt"]).toBe(publishedTieFirstPublishedAt);
      expect(publishedTieRecord?.["publicDiscoveryOrder"]).toEqual({ firstPublishedAt: publishedTieFirstPublishedAt, tieBreaker: "content-id-desc" });
      const archivedRecord = contentLines.find((line) => line.value["contentType"] === "achievement")?.value;
      expect(archivedRecord).toMatchObject({ lifecycle: "archived", publicRoute: null, lifecycleHistory: [
        expect.objectContaining({ previousLifecycle: "draft", lifecycle: "published" }),
        expect.objectContaining({ previousLifecycle: "published", lifecycle: "archived" }),
      ] });
      const testimonialRecord = contentLines.find((line) => line.value["contentType"] === "testimonial")?.value;
      expect(testimonialRecord).toMatchObject({
        lifecycle: "draft", publicRoute: null, publications: [], publicationHistory: [],
        revisions: expect.arrayContaining([
          expect.objectContaining({ locale: "en", sequence: 1, currentlyPublished: false }),
          expect.objectContaining({ locale: "ar", sequence: 1, currentlyPublished: false }),
        ]),
      });
      expect(testimonialRecord?.["revisions"][0]?.["payload"]["association"])
        .toEqual({ type: "project", projectId: projectA.contentId });
      const contentDependencies = (contentValidation.manifest as unknown as { dependencies: Array<Record<string, unknown>> }).dependencies;
      expect(contentDependencies).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceScope: "portfolio-content", sourceId: projectA.contentId, targetScope: "portfolio-content", targetId: projectB.contentId, disposition: "included" }),
        expect.objectContaining({ sourceScope: "portfolio-content", sourceId: projectA.contentId, targetScope: "taxonomy", targetId: taxonomyValue.valueId, disposition: "omitted", reason: "scope-not-selected" }),
      ]));

      const combined = await capture(["portfolio-content", "portfolio-configuration"]);
      const combinedBuilt = await buildSelectedOwnerExportPackage({
        exportId: createStableId("OwnerExport"), snapshot: combined as OwnerExportSelectedSnapshot,
      });
      const combinedBytes = await archiveBytes(combinedBuilt.content);
      const combinedValidation = validateOwnerExportZip(combinedBytes);
      const configuration = JSON.parse(new TextDecoder().decode(storedEntry(combinedBytes, "records/portfolio-configuration.ndjson")));
      expect(combinedValidation.includedScopes).toEqual(["portfolio-content", "portfolio-configuration"]);
      expect(combinedValidation.recordCounts).toEqual({ "portfolio-content": 5, "portfolio-configuration": 1 });
      expect(configuration.value.profile.displayName).toBe("Export fixture");
      const combinedDependencies = (combinedValidation.manifest as unknown as { dependencies: Array<Record<string, unknown>> }).dependencies;
      expect(combinedDependencies).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceScope: "portfolio-content", targetScope: "taxonomy", targetId: taxonomyValue.valueId, disposition: "omitted", reason: "scope-not-selected" }),
      ]));

      expect(await queryContentCount(scope.portfolioId, scope.ownerId, "content.owner-export")).toBe(5);
      expect(await queryContentCount(scope.portfolioId, scope.ownerId, "portability.configuration-export")).toBe(0);
      expect(await queryContentCount(scope.portfolioId, createStableId("Owner"), "content.owner-export")).toBe(0);
      expect(await queryContentCount(createStableId("Portfolio"), scope.ownerId, "content.owner-export")).toBe(0);
      const workerGrants = await admin.query(
        `select n.nspname || '.' || c.relname as table_name,
                has_table_privilege('shipwithali_worker', c.oid, 'select') as can_read,
                has_table_privilege('shipwithali_worker', c.oid, 'insert') as can_insert,
                has_table_privilege('shipwithali_worker', c.oid, 'update') as can_update,
                has_table_privilege('shipwithali_worker', c.oid, 'delete') as can_delete
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where (n.nspname = 'content' and c.relname = any($1::text[]))
             or (n.nspname = 'taxonomy' and c.relname = 'roots')
          order by n.nspname, c.relname`,
        [[
          "items", "project_status_values", "revisions", "revision_reviews", "language_publications",
          "testimonial_language_publications", "publication_history", "testimonial_publication_history",
          "lifecycle_history", "public_routes", "public_route_reservations", "public_route_history",
          "project_relationship_views", "project_relationship_history", "project_taxonomy_assignments",
        ]],
      );
      expect(workerGrants.rows).toHaveLength(16);
      expect(workerGrants.rows.every((row) => row["can_read"] === true && row["can_insert"] === false &&
        row["can_update"] === false && row["can_delete"] === false)).toBe(true);
      expect(contentValidation.verifiedSchemaCount).toBeGreaterThan(0);
      expect(combinedValidation.verifiedSchemaCount).toBeGreaterThan(0);
      expect(combinedValidation.dependencyCount).toBe(combinedDependencies.length);
      expect(contentBytes.byteLength).toBe(contentBuilt.contentLength);
      expect(combinedBytes.byteLength).toBe(combinedBuilt.contentLength);
    } finally {
      try {
        await admin.query("begin");
        // This runner owns a disposable PostgreSQL cluster. Suppress its
        // append-only/FK triggers only inside this cleanup transaction, then
        // delete each synthetic dependent row explicitly and verify emptiness.
        await admin.query("set local session_replication_role = replica");
        await admin.query("delete from operations.idempotency_records where actor_scope = $1", [ownerScopeHash]);
        if (fixtureAggregateIds.length > 0) {
          await admin.query("delete from operations.outbox_events where aggregate_id = any($1::uuid[])", [fixtureAggregateIds]);
        }
        for (const table of fixtureOwnedTables) {
          await admin.query(`delete from ${table} where portfolio_id = $1::uuid`, [scope.portfolioId]);
        }
        await admin.query("delete from portfolio_config.contact_channels where portfolio_id = $1::uuid", [scope.portfolioId]);
        await admin.query("delete from portfolio_config.settings where portfolio_id = $1::uuid", [scope.portfolioId]);
        const fixtureCounts: number[] = [];
        for (const table of fixtureOwnedTables) {
          const result = await admin.query(`select count(*)::int as count from ${table} where portfolio_id = $1::uuid`, [scope.portfolioId]);
          fixtureCounts.push(Number(result.rows[0]?.["count"] ?? -1));
        }
        const channelsRemaining = await admin.query("select count(*)::int as count from portfolio_config.contact_channels where portfolio_id = $1::uuid", [scope.portfolioId]);
        const settingsRemaining = await admin.query("select count(*)::int as count from portfolio_config.settings where portfolio_id = $1::uuid", [scope.portfolioId]);
        const idempotencyRemaining = await admin.query("select count(*)::int as count from operations.idempotency_records where actor_scope = $1", [ownerScopeHash]);
        const outboxRemaining = await admin.query("select count(*)::int as count from operations.outbox_events where aggregate_id = any($1::uuid[])", [fixtureAggregateIds]);
        fixtureCounts.push(
          Number(channelsRemaining.rows[0]?.["count"] ?? -1), Number(settingsRemaining.rows[0]?.["count"] ?? -1),
          Number(idempotencyRemaining.rows[0]?.["count"] ?? -1), Number(outboxRemaining.rows[0]?.["count"] ?? -1),
        );
        cleanupSucceeded = fixtureCounts.every((count) => count === 0);
        if (cleanupSucceeded) await admin.query("commit");
      } finally {
        if (!cleanupSucceeded) await admin.query("rollback").catch(() => undefined);
        await application.resource.close();
        await worker.resource.close();
        await admin.end();
      }
    }
    expect(cleanupSucceeded).toBe(true);
  }, 120_000);
});
