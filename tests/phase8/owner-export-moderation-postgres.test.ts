import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { createPostgresContentAuthoringRepository } from "../../src/modules/content-publishing/adapters/postgres-authoring.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createPostgresProjectInteractionFacts } from "../../src/modules/content-publishing/adapters/postgres-interaction-facts.js";
import { createPostgresModerationRepository } from "../../src/modules/interaction-moderation/adapters/postgres-moderation.js";
import { createPostgresFeedbackOwnerExportSnapshotReader } from "../../src/modules/interaction-moderation/adapters/postgres-owner-export.js";
import type { FeedbackOwnerExportSnapshotReaderPort } from "../../src/modules/interaction-moderation/application/owner-export.js";
import { createPostgresFeedbackRetentionRepository } from "../../src/modules/interaction-moderation/adapters/postgres-retention.js";
import { createOwnerFeedbackModerationService } from "../../src/modules/interaction-moderation/application/moderation.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPostgresOwnerExportStore } from "../../src/modules/portability-operations/adapters/postgres-owner-export-store.js";
import { createOwnerExportAssemblyService, type OwnerExportObjectStoragePort } from "../../src/modules/portability-operations/application/owner-export-assembly.js";
import { createOwnerExportService } from "../../src/modules/portability-operations/application/owner-export-service.js";
import { projectFeedbackOwnerExportSnapshot } from "../../src/modules/interaction-moderation/application/owner-export.js";
import { buildSelectedOwnerExportPackage, matchesOwnerExportModerationFacts } from "../../src/modules/portability-operations/application/owner-export-package.js";
import { decideAuthorization } from "../../src/modules/identity-access/index.js";
import { createOwnerExportSnapshotReader } from "../../src/runtime/adapters/owner-export-snapshot.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createStableId, parseIdempotencyKey, ok, err, type StableId } from "../../src/shared/domain/index.js";
import { validateOwnerExportZip } from "../../scripts/owner-export/validator.mjs";
import { createOwnerExportArtifactCleanupService, type OwnerExportObjectDeletePort } from "../../src/modules/portability-operations/application/owner-export-cleanup.js";
import { createSupabaseOwnerExportStorage } from "../../src/runtime/adapters/supabase-owner-export-storage.js";

const APPLICATION_URL = process.env["PHASE8_OWNER_EXPORT_APPLICATION_URL"];
const WORKER_URL = process.env["PHASE8_OWNER_EXPORT_WORKER_URL"];
const ADMIN_URL = process.env["PHASE8_OWNER_EXPORT_ADMIN_URL"];
const enabled = Boolean(APPLICATION_URL && WORKER_URL && ADMIN_URL);
const DAY_MS = 86_400_000;

