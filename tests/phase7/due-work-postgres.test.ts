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
const now = new Date().toISOString();
let admin: Client | undefined;
let worker: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
let workerTwo: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
let sequence = 100;

function id<T extends string>(kind: T): StableId<T> {
  const parsed = parseStableId(kind, `0196a1b2-7c3d-7e11-9f22-${(sequence++).toString(16).padStart(12, "0")}`);
  if (!parsed.ok) throw new Error("PHASE7_DUE_WORK_TEST_ID_INVALID");
  return parsed.value;
}

async function addEvent(input: { eventId: StableId<"PublicEvent">; acceptedAt: string; occurredAt: string }): Promise<void> {
  await admin!.query(`insert into measurement.public_events
    (event_id,portfolio_id,measurement_subject,action,occurred_at,accepted_at,effective_at,page_route_identity,project_id,locale,consent_version)
    values ($1,$2,$3,'page-viewed',$4,$5,$4,$6,null,'en','v1')`,
  [input.eventId, portfolioId, measurementSubject, input.occurredAt, input.acceptedAt, routeId]);
}

function makeModuleServices(db: NonNullable<typeof worker>) {
  const measurementRetention = createMeasurementRetentionWorkService({ portfolioId, transactions: db.transactions,
    repository: createPostgresMeasurementRetentionRepository() });
  const daily = createDailyAggregateWorkService({ portfolioId, transactions: db.transactions,
    repository: createPostgresDailyAggregateRepository() });
  const feedbackRetention = createFeedbackRetentionWorkService({ portfolioId, transactions: db.transactions,
    repository: createPostgresFeedbackRetentionRepository() });
  return { measurementRetention, daily, feedbackRetention };
}

function workCommand(jobId: StableId<"Job">, purpose: "measurement.aggregate" | "measurement.retention", at: string) {
  return { scope: { kind: "portfolio" as const, portfolioId }, correlationId: "phase7-due-work-postgres",
    actor: { kind: "system" as const, jobId, purpose }, batchSize: 100 as const, now: at };
}

