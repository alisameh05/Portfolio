import { describe, expect, it } from "vitest";
import { validateOwnerExportZip } from "../../scripts/owner-export/validator.mjs";
import { measurementAggregateExpiryAt } from "../../src/modules/measurement/application/retention.js";
import { createOwnerAnalyticsExportSnapshotService } from "../../src/modules/measurement/application/owner-analytics-export.js";
import { buildAnalyticsOwnerExportPackage, type OwnerExportSelectedSnapshot } from "../../src/modules/portability-operations/application/owner-export-package.js";
import type { AnalyticsGoalRootRecord, AnalyticsGoalVersionRecord, AnalyticsGoalActivationRecord } from "../../src/modules/measurement/ports/repository.js";
import type { DailyAggregatePage, DailyAggregateReportRecord } from "../../src/modules/measurement/ports/daily-aggregates.js";
import type { StableId } from "@shared/domain";

const id = <T extends string>(tail: string): StableId<T> => `01890f3e-7b2f-7cc0-98cf-5a2890378${tail}` as StableId<T>;
const portfolioId = id<"Portfolio">("101");
const ownerId = id<"Owner">("102");
const goalId = id<"AnalyticsGoal">("103");
const versionA = id<"AnalyticsGoalVersion">("104");
const versionB = id<"AnalyticsGoalVersion">("105");
const projectId = id<"Project">("106");
const routeId = id<"PublicRoute">("107");
const capturedAt = "2026-10-25T00:00:00.000Z";
const transaction = { kind: "transaction" as const };
const definition = { name: "Qualified conversion", steps: [{ action: "project-viewed" as const, projectIds: [projectId], publicRouteIds: [routeId] }] };

const roots: readonly AnalyticsGoalRootRecord[] = [{ goalId, aggregateVersion: 5, activeVersionId: versionA }];
const versions: readonly AnalyticsGoalVersionRecord[] = [
  { versionId: versionB, versionNumber: 1, definition, createdAt: "2026-10-01T00:00:00.000Z" },
  { versionId: versionA, versionNumber: 2, definition, createdAt: "2026-10-02T00:00:00.000Z" },
];
const activations: readonly AnalyticsGoalActivationRecord[] = [
  { versionId: versionA, activatedAt: "2026-10-03T00:00:00.000Z", activationSequence: 1 },
  { versionId: versionB, activatedAt: "2026-10-03T00:00:00.000Z", activationSequence: 2 },
  { versionId: versionA, activatedAt: "2026-10-04T00:00:00.000Z", activationSequence: 3 },
];

function aggregateRow(input: {
  readonly startDay: string;
  readonly goalId: StableId<"AnalyticsGoal">;
  readonly versionId: StableId<"AnalyticsGoalVersion">;
  readonly observedSubjects?: number;
  readonly count?: number;
  readonly hasSmallDimensionCell?: boolean;
  readonly locale?: "en" | "ar";
}): DailyAggregateReportRecord {
  return {
    date: input.startDay,
    metric: "goal",
    metricKey: "goal-conversion",
    goalId: input.goalId,
    goalVersionId: input.versionId,
    count: input.count ?? 0,
    sum: 0,
    dimensions: { locale: input.locale ?? "en" },
    observedSubjects: input.observedSubjects ?? 5,
    returningSubjects: 0,
    policyVersion: "phase7.daily.v2",
    asOf: capturedAt,
    incomplete: false,
    definitionSnapshot: definition,
    hasSmallDimensionCell: input.hasSmallDimensionCell ?? false,
  };
}

function createService(readReport: (input: { startDay: string; endDay: string; goalId?: StableId<"AnalyticsGoal">; goalVersionId?: StableId<"AnalyticsGoalVersion">; limit: number }) => DailyAggregatePage) {
  return createOwnerAnalyticsExportSnapshotService({
    goals: {
      async listGoals() { return roots; },
      async listVersions() { return versions; },
      async listActivations() { return activations; },
      async getGoal() { return null; },
      async lockGoal() {},
      async insertGoal() {},
      async appendVersion() {},
      async activateVersion() { return 0; },
    },
    aggregates: { async readReport(input) { return readReport(input); } },
  });
}

async function collect(content: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of content) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

