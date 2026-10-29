import { afterAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createStableId, parseIdempotencyKey, parseStableId, type Result, type Rejection } from "../../src/shared/domain/index.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createOperationsReadiness } from "../../src/modules/portability-operations/application/operations-readiness.js";
import { createIncidentLifecycleService } from "../../src/modules/portability-operations/application/incident-lifecycle.js";
import { createPostgresIncidentLifecycleStore } from "../../src/modules/portability-operations/adapters/postgres-incident-lifecycle.js";
import { CORE_INCIDENT_RULES } from "../../src/modules/portability-operations/application/incident-policy.js";
import { createOperationsSummaryService, OPERATIONS_SUMMARY_PURPOSE } from "../../src/modules/portability-operations/application/operations-observability.js";
import { createPostgresOperationsSummaryReader } from "../../src/modules/portability-operations/adapters/postgres-operations-summary.js";
import { createContentAuthoringService } from "../../src/modules/content-publishing/application/authoring.js";
import { createPostgresContentAuthoringRepository } from "../../src/modules/content-publishing/adapters/postgres-authoring.js";
import { createPostgresProjectDiscoveryProjectionWriter } from "../../src/modules/taxonomy-discovery/adapters/postgres-project-discovery.js";
import { createPostgresContentTaxonomyAssignmentsPort } from "../../src/modules/content-publishing/adapters/postgres-taxonomy-assignments.js";
import { createTaxonomyOwnerService } from "../../src/modules/taxonomy-discovery/application/owner-taxonomies.js";
import { createPostgresTaxonomyOwnerRepository } from "../../src/modules/taxonomy-discovery/adapters/postgres-owner-taxonomies.js";
import { createMediaAcceptanceApplicationService } from "../../src/modules/media/application/acceptance.js";
import { createPostgresMediaAcceptanceRepository } from "../../src/modules/media/adapters/postgres-acceptance.js";
import { createPostgresCvPortfolioRepository, createPostgresCurrentCvSnapshotRepository } from "../../src/modules/cv-portfolio/adapters/postgres-portfolio.js";
import { createOwnerCvApplicationService } from "../../src/modules/cv-portfolio/application/owner-service.js";
import { createFeedbackApplicationService, createOwnerFeedbackModerationService } from "../../src/modules/interaction-moderation/index.js";
import { createPostgresFeedbackSubmissionRepository } from "../../src/modules/interaction-moderation/adapters/postgres-feedback.js";
import { createPostgresModerationRepository } from "../../src/modules/interaction-moderation/adapters/postgres-moderation.js";
import { createPostgresProjectInteractionFacts } from "../../src/modules/content-publishing/adapters/postgres-interaction-facts.js";
import { decideAuthorization } from "../../src/modules/identity-access/index.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";
import { createLifecycleCoordinator } from "../../src/runtime/lifecycle.js";
import { createCheckedReadyzResponse } from "../../src/runtime/readyz.js";
import { seedAcceptedMedia } from "./optional-outage-fixture.js";
import { createCurrentCvDeliveryService } from "../../src/modules/cv-portfolio/application/current-delivery.js";
import { parseSafeErrorCode } from "../../src/modules/portability-operations/application/persistence.js";
import { initializeDatabaseRuntime, resetRuntimeForTests } from "../../src/bootstrap/composition-root.js";
import { getLifecycleCoordinator } from "../../src/runtime/lifecycle.js";

const adminUrl = process.env["OPERATIONS_INCIDENT_SCENARIO_ADMIN_URL"];
const applicationUrl = process.env["OPERATIONS_INCIDENT_SCENARIO_APPLICATION_URL"];
const workerUrl = process.env["OPERATIONS_INCIDENT_SCENARIO_WORKER_URL"];
function value<T>(result: Result<T, Rejection>): T {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
}
function key() { return value(parseIdempotencyKey(createStableId("Request"))); }

