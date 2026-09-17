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
  ): Promise<Result<ConsentRecord, Rejection>>;

  getConsentRecord(
    visitorId: StableId<"MeasurementVisitor">,
  ): Promise<Result<ConsentRecord, Rejection>>;

  savePublicEvent(
    event: PublicEventData,
  ): Promise<Result<PublicEventData, Rejection>>;

  getActiveGoalVersion(
    goalId: StableId<"AnalyticsGoal">,
  ): Promise<Result<AnalyticsGoalVersion, Rejection>>;

  saveGoalVersion(
    goalVersion: AnalyticsGoalVersion,
  ): Promise<Result<AnalyticsGoalVersion, Rejection>>;

  getDailyAggregates(
    metricName: string,
    startDate: string,
    endDate: string,
  ): Promise<Result<readonly DailyAggregate[], Rejection>>;

  expireDetailEvents(
    olderThanTimestamp: string,
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