describe("Analytics Owner export", () => {
  it("keeps activation sequence and exports complete retained windows no longer than 31 days", async () => {
    const queries: { startDay: string; endDay: string; limit: number }[] = [];
    const service = createService((query) => {
      queries.push({ startDay: query.startDay, endDay: query.endDay, limit: query.limit });
      return { rows: [], asOf: capturedAt, incomplete: false };
    });
    const result = await service.readOwnerAnalyticsExportSnapshot({ portfolioId, ownerId, capturedAt, transaction });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const record = result.value.records[0]!;
    const value = record.value as { goal: { activationHistory: readonly { versionId: string; activationSequence: number }[]; versions: readonly unknown[] }; reports: readonly { periodStartDay: string; periodEndDay: string; sampleState: string }[] };
    expect(value.goal.versions).toHaveLength(2);
    expect(value.goal.activationHistory.map((activation) => activation.activationSequence)).toEqual([1, 2, 3]);
    expect(value.goal.activationHistory.map((activation) => activation.versionId)).toEqual([versionA, versionB, versionA]);
    expect(value.reports.length).toBeGreaterThan(10);
    expect(value.reports.every((report) => report.sampleState === "no-data")).toBe(true);
    expect(queries.every((query) => query.limit === 500 &&
      (Date.parse(`${query.endDay}T00:00:00Z`) - Date.parse(`${query.startDay}T00:00:00Z`)) / 86_400_000 < 31)).toBe(true);
    const earliestDay = value.reports[0]!.periodStartDay;
    expect(Date.parse(measurementAggregateExpiryAt(earliestDay))).toBeGreaterThan(Date.parse(capturedAt));
    expect(measurementAggregateExpiryAt(new Date(Date.parse(`${earliestDay}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10))).toBe(capturedAt);
    expect(result.value.policyExpiresAt).toBe(measurementAggregateExpiryAt(earliestDay));
  });

  it("applies five-subject complementary locale suppression and withholds counts without inventing zero", async () => {
    let call = 0;
    const service = createService((query) => {
      const current = call++;
      if (current === 0) return { rows: [aggregateRow({ startDay: query.startDay, goalId, versionId: versionB, observedSubjects: 4, count: 11 })], asOf: capturedAt, incomplete: false };
      if (current === 1) return { rows: [
        aggregateRow({ startDay: query.startDay, goalId, versionId: versionB, observedSubjects: 2, count: 13, locale: "ar" }),
        aggregateRow({ startDay: query.startDay, goalId, versionId: versionB, count: 130, locale: "en" }),
      ], asOf: capturedAt, incomplete: false };
      if (current === 2) return { rows: [], asOf: capturedAt, incomplete: true };
      if (current === 3) return { rows: [aggregateRow({ startDay: query.startDay, goalId, versionId: versionB, count: 3 })], asOf: capturedAt, incomplete: false };
      return { rows: [], asOf: capturedAt, incomplete: false };
    });
    const result = await service.readOwnerAnalyticsExportSnapshot({ portfolioId, ownerId, capturedAt, transaction });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reports = (result.value.records[0]!.value as { reports: readonly Record<string, unknown>[] }).reports;
    expect(reports.slice(0, 4).map((report) => report["sampleState"])).toEqual(["low-sample", "low-sample", "incomplete", "sufficient"]);
    expect(reports.slice(0, 3).every((report) => report["cells"] === undefined)).toBe(true);
    expect(reports[3]).toMatchObject({ countDisposition: "included", breakdown: "locale", cells: [{ locale: "en", aggregateCount: 3 }] });
    expect(Object.hasOwn(reports[3]!, "aggregateCount")).toBe(false);
    expect(reports.slice(4).every((report) => !Object.hasOwn(report, "aggregateCount"))).toBe(true);
  });

  it("exports only safe locale cells when complementary suppression affects another day", async () => {
    let call = 0;
    const service = createService((query) => {
      if (call++ === 0) return { rows: [
        aggregateRow({ startDay: query.startDay, goalId, versionId: versionB, observedSubjects: 2, count: 2, locale: "ar" }),
        aggregateRow({ startDay: query.startDay, goalId, versionId: versionB, count: 9, locale: "en" }),
        aggregateRow({ startDay: new Date(Date.parse(`${query.startDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10), goalId, versionId: versionB, count: 11, locale: "en" }),
      ], asOf: capturedAt, incomplete: false };
      return { rows: [], asOf: capturedAt, incomplete: false };
    });
    const result = await service.readOwnerAnalyticsExportSnapshot({ portfolioId, ownerId, capturedAt, transaction });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reports = (result.value.records[0]!.value as { reports: readonly Record<string, unknown>[] }).reports;
    expect(reports[0]).toMatchObject({ sampleState: "low-sample", countDisposition: "partially-withheld", cells: [{ locale: "en", aggregateCount: 11 }] });
    expect(reports[0]?.["cells"]).not.toContainEqual(expect.objectContaining({ aggregateCount: 9 }));
    expect(Object.hasOwn(reports[0]!, "aggregateCount")).toBe(false);
  });

  it("withholds a report page that reaches the 500-row query limit", async () => {
    let observedLimit = 0;
    let page = 0;
    const service = createService((query) => {
      observedLimit = query.limit;
      if (page++ > 0) return { rows: [], asOf: capturedAt, incomplete: false };
      return { rows: Array.from({ length: 500 }, () => aggregateRow({
        startDay: query.startDay, goalId, versionId: versionB, count: 1,
      })), asOf: capturedAt, incomplete: false };
    });
    const result = await service.readOwnerAnalyticsExportSnapshot({ portfolioId, ownerId, capturedAt, transaction });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reports = (result.value.records[0]!.value as { reports: readonly Record<string, unknown>[] }).reports;
    expect(observedLimit).toBe(500);
    expect(reports[0]).toMatchObject({ sampleState: "incomplete", completeness: "incomplete", countDisposition: "withheld" });
    expect(Object.hasOwn(reports[0]!, "cells")).toBe(false);
  });

  it("builds an independently validated Analytics-only archive and leaves legacy schema 1.1 unchanged", async () => {
    const service = createService((query) => ({ rows: [], asOf: capturedAt, incomplete: false }));
    const captured = await service.readOwnerAnalyticsExportSnapshot({ portfolioId, ownerId, capturedAt, transaction });
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const snapshot: OwnerExportSelectedSnapshot = {
      kind: "owner-export-snapshot-v1",
      snapshotId: id<"OwnerExportArtifact">("108"),
      capturedAt,
      includedScopes: ["analytics-reports"],
      analytics: { records: captured.value.records },
      policyExpiresAt: captured.value.policyExpiresAt,
    };
    const built = await buildAnalyticsOwnerExportPackage({ exportId: id<"OwnerExport">("109"), snapshot });
    const archive = await collect(built.content);
    const validated = validateOwnerExportZip(archive);
    expect(validated.manifest.schemaVersion).toBe("1.8");
    expect(validated.includedScopes).toEqual(["analytics-reports"]);
    expect(validated.recordCounts["analytics-reports"]).toBe(1);
    expect(validated.verifiedSchemaCount).toBe(2);
    expect(validated.dependencyCount).toBe(2);
    expect(archive.includes(Buffer.from("analytics-visitor-marker"))).toBe(false);
    expect(archive.includes(Buffer.from("provider-session-secret"))).toBe(false);
    const analyticsValue = captured.value.records[0]!.value as { goal: Readonly<Record<string, unknown>>; reports: readonly Record<string, unknown>[] };
    const malformed = {
      ...analyticsValue,
      reports: analyticsValue.reports.map((report) => ({ ...report, aggregateCount: 0 })),
    };
    await expect(buildAnalyticsOwnerExportPackage({ exportId: id<"OwnerExport">("110"), snapshot: {
      ...snapshot, analytics: { records: [{ goalId, value: malformed }] },
    } })).rejects.toThrow("OWNER_EXPORT_ANALYTICS_RECORD_INVALID");
  });

  it("represents an empty Analytics selection as a zero-record scope", async () => {
    const service = createOwnerAnalyticsExportSnapshotService({
      goals: {
        async listGoals() { return []; },
        async listVersions() { return []; },
        async listActivations() { return []; },
        async getGoal() { return null; },
        async lockGoal() {},
        async insertGoal() {},
        async appendVersion() {},
        async activateVersion() { return 0; },
      },
      aggregates: { async readReport() { throw new Error("must not query reports without goals"); } },
    });
    const captured = await service.readOwnerAnalyticsExportSnapshot({ portfolioId, ownerId, capturedAt, transaction });
    expect(captured).toMatchObject({ ok: true, value: { records: [] } });
  });
});