describe.runIf(Boolean(adminUrl && applicationUrl && workerUrl))("optional outage PostgreSQL qualification", () => {
  const application = createPostgresRuntimeDatabase(applicationUrl ?? "postgres://invalid");
  const worker = createPostgresRuntimeDatabase(workerUrl ?? "postgres://invalid");
  const admin = new Client({ connectionString: adminUrl });
  afterAll(async () => { await application.resource.close(); await worker.resource.close(); await admin.end(); });

  it("#252 AC07 Scenario 15 preserves published routes, Current CV, taxonomy and Moderation through optional outages", async () => {
    await admin.connect();
    const scope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    const actor = { kind: "owner" as const, ownerId: scope.ownerId, sessionId: "isolated-owner" };
    const clock = { now: () => new Date().toISOString() };
    const operations = createPostgresOperationsPersistence(application.database, clock);
    await admin.query(`insert into portfolio_config.settings
      (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback)
      values ($1,$2,'Synthetic Owner','Headline','Bio','Contact','https://example.test','Unavailable')`, [scope.portfolioId, scope.ownerId]);
    const discovery = createPostgresProjectDiscoveryProjectionWriter();
    const content = createContentAuthoringService({ operations, scope, clock,
      repository: createPostgresContentAuthoringRepository(), discoveryProjection: discovery, taxonomyAssignments: discovery });
    const artifact = createStableId("SupportingArtifact");
    const slug = "outage-project";
    const created = value(await content.createContent({ actor, idempotencyKey: key(), correlationId: "scenario15",
      payload: { contentType: "project", locale: "en", title: "Durable project", summary: "Last-valid publication", body: "Synthetic public case study.", candidateSlug: slug,
        caseStudy: { problem: "Preserve core reads.", ownerRole: "Engineer", contributions: ["Bound optional effects"], outcomes: ["Core state survives"], lessons: "Separate capabilities" },
        evidence: { claims: [{ claimId: createStableId("EvidenceClaim"), text: "Isolated database proof", artifactIds: [artifact] }],
          artifacts: [{ id: artifact, title: "Proof", destinationUrl: "https://example.test/proof" }] }, externalLinks: [] } }));
    const preview = value(await content.previewRevision({ actor, contentId: created.contentId, revisionId: created.revisionId }));
    const reviewed = value(await content.reviewRevision({ actor, contentId: created.contentId, revisionId: created.revisionId,
      expectedVersion: created.aggregateVersion, idempotencyKey: key(), correlationId: "scenario15", locale: "en",
      snapshotHash: preview.snapshotHash, evidenceVersion: preview.evidenceVersion, decision: "accepted", findings: [] }));
    const published = value(await content.publishLanguageVersion({ actor, contentId: created.contentId, revisionId: created.revisionId,
      expectedVersion: reviewed.aggregateVersion, idempotencyKey: key(), correlationId: "scenario15", locale: "en" }));
    const projectId = created.contentId as ReturnType<typeof createStableId<"Project">>;

    const root = await admin.query("select taxonomy_id from taxonomy.roots where portfolio_id=$1 and kind='technology'", [scope.portfolioId]);
    const taxonomyId = value(parseStableId("Taxonomy", root.rows[0]?.taxonomy_id));
    const taxonomy = createTaxonomyOwnerService({ operations, scope, repository: createPostgresTaxonomyOwnerRepository(),
      contentAssignments: createPostgresContentTaxonomyAssignmentsPort({ scope, discovery }) });
    value(await taxonomy.createOwnerTaxonomyValue({ actor, taxonomyId, expectedVersion: 1, idempotencyKey: key(), name: "Reliable systems" }));
    const taxonomyValues = value(await taxonomy.getOwnerTaxonomy({ actor, taxonomyId }));
    value(await content.assignProjectTaxonomyValue({ actor, projectId, valueId: taxonomyValues.values[0]!.valueId,
      expectedVersion: published.aggregateVersion, idempotencyKey: key(), correlationId: "scenario15" }));
    const taxonomyBefore = value(await taxonomy.getOwnerTaxonomy({ actor, taxonomyId }));

    const acceptedMedia = await seedAcceptedMedia(admin, { ...scope, mediaId: createStableId("MediaAsset") });
    const media = createMediaAcceptanceApplicationService({ scope, repository: createPostgresMediaAcceptanceRepository({
      database: application.database, transactions: application.transactions, scope }), preflight: async () => ({ ok: true, value: undefined }) });
    const cv = createOwnerCvApplicationService({ ownerId: scope.ownerId, repository: createPostgresCvPortfolioRepository({
      database: application.database, transactions: application.transactions, scope, media }) });
    const registered = value(await cv.registerOwnerCvVersion({ actor, expectedVersion: 1, mediaId: acceptedMedia.mediaId,
      locale: "en", label: "Last valid CV", idempotencyKey: key() }));
    const accepted = value(await cv.acceptOwnerCvVersion({ actor, expectedVersion: registered.aggregateVersion,
      versionId: registered.versionId, idempotencyKey: key() }));
    value(await cv.activateOwnerCvVersion({ actor, expectedVersion: accepted.aggregateVersion,
      versionId: registered.versionId, idempotencyKey: key() }));
    const currentCv = createPostgresCurrentCvSnapshotRepository({ database: application.database, transactions: application.transactions, scope, media });
    const cvBefore = value(await currentCv.getCurrentCvSnapshot());

    const facts = createPostgresProjectInteractionFacts(scope);
    const moderation = createOwnerFeedbackModerationService({ scope, operations, content: facts,
      repository: createPostgresModerationRepository(), clock, ids: createSystemIdGenerator(), authorize: async (q) => decideAuthorization(q) });
    const feedback = createFeedbackApplicationService({ portfolioId: scope.portfolioId, operations, content: facts,
      repository: createPostgresFeedbackSubmissionRepository(), clock, ids: createSystemIdGenerator() });
    const submitted = value(await feedback.submitFeedback({ scope: { kind: "portfolio", portfolioId: scope.portfolioId },
      actor: { kind: "visitor", consent: "denied" }, projectId, locale: "en", authorName: "Synthetic visitor", comment: "Synthetic feedback",
      idempotencyKey: key(), correlationId: "scenario15" }));
    value(await moderation.approveOwnerFeedback({ scope: { kind: "portfolio", portfolioId: scope.portfolioId }, actor,
      feedbackId: submitted.id, expectedVersion: 1, reason: "Approved synthetic fixture", idempotencyKey: key(), correlationId: "scenario15" }));
    const page = () => moderation.getApprovedFeedback({ scope: { kind: "portfolio" as const, portfolioId: scope.portfolioId },
      portfolioId: scope.portfolioId, projectId, locale: "en", correlationId: "scenario15" });
    const feedbackBefore = value(await page());
    const publicBefore = value(await content.getPublicProject({ slug, locale: "en" }));
    const routeBefore = value(await content.resolvePublicProjectRoute({ slug, locale: "en" }));

    // Optional work executes after the domain commits, through the existing
    // durable lease/failure seam. Each isolated provider refuses its effect.
    const work = createPostgresOperationsPersistence(worker.database);
    for (const capability of ["export", "measurement", "backup"] as const) {
      const jobId = createStableId("Job");
      const jobType = `fixture.optional-${capability}.v1`;
      await work.transactions.run((tx) => work.jobs.enqueue(tx, { jobId, availableAt: clock.now(),
        payload: { type: jobType, version: 1, value: {} } }));
      const [claim] = await work.jobs.claimDue({ workerId: "isolated-scenario15", now: clock.now(),
        leaseDurationSeconds: 30, limit: 1, jobTypes: [jobType] });
      expect(claim?.jobId).toBe(jobId);
      if (!claim) throw new Error("SCENARIO15_OPTIONAL_CLAIM_MISSING");
      expect(await work.jobs.fail(jobId, claim.leaseToken, parseSafeErrorCode("OPTIONAL_PROVIDER_UNAVAILABLE"))).toBe(true);
    }
    const cvDelivery = createCurrentCvDeliveryService({ repository: currentCv, storage: {
      async stream() { return { ok: false, error: { kind: "temporarily_unavailable", code: "CURRENT_CV_STORAGE_UNAVAILABLE" } }; },
      async createDownloadTarget() { throw new Error("UNEXPECTED_REDIRECT"); },
    } });
    expect(await cvDelivery.downloadCurrentCv({ actor: { kind: "visitor", consent: "denied" }, locale: "en", disposition: "attachment" }))
      .toMatchObject({ ok: false, error: { code: "CURRENT_CV_STORAGE_UNAVAILABLE" } });

    const incidentId = createStableId("OperationsIncident");
    const store = createPostgresIncidentLifecycleStore(worker.database);
    const alerts = createIncidentLifecycleService({ store, sink: { async deliver() { throw new Error("ISOLATED_NOTIFICATION_OUTAGE"); } } });
    const at = clock.now();
    await alerts.observe([{ incidentId, scopeKey: scope.portfolioId, rule: CORE_INCIDENT_RULES[0]!, value: 901, firstObservedAt: at, lastObservedAt: at }]);
    const lifecycle = createLifecycleCoordinator();
    const readiness = createOperationsReadiness({ required: [
      { name: "configuration", async check() { return true; } }, { name: "identity", async check() { return true; } },
      { name: "database", check: () => application.readiness.check() },
    ], optional: ["export", "storage", "alert", "measurement", "backup"].map((name) => ({
      name: name as "export" | "storage" | "alert" | "measurement" | "backup", async check() { throw new Error("ISOLATED_OPTIONAL_OUTAGE"); },
    })) });
    lifecycle.registerReadinessCheck({ name: "core", check: () => readiness.check() });
    lifecycle.markReady();
    expect(await alerts.deliverDue(at)).toEqual({ attempted: 4, delivered: 0, failed: 4 });
    expect((await createCheckedReadyzResponse(lifecycle.getState(), () => lifecycle.checkReadiness())).status).toBe(200);
    expect((await readiness.read()).degradedCapabilities).toHaveLength(5);
    expect(value(await content.getPublicProject({ slug, locale: "en" }))).toEqual(publicBefore);
    expect(value(await content.resolvePublicProjectRoute({ slug, locale: "en" }))).toEqual(routeBefore);
    expect(value(await taxonomy.getOwnerTaxonomy({ actor, taxonomyId }))).toEqual(taxonomyBefore);
    expect(value(await currentCv.getCurrentCvSnapshot())).toEqual(cvBefore);
    expect(value(await page())).toEqual(feedbackBefore);
    const summaries = createOperationsSummaryService({ reader: createPostgresOperationsSummaryReader(worker.database), clock });
    const summary = value(await summaries.readOperationsSummary({ actor: { kind: "system", purpose: OPERATIONS_SUMMARY_PURPOSE,
      jobId: createStableId("Job") }, portfolioId: scope.portfolioId }));
    expect(summary.exports.states.ready.value).toBe(0);
    expect(summary.backup.state.state).toBe("unknown");
    expect(summary.recovery.durationMs.state).toBe("unknown");
    const pointer = await admin.query("select current_version_id from cv_portfolio.portfolios where portfolio_id=$1", [scope.portfolioId]);
    expect(pointer.rows[0]?.current_version_id).toBe(registered.versionId);
  }, 30_000);

  it("#252 AC06 gates the assembled runtime on live database, configuration and identity while optional probes fail", async () => {
    const db = createPostgresRuntimeDatabase(applicationUrl!);
    let identityReady = true;
    const env = { NODE_ENV: "test", APP_BASE_URL: "http://localhost:3000", DATABASE_URL: applicationUrl! };
    const factory = () => ({ operations: createPostgresOperationsPersistence(db.database),
      readiness: db.readiness, identityReadiness: { name: "identity", async check() { return identityReady; } },
      resource: { name: "fixture", async close() {} }, capabilityReadiness: [{ name: "alert" as const, async check() { return false; } }] });
    const readyz = () => createCheckedReadyzResponse(getLifecycleCoordinator().getState(), () => getLifecycleCoordinator().checkReadiness());
    try {
      resetRuntimeForTests();
      await initializeDatabaseRuntime(env, "application", factory);
      expect((await readyz()).status).toBe(200);
      identityReady = false;
      expect((await readyz()).status).toBe(503);
      identityReady = true;
      expect((await readyz()).status).toBe(200);
      await db.resource.close();
      expect((await readyz()).status).toBe(503);
      resetRuntimeForTests();
      await expect(initializeDatabaseRuntime({ ...env, APP_BASE_URL: "invalid" }, "application", factory)).rejects.toThrow();
      expect((await readyz()).status).toBe(503);
    } finally { await db.resource.close(); resetRuntimeForTests(); }
  }, 15_000);

  it("#252 AC04 AC08 exhausts eight real claims and stops before the next delivery on shutdown", async () => {
    const store = createPostgresIncidentLifecycleStore(worker.database);
    const id = createStableId("OperationsIncident");
    const at = new Date().toISOString();
    const input = { incidentId: id, scopeKey: id, rule: CORE_INCIDENT_RULES[0]!, value: 901, firstObservedAt: at, lastObservedAt: at };
    let deliveries = 0;
    const service = createIncidentLifecycleService({ store, sink: { async deliver() { deliveries += 1; throw new Error("ISOLATED_SINK_DOWN"); } } });
    await service.observe([input]);
    for (let attempt = 1; attempt <= 8; attempt++) {
      expect(await service.deliverDue(new Date().toISOString())).toEqual({ attempted: 1, delivered: 0, failed: 1 });
      const state = await admin.query("select delivery_state,delivery_attempts,next_delivery_at,delivery_error_code from operations.incidents where incident_id=$1", [id]);
      expect(state.rows[0]).toMatchObject({ delivery_state: attempt === 8 ? "exhausted" : "pending", delivery_attempts: attempt,
        delivery_error_code: "INCIDENT_DELIVERY_FAILED" });
      await store.upsert({ ...input, lastObservedAt: new Date().toISOString() });
      expect((await admin.query("select next_delivery_at from operations.incidents where incident_id=$1", [id])).rows[0]?.next_delivery_at)
        .toEqual(state.rows[0]?.next_delivery_at);
      if (attempt < 8) await admin.query("update operations.incidents set next_delivery_at=clock_timestamp()-interval '1 second' where incident_id=$1", [id]);
    }
    expect(await service.deliverDue(new Date().toISOString())).toEqual({ attempted: 0, delivered: 0, failed: 0 });
    expect(deliveries).toBe(8);
    const ids = [createStableId("OperationsIncident"), createStableId("OperationsIncident")];
    await service.observe(ids.map((incidentId) => ({ ...input, incidentId, scopeKey: incidentId })));
    const shutdown = new AbortController();
    let started = 0;
    const bounded = createIncidentLifecycleService({ store, deliveryTimeoutMs: 50, deliveryBudgetMs: 100, sink: {
      async deliver() { started += 1; shutdown.abort(); await new Promise<void>(() => undefined); },
    } });
    await expect(bounded.deliverDue(new Date().toISOString(), shutdown.signal)).resolves.toEqual({ attempted: 1, delivered: 0, failed: 1 });
    expect(started).toBe(1);
    const attempts = await admin.query("select delivery_attempts from operations.incidents where incident_id=any($1::uuid[]) order by delivery_attempts", [ids]);
    expect(attempts.rows).toEqual([{ delivery_attempts: 0 }, { delivery_attempts: 1 }]);
    // Resolving then reopening invalidates the previous episode's delivery ownership.
    const episodeId = createStableId("OperationsIncident");
    const episode = { ...input, incidentId: episodeId, scopeKey: episodeId };
    await service.observe([episode]);
    // Exclude the unclaimed shutdown fixture from this claim without running it.
    await admin.query("update operations.incidents set next_delivery_at=clock_timestamp()+interval '1 day' where incident_id=any($1::uuid[])", [ids]);
    const old = (await store.claimDue(1, at))[0]?.deliveryClaim;
    expect(old?.incidentId).toBe(episodeId);
    const recoveredAt = new Date().toISOString();
    expect(await service.resolve(episode.rule.key, episode.scopeKey, recoveredAt)).toBe(true);
    const later = new Date(Date.parse(recoveredAt) + 1).toISOString();
    await service.observe([{ ...episode, firstObservedAt: later, lastObservedAt: later }]);
    await admin.query("update operations.incidents set next_delivery_at=clock_timestamp()-interval '1 second' where incident_id=$1", [episodeId]);
    const current = (await store.claimDue(1, later))[0]?.deliveryClaim;
    if (!old || !current) throw new Error("EPISODE_CLAIM_MISSING");
    expect(await store.markDelivered(old, later)).toBe(false);
    expect(await store.markDeliveryFailed(old, later, "INCIDENT_DELIVERY_FAILED", null)).toBe(false);
    expect(await store.markDelivered(current, later)).toBe(true);
  }, 15_000);
});
