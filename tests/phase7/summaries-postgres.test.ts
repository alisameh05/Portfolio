import { isolatedIdentityReadiness, isolatedOwnerAuthEnvironment } from "../fixtures/identity-readiness.js";
import { createPostgresFeedbackSubmissionRepository } from "../../src/modules/interaction-moderation/adapters/postgres-feedback.js";
import { createPostgresModerationRepository } from "../../src/modules/interaction-moderation/adapters/postgres-moderation.js";
import { createFeedbackApplicationService, createOwnerFeedbackModerationService } from "../../src/modules/interaction-moderation/index.js";
import { decideAuthorization } from "../../src/modules/identity-access/index.js";
import { createPostgresContentAuthoringRepository } from "../../src/modules/content-publishing/adapters/postgres-authoring.js";
import { createContentAuthoringService } from "../../src/modules/content-publishing/application/authoring.js";
import { createPostgresProjectDiscoveryProjectionWriter } from "../../src/modules/taxonomy-discovery/adapters/postgres-project-discovery.js";
import { initializeDatabaseRuntime, getProjectInteractionSummaryApplicationService, resetRuntimeForTests } from "../../src/bootstrap/composition-root.js";
import { getLifecycleCoordinator } from "../../src/runtime/lifecycle.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createStableId, parseIdempotencyKey, type StableId } from "../../src/shared/domain/index.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPostgresProjectInteractionFacts } from "../../src/modules/content-publishing/adapters/postgres-interaction-facts.js";
import { createPostgresInteractionSummaryRepository } from "../../src/modules/interaction-moderation/adapters/postgres-summary.js";
import { createProjectInteractionSummaryService } from "../../src/modules/interaction-moderation/index.js";
import { createRatingApplicationService, createReactionApplicationService } from "../../src/modules/interaction-moderation/index.js";
import { createPostgresRatingRepository } from "../../src/modules/interaction-moderation/adapters/postgres-ratings.js";
import { createPostgresReactionRepository } from "../../src/modules/interaction-moderation/adapters/postgres-reactions.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";

