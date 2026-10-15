import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createPostgresDailyAggregateRepository } from "../../src/modules/measurement/adapters/postgres-daily-aggregates.js";
import type { MeasurementEventType } from "../../src/modules/measurement/domain/index.js";
import { createDailyAggregateWorkService, createOwnerAggregateReportService } from "../../src/modules/measurement/application/daily-aggregates.js";
import type { MeasurementWorkCommand } from "../../src/modules/measurement/application/work.js";
import type { DailyAggregateRepositoryPort } from "../../src/modules/measurement/ports/daily-aggregates.js";
import { parseStableId, type StableId } from "../../src/shared/domain/index.js";
import { getOwnerAggregateReportApplicationService, initializeDatabaseRuntime, resetRuntimeForTests } from "../../src/bootstrap/composition-root.js";
import { getLifecycleCoordinator } from "../../src/runtime/lifecycle.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";

const DATABASE_URL = process.env["PHASE7_AGGREGATE_DATABASE_URL"];
const ADMIN_URL = process.env["PHASE7_AGGREGATE_ADMIN_URL"];
const portfolioId = "0196a1b2-7c3d-7e11-9f22-000000000001" as StableId<"Portfolio">;
const ownerId = "0196a1b2-7c3d-7e11-9f22-000000000002" as StableId<"Owner">;
const routeId = "0196a1b2-7c3d-7e11-9f22-000000000003" as StableId<"PublicRoute">;
const projectId = "0196a1b2-7c3d-7e11-9f22-000000000004" as StableId<"Project">;
const now = "2026-10-15T12:00:00.000Z";
let admin: Client | undefined;
let app: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
let worker: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
let idSequence = 100;

function id<T extends string>(kind: T): StableId<T> {
  const parsed = parseStableId(kind, `0196a1b2-7c3d-7e11-9f22-${(idSequence++).toString(16).padStart(12, "0")}`);
  if (!parsed.ok) throw new Error("DAILY_AGGREGATE_TEST_ID_INVALID");
  return parsed.value;
}

function command(utcDay: string, jobId = id("Job"), at = now): MeasurementWorkCommand & { readonly utcDay: string } {
  return { scope: { kind: "portfolio", portfolioId }, correlationId: "phase7-daily-aggregate-test",
    actor: { kind: "system", jobId, purpose: "measurement.aggregate" }, batchSize: 25, now: at, utcDay };
}

async function addEvent(input: { subject: StableId<"MeasurementVisitor">; action: "page-viewed" | "project-viewed" | "active-engagement-sampled";
  occurredAt: string; acceptedAt?: string; activeMilliseconds?: number; locale?: "en" | "ar"; countryCode?: string | null;
  deviceClass?: "desktop" | "mobile" | "tablet" | "other" | "unknown"; referrerClass?: "direct" | "search" | "social" | "professional" | "referral" | "unknown" }): Promise<StableId<"PublicEvent">> {
  const eventId = id("PublicEvent");
  await admin!.query(`insert into measurement.public_events
    (event_id,portfolio_id,measurement_subject,action,occurred_at,accepted_at,effective_at,page_route_identity,project_id,
      locale,consent_version,active_milliseconds,country_code,device_class,referrer_class)
    values ($1,$2,$3,$4,$5,$6,$5,$7,$8,$10,'v1',$9,$11,$12,$13)`,
    [eventId, portfolioId, input.subject, input.action, input.occurredAt, input.acceptedAt ?? input.occurredAt,
      routeId, input.action === "page-viewed" ? null : projectId,
      input.action === "active-engagement-sampled" ? input.activeMilliseconds ?? 5_000 : null,
      input.locale ?? "en", input.countryCode ?? "EG", input.deviceClass ?? "mobile", input.referrerClass ?? "direct"]);
  return eventId;
}

