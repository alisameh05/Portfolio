import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { parseSafeErrorCode, redriveDeadJob } from "../../src/modules/portability-operations/index.js";
import { createPostgresDailyAggregateRepository } from "../../src/modules/measurement/adapters/postgres-daily-aggregates.js";
import { createDailyAggregateWorkService } from "../../src/modules/measurement/application/daily-aggregates.js";
import { createPostgresMeasurementRetentionRepository } from "../../src/modules/measurement/adapters/postgres-retention.js";
import { createMeasurementRetentionWorkService } from "../../src/modules/measurement/application/retention.js";
import { createPostgresFeedbackRetentionRepository } from "../../src/modules/interaction-moderation/adapters/postgres-retention.js";
import { createFeedbackRetentionWorkService } from "../../src/modules/interaction-moderation/application/retention.js";
import { createPhase7DueWorkService } from "../../src/runtime/phase7-due-work.js";
import { parseStableId, type StableId } from "../../src/shared/domain/index.js";

const WORKER_URL = process.env["PHASE7_JOBS_WORKER_URL"];
const SECOND_WORKER_URL = process.env["PHASE7_JOBS_SECOND_WORKER_URL"] ?? WORKER_URL;
const ADMIN_URL = process.env["PHASE7_JOBS_ADMIN_URL"];
const portfolioId = "0196a1b2-7c3d-7e11-9f22-000000000001" as StableId<"Portfolio">;
const routeId = "0196a1b2-7c3d-7e11-9f22-000000000002" as StableId<"PublicRoute">;
const measurementSubject = "0196a1b2-7c3d-7e11-9f22-000000000003" as StableId<"MeasurementVisitor">;
const retentionTypes = ["measurement.detail-retention.v1", "measurement.aggregate-retention.v1",
  "measurement.withdrawal-cleanup.v1", "interaction.feedback-retention.v1"] as const;
let now = new Date().toISOString();
let admin: Client | undefined;
let worker: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
let workerTwo: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
let sequence = 100;

function id<T extends string>(kind: T): StableId<T> {
  const parsed = parseStableId(kind, `0196a1b2-7c3d-7e11-9f22-${(sequence++).toString(16).padStart(12, "0")}`);
  if (!parsed.ok) throw new Error("PHASE7_DUE_WORK_TEST_ID_INVALID");
  return parsed.value;
}

async function addEvent(input: { eventId: StableId<"PublicEvent">; acceptedAt: string; occurredAt: string;
  portfolioId?: StableId<"Portfolio">; subject?: StableId<"MeasurementVisitor"> }): Promise<void> {
  await admin!.query(`insert into measurement.public_events
    (event_id,portfolio_id,measurement_subject,action,occurred_at,accepted_at,effective_at,page_route_identity,project_id,locale,consent_version)
    values ($1,$2,$3,'page-viewed',$4,$5,$4,$6,null,'en','v1')`,
  [input.eventId, input.portfolioId ?? portfolioId, input.subject ?? measurementSubject, input.occurredAt, input.acceptedAt, routeId]);
}

function makeModuleServices(db: NonNullable<typeof worker>, scope: StableId<"Portfolio"> = portfolioId) {
  const measurementRetention = createMeasurementRetentionWorkService({ portfolioId: scope, transactions: db.transactions,
    repository: createPostgresMeasurementRetentionRepository() });
  const daily = createDailyAggregateWorkService({ portfolioId: scope, transactions: db.transactions,
    repository: createPostgresDailyAggregateRepository() });
  const feedbackRetention = createFeedbackRetentionWorkService({ portfolioId: scope, transactions: db.transactions,
    repository: createPostgresFeedbackRetentionRepository() });
  return { measurementRetention, daily, feedbackRetention };
}

function workCommand(jobId: StableId<"Job">, purpose: "measurement.aggregate" | "measurement.retention", at: string,
  scope: StableId<"Portfolio"> = portfolioId) {
  return { scope: { kind: "portfolio" as const, portfolioId: scope }, correlationId: "phase7-due-work-postgres",
    actor: { kind: "system" as const, jobId, purpose }, batchSize: 100 as const, now: at };
}

async function makeJobAvailableInDatabasePast(jobId: StableId<"Job">): Promise<void> {
  const updated = await admin!.query("update operations.jobs set available_at=clock_timestamp()-interval '1 millisecond' where job_id=$1 returning job_id",
    [jobId]);
  if (updated.rowCount !== 1) throw new Error("PHASE7_DUE_WORK_TEST_JOB_NOT_FOUND");
}

async function seedReadyAggregationScope(scope: StableId<"Portfolio">, policyPeriod: string): Promise<void> {
  const operations = createPostgresOperationsPersistence(worker!.database);
  await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope, fromPeriod: policyPeriod, throughPeriod: policyPeriod });
  for (const type of retentionTypes) {
    const enqueued = await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, {
      jobId: id("Job"), payload: { type, version: 1, value: {} }, availableAt: `${policyPeriod}T00:00:00.000Z`,
      semanticSchedule: { portfolioId: scope, period: policyPeriod },
    }));
    if (!enqueued) throw new Error("PHASE7_AGGREGATE_TEST_RETENTION_ENQUEUE_FAILED");
  }
  const advanced = await operations.jobs.advancePhase7RetentionSchedule({ portfolioId: scope,
    expectedNextPeriod: policyPeriod, scheduledThroughPeriod: policyPeriod });
  if (!advanced) throw new Error("PHASE7_AGGREGATE_TEST_RETENTION_CURSOR_FAILED");
  await admin!.query(`update operations.jobs set status='completed',completed_at=clock_timestamp()
    where semantic_scope_id=$1 and job_type=any($2::text[])`, [scope, retentionTypes]);
  const ready = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope,
    fromPeriod: policyPeriod, throughPeriod: policyPeriod });
  if (ready.phase !== "aggregate" || ready.retentionCompleteThrough !== policyPeriod) {
    throw new Error("PHASE7_AGGREGATE_TEST_RETENTION_NOT_READY");
  }
}