describe.runIf(Boolean(WORKER_URL && ADMIN_URL))("Phase 7 leased due-work PostgreSQL acceptance", () => {
  beforeAll(async () => {
    if (!WORKER_URL || !ADMIN_URL) throw new Error("PHASE7_JOBS_DATABASE_REQUIRED");
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    worker = createPostgresRuntimeDatabase(WORKER_URL);
    workerTwo = createPostgresRuntimeDatabase(SECOND_WORKER_URL ?? WORKER_URL);
  });

  afterAll(async () => {
    await worker?.resource.close();
    await workerTwo?.resource.close();
    await admin?.end();
  });

  it("enqueues and executes real retention and daily aggregation jobs with retention-first incompleteness", async () => {
    const expiredEvent = id("PublicEvent");
    const currentEvent = id("PublicEvent");
    await addEvent({ eventId: expiredEvent, occurredAt: "2026-10-01T00:00:00.000Z", acceptedAt: "2026-10-01T00:00:00.000Z" });
    await addEvent({ eventId: currentEvent, occurredAt: "2026-10-14T09:00:00.000Z", acceptedAt: "2026-10-14T09:00:01.000Z" });
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
      operations, measurement: { ...modules.daily, ...modules.measurementRetention }, interaction: modules.feedbackRetention });
    const result = await service.runDueWork({ workerId: "phase7-local-acceptance" });
    if (!result.ok) throw new Error(`DUE_WORK_RESULT:${JSON.stringify(result.error)}`);
    if (result.value.completed !== 19 || result.value.failed !== 0 || !result.value.incomplete) {
      throw new Error(`DUE_WORK_RESULT:${JSON.stringify(result.value)}`);
    }

    expect(result).toMatchObject({ ok: true, value: { scheduled: 19, completed: 19, failed: 0, staleLeases: 0, incomplete: true } });
    expect(result.ok && result.value.claimed).toBeGreaterThanOrEqual(19);
    const retainedEvents = (await admin!.query("select event_id,accepted_at from measurement.public_events where event_id = any($1::uuid[])", [[expiredEvent, currentEvent]])).rows;
    if (retainedEvents.length !== 1 || retainedEvents[0]?.event_id !== currentEvent) {
      throw new Error(`DUE_WORK_EVENT_RETENTION:${JSON.stringify(retainedEvents)}`);
    }
    expect((await admin!.query("select feedback_id from interaction.feedback where feedback_id = $1", [expiredFeedback])).rows).toHaveLength(0);
    expect((await admin!.query(`select event_count,incomplete from measurement.daily_aggregates
      where portfolio_id=$1 and utc_day='2026-10-14' and metric_kind='action' and metric_key='page-viewed' and dimensions='{}'::jsonb`, [portfolioId])).rows)
      .toEqual([{ event_count: "1", incomplete: false }]);
    expect((await admin!.query(`select incomplete,retention_sealed from measurement.daily_aggregate_checkpoints
      where portfolio_id=$1 and utc_day='2026-10-01'`, [portfolioId])).rows)
      .toEqual([{ incomplete: true, retention_sealed: true }]);
    expect((await admin!.query("select status from operations.jobs where job_id=$1", [unrelatedJob])).rows)
      .toEqual([{ status: "available" }]);
    expect((await admin!.query("select count(*)::integer as count from operations.jobs where status <> 'completed' and job_id <> $1", [unrelatedJob])).rows)
      .toEqual([{ count: 0 }]);
  });

  it("proves concurrent lease exclusion, expiry recovery, stale-token denial, and idempotent post-effect replay", async () => {
    const jobId = id("Job");
    const eventId = id("PublicEvent");
    await addEvent({ eventId, occurredAt: "2026-10-14T10:00:00.000Z", acceptedAt: "2026-10-14T10:00:00.000Z" });
    const firstOperations = createPostgresOperationsPersistence(worker!.database);
    const secondOperations = createPostgresOperationsPersistence(workerTwo!.database);
    await firstOperations.transactions.run(transaction => firstOperations.jobs.enqueue(transaction, {
      jobId, availableAt: now, payload: { type: "measurement.daily-aggregate.v1", version: 1, value: { utcDay: "2026-10-14" } },
    }));
    const claimInput = { workerId: "worker-one", now, leaseDurationSeconds: 60, limit: 1,
      jobTypes: ["measurement.daily-aggregate.v1"] };
    const [firstClaims, competingClaims] = await Promise.all([
      firstOperations.jobs.claimDue(claimInput),
      secondOperations.jobs.claimDue({ ...claimInput, workerId: "worker-two" }),
    ]);
    expect(firstClaims.length + competingClaims.length).toBe(1);
    const firstLease = firstClaims[0] ?? competingClaims[0]!;

    const firstModules = makeModuleServices(worker!);
    const firstEffect = await firstModules.daily.aggregateDay({ ...workCommand(jobId, "measurement.aggregate", now), utcDay: "2026-10-14" });
    expect(firstEffect).toMatchObject({ ok: true });
    const aggregateAfterFirstEffect = (await admin!.query(`select event_count,metric_key,dimensions from measurement.daily_aggregates
      where portfolio_id=$1 and utc_day='2026-10-14' and metric_kind='action' and dimensions='{}'::jsonb order by metric_key`, [portfolioId])).rows;
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
    const replay = await makeModuleServices(workerTwo!).daily.aggregateDay({ ...workCommand(jobId, "measurement.aggregate", afterExpiry), utcDay: "2026-10-14" });
    expect(replay).toMatchObject({ ok: true });
    const aggregateRows = (await admin!.query(`select event_count,metric_key,dimensions from measurement.daily_aggregates
      where portfolio_id=$1 and utc_day='2026-10-14' and metric_kind='action' and dimensions='{}'::jsonb order by metric_key`, [portfolioId])).rows;
    expect(aggregateRows).toEqual(aggregateAfterFirstEffect);
    expect(aggregateRows.some((row: { metric_key: string }) => row.metric_key === "page-viewed")).toBe(true);
    expect(await secondOperations.jobs.complete(jobId, reclaimed[0]!.leaseToken, afterExpiry)).toBe(true);
  });

  it("recovers a claimed cleanup job that crashes before its first effect", async () => {
    const jobId = id("Job");
    const expiredEvent = id("PublicEvent");
    await addEvent({ eventId: expiredEvent, occurredAt: "2026-10-01T00:00:00.000Z", acceptedAt: "2026-10-01T00:00:00.000Z" });
    const operations = createPostgresOperationsPersistence(worker!.database);
    await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, {
      jobId, availableAt: now, payload: { type: "measurement.detail-retention.v1", version: 1, value: {} },
    }));
    const claim = await operations.jobs.claimDue({ workerId: "worker-before-effect", now, leaseDurationSeconds: 60, limit: 1,
      jobTypes: ["measurement.detail-retention.v1"] });
    expect(claim).toHaveLength(1);
    // The first worker dies here, before calling the module-owned retention command.
    await admin!.query("update operations.jobs set lease_expires_at=clock_timestamp() - interval '1 second' where job_id=$1", [jobId]);
    const afterExpiry = new Date().toISOString();
    const recovered = await createPostgresOperationsPersistence(workerTwo!.database).jobs.claimDue({ workerId: "worker-recovered",
      now: afterExpiry, leaseDurationSeconds: 60, limit: 1, jobTypes: ["measurement.detail-retention.v1"] });
    expect(recovered).toHaveLength(1);
    const retention = makeModuleServices(workerTwo!).measurementRetention;
    let outcome = await retention.expireDetail(workCommand(jobId, "measurement.retention", afterExpiry));
    while (outcome.ok && outcome.value.nextCursor !== null) {
      outcome = await retention.expireDetail(workCommand(jobId, "measurement.retention", afterExpiry));
    }
    if (!outcome.ok) throw new Error(`PRE_EFFECT_RECOVERY_RESULT:${JSON.stringify(outcome.error)}`);
    expect(outcome).toMatchObject({ ok: true, value: { incomplete: true, nextCursor: null } });
    expect(await createPostgresOperationsPersistence(workerTwo!.database).jobs.complete(jobId, recovered[0]!.leaseToken, afterExpiry)).toBe(true);
    const remaining = (await admin!.query("select event_id,accepted_at from measurement.public_events where event_id=$1", [expiredEvent])).rows;
    expect(remaining).toHaveLength(0);
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
    await admin!.query(`update operations.jobs set status='completed',completed_at=clock_timestamp(),lease_owner=null,
      lease_token=null,lease_expires_at=null where job_type='measurement.detail-retention.v1' and status='available'`);
    const expiredEvent = id("PublicEvent");
    await addEvent({ eventId: expiredEvent, occurredAt: "2026-10-01T00:00:00.000Z", acceptedAt: "2026-10-01T00:00:00.000Z" });
    await admin!.query(`create function public.fail_due_work_event_delete() returns trigger language plpgsql as $$
      begin raise exception 'PRIVATE_SUBJECT_TOKEN_SHOULD_NOT_PERSIST'; end $$`);
    await admin!.query(`create trigger fail_due_work_event_delete before delete on measurement.public_events
      for each row execute function public.fail_due_work_event_delete()`);

    const operations = createPostgresOperationsPersistence(worker!.database, { now: () => now });
    const modules = makeModuleServices(worker!);
    const service = createPhase7DueWorkService({ portfolioId, clock: { now: () => now }, ids: createSystemIdGenerator(),
      operations, measurement: { ...modules.daily, ...modules.measurementRetention }, interaction: modules.feedbackRetention });
    const failedRun = await service.runDueWork({ workerId: "phase7-rollback-test" });
    if (!failedRun.ok || failedRun.value.failed !== 0 || failedRun.value.claimed !== 2 || failedRun.value.released !== 2 || !failedRun.value.incomplete) {
      throw new Error(`DUE_WORK_SAFE_FAILURE_RESULT:${JSON.stringify(failedRun)}`);
    }

    const failedJob = (await admin!.query(`select job_id,job_type,payload,status,attempt_count,last_error_code
      from operations.jobs where job_type='measurement.detail-retention.v1' and status='available' and last_error_code='PHASE7_WORK_FAILED' order by job_id limit 1`)).rows[0];
    if (failedJob?.status !== "available" || failedJob.attempt_count !== 2 || failedJob.last_error_code !== "PHASE7_WORK_FAILED" ||
        JSON.stringify(failedJob.payload) !== "{}") {
      throw new Error(`DUE_WORK_PERSISTED_FAILURE:${JSON.stringify(failedJob)}`);
    }
    expect((await admin!.query("select available_at > clock_timestamp() as delayed from operations.jobs where job_id=$1", [failedJob.job_id])).rows)
      .toEqual([{ delayed: true }]);
    expect(JSON.stringify(failedJob)).not.toContain("PRIVATE_SUBJECT_TOKEN_SHOULD_NOT_PERSIST");
    expect((await admin!.query("select 1 from measurement.public_events where event_id=$1", [expiredEvent])).rows).toHaveLength(1);
    expect((await admin!.query("select stage from measurement.retention_checkpoints where job_id=$1 and work_kind='detail'", [failedJob.job_id])).rows)
      .toEqual([{ stage: "events" }]);

    await admin!.query("drop trigger fail_due_work_event_delete on measurement.public_events; drop function public.fail_due_work_event_delete()");
    await admin!.query(`update operations.jobs set status='completed',completed_at=clock_timestamp(),lease_owner=null,
      lease_token=null,lease_expires_at=null where job_type='measurement.detail-retention.v1' and job_id<>$1 and status<>'completed'`, [failedJob.job_id]);
    await admin!.query("update operations.jobs set available_at=clock_timestamp() - interval '1 millisecond' where job_id=$1", [failedJob.job_id]);
    const retried = await operations.jobs.claimDue({ workerId: "phase7-rollback-retry", now: new Date().toISOString(),
      leaseDurationSeconds: 300, limit: 1, jobTypes: ["measurement.detail-retention.v1"] });
    expect(retried).toHaveLength(1);
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
  });

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

  it("fences outbox retries and terminalizes the fifth delivery with one incident", async () => {
    const operations = createPostgresOperationsPersistence(worker!.database);
    const eventId = id("DomainEvent");
    await admin!.query(`insert into operations.outbox_events(event_id,event_type,schema_version,aggregate_id,aggregate_version,
      payload,correlation_id,occurred_at,available_at)
      values ($1,'phase8.outbox-retry-probe.v1',1,$2,1,'{}'::jsonb,'phase8-outbox-fencing',clock_timestamp(),clock_timestamp())`,
    [eventId, portfolioId]);
    let previousToken: string | undefined;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claimed = await operations.outbox.claimDue({ workerId: `outbox-attempt-${attempt}`,
        now: new Date().toISOString(), leaseDurationSeconds: 30, limit: 1 });
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
    expect(await operations.outbox.claimDue({ workerId: "outbox-no-sixth-attempt", now: new Date().toISOString(),
      leaseDurationSeconds: 30, limit: 1 })).toHaveLength(0);
    expect((await admin!.query("select attempt_count,dead_at is not null as dead,last_error_code from operations.outbox_events where event_id=$1", [eventId])).rows)
      .toEqual([{ attempt_count: 5, dead: true, last_error_code: "HANDLER_TIMEOUT" }]);
    expect((await admin!.query("select occurrences,safe_error_code from operations.incidents where incident_key=$1", [`outbox:${eventId}`])).rows)
      .toEqual([{ occurrences: 1, safe_error_code: "HANDLER_TIMEOUT" }]);
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
  });
});
