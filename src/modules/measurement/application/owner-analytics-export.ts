import { err, ok, type Rejection, type Result, type StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import type { DailyAggregateRepositoryPort } from "../ports/daily-aggregates.js";
import type { DailyAggregateReportRecord } from "../ports/daily-aggregates.js";
import type { OwnerAnalyticsGoalRepositoryPort } from "../ports/repository.js";
import { suppressDailyAggregateBreakdown } from "./daily-aggregates.js";
import { measurementAggregateExpiryAt } from "./retention.js";

const REPORT_WINDOW_DAYS = 31;
const REPORT_ROW_LIMIT = 500;
const MINIMUM_OBSERVED_SUBJECTS = 5;
const SOURCE_HORIZON = "accepted-events-within-14-days-of-as-of" as const;
const EXPORT_BREAKDOWN = "locale" as const;
const unavailable = () => err<Rejection>({ kind: "temporarily_unavailable", code: "ANALYTICS_EXPORT_UNAVAILABLE" });

export interface OwnerAnalyticsExportSnapshot {
  readonly capturedAt: string;
  readonly policyExpiresAt: string;
  readonly records: readonly { readonly goalId: string; readonly value: Readonly<Record<string, unknown>> }[];
}

export interface OwnerAnalyticsExportSnapshotReaderPort {
  readOwnerAnalyticsExportSnapshot(input: {
    readonly portfolioId: StableId<"Portfolio">;
    readonly ownerId: StableId<"Owner">;
    readonly transaction: TransactionContext;
  }): Promise<Result<OwnerAnalyticsExportSnapshot, Rejection>>;
}

export interface OwnerAnalyticsExportServiceDependencies {
  readonly goals: OwnerAnalyticsGoalRepositoryPort;
  readonly aggregates: Pick<DailyAggregateRepositoryPort, "readReport">;
}

function validInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function addDays(day: string, amount: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + amount * 86_400_000).toISOString().slice(0, 10);
}

function retainedStartDay(capturedAt: string): string {
  const captureTime = Date.parse(capturedAt);
  const captureDay = capturedAt.slice(0, 10);
  let day = captureDay;
  let previous = addDays(day, -1);
  for (let scanned = 0; scanned < 400 && measurementAggregateExpiryAt(previous) > new Date(captureTime).toISOString(); scanned += 1) {
    day = previous;
    previous = addDays(day, -1);
  }
  return day;
}

function reportForWindow(input: {
  readonly goalId: StableId<"AnalyticsGoal">;
  readonly versionId: StableId<"AnalyticsGoalVersion">;
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
  readonly startDay: string;
  readonly endDay: string;
  readonly capturedAt: string;
  readonly transaction: TransactionContext;
  readonly aggregates: Pick<DailyAggregateRepositoryPort, "readReport">;
}): Promise<Readonly<Record<string, unknown>>> {
  return input.aggregates.readReport({
    portfolioId: input.portfolioId,
    ownerId: input.ownerId,
    startDay: input.startDay,
    endDay: input.endDay,
    grouping: "daily-goal",
    goalId: input.goalId,
    goalVersionId: input.versionId,
    breakdown: EXPORT_BREAKDOWN,
    limit: REPORT_ROW_LIMIT,
  }, input.transaction).then((page) => {
    const matching = page.rows.filter((row) => row.metric === "goal" && row.goalId === input.goalId && row.goalVersionId === input.versionId);
    if (matching.length !== page.rows.length || matching.length > REPORT_ROW_LIMIT) throw new Error("ANALYTICS_EXPORT_REPORT_SCOPE_INVALID");
    const pageAsOf = Date.parse(page.asOf);
    if (!Number.isFinite(pageAsOf) || pageAsOf > Date.parse(input.capturedAt)) throw new Error("ANALYTICS_EXPORT_REPORT_TIME_INVALID");
    const common = {
      goalVersionId: input.versionId,
      periodStartDay: input.startDay,
      periodEndDay: input.endDay,
      completeness: "complete" as const,
      asOf: page.asOf,
      policyVersion: "phase7.daily.v2",
      sourceHorizon: SOURCE_HORIZON,
      grouping: "daily-goal" as const,
      breakdown: EXPORT_BREAKDOWN,
    };
    if (page.incomplete || matching.length === REPORT_ROW_LIMIT || matching.some((row) => row.incomplete)) {
      return { ...common, sampleState: "incomplete", completeness: "incomplete", countDisposition: "withheld" };
    }
    if (matching.length === 0) {
      return { ...common, sampleState: "no-data", countDisposition: "not-applicable" };
    }
    const filtered = suppressDailyAggregateBreakdown(matching);
    const cells = filtered.rows.map((row: DailyAggregateReportRecord) => {
      if (row.observedSubjects < MINIMUM_OBSERVED_SUBJECTS || !Number.isSafeInteger(row.count) || row.count < 1 ||
          (row.dimensions as { locale?: unknown }).locale !== "en" && (row.dimensions as { locale?: unknown }).locale !== "ar") {
        throw new Error("ANALYTICS_EXPORT_CELL_INVALID");
      }
      return { utcDay: row.date, locale: (row.dimensions as { locale: "en" | "ar" }).locale, aggregateCount: row.count };
    });
    if (filtered.suppressedCells) {
      return cells.length > 0
        ? { ...common, sampleState: "low-sample", countDisposition: "partially-withheld", cells }
        : { ...common, sampleState: "low-sample", countDisposition: "withheld" };
    }
    if (cells.length === 0) throw new Error("ANALYTICS_EXPORT_CELL_INVALID");
    return { ...common, sampleState: "sufficient", countDisposition: "included", cells };
  });
}

