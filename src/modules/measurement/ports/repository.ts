import type { TransactionContext } from "../../../runtime/ports.js";
import type { StableId, Result, Rejection } from "@shared/domain";
import type {
  ConsentRecord,
  PublicEventData,
  AnalyticsGoalVersion,
  DailyAggregate,
} from "../domain/index.js";

export interface MeasurementRepositoryPort {
  saveConsentRecord(
    record: ConsentRecord,
    portfolioId: StableId<"Portfolio">,
    transaction: TransactionContext,
  ): Promise<Result<ConsentRecord, Rejection>>;

  getConsentRecord(
    visitorId: StableId<"MeasurementVisitor">,
    portfolioId: StableId<"Portfolio">,
    transaction: TransactionContext,
  ): Promise<Result<ConsentRecord, Rejection>>;

  savePublicEvent(
    event: PublicEventData,
    portfolioId: StableId<"Portfolio">,
    transaction: TransactionContext,
  ): Promise<Result<PublicEventData, Rejection>>;

  getActiveGoalVersion(
    goalId: StableId<"AnalyticsGoal">,
    portfolioId: StableId<"Portfolio">,
    transaction: TransactionContext,
  ): Promise<Result<AnalyticsGoalVersion, Rejection>>;

  saveGoalVersion(
    goalVersion: AnalyticsGoalVersion,
    portfolioId: StableId<"Portfolio">,
    transaction: TransactionContext,
  ): Promise<Result<AnalyticsGoalVersion, Rejection>>;

  getDailyAggregates(
    metricName: string,
    startDate: string,
    endDate: string,
    portfolioId: StableId<"Portfolio">,
    transaction: TransactionContext,
  ): Promise<Result<readonly DailyAggregate[], Rejection>>;

  expireDetailEvents(
    olderThanTimestamp: string,
    portfolioId: StableId<"Portfolio">,
    transaction: TransactionContext,
  ): Promise<Result<number, Rejection>>;
}

export interface ClockPort {
  now(): string;
  nowMs(): number;
}

export interface HashPort {
  sha256(input: string): string;
  pseudonymize(input: string, salt: string): string;
}
