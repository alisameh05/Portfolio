import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createStableId, parseIdempotencyKey, type StableId } from "../../src/shared/domain/index.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createPostgresConsentRepository } from "../../src/modules/measurement/adapters/postgres-consent.js";
import { createPostgresMeasurementEventRepository } from "../../src/modules/measurement/adapters/postgres-events.js";
import { createPostgresDailyAggregateRepository } from "../../src/modules/measurement/adapters/postgres-daily-aggregates.js";
import { createPostgresMeasurementRetentionRepository } from "../../src/modules/measurement/adapters/postgres-retention.js";
import { createMeasurementRetentionWorkService } from "../../src/modules/measurement/application/retention.js";
import { createDailyAggregateWorkService } from "../../src/modules/measurement/application/daily-aggregates.js";
import { createConsentApplicationService } from "../../src/modules/measurement/application/consent.js";
import { createMeasurementEventService, type MeasurementEventRepositoryPort } from "../../src/modules/measurement/application/ingest-event.js";
import { AesGcmConsentEvidenceAdapter } from "../../src/modules/identity-access/adapters/consent-evidence.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";

const workerUrl = process.env["PHASE7_RETENTION_DATABASE_URL"];
const appUrl = process.env["PHASE7_RETENTION_APP_URL"];
const adminUrl = process.env["PHASE7_RETENTION_ADMIN_URL"];
const baseNow = "2026-10-15T12:00:00.000Z";
const portfolioId = createStableId("Portfolio");
const routeId = createStableId("PublicRoute");