export function createOwnerAnalyticsExportSnapshotService(deps: OwnerAnalyticsExportServiceDependencies): {
  readOwnerAnalyticsExportSnapshot(input: {
    readonly portfolioId: StableId<"Portfolio">;
    readonly ownerId: StableId<"Owner">;
    readonly capturedAt: string;
    readonly transaction: TransactionContext;
  }): Promise<Result<OwnerAnalyticsExportSnapshot, Rejection>>;
} {
  return {
    async readOwnerAnalyticsExportSnapshot(input) {
      if (!validInstant(input.capturedAt) || deps.goals.listGoals === undefined) return unavailable();
      const captureDay = input.capturedAt.slice(0, 10);
      if (!validDay(captureDay)) return unavailable();
      try {
        const roots = await deps.goals.listGoals(input.portfolioId, input.transaction);
        const startDay = retainedStartDay(input.capturedAt);
        const policyExpiresAt = measurementAggregateExpiryAt(startDay);
        const records: OwnerAnalyticsExportSnapshot["records"][number][] = [];
        for (const root of roots) {
          const [versions, activations] = await Promise.all([
            deps.goals.listVersions(root.goalId, input.portfolioId, input.transaction),
            deps.goals.listActivations(root.goalId, input.portfolioId, input.transaction),
          ]);
          if (versions.length === 0 || root.activeVersionId !== null && !versions.some((version) => version.versionId === root.activeVersionId)) {
            throw new Error("ANALYTICS_EXPORT_GOAL_HISTORY_INVALID");
          }
          const reports: Readonly<Record<string, unknown>>[] = [];
          for (const version of versions) {
            let periodStart = startDay;
            while (periodStart <= captureDay) {
              const periodEnd = addDays(periodStart, REPORT_WINDOW_DAYS - 1) > captureDay
                ? captureDay
                : addDays(periodStart, REPORT_WINDOW_DAYS - 1);
              reports.push(await reportForWindow({
                goalId: root.goalId,
                versionId: version.versionId,
                portfolioId: input.portfolioId,
                ownerId: input.ownerId,
                startDay: periodStart,
                endDay: periodEnd,
                capturedAt: input.capturedAt,
                transaction: input.transaction,
                aggregates: deps.aggregates,
              }));
              periodStart = addDays(periodEnd, 1);
            }
          }
          records.push({
            goalId: root.goalId,
            value: {
              goal: {
                goalId: root.goalId,
                aggregateVersion: root.aggregateVersion,
                activeVersionId: root.activeVersionId,
                versions: versions.map((version) => ({
                  versionId: version.versionId,
                  versionNumber: version.versionNumber,
                  definition: version.definition,
                  createdAt: version.createdAt,
                })),
                activationHistory: activations.map((activation) => ({
                  versionId: activation.versionId,
                  activatedAt: activation.activatedAt,
                  activationSequence: activation.activationSequence,
                })),
              },
              reports,
            },
          });
        }
        return ok({ capturedAt: input.capturedAt, policyExpiresAt, records });
      } catch {
        return unavailable();
      }
    },
  };
}
