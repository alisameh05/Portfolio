/**
 * Phase 8 #237 rollback and recovery PostgreSQL acceptance.
 *
 * Complements the Phase 7 due-work suite with the recovery evidence this
 * ticket owns: forced domain rollback without residue, optional post-commit
 * export failure preservation, and failed Owner-export recovery through a
 * fresh request. Writes use their production roles — the application runtime
 * connection owns idempotency receipts and outbox events, the worker runtime
 * connection owns job reservations.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { parseSafeErrorCode } from "../../src/modules/portability-operations/index.js";
import { createDailyAggregateWorkService } from "../../src/modules/measurement/application/daily-aggregates.js";
import { createPostgresDailyAggregateRepository } from "../../src/modules/measurement/adapters/postgres-daily-aggregates.js";
import { createMeasurementRetentionWorkService } from "../../src/modules/measurement/application/retention.js";
import { createPostgresMeasurementRetentionRepository } from "../../src/modules/measurement/adapters/postgres-retention.js";
import { createFeedbackRetentionWorkService } from "../../src/modules/interaction-moderation/application/retention.js";
import { createPostgresFeedbackRetentionRepository } from "../../src/modules/interaction-moderation/adapters/postgres-retention.js";
import { createPhase7DueWorkService } from "../../src/runtime/phase7-due-work.js";
import { requestTransactionRollback } from "../../src/runtime/ports.js";
import { parseIdempotencyKey, parseStableId, type IdempotencyKey, type StableId } from "../../src/shared/domain/index.js";

const WORKER_URL = process.env["PHASE7_JOBS_WORKER_URL"];
const ADMIN_URL = process.env["PHASE7_JOBS_ADMIN_URL"];
const APPLICATION_URL = process.env["PHASE7_JOBS_APPLICATION_URL"];
const portfolioId = "0196a1b2-7c3d-7e11-9f22-000000000001" as StableId<"Portfolio">;
const aggregatePortfolioId = "0196a1b2-7c3d-7e11-9f22-000000000009" as StableId<"Portfolio">;
const invalidPayloadPortfolioId = "0196a1b2-7c3d-7e11-9f22-00000000000a" as StableId<"Portfolio">;
const routeId = "0196a1b2-7c3d-7e11-9f22-000000000002" as StableId<"PublicRoute">;
const measurementSubject = "0196a1b2-7c3d-7e11-9f22-000000000003" as StableId<"MeasurementVisitor">;
const retentionTypes = ["measurement.detail-retention.v1", "measurement.aggregate-retention.v1",
  "measurement.withdrawal-cleanup.v1", "interaction.feedback-retention.v1"] as const;
let now = new Date().toISOString();
let admin: Client | undefined;
let worker: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
let application: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
let sequence = 200;

function id<T extends string>(kind: T): StableId<T> {
  const parsed = parseStableId(kind, `0196a1b2-7c3d-7e11-9f22-${(sequence++).toString(16).padStart(12, "0")}`);
  if (!parsed.ok) throw new Error("PHASE8_ROLLBACK_RECOVERY_TEST_ID_INVALID");
  return parsed.value;
}

function workCommand(jobId: StableId<"Job">, purpose: "measurement.aggregate", at: string,
  scope: StableId<"Portfolio"> = portfolioId) {
  return { scope: { kind: "portfolio" as const, portfolioId: scope }, correlationId: "phase8-rollback-recovery-postgres",
    actor: { kind: "system" as const, jobId, purpose }, batchSize: 100 as const, now: at };
}

async function makeJobAvailableInDatabasePast(jobId: StableId<"Job">): Promise<void> {
  const updated = await admin!.query("update operations.jobs set available_at=clock_timestamp()-interval '1 millisecond' where job_id=$1 returning job_id",
    [jobId]);
  if (updated.rowCount !== 1) throw new Error("PHASE8_ROLLBACK_RECOVERY_TEST_JOB_NOT_FOUND");
}

async function addEvent(input: { eventId: StableId<"PublicEvent">; acceptedAt: string; occurredAt: string;
  portfolioId?: StableId<"Portfolio"> }): Promise<void> {
  await admin!.query(`insert into measurement.public_events
    (event_id,portfolio_id,measurement_subject,action,occurred_at,accepted_at,effective_at,page_route_identity,project_id,locale,consent_version)
    values ($1,$2,$3,'page-viewed',$4,$5,$4,$6,null,'en','v1')`,
  [input.eventId, input.portfolioId ?? portfolioId, measurementSubject, input.occurredAt, input.acceptedAt, routeId]);
}

async function seedReadyAggregationScope(scope: StableId<"Portfolio">, policyPeriod: string): Promise<void> {
  const operations = createPostgresOperationsPersistence(worker!.database);
  await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope, fromPeriod: policyPeriod, throughPeriod: policyPeriod });
  for (const type of retentionTypes) {
    const enqueued = await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, {
      jobId: id("Job"), payload: { type, version: 1, value: {} }, availableAt: `${policyPeriod}T00:00:00.000Z`,
      semanticSchedule: { portfolioId: scope, period: policyPeriod },
    }));
    if (!enqueued) throw new Error("PHASE8_ROLLBACK_RECOVERY_RETENTION_ENQUEUE_FAILED");
  }
  const advanced = await operations.jobs.advancePhase7RetentionSchedule({ portfolioId: scope,
    expectedNextPeriod: policyPeriod, scheduledThroughPeriod: policyPeriod });
  if (!advanced) throw new Error("PHASE8_ROLLBACK_RECOVERY_RETENTION_CURSOR_FAILED");
  await admin!.query("update operations.jobs set status='completed',completed_at=clock_timestamp() where semantic_scope_id=$1 and job_type=any($2::text[])",
    [scope, retentionTypes]);
  const ready = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope,
    fromPeriod: policyPeriod, throughPeriod: policyPeriod });
  if (ready.phase !== "aggregate" || ready.retentionCompleteThrough !== policyPeriod) {
    throw new Error("PHASE8_ROLLBACK_RECOVERY_RETENTION_NOT_READY");
  }
}

describe.runIf(Boolean(WORKER_URL && ADMIN_URL && APPLICATION_URL))("Phase 8 rollback and recovery PostgreSQL acceptance", () => {
  beforeAll(async () => {
    if (!WORKER_URL || !ADMIN_URL || !APPLICATION_URL) throw new Error("PHASE8_ROLLBACK_RECOVERY_DATABASE_REQUIRED");
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    worker = createPostgresRuntimeDatabase(WORKER_URL);
    application = createPostgresRuntimeDatabase(APPLICATION_URL);
    // Keep due-time fixtures safely in the database past after eligibility
    // moved from caller time to PostgreSQL time.
    const databaseNow = await admin.query<{ now: Date }>("select clock_timestamp() as now");
    now = databaseNow.rows[0]!.now.toISOString();
  });

  afterAll(async () => {
    // The acceptance runner shares one disposable PostgreSQL cluster across
    // suites, so this suite leaves no committed rows behind before yielding
    // the database to the next file.
    try {
      // Audit tables hold foreign keys into jobs, so they are cleared first
      // regardless of which suite ran before this one in the shared cluster.
      await admin?.query("delete from measurement.daily_aggregates where portfolio_id=any($1::uuid[])", [[portfolioId, aggregatePortfolioId]]);
      await admin?.query("delete from measurement.public_events where portfolio_id=any($1::uuid[])", [[portfolioId, aggregatePortfolioId]]);
      await admin?.query("delete from operations.job_redrive_audit");
      await admin?.query("delete from operations.idempotency_records");
      await admin?.query("delete from operations.outbox_events");
      await admin?.query("delete from operations.incidents");
      await admin?.query("delete from operations.jobs");
      await admin?.query("delete from operations.phase7_schedule_progress where portfolio_id=any($1::uuid[])",
        [[aggregatePortfolioId, invalidPayloadPortfolioId]]);
      await worker?.resource.close();
      await application?.resource.close();
      await admin?.end();
    } finally {
      admin = undefined;
      worker = undefined;
      application = undefined;
    }
  });

  it("forces a domain rollback that yields no outbox event, job, or durable receipt", async () => {
    // Application boundary: the reserved receipt and both projected outbox
    // events share one domain transaction; a forced rollback discards them.
    const applicationOperations = createPostgresOperationsPersistence(application!.database);
    const forcedEventId = id("DomainEvent");
    const forcedEffectEventId = id("DomainEvent");
    const expiresAt = new Date(Date.parse(now) + 3_600_000).toISOString();
    const rollbackKey = parseIdempotencyKey("export-rollback-recovery-key");
    if (!rollbackKey.ok) throw new Error("PHASE8_ROLLBACK_RECOVERY_IDEMPOTENCY_KEY_INVALID");
    const forced = await applicationOperations.transactions.run(async transaction => {
      await applicationOperations.outbox.append(transaction, {
        eventId: forcedEventId, aggregateId: portfolioId, aggregateVersion: 1,
        payload: { type: "phase8.rollback-probe.v1", version: 1, value: {} },
        correlationId: "phase8-forced-rollback", occurredAt: now, availableAt: now,
      });
      await applicationOperations.idempotency.execute({
        operationScope: "phase8.forced-rollback", actorScope: "b".repeat(64),
        key: rollbackKey.value,
        requestHash: "c".repeat(64), expiresAt,
      }, async effectContext => {
        // The projected effect exists only while its request receipt is reserved.
        await applicationOperations.outbox.append(effectContext, {
          eventId: forcedEffectEventId, aggregateId: portfolioId, aggregateVersion: 1,
          payload: { type: "phase8.rollback-probe.v2", version: 1, value: {} },
          correlationId: "phase8-forced-rollback", occurredAt: now, availableAt: now,
        });
        return { exportId: id("OwnerExport") as string };
      }, transaction);
      return requestTransactionRollback({ rolledBack: true });
    });
    expect(forced).toEqual({ rolledBack: true });
    expect((await admin!.query("select count(*)::int as count from operations.outbox_events where event_id = any($1::uuid[])",
      [[forcedEventId, forcedEffectEventId]])).rows).toEqual([{ count: 0 }]);
    expect((await admin!.query("select count(*)::int as count from operations.idempotency_records where operation_scope='phase8.forced-rollback'")).rows)
      .toEqual([{ count: 0 }]);

    // Worker runtime: a leased queue reservation is discardable the same way.
    const workerOperations = createPostgresOperationsPersistence(worker!.database);
    const committedJobId = id("Job");
    const rollbackJobId = id("Job");
    await workerOperations.transactions.run(transaction => workerOperations.jobs.enqueue(transaction, {
      jobId: committedJobId, availableAt: now,
      payload: { type: "phase8.rollback-probe.v1", version: 1, value: {} },
    }));
    const rolledBack = await workerOperations.transactions.run(async transaction => {
      await workerOperations.jobs.enqueue(transaction, {
        jobId: rollbackJobId, availableAt: now,
        payload: { type: "phase8.rollback-probe.v1", version: 1, value: {} },
      });
      return requestTransactionRollback({ rolledBack: true });
    });
    expect(rolledBack).toEqual({ rolledBack: true });
    expect((await admin!.query("select count(*)::int as count from operations.jobs where job_id=$1", [rollbackJobId])).rows)
      .toEqual([{ count: 0 }]);
    expect((await admin!.query("select job_id from operations.jobs where job_id=$1", [committedJobId])).rows)
      .toHaveLength(1);
  });

  it("keeps committed core state valid when optional post-commit export work fails", async () => {
    const operations = createPostgresOperationsPersistence(worker!.database);
    const committedEvent = id("PublicEvent");
    await addEvent({ eventId: committedEvent, occurredAt: now, acceptedAt: now, portfolioId: aggregatePortfolioId });
    const aggregateJobId = id("Job");
    const utcDay = now.slice(0, 10);
    await seedReadyAggregationScope(aggregatePortfolioId, utcDay);
    await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, {
      jobId: aggregateJobId, availableAt: now,
      payload: { type: "measurement.daily-aggregate.v1", version: 1, value: { utcDay } },
      semanticSchedule: { portfolioId: aggregatePortfolioId, period: `${utcDay}:${utcDay}` },
    }));
    await makeJobAvailableInDatabasePast(aggregateJobId);
    const publication = await operations.jobs.claimDue({ workerId: "phase8-committed-state", now,
      leaseDurationSeconds: 60, limit: 1, jobTypes: ["measurement.daily-aggregate.v1"], semanticScopeId: aggregatePortfolioId });
    expect(publication).toHaveLength(1);
    expect(publication[0]!.jobId).toBe(aggregateJobId);
    const daily = createDailyAggregateWorkService({ portfolioId: aggregatePortfolioId, transactions: worker!.transactions,
      repository: createPostgresDailyAggregateRepository() });
    const aggregated = await daily.aggregateDay({
      ...workCommand(aggregateJobId, "measurement.aggregate", now, aggregatePortfolioId), utcDay });
    expect(aggregated).toMatchObject({ ok: true });
    expect(await operations.jobs.complete(aggregateJobId, publication[0]!.leaseToken, now)).toBe(true);
    const committedAggregate = (await admin!.query(`select event_count,metric_key,dimensions from measurement.daily_aggregates
      where portfolio_id=$1 and utc_day=$2 and metric_kind='action' and dimensions='{}'::jsonb order by metric_key`, [aggregatePortfolioId, utcDay])).rows;
    const committedSource = (await admin!.query("select event_id,accepted_at from measurement.public_events where event_id=$1", [committedEvent])).rows;
    if (committedAggregate.length === 0) throw new Error("PHASE8_ROLLBACK_RECOVERY_COMMITTED_STATE_MISSING");

    const exportAssemblyJobId = id("Job");
    const failedExportArtifactId = id("OwnerExport");
    await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, {
      jobId: exportAssemblyJobId, availableAt: now,
      payload: { type: "portability.export_assembly.v1", version: 1, value: { exportId: failedExportArtifactId } },
    }));
    await makeJobAvailableInDatabasePast(exportAssemblyJobId);
    const exportClaim = await operations.jobs.claimDue({ workerId: "phase8-optional-export", now,
      leaseDurationSeconds: 60, limit: 1, jobTypes: ["portability.export_assembly.v1"] });
    expect(exportClaim).toHaveLength(1);
    expect(await operations.jobs.fail(exportClaim[0]!.jobId, exportClaim[0]!.leaseToken,
      parseSafeErrorCode("EXPORT_ASSEMBLY_FAILED"))).toBe(true);
    expect((await admin!.query("select status,attempt_count,payload,last_error_code from operations.jobs where job_id=$1",
      [exportAssemblyJobId])).rows)
      .toEqual([{ status: "dead", attempt_count: 1, payload: { exportId: failedExportArtifactId }, last_error_code: "EXPORT_ASSEMBLY_FAILED" }]);
    expect((await admin!.query("select occurrences,safe_error_code from operations.incidents where incident_key=$1",
      [`job:${exportAssemblyJobId}`])).rows).toEqual([{ occurrences: 1, safe_error_code: "EXPORT_ASSEMBLY_FAILED" }]);
    expect((await admin!.query(`select event_count,metric_key,dimensions from measurement.daily_aggregates
      where portfolio_id=$1 and utc_day=$2 and metric_kind='action' and dimensions='{}'::jsonb order by metric_key`, [aggregatePortfolioId, utcDay])).rows)
      .toEqual(committedAggregate);
    expect((await admin!.query("select event_id,accepted_at from measurement.public_events where event_id=$1", [committedEvent])).rows)
      .toEqual(committedSource);
  });

  it("puts failed export recovery on a fresh request instead of a replayed or reused artifact", async () => {
    // Owner export requests, their receipts, and their projected outbox events
    // execute on the application role, while the export assembly lifecycle
    // (terminal first-claim failure here) executes on the worker role.
    const applicationOperations = createPostgresOperationsPersistence(application!.database);
    const workerOperations = createPostgresOperationsPersistence(worker!.database);
    const actorScope = "d".repeat(64);
    const expiresAt = new Date(Date.parse(now) + 3_600_000).toISOString();
    const failedExportArtifactId = id("OwnerExport");
    const recoveredArtifactId = id("OwnerExport");
    const originalEventId = id("DomainEvent");
    const recoveredEventId = id("DomainEvent");
    const neverUsedEventId = id("DomainEvent");
    const originalRequestKey = parseIdempotencyKey("owner-export-request-237");
    const recoveryRequestKey = parseIdempotencyKey("owner-export-recovery-237");
    if (!originalRequestKey.ok || !recoveryRequestKey.ok) throw new Error("PHASE8_ROLLBACK_RECOVERY_IDEMPOTENCY_KEY_INVALID");
    const executeRequest = (key: IdempotencyKey, requestHash: string, exportId: string, eventId: string) =>
      applicationOperations.idempotency.execute({
        operationScope: "portfolio.owner-export", actorScope,
        key, requestHash, expiresAt,
      }, async context => {
        await applicationOperations.outbox.append(context, {
          eventId, aggregateId: portfolioId, aggregateVersion: 1,
          payload: { type: "portability.owner-export-ready.v1", version: 1, value: {} },
          correlationId: "phase8-export-recovery", occurredAt: now, availableAt: now,
        });
        return { exportId };
      });

    // The terminal artifact is a real failed export: its request reserves the
    // artifact, its assembly lifecycle dies on the first claim, and one
    // durable incident records the failure.
    const failedExportJobId = id("Job");
    await workerOperations.transactions.run(transaction => workerOperations.jobs.enqueue(transaction, {
      jobId: failedExportJobId, availableAt: now,
      payload: { type: "portability.export_assembly.v1", version: 1, value: { exportId: failedExportArtifactId } },
    }));
    await makeJobAvailableInDatabasePast(failedExportJobId);
    const first = await executeRequest(originalRequestKey.value, "c".repeat(64), failedExportArtifactId, originalEventId);
    expect(first).toMatchObject({ kind: "executed", result: { exportId: failedExportArtifactId } });
    const failedClaim = await workerOperations.jobs.claimDue({ workerId: "phase8-export-failure", now,
      leaseDurationSeconds: 60, limit: 1, jobTypes: ["portability.export_assembly.v1"] });
    expect(failedClaim).toHaveLength(1);
    expect(failedClaim[0]!.jobId).toBe(failedExportJobId);
    expect(await workerOperations.jobs.fail(failedClaim[0]!.jobId, failedClaim[0]!.leaseToken,
      parseSafeErrorCode("EXPORT_ASSEMBLY_FAILED"))).toBe(true);
    const failedJobRow = { status: "dead", attempt_count: 1, payload: { exportId: failedExportArtifactId }, last_error_code: "EXPORT_ASSEMBLY_FAILED" };
    expect((await admin!.query("select status,attempt_count,payload,last_error_code from operations.jobs where job_id=$1", [failedExportJobId])).rows)
      .toEqual([failedJobRow]);
    expect((await admin!.query("select occurrences,safe_error_code from operations.incidents where incident_key=$1",
      [`job:${failedExportJobId}`])).rows).toEqual([{ occurrences: 1, safe_error_code: "EXPORT_ASSEMBLY_FAILED" }]);

    // Recovery never goes through the original request: a verbatim replay
    // only replays the original envelope without new effects, changed
    // content under the original key is refused as a conflict, and success
    // requires a fresh key, request hash, and artifact identity.
    const replay = await executeRequest(originalRequestKey.value, "c".repeat(64), recoveredArtifactId, neverUsedEventId);
    expect(replay).toMatchObject({ kind: "replayed", result: { exportId: failedExportArtifactId } });
    expect((await admin!.query("select count(*)::int as count from operations.outbox_events where event_id=$1", [neverUsedEventId])).rows)
      .toEqual([{ count: 0 }]);
    const conflict = await applicationOperations.idempotency.execute({
      operationScope: "portfolio.owner-export", actorScope,
      key: originalRequestKey.value,
      requestHash: "f".repeat(64), expiresAt,
    }, async () => ({ exportId: recoveredArtifactId as string }));
    expect(conflict).toEqual({ kind: "conflict" });
    const recovered = await executeRequest(recoveryRequestKey.value, "e".repeat(64), recoveredArtifactId, recoveredEventId);
    expect(recovered).toMatchObject({ kind: "executed", result: { exportId: recoveredArtifactId } });
    expect(new Set([failedExportArtifactId, recoveredArtifactId]).size).toBe(2);
    expect((await admin!.query("select event_id,correlation_id from operations.outbox_events where event_id = any($1::uuid[]) order by event_id",
      [[originalEventId, recoveredEventId]])).rows).toHaveLength(2);
    const receipts = (await admin!.query(`select status, result_envelope->>'exportId' as export_id
      from operations.idempotency_records
      where operation_scope='portfolio.owner-export' and actor_scope=$1`, [actorScope])).rows;
    expect(receipts).toHaveLength(2);
    expect(receipts.map(receipt => receipt.export_id).sort()).toEqual([failedExportArtifactId, recoveredArtifactId].sort());
    expect(receipts.every(receipt => receipt.status === "completed")).toBe(true);

    // The failed terminal source survives the recovery untouched.
    expect((await admin!.query("select status,attempt_count,payload,last_error_code from operations.jobs where job_id=$1", [failedExportJobId])).rows)
      .toEqual([failedJobRow]);
    expect((await admin!.query("select occurrences,safe_error_code from operations.incidents where incident_key=$1",
      [`job:${failedExportJobId}`])).rows).toEqual([{ occurrences: 1, safe_error_code: "EXPORT_ASSEMBLY_FAILED" }]);
  });

  it("terminalizes a mismatched payload version immediately with one incident instead of a retry", async () => {
    // The documented permanent path: a job whose payload version fails the
    // current handler policy is failure-coded on its first claim and
    // terminalized without consuming a retry window.
    const invalidJobId = id("Job");
    const policyPeriod = now.slice(0, 10);
    const operations = createPostgresOperationsPersistence(worker!.database);
    await operations.jobs.getPhase7ScheduleStatus({ portfolioId: invalidPayloadPortfolioId,
      fromPeriod: policyPeriod, throughPeriod: policyPeriod });
    for (const type of retentionTypes) {
      const jobId = type === "measurement.detail-retention.v1" ? invalidJobId : id("Job");
      const enqueued = await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, {
        jobId, availableAt: `${policyPeriod}T00:00:00.000Z`,
        payload: { type, version: 1, value: {} },
        semanticSchedule: { portfolioId: invalidPayloadPortfolioId, period: policyPeriod },
      }));
      if (!enqueued) throw new Error("PHASE8_ROLLBACK_RECOVERY_INVALID_JOB_ENQUEUE_FAILED");
      if (type !== "measurement.detail-retention.v1") {
        await admin!.query("update operations.jobs set status='completed',completed_at=clock_timestamp() where job_id=$1", [jobId]);
      }
    }
    const advanced = await operations.jobs.advancePhase7RetentionSchedule({ portfolioId: invalidPayloadPortfolioId,
      expectedNextPeriod: policyPeriod, scheduledThroughPeriod: policyPeriod });
    if (!advanced) throw new Error("PHASE8_ROLLBACK_RECOVERY_INVALID_JOB_CURSOR_FAILED");
    await admin!.query("update operations.jobs set payload_version=2 where job_id=$1", [invalidJobId]);
    const daily = createDailyAggregateWorkService({ portfolioId: invalidPayloadPortfolioId, transactions: worker!.transactions,
      repository: createPostgresDailyAggregateRepository() });
    const measurementRetention = createMeasurementRetentionWorkService({ portfolioId: invalidPayloadPortfolioId, transactions: worker!.transactions,
      repository: createPostgresMeasurementRetentionRepository() });
    const feedbackRetention = createFeedbackRetentionWorkService({ portfolioId: invalidPayloadPortfolioId, transactions: worker!.transactions,
      repository: createPostgresFeedbackRetentionRepository() });
    const futurePolicyClock = new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString();
    const service = createPhase7DueWorkService({ portfolioId: invalidPayloadPortfolioId, clock: { now: () => futurePolicyClock }, ids: createSystemIdGenerator(),
      operations,
      measurement: { ...daily, ...measurementRetention }, interaction: feedbackRetention,
      ownerExports: { runOwnerExportAssembly: async () => ({ ok: true, value: { claimed: 0, completed: 0, retried: 0, failed: 0, staleLeases: 0 } }) } });
    const result = await service.runDueWork({ workerId: "phase8-invalid-payload" });
    expect(result).toMatchObject({ ok: true, value: { scheduled: 4, claimed: 1, completed: 0, released: 0,
      failed: 1, staleLeases: 0, processedCount: 0, incomplete: true } });
    expect((await admin!.query("select status,attempt_count,payload,last_error_code from operations.jobs where job_id=$1",
      [invalidJobId])).rows)
      .toEqual([{ status: "dead", attempt_count: 1, payload: {}, last_error_code: "PHASE7_JOB_INVALID" }]);
    expect((await admin!.query("select occurrences,safe_error_code from operations.incidents where incident_key=$1",
      [`job:${invalidJobId}`])).rows).toEqual([{ occurrences: 1, safe_error_code: "PHASE7_JOB_INVALID" }]);
    // attempt_count stays at 1 and the row is terminal: no retry window was
    // consumed for the invalid payload.
    expect(result.ok && result.value.released).toBe(0);
  });
});