describe.runIf(Boolean(workerUrl && appUrl && adminUrl))("Measurement retention PostgreSQL acceptance", () => {
  const worker = createPostgresRuntimeDatabase(workerUrl ?? "postgres://invalid");
  const app = createPostgresRuntimeDatabase(appUrl ?? "postgres://invalid");
  const admin = new Client({ connectionString: adminUrl });
  const retention = createMeasurementRetentionWorkService({ portfolioId, transactions: worker.transactions,
    repository: createPostgresMeasurementRetentionRepository() });
  let now = baseNow;
  const nextId = <T extends string>(kind: T): StableId<T> => createStableId(kind);
  const command = (kind: "retention" | "withdrawal", jobId: StableId<"Job">, asOf = now, batchSize: 25 | 50 | 100 = 25) => ({
    scope: { kind: "portfolio" as const, portfolioId }, correlationId: "phase7-retention-test",
    actor: { kind: "system" as const, jobId, purpose: kind === "retention" ? "measurement.retention" as const : "measurement.withdrawal" as const },
    batchSize, now: asOf,
  });
  async function drain(work: (input: ReturnType<typeof command>) => Promise<{ ok: boolean; value?: { processedCount: number; nextCursor: string | null; incomplete: boolean }; error?: unknown }>,
    kind: "retention" | "withdrawal", asOf = now, batchSize: 25 | 50 | 100 = 25) {
    const jobId = nextId("Job"), results: { processedCount: number; nextCursor: string | null; incomplete: boolean }[] = [];
    for (let step = 0; step < 30; step++) {
      const response = await work(command(kind, jobId, asOf, batchSize));
      if (!response.ok || !response.value) throw new Error(`MEASUREMENT_RETENTION_WORK_FAILED:${JSON.stringify(response)}`);
      results.push(response.value);
      if (response.value.nextCursor === null) return { jobId, results };
    }
    throw new Error("MEASUREMENT_RETENTION_DID_NOT_FINISH");
  }
  async function addEvent(input: { subject: StableId<"MeasurementVisitor">; acceptedAt: string; occurredAt?: string; eventId?: StableId<"PublicEvent"> }) {
    const eventId = input.eventId ?? nextId("PublicEvent");
    const occurredAt = input.occurredAt ?? input.acceptedAt;
    await admin.query(`insert into measurement.public_events
      (event_id,portfolio_id,measurement_subject,action,occurred_at,accepted_at,effective_at,page_route_identity,locale,consent_version,journey_context)
      values ($1,$2,$3,'page-viewed',$4,$5,$4,$6,'en','2026-10',$7::uuid[])`,
      [eventId, portfolioId, input.subject, occurredAt, input.acceptedAt, routeId, [routeId]]);
    return eventId;
  }
  async function addConsent(input: { subject: StableId<"MeasurementVisitor"> | null; state: "granted" | "denied" | "unknown"; evidenceExpiresAt: string; recordedAt?: string }) {
    const consentId = nextId("Consent"), recordedAt = input.recordedAt ?? "2026-09-01T00:00:00.000Z";
    await admin.query(`insert into measurement.consents
      (portfolio_id,consent_id,subject,state,notice_version,revision,recorded_at,evidence_expires_at)
      values ($1,$2,$3,$4,'2026-10',1,$5,$6)`, [portfolioId, consentId, input.subject, input.state, recordedAt, input.evidenceExpiresAt]);
    await admin.query(`insert into measurement.consent_history (portfolio_id,consent_id,revision,state,notice_version,recorded_at)
      values ($1,$2,1,$3,'2026-10',$4)`, [portfolioId, consentId, input.state, recordedAt]);
    return consentId;
  }
  async function addContribution(input: { subject: StableId<"MeasurementVisitor">; eventId: StableId<"PublicEvent">; acceptedAt: string; convertedAt: string }) {
    const goalId = nextId("AnalyticsGoal"), versionId = nextId("AnalyticsGoalVersion");
    await admin.query(`insert into measurement.analytics_goals (portfolio_id,goal_id,aggregate_version,active_version_id)
      values ($1,$2,1,null)`, [portfolioId, goalId]);
    await admin.query(`insert into measurement.analytics_goal_versions (portfolio_id,goal_id,version_id,version_number,definition,created_at)
      values ($1,$2,$3,1,'{"name":"Retention fixture","steps":[]}'::jsonb,$4)`, [portfolioId, goalId, versionId, input.acceptedAt]);
    await admin.query(`update measurement.analytics_goals set active_version_id=$3 where portfolio_id=$1 and goal_id=$2`, [portfolioId, goalId, versionId]);
    await admin.query(`insert into measurement.goal_conversion_rebuilds
      (portfolio_id,measurement_subject,generation,completed_generation,trigger_event_id,trigger_accepted_at,progress,completed,updated_at)
      values ($1,$2,1,1,$3,$4,'{}'::jsonb,true,$4)`, [portfolioId, input.subject, input.eventId, input.acceptedAt]);
    await admin.query(`insert into measurement.goal_conversion_contributions
      (portfolio_id,measurement_subject,goal_id,version_id,terminal_event_id,converted_at,accepted_at,consent_revision,activation_sequence,generation)
      values ($1,$2,$3,$4,$5,$6,$7,1,1,1)`, [portfolioId, input.subject, goalId, versionId, input.eventId, input.convertedAt, input.acceptedAt]);
  }
  async function addAggregate(day: string, count = 7) {
    await admin.query(`insert into measurement.daily_aggregates
      (portfolio_id,utc_day,metric_kind,metric_key,dimensions,event_count,sum_value,observed_subjects,returning_subjects,policy_version,checkpoint_at)
      values ($1,$2::date,'action','page-viewed','{}'::jsonb,$3,0,5,0,'phase7.daily.v1',($2::date::timestamp at time zone 'UTC'))`, [portfolioId, day, count]);
    await admin.query(`insert into measurement.daily_aggregate_checkpoints
      (portfolio_id,utc_day,source_event_count,source_conversion_count,policy_version,checkpoint_at)
      values ($1,$2::date,0,0,'phase7.daily.v1',($2::date::timestamp at time zone 'UTC')) on conflict do nothing`, [portfolioId, day]);
  }

  beforeAll(async () => { await admin.connect(); });
  afterAll(async () => { await admin.end(); await app.resource.close(); await worker.resource.close(); });

  it("expires acceptedAt-anchored raw events and subject-linked alternates in deterministic batches of at most 100", async () => {
    const cutoff = "2026-10-01T12:00:00.000Z";
    const subjects = Array.from({ length: 101 }, () => nextId("MeasurementVisitor"));
    const expired: StableId<"PublicEvent">[] = [];
    for (let index = 0; index < subjects.length; index++) {
      const acceptedAt = index === 0 ? "2026-10-01T11:59:59.999Z" : cutoff;
      expired.push(await addEvent({ subject: subjects[index]!, acceptedAt }));
    }
    const younger = await addEvent({ subject: subjects[0]!, acceptedAt: "2026-10-01T12:00:00.001Z" });
    await addContribution({ subject: subjects[0]!, eventId: expired[0]!, acceptedAt: "2026-10-01T11:59:59.999Z", convertedAt: "2026-10-01T12:00:00.000Z" });
    await addContribution({ subject: subjects[1]!, eventId: expired[1]!, acceptedAt: cutoff, convertedAt: cutoff });
    const completed = await drain(input => retention.expireDetail(input), "retention", baseNow, 100);
    expect(completed.results.every(result => result.processedCount <= 100)).toBe(true);
    const raw = await admin.query("select event_id::text from measurement.public_events where portfolio_id=$1 and event_id=any($2::uuid[])", [portfolioId, expired]);
    expect(raw.rows).toHaveLength(0);
    expect((await admin.query("select 1 from measurement.public_events where event_id=$1", [younger])).rows).toHaveLength(1);
    expect((await admin.query("select 1 from measurement.goal_conversion_contributions where portfolio_id=$1", [portfolioId])).rows).toHaveLength(0);
    expect((await admin.query("select 1 from measurement.goal_conversion_rebuilds where portfolio_id=$1 and measurement_subject=$2", [portfolioId, subjects[0]])).rows).toHaveLength(1);
    expect((await admin.query("select 1 from measurement.goal_conversion_rebuilds where portfolio_id=$1 and measurement_subject=$2", [portfolioId, subjects[1]])).rows).toHaveLength(0);
    const sealed = await admin.query("select incomplete,retention_sealed from measurement.daily_aggregate_checkpoints where portfolio_id=$1 and utc_day='2026-10-01'", [portfolioId]);
    expect(sealed.rows[0]).toEqual({ incomplete: true, retention_sealed: true });
    const progress = await admin.query("select count(*)::int as count from measurement.retention_checkpoints where portfolio_id=$1 and job_id=$2", [portfolioId, completed.jobId]);
    expect(progress.rows[0].count).toBe(0);
  });

  it("expires daily aggregates from UTC day start plus thirteen calendar months, clamping month ends", async () => {
    await addAggregate("2024-01-31", 11);
    await addAggregate("2024-02-29", 13);
    const exactMonthEnd = await drain(input => retention.expireAggregates(input), "retention", "2025-02-28T00:00:00.000Z");
    expect(exactMonthEnd.results.every(result => result.processedCount <= 25)).toBe(true);
    expect((await admin.query("select 1 from measurement.daily_aggregates where portfolio_id=$1 and utc_day='2024-01-31'", [portfolioId])).rows).toHaveLength(0);
    expect((await admin.query("select 1 from measurement.daily_aggregates where portfolio_id=$1 and utc_day='2024-02-29'", [portfolioId])).rows).toHaveLength(1);
    await drain(input => retention.expireAggregates(input), "retention", "2025-03-29T00:00:00.000Z");
    expect((await admin.query("select 1 from measurement.daily_aggregates where portfolio_id=$1 and utc_day='2024-02-29'", [portfolioId])).rows).toHaveLength(0);
    expect((await admin.query("select 1 from measurement.daily_aggregate_checkpoints where portfolio_id=$1 and utc_day='2024-01-31'", [portfolioId])).rows).toHaveLength(0);
  });

  it("rolls back a failed bounded batch and resumes from the same checkpoint", async () => {
    now = baseNow;
    const subject = nextId("MeasurementVisitor");
    const eventId = await addEvent({ subject, acceptedAt: "2026-10-01T00:00:00.000Z" });
    const jobId = nextId("Job");
    const batch = command("retention", jobId, now, 25);
    const advanced = await retention.expireDetail(batch);
    expect(advanced).toMatchObject({ ok: true, value: { nextCursor: jobId } });
    await admin.query(`create function public.fail_retention_event_delete() returns trigger language plpgsql as $$
      begin raise exception 'retention test failure'; end $$`);
    await admin.query(`create trigger fail_retention_event_delete before delete on measurement.public_events
      for each row execute function public.fail_retention_event_delete()`);
    const failed = await retention.expireDetail(batch);
    expect(failed).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable" } });
    expect((await admin.query("select 1 from measurement.public_events where event_id=$1", [eventId])).rows).toHaveLength(1);
    expect((await admin.query("select stage from measurement.retention_checkpoints where portfolio_id=$1 and job_id=$2 and work_kind='detail'", [portfolioId, jobId])).rows[0]).toEqual({ stage: "events" });
    await admin.query("drop trigger fail_retention_event_delete on measurement.public_events; drop function public.fail_retention_event_delete()");
    let resumed = await retention.expireDetail(batch);
    if (!resumed.ok) throw new Error(`MEASUREMENT_RETENTION_RETRY_FAILED:${JSON.stringify(resumed)}`);
    for (let step = 0; resumed.value.nextCursor !== null && step < 8; step++) {
      resumed = await retention.expireDetail(batch);
      if (!resumed.ok) throw new Error(`MEASUREMENT_RETENTION_RETRY_FAILED:${JSON.stringify(resumed)}`);
    }
    expect(resumed.value.nextCursor).toBeNull();
    expect((await admin.query("select 1 from measurement.public_events where event_id=$1", [eventId])).rows).toHaveLength(0);
  });

  it("seals complete aggregates before raw deletion and reports incomplete coverage when unprocessed detail expires", async () => {
    now = "2026-10-16T12:00:00.000Z";
    const completeSubject = nextId("MeasurementVisitor");
    await addEvent({ subject: completeSubject, acceptedAt: "2026-10-02T12:00:00.000Z" });
    await addAggregate("2026-10-02", 19);
    await admin.query(`update measurement.daily_aggregate_checkpoints set source_event_count=1, checkpoint_at=$2
      where portfolio_id=$1 and utc_day='2026-10-02'`, [portfolioId, now]);
    const expired = await drain(input => retention.expireDetail(input), "retention", now);
    expect(expired.results.at(-1)?.nextCursor).toBeNull();
    const again = createDailyAggregateWorkService({ portfolioId, transactions: worker.transactions, repository: createPostgresDailyAggregateRepository() });
    await again.aggregateDay({ ...command("retention", nextId("Job"), now), actor: { kind: "system", jobId: nextId("Job"), purpose: "measurement.aggregate" }, utcDay: "2026-10-02" });
    expect((await admin.query("select event_count::int as count from measurement.daily_aggregates where portfolio_id=$1 and utc_day='2026-10-02'", [portfolioId])).rows[0].count).toBe(19);
    expect((await admin.query("select retention_sealed,incomplete from measurement.daily_aggregate_checkpoints where portfolio_id=$1 and utc_day='2026-10-02'", [portfolioId])).rows[0]).toEqual({ retention_sealed: true, incomplete: false });
  });

  it("cleans withdrawn subjects while preserving the bounded revocation proof and rejecting the old signed token", async () => {
    now = baseNow;
    const cryptoConfig = {
      functional: { active: { version: 1, secret: Buffer.alloc(32, 11).toString("base64url") }, previous: [] },
      measurement: { active: { version: 1, secret: Buffer.alloc(32, 22).toString("base64url") }, previous: [] },
    };
    const consentService = createConsentApplicationService({ transactions: app.transactions, repository: createPostgresConsentRepository(),
      crypto: new AesGcmConsentEvidenceAdapter(cryptoConfig, () => now),
      clock: { now: () => now }, ids: createSystemIdGenerator(), supportedNoticeVersions: ["2026-10"], ttlSeconds: 86_400 });
    const scope = { kind: "portfolio" as const, portfolioId };
    const granted = await consentService.recordConsent({ scope, correlationId: "retention-consent", consent: "granted", noticeVersion: "2026-10", expectedRevision: 0 });
    if (!granted.ok || !granted.value.evidence) throw new Error("RETENTION_TEST_GRANT_FAILED");
    const token = granted.value.evidence;
    const checked = await consentService.verifyEvidence({ scope, correlationId: "retention-consent", noticeVersion: "2026-10", token });
    if (!checked.ok) throw new Error("RETENTION_TEST_EVIDENCE_FAILED");

    const operations = createPostgresOperationsPersistence(app.database, { now: () => now });
    const realEventRepository = createPostgresMeasurementEventRepository();
    let releaseInsert!: () => void;
    let reportInsertStarted!: () => void;
    const insertStarted = new Promise<void>(resolve => { reportInsertStarted = resolve; });
    const insertGate = new Promise<void>(resolve => { releaseInsert = resolve; });
    const eventRepository: MeasurementEventRepositoryPort = { async insert(event, transaction) {
      reportInsertStarted();
      await insertGate;
      await realEventRepository.insert(event, transaction);
    } };
    const events = createMeasurementEventService({ portfolioId, transactions: operations.transactions, operations,
      consent: consentService,
      content: {
        async getRouteFacts(input) { return { ok: true as const, value: { routeId: input.routeId, projectId: null, contentType: "project" as const, published: true } }; },
        async hasRetainedPublicRoute() { return { ok: true as const, value: true }; },
      }, repository: eventRepository, clock: { now: () => now }, ids: createSystemIdGenerator() });
    const keyResult = parseIdempotencyKey(createStableId("Key"));
    if (!keyResult.ok) throw new Error("RETENTION_TEST_KEY_INVALID");
    const eventCommand = { scope, correlationId: "retention-event-race", actor: { kind: "visitor" as const, consent: "granted" as const },
      measurement: checked.value, idempotencyKey: keyResult.value,
      event: { action: "page-viewed", context: { occurredAt: now, locale: "en", pageRouteIdentity: routeId, consentVersion: "2026-10", journeyContext: [routeId] } } as never };
    const intake = events.ingestEvent(eventCommand);
    await insertStarted;
    const revokedPromise = consentService.recordConsent({ scope, correlationId: "retention-withdrawal", consentId: granted.value.consentId,
      expectedRevision: 1, consent: "denied", noticeVersion: "2026-10" });
    releaseInsert();
    const [accepted, revoked] = await Promise.all([intake, revokedPromise]);
    expect(accepted.ok).toBe(true);
    expect(revoked).toMatchObject({ ok: true, value: { revision: 2, state: "denied" } });
    if (!accepted.ok) throw new Error("RETENTION_TEST_INTAKE_FAILED");
    const retainedEventId = accepted.value.eventId;
    const cleaned = await drain(input => retention.cleanWithdrawnConsent(input), "withdrawal", now);
    expect(cleaned.results.every(result => result.processedCount <= 25)).toBe(true);
    expect((await admin.query("select 1 from measurement.public_events where event_id=$1", [retainedEventId])).rows).toHaveLength(0);
    expect(await consentService.verifyEvidence({ scope, correlationId: "retention-replay", noticeVersion: "2026-10", token }))
      .toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(await events.ingestEvent(eventCommand)).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect((await admin.query("select 1 from measurement.public_events where event_id=$1", [retainedEventId])).rows).toHaveLength(0);
    expect((await admin.query("select state,subject from measurement.consents where portfolio_id=$1 and consent_id=$2", [portfolioId, granted.value.consentId])).rows[0])
      .toMatchObject({ state: "denied", subject: checked.value.subject });
    const safeJob = await admin.query("select payload from operations.jobs where payload->>'eventId'=$1", [retainedEventId]);
    expect(JSON.stringify(safeJob.rows)).not.toContain(checked.value.subject);
    now = new Date(Date.parse(baseNow) + 86_400_000).toISOString();
    await drain(input => retention.expireDetail(input), "retention", now);
    expect((await admin.query("select 1 from measurement.consents where portfolio_id=$1 and consent_id=$2", [portfolioId, granted.value.consentId])).rows).toHaveLength(0);
    expect((await admin.query("select 1 from measurement.consent_history where portfolio_id=$1 and consent_id=$2", [portfolioId, granted.value.consentId])).rows).toHaveLength(0);
  });

  it("does not grant cross-Portfolio delete access to the Worker or delete access to the application role", async () => {
    const foreignPortfolio = nextId("Portfolio"), foreignSubject = nextId("MeasurementVisitor");
    const foreignEvent = nextId("PublicEvent");
    await admin.query(`insert into measurement.public_events
      (event_id,portfolio_id,measurement_subject,action,occurred_at,accepted_at,effective_at,page_route_identity,locale,consent_version)
      values ($1,$2,$3,'page-viewed',$4,$4,$4,$5,'en','2026-10')`, [foreignEvent, foreignPortfolio, foreignSubject, baseNow, routeId]);
    const privilege = await admin.query("select has_table_privilege('retention_app_runtime','measurement.public_events','DELETE') as can_delete");
    expect(privilege.rows[0].can_delete).toBe(false);
    const consentLock = await admin.query(`select
      has_column_privilege('retention_worker_runtime','measurement.consents','retention_lock','UPDATE') as can_lock,
      has_column_privilege('retention_worker_runtime','measurement.consents','state','UPDATE') as can_change_state`);
    expect(consentLock.rows[0]).toEqual({ can_lock: true, can_change_state: false });
    const deleted = await worker.transactions.run(async tx => {
      const { sql } = await import("kysely");
      const { resolvePostgresTransaction } = await import("../../src/shared/adapters/postgres/runtime.js");
      const db = resolvePostgresTransaction(tx);
      await sql`select set_config('shipwithali.portfolio_id', ${portfolioId}, true)`.execute(db);
      return sql`delete from measurement.public_events where portfolio_id=${foreignPortfolio}::uuid`.execute(db);
    });
    expect(Number(deleted.numAffectedRows ?? 0n)).toBe(0);
    expect((await admin.query("select 1 from measurement.public_events where event_id=$1", [foreignEvent])).rows).toHaveLength(1);
  });
});
