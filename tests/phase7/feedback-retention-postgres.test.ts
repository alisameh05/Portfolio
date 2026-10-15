import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createStableId, parseIdempotencyKey, type StableId } from "../../src/shared/domain/index.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPostgresModerationRepository } from "../../src/modules/interaction-moderation/adapters/postgres-moderation.js";
import { createPostgresFeedbackSubmissionRepository } from "../../src/modules/interaction-moderation/adapters/postgres-feedback.js";
import { createPostgresFeedbackRetentionRepository } from "../../src/modules/interaction-moderation/adapters/postgres-retention.js";
import { createPostgresProjectInteractionFacts } from "../../src/modules/content-publishing/adapters/postgres-interaction-facts.js";
import { createFeedbackRetentionWorkService } from "../../src/modules/interaction-moderation/application/retention.js";
import { createOwnerFeedbackModerationService } from "../../src/modules/interaction-moderation/application/moderation.js";
import { createFeedbackApplicationService } from "../../src/modules/interaction-moderation/application/feedback.js";
import { createPostgresRuntimeDatabase as runtimeDb } from "../../src/shared/adapters/postgres/runtime.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";
import { decideAuthorization } from "../../src/modules/identity-access/index.js";

const workerUrl = process.env["PHASE7_FEEDBACK_RETENTION_WORKER_URL"];
const appUrl = process.env["PHASE7_FEEDBACK_RETENTION_APP_URL"];
const adminUrl = process.env["PHASE7_FEEDBACK_RETENTION_ADMIN_URL"];
const portfolioId = createStableId("Portfolio");
const ownerId = createStableId("Owner");
const owner = { kind: "owner" as const, ownerId, sessionId: "verified-session" };

