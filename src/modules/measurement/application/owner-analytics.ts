import type { ApplicationRequestContext } from "@shared/application";
import type { ActorContext, IdempotencyKey, Rejection, Result, StableId } from "@shared/domain";

export type AnalyticsEventAction = import("../domain/index.js").MeasurementEventType;

export interface AnalyticsGoalStep {
  readonly action: AnalyticsEventAction;
  readonly publicRouteIds?: ReadonlyArray<StableId<"PublicRoute">>;
  readonly projectIds?: ReadonlyArray<StableId<"Project">>;
}

export interface AnalyticsGoalDefinition {
  readonly name: string;
  readonly steps: ReadonlyArray<AnalyticsGoalStep>;
}

export interface GetOwnerAnalyticsGoalQuery extends ApplicationRequestContext {
  readonly actor: ActorContext;
  readonly goalId: StableId<"AnalyticsGoal">;
}

export interface CreateOwnerAnalyticsGoalVersionApplicationCommand extends ApplicationRequestContext {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly goalId: StableId<"AnalyticsGoal">;
  readonly definition: AnalyticsGoalDefinition;
}

export interface ActivateOwnerAnalyticsGoalVersionApplicationCommand extends ApplicationRequestContext {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly goalId: StableId<"AnalyticsGoal">;
  readonly versionId: StableId<"AnalyticsGoalVersion">;
}

export interface AnalyticsGoalVersionView {
  readonly versionId: StableId<"AnalyticsGoalVersion">;
  readonly versionNumber: number;
  readonly definition: AnalyticsGoalDefinition;
  readonly createdAt: string;
}

export interface AnalyticsGoalActivationView {
  readonly versionId: StableId<"AnalyticsGoalVersion">;
  readonly activatedAt: string;
}

export interface AnalyticsGoalAggregateView {
  readonly goalId: StableId<"AnalyticsGoal">;
  readonly aggregateVersion: number;
  readonly activeVersionId: StableId<"AnalyticsGoalVersion"> | null;
  readonly versions: ReadonlyArray<AnalyticsGoalVersionView>;
  readonly activationHistory: ReadonlyArray<AnalyticsGoalActivationView>;
}

export interface AnalyticsGoalVersionReceipt {
  readonly goalId: StableId<"AnalyticsGoal">;
  readonly versionId: StableId<"AnalyticsGoalVersion">;
  readonly aggregateVersion: number;
  readonly outcome: "analytics-goal-version-created";
}

export interface AnalyticsGoalActivationReceipt {
  readonly aggregateId: StableId<"AnalyticsGoal">;
  readonly aggregateVersion: number;
  readonly outcome: "analytics-goal-version-activated";
}

export interface OwnerAnalyticsApplicationService {
  getOwnerAnalyticsGoal(
    query: GetOwnerAnalyticsGoalQuery,
  ): Promise<Result<AnalyticsGoalAggregateView, Rejection>>;
  createOwnerAnalyticsGoalVersion(
    command: CreateOwnerAnalyticsGoalVersionApplicationCommand,
  ): Promise<Result<AnalyticsGoalVersionReceipt, Rejection>>;
  activateOwnerAnalyticsGoalVersion(
    command: ActivateOwnerAnalyticsGoalVersionApplicationCommand,
  ): Promise<Result<AnalyticsGoalActivationReceipt, Rejection>>;
}