async function addGoal(subjects: readonly StableId<"MeasurementVisitor">[], terminalEvents: readonly StableId<"PublicEvent">[], action: "page-viewed" | "project-viewed" = "project-viewed") {
  const goalId = id("AnalyticsGoal"), versionId = id("AnalyticsGoalVersion"), activationId = id("Event");
  await admin!.query(`insert into measurement.analytics_goals (portfolio_id,goal_id,aggregate_version,active_version_id)
    values ($1,$2,3,null)`, [portfolioId, goalId]);
  const definition = { name: "Project engagement", steps: [{ action, ...(action === "project-viewed" ? { projectIds: [projectId] } : {}) }] };
  await admin!.query(`insert into measurement.analytics_goal_versions (portfolio_id,goal_id,version_id,version_number,definition,created_at)
    values ($1,$2,$3,1,$4::jsonb,'2026-10-14T00:00:00Z')`, [portfolioId, goalId, versionId, JSON.stringify(definition)]);
  await admin!.query("update measurement.analytics_goals set active_version_id=$3 where portfolio_id=$1 and goal_id=$2", [portfolioId, goalId, versionId]);
  await admin!.query(`insert into measurement.analytics_goal_activation_history
    (portfolio_id,goal_id,activation_id,version_id,aggregate_version,activated_at,activation_sequence)
    values ($1,$2,$3,$4,3,'2026-10-14T00:00:00Z',1)`, [portfolioId, goalId, activationId, versionId]);
  for (let index = 0; index < subjects.length; index++) {
    const subject = subjects[index]!;
    const triggerEventId = terminalEvents[index]!;
    await admin!.query(`insert into measurement.goal_conversion_rebuilds
      (portfolio_id,measurement_subject,generation,completed_generation,trigger_event_id,trigger_accepted_at,progress,completed,updated_at)
      values ($1,$2,1,1,$3,'2026-10-14T23:59:59Z','{}'::jsonb,true,'2026-10-15T00:00:00Z')`, [portfolioId, subject, triggerEventId]);
    await admin!.query(`insert into measurement.goal_conversion_contributions
      (portfolio_id,measurement_subject,goal_id,version_id,terminal_event_id,converted_at,accepted_at,consent_revision,activation_sequence,generation)
      values ($1,$2,$3,$4,$5,'2026-10-14T23:59:59Z','2026-10-14T23:59:59Z',1,1,1)`,
      [portfolioId, subject, goalId, versionId, triggerEventId]);
  }
  return { goalId, versionId, definition };
}

function createServices(repository: DailyAggregateRepositoryPort = createPostgresDailyAggregateRepository()) {
  const workerService = createDailyAggregateWorkService({ portfolioId, transactions: worker!.transactions, repository });
  const reportService = createOwnerAggregateReportService({ scope: { portfolioId, ownerId },
    authorize: async () => ({ ok: true as const, value: true }), transactions: app!.transactions,
    repository, clock: { now: () => now } });
  return { workerService, reportService };
}

async function aggregate(day: string) {
  return createServices().workerService.aggregateDay(command(day));
}

async function report(input: { startDate: string; endDate: string; grouping: "daily-action" | "daily-goal"; action?: MeasurementEventType;
  breakdown?: "summary" | "locale" | "country" | "device" | "referrer" | "project" | "route" }) {
  return createServices().reportService.getAggregateReport({ scope: { kind: "portfolio", portfolioId },
    correlationId: "phase7-daily-aggregate-report", actor: { kind: "owner", ownerId, sessionId: "owner-session" }, ...input });
}

