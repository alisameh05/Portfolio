import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getOperationsPersistence,
  getPhase5OwnerApplicationServices,
  initializeDatabaseRuntime,
  resetRuntimeForTests,
} from "../../src/bootstrap/composition-root.js";
import { createPortfolioSettingsService } from "../../src/modules/portfolio-configuration/application/settings-service.js";
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
      DATABASE_URL: applicationUrl.toString(),
      PORTFOLIO_ID: scope.portfolioId,
      OWNER_ID,
    }, "application");
    runtimeReady = true;

    const settings = createPortfolioSettingsService({
      repository: createPostgresPortfolioSettingsRepository(),
      transactions: getOperationsPersistence().transactions,
      scope,
    });
    const provisioned = await settings.provision({
      profile: { displayName: "Integration Owner", headline: "Phase 5 Owner", bio: "Private test fixture." },
      contactChannels: [],
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

  it("serves real Owner content, histories, Project controls and Taxonomy through the runtime assembly", async () => {
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

    const aggregate = await services.contentAuthoring.getOwnerContentAggregate({ actor, contentId: created.value.contentId });
    expect(aggregate).toMatchObject({ ok: true, value: { lifecycle: "published", revisions: [{ reviewed: true }] } });
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
    expect(await contentResponse.json()).toMatchObject({ contentId: created.value.contentId, lifecycle: "published" });
    const historyResponse = await handleGetOwnerContentHistory(
      ownerReadRequest(`/api/owner/v1/content/${created.value.contentId}/history?locale=en&limit=10`),
      { contentId: created.value.contentId },
      { service: services.contentAuthoring, security },
    );
    expect(historyResponse.status).toBe(200);
    expect(await historyResponse.json()).toMatchObject({ entries: [{ revisionId: created.value.revisionId }] });
    const projectResponse = await handleGetOwnerProjectAggregate(
      ownerReadRequest(`/api/owner/v1/projects/${created.value.contentId}`),
      { projectId: created.value.contentId },
      { service: services.project, security },
    );
    expect(projectResponse.status).toBe(200);
    expect(await projectResponse.json()).toMatchObject({ projectId: created.value.contentId });

    const statusCreated = await services.contentAuthoring.createProjectStatusValue({
      actor, label: "Owner assembly state", idempotencyKey: key("owner-assembly-status-create"), correlationId: "owner-assembly-status-create",
    });
    expect(statusCreated.ok).toBe(true);
    if (!statusCreated.ok) return;
    const changedStatus = await services.project.changeOwnerProjectStatus({
      actor, projectId: created.value.contentId as StableId<"Project">, statusValueId: statusCreated.value.valueId,
      expectedVersion: published.value.aggregateVersion, idempotencyKey: key("owner-assembly-status"), correlationId: "owner-assembly-status",
    });
    expect(changedStatus.ok).toBe(true);
    if (!changedStatus.ok) return;
    const featured = await services.project.setOwnerProjectFeatured({
      actor, projectId: created.value.contentId as StableId<"Project">, featured: true,
      expectedVersion: changedStatus.value.aggregateVersion, idempotencyKey: key("owner-assembly-featured"), correlationId: "owner-assembly-featured",
    });
    expect(featured.ok).toBe(true);
    const statusHistory = await services.contentAuthoring.getProjectStatusHistory({ actor, valueId: statusCreated.value.valueId });
    expect(statusHistory).toMatchObject({ ok: true, value: expect.arrayContaining([expect.objectContaining({ operation: "created", label: "Owner assembly state" })]) });
    const featuredProject = await services.project.getOwnerProjectAggregate({ actor, projectId: created.value.contentId as StableId<"Project"> });
    expect(featuredProject).toMatchObject({ ok: true, value: { featured: true, statusValueId: statusCreated.value.valueId } });

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
  }, 60_000);
});
