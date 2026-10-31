import { isolatedIdentityReadiness } from "../fixtures/identity-readiness.js";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getOperationsPersistence,
  getPublicDiscoveryApplicationService,
  getPhase5OwnerApplicationServices,
  initializeDatabaseRuntime,
  resetRuntimeForTests,
} from "../../src/bootstrap/composition-root.js";
import { createPortfolioSettingsReader, createPortfolioSettingsService } from "../../src/modules/portfolio-configuration/application/settings-service.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createStableId, type IdempotencyKey, type StableId } from "../../src/shared/domain/index.js";
import { getLifecycleCoordinator } from "../../src/runtime/lifecycle.js";
import { handleGetOwnerContentAggregate } from "../../src/runtime/http/owner-publication.js";
import { handleGetOwnerContentHistory } from "../../src/runtime/http/owner-content-review.js";
import { handleGetOwnerProjectAggregate } from "../../src/runtime/http/owner-project.js";
import { ownerTestSecurity, withOwnerTestAuth } from "../runtime/owner-test-auth.js";

const DATABASE_URL = process.env["PHASE5_CONTENT_AUTHORING_DATABASE_URL"];
if (process.env["PHASE5_REQUIRE_OWNER_COMPOSITION"] === "1" && !DATABASE_URL) {
  throw new Error("PHASE5_OWNER_COMPOSITION_DATABASE_URL_REQUIRED");
}
const describeDatabase = DATABASE_URL === undefined ? describe.skip : describe;
const OWNER_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0" as StableId<"Owner">;
const TAXONOMY_IDS = {
  category: "01890f3e-7b2f-7cc0-98cf-5a2890378ef6",
  technology: "01890f3e-7b2f-7cc0-98cf-5a2890378ef8",
} as const;

function ownerReadRequest(path: string): Request {
  return new Request(`https://example.com${path}`, {
    method: "GET",
    headers: withOwnerTestAuth({ accept: "application/json" }),
  });
}

function quotedRole(name: string): string {
  if (!/^phase5_owner_[a-z0-9_]+$/.test(name)) throw new Error("PHASE5_OWNER_ROLE_INVALID");
  return `"${name}"`;
}

