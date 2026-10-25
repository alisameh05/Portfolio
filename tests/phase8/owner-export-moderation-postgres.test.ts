import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { sql } from "kysely";
import { createPostgresContentAuthoringRepository } from "../../src/modules/content-publishing/adapters/postgres-authoring.js";
import { createPostgresProjectInteractionFacts } from "../../src/modules/content-publishing/adapters/postgres-interaction-facts.js";
import { createPostgresModerationRepository } from "../../src/modules/interaction-moderation/adapters/postgres-moderation.js";
import { createPostgresFeedbackOwnerExportSnapshotReader } from "../../src/modules/interaction-moderation/adapters/postgres-owner-export.js";
import type { FeedbackOwnerExportSnapshotReaderPort } from "../../src/modules/interaction-moderation/application/owner-export.js";
import { createPostgresFeedbackRetentionRepository } from "../../src/modules/interaction-moderation/adapters/postgres-retention.js";
import { createOwnerFeedbackModerationService } from "../../src/modules/interaction-moderation/application/moderation.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { buildSelectedOwnerExportPackage } from "../../src/modules/portability-operations/application/owner-export-package.js";
import { decideAuthorization } from "../../src/modules/identity-access/index.js";
import { createOwnerExportSnapshotReader } from "../../src/runtime/adapters/owner-export-snapshot.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createStableId, parseIdempotencyKey, type StableId } from "../../src/shared/domain/index.js";
import { validateOwnerExportZip } from "../../scripts/owner-export/validator.mjs";

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

async function waitForRetentionDeleteLock(admin: Client): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const waiting = await admin.query(`select count(*)::int as count from pg_stat_activity
      where usename = 'owner_export_worker_runtime' and state = 'active'
        and wait_event_type = 'Lock' and query ilike '%delete from interaction.feedback%'`);
    if (Number(waiting.rows[0]?.count ?? 0) > 0) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("PHASE8_FEEDBACK_RETENTION_RACE_LOCK_NOT_OBSERVED");
}

async function waitForRoleLock(admin: Client, username: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
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
      set_config('shipwithali.feedback_access', ${input.feedbackAccess}, true)`.execute(transaction);
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
    await admin.query(`delete from operations.outbox_events where aggregate_id in
      (select feedback_id from interaction.feedback where portfolio_id=$1)`, [portfolioId]);
    await admin.query("delete from operations.idempotency_records where operation_scope like $1", [`interaction.moderation:%:${portfolioId}:%`]);
    await admin.query("delete from interaction.feedback_retention_checkpoints where portfolio_id=$1", [portfolioId]);
    await admin.query("delete from interaction.feedback where portfolio_id=$1", [portfolioId]);
    await admin.query("delete from content.items where portfolio_id=$1", [portfolioId]);
    await admin.query("delete from portfolio_config.settings where portfolio_id=$1", [portfolioId]);
  }

  beforeAll(async () => { await admin.connect(); });
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
      expect(validated.recordCounts["moderation-history"]).toBe(4);
      expect(validated.manifest.dependencies.filter(dependency => dependency.sourceScope === "moderation-history"))
        .toHaveLength(4);
      expect(validated.manifest.dependencies.filter(dependency => dependency.sourceScope === "moderation-history")
        .every(dependency => dependency.disposition === "included")).toBe(true);
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
        let cleanup: Promise<unknown> | undefined;
        await admin.query("begin");
        transactionOpen = true;
        try {
          await admin.query("select feedback_id from interaction.feedback where feedback_id=$1 for update", [feedbackId]);
          const approval = moderation.approveOwnerFeedback({ scope: { kind: "portfolio", portfolioId },
            actor: { kind: "owner", ownerId, sessionId: "phase8-feedback-retention-race" }, feedbackId,
            expectedVersion: 1, idempotencyKey: idempotencyKey.value, reason: "Approved during cleanup selection",
            correlationId: "phase8-feedback-retention-race" });
          await waitForRoleLock(admin, "owner_export_application_runtime");
          cleanup = worker.transactions.run(transaction => retention.processBatch({ portfolioId, jobId, batchSize: 25, now: cleanupNow }, transaction));
          await waitForRetentionDeleteLock(admin);
          await admin.query("commit");
          transactionOpen = false;
          expect(await approval).toMatchObject({ ok: true, value: { outcome: "feedback-approved" } });
          await cleanup;
          const retained = await admin.query("select moderation_state from interaction.feedback where portfolio_id=$1 and feedback_id=$2", [portfolioId, feedbackId]);
          expect(retained.rows).toEqual([{ moderation_state: "approved" }]);
        } finally {
          if (transactionOpen) await admin.query("rollback");
          if (cleanup !== undefined) await cleanup;
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
      expect(racedCapture.value.moderation?.records.find(record => record.feedbackId === pendingId)?.value.state).toBe("pending");
      const finalizationRejected = await worker.transactions.run(context => snapshotReader.revalidateModerationForReady!({
        snapshot: racedCapture.value, portfolioId, ownerId, context,
      }));
      expect(finalizationRejected).toBe(false);
    } finally {
      await cleanFixtures();
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
