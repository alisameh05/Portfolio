import { describe, expect, it, vi } from "vitest";
import { createStableId } from "../../src/shared/domain/index.js";
import { isTransactionRollback, type TransactionContext, type TransactionRunner, type TransactionRollback } from "../../src/runtime/ports.js";
import { createDailyAggregateWorkService, createOwnerAggregateReportService, type DailyAggregateRepositoryPort } from "../../src/modules/measurement/index.js";
import type { MeasurementWorkCommand } from "../../src/modules/measurement/application/work.js";
import type { GetAggregateReportQuery } from "../../src/modules/measurement/application/service.js";
import type { DailyAggregateReportRecord } from "../../src/modules/measurement/ports/daily-aggregates.js";

const portfolioId = createStableId("Portfolio");
const ownerId = createStableId("Owner");
const jobId = createStableId("Job");
const goalId = createStableId("AnalyticsGoal");
const versionId = createStableId("AnalyticsGoalVersion");
const now = "2026-10-15T12:00:00.000Z";

function actionRow(observedSubjects: number, overrides: Partial<DailyAggregateReportRecord> = {}): DailyAggregateReportRecord {
  return { date: "2026-10-14", metric: "action", metricKey: "project-viewed", dimensions: {}, count: 80, sum: 0,
    observedSubjects, returningSubjects: Math.min(3, observedSubjects), policyVersion: "phase7.daily.v2", asOf: now,
    incomplete: false, ...overrides };
}

function goalRow(observedSubjects: number): DailyAggregateReportRecord {
  return { date: "2026-10-14", metric: "goal", metricKey: `${goalId}:${versionId}`, dimensions: {}, goalId, goalVersionId: versionId,
    definitionSnapshot: { name: "Project journey", steps: [{ action: "project-viewed" }, { action: "contact-channel-opened" }] },
    count: 8, sum: 0, observedSubjects, returningSubjects: Math.min(2, observedSubjects), policyVersion: "phase7.daily.v2",
    asOf: now, incomplete: false };
}

function harness(rows: readonly DailyAggregateReportRecord[] = [], incomplete = false) {
  const repository: DailyAggregateRepositoryPort = {
    rebuildDay: vi.fn(async () => 2),
    readReport: vi.fn(async () => ({ rows, asOf: now, incomplete })),
  };
  const transactions: Pick<TransactionRunner, "run"> = { run: async <T>(callback: (tx: TransactionContext) => Promise<T | TransactionRollback<T>> | T | TransactionRollback<T>) => {
    const result = await callback({ kind: "transaction" });
    return isTransactionRollback(result) ? result.value : result;
  } };
  const service = createOwnerAggregateReportService({
    scope: { portfolioId, ownerId }, transactions, repository, clock: { now: () => now },
    authorize: vi.fn(async () => ({ ok: true as const, value: true })),
  });
  return { repository, transactions, service };
}

function reportQuery(overrides: Partial<GetAggregateReportQuery> = {}): GetAggregateReportQuery {
  return { scope: { kind: "portfolio", portfolioId }, correlationId: "daily-report-test",
    actor: { kind: "owner", ownerId, sessionId: "session" }, grouping: "daily-action",
    startDate: "2026-10-14", endDate: "2026-10-14", ...overrides };
}

function workCommand(overrides: Partial<MeasurementWorkCommand & { readonly utcDay: string }> = {}): MeasurementWorkCommand & { readonly utcDay: string } {
  return { scope: { kind: "portfolio", portfolioId }, correlationId: "daily-work-test", actor: { kind: "system", jobId, purpose: "measurement.aggregate" },
    batchSize: 25, now, utcDay: "2026-10-14", ...overrides };
}