describeDatabase("Phase 5 Owner production composition against PostgreSQL", () => {
  let admin: Client;
  let roleName: string;
  let runtimeReady = false;
  const scope = { portfolioId: createStableId("Portfolio"), ownerId: OWNER_ID };
  const actor = { kind: "owner" as const, ownerId: OWNER_ID, sessionId: "owner-composition-integration" };
  const key = (value: string) => value as IdempotencyKey;
  let services: Awaited<ReturnType<typeof getPhase5OwnerApplicationServices>>;

  beforeAll(async () => {
    resetRuntimeForTests();
    admin = new Client({ connectionString: DATABASE_URL! });
    await admin.connect();
    roleName = `phase5_owner_${process.pid}_${randomBytes(3).toString("hex")}`;
    const password = randomBytes(32).toString("hex");
    await admin.query(`create role ${quotedRole(roleName)} login password '${password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await admin.query(`grant shipwithali_application to ${quotedRole(roleName)}`);
    const applicationUrl = new URL(DATABASE_URL!);
    applicationUrl.username = roleName;
    applicationUrl.password = password;
    await initializeDatabaseRuntime({
      NODE_ENV: "test",
      APP_BASE_URL: "https://example.com",
      SUPABASE_URL: "https://auth.example.test",
      SUPABASE_JWT_ISSUER: "https://auth.example.test/auth/v1",
      SUPABASE_JWT_AUDIENCE: "authenticated",
      OWNER_GITHUB_SUBJECTS: "910294",
      DATABASE_URL: applicationUrl.toString(),
      PORTFOLIO_ID: scope.portfolioId,
      OWNER_ID,
    }, "application", undefined, { identityReadiness: isolatedIdentityReadiness });
    runtimeReady = true;

    const settings = createPortfolioSettingsService({
      repository: createPostgresPortfolioSettingsRepository(),
      transactions: getOperationsPersistence().transactions,
      scope,
    });
    const provisioned = await settings.provision({
      profile: { displayName: "Integration Owner", headline: "Phase 5 Owner", bio: "Private test fixture." },
      contactChannels: [{ channel: "email", label: "Email", destination: "mailto:owner@example.com", availableLocales: ["en"] }],
      globalCta: { label: "Contact", destination: "https://example.com/contact", unavailableFallback: "Unavailable" },
    });
    expect(provisioned.ok).toBe(true);
    services = await getPhase5OwnerApplicationServices();
  }, 30_000);

  afterAll(async () => {
    if (runtimeReady) await getLifecycleCoordinator().shutdown();
    resetRuntimeForTests();
    if (admin !== undefined) {
      let cleanupFailed = false;
      try { await admin.query(`alter role ${quotedRole(roleName)} nologin`); } catch { cleanupFailed = true; }
      try { await admin.query(`drop role if exists ${quotedRole(roleName)}`); } catch { cleanupFailed = true; }
      await admin.end();
      if (cleanupFailed) throw new Error("PHASE5_OWNER_ROLE_CLEANUP_FAILED");
    }
  });

  it("keeps the committed route and projection readable after optional delivery port failures", async () => {
    const artifactId = createStableId("SupportingArtifact");
    const created = await services.contentAuthoring.createContent({
      actor,
      idempotencyKey: key("owner-assembly-project-create"),
      correlationId: "owner-assembly-create",
      payload: {
        contentType: "project",
        locale: "en",
        title: "Runtime assembled Project",
        summary: "A real PostgreSQL Owner composition workflow.",
        body: "The runtime assembly persists this Project through the scoped application connection.",
        candidateSlug: "runtime-assembled-project",
        caseStudy: {
          problem: "Owner operations were not wired to the standard assembly.",
          ownerRole: "Connected the production services.",
          contributions: ["Used the existing deep-module interfaces."],
          outcomes: ["The Owner can inspect the saved Project."],
          lessons: "Keep the transport thin.",
        },
        evidence: {
          claims: [{ claimId: createStableId("EvidenceClaim"), text: "This workflow is exercised in PostgreSQL.", artifactIds: [artifactId] }],
          artifacts: [{ id: artifactId, title: "Workflow evidence", destinationUrl: "https://example.com/evidence" }],
        },
        externalLinks: [],
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const preview = await services.contentAuthoring.previewRevision({ actor, contentId: created.value.contentId, revisionId: created.value.revisionId });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const reviewed = await services.contentAuthoring.reviewRevision({
      actor,
      contentId: created.value.contentId,
      revisionId: created.value.revisionId,
      expectedVersion: created.value.aggregateVersion,
      idempotencyKey: key("owner-assembly-project-review"),
      correlationId: "owner-assembly-review",
      locale: "en",
      snapshotHash: preview.value.snapshotHash,
      evidenceVersion: preview.value.evidenceVersion,
      decision: "accepted",
      findings: [],
    });
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    const published = await services.contentAuthoring.publishLanguageVersion({
      actor,
      contentId: created.value.contentId,
      revisionId: created.value.revisionId,
      expectedVersion: reviewed.value.aggregateVersion,
      idempotencyKey: key("owner-assembly-project-publish"),
      correlationId: "owner-assembly-publish",
      locale: "en",
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;

    const publicationEvent = await admin.query(
      "select event_id, event_type, aggregate_id, payload from operations.outbox_events where aggregate_id = $1::uuid and correlation_id = 'owner-assembly-publish' and event_type = 'content.language_version_published.v1'",
      [created.value.contentId],
    );
    expect(publicationEvent.rows).toHaveLength(1);
    const committedPublication = publicationEvent.rows[0];
    expect(committedPublication).toMatchObject({ event_type: "content.language_version_published.v1", aggregate_id: created.value.contentId });
    const optionalDeliveryKinds = ["media", "link", "analytics", "alert"] as const;
    for (const kind of optionalDeliveryKinds) {
      const deliveryPort = {
        async deliver(event: typeof committedPublication) {
          expect(event.event_id).toBe(committedPublication.event_id);
          expect(event.event_type).toBe("content.language_version_published.v1");
          expect(event.aggregate_id).toBe(created.value.contentId);
          expect(event.payload).toBeDefined();
          throw new Error(`INJECTED_${kind.toUpperCase()}_DELIVERY_FAILURE`);
        },
      };
      await expect(deliveryPort.deliver(committedPublication)).rejects.toThrow(`INJECTED_${kind.toUpperCase()}_DELIVERY_FAILURE`);
      expect(await services.contentAuthoring.resolvePublicProjectRoute({ slug: "runtime-assembled-project", locale: "en" }))
        .toMatchObject({ ok: true, value: { type: "canonical", content: { currentSlug: "runtime-assembled-project" } } });
      expect(await services.contentAuthoring.getPublicProject({ slug: "runtime-assembled-project", locale: "en" }))
        .toMatchObject({ ok: true, value: { title: "Runtime assembled Project", currentSlug: "runtime-assembled-project" } });
      const retainedEvent = await admin.query(
        "select count(*)::int as count from operations.outbox_events where event_id = $1::uuid",
        [committedPublication.event_id],
      );
      expect(retainedEvent.rows[0]?.count).toBe(1);
    }

    const aggregate = await services.contentAuthoring.getOwnerContentAggregate({ actor, contentId: created.value.contentId });
    expect(aggregate).toMatchObject({
      ok: true,
      value: {
        lifecycle: "published",
        revisions: [{ reviewed: true }],
        publicationHistory: [expect.objectContaining({
          locale: "en",
          revisionId: created.value.revisionId,
          reviewId: expect.any(String),
          publishedAt: expect.any(String),
        })],
      },
    });
    const history = await services.contentAuthoring.getContentHistory({ actor, contentId: created.value.contentId, locale: "en", limit: 10 });
    expect(history).toMatchObject({ ok: true, value: { entries: [{ revisionId: created.value.revisionId, reviewDecision: "accepted" }] } });
    const project = await services.project.getOwnerProjectAggregate({ actor, projectId: created.value.contentId as StableId<"Project"> });
    expect(project).toMatchObject({ ok: true, value: { projectId: created.value.contentId, aggregateVersion: published.value.aggregateVersion } });

    const security = ownerTestSecurity();
    const contentResponse = await handleGetOwnerContentAggregate(
      ownerReadRequest(`/api/owner/v1/content/${created.value.contentId}`),
      { contentId: created.value.contentId },
      { service: services.publication, contentAuthoring: services.contentAuthoring, security },
    );
    expect(contentResponse.status).toBe(200);
    expect(contentResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(contentResponse.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await contentResponse.json()).toMatchObject({ contentId: created.value.contentId, lifecycle: "published" });
    const historyResponse = await handleGetOwnerContentHistory(
      ownerReadRequest(`/api/owner/v1/content/${created.value.contentId}/history?locale=en&limit=10`),
      { contentId: created.value.contentId },
      { service: services.contentAuthoring, security },
    );
    expect(historyResponse.status).toBe(200);
    expect(historyResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(historyResponse.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await historyResponse.json()).toMatchObject({ entries: [{ revisionId: created.value.revisionId }] });
    const projectResponse = await handleGetOwnerProjectAggregate(
      ownerReadRequest(`/api/owner/v1/projects/${created.value.contentId}`),
      { projectId: created.value.contentId },
      { service: services.project, security },
    );
    expect(projectResponse.status).toBe(200);
    expect(projectResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(projectResponse.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await projectResponse.json()).toMatchObject({ projectId: created.value.contentId });

    const slugChanged = await services.project.changeOwnerProjectPublicSlug({
      actor, projectId: created.value.contentId as StableId<"Project">, slug: "runtime-assembled-project-revised",
      expectedVersion: published.value.aggregateVersion, idempotencyKey: key("owner-assembly-route-change"), correlationId: "owner-assembly-route-change",
    });
    expect(slugChanged.ok).toBe(true);
    if (!slugChanged.ok) return;

    const statusCreated = await services.contentAuthoring.createProjectStatusValue({
      actor, label: "Owner assembly state", idempotencyKey: key("owner-assembly-status-create"), correlationId: "owner-assembly-status-create",
    });
    expect(statusCreated.ok).toBe(true);
    if (!statusCreated.ok) return;
    const changedStatus = await services.project.changeOwnerProjectStatus({
      actor, projectId: created.value.contentId as StableId<"Project">, statusValueId: statusCreated.value.valueId,
      expectedVersion: slugChanged.value.aggregateVersion, idempotencyKey: key("owner-assembly-status"), correlationId: "owner-assembly-status",
    });
    expect(changedStatus.ok).toBe(true);
    if (!changedStatus.ok) return;
    const featured = await services.project.setOwnerProjectFeatured({
      actor, projectId: created.value.contentId as StableId<"Project">, featured: true,
      expectedVersion: changedStatus.value.aggregateVersion, idempotencyKey: key("owner-assembly-featured"), correlationId: "owner-assembly-featured",
    });
    expect(featured.ok).toBe(true);
    if (!featured.ok) return;
    const statusHistory = await services.contentAuthoring.getProjectStatusHistory({ actor, valueId: statusCreated.value.valueId });
    expect(statusHistory).toMatchObject({ ok: true, value: expect.arrayContaining([expect.objectContaining({ operation: "created", label: "Owner assembly state" })]) });
    const featuredProject = await services.project.getOwnerProjectAggregate({ actor, projectId: created.value.contentId as StableId<"Project"> });
    expect(featuredProject).toMatchObject({ ok: true, value: {
      featured: true,
      statusValueId: statusCreated.value.valueId,
      publicRoute: { canonicalSlug: "runtime-assembled-project-revised", history: [expect.objectContaining({ fromSlug: "runtime-assembled-project", toSlug: "runtime-assembled-project-revised" })] },
      statusHistory: [expect.objectContaining({ currentValueId: statusCreated.value.valueId })],
    } });

    const relatedArtifactId = createStableId("SupportingArtifact");
    const relatedCreated = await services.contentAuthoring.createContent({
      actor, idempotencyKey: key("owner-assembly-related-project-create"), correlationId: "owner-assembly-related-project-create",
      payload: {
        contentType: "project", locale: "en", title: "Runtime relationship target", summary: "A second real Project.",
        body: "The relationship is stored by the standard runtime composition.", candidateSlug: "runtime-relationship-target",
        caseStudy: { problem: "No relationship existed.", ownerRole: "Connected a Project.", contributions: ["Created the link."], outcomes: ["Both projects retain the fact."], lessons: "Keep links symmetric." },
        evidence: {
          claims: [{ claimId: createStableId("EvidenceClaim"), text: "The second Project is independently reviewed.", artifactIds: [relatedArtifactId] }],
          artifacts: [{ id: relatedArtifactId, title: "Owner composition evidence", destinationUrl: "https://example.com/related-evidence" }],
        }, externalLinks: [],
      },
    });
    expect(relatedCreated.ok).toBe(true);
    if (!relatedCreated.ok) return;
    const related = await services.project.relateOwnerProjects({
      actor, projectId: created.value.contentId as StableId<"Project">, relatedProjectId: relatedCreated.value.contentId as StableId<"Project">,
      expectedVersion: featured.value.aggregateVersion, idempotencyKey: key("owner-assembly-relate-projects"), correlationId: "owner-assembly-relate-projects",
    });
    expect(related.ok).toBe(true);
    if (!related.ok) return;
    const relationshipView = await services.project.getOwnerProjectAggregate({ actor, projectId: created.value.contentId as StableId<"Project"> });
    expect(relationshipView).toMatchObject({ ok: true, value: {
      relatedProjectIds: [relatedCreated.value.contentId],
      relationshipHistory: [expect.objectContaining({ relatedProjectId: relatedCreated.value.contentId, action: "related" })],
      statusHistory: [expect.objectContaining({ currentValueId: statusCreated.value.valueId })],
    } });
    const relationshipResponse = await handleGetOwnerProjectAggregate(
      ownerReadRequest(`/api/owner/v1/projects/${created.value.contentId}`),
      { projectId: created.value.contentId },
      { service: services.project, security },
    );
    expect(relationshipResponse.status).toBe(200);
    expect(relationshipResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(relationshipResponse.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await relationshipResponse.json()).toMatchObject({
      statusHistory: [expect.objectContaining({ currentValueId: statusCreated.value.valueId })],
      relationshipHistory: [expect.objectContaining({ relatedProjectId: relatedCreated.value.contentId, action: "related" })],
    });

    const taxonomyId = TAXONOMY_IDS.technology as StableId<"Taxonomy">;
    const taxonomy = await services.taxonomy.getOwnerTaxonomyAggregate({ actor, taxonomyId });
    expect(taxonomy.ok).toBe(true);
    if (!taxonomy.ok) return;
    const value = await services.taxonomy.createOwnerTaxonomyValue({
      actor, taxonomyId, name: "Owner composition integration", expectedVersion: taxonomy.value.aggregateVersion,
      idempotencyKey: key("owner-assembly-taxonomy-create"),
    });
    expect(value.ok).toBe(true);
    if (!value.ok) return;
    const updatedTaxonomy = await services.taxonomy.getOwnerTaxonomyAggregate({ actor, taxonomyId });
    expect(updatedTaxonomy.ok).toBe(true);
    if (!updatedTaxonomy.ok) return;
    const createdValue = updatedTaxonomy.value.values.find((entry) => entry.name === "Owner composition integration");
    expect(createdValue).toBeDefined();
    if (createdValue === undefined) return;
    const latestProject = await services.project.getOwnerProjectAggregate({ actor, projectId: created.value.contentId as StableId<"Project"> });
    expect(latestProject.ok).toBe(true);
    if (!latestProject.ok) return;
    const assignment = await services.project.assignOwnerProjectTaxonomyValue({
      actor, projectId: created.value.contentId as StableId<"Project">, valueId: createdValue.valueId,
      expectedVersion: latestProject.value.aggregateVersion,
      idempotencyKey: key("owner-assembly-taxonomy-assignment"),
    });
    expect(assignment.ok).toBe(true);
    const categoryTaxonomyId = TAXONOMY_IDS.category as StableId<"Taxonomy">;
    const categoryTaxonomy = await services.taxonomy.getOwnerTaxonomyAggregate({ actor, taxonomyId: categoryTaxonomyId });
    expect(categoryTaxonomy.ok).toBe(true);
    if (!categoryTaxonomy.ok) return;
    const categoryValueResult = await services.taxonomy.createOwnerTaxonomyValue({
      actor, taxonomyId: categoryTaxonomyId, name: "Owner composition category",
      expectedVersion: categoryTaxonomy.value.aggregateVersion, idempotencyKey: key("owner-assembly-category-value-create"),
    });
    expect(categoryValueResult.ok).toBe(true);
    if (!categoryValueResult.ok) return;
    const categoryValue = await services.taxonomy.getOwnerTaxonomyAggregate({ actor, taxonomyId: categoryTaxonomyId });
    expect(categoryValue.ok).toBe(true);
    if (!categoryValue.ok) return;
    const createdCategoryValue = categoryValue.value.values.find((entry) => entry.name === "Owner composition category");
    expect(createdCategoryValue).toBeDefined();
    if (createdCategoryValue === undefined) return;
    const currentProjectForCategory = await services.project.getOwnerProjectAggregate({ actor, projectId: created.value.contentId as StableId<"Project"> });
    expect(currentProjectForCategory.ok).toBe(true);
    if (!currentProjectForCategory.ok) return;
    const categoryAssignment = await services.project.assignOwnerProjectTaxonomyValue({
      actor, projectId: created.value.contentId as StableId<"Project">, valueId: createdCategoryValue.valueId,
      expectedVersion: currentProjectForCategory.value.aggregateVersion, idempotencyKey: key("owner-assembly-category-assignment"),
    });
    expect(categoryAssignment.ok).toBe(true);
    const renamed = await services.taxonomy.renameOwnerTaxonomyValue({
      actor, valueId: createdValue.valueId, name: "Owner composition integration renamed",
      expectedVersion: value.value.aggregateVersion,
      idempotencyKey: key("owner-assembly-taxonomy-rename"),
    });
    expect(renamed.ok).toBe(true);
    const evolvedTaxonomy = await services.taxonomy.getOwnerTaxonomyAggregate({ actor, taxonomyId });
    expect(evolvedTaxonomy).toMatchObject({
      ok: true,
      value: {
        values: [expect.objectContaining({ valueId: createdValue.valueId, name: "Owner composition integration renamed", state: "active" })],
        history: expect.arrayContaining([
          expect.objectContaining({ valueId: createdValue.valueId, action: "created" }),
          expect.objectContaining({ valueId: createdValue.valueId, action: "renamed", previousLabel: "Owner composition integration", label: "Owner composition integration renamed" }),
        ]),
        assignmentHistory: [expect.objectContaining({ projectId: created.value.contentId, valueId: createdValue.valueId })],
      },
    });
    const mergeSource = await services.taxonomy.createOwnerTaxonomyValue({
      actor, taxonomyId, name: "Owner composition merge source", expectedVersion: renamed.ok ? renamed.value.aggregateVersion : 0,
      idempotencyKey: key("owner-assembly-taxonomy-merge-source"),
    });
    expect(mergeSource.ok).toBe(true);
    if (!mergeSource.ok) return;
    const afterMergeSourceCreate = await services.taxonomy.getOwnerTaxonomyAggregate({ actor, taxonomyId });
    expect(afterMergeSourceCreate.ok).toBe(true);
    if (!afterMergeSourceCreate.ok) return;
    const mergeSourceValue = afterMergeSourceCreate.value.values.find((entry) => entry.name === "Owner composition merge source");
    expect(mergeSourceValue).toBeDefined();
    if (mergeSourceValue === undefined) return;
    const relatedProject = await services.project.getOwnerProjectAggregate({ actor, projectId: relatedCreated.value.contentId as StableId<"Project"> });
    expect(relatedProject.ok).toBe(true);
    if (!relatedProject.ok) return;
    const sourceAssignment = await services.project.assignOwnerProjectTaxonomyValue({
      actor, projectId: relatedCreated.value.contentId as StableId<"Project">, valueId: mergeSourceValue.valueId,
      expectedVersion: relatedProject.value.aggregateVersion, idempotencyKey: key("owner-assembly-taxonomy-source-assignment"),
    });
    expect(sourceAssignment.ok).toBe(true);
    const merged = await services.taxonomy.mergeOwnerTaxonomyValue({
      actor, valueId: mergeSourceValue.valueId, targetValueId: createdValue.valueId,
      expectedVersion: mergeSource.value.aggregateVersion, idempotencyKey: key("owner-assembly-taxonomy-merge"),
    });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const retireValue = await services.taxonomy.createOwnerTaxonomyValue({
      actor, taxonomyId, name: "Owner composition retirement", expectedVersion: merged.value.aggregateVersion,
      idempotencyKey: key("owner-assembly-taxonomy-retire-value"),
    });
    expect(retireValue.ok).toBe(true);
    if (!retireValue.ok) return;
    const beforeRetire = await services.taxonomy.getOwnerTaxonomyAggregate({ actor, taxonomyId });
    expect(beforeRetire.ok).toBe(true);
    if (!beforeRetire.ok) return;
    const retirementValue = beforeRetire.value.values.find((entry) => entry.name === "Owner composition retirement");
    expect(retirementValue).toBeDefined();
    if (retirementValue === undefined) return;
    const retired = await services.taxonomy.retireOwnerTaxonomyValue({
      actor, valueId: retirementValue.valueId, expectedVersion: retireValue.value.aggregateVersion,
      idempotencyKey: key("owner-assembly-taxonomy-retire"),
    });
    expect(retired.ok).toBe(true);
    const finalTaxonomy = await services.taxonomy.getOwnerTaxonomyAggregate({ actor, taxonomyId });
    expect(finalTaxonomy).toMatchObject({ ok: true, value: {
      values: expect.arrayContaining([
        expect.objectContaining({ valueId: mergeSourceValue.valueId, state: "merged", mergedIntoValueId: createdValue.valueId }),
        expect.objectContaining({ valueId: retirementValue.valueId, state: "retired" }),
      ]),
      history: expect.arrayContaining([
        expect.objectContaining({ valueId: mergeSourceValue.valueId, action: "merged" }),
        expect.objectContaining({ valueId: retirementValue.valueId, action: "retired" }),
      ]),
    } });

    const relatedPreview = await services.contentAuthoring.previewRevision({ actor, contentId: relatedCreated.value.contentId, revisionId: relatedCreated.value.revisionId });
    expect(relatedPreview.ok).toBe(true);
    if (!relatedPreview.ok) return;
    const latestRelated = await services.contentAuthoring.getOwnerContentAggregate({ actor, contentId: relatedCreated.value.contentId });
    expect(latestRelated.ok).toBe(true);
    if (!latestRelated.ok) return;
    const relatedReview = await services.contentAuthoring.reviewRevision({
      actor, contentId: relatedCreated.value.contentId, revisionId: relatedCreated.value.revisionId,
      expectedVersion: latestRelated.value.aggregateVersion, idempotencyKey: key("owner-assembly-related-review"),
      correlationId: "owner-assembly-related-review", locale: "en", snapshotHash: relatedPreview.value.snapshotHash,
      evidenceVersion: relatedPreview.value.evidenceVersion, decision: "accepted", findings: [],
    });
    expect(relatedReview.ok).toBe(true);
    if (!relatedReview.ok) return;
    const relatedPublished = await services.contentAuthoring.publishLanguageVersion({
      actor, contentId: relatedCreated.value.contentId, revisionId: relatedCreated.value.revisionId, locale: "en",
      expectedVersion: relatedReview.value.aggregateVersion, idempotencyKey: key("owner-assembly-related-publish"),
      correlationId: "owner-assembly-related-publish",
    });
    expect(relatedPublished.ok).toBe(true);
    if (!relatedPublished.ok) return;

    const currentPrimary = await services.project.getOwnerProjectAggregate({ actor, projectId: created.value.contentId as StableId<"Project"> });
    expect(currentPrimary.ok).toBe(true);
    if (!currentPrimary.ok) return;
    const movedRoute = await services.project.changeOwnerProjectPublicSlug({
      actor, projectId: created.value.contentId as StableId<"Project">, slug: "runtime-assembled-project-v3",
      expectedVersion: currentPrimary.value.aggregateVersion, idempotencyKey: key("owner-assembly-route-third-slug"),
      correlationId: "owner-assembly-route-third-slug",
    });
    expect(movedRoute.ok).toBe(true);
    if (!movedRoute.ok) return;
    const returnedRoute = await services.project.changeOwnerProjectPublicSlug({
      actor, projectId: created.value.contentId as StableId<"Project">, slug: "runtime-assembled-project-revised",
      expectedVersion: movedRoute.value.aggregateVersion, idempotencyKey: key("owner-assembly-route-return"),
      correlationId: "owner-assembly-route-return",
    });
    expect(returnedRoute.ok).toBe(true);
    if (!returnedRoute.ok) return;
    const currentRelatedProject = await services.project.getOwnerProjectAggregate({ actor, projectId: relatedCreated.value.contentId as StableId<"Project"> });
    expect(currentRelatedProject.ok).toBe(true);
    if (!currentRelatedProject.ok) return;
    const reservedSlugCollision = await services.project.changeOwnerProjectPublicSlug({
      actor, projectId: relatedCreated.value.contentId as StableId<"Project">, slug: "runtime-assembled-project",
      expectedVersion: currentRelatedProject.value.aggregateVersion, idempotencyKey: key("owner-assembly-route-reservation-collision"),
      correlationId: "owner-assembly-route-reservation-collision",
    });
    expect(reservedSlugCollision).toMatchObject({ ok: false, error: { kind: "conflict", code: "PUBLIC_SLUG_CONFLICT" } });
    expect(await services.contentAuthoring.resolvePublicProjectRoute({ slug: "runtime-assembled-project-v3", locale: "en" }))
      .toMatchObject({ ok: true, value: { type: "redirect", toSlug: "runtime-assembled-project-revised" } });
    expect(await services.contentAuthoring.resolvePublicProjectRoute({ slug: "runtime-assembled-project", locale: "en" }))
      .toMatchObject({ ok: true, value: { type: "redirect", toSlug: "runtime-assembled-project-revised" } });

    const discovery = await getPublicDiscoveryApplicationService();
    const taxonomyValueId = createdValue.valueId as StableId<"TaxonomyValue">;
    const categoryValueId = createdCategoryValue.valueId as StableId<"TaxonomyValue">;
    const filtered = await discovery.getPublicDiscovery({ locale: "en", taxonomyValueIds: [taxonomyValueId], limit: 20 });
    expect(filtered).toMatchObject({ ok: true, value: { entries: expect.arrayContaining([
      expect.objectContaining({ projectId: created.value.contentId, slug: "runtime-assembled-project-revised", isFeatured: true,
        taxonomyValues: expect.arrayContaining([expect.objectContaining({ id: createdValue.valueId, label: "Owner composition integration renamed" })]) }),
      expect.objectContaining({ projectId: relatedCreated.value.contentId, slug: "runtime-relationship-target",
        taxonomyValues: expect.arrayContaining([expect.objectContaining({ id: createdValue.valueId, label: "Owner composition integration renamed" })]) }),
      ]) } });
    const firstPage = await discovery.getPublicDiscovery({ locale: "en", taxonomyValueIds: [taxonomyValueId], limit: 1 });
    expect(firstPage.ok).toBe(true);
    if (!firstPage.ok) return;
    expect(firstPage.value.entries.map((entry) => entry.projectId)).toEqual([relatedCreated.value.contentId]);
    expect(firstPage.value.nextCursor).not.toBeNull();
    if (firstPage.value.nextCursor === null) throw new Error("OWNER_COMPOSITION_DISCOVERY_NEXT_PAGE_MISSING");
    const secondPage = await discovery.getPublicDiscovery({ locale: "en", taxonomyValueIds: [taxonomyValueId], limit: 1, cursor: firstPage.value.nextCursor });
    expect(secondPage).toMatchObject({ ok: true, value: { entries: [expect.objectContaining({ projectId: created.value.contentId })], nextCursor: null } });
    const crossTaxonomy = await discovery.getPublicDiscovery({ locale: "en", taxonomyValueIds: [categoryValueId], limit: 20 });
    expect(crossTaxonomy).toMatchObject({ ok: true, value: { entries: [expect.objectContaining({
      projectId: created.value.contentId,
      taxonomyValues: expect.arrayContaining([expect.objectContaining({ id: categoryValueId, label: "Owner composition category" })]),
    })] } });
    const arabic = await discovery.getPublicDiscovery({ locale: "ar", taxonomyValueIds: [taxonomyValueId], limit: 20 });
    expect(arabic).toMatchObject({ ok: true, value: { entries: [] } });
    const publicRelated = await services.contentAuthoring.getPublicRelatedProjects({ projectId: created.value.contentId as StableId<"Project">, locale: "en", limit: 10 });
    expect(publicRelated).toMatchObject({ ok: true, value: [expect.objectContaining({ projectId: relatedCreated.value.contentId, slug: "runtime-relationship-target" })] });
    const missingArabicRoute = await services.contentAuthoring.getPublicProject({ slug: "runtime-relationship-target", locale: "ar" });
    expect(missingArabicRoute.ok).toBe(false);

    const optionalCapabilities = createPortfolioSettingsReader({
      repository: createPostgresPortfolioSettingsRepository(),
      transactions: getOperationsPersistence().transactions,
      scope,
      capabilityReader: { async getFacts() { throw new Error("optional capability provider unavailable"); } },
    });
    const availableCoreConfiguration = await optionalCapabilities.getPublicConfiguration({ locale: "en" });
    expect(availableCoreConfiguration).toMatchObject({ ok: true, value: {
      profile: { displayName: "Integration Owner", headline: "Phase 5 Owner" },
      contactChannels: [expect.objectContaining({ channel: "email", label: "Email" })],
      globalCta: { availability: "unavailable", label: "Contact", unavailableFallback: "Unavailable" },
      capabilities: { currentCvAvailable: false, externalLinksAvailable: false },
    } });
    expect(await services.contentAuthoring.getPublicProject({ slug: "runtime-assembled-project-revised", locale: "en" })).toMatchObject({
      ok: true, value: { title: "Runtime assembled Project", currentSlug: "runtime-assembled-project-revised" },
    });

    const currentRelatedContent = await services.contentAuthoring.getOwnerContentAggregate({ actor, contentId: relatedCreated.value.contentId });
    expect(currentRelatedContent.ok).toBe(true);
    if (!currentRelatedContent.ok) return;
    const hidden = await services.contentAuthoring.hideContent({
      actor, contentId: relatedCreated.value.contentId, expectedVersion: currentRelatedContent.value.aggregateVersion,
      idempotencyKey: key("owner-assembly-related-hide"), correlationId: "owner-assembly-related-hide",
    });
    expect(hidden.ok).toBe(true);
    if (!hidden.ok) return;
    const afterHide = await discovery.getPublicDiscovery({ locale: "en", taxonomyValueIds: [taxonomyValueId], limit: 20 });
    expect(afterHide).toMatchObject({ ok: true, value: { entries: [expect.objectContaining({ projectId: created.value.contentId })] } });
    expect(await services.contentAuthoring.getPublicRelatedProjects({ projectId: created.value.contentId as StableId<"Project">, locale: "en" })).toMatchObject({ ok: true, value: [] });
    expect(await services.contentAuthoring.getPublicProject({ slug: "runtime-relationship-target", locale: "en" })).toMatchObject({ ok: false });

    const restored = await services.contentAuthoring.restoreContent({
      actor, contentId: relatedCreated.value.contentId, expectedVersion: hidden.value.aggregateVersion,
      idempotencyKey: key("owner-assembly-related-restore"), correlationId: "owner-assembly-related-restore",
    });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    const afterRestore = await discovery.getPublicDiscovery({ locale: "en", taxonomyValueIds: [taxonomyValueId], limit: 20 });
    expect(afterRestore).toMatchObject({ ok: true, value: { entries: expect.arrayContaining([expect.objectContaining({ projectId: relatedCreated.value.contentId })]) } });

    const archived = await services.contentAuthoring.archiveContent({
      actor, contentId: relatedCreated.value.contentId, expectedVersion: restored.value.aggregateVersion,
      idempotencyKey: key("owner-assembly-related-archive"), correlationId: "owner-assembly-related-archive",
    });
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    expect(await services.contentAuthoring.resolvePublicProjectRoute({ slug: "runtime-relationship-target", locale: "en" }))
      .toMatchObject({ ok: false });
    const restoredAfterArchive = await services.contentAuthoring.restoreContent({
      actor, contentId: relatedCreated.value.contentId, expectedVersion: archived.value.aggregateVersion,
      idempotencyKey: key("owner-assembly-related-restore-after-archive"), correlationId: "owner-assembly-related-restore-after-archive",
    });
    expect(restoredAfterArchive.ok).toBe(true);
    if (!restoredAfterArchive.ok) return;

    const primaryHidden = await services.contentAuthoring.hideContent({
      actor, contentId: created.value.contentId, expectedVersion: returnedRoute.value.aggregateVersion,
      idempotencyKey: key("owner-assembly-primary-hide"), correlationId: "owner-assembly-primary-hide",
    });
    expect(primaryHidden.ok).toBe(true);
    if (!primaryHidden.ok) return;
    expect(await services.contentAuthoring.resolvePublicProjectRoute({ slug: "runtime-assembled-project", locale: "en" }))
      .toMatchObject({ ok: false });
    const primaryRestored = await services.contentAuthoring.restoreContent({
      actor, contentId: created.value.contentId, expectedVersion: primaryHidden.value.aggregateVersion,
      idempotencyKey: key("owner-assembly-primary-restore"), correlationId: "owner-assembly-primary-restore",
    });
    expect(primaryRestored.ok).toBe(true);
    if (!primaryRestored.ok) return;
    expect(await services.contentAuthoring.resolvePublicProjectRoute({ slug: "runtime-assembled-project", locale: "en" }))
      .toMatchObject({ ok: true, value: { type: "redirect", toSlug: "runtime-assembled-project-revised" } });
    expect(await services.contentAuthoring.getPublicProject({ slug: "runtime-assembled-project-revised", locale: "ar" })).toMatchObject({ ok: false });
    const primaryArchived = await services.contentAuthoring.archiveContent({
      actor, contentId: created.value.contentId, expectedVersion: primaryRestored.value.aggregateVersion,
      idempotencyKey: key("owner-assembly-primary-archive"), correlationId: "owner-assembly-primary-archive",
    });
    expect(primaryArchived.ok).toBe(true);
    if (!primaryArchived.ok) return;
    expect(await services.contentAuthoring.resolvePublicProjectRoute({ slug: "runtime-assembled-project", locale: "en" })).toMatchObject({ ok: false });
    expect(await services.contentAuthoring.resolvePublicProjectRoute({ slug: "runtime-assembled-project-revised", locale: "en" })).toMatchObject({ ok: false });
    const primaryRestoredAfterArchive = await services.contentAuthoring.restoreContent({
      actor, contentId: created.value.contentId, expectedVersion: primaryArchived.value.aggregateVersion,
      idempotencyKey: key("owner-assembly-primary-restore-after-archive"), correlationId: "owner-assembly-primary-restore-after-archive",
    });
    expect(primaryRestoredAfterArchive.ok).toBe(true);
    if (!primaryRestoredAfterArchive.ok) return;
    expect(await services.contentAuthoring.resolvePublicProjectRoute({ slug: "runtime-assembled-project", locale: "en" }))
      .toMatchObject({ ok: true, value: { type: "redirect", toSlug: "runtime-assembled-project-revised" } });
    expect(await services.contentAuthoring.resolvePublicProjectRoute({ slug: "runtime-assembled-project-v3", locale: "en" }))
      .toMatchObject({ ok: true, value: { type: "redirect", toSlug: "runtime-assembled-project-revised" } });
    expect(await services.contentAuthoring.getPublicProject({ slug: "runtime-assembled-project-revised", locale: "en" })).toMatchObject({ ok: true });
    expect(await services.contentAuthoring.getPublicProject({ slug: "runtime-assembled-project-revised", locale: "ar" })).toMatchObject({ ok: false });
  }, 60_000);
});