const url = process.env["PHASE7_MODERATION_DATABASE_URL"];
describe.runIf(Boolean(url))("real current interaction summaries", () => {
  const portfolioId = createStableId("Portfolio"), ownerId = createStableId("Owner");
  const scope = { kind: "portfolio" as const, portfolioId }, now = "2099-10-15T00:00:00.000Z";
  const db = createPostgresRuntimeDatabase(url ?? "postgres://invalid");
  const second = createPostgresRuntimeDatabase(url ?? "postgres://invalid");
  const admin = new Client({ connectionString: process.env["PHASE7_MODERATION_ADMIN_URL"] });
  const clock = { now: () => now }, operations = createPostgresOperationsPersistence(db.database, clock);
  const content = createPostgresProjectInteractionFacts({ portfolioId, ownerId });
  const summary = createProjectInteractionSummaryService({ portfolioId, transactions: operations.transactions, content,
    repository: createPostgresInteractionSummaryRepository() });
  const deps = { portfolioId, content, operations, clock, ids: createSystemIdGenerator() };
  const ratings = createRatingApplicationService({ ...deps, repository: createPostgresRatingRepository() });
  const reactions = createReactionApplicationService({ ...deps, repository: createPostgresReactionRepository() });
  const key = () => { const r = parseIdempotencyKey(createStableId("Key")); if (!r.ok) throw new Error("KEY"); return r.value; };
  const query = (projectId: StableId<"Project">, locale: "en" | "ar" = "en") => summary.getProjectAggregate({ scope, portfolioId, projectId, locale, correlationId: "summary" });
  const owner = { kind: "owner" as const, ownerId, sessionId: "verified-owner" };
  const moderation = createOwnerFeedbackModerationService({ scope: { portfolioId, ownerId }, operations, content,
    repository: createPostgresModerationRepository(), clock, ids: deps.ids, authorize: async q => decideAuthorization(q) });
  const submission = createFeedbackApplicationService({ ...deps, repository: createPostgresFeedbackSubmissionRepository() });
  const pages = (projectId: StableId<"Project">, locale: "en" | "ar" = "en") => moderation.getApprovedFeedback({ scope, portfolioId, projectId, locale, correlationId: "page" });
  const inspect = (feedbackId: StableId<"Feedback">) => moderation.getOwnerFeedbackModeration({ scope, actor: owner, feedbackId, correlationId: "history" });
  const decision = (feedbackId: StableId<"Feedback">, expectedVersion = 1) => ({ scope, actor: owner, feedbackId, expectedVersion, idempotencyKey: key(), reason: "PRIVATE_REASON", correlationId: "decision" });
  async function submit(projectId: StableId<"Project">, locale: "en" | "ar" = "en") {
    const r = await submission.submitFeedback({ scope, actor: { kind: "visitor", consent: "denied" }, projectId, locale,
      authorName: "PRIVATE_NAME", comment: "PRIVATE_TEXT", idempotencyKey: key(), correlationId: "feedback" });
    expect(r.ok).toBe(true); if (!r.ok) throw new Error("SUBMIT_FAILED"); return r.value.id;
  }
  async function approved(projectId: StableId<"Project">, locale: "en" | "ar" = "en") {
    const id = await submit(projectId, locale); expect((await moderation.approveOwnerFeedback(decision(id))).ok).toBe(true); return id;
  }
  const contentRepository = createPostgresContentAuthoringRepository();
  const makeLifecycle = (repository = contentRepository) => createContentAuthoringService({ operations, repository,
    scope: { portfolioId, ownerId }, clock, discoveryProjection: createPostgresProjectDiscoveryProjectionWriter() });
  const lifecycle = makeLifecycle();
  const change = (projectId: StableId<"Project">, expectedVersion = 1) => ({ actor: owner, contentId: projectId, expectedVersion, idempotencyKey: key(), correlationId: "lifecycle" });
  function barrier() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
  async function waitForLock() {
    const until = Date.now() + 2500;
    while (Date.now() < until) {
      if ((await admin.query("select 1 from pg_stat_activity where usename='moderation_runtime' and wait_event_type='Lock'")).rowCount) return;
    }
    throw new Error("NO_DATABASE_LOCK_OBSERVED");
  }
  async function publishProject() {
    const artifact = createStableId("SupportingArtifact"), common = { actor: owner, correlationId: "publication" };
    const data = { caseStudy: { problem: "Prevent stale public interactions.", ownerRole: "Built transactional reads.", contributions: ["Shared Content locking."], outcomes: ["Withdrawal is synchronous."], lessons: "Recheck current facts." },
      evidence: { claims: [{ claimId: createStableId("EvidenceClaim"), text: "The database suite proves lifecycle safety.", artifactIds: [artifact] }],
        artifacts: [{ id: artifact, title: "Database evidence", destinationUrl: "https://example.com/evidence" }] }, externalLinks: [] };
    const created = await lifecycle.createContent({ ...common, idempotencyKey: key(), payload: { contentType: "project", locale: "en", title: "Project", summary: "Current interactions", body: "A published case study.", candidateSlug: "project-" + createStableId("Slug"), ...data } });
    expect(created.ok).toBe(true); if (!created.ok) throw new Error("CREATE_FAILED");
    const projectId = created.value.contentId as StableId<"Project">;
    let version = created.value.aggregateVersion, revisionId = created.value.revisionId;
    for (const locale of ["en", "ar"] as const) {
      if (locale === "ar") {
        const saved = await lifecycle.saveRevision({ ...common, contentId: projectId, expectedVersion: version, idempotencyKey: key(), locale, title: "مشروع", summary: "تفاعلات", body: "دراسة حالة", draftData: { contentType: "project", ...data } });
        expect(saved.ok).toBe(true); if (!saved.ok) throw new Error("SAVE_FAILED"); version = saved.value.aggregateVersion; revisionId = saved.value.revisionId;
      }
      const preview = await lifecycle.previewRevision({ actor: owner, contentId: projectId, revisionId });
      expect(preview.ok).toBe(true); if (!preview.ok) throw new Error("PREVIEW_FAILED");
      const reviewed = await lifecycle.reviewRevision({ ...common, contentId: projectId, revisionId, expectedVersion: version,
        idempotencyKey: key(), locale, snapshotHash: preview.value.snapshotHash, evidenceVersion: preview.value.evidenceVersion, decision: "accepted", findings: [] });
      expect(reviewed.ok).toBe(true); if (!reviewed.ok) throw new Error("REVIEW_FAILED");
      const published = await lifecycle.publishLanguageVersion({ ...common, contentId: projectId, revisionId, expectedVersion: reviewed.value.aggregateVersion, locale, idempotencyKey: key() });
      expect(published.ok).toBe(true); if (!published.ok) throw new Error("PUBLISH_FAILED"); version = published.value.aggregateVersion;
    }
    return { projectId, version };
  }
  beforeAll(async () => {
    await admin.connect();
    await admin.query("insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Owner','Headline','Bio','Contact','https://example.com','Unavailable')", [portfolioId, ownerId]);
  });
  afterAll(async () => { await admin.end(); await db.resource.close(); await second.resource.close(); resetRuntimeForTests(); });
  async function seed(lifecycle = "published", contentType = "project", locales: readonly string[] = ["en", "ar"], portfolio = portfolioId) {
    const projectId = createStableId("Project"), route = createStableId("PublicRoute");
    if (portfolio !== portfolioId) await admin.query("insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Foreign','Headline','Bio','Contact','https://example.com','Unavailable')", [portfolio, createStableId("Owner")]);
    await admin.query("insert into content.items (content_id,portfolio_id,content_type,lifecycle) values ($1,$2,$3,$4)", [projectId, portfolio, contentType, lifecycle]);
    if (contentType === "project" && locales.length) {
      await admin.query("insert into content.public_routes (route_identity,content_id,portfolio_id,content_type,current_slug,first_published_at) values ($1,$2,$3,'project',$4,$5)", [route, projectId, portfolio, "project-" + projectId, now]);
      for (const locale of locales) {
        const revision = createStableId("Revision"), review = createStableId("ContentReview");
        const payload = { contentType: "project", locale, title: "Project", summary: "Summary", body: "Body" };
        await admin.query("insert into content.revisions (revision_id,content_id,portfolio_id,content_type,locale,stream_sequence,aggregate_version,title,summary,body,payload,saved_at) values ($1,$2,$3,'project',$4,1,1,'Project','Summary','Body',$5,$6)", [revision, projectId, portfolio, locale, payload, now]);
        await admin.query("insert into content.revision_reviews (review_id,content_id,portfolio_id,content_type,revision_id,locale,review_sequence,snapshot_hash,evidence_version,reviewer_id,decision,reviewed_at) values ($1,$2,$3,'project',$4,$5,1,$6,1,$7,'accepted',$8)", [review, projectId, portfolio, revision, locale, "a".repeat(64), ownerId, now]);
        await admin.query("insert into content.language_publications (content_id,portfolio_id,content_type,locale,revision_id,review_id,route_identity,publication_sequence,published_at) values ($1,$2,'project',$3,$4,$5,$6,1,$7)", [projectId, portfolio, locale, revision, review, route, now]);
      }
    }
    return projectId;
  }
  it("T08-01 current replacements/retries keep cardinality; zero/four/five raters gate the average", async () => {
    const projectId = await seed();
    expect(await query(projectId)).toMatchObject({ ok: true, value: { likesCount: 0, dislikesCount: 0, ratingCount: 0, ratingState: "no-data", approvedFeedbackCount: 0 } });
    const actor = { kind: "visitor" as const, consent: "denied" as const, functionalId: createStableId("FunctionalVisitor") };
    const command = { scope, actor, projectId, idempotencyKey: key(), correlationId: "current" };
    expect((await reactions.submitReaction({ ...command, kind: "like" })).ok).toBe(true);
    expect((await reactions.submitReaction({ ...command, kind: "dislike", idempotencyKey: key() })).ok).toBe(true);
    expect((await reactions.submitReaction({ ...command, kind: "dislike", idempotencyKey: key() })).ok).toBe(true);
    for (let i = 0; i < 4; i++) expect((await ratings.submitRating({ ...command, actor: { ...actor, functionalId: createStableId("FunctionalVisitor") }, value: 3, idempotencyKey: key() })).ok).toBe(true);
    const four = await query(projectId);
    expect(four).toMatchObject({ ok: true, value: { likesCount: 0, dislikesCount: 1, ratingCount: 4, ratingState: "low-sample" } });
    expect(four.ok && "averageRating" in four.value).toBe(false);
    const fifth = { ...command, value: 1 as const, idempotencyKey: key() };
    expect((await ratings.submitRating(fifth)).ok).toBe(true);
    expect(await query(projectId)).toMatchObject({ ok: true, value: { ratingCount: 5, ratingState: "available", averageRating: 2.6 } });
    expect((await ratings.submitRating({ ...fifth, value: 5, idempotencyKey: key() })).ok).toBe(true);
    expect((await ratings.submitRating(fifth)).ok).toBe(true);
    expect(await query(projectId)).toMatchObject({ ok: true, value: { ratingCount: 5, averageRating: 3.4 } });
    expect(await query(projectId, "ar")).toMatchObject({ ok: true, value: { likesCount: 0, dislikesCount: 1, ratingCount: 5, averageRating: 3.4 } });
  });

  it("T08-02 all public queries reject unknown, Draft, Hidden, Archived, wrong-type, foreign-scope and unavailable locales", async () => {
    for (const project of [createStableId("Project"), await seed("draft"), await seed("hidden"), await seed("archived"), await seed("published", "achievement"), await seed("published", "project", ["en"], createStableId("Portfolio")), await seed("published", "project", [])]) {
      expect(await query(project)).toMatchObject({ ok: false, error: { kind: "not_found" } });
      expect(await pages(project)).toMatchObject({ ok: false, error: { kind: "not_found" } });
    }
    const english = await seed("published", "project", ["en"]);
    expect((await query(english)).ok).toBe(true);
    expect(await query(english, "ar")).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(await pages(english, "ar")).toMatchObject({ ok: false, error: { kind: "not_found" } });
    const input = { scope, portfolioId, projectId: english, locale: "en" as const, correlationId: "invalid" };
    expect(await summary.getProjectAggregate({ ...input, portfolioId: createStableId("Portfolio") })).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(await summary.getProjectAggregate({ ...input, scope: { kind: "portfolio", portfolioId: createStableId("Portfolio") } })).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(await summary.getProjectAggregate({ ...input, projectId: "invalid" as never })).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(await summary.getProjectAggregate({ ...input, locale: "fr" as never })).toMatchObject({ ok: false, error: { kind: "validation" } });
  });
  it("T08-03/T08-04 real hide/archive remove every public view and restore only retained approved requested-locale Feedback", async () => {
    for (const operation of ["hideContent", "archiveContent"] as const) {
      const { projectId, version } = await publishProject();
      const en = await approved(projectId), ar = await approved(projectId, "ar"), suppressed = await approved(projectId), pending = await submit(projectId), rejected = await submit(projectId);
      expect((await moderation.suppressOwnerFeedback(decision(suppressed, 2))).ok).toBe(true);
      expect((await moderation.rejectOwnerFeedback(decision(rejected))).ok).toBe(true);
      expect(await query(projectId)).toMatchObject({ ok: true, value: { approvedFeedbackCount: 1 } });
      expect(await query(projectId, "ar")).toMatchObject({ ok: true, value: { approvedFeedbackCount: 1 } });
      const withdrawn = await lifecycle[operation](change(projectId, version)); expect(withdrawn.ok).toBe(true);
      if (!withdrawn.ok) throw new Error("WITHDRAW_FAILED");
      for (const locale of ["en", "ar"] as const) {
        expect(await query(projectId, locale)).toMatchObject({ ok: false, error: { kind: "not_found" } });
        expect(await pages(projectId, locale)).toMatchObject({ ok: false, error: { kind: "not_found" } });
      }
      for (const id of [en, ar, suppressed, pending, rejected]) expect((await inspect(id)).ok).toBe(true);
      // A published-language withdrawal has no separate command in this phase.
      // Removing its pointer models the authoritative unavailable-locale fact.
      await admin.query("delete from content.language_publications where content_id=$1 and locale='ar'", [projectId]);
      expect((await lifecycle.restoreContent(change(projectId, withdrawn.value.aggregateVersion))).ok).toBe(true);
      expect(await query(projectId)).toMatchObject({ ok: true, value: { approvedFeedbackCount: 1 } });
      expect(await pages(projectId)).toMatchObject({ ok: true, value: { items: [{ feedbackId: en }] } });
      const page = await pages(projectId); expect(page.ok && page.value.items).toHaveLength(1);
      expect(await query(projectId, "ar")).toMatchObject({ ok: false, error: { kind: "not_found" } });
      expect(await pages(projectId, "ar")).toMatchObject({ ok: false, error: { kind: "not_found" } });
      expect(await inspect(suppressed)).toMatchObject({ ok: true, value: { state: "suppressed", decisionHistory: [{ decision: "approved" }, { decision: "suppressed" }] } });
    }
  });
  it("T08-05 independent-connection withdrawal-first races reject later Reaction/Rating/Feedback and queued summaries", async () => {
    const independent = createPostgresOperationsPersistence(second.database, clock);
    const reaction = createReactionApplicationService({ ...deps, operations: independent, repository: createPostgresReactionRepository() });
    const rating = createRatingApplicationService({ ...deps, operations: independent, repository: createPostgresRatingRepository() });
    const feedback = createFeedbackApplicationService({ ...deps, operations: independent, repository: createPostgresFeedbackSubmissionRepository() });
    for (const operation of ["hideContent", "archiveContent"] as const) for (const kind of ["reaction", "rating", "feedback", "summary"] as const) {
      const projectId = await seed(), entered = barrier(), release = barrier();
      const withdrawing = makeLifecycle({ ...contentRepository, async changeLifecycle(input, tx) {
        const r = await contentRepository.changeLifecycle(input, tx); entered.release(); await release.promise; return r;
      } });
      const command = { scope, projectId, actor: { kind: "visitor" as const, consent: "denied" as const, functionalId: createStableId("FunctionalVisitor") }, idempotencyKey: key(), correlationId: "after-preflight" };
      const withdrawal = withdrawing[operation](change(projectId)); await entered.promise;
      const pending = kind === "reaction" ? reaction.submitReaction({ ...command, kind: "like" }) : kind === "rating" ? rating.submitRating({ ...command, value: 5 }) : kind === "feedback" ? feedback.submitFeedback({ ...command, actor: { kind: "visitor", consent: "denied" }, authorName: "PRIVATE_NAME", comment: "PRIVATE_TEXT", locale: "en" }) : query(projectId);
      try { await waitForLock(); } finally { release.release(); }
      expect((await withdrawal).ok).toBe(true);
      expect(await pending).toMatchObject({ ok: false, error: { kind: "not_found" } });
      expect((await admin.query("select (select count(*)::int from interaction.reactions where project_id=$1) as reactions,(select count(*)::int from interaction.ratings where project_id=$1) as ratings,(select count(*)::int from interaction.feedback where project_id=$1) as feedback", [projectId])).rows).toEqual([{ reactions: 0, ratings: 0, feedback: 0 }]);
    }
  });
  it("T08-05 submission-first holds real withdrawal until commit and subsequent reads/writes reject", async () => {
    for (const kind of ["reaction", "rating", "feedback"] as const) {
      const projectId = await seed(), entered = barrier(), release = barrier();
      const command = { scope, projectId, actor: { kind: "visitor" as const, consent: "denied" as const, functionalId: createStableId("FunctionalVisitor") }, idempotencyKey: key(), correlationId: "submit-first" };
      const r = createPostgresReactionRepository(), v = createPostgresRatingRepository(), f = createPostgresFeedbackSubmissionRepository();
      const pause = async () => { entered.release(); await release.promise; };
      const pending = kind === "reaction" ? createReactionApplicationService({ ...deps, repository: { ...r, async save(row, tx) { await r.save(row, tx); await pause(); } } }).submitReaction({ ...command, kind: "like" }) : kind === "rating" ? createRatingApplicationService({ ...deps, repository: { ...v, async save(row, tx) { await v.save(row, tx); await pause(); } } }).submitRating({ ...command, value: 5 }) : createFeedbackApplicationService({ ...deps, repository: { ...f, async insert(row, tx) { await f.insert(row, tx); await pause(); } } }).submitFeedback({ ...command, actor: { kind: "visitor", consent: "denied" }, authorName: "PRIVATE_NAME", comment: "PRIVATE_TEXT", locale: "en" });
      await entered.promise; const withdrawal = lifecycle.hideContent(change(projectId));
      try { await waitForLock(); } finally { release.release(); }
      expect((await pending).ok).toBe(true); expect((await withdrawal).ok).toBe(true);
      expect(await query(projectId)).toMatchObject({ ok: false, error: { kind: "not_found" } });
      expect(await reactions.submitReaction({ ...command, kind: "like", idempotencyKey: key() })).toMatchObject({ ok: false, error: { kind: "not_found" } });
      expect(await ratings.submitRating({ ...command, value: 1, idempotencyKey: key() })).toMatchObject({ ok: false, error: { kind: "not_found" } });
    }
  });

  it("T08-06 paused/reclaimed queued on-read work cannot resurrect withdrawal or committed suppression", async () => {
    const projectId = await seed(), id = await approved(projectId), jobId = createStableId("Job");
    const worker = createPostgresRuntimeDatabase(process.env["PHASE7_MODERATION_WORKER_URL"] ?? "postgres://invalid");
    const workerOperations = createPostgresOperationsPersistence(worker.database, clock), jobs = workerOperations.jobs;
    try {
      await workerOperations.transactions.run(tx => jobs.enqueue(tx, { jobId, availableAt: now,
        payload: { type: "interaction.summary_read.v1", version: 1, value: { projectId, locale: "en" } } }));
      expect((await moderation.suppressOwnerFeedback(decision(id, 2))).ok).toBe(true);
      // Queue eligibility and leases use PostgreSQL time, independently of the
      // fixed 2099 policy clock. Make only this queued summary job due.
      expect((await admin.query("update operations.jobs set available_at=clock_timestamp()-interval '1 millisecond' where job_id=$1 returning job_id", [jobId])).rows).toEqual([{ job_id: jobId }]);
      const claim = { workerId: "summary-proof", now, leaseDurationSeconds: 1, limit: 1 };
      const first = await jobs.claimDue(claim); expect(first).toHaveLength(1);
      expect(first[0]!.jobId).toBe(jobId);
      // The chosen numeric strategy recomputes from current rows. It has no
      // projection write handler; dispatching delayed work invokes this interface.
      expect(await query(projectId)).toMatchObject({ ok: true, value: { approvedFeedbackCount: 0 } });
      expect(await pages(projectId)).toMatchObject({ ok: true, value: { items: [] } });
      const later = "2099-10-15T00:00:02.000Z";
      expect((await admin.query("update operations.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where job_id=$1 and lease_token=$2 returning job_id", [jobId, first[0]!.leaseToken])).rows).toEqual([{ job_id: jobId }]);
      const reclaimed = await jobs.claimDue({ ...claim, now: later }); expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]!.leaseToken).not.toBe(first[0]!.leaseToken);
      expect(await jobs.complete(jobId, first[0]!.leaseToken, later)).toBe(false);
      expect((await lifecycle.hideContent(change(projectId))).ok).toBe(true);
      for (let replay = 0; replay < 2; replay++) {
        expect(await query(projectId)).toMatchObject({ ok: false, error: { kind: "not_found" } });
        expect(await pages(projectId)).toMatchObject({ ok: false, error: { kind: "not_found" } });
      }
      expect(await jobs.complete(jobId, reclaimed[0]!.leaseToken, later)).toBe(true);
      expect(await inspect(id)).toMatchObject({ ok: true, value: { state: "suppressed" } });
    } finally { await worker.resource.close(); }
  });
  it("T08-07 exact safe DTO and aggregate-only grants preserve raw-voter isolation, visibility and pooled scopes", async () => {
    const projectId = await seed(), visitorId = createStableId("FunctionalVisitor");
    expect((await reactions.submitReaction({ scope, actor: { kind: "visitor", consent: "denied", functionalId: visitorId }, projectId, kind: "like", idempotencyKey: key(), correlationId: "privacy" })).ok).toBe(true);
    await approved(projectId); await submit(projectId); const suppressed = await approved(projectId);
    expect((await moderation.suppressOwnerFeedback(decision(suppressed, 2))).ok).toBe(true);
    const dto = await query(projectId); expect(dto.ok).toBe(true); if (!dto.ok) throw new Error("SUMMARY_FAILED");
    expect(Object.keys(dto.value).sort()).toEqual(["approvedFeedbackCount", "asOf", "dislikesCount", "likesCount", "projectId", "ratingCount", "ratingState"].sort());
    expect(dto.value).toMatchObject({ likesCount: 1, approvedFeedbackCount: 1 });
    expect(Number.isFinite(Date.parse(dto.value.asOf))).toBe(true);
    for (const privateValue of [visitorId, "PRIVATE_NAME", "PRIVATE_TEXT", "PRIVATE_REASON", "history", "subject", "provider", "pending", "suppressed"]) expect(JSON.stringify(dto)).not.toContain(privateValue);
    const c = new Client({ connectionString: url }); await c.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('shipwithali.portfolio_id',$1,true),set_config('shipwithali.owner_id',$2,true),set_config('shipwithali.summary_project_id',$3,true),set_config('shipwithali.summary_locale','en',true)", [portfolioId, ownerId, projectId]);
      expect((await c.query("select * from interaction.reactions")).rows).toEqual([]);
      expect((await c.query("select * from interaction.ratings")).rows).toEqual([]);
      expect((await c.query("select * from interaction.current_reaction_counts")).rows).toEqual([{ likes: "1", dislikes: "0" }]);
      await c.query("select set_config('shipwithali.summary_locale','fr',true)");
      expect((await c.query("select * from interaction.current_reaction_counts")).rows).toEqual([{ likes: "0", dislikes: "0" }]);
      await c.query("rollback");
      expect((await c.query("select * from interaction.current_reaction_counts")).rows).toEqual([{ likes: "0", dislikes: "0" }]);
      await expect(c.query("set role shipwithali_summary_reader")).rejects.toMatchObject({ code: "42501" });
    } finally { await c.query("rollback"); await c.end(); }
    expect((await admin.query("select rolcanlogin,rolbypassrls,rolsuper from pg_roles where rolname='shipwithali_summary_reader'")).rows).toEqual([{ rolcanlogin: false, rolbypassrls: false, rolsuper: false }]);
    expect((await admin.query("select has_schema_privilege('shipwithali_summary_reader','interaction','create') as can_create")).rows).toEqual([{ can_create: false }]);
    expect((await admin.query("select pg_has_role('shipwithali_application','shipwithali_summary_reader','MEMBER') as member")).rows).toEqual([{ member: false }]);
    for (const role of ["anon", "authenticated", "shipwithali_worker", "shipwithali_backup"])
      expect((await admin.query("select has_table_privilege($1,'interaction.current_reaction_counts','select') as reactions,has_table_privilege($1,'interaction.current_rating_summary','select') as ratings", [role])).rows).toEqual([{ reactions: false, ratings: false }]);
    expect((await lifecycle.hideContent(change(projectId))).ok).toBe(true);
    expect(await query(projectId)).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect((await query(await seed())).ok).toBe(true);
  });
  it("T08-08 natural summary plans restrict scans to the requested Project and use vote indexes", async () => {
    const projectId = await seed(), other = await seed();
    await admin.query("insert into interaction.reactions(portfolio_id,project_id,visitor_id,kind,updated_at) select $1,$2,id,'like',$4 from unnest($3::uuid[]) id", [portfolioId, other, Array.from({ length: 6000 }, () => createStableId("FunctionalVisitor")), now]);
    const ids = Array.from({ length: 5 }, () => createStableId("FunctionalVisitor"));
    await admin.query("insert into interaction.reactions(portfolio_id,project_id,visitor_id,kind,updated_at) select $1,$2,id,'like',$4 from unnest($3::uuid[]) id", [portfolioId, projectId, ids, now]);
    await admin.query("insert into interaction.ratings(portfolio_id,project_id,visitor_id,value,updated_at) select $1,$2,id,5,$4 from unnest($3::uuid[]) id", [portfolioId, projectId, ids, now]);
    await admin.query("insert into interaction.ratings(portfolio_id,project_id,visitor_id,value,updated_at) select $1,$2,id,1,$4 from unnest($3::uuid[]) id", [portfolioId, other, Array.from({ length: 6000 }, () => createStableId("FunctionalVisitor")), now]);
    await admin.query("analyze interaction.reactions; analyze interaction.ratings");
    const c = new Client({ connectionString: url }); await c.connect();
    try {
      await c.query("begin"); await c.query("select set_config('shipwithali.portfolio_id',$1,true),set_config('shipwithali.owner_id',$2,true),set_config('shipwithali.summary_project_id',$3,true),set_config('shipwithali.summary_locale','en',true)", [portfolioId, ownerId, projectId]);
      const plans = [];
      for (const view of ["current_reaction_counts", "current_rating_summary"]) {
        const plan = (await c.query("explain (analyze,buffers,format json) select * from interaction." + view)).rows[0]["QUERY PLAN"][0].Plan;
        const serialized = JSON.stringify(plan); expect(serialized).toContain(view === "current_reaction_counts" ? "reactions_pkey" : "ratings_pkey");
        expect(plan["Actual Rows"]).toBe(1);
        const voteScans: Record<string, unknown>[] = [];
        function collect(node: Record<string, unknown>) {
          if (["reactions_pkey", "ratings_pkey"].includes(String(node["Index Name"]))) voteScans.push(node);
          for (const child of Array.isArray(node["Plans"]) ? node["Plans"] : []) collect(child);
        }
        collect(plan); expect(voteScans).toHaveLength(1);
        expect(voteScans[0]!["Actual Rows"]).toBe(5); expect(voteScans[0]!["Actual Loops"]).toBe(1);
        function safe(node: Record<string, unknown>): object {
          return Object.fromEntries(Object.entries(node).filter(([k]) => ["Node Type", "Index Name", "Actual Rows", "Actual Loops", "Plan Rows", "Shared Hit Blocks", "Shared Read Blocks", "Rows Removed by Filter"].includes(k)).concat([["children", (Array.isArray(node["Plans"]) ? node["Plans"] : []).map(safe)]]));
        }
        plans.push({ view, naturalPlanner: true, resultRows: plan["Actual Rows"], plan: safe(plan) });
      }
      const { writeFileSync } = await import("node:fs"); writeFileSync("artifacts/summary-query-plans.json", JSON.stringify({ unrelatedVotersPerTable: 6000, targetVoters: 5, plans }, null, 2));
    } finally { await c.query("rollback"); await c.end(); }
    expect(await query(projectId)).toMatchObject({ ok: true, value: { likesCount: 5, ratingCount: 5, averageRating: 5 } });
  });
  it("standard runtime composes current summaries without Measurement or workers and fails closed on database loss", async () => {
    const projectId = await seed(); resetRuntimeForTests();
    await initializeDatabaseRuntime({ ...isolatedOwnerAuthEnvironment, NODE_ENV: "test", APP_BASE_URL: "https://example.com", DATABASE_URL: url!, PORTFOLIO_ID: portfolioId, OWNER_ID: ownerId }, "application", undefined, { identityReadiness: isolatedIdentityReadiness });
    const service = getProjectInteractionSummaryApplicationService();
    expect(await service.getProjectAggregate({ scope, portfolioId, projectId, locale: "en", correlationId: "assembled" })).toMatchObject({ ok: true, value: { ratingState: "no-data", likesCount: 0, approvedFeedbackCount: 0 } });
    await getLifecycleCoordinator().shutdown();
    expect(await service.getProjectAggregate({ scope, portfolioId, projectId, locale: "en", correlationId: "closed" })).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable" } });
    resetRuntimeForTests();
  });
});