async function seedOneDueRetentionFailure(scope: StableId<"Portfolio">, throughPeriod: string): Promise<StableId<"Job">> {
  const operations = createPostgresOperationsPersistence(worker!.database);
  const firstPeriod = new Date(Date.parse(`${throughPeriod}T00:00:00.000Z`) - 14 * 86_400_000).toISOString().slice(0, 10);
  await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope, fromPeriod: firstPeriod, throughPeriod });
  const periods = Array.from({ length: 15 }, (_, index) =>
    new Date(Date.parse(`${firstPeriod}T00:00:00.000Z`) + index * 86_400_000).toISOString().slice(0, 10));
  let failingJobId: StableId<"Job"> | undefined;
  for (const period of periods) for (const type of retentionTypes) {
    const jobId = id("Job");
    if (period === throughPeriod && type === "measurement.detail-retention.v1") failingJobId = jobId;
    const enqueued = await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, {
      jobId, payload: { type, version: 1, value: {} }, availableAt: `${period}T00:00:00.000Z`,
      semanticSchedule: { portfolioId: scope, period },
    }));
    if (!enqueued) throw new Error("PHASE7_FAILURE_TEST_RETENTION_ENQUEUE_FAILED");
  }
  if (!failingJobId) throw new Error("PHASE7_FAILURE_TEST_TARGET_MISSING");
  const advanced = await operations.jobs.advancePhase7RetentionSchedule({ portfolioId: scope,
    expectedNextPeriod: periods[0]!, scheduledThroughPeriod: periods.at(-1)! });
  if (!advanced) throw new Error("PHASE7_FAILURE_TEST_RETENTION_CURSOR_FAILED");
  await admin!.query(`update operations.jobs set status='completed',completed_at=clock_timestamp()
    where semantic_scope_id=$1 and job_id<>$2`, [scope, failingJobId]);
  const status = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope, fromPeriod: firstPeriod, throughPeriod });
  if (status.phase !== "retention" || status.retentionCompleteThrough !== periods.at(-2)) {
    throw new Error("PHASE7_FAILURE_TEST_RETENTION_BARRIER_INVALID");
  }
  return failingJobId;
}

