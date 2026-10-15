import type { StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import type { GoalConversionContribution, GoalConversionEvent, GoalConversionProgress, GoalConversionTimeline } from "../application/goal-conversions.js";

export interface GoalConversionCursor {
  readonly effectiveAt: string;
  readonly acceptedAt: string;
  readonly eventId: StableId<"PublicEvent">;
}

export interface GoalConversionTimelineCursor {
  readonly goalId: StableId<"AnalyticsGoal">;
  readonly activationSequence: number;
}

export interface GoalConversionTimelinePage {
  readonly timelines: readonly GoalConversionTimeline[];
  readonly hasMore: boolean;
  readonly nextCursor: GoalConversionTimelineCursor | null;
}

export interface GoalConversionEventPage {
  readonly events: readonly GoalConversionEvent[];
  readonly hasMore: boolean;
}

export interface GoalConversionCheckpoint {
  readonly status: "ready" | "already-complete" | "stale-trigger";
  readonly portfolioId: StableId<"Portfolio">;
  readonly measurementSubject: StableId<"MeasurementVisitor">;
  readonly generation: number;
  readonly triggerEventId: StableId<"PublicEvent">;
  readonly progress: GoalConversionProgress;
  readonly cursor: GoalConversionCursor | null;
  readonly timelineCursor: GoalConversionTimelineCursor | null;
  readonly consentGranted: boolean;
}

export interface GoalConversionRepositoryPort {
  beginOrResume(input: { readonly portfolioId: StableId<"Portfolio">; readonly eventId: StableId<"PublicEvent">; readonly now: string }, transaction: TransactionContext): Promise<GoalConversionCheckpoint | null>;
  listTimelines(portfolioId: StableId<"Portfolio">, after: GoalConversionTimelineCursor | null, limit: number, transaction: TransactionContext): Promise<GoalConversionTimelinePage>;
  listEvents(input: { readonly portfolioId: StableId<"Portfolio">; readonly measurementSubject: StableId<"MeasurementVisitor">; readonly after: GoalConversionCursor | null; readonly acceptedAfter: string; readonly limit: number }, transaction: TransactionContext): Promise<GoalConversionEventPage>;
  saveBatch(input: { readonly checkpoint: GoalConversionCheckpoint; readonly progress: GoalConversionProgress; readonly cursor: GoalConversionCursor | null; readonly timelineCursor: GoalConversionTimelineCursor | null; readonly contributions: readonly GoalConversionContribution[]; readonly completed: boolean }, transaction: TransactionContext): Promise<boolean>;
}