describe.runIf(Boolean(workerUrl && appUrl && adminUrl))("Feedback retention PostgreSQL acceptance", () => {
  const worker = runtimeDb(workerUrl ?? "postgres://invalid");
  const worker2 = runtimeDb(workerUrl ?? "postgres://invalid");
  const app = createPostgresRuntimeDatabase(appUrl ?? "postgres://invalid");
  const admin = new Client({ connectionString: adminUrl });
  const scope = { kind: "portfolio" as const, portfolioId };
  let appNow = "2026-10-15T00:00:00.000Z";
  const operations = createPostgresOperationsPersistence(app.database, { now: () => appNow });
  const repository = createPostgresModerationRepository();
  const retention = createFeedbackRetentionWorkService({ portfolioId, transactions: worker.transactions, repository: createPostgresFeedbackRetentionRepository() });
  const retentionRestart = createFeedbackRetentionWorkService({ portfolioId, transactions: worker2.transactions, repository: createPostgresFeedbackRetentionRepository() });
  const key = () => { const parsed = parseIdempotencyKey(createStableId("Key")); if (!parsed.ok) throw new Error("TEST_KEY_INVALID"); return parsed.value; };
  const decisionIds = createSystemIdGenerator();
  const command = (now: string, jobId = createStableId("Job"), batchSize: 25 | 50 | 100 = 25) => ({
    scope, correlationId: "feedback-retention-acceptance", actor: { kind: "system" as const, jobId, purpose: "feedback.retention" as const }, batchSize, now,
  });
  const moderationAt = (instant: string) => createOwnerFeedbackModerationService({
    scope: { portfolioId, ownerId }, operations, content: createPostgresProjectInteractionFacts({ portfolioId, ownerId }), repository,
    clock: { now: () => instant }, ids: decisionIds, authorize: async q => decideAuthorization(q),
  });
  const submissionAt = (instant: string) => createFeedbackApplicationService({ portfolioId, operations,
    content: createPostgresProjectInteractionFacts({ portfolioId, ownerId }),
    repository: createPostgresFeedbackSubmissionRepository(), clock: { now: () => instant }, ids: decisionIds,
  });
  async function submitReal(projectId: StableId<"Project">, instant: string, tag: string) {
    const response = await submissionAt(instant).submitFeedback({ scope, actor: { kind: "visitor", consent: "unknown" },
      projectId, locale: "en", authorName: `NAME_${tag}`, comment: `PARAGRAPH_${tag}`,
      idempotencyKey: key(), correlationId: "feedback-retention-real-submission" });
    if (!response.ok) throw new Error(`FEEDBACK_TEST_SUBMISSION_FAILED:${response.error.code}`);
    return response.value.id;
  }
  const inspect = (service: ReturnType<typeof moderationAt>, feedbackId: StableId<"Feedback">) => service.getOwnerFeedbackModeration({
    scope, actor: owner, feedbackId, correlationId: "feedback-retention-owner-inspection",
  });

  async function seedFeedback(input: { state: "pending" | "rejected" | "approved" | "suppressed"; submittedAt: string; approvedAt?: string; suppressedAt?: string; textTag?: string }) {
    const feedbackId = createStableId("Feedback"), projectId = createStableId("Project"), tag = input.textTag ?? feedbackId;
    const state = input.state, version = state === "pending" ? 1 : state === "suppressed" ? 3 : 2;
    await admin.query(`insert into interaction.feedback (feedback_id,portfolio_id,project_id,locale,author_name,paragraph,moderation_state,aggregate_version,submitted_at,approved_at)
      values ($1,$2,$3,'en',$4,$5,$6,$7,$8,$9)`, [feedbackId, portfolioId, projectId, `NAME_${tag}`, `PARAGRAPH_${tag}`, state, version, input.submittedAt, input.approvedAt ?? input.suppressedAt ?? null]);
    if (state === "rejected" || state === "approved" || state === "suppressed") {
      const decisionId = createStableId("ModerationDecision");
      const decision = state === "rejected" ? "rejected" : "approved";
      const at = state === "rejected" ? input.submittedAt : input.approvedAt ?? input.suppressedAt!;
      await admin.query(`insert into interaction.moderation_decisions (decision_id,portfolio_id,feedback_id,sequence,decision,reason,owner_id,decided_at)
        values ($1,$2,$3,1,$4,$5,$6,$7)`, [decisionId, portfolioId, feedbackId, decision, `REASON_${tag}`, ownerId, at]);
    }
    if (state === "suppressed") {
      const decisionId = createStableId("ModerationDecision");
      await admin.query(`insert into interaction.moderation_decisions (decision_id,portfolio_id,feedback_id,sequence,decision,reason,owner_id,decided_at)
        values ($1,$2,$3,2,'suppressed',$4,$5,$6)`, [decisionId, portfolioId, feedbackId, `SUPPRESSION_REASON_${tag}`, ownerId, input.suppressedAt]);
    }
    return { feedbackId, projectId, tag };
  }

  async function seedPublishedProject(lifecycle = "published") {
    const projectId = createStableId("Project"), route = createStableId("PublicRoute"), now = "2026-10-15T00:00:00.000Z";
    await admin.query("insert into content.items (content_id,portfolio_id,content_type,lifecycle) values ($1,$2,'project',$3)", [projectId, portfolioId, lifecycle]);
    await admin.query("insert into content.public_routes (route_identity,content_id,portfolio_id,content_type,current_slug,first_published_at) values ($1,$2,$3,'project',$4,$5)", [route, projectId, portfolioId, `project-${projectId}`, now]);
    for (const locale of ["en", "ar"] as const) {
      const revision = createStableId("Revision"), review = createStableId("ContentReview");
      const payload = { contentType: "project", locale, title: "Project", summary: "Summary", body: "Body" };
      await admin.query("insert into content.revisions (revision_id,content_id,portfolio_id,content_type,locale,stream_sequence,aggregate_version,title,summary,body,payload,saved_at) values ($1,$2,$3,'project',$4,1,1,'Project','Summary','Body',$5,$6)", [revision, projectId, portfolioId, locale, payload, now]);
      await admin.query("insert into content.revision_reviews (review_id,content_id,portfolio_id,content_type,revision_id,locale,review_sequence,snapshot_hash,evidence_version,reviewer_id,decision,reviewed_at) values ($1,$2,$3,'project',$4,$5,1,$6,1,$7,'accepted',$8)", [review, projectId, portfolioId, revision, locale, "a".repeat(64), ownerId, now]);
      await admin.query("insert into content.language_publications (content_id,portfolio_id,content_type,locale,revision_id,review_id,route_identity,publication_sequence,published_at) values ($1,$2,'project',$3,$4,$5,$6,1,$7)", [projectId, portfolioId, locale, revision, review, route, now]);
    }
    return projectId;
  }

  async function drain(now: string, jobId = createStableId("Job"), batchSize: 25 | 50 | 100 = 25, service = retention) {
    const results: { processedCount: number; nextCursor: string | null; incomplete: boolean }[] = [];
    for (let step = 0; step < 30; step++) {
      const response = await service.expireFeedback(command(now, jobId, batchSize));
      if (!response.ok) throw new Error(`FEEDBACK_RETENTION_FAILED:${response.error.code}`);
      results.push(response.value);
      if (response.value.nextCursor === null) return { jobId, results };
    }
    throw new Error("FEEDBACK_RETENTION_NOT_BOUNDED");
  }

  async function waitForLock(user: string) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      if ((await admin.query("select 1 from pg_stat_activity where usename=$1 and wait_event_type='Lock'", [user])).rowCount) return;
    }
    throw new Error("FEEDBACK_RETENTION_LOCK_NOT_OBSERVED");
  }

  beforeAll(async () => {
    await admin.connect();
    await admin.query("insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Owner','Headline','Bio','Contact','https://example.com','Unavailable')", [portfolioId, ownerId]);
  });
  afterAll(async () => { await admin.end(); await worker.resource.close(); await worker2.resource.close(); await app.resource.close(); });

  it("T18-01: uses submission time at before/exact/after 90-day cutoffs, regardless of rejection time", async () => {
    const pending = await seedFeedback({ state: "pending", submittedAt: "2026-01-01T00:00:00.000Z" });
    const rejected = await seedFeedback({ state: "rejected", submittedAt: "2026-01-01T00:00:00.000Z" });
    const nextDay = await seedFeedback({ state: "rejected", submittedAt: "2026-01-02T00:00:00.000Z" });
    await admin.query("update interaction.moderation_decisions set decided_at='2026-07-01T00:00:00Z' where feedback_id=$1", [rejected.feedbackId]);
    const before = await drain("2026-03-31T23:59:59.999Z");
    expect((await admin.query("select count(*)::int as count from interaction.feedback where feedback_id=any($1::uuid[])", [[pending.feedbackId, rejected.feedbackId, nextDay.feedbackId]])).rows[0].count).toBe(3);
    await drain("2026-04-01T00:00:00.000Z");
    expect((await admin.query("select count(*)::int as count from interaction.feedback where feedback_id=any($1::uuid[])", [[pending.feedbackId, rejected.feedbackId, nextDay.feedbackId]])).rows[0].count).toBe(1);
    await drain("2026-04-02T00:00:00.000Z");
    expect((await admin.query("select count(*)::int as count from interaction.feedback where feedback_id=$1", [nextDay.feedbackId])).rows[0].count).toBe(0);
    expect(before.results.every(result => result.processedCount <= 25)).toBe(true);
  });

  it("T18-02/03/04/05: erases suppressed text and reasons on the clamped 12-month boundary while retaining permitted audit", async () => {
    const suppressed = await seedFeedback({ state: "suppressed", submittedAt: "2024-01-01T00:00:00.000Z", approvedAt: "2024-01-02T00:00:00.000Z", suppressedAt: "2024-02-29T12:30:00.000Z", textTag: "ERASURE_SENTINEL" });
    const suppressedLater = await seedFeedback({ state: "suppressed", submittedAt: "2024-01-01T00:00:00.000Z", approvedAt: "2024-01-02T00:00:00.000Z", suppressedAt: "2024-03-01T12:30:00.000Z" });
    const approved = await seedFeedback({ state: "approved", submittedAt: "2024-01-01T00:00:00.000Z", approvedAt: "2024-01-02T00:00:00.000Z" });
    const approvedHidden = await seedFeedback({ state: "approved", submittedAt: "2024-01-01T00:00:00.000Z", approvedAt: "2024-01-02T00:00:00.000Z" });
    const before = await drain("2025-02-27T23:59:59.999Z");
    expect((await admin.query("select text_erased_at from interaction.feedback where feedback_id=$1", [suppressed.feedbackId])).rows[0].text_erased_at).toBeNull();
    await drain("2025-02-28T12:30:00.000Z");
    const audit = (await admin.query(`select f.feedback_id,f.project_id,f.locale,f.moderation_state,f.aggregate_version::int as aggregate_version,f.submitted_at,f.approved_at,f.text_erased_at,f.author_name,f.paragraph,
      (select json_agg(json_build_object('decision',d.decision,'reason',d.reason,'owner_id',d.owner_id,'sequence',d.sequence) order by d.sequence) from interaction.moderation_decisions d where d.feedback_id=f.feedback_id) as decisions
      from interaction.feedback f where f.feedback_id=$1`, [suppressed.feedbackId])).rows[0];
    expect(audit).toMatchObject({ feedback_id: suppressed.feedbackId, moderation_state: "suppressed", aggregate_version: 3, text_erased_at: new Date("2025-02-28T12:30:00.000Z"), author_name: null, paragraph: null });
    expect(audit.decisions).toEqual([{ decision: "approved", reason: null, owner_id: null, sequence: 1 }, { decision: "suppressed", reason: null, owner_id: null, sequence: 2 }]);
    expect(JSON.stringify(audit)).not.toContain("ERASURE_SENTINEL");
    expect((await admin.query("select count(*)::int as count from interaction.feedback where feedback_id=any($1::uuid[])", [[approved.feedbackId, approvedHidden.feedbackId, suppressedLater.feedbackId]])).rows[0].count).toBe(3);
    expect(before.results.every(result => result.processedCount <= 25)).toBe(true);
    const ownerService = moderationAt("2025-02-28T12:30:00.000Z");
    expect(await inspect(ownerService, suppressed.feedbackId)).toMatchObject({ ok: false, error: { kind: "not_found", code: "FEEDBACK_NOT_FOUND" } });
    expect(await inspect(ownerService, approved.feedbackId)).toMatchObject({ ok: true, value: { state: "approved", paragraph: expect.any(String) } });
    const copies = await admin.query(`select
      (select count(*)::int from operations.outbox_events where payload::text like '%ERASURE_SENTINEL%') as outbox,
      (select count(*)::int from operations.idempotency_records where result_envelope::text like '%ERASURE_SENTINEL%' or request_hash like '%ERASURE_SENTINEL%') as receipts,
      (select count(*)::int from interaction.moderation_decisions where reason like '%ERASURE_SENTINEL%') as reasons`);
    expect(copies.rows[0]).toEqual({ outbox: 0, receipts: 0, reasons: 0 });

    const realProject = await seedPublishedProject();
    const realId = await submitReal(realProject, "2026-10-15T00:00:00.000Z", "REAL_ERASURE_SENTINEL");
    expect((await moderationAt("2026-10-15T00:00:00.000Z").approveOwnerFeedback({ scope, actor: owner, feedbackId: realId,
      expectedVersion: 1, idempotencyKey: key(), reason: "PRIVATE_APPROVAL_REASON", correlationId: "approve-retention" })).ok).toBe(true);
    expect((await moderationAt("2026-10-15T00:00:00.000Z").suppressOwnerFeedback({ scope, actor: owner, feedbackId: realId,
      expectedVersion: 2, idempotencyKey: key(), reason: "PRIVATE_SUPPRESSION_REASON", correlationId: "suppress-retention" })).ok).toBe(true);
    await drain("2027-10-15T00:00:00.000Z");
    expect((await admin.query("select author_name,paragraph from interaction.feedback where feedback_id=$1", [realId])).rows[0]).toEqual({ author_name: null, paragraph: null });
    expect(await moderationAt("2027-10-15T00:00:00.000Z").getApprovedFeedback({ scope, portfolioId, projectId: realProject, locale: "en", correlationId: "retention-public-history", limit: 100 }))
      .toMatchObject({ ok: true, value: { items: [] } });
    const copiesAfterRealSubmission = await admin.query(`select
      (select count(*)::int from operations.outbox_events where payload::text like '%REAL_ERASURE_SENTINEL%') as outbox,
      (select count(*)::int from operations.idempotency_records where result_envelope::text like '%REAL_ERASURE_SENTINEL%') as receipts,
      (select count(*)::int from interaction.moderation_decisions where reason like '%PRIVATE_APPROVAL_REASON%' or reason like '%PRIVATE_SUPPRESSION_REASON%') as reasons`);
    expect(copiesAfterRealSubmission.rows[0]).toEqual({ outbox: 0, receipts: 0, reasons: 0 });
  });

  it("T18-03: approved hidden records are retained and only reappear after current Project publication", async () => {
    const projectId = await seedPublishedProject("hidden");
    const hidden = await seedFeedback({ state: "approved", submittedAt: "2024-01-01T00:00:00.000Z", approvedAt: "2024-01-02T00:00:00.000Z" });
    await admin.query("update interaction.feedback set project_id=$2 where feedback_id=$1", [hidden.feedbackId, projectId]);
    const service = moderationAt("2026-10-15T00:00:00.000Z");
    expect(await service.getApprovedFeedback({ scope, portfolioId, projectId, locale: "en", correlationId: "hidden" })).toMatchObject({ ok: false, error: { kind: "not_found" } });
    await drain("2026-10-15T00:00:00.000Z");
    expect((await admin.query("select count(*)::int as count from interaction.feedback where feedback_id=$1", [hidden.feedbackId])).rows[0].count).toBe(1);
    await admin.query("update content.items set lifecycle='published' where content_id=$1", [projectId]);
    expect(await service.getApprovedFeedback({ scope, portfolioId, projectId, locale: "en", correlationId: "restored" })).toMatchObject({ ok: true, value: { items: [{ feedbackId: hidden.feedbackId }] } });
  });

  it("T18-06: independent moderation wins a pending-to-approved race with cleanup", async () => {
    const projectId = await seedPublishedProject();
    const feedback = await seedFeedback({ state: "pending", submittedAt: "2026-01-01T00:00:00.000Z" });
    await admin.query("update interaction.feedback set project_id=$2 where feedback_id=$1", [feedback.feedbackId, projectId]);
    await admin.query("begin");
    try {
      await admin.query("select feedback_id from interaction.feedback where feedback_id=$1 for update", [feedback.feedbackId]);
      const service = moderationAt("2026-10-15T00:00:00.000Z");
      const approval = service.approveOwnerFeedback({ scope, actor: owner, feedbackId: feedback.feedbackId, expectedVersion: 1, idempotencyKey: key(), reason: "Approved after review", correlationId: "retention-race" });
      await waitForLock("feedback_retention_app_runtime");
      const jobId = createStableId("Job");
      const skipped = await retention.expireFeedback(command("2026-10-15T00:00:00.000Z", jobId));
      expect(skipped).toMatchObject({ ok: true, value: { processedCount: 0, nextCursor: jobId, incomplete: true } });
      await admin.query("commit");
      expect(await approval).toMatchObject({ ok: true, value: { outcome: "feedback-approved" } });
      expect(await service.suppressOwnerFeedback({ scope, actor: owner, feedbackId: feedback.feedbackId, expectedVersion: 2,
        idempotencyKey: key(), reason: "Suppressed after approval", correlationId: "retention-suppression-race" }))
        .toMatchObject({ ok: true, value: { outcome: "feedback-suppressed" } });
      await drain("2026-10-15T00:00:00.000Z", jobId);
      expect((await admin.query("select count(*)::int as count from interaction.feedback where feedback_id=$1", [feedback.feedbackId])).rows[0].count).toBe(1);
      expect(await inspect(service, feedback.feedbackId)).toMatchObject({ ok: true, value: { state: "suppressed", paragraph: expect.any(String) } });
    } catch (error) {
      await admin.query("rollback");
      throw error;
    }
  });

  it("T18-06/07: retries the same checkpoint after a competing row lock rolls back", async () => {
    const feedback = await seedFeedback({ state: "pending", submittedAt: "2026-01-01T00:00:00.000Z" });
    const jobId = createStableId("Job"), now = "2026-10-15T00:00:00.000Z";
    await admin.query("begin");
    try {
      await admin.query("select pg_advisory_xact_lock(hashtextextended($1::text, 205))", [feedback.feedbackId]);
      const deferred = await retention.expireFeedback(command(now, jobId));
      expect(deferred).toMatchObject({ ok: true, value: { processedCount: 0, nextCursor: jobId, incomplete: true } });
      await admin.query("rollback");
      await drain(now, jobId);
      expect((await admin.query("select count(*)::int as count from interaction.feedback where feedback_id=$1", [feedback.feedbackId])).rows[0].count).toBe(0);
    } catch (error) {
      await admin.query("rollback");
      throw error;
    }
  });

  it("T18-07: processes at most 100 rows per batch, resumes after restart, and rolls back failures", async () => {
    const bulk = await Promise.all(Array.from({ length: 205 }, () => seedFeedback({ state: "pending", submittedAt: "2025-01-01T00:00:00.000Z" })));
    const jobId = createStableId("Job"), now = "2026-10-15T00:00:00.000Z";
    const first = await retention.expireFeedback(command(now, jobId, 100));
    expect(first).toMatchObject({ ok: true, value: { processedCount: 100, nextCursor: jobId, incomplete: true } });
    const second = await retentionRestart.expireFeedback(command(now, jobId, 100));
    expect(second).toMatchObject({ ok: true, value: { processedCount: 100, nextCursor: jobId, incomplete: true } });
    const third = await retention.expireFeedback(command(now, jobId, 100));
    expect(third).toMatchObject({ ok: true, value: { processedCount: 5, nextCursor: jobId, incomplete: true } });
    const fourth = await retentionRestart.expireFeedback(command(now, jobId, 100));
    expect(fourth).toMatchObject({ ok: true, value: { processedCount: 0, nextCursor: null, incomplete: false } });
    expect((await admin.query("select count(*)::int as count from interaction.feedback where feedback_id=any($1::uuid[])", [bulk.map(row => row.feedbackId)])).rows[0].count).toBe(0);

    const retry = await seedFeedback({ state: "pending", submittedAt: "2025-01-01T00:00:00.000Z" });
    await admin.query("create function public.fail_feedback_retention() returns trigger language plpgsql as $$ begin raise exception using errcode='P0001',message='PRIVATE_PARAGRAPH_SENTINEL'; end $$");
    await admin.query("create trigger fail_feedback_retention before delete on interaction.feedback for each row execute function public.fail_feedback_retention()");
    const failureJob = createStableId("Job");
    expect(await retention.expireFeedback(command(now, failureJob))).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable", code: "FEEDBACK_RETENTION_UNAVAILABLE" } });
    expect((await admin.query("select count(*)::int as count from interaction.feedback where feedback_id=$1", [retry.feedbackId])).rows[0].count).toBe(1);
    expect((await admin.query("select count(*)::int as count from interaction.feedback_retention_checkpoints where job_id=$1", [failureJob])).rows[0].count).toBe(0);
    await admin.query("drop trigger fail_feedback_retention on interaction.feedback; drop function public.fail_feedback_retention()");
    await drain(now, failureJob);
    expect((await admin.query("select count(*)::int as count from interaction.feedback where feedback_id=$1", [retry.feedbackId])).rows[0].count).toBe(0);
  });

  it("T18-08/09: scoped worker policies deny forged purposes and output only counts/codes", async () => {
    const feedback = await seedFeedback({ state: "pending", submittedAt: "2025-01-01T00:00:00.000Z" });
    const deniedPurpose = await retention.expireFeedback({ ...command("2026-10-15T00:00:00.000Z"), actor: { kind: "system", jobId: createStableId("Job"), purpose: "measurement.retention" as never } });
    const deniedPortfolio = await retention.expireFeedback({ ...command("2026-10-15T00:00:00.000Z"), scope: { kind: "portfolio", portfolioId: createStableId("Portfolio") } });
    expect(deniedPurpose).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(deniedPortfolio).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    const result = await retention.expireFeedback(command("2026-10-15T00:00:00.000Z"));
    expect(JSON.stringify(result)).not.toMatch(/NAME_|PARAGRAPH_|REASON_/);
    expect((await admin.query("select count(*)::int as count from interaction.feedback where feedback_id=$1", [feedback.feedbackId])).rows[0].count).toBe(0);
    await admin.query("begin");
    try {
      await worker.transactions.run(async tx => {
        const { sql } = await import("kysely");
        const { resolvePostgresTransaction } = await import("../../src/shared/adapters/postgres/runtime.js");
        const db = resolvePostgresTransaction(tx);
        await sql`select set_config('shipwithali.portfolio_id', ${portfolioId}, true),
          set_config('shipwithali.system_purpose', 'measurement.retention', true),
          set_config('shipwithali.feedback_access', 'retention', true)`.execute(db);
        const hidden = await sql`select count(*)::int as count from interaction.feedback_retention_checkpoints`.execute(db);
        expect(Number((hidden.rows[0] as { count?: string | number } | undefined)?.count ?? 0)).toBe(0);
        return hidden;
      });
    } finally { await admin.query("rollback"); }
  });

  void appNow;
});