describe.runIf(Boolean(DATABASE_URL && ADMIN_URL))("Measurement daily aggregation PostgreSQL acceptance", () => {
  beforeAll(async () => {
    if (!DATABASE_URL || !ADMIN_URL) throw new Error("PHASE7_AGGREGATE_DATABASE_REQUIRED");
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    app = createPostgresRuntimeDatabase(DATABASE_URL);
    worker = createPostgresRuntimeDatabase(DATABASE_URL.replace("aggregate_app_runtime", "aggregate_worker_runtime"));
  }, 20_000);

  afterAll(async () => {
    await worker?.resource.close();
    await app?.resource.close();
    await admin?.end();
  });

  it("reconciles UTC action totals, active-attention sums, and completed goal-version conversions", async () => {
    await admin!.query(`insert into portfolio_config.settings
      (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback)
      values ($1,$2,'Owner','Headline','Bio','Contact','https://example.com','Unavailable')`, [portfolioId, ownerId]);
    await admin!.query(`insert into content.items (content_id,portfolio_id,content_type,lifecycle,candidate_slug)
      values ($1,$2,'project','published',null)`, [projectId, portfolioId]);
    const subjects = Array.from({ length: 6 }, () => id("MeasurementVisitor"));
    const dayEvents: StableId<"PublicEvent">[] = [];
    for (let index = 0; index < subjects.length; index++) {
      const subject = subjects[index]!;
      if (index < 3) await addEvent({ subject, action: "page-viewed", occurredAt: "2026-10-13T22:00:00Z" });
      dayEvents.push(await addEvent({ subject, action: "project-viewed", occurredAt: "2026-10-14T23:59:30Z", acceptedAt: "2026-10-15T00:00:10Z" }));
      await addEvent({ subject, action: "active-engagement-sampled", occurredAt: "2026-10-14T23:59:45Z", acceptedAt: "2026-10-15T00:00:20Z", activeMilliseconds: 5_000 });
    }
    const goal = await addGoal(subjects.slice(0, 5), dayEvents.slice(0, 5));
    expect(await aggregate("2026-10-13")).toMatchObject({ ok: true, value: { incomplete: false } });
    expect(await aggregate("2026-10-14")).toMatchObject({ ok: true, value: { incomplete: false } });

    const projectViews = await report({ startDate: "2026-10-14", endDate: "2026-10-14", grouping: "daily-action", action: "project-viewed" });
    expect(projectViews).toMatchObject({ ok: true, value: { state: "available", policyVersion: "phase7.daily.v2", asOf: now, incomplete: false,
      rows: [{ count: 6, metric: "action", action: "project-viewed" }] } });
    const engagement = await report({ startDate: "2026-10-14", endDate: "2026-10-14", grouping: "daily-action", action: "active-engagement-sampled" });
    expect(engagement).toMatchObject({ ok: true, value: { state: "available", rows: [{ count: 6, sum: 30_000, action: "active-engagement-sampled" }] } });
    const goals = await report({ startDate: "2026-10-14", endDate: "2026-10-14", grouping: "daily-goal" });
    expect(goals).toMatchObject({ ok: true, value: { state: "available", rows: [{ count: 5, metric: "goal", goalId: goal.goalId,
      goalVersionId: goal.versionId, definitionSnapshot: goal.definition }] } });
    const privateData = JSON.stringify([projectViews, engagement, goals]);
    expect(privateData).not.toContain("measurementSubject");
    expect(privateData).not.toContain("functionalId");
    expect(privateData).not.toContain("authorName");
    const stored = await admin!.query(`select metric_key,observed_subjects::int,returning_subjects::int,sum_value::int,utc_day::text
      from measurement.daily_aggregates where portfolio_id=$1 and utc_day='2026-10-14' and metric_kind='action' order by metric_key`, [portfolioId]);
    const engagementStat = stored.rows.find(row => row.sum_value === 30_000);
    expect(engagementStat).toMatchObject({ observed_subjects: 6, returning_subjects: 3, utc_day: "2026-10-14" });
    expect(engagementStat!.returning_subjects).toBeLessThanOrEqual(engagementStat!.observed_subjects);

    await admin!.query("update content.items set lifecycle='hidden' where content_id=$1", [projectId]);
    expect(await report({ startDate: "2026-10-14", endDate: "2026-10-14", grouping: "daily-action", action: "project-viewed" }))
      .toMatchObject({ ok: true, value: { state: "available", rows: [{ count: 6 }] } });
    await admin!.query("update content.items set lifecycle='archived' where content_id=$1", [projectId]);
    expect(await report({ startDate: "2026-10-14", endDate: "2026-10-14", grouping: "daily-action", action: "project-viewed" }))
      .toMatchObject({ ok: true, value: { state: "available", rows: [{ count: 6 }] } });
  });

  it("reclaims an expired daily job, includes late accepted events, and replays action and goal totals", async () => {
    const subject = id("MeasurementVisitor"), jobId = id("Job");
    const triggerEvent = await addEvent({ subject, action: "page-viewed", occurredAt: "2026-10-14T12:00:00Z" });
    const goal = await addGoal([subject], [triggerEvent], "page-viewed");
    const operations = createPostgresOperationsPersistence(worker!.database);
    await operations.transactions.run(tx => operations.jobs.enqueue(tx, { jobId, availableAt: now,
      payload: { type: "measurement.daily-aggregate.v1", version: 1, value: { portfolioId, utcDay: "2026-10-14" } } }));
    const claim = { workerId: "daily-aggregate-proof", now, leaseDurationSeconds: 1, limit: 1 };
    const firstClaim = await operations.jobs.claimDue(claim);
    expect(firstClaim).toHaveLength(1);
    expect(firstClaim[0]!.jobId).toBe(jobId);
    const { workerService } = createServices();
    await workerService.aggregateDay(command("2026-10-14", jobId));
    const later = "2026-10-15T12:00:02.000Z";
    const reclaimed = await operations.jobs.claimDue({ ...claim, now: later });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]!.leaseToken).not.toBe(firstClaim[0]!.leaseToken);
    expect(await operations.jobs.complete(jobId, firstClaim[0]!.leaseToken, later)).toBe(false);
    const late = await addEvent({ subject, action: "page-viewed", occurredAt: "2026-10-14T11:59:00Z", acceptedAt: "2026-10-15T11:00:00Z" });
    expect(late).toBeTruthy();
    await workerService.aggregateDay(command("2026-10-14", jobId, later));
    const first = await admin!.query(`select event_count::int,observed_subjects::int from measurement.daily_aggregates
      where portfolio_id=$1 and utc_day='2026-10-14' and metric_key='page-viewed' and dimensions='{}'::jsonb`, [portfolioId]);
    expect(await operations.jobs.complete(jobId, reclaimed[0]!.leaseToken, later)).toBe(true);
    await workerService.aggregateDay(command("2026-10-14", jobId, later));
    const second = await admin!.query(`select event_count::int,observed_subjects::int from measurement.daily_aggregates
      where portfolio_id=$1 and utc_day='2026-10-14' and metric_key='page-viewed' and dimensions='{}'::jsonb`, [portfolioId]);
    expect(first.rows).toEqual([{ event_count: 2, observed_subjects: 1 }]);
    expect(second.rows).toEqual(first.rows);
    const conversions = await admin!.query(`select metric_key,event_count::int,goal_id::text,goal_version_id::text from measurement.daily_aggregates
      where portfolio_id=$1 and utc_day='2026-10-14' and metric_kind='goal' and goal_id=$2 and dimensions='{}'::jsonb`, [portfolioId, goal.goalId]);
    expect(conversions.rows).toEqual([{ metric_key: `${goal.goalId}:${goal.versionId}`, event_count: 1,
      goal_id: goal.goalId, goal_version_id: goal.versionId }]);
  });

  it("persists bounded single-dimension groupings and applies report-wide and complementary suppression", async () => {
    const groups = [
      { country: "EG", count: 2, locale: "en" as const },
      { country: "CA", count: 5, locale: "en" as const },
      { country: "US", count: 6, locale: "ar" as const },
    ];
    for (const group of groups) for (let index = 0; index < group.count; index++) {
      await addEvent({ subject: id("MeasurementVisitor"), action: "page-viewed", occurredAt: "2026-10-07T10:00:00Z",
        countryCode: group.country, locale: group.locale, deviceClass: "mobile", referrerClass: "search" });
    }
    await aggregate("2026-10-07");
    const summary = await createServices().reportService.getAggregateReport({ scope: { kind: "portfolio", portfolioId },
      correlationId: "aggregate-privacy-summary", actor: { kind: "owner", ownerId, sessionId: "owner-session" },
      grouping: "daily-action", action: "page-viewed", startDate: "2026-10-07", endDate: "2026-10-07" });
    expect(summary).toMatchObject({ ok: true, value: { state: "low-sample", observedSubjects: "not-disclosed" } });
    const country = await createServices().reportService.getAggregateReport({ scope: { kind: "portfolio", portfolioId },
      correlationId: "aggregate-privacy-country", actor: { kind: "owner", ownerId, sessionId: "owner-session" },
      grouping: "daily-action", breakdown: "country", action: "page-viewed", startDate: "2026-10-07", endDate: "2026-10-07" });
    expect(country).toMatchObject({ ok: true, value: { state: "available", sampleState: "low-sample", rows: [
      { count: 6, dimensions: { countryCode: "US" } },
    ] } });
    expect(JSON.stringify(country)).not.toContain("EG");
    expect(JSON.stringify(country)).not.toContain("CA");
    expect(await createServices().reportService.getAggregateReport({ scope: { kind: "portfolio", portfolioId },
      correlationId: "aggregate-privacy-country-replay", actor: { kind: "owner", ownerId, sessionId: "owner-session" },
      grouping: "daily-action", breakdown: "country", action: "page-viewed", startDate: "2026-10-07", endDate: "2026-10-07" })).toEqual(country);
    const locale = await createServices().reportService.getAggregateReport({ scope: { kind: "portfolio", portfolioId },
      correlationId: "aggregate-privacy-locale", actor: { kind: "owner", ownerId, sessionId: "owner-session" },
      grouping: "daily-action", breakdown: "locale", action: "page-viewed", startDate: "2026-10-07", endDate: "2026-10-07" });
    expect(locale).toMatchObject({ ok: true, value: { state: "available", sampleState: "sufficient", rows: [
      { count: 6, dimensions: { locale: "ar" } }, { count: 7, dimensions: { locale: "en" } },
    ] } });
    const stored = await admin!.query(`select dimensions,event_count::int,observed_subjects::int from measurement.daily_aggregates
      where portfolio_id=$1 and utc_day='2026-10-07' and metric_kind='action' and metric_key='page-viewed' order by dimensions`, [portfolioId]);
    expect(stored.rows).toContainEqual({ dimensions: {}, event_count: 13, observed_subjects: 13 });
    expect(stored.rows).toContainEqual({ dimensions: { countryCode: "EG" }, event_count: 2, observed_subjects: 2 });
    expect(stored.rows).toContainEqual({ dimensions: { locale: "en" }, event_count: 7, observed_subjects: 7 });
    await admin!.query("set enable_seqscan=off");
    const groupedPlan = await admin!.query(`explain (format json) select metric_key from measurement.daily_aggregates
      where portfolio_id=$1 and utc_day between '2026-10-07' and '2026-10-07' and metric_kind='action'
        and dimensions ? 'countryCode'`, [portfolioId]);
    expect(JSON.stringify(groupedPlan.rows)).toContain("daily_aggregates_report_range");
    await admin!.query("reset enable_seqscan");
    const beforeReplay = await admin!.query(`select dimensions,event_count::int,observed_subjects::int from measurement.daily_aggregates
      where portfolio_id=$1 and utc_day='2026-10-07' and metric_kind='action' and metric_key='page-viewed' order by dimensions`, [portfolioId]);
    await aggregate("2026-10-07");
    const afterReplay = await admin!.query(`select dimensions,event_count::int,observed_subjects::int from measurement.daily_aggregates
      where portfolio_id=$1 and utc_day='2026-10-07' and metric_kind='action' and metric_key='page-viewed' order by dimensions`, [portfolioId]);
    expect(afterReplay.rows).toEqual(beforeReplay.rows);
  });

  it("keeps retained legacy summaries readable while old dimension breakdowns remain incomplete", async () => {
    await admin!.query(`insert into measurement.daily_aggregates
      (portfolio_id,utc_day,metric_kind,metric_key,dimensions,event_count,observed_subjects,policy_version,checkpoint_at,incomplete)
      values ($1,'2026-10-06','action','page-viewed','{}'::jsonb,9,6,'phase7.daily.v1','2026-10-07T00:00:00Z',false)`, [portfolioId]);
    await admin!.query(`insert into measurement.daily_aggregate_checkpoints
      (portfolio_id,utc_day,source_event_count,source_conversion_count,policy_version,checkpoint_at,incomplete)
      values ($1,'2026-10-06',9,0,'phase7.daily.v1','2026-10-07T00:00:00Z',false)`, [portfolioId]);
    const summary = await report({ startDate: "2026-10-06", endDate: "2026-10-06", grouping: "daily-action", action: "page-viewed" });
    expect(summary).toMatchObject({ ok: true, value: { state: "available", rows: [{ count: 9, action: "page-viewed" }] } });
    const country = await report({ startDate: "2026-10-06", endDate: "2026-10-06", grouping: "daily-action", action: "page-viewed", breakdown: "country" });
    expect(country).toMatchObject({ ok: true, value: { state: "incomplete", incomplete: true, observedSubjects: "not-disclosed" } });
  });

  it("distinguishes empty, four-subject Low-sample, and five-subject eligible cohorts despite repeated events", async () => {
    await aggregate("2026-10-10");
    expect(await report({ startDate: "2026-10-10", endDate: "2026-10-10", grouping: "daily-action" }))
      .toMatchObject({ ok: true, value: { state: "no-data", observedSubjects: "zero", incomplete: false } });
    const four = Array.from({ length: 4 }, () => id("MeasurementVisitor"));
    const five = Array.from({ length: 5 }, () => id("MeasurementVisitor"));
    for (const subject of four) for (let n = 0; n < 12; n++) await addEvent({ subject, action: "project-viewed", occurredAt: `2026-10-09T10:00:${String(n).padStart(2, "0")}Z` });
    for (const subject of five) await addEvent({ subject, action: "project-viewed", occurredAt: "2026-10-08T11:00:00Z" });
    await aggregate("2026-10-08"); await aggregate("2026-10-09");
    expect(await report({ startDate: "2026-10-08", endDate: "2026-10-08", grouping: "daily-action", action: "project-viewed" }))
      .toMatchObject({ ok: true, value: { state: "available", rows: [{ count: 5 }] } });
    expect(await report({ startDate: "2026-10-09", endDate: "2026-10-09", grouping: "daily-action" }))
      .toMatchObject({ ok: true, value: { state: "low-sample", observedSubjects: "fewer-than-five" } });
  });

  it("rolls back failed day replacement and enforces isolated application and worker access", async () => {
    const before = await admin!.query(`select utc_day::text,metric_key,event_count::text from measurement.daily_aggregates
      where portfolio_id=$1 and utc_day='2026-10-12' order by metric_key`, [portfolioId]);
    const base = createPostgresDailyAggregateRepository();
    const failing: DailyAggregateRepositoryPort = { ...base, async rebuildDay(input, tx) {
      await base.rebuildDay(input, tx);
      throw new Error("injected aggregation failure");
    } };
    const failedService = createDailyAggregateWorkService({ portfolioId, transactions: worker!.transactions, repository: failing });
    expect(await failedService.aggregateDay(command("2026-10-12"))).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable" } });
    const after = await admin!.query(`select utc_day::text,metric_key,event_count::text from measurement.daily_aggregates
      where portfolio_id=$1 and utc_day='2026-10-12' order by metric_key`, [portfolioId]);
    expect(after.rows).toEqual(before.rows);

    for (const role of ["anon", "authenticated", "shipwithali_backup"]) {
      expect((await admin!.query("select has_table_privilege($1,'measurement.daily_aggregates','SELECT') as allowed", [role])).rows[0]?.allowed).toBe(role === "shipwithali_backup");
      expect((await admin!.query("select has_table_privilege($1,'measurement.daily_aggregates','INSERT') as allowed", [role])).rows[0]?.allowed).toBe(false);
    }
    expect((await admin!.query("select has_table_privilege('shipwithali_application','measurement.daily_aggregates','INSERT') as allowed")).rows[0]?.allowed)
      .toBe(false);
    expect((await admin!.query("select has_table_privilege('shipwithali_worker','measurement.daily_aggregates','INSERT') as allowed")).rows[0]?.allowed)
      .toBe(true);
    await admin!.query("set enable_seqscan=off");
    const eventPlan = await admin!.query(`explain (format json) select event_id from measurement.public_events
      where portfolio_id=$1 and effective_at >= '2026-10-12T00:00:00Z' and effective_at < '2026-10-13T00:00:00Z'
        and accepted_at >= '2026-10-01T00:00:00Z' and accepted_at <= $2`, [portfolioId, now]);
    const reportPlan = await admin!.query(`explain (format json) select metric_key from measurement.daily_aggregates
      where portfolio_id=$1 and utc_day between '2026-10-12' and '2026-10-12' and metric_kind='action'`, [portfolioId]);
    expect(JSON.stringify(eventPlan.rows)).toContain("public_events_daily_aggregate_order");
    expect(JSON.stringify(reportPlan.rows)).toContain("daily_aggregates_report_range");
    await admin!.query("reset enable_seqscan");
    await admin!.query("set role shipwithali_application");
    await expect(admin!.query("select measurement_subject from measurement.public_events limit 1")).rejects.toMatchObject({ code: "42501" });
    await admin!.query("reset role");
  });

  it("exposes safe aggregate reports through the standard application composition without an HTTP route", async () => {
    if (!DATABASE_URL) throw new Error("PHASE7_AGGREGATE_DATABASE_REQUIRED");
    resetRuntimeForTests();
    try {
      await initializeDatabaseRuntime({ NODE_ENV: "test", APP_BASE_URL: "https://example.com", DATABASE_URL,
        PORTFOLIO_ID: portfolioId, OWNER_ID: ownerId }, "application");
      const result = await getOwnerAggregateReportApplicationService().getAggregateReport({
        scope: { kind: "portfolio", portfolioId }, correlationId: "daily-report-standard-assembly",
        actor: { kind: "owner", ownerId, sessionId: "verified-owner-session" }, grouping: "daily-action",
        startDate: "2026-10-14", endDate: "2026-10-14", action: "project-viewed",
      });
      expect(result).toMatchObject({ ok: true, value: { state: "available", rows: [{ count: 6, action: "project-viewed" }] } });
    } finally {
      await getLifecycleCoordinator().shutdown();
      resetRuntimeForTests();
    }
  });
});