async function archiveBytes(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of content) { chunks.push(chunk); size += chunk.byteLength; }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function waitForRoleLock(admin: Client, username: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    await admin.query("select pg_stat_clear_snapshot()");
    const waiting = await admin.query(`select count(*)::int as count from pg_stat_activity
      where usename = $1 and state = 'active' and wait_event_type = 'Lock'`, [username]);
    if (Number(waiting.rows[0]?.count ?? 0) > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("PHASE8_FEEDBACK_MODERATION_RACE_LOCK_NOT_OBSERVED");
}

async function visibleFeedback(database: ReturnType<typeof createPostgresRuntimeDatabase>["database"], input: {
  readonly portfolioId: string;
  readonly ownerId: string;
  readonly workerPurpose?: string;
  readonly feedbackAccess: string;
}): Promise<{ readonly feedback: number; readonly decisions: number }> {
  return database.transaction().execute(async transaction => {
    await sql`select set_config('shipwithali.portfolio_id', ${input.portfolioId}, true),
      set_config('shipwithali.owner_id', ${input.ownerId}, true),
      set_config('shipwithali.worker_purpose', ${input.workerPurpose ?? ""}, true),
      set_config('shipwithali.feedback_access', ${input.feedbackAccess}, true),
      set_config('shipwithali.retention_now', transaction_timestamp()::text, true)`.execute(transaction);
    const feedback = await sql<{ count: number }>`select count(*)::int as count from interaction.feedback`.execute(transaction);
    const decisions = await sql<{ count: number }>`select count(*)::int as count from interaction.moderation_decisions`.execute(transaction);
    return { feedback: feedback.rows[0]?.count ?? 0, decisions: decisions.rows[0]?.count ?? 0 };
  });
}

describe.runIf(enabled)("Phase 8 #245 real Feedback and Moderation export fixture", () => {
  const admin = new Client({ connectionString: ADMIN_URL });
  const application = createPostgresRuntimeDatabase(APPLICATION_URL!);
  const worker = createPostgresRuntimeDatabase(WORKER_URL!);
  const reader = createPostgresFeedbackOwnerExportSnapshotReader();
  const storageUrl = process.env["PHASE8_OWNER_EXPORT_STORAGE_URL"];
  const realStorage = storageUrl === undefined ? undefined : createSupabaseOwnerExportStorage({ storageUrl,
    serviceRoleKey: process.env["PHASE8_OWNER_EXPORT_STORAGE_KEY"]! });
  let portfolioId: StableId<"Portfolio">;
  let ownerId: StableId<"Owner">;

  async function seedPortfolio(): Promise<void> {
    portfolioId = createStableId("Portfolio");
    ownerId = createStableId("Owner");
    await admin.query(`insert into portfolio_config.settings (
      portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback
    ) values ($1,$2,'Owner','Builder','Portfolio fixture','Contact','https://example.test/contact','Contact unavailable')`, [portfolioId, ownerId]);
  }

  async function insertProject(lifecycle: "hidden" | "archived"): Promise<StableId<"Project">> {
    const projectId = createStableId("Project");
    await admin.query(`insert into content.items (content_id,portfolio_id,content_type,lifecycle,aggregate_version)
      values ($1,$2,'project',$3,1)`, [projectId, portfolioId, lifecycle]);
    await admin.query(`insert into content.revisions (revision_id,content_id,portfolio_id,content_type,locale,
      stream_sequence,aggregate_version,title,summary,body,payload,saved_at)
      values ($1,$2,$3,'project','en',1,1,'Project','Project summary','Project body',$4::jsonb,transaction_timestamp())`,
    [createStableId("Revision"), projectId, portfolioId, JSON.stringify({ contentType: "project", locale: "en",
      title: "Project", summary: "Project summary", body: "Project body" })]);
    const routeId = createStableId("PublicRoute");
    const slug = `project-${projectId}`;
    const firstPublishedAt = new Date(Date.now() - 2 * DAY_MS).toISOString();
    await admin.query("update content.items set first_published_at=$2 where content_id=$1", [projectId, firstPublishedAt]);
    await admin.query(`insert into content.public_routes (route_identity,content_id,portfolio_id,content_type,current_slug,first_published_at)
      values ($1,$2,$3,'project',$4,$5)`, [routeId, projectId, portfolioId, slug, firstPublishedAt]);
    await admin.query(`insert into content.public_route_reservations (portfolio_id,content_type,normalized_slug,route_identity,content_id,is_current)
      values ($1,'project',$2,$3,$4,true)`, [portfolioId, slug, routeId, projectId]);
    return projectId;
  }

  async function insertFeedback(input: {
    readonly state: "pending" | "approved" | "rejected" | "suppressed";
    readonly projectId: StableId<"Project">;
    readonly submittedAt: string;
    readonly authorName?: string | null;
    readonly paragraph?: string | null;
    readonly erasedAt?: string | null;
    readonly decision?: "approved" | "rejected" | "suppressed";
    readonly approvalAt?: string;
    readonly decisionAt?: string;
    readonly reason?: string | null;
  }): Promise<StableId<"Feedback">> {
    const feedbackId = createStableId("Feedback");
    const erasedAt = input.erasedAt ?? null;
    await admin.query(`insert into interaction.feedback (
      feedback_id,portfolio_id,project_id,locale,author_name,paragraph,moderation_state,aggregate_version,submitted_at,text_erased_at,approved_at
    ) values ($1,$2,$3,'en',$4,$5,$6,$7,$8,$9,$10)`, [feedbackId, portfolioId, input.projectId,
      input.authorName === undefined ? "PRIVATE_NAME_SENTINEL" : input.authorName,
      input.paragraph === undefined ? "PRIVATE_TEXT_SENTINEL" : input.paragraph,
      input.state, input.state === "pending" ? 1 : input.state === "suppressed" ? 3 : 2, input.submittedAt, erasedAt,
      input.decision === "approved" || input.state === "suppressed" ? input.approvalAt ?? input.decisionAt ?? input.submittedAt : null]);
    if (input.decision !== undefined) {
      const approvalAt = input.approvalAt ?? input.submittedAt;
      if (input.state === "suppressed") {
        await admin.query(`insert into interaction.moderation_decisions (
          decision_id,portfolio_id,feedback_id,sequence,decision,reason,owner_id,decided_at
        ) values ($1,$2,$3,1,'approved',$4,$5,$6)`, [createStableId("ModerationDecision"), portfolioId, feedbackId,
          erasedAt === null ? "PRIVATE_APPROVAL_REASON_SENTINEL" : null, erasedAt === null ? ownerId : null, approvalAt]);
        await admin.query(`insert into interaction.moderation_decisions (
          decision_id,portfolio_id,feedback_id,sequence,decision,reason,owner_id,decided_at
        ) values ($1,$2,$3,2,'suppressed',$4,$5,$6)`, [createStableId("ModerationDecision"), portfolioId, feedbackId,
          input.reason === undefined ? "PRIVATE_REASON_SENTINEL" : input.reason,
          erasedAt === null ? ownerId : null, input.decisionAt]);
      } else {
        await admin.query(`insert into interaction.moderation_decisions (
          decision_id,portfolio_id,feedback_id,sequence,decision,reason,owner_id,decided_at
        ) values ($1,$2,$3,1,$4,$5,$6,$7)`, [createStableId("ModerationDecision"), portfolioId, feedbackId,
          input.decision, input.reason === undefined ? "PRIVATE_REASON_SENTINEL" : input.reason,
          erasedAt === null ? ownerId : null, input.decisionAt ?? approvalAt]);
      }
    }
    return feedbackId;
  }

  async function cleanFixtures(): Promise<void> {
    await admin.query("begin");
    try {
      // Only synthetic rows in this runner's disposable cluster are removed.
      await admin.query("set local session_replication_role=replica");
      await admin.query("delete from operations.jobs where payload->>'portfolioId'=$1", [portfolioId]);
      await admin.query("delete from operations.outbox_events where aggregate_id in (select export_id from portability.owner_exports where portfolio_id=$1)", [portfolioId]);
      await admin.query("delete from portability.owner_exports where portfolio_id=$1", [portfolioId]);
      await admin.query("delete from operations.idempotency_records where operation_scope=$1", [`portability.owner-export-request:${portfolioId}`]);
      await admin.query(`delete from operations.outbox_events where aggregate_id in
        (select feedback_id from interaction.feedback where portfolio_id=$1)`, [portfolioId]);
      await admin.query("delete from operations.idempotency_records where operation_scope like $1", [`interaction.moderation:%:${portfolioId}:%`]);
      await admin.query("delete from interaction.feedback_retention_checkpoints where portfolio_id=$1", [portfolioId]);
      await admin.query("delete from interaction.moderation_decisions where portfolio_id=$1", [portfolioId]);
      await admin.query("delete from interaction.feedback where portfolio_id=$1", [portfolioId]);
      await admin.query("delete from content.revisions where portfolio_id=$1", [portfolioId]);
      await admin.query("delete from content.public_route_reservations where portfolio_id=$1", [portfolioId]);
      await admin.query("delete from content.public_routes where portfolio_id=$1", [portfolioId]);
      await admin.query("delete from content.items where portfolio_id=$1", [portfolioId]);
      await admin.query("delete from taxonomy.roots where portfolio_id=$1", [portfolioId]);
      await admin.query("delete from portfolio_config.settings where portfolio_id=$1", [portfolioId]);
      await admin.query("commit");
    } catch (error) {
      await admin.query("rollback");
      throw error;
    }
  }

  beforeAll(async () => {
    await admin.connect();
    if (storageUrl !== undefined) {
      const url = new URL(storageUrl);
      const expectedPort = process.env["PHASE8_OWNER_EXPORT_STORAGE_PORT"] ?? "56321";
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== expectedPort) throw new Error('PHASE8_STORAGE_NOT_ISOLATED');
      const response = await fetch(new URL('/storage/v1/bucket', url), { method: 'POST',
        headers: { apikey: process.env["PHASE8_OWNER_EXPORT_STORAGE_KEY"]!,
          authorization: `Bearer ${process.env["PHASE8_OWNER_EXPORT_STORAGE_KEY"]!}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'owner-exports', name: 'owner-exports', public: false }) });
      if (!response.ok) throw new Error('PHASE8_STORAGE_BUCKET_FAILED');
    }
  });
  afterAll(async () => {
    if (portfolioId !== undefined) await cleanFixtures();
    await admin.end();
    await application.database.destroy();
    await worker.database.destroy();
  });

  it("AC01/AC02/AC05/AC06/AC07 captures hidden and archived projects with truthful retained or erased facts", async () => {
    await seedPortfolio();
    const hiddenProject = await insertProject("hidden");
    const archivedProject = await insertProject("archived");
    const pending = await insertFeedback({ state: "pending", projectId: hiddenProject,
      submittedAt: new Date(Date.now() - DAY_MS).toISOString() });
    const stalePending = await insertFeedback({ state: "pending", projectId: hiddenProject,
      submittedAt: new Date(Date.now() - 120 * DAY_MS).toISOString() });
    const recentSuppressionAt = new Date(Date.now() - 300 * DAY_MS).toISOString();
    const recentSuppression = await insertFeedback({ state: "suppressed", projectId: archivedProject,
      submittedAt: new Date(Date.parse(recentSuppressionAt) - DAY_MS).toISOString(), decision: "suppressed",
      approvalAt: new Date(Date.parse(recentSuppressionAt) - DAY_MS).toISOString(), decisionAt: recentSuppressionAt });
    const erasedSuppression = await insertFeedback({ state: "suppressed", projectId: archivedProject,
      submittedAt: "2024-01-01T00:00:00.000Z", authorName: null, paragraph: null,
      erasedAt: "2025-10-24T00:00:00.000Z", decision: "suppressed", approvalAt: "2024-10-23T00:00:00.000Z", decisionAt: "2024-10-24T00:00:00.000Z", reason: null });
    const approved = await insertFeedback({ state: "approved", projectId: hiddenProject,
      submittedAt: new Date(Date.now() - 730 * DAY_MS).toISOString(), decision: "approved",
      decisionAt: new Date(Date.now() - 729 * DAY_MS).toISOString() });
    try {
      const snapshotReader = createOwnerExportSnapshotReader({
        configuration: {} as never,
        content: createPostgresContentAuthoringRepository(),
        moderation: reader,
        transactions: worker.transactions,
        capabilities: { async read() { return { currentCvAvailable: false, externalLinksAvailable: false }; } },
      });
      const captured = await snapshotReader.capture({ portfolioId, ownerId, snapshotId: createStableId("OwnerExportArtifact"),
        includedScopes: ["portfolio-content", "moderation-history"] });
      expect(captured.ok).toBe(true);
      if (!captured.ok || !("kind" in captured.value)) throw new Error("PHASE8_FEEDBACK_EXPORT_CAPTURE_FAILED");
      const moderationValues = captured.value.moderation?.records ?? [];
      expect(moderationValues.map(record => record.feedbackId)).toContain(pending);
      expect(moderationValues.map(record => record.feedbackId)).toContain(recentSuppression);
      expect(moderationValues.map(record => record.feedbackId)).toContain(erasedSuppression);
      expect(moderationValues.map(record => record.feedbackId)).toContain(approved);
      expect(moderationValues.map(record => record.feedbackId)).not.toContain(stalePending);
      expect(moderationValues.find(record => record.feedbackId === recentSuppression)?.value).toMatchObject({
        projectId: archivedProject, textDisposition: "retained", authorName: "PRIVATE_NAME_SENTINEL", paragraph: "PRIVATE_TEXT_SENTINEL",
      });
      const minimal = moderationValues.find(record => record.feedbackId === erasedSuppression)?.value;
      expect(minimal).toMatchObject({ projectId: archivedProject, state: "suppressed", textDisposition: "erased" });
      expect(minimal).not.toHaveProperty("authorName");
      expect(minimal).not.toHaveProperty("paragraph");
      expect((minimal?.["decisionHistory"] as Record<string, unknown>[])[0]).not.toHaveProperty("reason");

      const built = await buildSelectedOwnerExportPackage({ exportId: createStableId("OwnerExport"), snapshot: captured.value });
      const archive = await archiveBytes(built.content);
      const validated = validateOwnerExportZip(archive);
      expect(validated.manifest.schemaVersion).toBe("1.7");
      if (!("dependencies" in validated.manifest) || !Array.isArray(validated.manifest.dependencies)) throw new Error("PHASE8_FEEDBACK_EXPORT_DEPENDENCIES_MISSING");
      expect(validated.recordCounts["moderation-history"]).toBe(4);
      expect(validated.manifest.dependencies.filter(dependency => dependency["sourceScope"] === "moderation-history"))
        .toHaveLength(4);
      expect(validated.manifest.dependencies.filter(dependency => dependency["sourceScope"] === "moderation-history")
        .every(dependency => dependency["disposition"] === "included")).toBe(true);
      const externalCopies = await admin.query(`select
        (select count(*)::int from operations.outbox_events where payload::text like '%PRIVATE_NAME_SENTINEL%' or payload::text like '%PRIVATE_TEXT_SENTINEL%' or payload::text like '%PRIVATE_REASON_SENTINEL%') as outbox,
        (select count(*)::int from operations.jobs where payload::text like '%PRIVATE_NAME_SENTINEL%' or payload::text like '%PRIVATE_TEXT_SENTINEL%' or payload::text like '%PRIVATE_REASON_SENTINEL%') as jobs,
        (select count(*)::int from measurement.public_events event where event.portfolio_id=$1
          and to_jsonb(event)::text like any(array['%PRIVATE_NAME_SENTINEL%','%PRIVATE_TEXT_SENTINEL%','%PRIVATE_REASON_SENTINEL%'])) as public_events,
        (select count(*)::int from measurement.daily_aggregates report where report.portfolio_id=$1
          and to_jsonb(report)::text like any(array['%PRIVATE_NAME_SENTINEL%','%PRIVATE_TEXT_SENTINEL%','%PRIVATE_REASON_SENTINEL%'])) as reports`, [portfolioId]);
      expect(externalCopies.rows[0]).toEqual({ outbox: 0, jobs: 0, public_events: 0, reports: 0 });
    } finally {
      await cleanFixtures();
    }
  });

  it("AC03 rechecks stale cleanup candidates after real Owner approvals win on Hidden and Archived Projects", async () => {
    await seedPortfolio();
    try {
      for (const lifecycle of ["hidden", "archived"] as const) {
        const projectId = await insertProject(lifecycle);
        const cleanupNow = new Date(Date.now() + 1_000).toISOString();
        const submittedAt = new Date(Date.parse(cleanupNow) - 91 * DAY_MS).toISOString();
        const feedbackId = await insertFeedback({ state: "pending", projectId, submittedAt });
        const jobId = createStableId("Job");
        const retention = createPostgresFeedbackRetentionRepository();
        const feedbackOperations = createPostgresOperationsPersistence(application.database, { now: () => cleanupNow });
        const moderation = createOwnerFeedbackModerationService({
          scope: { portfolioId, ownerId },
          operations: feedbackOperations,
          content: createPostgresProjectInteractionFacts({ portfolioId, ownerId }),
          repository: createPostgresModerationRepository(),
          clock: { now: () => cleanupNow },
          ids: createSystemIdGenerator(),
          authorize: async query => decideAuthorization(query),
        });
        const idempotencyKey = parseIdempotencyKey(createStableId("Key"));
        if (!idempotencyKey.ok) throw new Error("PHASE8_FEEDBACK_IDEMPOTENCY_KEY_INVALID");
        let transactionOpen = false;
        await admin.query("begin");
        transactionOpen = true;
        try {
          await admin.query("select feedback_id from interaction.feedback where feedback_id=$1 for update", [feedbackId]);
          const approval = moderation.approveOwnerFeedback({ scope: { kind: "portfolio", portfolioId },
            actor: { kind: "owner", ownerId, sessionId: "phase8-feedback-retention-race" }, feedbackId,
            expectedVersion: 1, idempotencyKey: idempotencyKey.value, reason: "Approved during cleanup selection",
            correlationId: "phase8-feedback-retention-race" });
          await Promise.race([waitForRoleLock(admin, "owner_export_application_runtime"), approval.then(result => {
            throw new Error("PHASE8_FEEDBACK_APPROVAL_FINISHED_BEFORE_LOCK:" + (result.ok ? "approved" : result.error.code));
          })]);
          // Approval holds the Feedback advisory lock while waiting on this row.
          // Cleanup selects the stale candidate but must skip that lock owner.
          expect(await worker.transactions.run(transaction => retention.processBatch({ portfolioId, jobId, batchSize: 25, now: cleanupNow }, transaction)))
            .toMatchObject({ processedCount: 0, incomplete: true });
          await admin.query("commit");
          transactionOpen = false;
          expect(await approval).toMatchObject({ ok: true, value: { outcome: "feedback-approved" } });
          expect(await worker.transactions.run(transaction => retention.processBatch({ portfolioId, jobId, batchSize: 25, now: cleanupNow }, transaction)))
            .toMatchObject({ processedCount: 0 });
          const retained = await admin.query("select moderation_state from interaction.feedback where portfolio_id=$1 and feedback_id=$2", [portfolioId, feedbackId]);
          expect(retained.rows).toEqual([{ moderation_state: "approved" }]);
        } finally {
          if (transactionOpen) await admin.query("rollback");
        }
      }
    } finally {
      await cleanFixtures();
    }
  });

  it("AC04 rejects pre-ready and download snapshots after erasure, deletion, or a capture/finalization race", async () => {
    await seedPortfolio();
    const projectId = await insertProject("archived");
    const feedbackId = await insertFeedback({ state: "suppressed", projectId, submittedAt: "2026-01-01T00:00:00.000Z",
      decision: "suppressed", approvalAt: "2026-01-31T00:00:00.000Z", decisionAt: "2026-02-01T00:00:00.000Z" });
    try {
      const snapshotReader = createOwnerExportSnapshotReader({
        configuration: {} as never,
        content: createPostgresContentAuthoringRepository(),
        moderation: reader,
        transactions: worker.transactions,
        capabilities: { async read() { return { currentCvAvailable: false, externalLinksAvailable: false }; } },
      });
      const captured = await snapshotReader.capture({ portfolioId, ownerId, snapshotId: createStableId("OwnerExportArtifact"),
        includedScopes: ["moderation-history"] });
      expect(captured.ok).toBe(true);
      if (!captured.ok || !("kind" in captured.value)) throw new Error("PHASE8_FEEDBACK_EXPORT_CAPTURE_FAILED");
      const initiallyEligible = await worker.transactions.run(context => snapshotReader.revalidateModerationForReady!({
        snapshot: captured.value, portfolioId, ownerId, context,
      }));
      expect(initiallyEligible).toBe(true);
      await admin.query(`update interaction.moderation_decisions set reason=null,owner_id=null where portfolio_id=$1 and feedback_id=$2`, [portfolioId, feedbackId]);
      await admin.query(`update interaction.feedback set author_name=null,paragraph=null,text_erased_at=transaction_timestamp() where portfolio_id=$1 and feedback_id=$2`, [portfolioId, feedbackId]);
      const eraseRejected = await worker.transactions.run(context => snapshotReader.revalidateModerationForReady!({
        snapshot: captured.value, portfolioId, ownerId, context,
      }));
      expect(eraseRejected).toBe(false);
      await admin.query("delete from interaction.feedback where portfolio_id=$1 and feedback_id=$2", [portfolioId, feedbackId]);
      const deleteRejected = await worker.transactions.run(context => snapshotReader.revalidateModerationForReady!({
        snapshot: captured.value, portfolioId, ownerId, context,
      }));
      expect(deleteRejected).toBe(false);

      const pendingId = await insertFeedback({ state: "pending", projectId,
        submittedAt: new Date(Date.now() - DAY_MS).toISOString() });
      let releaseCapture!: () => void;
      let signalCaptured!: () => void;
      const captureGate = new Promise<void>(resolve => { releaseCapture = resolve; });
      const feedbackReadFinished = new Promise<void>(resolve => { signalCaptured = resolve; });
      const blockedReader: FeedbackOwnerExportSnapshotReaderPort = {
        async readOwnerExportSnapshot(input: { portfolioId: StableId<"Portfolio">; ownerId: StableId<"Owner"> }, transaction: Parameters<typeof reader.readOwnerExportSnapshot>[1]) {
          const snapshot = await reader.readOwnerExportSnapshot(input, transaction);
          signalCaptured();
          await captureGate;
          return snapshot;
        },
      };
      const racingSnapshotReader = createOwnerExportSnapshotReader({
        configuration: {} as never,
        content: createPostgresContentAuthoringRepository(),
        moderation: blockedReader,
        transactions: worker.transactions,
        capabilities: { async read() { return { currentCvAvailable: false, externalLinksAvailable: false }; } },
      });
      const pendingCapture = racingSnapshotReader.capture({ portfolioId, ownerId, snapshotId: createStableId("OwnerExportArtifact"),
        includedScopes: ["moderation-history"] });
      await feedbackReadFinished;
      try {
        await admin.query("begin");
        await admin.query(`update interaction.feedback set moderation_state='approved',approved_at=transaction_timestamp(),aggregate_version=aggregate_version+1 where feedback_id=$1`, [pendingId]);
        await admin.query(`insert into interaction.moderation_decisions (decision_id,portfolio_id,feedback_id,sequence,decision,reason,owner_id,decided_at)
          values ($1,$2,$3,1,'approved','Approved after snapshot capture',$4,transaction_timestamp())`,
          [createStableId("ModerationDecision"), portfolioId, pendingId, ownerId]);
        await admin.query("commit");
      } finally {
        await admin.query("rollback").catch(() => undefined);
        releaseCapture();
      }
      const racedCapture = await pendingCapture;
      expect(racedCapture.ok).toBe(true);
      if (!racedCapture.ok || !("kind" in racedCapture.value)) throw new Error("PHASE8_FEEDBACK_EXPORT_CAPTURE_FAILED");
      expect(racedCapture.value.moderation?.records.find(record => record.feedbackId === pendingId)?.value["state"]).toBe("pending");
      const finalizationRejected = await worker.transactions.run(context => snapshotReader.revalidateModerationForReady!({
        snapshot: racedCapture.value, portfolioId, ownerId, context,
      }));
      expect(finalizationRejected).toBe(false);
    } finally {
      await cleanFixtures();
    }
  });

  it.each([
    { selection: "Moderation only", includedScopes: ["moderation-history"] as const, terminalFailure: false },
    { selection: "Moderation with configuration", includedScopes: ["moderation-history", "portfolio-configuration"] as const, terminalFailure: false },
    { selection: "Failed Moderation build", includedScopes: ["moderation-history"] as const, terminalFailure: true },
    { selection: "Failed Moderation finalization", includedScopes: ["moderation-history"] as const, terminalFailure: true, failFinalization: true },
    { selection: "Earlier source erasure", includedScopes: ["moderation-history"] as const, terminalFailure: false, earlierErasure: true },
    { selection: "Exact Feedback deadline", includedScopes: ["moderation-history"] as const, terminalFailure: false, deadlineOnly: true },
    { selection: "Exact seven-day export expiry", includedScopes: ["moderation-history"] as const, terminalFailure: false, expiryOnly: true },
    { selection: "Upload racing cleanup", includedScopes: ["moderation-history"] as const, terminalFailure: false, raceUpload: true },
  ])("AC01/AC04 retains privacy-safe checkpoints for $selection through source retention", async ({ includedScopes, terminalFailure, failFinalization = false, earlierErasure = false, deadlineOnly = false, expiryOnly = false, raceUpload = false }) => {
    await seedPortfolio();
    const projectId = await insertProject("hidden");
    const feedbackId = await insertFeedback({ state: "approved", projectId,
      submittedAt: new Date(Date.now() - DAY_MS).toISOString(), decision: "approved",
      decisionAt: new Date(Date.now() - DAY_MS / 2).toISOString() });
    const pendingId = await insertFeedback({ state: "pending", projectId, submittedAt: new Date(Date.now() - DAY_MS).toISOString() });
    const suppressionAt = new Date(Date.now() - DAY_MS);
    if (deadlineOnly) { suppressionAt.setUTCFullYear(suppressionAt.getUTCFullYear() - 1); suppressionAt.setUTCDate(suppressionAt.getUTCDate() + 3); }
    const suppressedId = await insertFeedback({ state: "suppressed", projectId,
      submittedAt: new Date(suppressionAt.getTime() - DAY_MS).toISOString(), decision: "suppressed",
      approvalAt: new Date(suppressionAt.getTime() - DAY_MS / 2).toISOString(), decisionAt: suppressionAt.toISOString() });
    const clock = { now: () => new Date().toISOString() };
    const ids = createSystemIdGenerator();
    const applicationOperations = createPostgresOperationsPersistence(application.database, clock);
    const applicationStore = createPostgresOwnerExportStore(application.database, { outbox: applicationOperations.outbox });
    const workerOperations = createPostgresOperationsPersistence(worker.database, clock);
    const workerStore = createPostgresOwnerExportStore(worker.database, { outbox: workerOperations.outbox });
    const snapshots = createOwnerExportSnapshotReader({
      configuration: createPostgresPortfolioSettingsRepository(), content: createPostgresContentAuthoringRepository(), moderation: reader,
      transactions: worker.transactions,
      capabilities: { async read() { return { currentCvAvailable: false, externalLinksAvailable: false }; } },
    });
    let captures = 0;
    let restores = 0;
    let writes = 0;
    let stored = new Uint8Array();
    let deleteCalls = 0;
    let exportIdentity: { portfolioId: StableId<"Portfolio">; exportId: StableId<"OwnerExport">; artifactId: StableId<"OwnerExportArtifact"> } | undefined;
    const storage: OwnerExportObjectStoragePort = {
      async writeOwnerExport(input) {
        exportIdentity = input;
        if (realStorage !== undefined) {
          const result = await realStorage.writeOwnerExport(input);
          if (!result.ok) return result;
        } else stored = new Uint8Array(await archiveBytes(input.content));
        // A lost upload response leaves real bytes despite an unsuccessful build.
        if (++writes === 1 && !failFinalization) return err({ kind: "temporarily_unavailable", code: "OWNER_EXPORT_ARTIFACT_UNAVAILABLE" });
        return ok(undefined);
      },
      async readOwnerExport(input) {
        if (realStorage !== undefined) return realStorage.readOwnerExport(input);
        if (stored.byteLength === 0) return err({ kind: 'temporarily_unavailable', code: 'OWNER_EXPORT_ARTIFACT_UNAVAILABLE' });
        return ok({ contentLength: stored.byteLength,
        sha256: createHash("sha256").update(stored).digest("hex"),
        content: { async *[Symbol.asyncIterator]() { yield stored; } } }); },
    };
    const deletion: OwnerExportObjectDeletePort = { async deleteOwnerExport(input) {
      const revoked = await applicationStore.findOwnerExport({ ...input, ownerId });
      expect(revoked?.artifactRevokedAt).toBeDefined();
      expect(['failed', 'expired']).toContain(revoked?.status);
      // Revocation commits first; Storage outage cannot undo access denial.
      if (++deleteCalls === 1) return err({ kind: 'temporarily_unavailable', code: 'OWNER_EXPORT_ARTIFACT_UNAVAILABLE' });
      if (realStorage !== undefined) return realStorage.deleteOwnerExport(input);
      stored = new Uint8Array(); return ok(undefined);
    } };
    const cleanup = () => createOwnerExportArtifactCleanupService({ scope: { portfolioId, ownerId },
      artifacts: workerStore, storage: deletion, snapshots });
    const service = createOwnerExportService({
      operations: applicationOperations, exports: applicationStore, clock, ids, objectRead: storage,
      revalidateModerationForDownload: async ({ snapshot, portfolioId, ownerId }) => {
        if (!("kind" in snapshot)) return false;
        return application.transactions.run(async context => matchesOwnerExportModerationFacts(snapshot,
          projectFeedbackOwnerExportSnapshot(await reader.readOwnerExportSnapshot({ portfolioId, ownerId }, context)).records),
        { isolationLevel: "repeatable read" });
      },
    });
    const assembly = createOwnerExportAssemblyService({
      operations: workerOperations, exports: failFinalization ? { ...workerStore,
        async applyOwnerExportTransition(input) {
          if (input.toStatus === 'ready') throw new Error('SYNTHETIC_FINALIZATION_FAILURE');
          return workerStore.applyOwnerExportTransition(input);
        } } : workerStore, artifacts: workerStore, clock, ids, storage, random: () => 0,
      snapshots: { ...snapshots, async capture(input) { captures++; return snapshots.capture(input); },
        async restoreModerationSnapshot(input) {
          if (++restores === 1) return err({ kind: "temporarily_unavailable", code: "OWNER_EXPORT_MODERATION_UNAVAILABLE" });
          return snapshots.restoreModerationSnapshot!(input);
        } },
    });
    const actor = { kind: "owner" as const, ownerId, sessionId: "phase8-moderation-persisted-reload" };
    const key = parseIdempotencyKey("phase8-moderation-persisted-reload-001");
    if (!key.ok) throw new Error("PHASE8_FEEDBACK_EXPORT_KEY_INVALID");
    try {
      const requested = await service.requestOwnerExport({ actor, portfolioId, includedScopes, idempotencyKey: key.value });
      expect(requested.ok).toBe(true);
      if (!requested.ok) throw new Error("PHASE8_FEEDBACK_EXPORT_REQUEST_FAILED");
      const scope = { exportId: requested.value.exportId, portfolioId, ownerId };
      if (terminalFailure) await admin.query("update operations.jobs set attempt_count=4 where payload->>'exportId'=$1", [scope.exportId]);
      expect(await assembly.runOwnerExportAssembly({ workerId: "phase8-moderation-reload" }))
        .toMatchObject({ ok: true, value: { claimed: 1, retried: terminalFailure ? 0 : 1, failed: terminalFailure ? 1 : 0, completed: 0 } });
      const checkpoint = await workerStore.findOwnerExport(scope);
      expect(checkpoint).toMatchObject({ status: terminalFailure ? "failed" : "building", candidateArtifactId: expect.any(String),
        snapshot: { kind: "owner-export-snapshot-v1", includedScopes,
          moderationCheckpoint: { recordsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
            dependencies: expect.arrayContaining([{ feedbackId, projectId }, { feedbackId: pendingId, projectId }, { feedbackId: suppressedId, projectId }]) },
          ...(includedScopes.length === 2 ? { configuration: { settings: { profile: { displayName: "Owner" } } } } : {}) } });
      if (checkpoint?.snapshot === undefined || !("kind" in checkpoint.snapshot) || checkpoint.snapshot.moderationCheckpoint === undefined) throw new Error("PHASE8_FEEDBACK_EXPORT_CHECKPOINT_MISSING");
      expect(await workerStore.listOwnerExportCleanup({ portfolioId, ownerId: createStableId('Owner'), limit: 25 })).toEqual([]);
      expect(await workerStore.revokeOwnerExportArtifact({ ...scope, ownerId: createStableId('Owner'),
        stillEligible: async () => false })).toBeNull();
      if (storageUrl !== undefined) {
        const direct = await fetch(new URL(`/storage/v1/object/authenticated/owner-exports/${portfolioId}/${scope.exportId}/${checkpoint.candidateArtifactId}.zip`, storageUrl));
        expect(direct.ok).toBe(false);
        await direct.body?.cancel();
      }
      const assertPrivateMarkersAbsent = async () => {
        const result = await admin.query("select snapshot_data::text as checkpoint from portability.owner_exports where export_id=$1", [scope.exportId]);
        const persisted = String(result.rows[0]?.checkpoint);
        for (const marker of ["PRIVATE_NAME_SENTINEL", "PRIVATE_TEXT_SENTINEL", "PRIVATE_REASON_SENTINEL", "PRIVATE_APPROVAL_REASON_SENTINEL"]) {
          expect(persisted.includes(marker)).toBe(false);
        }
      };
      const retainSource = async () => {
        if (deadlineOnly) {
          const cutoff = checkpoint.snapshot!.policyExpiresAt!;
          await admin.query("update portability.owner_exports set expires_at=$2::timestamptz where export_id=$1", [scope.exportId, cutoff]);
          expect((await workerStore.findOwnerExport(scope))?.expiresAt).toBe(cutoff);
          expect(await cleanup().runOwnerExportCleanup()).toMatchObject({ ok: true, value: { deleted: 0, pending: 0 } });
          await admin.query("update portability.owner_exports set expires_at=clock_timestamp() where export_id=$1", [scope.exportId]);
        } else if (expiryOnly) {
          await admin.query("update portability.owner_exports set expires_at=clock_timestamp()+interval '1 minute' where export_id=$1", [scope.exportId]);
          expect(await cleanup().runOwnerExportCleanup()).toMatchObject({ ok: true, value: { deleted: 0, pending: 0 } });
          expect(await service.downloadOwnerExport({ actor, ...scope })).toMatchObject({ ok: true });
          await admin.query("update portability.owner_exports set expires_at=clock_timestamp() where export_id=$1", [scope.exportId]);
        } else if (earlierErasure) {
          await admin.query('update interaction.moderation_decisions set reason=null,owner_id=null where feedback_id=$1', [suppressedId]);
          await admin.query('update interaction.feedback set author_name=null,paragraph=null,text_erased_at=clock_timestamp() where feedback_id=$1', [suppressedId]);
        } else {
        const retention = createPostgresFeedbackRetentionRepository();
        const input = { portfolioId, jobId: createStableId("Job"), batchSize: 25 as const,
          now: new Date(Date.now() + 367 * DAY_MS).toISOString() };
        let complete = false;
        for (let batch = 0; batch < 4; batch++) {
          const result = await worker.transactions.run(context => retention.processBatch(input, context));
          if (!result.incomplete) { complete = true; break; }
        }
        expect(complete).toBe(true);
        expect((await admin.query("select count(*)::int as count from interaction.feedback where feedback_id=$1", [pendingId])).rows[0]?.count).toBe(0);
        expect((await admin.query("select author_name,paragraph from interaction.feedback where feedback_id=$1", [suppressedId])).rows)
          .toEqual([{ author_name: null, paragraph: null }]);
        expect((await admin.query("select count(*)::int as count from interaction.moderation_decisions where feedback_id=$1 and (reason is not null or owner_id is not null)", [suppressedId])).rows[0]?.count).toBe(0);
        }
        await assertPrivateMarkersAbsent();
        if (expiryOnly) {
          expect(await worker.transactions.run(context => snapshots.revalidateModerationForReady!({ snapshot: checkpoint.snapshot!, portfolioId, ownerId, context }))).toBe(true);
        } else if (!deadlineOnly) {
          expect(await worker.transactions.run(context => snapshots.revalidateModerationForReady!({ snapshot: checkpoint.snapshot!, portfolioId, ownerId, context }))).toBe(false);
          expect(await snapshots.restoreModerationSnapshot!({ snapshot: checkpoint.snapshot!, portfolioId, ownerId })).toMatchObject({ ok: false });
        }
        expect(await service.downloadOwnerExport({ actor, ...scope })).toMatchObject({ ok: false });
        expect(exportIdentity).toBeDefined();
        // The first delete fails after durable revocation. Reconstructing the
        // service simulates restart; it retries from persisted state.
        expect(await cleanup().runOwnerExportCleanup({ limit: 1 })).toMatchObject({ ok: true, value: { pending: 1, deleted: 0, incomplete: true } });
        const revoked = await workerStore.findOwnerExport(scope);
        expect(revoked?.artifactRevokedAt).toBeDefined();
        expect(revoked?.artifactRevocationCode).toBe(terminalFailure ? "build_failed" : deadlineOnly || expiryOnly ? "expired" : "privacy_invalid");
        expect(revoked?.artifactDeletedAt).toBeUndefined();
        const invalidations = await workerStore.listOwnerExportInvalidationLedger({ portfolioId, limit: 100 });
        const invalidation = invalidations.find(entry => entry.exportId === scope.exportId);
        expect(invalidation).toEqual({ portfolioId, exportId: scope.exportId, artifactId: checkpoint.candidateArtifactId,
          revokedAt: expect.any(String), revocationCode: terminalFailure ? "build_failed" : deadlineOnly || expiryOnly ? "expired" : "privacy_invalid" });
        expect(await service.downloadOwnerExport({ actor, ...scope })).toMatchObject({ ok: false });
        expect(await cleanup().runOwnerExportCleanup()).toMatchObject({ ok: true, value: { deleted: 1, pending: 0 } });
        expect((await workerStore.findOwnerExport(scope))?.artifactDeletedAt).toBeDefined();
        const reconciledInvalidation = (await workerStore.listOwnerExportInvalidationLedger({ portfolioId, limit: 100 }))
          .find(entry => entry.exportId === scope.exportId);
        expect(reconciledInvalidation?.artifactDeletedAt).toEqual(expect.any(String));
        expect(await storage.readOwnerExport({ ...exportIdentity!, expectedContentLength: checkpoint.candidateContentLength!,
          expectedSha256: checkpoint.candidateSha256! })).toMatchObject({ ok: false });
        expect(await cleanup().runOwnerExportCleanup()).toMatchObject({ ok: true, value: { scanned: 0, deleted: 0 } });
      };
      await assertPrivateMarkersAbsent();
      if (terminalFailure) { await retainSource(); return; }
      if (raceUpload) {
        await admin.query("update operations.jobs set available_at=clock_timestamp()-interval '1 second' where payload->>'exportId'=$1", [scope.exportId]);
        const [lease] = await workerOperations.jobs.claimDue({ workerId: 'phase8-cleanup-race', now: clock.now(), leaseDurationSeconds: 300,
          limit: 1, jobTypes: ['portability.owner-export-assembly.v1'] });
        if (lease === undefined) throw new Error('PHASE8_CLEANUP_RACE_LEASE_MISSING');
        const jobId = createStableId('Job');
        const racingJobId = { ...lease, jobId: lease.jobId as typeof jobId };
        const identity = { ...exportIdentity!, actingJobId: racingJobId.jobId, leaseToken: lease.leaseToken };
        const original = await storage.readOwnerExport({ ...identity, expectedContentLength: checkpoint.candidateContentLength!, expectedSha256: checkpoint.candidateSha256! });
        if (!original.ok) throw new Error('PHASE8_CLEANUP_RACE_BYTES_MISSING');
        const bytes = await archiveBytes(original.value.content);
        let release!: () => void, signal!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { signal = resolve; });
        const uploading = workerStore.uploadCandidate(identity, async () => {
          signal(); await gate;
          if (realStorage !== undefined) return (await realStorage.writeOwnerExport({ ...identity,
            contentLength: bytes.byteLength, sha256: checkpoint.candidateSha256!,
            content: { async *[Symbol.asyncIterator]() { yield bytes; } } })).ok;
          stored = new Uint8Array(bytes); return true;
        });
        await started;
        const retaining = retainSource();
        try { await waitForRoleLock(admin, 'owner_export_worker_runtime'); }
        finally { release(); }
        expect(await uploading).toBe(true);
        await retaining;
        let lateWrites = 0;
        expect(await workerStore.uploadCandidate(identity, async () => { lateWrites++; return true; })).toBe(false);
        expect(lateWrites).toBe(0);
        expect(await workerStore.applyOwnerExportTransition({ exportId: scope.exportId, fromStatus: 'building', toStatus: 'ready',
          expectedAggregateVersion: checkpoint.aggregateVersion, actingJobId: racingJobId.jobId, leaseToken: lease.leaseToken,
          transitionedAt: clock.now(), artifactId: identity.artifactId })).toMatchObject({ ok: true, value: { kind: 'stale' } });
        return;
      }
      expect(await worker.transactions.run(context => snapshots.revalidateModerationForReady!({
        snapshot: checkpoint.snapshot!, portfolioId, ownerId, context,
      }))).toBe(true);
      await admin.query("update operations.jobs set available_at=clock_timestamp()-interval '1 second' where payload->>'exportId'=$1", [scope.exportId]);
      expect(await assembly.runOwnerExportAssembly({ workerId: "phase8-moderation-reload" }))
        .toMatchObject({ ok: true, value: { claimed: 1, completed: 0, retried: 1, failed: 0 } });
      expect(writes).toBe(1);
      await admin.query("update operations.jobs set available_at=clock_timestamp()-interval '1 second' where payload->>'exportId'=$1", [scope.exportId]);
      expect(await assembly.runOwnerExportAssembly({ workerId: "phase8-moderation-reload" }))
        .toMatchObject({ ok: true, value: { claimed: 1, completed: 1, retried: 0, failed: 0 } });
      expect(captures).toBe(1);
      const ready = await applicationStore.findOwnerExport(scope);
      expect(ready).toMatchObject({ status: "ready", schemaVersion: "1.7", candidateArtifactId: checkpoint.candidateArtifactId });
      expect(await cleanup().runOwnerExportCleanup()).toMatchObject({ ok: true, value: { deleted: 0, pending: 0 } });
      const download = await service.downloadOwnerExport({ actor, ...scope });
      expect(download.ok).toBe(true);
      if (!download.ok) throw new Error("PHASE8_FEEDBACK_EXPORT_DOWNLOAD_FAILED");
      const validated = validateOwnerExportZip(await archiveBytes(download.value.content));
      expect(validated.includedScopes).toEqual(includedScopes);
      expect(validated.recordCounts["moderation-history"]).toBe(3);
      if (includedScopes.length === 2) expect(validated.recordCounts["portfolio-configuration"]).toBe(1);

      // The checkpoint parser must reject scope/shape drift before exposing persisted facts.
      for (const moderation of [null, [], {}, { recordsDigest: "invalid", dependencies: [] },
        { recordsDigest: "a".repeat(64), dependencies: [null] },
        { ...checkpoint.snapshot.moderationCheckpoint, authorName: "PRIVATE_NAME_SENTINEL" }]) {
        await admin.query("update portability.owner_exports set snapshot_data=jsonb_set(snapshot_data,'{moderationCheckpoint}',$2::jsonb) where export_id=$1", [scope.exportId, JSON.stringify(moderation)]);
        await expect(applicationStore.findOwnerExport(scope)).rejects.toThrow();
      }
      await admin.query("update portability.owner_exports set snapshot_data=$2::jsonb where export_id=$1", [scope.exportId, JSON.stringify(checkpoint.snapshot)]);
      if (!deadlineOnly && !earlierErasure && !expiryOnly) {
        await admin.query("update interaction.feedback set paragraph='Changed retained feedback' where feedback_id=$1", [feedbackId]);
        expect(await service.downloadOwnerExport({ actor, ...scope })).toMatchObject({ ok: false });
      }
      await retainSource();
    } finally {
      try {
        if (realStorage !== undefined && exportIdentity !== undefined) {
          const removed = await realStorage.deleteOwnerExport(exportIdentity);
          expect(removed.ok, 'PHASE8_STORAGE_FIXTURE_CLEANUP_FAILED').toBe(true);
        }
      } finally { await cleanFixtures(); }
    }
  });

  it("AC06 grants direct reads only to the matching Owner and exact worker purpose", async () => {
    await seedPortfolio();
    const projectId = await insertProject("hidden");
    await insertFeedback({ state: "approved", projectId, submittedAt: new Date(Date.now() - 730 * DAY_MS).toISOString(),
      decision: "approved", decisionAt: new Date(Date.now() - 729 * DAY_MS).toISOString() });
    try {
      expect(await visibleFeedback(worker.database, {
        portfolioId, ownerId, workerPurpose: "interaction.owner-export", feedbackAccess: "owner-export",
      })).toEqual({ feedback: 1, decisions: 1 });
      expect(await visibleFeedback(worker.database, {
        portfolioId, ownerId, workerPurpose: "feedback.retention", feedbackAccess: "owner-export",
      })).toEqual({ feedback: 0, decisions: 0 });
      expect(await visibleFeedback(worker.database, {
        portfolioId, ownerId: createStableId("Owner"), workerPurpose: "interaction.owner-export", feedbackAccess: "owner-export",
      })).toEqual({ feedback: 0, decisions: 0 });
      expect(await visibleFeedback(worker.database, {
        portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner"),
        workerPurpose: "interaction.owner-export", feedbackAccess: "owner-export",
      })).toEqual({ feedback: 0, decisions: 0 });
      expect(await visibleFeedback(application.database, {
        portfolioId, ownerId, feedbackAccess: "owner-export",
      })).toEqual({ feedback: 1, decisions: 1 });
      expect(await visibleFeedback(application.database, {
        portfolioId, ownerId: createStableId("Owner"), feedbackAccess: "owner-export",
      })).toEqual({ feedback: 0, decisions: 0 });
      expect(await visibleFeedback(application.database, {
        portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner"), feedbackAccess: "owner-export",
      })).toEqual({ feedback: 0, decisions: 0 });
    } finally {
      await cleanFixtures();
    }
  });
});
