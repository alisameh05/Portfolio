import type { StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import type { DailyAggregate } from "../domain/index.js";
import type { AnalyticsGoalDefinition } from "../application/owner-analytics.js";

export interface DailyAggregateReportRecord extends DailyAggregate {
  readonly definitionSnapshot?: AnalyticsGoalDefinition;
  /** Internal-only signal used to withhold an additive summary above a small cell. */
  readonly hasSmallDimensionCell?: boolean;
}

export interface DailyAggregatePage {
  readonly rows: readonly DailyAggregateReportRecord[];
  readonly asOf: string;
  readonly incomplete: boolean;
}

export interface DailyAggregateRebuildResult {
  readonly processedCount: number;
  /** The owning module found that retention sealed this day before complete coverage. */
  readonly coverageIncomplete: boolean;
}

export interface DailyAggregateRepositoryPort {
  rebuildDay(input: {
    readonly portfolioId: StableId<"Portfolio">;
    readonly utcDay: string;
    readonly asOf: string;
  }, transaction: TransactionContext): Promise<DailyAggregateRebuildResult>;
  readReport(input: {
    readonly portfolioId: StableId<"Portfolio">;
    readonly ownerId: StableId<"Owner">;
    readonly startDay: string;
    readonly endDay: string;
    readonly grouping: "daily-action" | "daily-goal";
    readonly goalId?: StableId<"AnalyticsGoal">;
    readonly goalVersionId?: StableId<"AnalyticsGoalVersion">;
    readonly breakdown: "summary" | "locale" | "country" | "device" | "referrer" | "project" | "route";
    readonly action?: string;
    readonly limit: number;
  }, transaction: TransactionContext): Promise<DailyAggregatePage>;
}
