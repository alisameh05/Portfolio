import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { parseSafeErrorCode } from "../../src/modules/portability-operations/index.js";
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
const now = "2026-10-15T12:00:00.000Z";
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
    // Simulate a worker crash after its PostgreSQL effect committed and before lease completion.
    const afterExpiry = "2026-10-15T12:02:00.000Z";
    const reclaimed = await secondOperations.jobs.claimDue({ ...claimInput, workerId: "worker-two", now: afterExpiry });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.leaseToken).not.toBe(firstLease.leaseToken);
    expect(await firstOperations.jobs.complete(jobId, firstLease.leaseToken, afterExpiry)).toBe(false);
    expect(await firstOperations.jobs.fail(jobId, firstLease.leaseToken, parseSafeErrorCode("PHASE7_WORK_FAILED"))).toBe(false);
    const replay = await makeModuleServices(workerTwo!).daily.aggregateDay({ ...workCommand(jobId, "measurement.aggregate", afterExpiry), utcDay: "2026-10-14" });
    expect(replay).toMatchObject({ ok: true });
    const aggregateRows = (await admin!.query(`select event_count,metric_key,dimensions from measurement.daily_aggregates
      where portfolio_id=$1 and utc_day='2026-10-14' and metric_kind='action' and dimensions='{}'::jsonb`, [portfolioId])).rows;
    expect(aggregateRows.filter((row: { metric_key: string }) => row.metric_key === "page-viewed")
      .map((row: { event_count: string }) => row.event_count)).toEqual(["2"]);
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
    const afterExpiry = "2026-10-15T12:02:00.000Z";
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

  it("rolls back a failed retention batch, persists only safe retry diagnostics, then retries to completion", async () => {
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
    if (!failedRun.ok || failedRun.value.failed !== 1 || !failedRun.value.incomplete) {
      throw new Error(`DUE_WORK_SAFE_FAILURE_RESULT:${JSON.stringify(failedRun)}`);
    }

    const failedJob = (await admin!.query(`select job_id,job_type,payload,status,attempt_count,last_error_code
      from operations.jobs where job_type='measurement.detail-retention.v1' and status='available' order by job_id limit 1`)).rows[0];
    if (failedJob?.status !== "available" || failedJob.attempt_count !== 2 || failedJob.last_error_code !== "PHASE7_WORK_FAILED" ||
        JSON.stringify(failedJob.payload) !== "{}") {
      throw new Error(`DUE_WORK_PERSISTED_FAILURE:${JSON.stringify(failedJob)}`);
    }
    expect(JSON.stringify(failedJob)).not.toContain("PRIVATE_SUBJECT_TOKEN_SHOULD_NOT_PERSIST");
    expect((await admin!.query("select 1 from measurement.public_events where event_id=$1", [expiredEvent])).rows).toHaveLength(1);
    expect((await admin!.query("select stage from measurement.retention_checkpoints where job_id=$1 and work_kind='detail'", [failedJob.job_id])).rows)
      .toEqual([{ stage: "events" }]);

    await admin!.query("drop trigger fail_due_work_event_delete on measurement.public_events; drop function public.fail_due_work_event_delete()");
    const retriedRun = await service.runDueWork({ workerId: "phase7-rollback-test" });
    expect(retriedRun).toMatchObject({ ok: true, value: { failed: 0, incomplete: true } });
    const retriedJob = (await admin!.query("select status,attempt_count,last_error_code from operations.jobs where job_id=$1", [failedJob.job_id])).rows[0];
    expect(retriedJob.status).toBe("completed");
    expect(retriedJob.attempt_count).toBeGreaterThan(failedJob.attempt_count);
    expect(retriedJob.last_error_code).toBe("PHASE7_WORK_FAILED");
    expect((await admin!.query("select 1 from measurement.public_events where event_id=$1", [expiredEvent])).rows).toHaveLength(0);
  });
});
