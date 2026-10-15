import type { StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import type { GoalConversionContribution, GoalConversionEvent, GoalConversionProgress, GoalConversionTimeline } from "../application/goal-conversions.js";

export interface GoalConversionCursor {
  readonly effectiveAt: string;
  readonly acceptedAt: string;
  readonly eventId: StableId<"PublicEvent">;
}

export interface GoalConversionCheckpoint {
  readonly status: "ready" | "already-complete" | "stale-trigger";
  readonly portfolioId: StableId<"Portfolio">;
  readonly measurementSubject: StableId<"MeasurementVisitor">;
  readonly generation: number;
  readonly triggerEventId: StableId<"PublicEvent">;
  readonly progress: GoalConversionProgress;
  readonly cursor: GoalConversionCursor | null;
  readonly consentGranted: boolean;
}

export interface GoalConversionRepositoryPort {
  beginOrResume(input: { readonly portfolioId: StableId<"Portfolio">; readonly eventId: StableId<"PublicEvent">; readonly now: string }, transaction: TransactionContext): Promise<GoalConversionCheckpoint | null>;
  listTimelines(portfolioId: StableId<"Portfolio">, transaction: TransactionContext): Promise<readonly GoalConversionTimeline[]>;
  listEvents(input: { readonly portfolioId: StableId<"Portfolio">; readonly measurementSubject: StableId<"MeasurementVisitor">; readonly after: GoalConversionCursor | null; readonly acceptedAfter: string; readonly limit: number }, transaction: TransactionContext): Promise<readonly GoalConversionEvent[]>;
  saveBatch(input: { readonly checkpoint: GoalConversionCheckpoint; readonly progress: GoalConversionProgress; readonly cursor: GoalConversionCursor | null; readonly contributions: readonly GoalConversionContribution[]; readonly completed: boolean }, transaction: TransactionContext): Promise<boolean>;
}