describe("daily aggregates and safe Owner reporting", () => {
  it("replaces one UTC day through a bounded worker command and rejects other purposes or old data", async () => {
    const { repository, transactions } = harness();
    const worker = createDailyAggregateWorkService({ portfolioId, transactions, repository });
    expect(await worker.aggregateDay(workCommand())).toEqual({ ok: true, value: { processedCount: 2, nextCursor: null, incomplete: false } });
    expect(repository.rebuildDay).toHaveBeenCalledWith({ portfolioId, utcDay: "2026-10-14", asOf: now }, expect.anything());
    expect(await worker.aggregateDay(workCommand({ actor: { kind: "system", jobId, purpose: "measurement.retention" } })))
      .toMatchObject({ ok: false, error: { kind: "validation", code: "DAILY_AGGREGATE_COMMAND_INVALID" } });
    expect(await worker.aggregateDay(workCommand({ utcDay: "2026-09-01" }))).toMatchObject({ ok: false, error: { kind: "validation" } });
  });

  it("reports no-data and marks missing aggregation coverage", async () => {
    const { service } = harness([], true);
    expect(await service.getAggregateReport(reportQuery())).toEqual({ ok: true, value: {
      utcPeriod: { startDay: "2026-10-14", endDay: "2026-10-14" }, asOf: now, incomplete: true,
      policyVersion: "phase7.daily.v2", grouping: "daily-action", breakdown: "summary", state: "incomplete", observedSubjects: "not-disclosed",
      sourceHorizon: "accepted-events-within-14-days-of-as-of",
    } });
  });

  it("suppresses all report rows when the canonical cohort has fewer than five subjects", async () => {
    const { service } = harness([actionRow(1, { count: 900 }), actionRow(8, { metricKey: "page-viewed" })]);
    const result = await service.getAggregateReport(reportQuery());
    expect(result).toMatchObject({ ok: true, value: { state: "low-sample", observedSubjects: "fewer-than-five" } });
    if (result.ok) expect("rows" in result.value).toBe(false);
  });

  it("returns only safe daily action facts with approximate and non-causal labels for eligible cohorts", async () => {
    const { service } = harness([actionRow(5, { count: 12, sum: 25_000 })]);
    const result = await service.getAggregateReport(reportQuery());
    expect(result).toMatchObject({ ok: true, value: { state: "available", observedSubjects: "five-or-more",
      engagementMeaning: "approximate-active-attention", journeyMeaning: "context-without-causation",
      sourceHorizon: "accepted-events-within-14-days-of-as-of",
      sampleState: "sufficient", rows: [{ utcDay: "2026-10-14", count: 12, sum: 25_000, metric: "action", action: "project-viewed", dimensions: {} }] } });
    expect(JSON.stringify(result)).not.toContain("measurementSubject");
    expect(JSON.stringify(result)).not.toContain("functionalId");
  });

  it("includes immutable goal and version meaning without exposing subjects", async () => {
    const { service } = harness([goalRow(5)]);
    const result = await service.getAggregateReport(reportQuery({ grouping: "daily-goal" }));
    expect(result).toMatchObject({ ok: true, value: { state: "available", rows: [{ metric: "goal", goalId, goalVersionId: versionId,
      definitionSnapshot: { name: "Project journey" } }] } });
    expect(JSON.stringify(result)).not.toContain("measurementSubject");
  });

  it("fails closed for unauthorized scope, unknown Owner, and report ranges above 31 days", async () => {
    const denied = harness();
    const unauthorized = createOwnerAggregateReportService({
      scope: { portfolioId, ownerId }, transactions: denied.transactions, repository: denied.repository, clock: { now: () => now },
      authorize: async () => ({ ok: true, value: false }),
    });
    expect(await unauthorized.getAggregateReport(reportQuery())).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(await denied.service.getAggregateReport(reportQuery({ scope: { kind: "portfolio", portfolioId: createStableId("Portfolio") } })))
      .toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(await denied.service.getAggregateReport(reportQuery({ startDate: "2026-09-01" })))
      .toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(await denied.service.getAggregateReport(reportQuery({ breakdown: "country+device" as never })))
      .toMatchObject({ ok: false, error: { kind: "validation" } });
  });

  it.each([
    ["locale", { locale: "en" }], ["country", { countryCode: "EG" }], ["device", { deviceClass: "mobile" }],
    ["referrer", { referrerClass: "search" }], ["project", { projectId: createStableId("Project") }],
    ["route", { publicRouteId: createStableId("PublicRoute") }],
  ] as const)("uses distinct-subject zero/four/five thresholds for the fixed %s breakdown", async (breakdown, dimensions) => {
    expect(await harness().service.getAggregateReport(reportQuery({ breakdown })))
      .toMatchObject({ ok: true, value: { state: "no-data", observedSubjects: "zero", breakdown } });
    const small = await harness([actionRow(4, { dimensions, count: 900 })]).service.getAggregateReport(reportQuery({ breakdown }));
    expect(small).toMatchObject({ ok: true, value: { state: "low-sample", observedSubjects: "not-disclosed" } });
    if (small.ok) expect("rows" in small.value).toBe(false);
    const eligible = await harness([actionRow(5, { dimensions, count: 6 })]).service.getAggregateReport(reportQuery({ breakdown }));
    expect(eligible).toMatchObject({ ok: true, value: { state: "available", sampleState: "sufficient", rows: [{ count: 6, dimensions }] } });
  });

  it("withholds small cells and deterministic complementary cells from additive breakdown queries", async () => {
    const rows = [
      actionRow(2, { dimensions: { countryCode: "EG" }, metricKey: "page-viewed", count: 100 }),
      actionRow(7, { dimensions: { countryCode: "CA" }, metricKey: "page-viewed", count: 700 }),
      actionRow(8, { dimensions: { countryCode: "US" }, metricKey: "page-viewed", count: 800 }),
      actionRow(9, { dimensions: { countryCode: "GB" }, metricKey: "page-viewed", count: 900 }),
    ];
    const result = await harness(rows).service.getAggregateReport(reportQuery({ breakdown: "country" }));
    expect(result).toMatchObject({ ok: true, value: { state: "available", sampleState: "low-sample", rows: [
      { dimensions: { countryCode: "GB" }, count: 900 }, { dimensions: { countryCode: "US" }, count: 800 },
    ] } });
    expect(JSON.stringify(result)).not.toContain('"countryCode":"EG"');
    expect(JSON.stringify(result)).not.toContain('"countryCode":"CA"');
  });

  it("withholds aggregate summaries for any metric/day with a small dimension cell", async () => {
    const { service, repository } = harness([actionRow(20, { hasSmallDimensionCell: true })]);
    const result = await service.getAggregateReport(reportQuery());
    expect(result).toMatchObject({ ok: true, value: { state: "low-sample", observedSubjects: "not-disclosed" } });
    expect(repository.readReport).toHaveBeenCalledWith(expect.objectContaining({ breakdown: "summary" }), expect.anything());
  });

  it("keeps high event volume from one subject in the low-sample state", async () => {
    const result = await harness([actionRow(1, { dimensions: { locale: "ar" }, count: 12_000 })])
      .service.getAggregateReport(reportQuery({ breakdown: "locale" }));
    expect(result).toMatchObject({ ok: true, value: { state: "low-sample", observedSubjects: "not-disclosed" } });
  });

  it("marks reports over the bounded row limit incomplete", async () => {
    const rows = Array.from({ length: 501 }, (_, index) => actionRow(5, {
      date: new Date(Date.parse("2026-10-14T00:00:00.000Z") - index * 86_400_000).toISOString().slice(0, 10),
      metricKey: `action-${index}`,
    }));
    const result = await harness(rows).service.getAggregateReport(reportQuery());
    expect(result).toMatchObject({ ok: true, value: { state: "incomplete", incomplete: true, observedSubjects: "not-disclosed" } });
    if (result.ok) expect("rows" in result.value).toBe(false);
  });
});
