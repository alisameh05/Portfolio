import { parseStableId, type ActorContext, type Rejection, type Result, type StableId } from "@shared/domain";
import type { BoundedWorkResult } from "@shared/application";
import type { Clock, TransactionRunner } from "../../../runtime/ports.js";
import type { AuthorizeOperationQuery } from "../../identity-access/index.js";
import type { MeasurementEventType } from "../domain/index.js";
import type { DailyAggregateRepositoryPort, DailyAggregateReportRecord } from "../ports/daily-aggregates.js";
import type { GetAggregateReportQuery, SafeAggregateReport } from "./service.js";
import type { MeasurementWorkCommand } from "./work.js";

const POLICY_VERSION = "phase7.daily.v2";
const REPORT_LIMIT = 500;
const MAX_REPORT_DAYS = 31;
const BREAKDOWNS = new Set(["summary", "locale", "country", "device", "referrer", "project", "route"]);
const ACTIONS = new Set<MeasurementEventType>([
  "page-viewed", "project-viewed", "active-engagement-sampled", "media-engaged", "related-project-opened",
  "contact-channel-opened", "external-project-link-opened", "testimonial-engaged", "global-project-cta-opened",
]);
const unavailable = () => ({ ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "ANALYTICS_REPORT_UNAVAILABLE" } });
const invalid = (code = "ANALYTICS_REPORT_QUERY_INVALID") => ({ ok: false as const, error: { kind: "validation" as const, code } });

function parseUtcDay(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value ? value : null;
}

function daysBetween(start: string, end: string): number {
  return Math.floor((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000) + 1;
}

export interface DailyAggregateWorkDependencies {
  readonly portfolioId: StableId<"Portfolio">;
  readonly transactions: Pick<TransactionRunner, "run">;
  readonly repository: DailyAggregateRepositoryPort;
}

function isValidWorkCommand(command: MeasurementWorkCommand & { readonly utcDay: string }, portfolioId: StableId<"Portfolio">): boolean {
  const now = Date.parse(command.now);
  const day = parseUtcDay(command.utcDay);
  if (!day || !Number.isFinite(now) || command.scope.kind !== "portfolio" || command.scope.portfolioId !== portfolioId ||
      command.actor.kind !== "system" || command.actor.purpose !== "measurement.aggregate" ||
      !parseStableId("Job", command.actor.jobId).ok || ![25, 50, 100].includes(command.batchSize) ||
      typeof command.correlationId !== "string" || command.correlationId.length < 1 || command.correlationId.length > 200) return false;
  const today = new Date(now).toISOString().slice(0, 10);
  const earliest = new Date(now - 15 * 86_400_000).toISOString().slice(0, 10);
  return day <= today && day >= earliest;
}

export function createDailyAggregateWorkService(deps: DailyAggregateWorkDependencies): {
  aggregateDay(command: MeasurementWorkCommand & { readonly utcDay: string }): Promise<Result<BoundedWorkResult, Rejection>>;
} {
  return {
    async aggregateDay(command) {
      if (!isValidWorkCommand(command, deps.portfolioId)) return invalid("DAILY_AGGREGATE_COMMAND_INVALID");
      try {
        const count = await deps.transactions.run(transaction => deps.repository.rebuildDay({
          portfolioId: deps.portfolioId, utcDay: command.utcDay, asOf: command.now,
        }, transaction));
        return { ok: true, value: { processedCount: count, nextCursor: null, incomplete: false } };
      } catch {
        return unavailable();
      }
    },
  };
}

export interface OwnerAggregateReportDependencies {
  readonly scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> };
  readonly authorize: (query: AuthorizeOperationQuery) => Promise<Result<boolean, Rejection>>;
  readonly transactions: Pick<TransactionRunner, "run">;
  readonly repository: DailyAggregateRepositoryPort;
  readonly clock: Clock;
}

function validOwner(actor: ActorContext, ownerId: StableId<"Owner">): boolean {
  return actor.kind === "owner" && actor.ownerId === ownerId && typeof actor.sessionId === "string" && actor.sessionId.length > 0;
}

function validQuery(query: GetAggregateReportQuery, scope: OwnerAggregateReportDependencies["scope"]): boolean {
  const start = parseUtcDay(query.startDate), end = parseUtcDay(query.endDate);
  return query.scope.kind === "portfolio" && query.scope.portfolioId === scope.portfolioId &&
    validOwner(query.actor, scope.ownerId) && !!start && !!end && start <= end && daysBetween(start, end) <= MAX_REPORT_DAYS &&
    (query.breakdown === undefined || BREAKDOWNS.has(query.breakdown)) &&
    (query.action === undefined || (query.grouping === "daily-action" && ACTIONS.has(query.action)));
}

function suppressionKey(row: DailyAggregateReportRecord): string {
  return `${row.date}:${row.metric}:${row.metricKey}`;
}

function dimensionKey(row: DailyAggregateReportRecord): string {
  return JSON.stringify(row.dimensions);
}