describe.runIf(Boolean(WORKER_URL && ADMIN_URL))("Phase 7 leased due-work PostgreSQL acceptance", () => {
  beforeAll(async () => {
    if (!WORKER_URL || !ADMIN_URL) throw new Error("PHASE7_JOBS_DATABASE_REQUIRED");
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    worker = createPostgresRuntimeDatabase(WORKER_URL);
    workerTwo = createPostgresRuntimeDatabase(SECOND_WORKER_URL ?? WORKER_URL);
    const databaseNow = await admin.query<{ now: Date }>("select clock_timestamp() as now");
    now = databaseNow.rows[0]!.now.toISOString();
  });

  afterAll(async () => {
    await worker?.resource.close();
    await workerTwo?.resource.close();
    await admin?.end();
  });

  it("catches up real retention work before admitting dependent daily aggregation", async () => {
    const expiredEvent = id("PublicEvent");
    const currentEvent = id("PublicEvent");
    const currentUtcDay = new Date(Date.parse(now) - 86_400_000).toISOString().slice(0, 10);
    await addEvent({ eventId: expiredEvent, occurredAt: "2026-10-01T00:00:00.000Z", acceptedAt: "2026-10-01T00:00:00.000Z" });
    await addEvent({ eventId: currentEvent, occurredAt: `${currentUtcDay}T09:00:00.000Z`, acceptedAt: `${currentUtcDay}T09:00:01.000Z` });
    const expiredFeedback = id("Feedback");
    await admin!.query(`insert into interaction.feedback
      (feedback_id,portfolio_id,project_id,locale,author_name,paragraph,moderation_state,aggregate_version,submitted_at)
      values ($1,$2,$3,'en','Retained name','Expired private paragraph','pending',1,'2026-07-16T00:00:00.000Z')`,
    [expiredFeedback, portfolioId, id("Project")]);
    const unrelatedJob = id("Job");
    await admin!.query(`insert into operations.jobs(job_id,job_type,payload_version,payload,available_at)
      values ($1,'media.asset-processing.v1',1,'{}'::jsonb,$2)`, [unrelatedJob, now]);

    let clockNow = now;
    const operations = createPostgresOperationsPersistence(worker!.database, { now: () => clockNow });
    const modules = makeModuleServices(worker!);
    const service = createPhase7DueWorkService({ portfolioId, clock: { now: () => clockNow }, ids: createSystemIdGenerator(),
      operations, measurement: { ...modules.daily, ...modules.measurementRetention }, interaction: modules.feedbackRetention,
      ownerExports: { runOwnerExportAssembly: async () => ({ ok: true, value: { claimed: 0, completed: 0, retried: 0, failed: 0,
        staleLeases: 0, cleanup: { scanned: 0, deleted: 0, pending: 0, incomplete: false } } }) } });
    const retentionPass = await service.runDueWork({ workerId: "phase7-local-acceptance" });
    if (!retentionPass.ok) throw new Error(`DUE_WORK_RETENTION_RESULT:${JSON.stringify(retentionPass.error)}`);
    expect(retentionPass).toMatchObject({ ok: true, value: { scheduled: 60, completed: 60, failed: 0,
      staleLeases: 0, incomplete: true, ownerExportAssembly: { completed: 0 } } });
    expect(retentionPass.ok && retentionPass.value.claimed).toBeGreaterThanOrEqual(60);
    expect((await admin!.query(`select count(*)::integer as count from operations.jobs where semantic_scope_id=$1
      and job_type='measurement.daily-aggregate.v1'`, [portfolioId])).rows).toEqual([{ count: 0 }]);

    const aggregationPass = await service.runDueWork({ workerId: "phase7-local-acceptance" });
    if (!aggregationPass.ok) throw new Error(`DUE_WORK_AGGREGATION_RESULT:${JSON.stringify(aggregationPass.error)}`);
    if (aggregationPass.value.completed !== 225 || aggregationPass.value.failed !== 0 || !aggregationPass.value.incomplete) {
      throw new Error(`DUE_WORK_AGGREGATION_RESULT:${JSON.stringify(aggregationPass.value)}`);
    }
    expect(aggregationPass).toMatchObject({ ok: true, value: { scheduled: 225, completed: 225, failed: 0,
      staleLeases: 0, incomplete: true, incompleteCoverage: true, lastCompletePolicyPeriod: null,
      ownerExportAssembly: { completed: 0 } } });
    expect(aggregationPass.ok && aggregationPass.value.claimed).toBeGreaterThanOrEqual(225);
    const retainedEvents = (await admin!.query("select event_id,accepted_at from measurement.public_events where event_id = any($1::uuid[])", [[expiredEvent, currentEvent]])).rows;
    if (retainedEvents.length !== 1 || retainedEvents[0]?.event_id !== currentEvent) {
      throw new Error(`DUE_WORK_EVENT_RETENTION:${JSON.stringify(retainedEvents)}`);
    }
    expect((await admin!.query("select feedback_id from interaction.feedback where feedback_id = $1", [expiredFeedback])).rows).toHaveLength(0);
    expect((await admin!.query(`select event_count,incomplete from measurement.daily_aggregates
      where portfolio_id=$1 and utc_day=$2 and metric_kind='action' and metric_key='page-viewed' and dimensions='{}'::jsonb`, [portfolioId, currentUtcDay])).rows)
      .toEqual([{ event_count: "1", incomplete: false }]);
    expect((await admin!.query(`select incomplete,retention_sealed from measurement.daily_aggregate_checkpoints
      where portfolio_id=$1 and utc_day='2026-10-01'`, [portfolioId])).rows)
      .toEqual([{ incomplete: true, retention_sealed: true }]);
    expect((await admin!.query("select status from operations.jobs where job_id=$1", [unrelatedJob])).rows)
      .toEqual([{ status: "available" }]);
    expect((await admin!.query(`select count(*)::integer as count from operations.jobs
      where semantic_scope_id=$1 and job_type=any($2::text[]) and status <> 'completed'`,
    [portfolioId, ["measurement.daily-aggregate.v1", "measurement.detail-retention.v1", "measurement.aggregate-retention.v1",
      "measurement.withdrawal-cleanup.v1", "interaction.feedback-retention.v1"]])).rows)
      .toEqual([{ count: 0 }]);
  }, 60_000);

  it("proves concurrent lease exclusion, expiry recovery, stale-token denial, and idempotent post-effect replay", async () => {
    // Keep both replay attempts on one policy snapshot while deriving the
    // retained day from database time so the fixture stays inside the window.
    const retainedUtcDay = new Date(Date.parse(now) - 86_400_000).toISOString().slice(0, 10);
    const aggregateAsOf = `${retainedUtcDay}T23:59:59.999Z`;
    // Replay the same policy snapshot; lease time must not age this event out
    // of the aggregate's 14-day accepted-event window.
    const scope = id("Portfolio");
    const jobId = id("Job");
    const eventId = id("PublicEvent");
    const subject = id("MeasurementVisitor");
    const retainedEventAt = `${retainedUtcDay}T10:00:00.000Z`;
    await addEvent({ eventId, subject, portfolioId: scope, occurredAt: retainedEventAt, acceptedAt: retainedEventAt });
    await seedReadyAggregationScope(scope, now.slice(0, 10));
    const firstOperations = createPostgresOperationsPersistence(worker!.database);
    const secondOperations = createPostgresOperationsPersistence(workerTwo!.database);
    await firstOperations.transactions.run(transaction => firstOperations.jobs.enqueue(transaction, {
      jobId, availableAt: now, semanticSchedule: { portfolioId: scope, period: `${now.slice(0, 10)}:${retainedUtcDay}` },
      payload: { type: "measurement.daily-aggregate.v1", version: 1, value: { utcDay: retainedUtcDay } },
    }));
    await makeJobAvailableInDatabasePast(jobId);
    const claimInput = { workerId: "worker-one", now, leaseDurationSeconds: 60, limit: 1,
      jobTypes: ["measurement.daily-aggregate.v1"], semanticScopeId: scope };
    const [firstClaims, competingClaims] = await Promise.all([
      firstOperations.jobs.claimDue(claimInput),
      secondOperations.jobs.claimDue({ ...claimInput, workerId: "worker-two" }),
    ]);
    expect(firstClaims.length + competingClaims.length).toBe(1);
    const firstLease = firstClaims[0] ?? competingClaims[0]!;

    const firstModules = makeModuleServices(worker!, scope);
    const firstEffect = await firstModules.daily.aggregateDay({ ...workCommand(jobId, "measurement.aggregate", aggregateAsOf, scope), utcDay: retainedUtcDay });
    expect(firstEffect).toMatchObject({ ok: true });
    const aggregateAfterFirstEffect = (await admin!.query(`select event_count,metric_key,dimensions from measurement.daily_aggregates
      where portfolio_id=$1 and utc_day=$2 and metric_kind='action' and dimensions='{}'::jsonb order by metric_key`, [scope, retainedUtcDay])).rows;
    // Simulate a worker crash after its PostgreSQL effect committed and before lease completion.
    await admin!.query("update operations.jobs set lease_expires_at=clock_timestamp() - interval '1 second' where job_id=$1", [jobId]);
    const afterExpiry = new Date().toISOString();
    const reclaimed = await secondOperations.jobs.claimDue({ ...claimInput, workerId: "worker-two", now: afterExpiry });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.leaseToken).not.toBe(firstLease.leaseToken);
    expect(await secondOperations.jobs.complete(jobId, `${reclaimed[0]!.leaseToken}-wrong`, afterExpiry)).toBe(false);
    expect(await secondOperations.jobs.fail(jobId, `${reclaimed[0]!.leaseToken}-wrong`, parseSafeErrorCode("PHASE7_WORK_FAILED"))).toBe(false);
    expect(await secondOperations.jobs.scheduleRetry(jobId, `${reclaimed[0]!.leaseToken}-wrong`, parseSafeErrorCode("PHASE7_WORK_FAILED"), 0)).toBe(false);
    expect(await secondOperations.jobs.release(jobId, `${reclaimed[0]!.leaseToken}-wrong`)).toBe(false);
    expect(await firstOperations.jobs.complete(jobId, firstLease.leaseToken, afterExpiry)).toBe(false);
    expect(await firstOperations.jobs.fail(jobId, firstLease.leaseToken, parseSafeErrorCode("PHASE7_WORK_FAILED"))).toBe(false);
    expect(await firstOperations.jobs.scheduleRetry(jobId, firstLease.leaseToken, parseSafeErrorCode("PHASE7_WORK_FAILED"), 0)).toBe(false);
    expect(await firstOperations.jobs.release(jobId, firstLease.leaseToken)).toBe(false);
    const replay = await makeModuleServices(workerTwo!, scope).daily.aggregateDay({ ...workCommand(jobId, "measurement.aggregate", aggregateAsOf, scope), utcDay: retainedUtcDay });
    expect(replay).toMatchObject({ ok: true });
    const aggregateRows = (await admin!.query(`select event_count,metric_key,dimensions from measurement.daily_aggregates
      where portfolio_id=$1 and utc_day=$2 and metric_kind='action' and dimensions='{}'::jsonb order by metric_key`, [scope, retainedUtcDay])).rows;
    expect(aggregateRows).toEqual(aggregateAfterFirstEffect);
    expect(aggregateRows.some((row: { metric_key: string }) => row.metric_key === "page-viewed")).toBe(true);
    expect(await secondOperations.jobs.complete(jobId, reclaimed[0]!.leaseToken, afterExpiry)).toBe(true);
  }, 30_000);

  it("recovers a claimed cleanup job that crashes before its first effect", async () => {
    const scope = id("Portfolio");
    const jobId = id("Job");
    const expiredEvent = id("PublicEvent");
    await addEvent({ eventId: expiredEvent, portfolioId: scope, occurredAt: "2026-10-01T00:00:00.000Z", acceptedAt: "2026-10-01T00:00:00.000Z" });
    const operations = createPostgresOperationsPersistence(worker!.database);
    await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, {
      jobId, availableAt: now, payload: { type: "measurement.detail-retention.v1", version: 1, value: {} },
      semanticSchedule: { portfolioId: scope, period: now.slice(0, 10) },
    }));
    await makeJobAvailableInDatabasePast(jobId);
    const claim = await operations.jobs.claimDue({ workerId: "worker-before-effect", now, leaseDurationSeconds: 60, limit: 1,
      jobTypes: ["measurement.detail-retention.v1"], semanticScopeId: scope });
    expect(claim).toHaveLength(1);
    // The first worker dies here, before calling the module-owned retention command.
    await admin!.query("update operations.jobs set lease_expires_at=clock_timestamp() - interval '1 second' where job_id=$1", [jobId]);
    const afterExpiry = new Date().toISOString();
    const recovered = await createPostgresOperationsPersistence(workerTwo!.database).jobs.claimDue({ workerId: "worker-recovered",
      now: afterExpiry, leaseDurationSeconds: 60, limit: 1, jobTypes: ["measurement.detail-retention.v1"], semanticScopeId: scope });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.jobId).toBe(jobId);
    const retention = makeModuleServices(workerTwo!, scope).measurementRetention;
    let outcome = await retention.expireDetail(workCommand(jobId, "measurement.retention", afterExpiry, scope));
    while (outcome.ok && outcome.value.nextCursor !== null) {
      outcome = await retention.expireDetail(workCommand(jobId, "measurement.retention", afterExpiry, scope));
    }
    if (!outcome.ok) throw new Error(`PRE_EFFECT_RECOVERY_RESULT:${JSON.stringify(outcome.error)}`);
    expect(outcome).toMatchObject({ ok: true, value: { incomplete: true, nextCursor: null } });
    expect(await createPostgresOperationsPersistence(workerTwo!.database).jobs.complete(jobId, recovered[0]!.leaseToken, afterExpiry)).toBe(true);
    const remaining = (await admin!.query("select event_id,accepted_at from measurement.public_events where event_id=$1", [expiredEvent])).rows;
    expect(remaining).toHaveLength(0);
  });

  it("rejects expired job transitions before reclaim and resumes the existing checkpoint on a new token", async () => {
    const scope = id("Portfolio");
    const jobId = id("Job");
    const policyNow = "2026-10-26T00:00:00.000Z";
    const claimNow = new Date().toISOString();
    const operations = createPostgresOperationsPersistence(worker!.database);
    await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope, fromPeriod: policyNow.slice(0, 10),
      throughPeriod: policyNow.slice(0, 10) });
    await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, {
      jobId, availableAt: claimNow, payload: { type: "measurement.detail-retention.v1", version: 1, value: {} },
      semanticSchedule: { portfolioId: scope, period: policyNow.slice(0, 10) },
    }));
    await makeJobAvailableInDatabasePast(jobId);
    const eventIds = Array.from({ length: 101 }, () => id("PublicEvent"));
    await admin!.query(`insert into measurement.public_events
      (event_id,portfolio_id,measurement_subject,action,occurred_at,accepted_at,effective_at,page_route_identity,
       project_id,locale,consent_version)
      select event_id, $2::uuid, $3::uuid, 'page-viewed', $4::timestamptz, $4::timestamptz, $4::timestamptz,
        $5::uuid, null, 'en', 'v1' from unnest($1::uuid[]) as events(event_id)`,
    [eventIds, scope, id("MeasurementVisitor"), "2026-10-01T00:00:00.000Z", routeId]);

    const firstOperations = createPostgresOperationsPersistence(worker!.database);
    const firstLease = (await firstOperations.jobs.claimDue({ workerId: "expired-transition-worker-a", now: claimNow,
      leaseDurationSeconds: 300, limit: 1, jobTypes: ["measurement.detail-retention.v1"], semanticScopeId: scope }))[0];
    expect(firstLease?.jobId).toBe(jobId);
    if (!firstLease) throw new Error("PHASE7_EXPIRED_JOB_LEASE_MISSING");
    const firstModules = makeModuleServices(worker!, scope);
    const firstCheckpoint = await firstModules.measurementRetention.expireDetail(workCommand(jobId,
      "measurement.retention", policyNow, scope));
    expect(firstCheckpoint).toMatchObject({ ok: true, value: { nextCursor: jobId } });
    const secondCheckpoint = await firstModules.measurementRetention.expireDetail(workCommand(jobId,
      "measurement.retention", policyNow, scope));
    expect(secondCheckpoint).toMatchObject({ ok: true, value: { nextCursor: jobId, processedCount: 100 } });
    const stateBefore = (await admin!.query(`select status,attempt_count,lease_owner,lease_token,lease_expires_at,
      completed_at,last_error_code from operations.jobs where job_id=$1`, [jobId])).rows;
    const checkpointBefore = (await admin!.query(`select stage,requested_at,incomplete,updated_at
      from measurement.retention_checkpoints where portfolio_id=$1 and job_id=$2 and work_kind='detail'`, [scope, jobId])).rows;
    expect(checkpointBefore).toHaveLength(1);
    expect(checkpointBefore[0]?.stage).toBe("events");
    await admin!.query("update operations.jobs set lease_expires_at=clock_timestamp()-interval '1 second' where job_id=$1", [jobId]);
    const expiredState = (await admin!.query(`select status,attempt_count,lease_owner,lease_token,lease_expires_at,
      completed_at,last_error_code from operations.jobs where job_id=$1`, [jobId])).rows;
    const expiredCheckpoint = (await admin!.query(`select stage,requested_at,incomplete,updated_at
      from measurement.retention_checkpoints where portfolio_id=$1 and job_id=$2 and work_kind='detail'`, [scope, jobId])).rows;
    expect(await firstOperations.jobs.release(jobId, firstLease.leaseToken, true)).toBe(false);
    expect(await firstOperations.jobs.complete(jobId, firstLease.leaseToken, new Date().toISOString())).toBe(false);
    expect(await firstOperations.jobs.fail(jobId, firstLease.leaseToken, parseSafeErrorCode("PHASE7_WORK_FAILED"))).toBe(false);
    expect(await firstOperations.jobs.scheduleRetry(jobId, firstLease.leaseToken, parseSafeErrorCode("PHASE7_WORK_FAILED"), 0)).toBe(false);
    expect((await admin!.query(`select status,attempt_count,lease_owner,lease_token,lease_expires_at,
      completed_at,last_error_code from operations.jobs where job_id=$1`, [jobId])).rows).toEqual(expiredState);
    expect((await admin!.query(`select stage,requested_at,incomplete,updated_at
      from measurement.retention_checkpoints where portfolio_id=$1 and job_id=$2 and work_kind='detail'`, [scope, jobId])).rows)
      .toEqual(expiredCheckpoint);
    expect(expiredState[0]?.attempt_count).toBe(stateBefore[0]?.attempt_count);
    expect((await admin!.query("select count(*)::integer as count from operations.incidents where incident_key=$1", [`job:${jobId}`])).rows)
      .toEqual([{ count: 0 }]);

    const secondOperations = createPostgresOperationsPersistence(workerTwo!.database);
    const reclaimed = await secondOperations.jobs.claimDue({ workerId: "expired-transition-worker-b", now: new Date().toISOString(),
      leaseDurationSeconds: 300, limit: 1, jobTypes: ["measurement.detail-retention.v1"], semanticScopeId: scope });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.jobId).toBe(jobId);
    expect(reclaimed[0]?.leaseToken).not.toBe(firstLease.leaseToken);
    expect(reclaimed[0]?.attemptCount).toBe(2);
    const resumed = await makeModuleServices(workerTwo!, scope).measurementRetention.expireDetail(workCommand(jobId,
      "measurement.retention", policyNow, scope));
    expect(resumed).toMatchObject({ ok: true, value: { nextCursor: jobId, processedCount: 1 } });
    expect((await admin!.query("select count(*)::integer as count from measurement.public_events where portfolio_id=$1", [scope])).rows)
      .toEqual([{ count: 0 }]);
    expect((await admin!.query(`select stage,requested_at from measurement.retention_checkpoints
      where portfolio_id=$1 and job_id=$2 and work_kind='detail'`, [scope, jobId])).rows)
      .toEqual([{ stage: "rebuilds", requested_at: new Date(policyNow) }]);
    expect(await secondOperations.jobs.release(jobId, reclaimed[0]!.leaseToken, true)).toBe(true);
    expect((await admin!.query("select status,attempt_count from operations.jobs where job_id=$1", [jobId])).rows)
      .toEqual([{ status: "available", attempt_count: 0 }]);
  });

  it("rejects Visitor, Owner, wrong-purpose System, and foreign-Portfolio commands at both module boundaries", async () => {
    const modules = makeModuleServices(worker!);
    const jobId = id("Job");
    const invalidCommands = [
      { ...workCommand(jobId, "measurement.aggregate", now), actor: { kind: "visitor", consent: "denied" } },
      { ...workCommand(jobId, "measurement.aggregate", now), actor: { kind: "owner", ownerId: id("Owner"), sessionId: "test-session" } },
      { ...workCommand(jobId, "measurement.aggregate", now), scope: { kind: "portfolio", portfolioId: id("Portfolio") } },
    ];

    for (const command of invalidCommands) {
      const measurementResult = await modules.daily.aggregateDay({ ...command, utcDay: "2026-10-14" } as never);
      expect(measurementResult.ok).toBe(false);
      const feedbackResult = await modules.feedbackRetention.expireFeedback(command as never);
      expect(feedbackResult.ok ? "ok" : feedbackResult.error.kind).toBe("forbidden");
    }
    const wrongMeasurementPurpose = await modules.daily.aggregateDay({ ...workCommand(jobId, "measurement.retention", now), utcDay: "2026-10-14" } as never);
    expect(wrongMeasurementPurpose.ok).toBe(false);
    const wrongFeedbackPurpose = await modules.feedbackRetention.expireFeedback(workCommand(jobId, "measurement.aggregate", now) as never);
    expect(wrongFeedbackPurpose.ok ? "ok" : wrongFeedbackPurpose.error.kind).toBe("forbidden");
  });

  it("rolls back a failed retention batch and persists a delayed safe retry", async () => {
    const scope = id("Portfolio");
    const retryRunNow = new Date(Date.parse(now) + 86_400_000).toISOString();
    const failedJobId = await seedOneDueRetentionFailure(scope, retryRunNow.slice(0, 10));
    const expiredEvent = id("PublicEvent");
    await addEvent({ eventId: expiredEvent, portfolioId: scope, subject: id("MeasurementVisitor"),
      occurredAt: "2026-10-01T00:00:00.000Z", acceptedAt: "2026-10-01T00:00:00.000Z" });
    await admin!.query(`create function public.fail_due_work_event_delete() returns trigger language plpgsql as $$
      begin raise exception 'PRIVATE_SUBJECT_TOKEN_SHOULD_NOT_PERSIST'; end $$`);
    await admin!.query(`create trigger fail_due_work_event_delete before delete on measurement.public_events
      for each row execute function public.fail_due_work_event_delete()`);

    const operations = createPostgresOperationsPersistence(worker!.database, { now: () => retryRunNow });
    const modules = makeModuleServices(worker!, scope);
    // This fixture exercises handler retry behavior; make its selected job
    // database-due instead of relying on the future worker clock.
    await admin!.query("update operations.jobs set available_at=clock_timestamp()-interval '1 millisecond' where job_id=$1", [failedJobId]);
    const service = createPhase7DueWorkService({ portfolioId: scope, clock: { now: () => retryRunNow }, ids: createSystemIdGenerator(),
      operations, measurement: { ...modules.daily, ...modules.measurementRetention }, interaction: modules.feedbackRetention,
      ownerExports: { runOwnerExportAssembly: async () => ({ ok: true, value: { claimed: 0, completed: 0, retried: 0, failed: 0,
        staleLeases: 0, cleanup: { scanned: 0, deleted: 0, pending: 0, incomplete: false } } }) } });
    const failedRun = await service.runDueWork({ workerId: "phase7-rollback-test" });
    if (!failedRun.ok || failedRun.value.failed !== 0 || failedRun.value.claimed !== 1 || failedRun.value.released !== 1 || !failedRun.value.incomplete) {
      throw new Error(`DUE_WORK_SAFE_FAILURE_RESULT:${JSON.stringify(failedRun)}`);
    }

    const failedJob = (await admin!.query(`select job_id,job_type,payload,status,attempt_count,last_error_code
      from operations.jobs where semantic_scope_id=$1 and job_type='measurement.detail-retention.v1'
        and status='available' and last_error_code='PHASE7_WORK_FAILED' order by job_id limit 1`, [scope])).rows[0];
    if (failedJob?.status !== "available" || failedJob.attempt_count !== 1 || failedJob.last_error_code !== "PHASE7_WORK_FAILED" ||
        JSON.stringify(failedJob.payload) !== "{}") {
      throw new Error(`DUE_WORK_PERSISTED_FAILURE:${JSON.stringify(failedJob)}`);
    }
    expect((await admin!.query("select available_at > clock_timestamp() as delayed from operations.jobs where job_id=$1", [failedJob.job_id])).rows)
      .toEqual([{ delayed: true }]);
    expect(failedJob.job_id).toBe(failedJobId);
    expect(await operations.jobs.claimDue({ workerId: "phase7-no-early-retry", now: new Date().toISOString(),
      leaseDurationSeconds: 30, limit: 1, jobTypes: ["measurement.detail-retention.v1"], semanticScopeId: scope })).toHaveLength(0);
    expect(JSON.stringify(failedJob)).not.toContain("PRIVATE_SUBJECT_TOKEN_SHOULD_NOT_PERSIST");
    expect((await admin!.query("select 1 from measurement.public_events where event_id=$1 and portfolio_id=$2", [expiredEvent, scope])).rows).toHaveLength(1);
    expect((await admin!.query("select stage from measurement.retention_checkpoints where job_id=$1 and work_kind='detail'", [failedJob.job_id])).rows)
      .toEqual([]);

    await admin!.query("drop trigger fail_due_work_event_delete on measurement.public_events; drop function public.fail_due_work_event_delete()");
    await admin!.query(`update operations.jobs set status='completed',completed_at=clock_timestamp(),lease_owner=null,
      lease_token=null,lease_expires_at=null where semantic_scope_id=$1 and job_id<>$2 and status<>'completed'`, [scope, failedJob.job_id]);
    await admin!.query("update operations.jobs set available_at=clock_timestamp() - interval '1 second' where job_id=$1", [failedJob.job_id]);
    const retried = await operations.jobs.claimDue({ workerId: "phase7-rollback-retry", now: new Date().toISOString(),
      leaseDurationSeconds: 300, limit: 1, jobTypes: ["measurement.detail-retention.v1"], semanticScopeId: scope });
    expect(retried).toHaveLength(1);
    expect(retried[0]?.jobId).toBe(failedJobId);
    expect(retried[0]?.jobId).toBe(failedJob.job_id);
    expect(retried[0]?.attemptCount).toBeGreaterThan(failedJob.attempt_count);
    expect(await operations.jobs.scheduleRetry(failedJob.job_id, retried[0]!.leaseToken,
      parseSafeErrorCode("PHASE7_WORK_FAILED"), 30_000)).toBe(true);
    const retriedJob = (await admin!.query("select status,attempt_count,last_error_code from operations.jobs where job_id=$1", [failedJob.job_id])).rows[0];
    if (!retriedJob) throw new Error("DUE_WORK_RETRY_STATE_MISSING");
    expect(retriedJob.status).toBe("available");
    expect(retriedJob.attempt_count).toBeGreaterThan(failedJob.attempt_count);
    expect(retriedJob.last_error_code).toBe("PHASE7_WORK_FAILED");
    expect((await admin!.query("select 1 from measurement.public_events where event_id=$1", [expiredEvent])).rows).toHaveLength(1);
  }, 30_000);

  it("terminalizes the fifth failed claim and a crashed fifth claim with one durable incident", async () => {
    const operations = createPostgresOperationsPersistence(worker!.database);
    const failedJobId = id("Job");
    await admin!.query(`insert into operations.jobs(job_id,job_type,payload_version,payload,available_at,attempt_count)
      values ($1,'cache.refresh',1,'{}'::jsonb,clock_timestamp() - interval '1 second',4)`, [failedJobId]);
    const fifthClaim = await operations.jobs.claimDue({ workerId: "phase8-final-attempt", now: new Date().toISOString(),
      leaseDurationSeconds: 30, limit: 1, jobTypes: ["cache.refresh"] });
    expect(fifthClaim).toHaveLength(1);
    expect(fifthClaim[0]?.attemptCount).toBe(5);
    await expect(operations.jobs.scheduleRetry(failedJobId, fifthClaim[0]!.leaseToken,
      parseSafeErrorCode("HANDLER_TIMEOUT"), 600_000)).resolves.toBe(true);
    expect(await operations.jobs.claimDue({ workerId: "phase8-no-sixth-attempt", now: new Date().toISOString(),
      leaseDurationSeconds: 30, limit: 1, jobTypes: ["cache.refresh"] })).toHaveLength(0);
    expect((await admin!.query("select status,attempt_count,last_error_code from operations.jobs where job_id=$1", [failedJobId])).rows)
      .toEqual([{ status: "dead", attempt_count: 5, last_error_code: "HANDLER_TIMEOUT" }]);
    expect((await admin!.query("select category,safe_error_code,occurrences from operations.incidents where incident_key=$1", [`job:${failedJobId}`])).rows)
      .toEqual([{ category: "job", safe_error_code: "HANDLER_TIMEOUT", occurrences: 1 }]);

    const crashedJobId = id("Job");
    await admin!.query(`insert into operations.jobs(job_id,job_type,payload_version,payload,available_at,attempt_count,
      status,lease_owner,lease_token,lease_expires_at)
      values ($1,'cache.refresh',1,'{}'::jsonb,clock_timestamp() - interval '1 second',5,
        'leased','crashed-worker','expired-final-token',clock_timestamp() - interval '1 second')`, [crashedJobId]);
    expect(await operations.jobs.claimDue({ workerId: "phase8-crash-recovery", now: new Date().toISOString(),
      leaseDurationSeconds: 30, limit: 1, jobTypes: ["cache.refresh"] })).toHaveLength(0);
    expect((await admin!.query("select status,attempt_count,lease_token,last_error_code from operations.jobs where job_id=$1", [crashedJobId])).rows)
      .toEqual([{ status: "dead", attempt_count: 5, lease_token: null, last_error_code: "JOB_ATTEMPTS_EXHAUSTED" }]);
    expect((await admin!.query("select category,safe_error_code,occurrences from operations.incidents where incident_key=$1", [`job:${crashedJobId}`])).rows)
      .toEqual([{ category: "job", safe_error_code: "JOB_ATTEMPTS_EXHAUSTED", occurrences: 1 }]);
  });

  it("rejects expired outbox transitions and terminalizes the fifth delivery with one incident", async () => {
    const operations = createPostgresOperationsPersistence(worker!.database);
    const eventId = id("DomainEvent");
    await admin!.query(`insert into operations.outbox_events(event_id,event_type,schema_version,aggregate_id,aggregate_version,
      payload,correlation_id,occurred_at,available_at)
      values ($1,'phase8.outbox-retry-probe.v1',1,$2,1,'{}'::jsonb,'phase8-outbox-fencing',clock_timestamp(),clock_timestamp() - interval '1 second')`,
    [eventId, portfolioId]);
    const firstClaim = await operations.outbox.claimDue({ workerId: "outbox-expired-attempt-one",
      now: new Date(Date.now() + 1_000).toISOString(), leaseDurationSeconds: 30, limit: 1 });
    expect(firstClaim).toHaveLength(1);
    const expiredToken = firstClaim[0]!.leaseToken;
    expect(firstClaim[0]!.attemptCount).toBe(1);
    await admin!.query("update operations.outbox_events set lease_expires_at=clock_timestamp()-interval '1 second' where event_id=$1", [eventId]);
    const beforeExpiredTransitions = (await admin!.query(`select completed_at,dead_at,attempt_count,available_at,
      lease_owner,lease_token,lease_expires_at,last_error_code from operations.outbox_events where event_id=$1`, [eventId])).rows;
    expect(await operations.outbox.release(eventId, expiredToken)).toBe(false);
    expect(await operations.outbox.complete(eventId, expiredToken, new Date().toISOString())).toBe(false);
    expect(await operations.outbox.fail(eventId, expiredToken, parseSafeErrorCode("HANDLER_TIMEOUT"))).toBe(false);
    expect(await operations.outbox.scheduleRetry(eventId, expiredToken, parseSafeErrorCode("HANDLER_TIMEOUT"), 0)).toBe(false);
    expect((await admin!.query(`select completed_at,dead_at,attempt_count,available_at,
      lease_owner,lease_token,lease_expires_at,last_error_code from operations.outbox_events where event_id=$1`, [eventId])).rows)
      .toEqual(beforeExpiredTransitions);
    expect(beforeExpiredTransitions[0]?.attempt_count).toBe(1);
    expect((await admin!.query("select count(*)::integer as count from operations.incidents where incident_key=$1", [`outbox:${eventId}`])).rows)
      .toEqual([{ count: 0 }]);

    let previousToken: string | undefined = expiredToken;
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      const claimed = await operations.outbox.claimDue({ workerId: `outbox-attempt-${attempt}`,
        now: new Date(Date.now() + 1_000).toISOString(), leaseDurationSeconds: 30, limit: 1 });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]!.attemptCount).toBe(attempt);
      const token = claimed[0]!.leaseToken;
      expect(await operations.outbox.scheduleRetry(eventId, `${token}-wrong`, parseSafeErrorCode("HANDLER_TIMEOUT"), 0)).toBe(false);
      if (previousToken) {
        expect(await operations.outbox.scheduleRetry(eventId, previousToken, parseSafeErrorCode("HANDLER_TIMEOUT"), 0)).toBe(false);
        expect(await operations.outbox.complete(eventId, previousToken, new Date().toISOString())).toBe(false);
      }
      expect(await operations.outbox.scheduleRetry(eventId, token, parseSafeErrorCode("HANDLER_TIMEOUT"), 0)).toBe(true);
      previousToken = token;
    }
    expect(await operations.outbox.claimDue({ workerId: "outbox-no-sixth-attempt", now: new Date(Date.now() + 1_000).toISOString(),
      leaseDurationSeconds: 30, limit: 1 })).toHaveLength(0);
    expect((await admin!.query("select attempt_count,dead_at is not null as dead,last_error_code from operations.outbox_events where event_id=$1", [eventId])).rows)
      .toEqual([{ attempt_count: 5, dead: true, last_error_code: "HANDLER_TIMEOUT" }]);
    expect((await admin!.query("select occurrences,safe_error_code from operations.incidents where incident_key=$1", [`outbox:${eventId}`])).rows)
      .toEqual([{ occurrences: 1, safe_error_code: "HANDLER_TIMEOUT" }]);
  });

  it("uses PostgreSQL time for job not-before and preserves retry attempts until available", async () => {
    const operations = createPostgresOperationsPersistence(worker!.database);
    const jobId = id("Job");
    const jobType = "phase8.database-clock-job.v1";
    await admin!.query(`insert into operations.jobs(job_id,job_type,payload_version,payload,available_at)
      values ($1,$2,1,$3::jsonb,clock_timestamp()-interval '1 second')`,
    [jobId, jobType, JSON.stringify({ type: jobType, version: 1, value: {} })]);

    const initial = await operations.jobs.claimDue({ workerId: "db-clock-job-first", now: new Date().toISOString(),
      leaseDurationSeconds: 60, limit: 1, jobTypes: [jobType] });
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ jobId, attemptCount: 1 });
    expect(await operations.jobs.scheduleRetry(jobId, initial[0]!.leaseToken,
      parseSafeErrorCode("HANDLER_TIMEOUT"), 900_000)).toBe(true);

    const futureCallerTime = "2099-12-31T23:59:59.999Z";
    const beforeEarlyClaim = (await admin!.query(`select status,attempt_count,lease_owner,lease_token,lease_expires_at,
      available_at>clock_timestamp() as database_not_before,available_at<$2::timestamptz as caller_time_is_later
      from operations.jobs where job_id=$1`, [jobId, futureCallerTime])).rows;
    expect(beforeEarlyClaim).toEqual([{ status: "available", attempt_count: 1, lease_owner: null, lease_token: null,
      lease_expires_at: null, database_not_before: true, caller_time_is_later: true }]);

    expect(await operations.jobs.claimDue({ workerId: "db-clock-job-too-early", now: futureCallerTime,
      leaseDurationSeconds: 60, limit: 1, jobTypes: [jobType] })).toHaveLength(0);
    expect((await admin!.query(`select status,attempt_count,lease_owner,lease_token,lease_expires_at,
      available_at>clock_timestamp() as database_not_before,available_at<$2::timestamptz as caller_time_is_later
      from operations.jobs where job_id=$1`, [jobId, futureCallerTime])).rows).toEqual(beforeEarlyClaim);

    await admin!.query("update operations.jobs set available_at=clock_timestamp()-interval '1 millisecond' where job_id=$1", [jobId]);
    const afterDatabaseNotBefore = await operations.jobs.claimDue({ workerId: "db-clock-job-after-delay", now: futureCallerTime,
      leaseDurationSeconds: 60, limit: 1, jobTypes: [jobType] });
    expect(afterDatabaseNotBefore).toHaveLength(1);
    expect(afterDatabaseNotBefore[0]).toMatchObject({ jobId, attemptCount: 2 });
    expect(await operations.jobs.complete(jobId, afterDatabaseNotBefore[0]!.leaseToken, new Date().toISOString())).toBe(true);
  });

  it("uses PostgreSQL time for outbox not-before and preserves retry attempts until available", async () => {
    const operations = createPostgresOperationsPersistence(worker!.database);
    const eventId = id("DomainEvent");
    await admin!.query(`insert into operations.outbox_events(event_id,event_type,schema_version,aggregate_id,aggregate_version,
      payload,correlation_id,occurred_at,available_at)
      values ($1,'phase8.database-clock-outbox.v1',1,$2,1,'{}'::jsonb,'db-clock-outbox',clock_timestamp(),clock_timestamp()-interval '1 second')`,
    [eventId, portfolioId]);

    const initial = await operations.outbox.claimDue({ workerId: "db-clock-outbox-first", now: new Date().toISOString(),
      leaseDurationSeconds: 60, limit: 1 });
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ eventId, attemptCount: 1 });
    expect(await operations.outbox.scheduleRetry(eventId, initial[0]!.leaseToken,
      parseSafeErrorCode("HANDLER_TIMEOUT"), 900_000)).toBe(true);

    const futureCallerTime = "2099-12-31T23:59:59.999Z";
    const beforeEarlyClaim = (await admin!.query(`select attempt_count,lease_owner,lease_token,lease_expires_at,completed_at,dead_at,
      available_at>clock_timestamp() as database_not_before,available_at<$2::timestamptz as caller_time_is_later
      from operations.outbox_events where event_id=$1`, [eventId, futureCallerTime])).rows;
    expect(beforeEarlyClaim).toEqual([{ attempt_count: 1, lease_owner: null, lease_token: null, lease_expires_at: null,
      completed_at: null, dead_at: null, database_not_before: true, caller_time_is_later: true }]);

    expect(await operations.outbox.claimDue({ workerId: "db-clock-outbox-too-early", now: futureCallerTime,
      leaseDurationSeconds: 60, limit: 1 })).toHaveLength(0);
    expect((await admin!.query(`select attempt_count,lease_owner,lease_token,lease_expires_at,completed_at,dead_at,
      available_at>clock_timestamp() as database_not_before,available_at<$2::timestamptz as caller_time_is_later
      from operations.outbox_events where event_id=$1`, [eventId, futureCallerTime])).rows).toEqual(beforeEarlyClaim);

    await admin!.query("update operations.outbox_events set available_at=clock_timestamp()-interval '1 millisecond' where event_id=$1", [eventId]);
    const afterDatabaseNotBefore = await operations.outbox.claimDue({ workerId: "db-clock-outbox-after-delay", now: futureCallerTime,
      leaseDurationSeconds: 60, limit: 1 });
    expect(afterDatabaseNotBefore).toHaveLength(1);
    expect(afterDatabaseNotBefore[0]).toMatchObject({ eventId, attemptCount: 2 });
    expect(await operations.outbox.complete(eventId, afterDatabaseNotBefore[0]!.leaseToken, new Date().toISOString())).toBe(true);
  });

  it("re-drives an authorized current-policy dead job once and retains its audit and terminal source", async () => {
    const operations = createPostgresOperationsPersistence(worker!.database);
    const originalJobId = id("Job");
    await admin!.query(`insert into operations.jobs(job_id,job_type,payload_version,payload,available_at,attempt_count,status,last_error_code)
      values ($1,'measurement.detail-retention.v1',1,'{}'::jsonb,clock_timestamp(),5,'dead','HANDLER_TIMEOUT')`, [originalJobId]);
    const replacementJobId = id("Job");
    const denied = await redriveDeadJob({ jobs: operations.jobs, authorizeOperator: async () => null,
      generateJobId: () => id("Job") }, {
      actor: { kind: "system", jobId: id("Job"), purpose: "operations.redrive" }, originalJobId,
    });
    expect(denied).toMatchObject({ ok: false, error: { kind: "forbidden", code: "JOB_REDRIVE_UNAUTHORIZED" } });
    const result = await redriveDeadJob({
      jobs: operations.jobs,
      authorizeOperator: async () => "a".repeat(64),
      generateJobId: () => replacementJobId,
    }, {
      actor: { kind: "system", jobId: id("Job"), purpose: "operations.redrive" },
      originalJobId,
    });
    expect(result).toEqual({ ok: true, value: replacementJobId });
    expect((await admin!.query("select status,attempt_count from operations.jobs where job_id=$1", [originalJobId])).rows)
      .toEqual([{ status: "dead", attempt_count: 5 }]);
    expect((await admin!.query("select status,attempt_count,job_type,payload from operations.jobs where job_id=$1", [replacementJobId])).rows)
      .toEqual([{ status: "available", attempt_count: 0, job_type: "measurement.detail-retention.v1", payload: {} }]);
    expect((await admin!.query("select original_job_id,replacement_job_id,operator_scope_hash,policy_version,payload_sha256 from operations.job_redrive_audit where original_job_id=$1", [originalJobId])).rows)
      .toMatchObject([{ original_job_id: originalJobId, replacement_job_id: replacementJobId,
        operator_scope_hash: "a".repeat(64), policy_version: "phase7-handlers-v1", payload_sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    const duplicate = await operations.jobs.redriveDead({ originalJobId, replacementJobId: id("Job"),
      operatorScopeHash: "a".repeat(64), policyVersion: "phase7-handlers-v1", payloadSha256: "0".repeat(64) });
    expect(duplicate).toBeNull();

    const obsoleteJobId = id("Job");
    await admin!.query(`insert into operations.jobs(job_id,job_type,payload_version,payload,available_at,attempt_count,status,last_error_code)
      values ($1,'measurement.detail-retention.v2',2,'{}'::jsonb,clock_timestamp(),5,'dead','HANDLER_TIMEOUT')`, [obsoleteJobId]);
    const obsolete = await redriveDeadJob({ jobs: operations.jobs, authorizeOperator: async () => "a".repeat(64),
      generateJobId: () => id("Job") }, {
      actor: { kind: "system", jobId: id("Job"), purpose: "operations.redrive" }, originalJobId: obsoleteJobId,
    });
    expect(obsolete).toMatchObject({ ok: false, error: { kind: "validation", code: "JOB_REDRIVE_POLICY_OBSOLETE" } });
    expect((await admin!.query("select status from operations.jobs where job_id=$1", [obsoleteJobId])).rows)
      .toEqual([{ status: "dead" }]);

    const unsafeJobId = id("Job");
    await admin!.query(`insert into operations.jobs(job_id,job_type,payload_version,payload,available_at,attempt_count,status,last_error_code)
      values ($1,'measurement.detail-retention.v1',1,'{"email":"private@example.invalid"}'::jsonb,clock_timestamp(),5,'dead','HANDLER_TIMEOUT')`, [unsafeJobId]);
    const unsafe = await redriveDeadJob({ jobs: operations.jobs, authorizeOperator: async () => "a".repeat(64),
      generateJobId: () => id("Job") }, {
      actor: { kind: "system", jobId: id("Job"), purpose: "operations.redrive" }, originalJobId: unsafeJobId,
    });
    expect(unsafe).toMatchObject({ ok: false, error: { kind: "validation", code: "JOB_REDRIVE_PAYLOAD_UNSAFE" } });
    expect((await admin!.query("select status from operations.jobs where job_id=$1", [unsafeJobId])).rows)
      .toEqual([{ status: "dead" }]);

    const failedExportJobId = id("Job");
    const failedExportId = id("OwnerExport");
    await admin!.query(`insert into operations.jobs(job_id,job_type,payload_version,payload,available_at,attempt_count,status,last_error_code)
      values ($1,'portability.export_assembly.v1',1,$2::jsonb,clock_timestamp(),5,'dead','EXPORT_ASSEMBLY_FAILED')`,
    [failedExportJobId, JSON.stringify({ exportId: failedExportId })]);
    const exportRedrive = await redriveDeadJob({ jobs: operations.jobs, authorizeOperator: async () => "a".repeat(64),
      generateJobId: () => id("Job") }, {
      actor: { kind: "system", jobId: id("Job"), purpose: "operations.redrive" }, originalJobId: failedExportJobId,
    });
    expect(exportRedrive).toMatchObject({ ok: false, error: { kind: "validation", code: "JOB_REDRIVE_POLICY_OBSOLETE" } });
    expect((await admin!.query("select status,attempt_count,payload from operations.jobs where job_id=$1", [failedExportJobId])).rows)
      .toEqual([{ status: "dead", attempt_count: 5, payload: { exportId: failedExportId } }]);
    expect((await admin!.query("select count(*)::integer as count from operations.job_redrive_audit where original_job_id=$1", [failedExportJobId])).rows)
      .toEqual([{ count: 0 }]);
  });
});
