import type { TransactionContext } from "../../../runtime/ports.js";
import type { StableId, Result, Rejection } from "@shared/domain";
import type {
  ConsentRecord,
  PublicEventData,
  AnalyticsGoalVersion,
  DailyAggregate,
} from "../domain/index.js";
import type {
  AnalyticsGoalAggregateView,
  AnalyticsGoalDefinition,
  AnalyticsGoalVersionView,
  AnalyticsGoalActivationView,
} from "../application/owner-analytics.js";

export interface AnalyticsGoalRootRecord {
  readonly goalId: StableId<"AnalyticsGoal">;
  readonly aggregateVersion: number;
  readonly activeVersionId: StableId<"AnalyticsGoalVersion"> | null;
}

export interface AnalyticsGoalVersionRecord extends AnalyticsGoalVersionView {}
export interface AnalyticsGoalActivationRecord extends AnalyticsGoalActivationView {
  /** Monotonic, goal-local ordering for tied timestamps and delayed matching. */
  readonly activationSequence: number;
}

export interface OwnerAnalyticsGoalRepositoryPort {
  lockGoal(goalId: StableId<"AnalyticsGoal">, portfolioId: StableId<"Portfolio">, transaction: TransactionContext): Promise<void>;
  getGoal(goalId: StableId<"AnalyticsGoal">, portfolioId: StableId<"Portfolio">, transaction: TransactionContext): Promise<AnalyticsGoalRootRecord | null>;
  insertGoal(goalId: StableId<"AnalyticsGoal">, portfolioId: StableId<"Portfolio">, transaction: TransactionContext): Promise<void>;
  appendVersion(input: { readonly goalId: StableId<"AnalyticsGoal">; readonly portfolioId: StableId<"Portfolio">; readonly versionId: StableId<"AnalyticsGoalVersion">; readonly versionNumber: number; readonly expectedAggregateVersion: number; readonly definition: AnalyticsGoalDefinition; readonly createdAt: string }, transaction: TransactionContext): Promise<void>;
  activateVersion(input: { readonly goalId: StableId<"AnalyticsGoal">; readonly portfolioId: StableId<"Portfolio">; readonly versionId: StableId<"AnalyticsGoalVersion">; readonly activationId: StableId<"Event">; readonly expectedAggregateVersion: number; readonly activatedAt: string }, transaction: TransactionContext): Promise<number>;
  listVersions(goalId: StableId<"AnalyticsGoal">, portfolioId: StableId<"Portfolio">, transaction: TransactionContext): Promise<readonly AnalyticsGoalVersionRecord[]>;
  listActivations(goalId: StableId<"AnalyticsGoal">, portfolioId: StableId<"Portfolio">, transaction: TransactionContext): Promise<readonly AnalyticsGoalActivationRecord[]>;
}

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