/** Applies Measurement's deterministic small-cell and complementary suppression to one approved breakdown. */
export function suppressDailyAggregateBreakdown(rows: readonly DailyAggregateReportRecord[]): {
  readonly rows: readonly DailyAggregateReportRecord[];
  readonly suppressedCells: boolean;
} {
  const groups = new Map<string, DailyAggregateReportRecord[]>();
  for (const row of rows) groups.set(suppressionKey(row), [...(groups.get(suppressionKey(row)) ?? []), row]);
  const hidden = new Set<DailyAggregateReportRecord>();
  let suppressedCells = false;
  for (const group of groups.values()) {
    const small = group.filter((row) => row.observedSubjects < 5);
    if (small.length === 0) continue;
    suppressedCells = true;
    for (const row of small) hidden.add(row);
    const complements = group.filter((row) => row.observedSubjects >= 5)
      .sort((a, b) => {
        const left = dimensionKey(a), right = dimensionKey(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
    for (const row of complements.slice(0, small.length)) hidden.add(row);
  }
  return {
    rows: rows.filter((row) => !hidden.has(row)).sort((a, b) => {
      const left = `${a.date}:${a.metric}:${a.metricKey}:${dimensionKey(a)}`;
      const right = `${b.date}:${b.metric}:${b.metricKey}:${dimensionKey(b)}`;
      return left < right ? -1 : left > right ? 1 : 0;
    }),
    suppressedCells,
  };
}

export function createOwnerAggregateReportService(deps: OwnerAggregateReportDependencies): {
  getAggregateReport(query: GetAggregateReportQuery): Promise<Result<SafeAggregateReport, Rejection>>;
} {
  return {
    async getAggregateReport(query) {
      if (!validQuery(query, deps.scope)) return invalid();
      try {
        const authorized = await deps.authorize({ actor: query.actor, requiredPermission: "write:owner" });
        if (!authorized.ok) return authorized;
        if (!authorized.value) return { ok: false, error: { kind: "forbidden", code: "OPERATION_NOT_PERMITTED" } };
        const now = deps.clock.now();
        if (!Number.isFinite(Date.parse(now))) return unavailable();
        const breakdown = query.breakdown ?? "summary";
        const page = await deps.transactions.run(transaction => deps.repository.readReport({
          portfolioId: deps.scope.portfolioId,
          ownerId: deps.scope.ownerId,
          startDay: query.startDate,
          endDay: query.endDate,
          grouping: query.grouping,
          breakdown,
          ...(query.action === undefined ? {} : { action: query.action }),
          limit: REPORT_LIMIT + 1,
        }, transaction));
        const rows = page.rows.slice(0, REPORT_LIMIT);
        const incomplete = page.incomplete || page.rows.length > REPORT_LIMIT;
        const metadata = {
          utcPeriod: { startDay: query.startDate, endDay: query.endDate },
          asOf: page.asOf,
          incomplete,
          policyVersion: POLICY_VERSION,
          sourceHorizon: "accepted-events-within-14-days-of-as-of",
          grouping: query.grouping,
          breakdown,
        } as const;
        if (incomplete || rows.some(row => row.incomplete)) {
          return { ok: true, value: { ...metadata, state: "incomplete", observedSubjects: "not-disclosed" } };
        }
        if (rows.length === 0) return { ok: true, value: { ...metadata, state: "no-data", observedSubjects: "zero" } };
        if (breakdown === "summary" && rows.some(row => row.observedSubjects < 5)) {
          return { ok: true, value: { ...metadata, state: "low-sample", observedSubjects: "fewer-than-five" } };
        }
        if (breakdown === "summary" && rows.some(row => row.hasSmallDimensionCell)) {
          return { ok: true, value: { ...metadata, state: "low-sample", observedSubjects: "not-disclosed" } };
        }
        let reportRows = rows;
        let suppressedCells = false;
        if (breakdown !== "summary") {
          const filtered = suppressDailyAggregateBreakdown(rows);
          reportRows = [...filtered.rows];
          suppressedCells = filtered.suppressedCells;
          if (reportRows.length === 0) {
            return { ok: true, value: { ...metadata, state: "low-sample", observedSubjects: "not-disclosed" } };
          }
        }
        const safeRows = reportRows.map(row => {
          if (row.returningSubjects > row.observedSubjects || row.count < 0 || row.sum < 0) throw new Error("DAILY_AGGREGATE_STATISTIC_INVALID");
          if (row.metric === "goal" && (!row.goalId || !row.goalVersionId || !row.definitionSnapshot)) throw new Error("DAILY_AGGREGATE_GOAL_SNAPSHOT_MISSING");
          return {
            utcDay: row.date,
            count: row.count,
            ...(row.sum > 0 ? { sum: row.sum } : {}),
            dimensions: row.dimensions,
            ...(row.metric === "action"
              ? { metric: "action" as const, action: row.metricKey as MeasurementEventType }
              : { metric: "goal" as const, goalId: row.goalId!, goalVersionId: row.goalVersionId!, definitionSnapshot: row.definitionSnapshot! }),
      };
        });
        return { ok: true, value: { ...metadata, state: "available", observedSubjects: "five-or-more",
          sampleState: suppressedCells ? "low-sample" : "sufficient", rows: safeRows,
          engagementMeaning: "approximate-active-attention", journeyMeaning: "context-without-causation" } };
      } catch {
        return unavailable();
      }
    },
  };
}
