import { err, parseStableId, type Rejection, type Result, type StableId, type SystemActor } from "@shared/domain";
import type { ApplicationRequestContext, BoundedWorkResult, WorkBatchSize } from "@shared/application";
import type { OperationsPersistencePorts } from "../../portability-operations/index.js";
import type { GoalConversionRepositoryPort } from "../ports/goal-conversions.js";
import { emptyGoalConversionProgress, advanceGoalConversionProgress } from "./goal-conversions.js";

export interface RecomputeGoalConversionsCommand extends ApplicationRequestContext {
  readonly actor: SystemActor & { readonly purpose: "measurement.conversion" };
  readonly eventId: StableId<"PublicEvent">;
  readonly batchSize: WorkBatchSize;
  readonly now: string;
}

export interface GoalConversionWorkService {
  recomputeGoalConversions(command: RecomputeGoalConversionsCommand): Promise<Result<BoundedWorkResult, Rejection>>;
}

export interface GoalConversionWorkDependencies {
  readonly portfolioId: StableId<"Portfolio">;
  readonly operations: Pick<OperationsPersistencePorts, "transactions">;
  readonly repository: GoalConversionRepositoryPort;
}

const unavailable = () => err<Rejection>({ kind: "temporarily_unavailable", code: "GOAL_CONVERSION_UNAVAILABLE" });
const invalid = () => err<Rejection>({ kind: "validation", code: "GOAL_CONVERSION_COMMAND_INVALID" });

function hasValidContext(command: RecomputeGoalConversionsCommand, portfolioId: StableId<"Portfolio">): boolean {
  return command.scope.kind === "portfolio" && command.scope.portfolioId === portfolioId &&
    command.actor.kind === "system" && command.actor.purpose === "measurement.conversion" &&
    parseStableId("Job", command.actor.jobId).ok && parseStableId("PublicEvent", command.eventId).ok &&
    [25, 50, 100].includes(command.batchSize) && Number.isFinite(Date.parse(command.now)) &&
    typeof command.correlationId === "string" && command.correlationId.length > 0 && command.correlationId.length <= 200;
}

export function createGoalConversionWorkService(deps: GoalConversionWorkDependencies): GoalConversionWorkService {
  return {
    async recomputeGoalConversions(command) {
      if (!hasValidContext(command, deps.portfolioId)) return invalid();
      try {
        return await deps.operations.transactions.run<Result<BoundedWorkResult, Rejection>>(async transaction => {
          const checkpoint = await deps.repository.beginOrResume({ portfolioId: deps.portfolioId, eventId: command.eventId, now: command.now }, transaction);
          if (!checkpoint) return err({ kind: "not_found", code: "MEASUREMENT_EVENT_UNAVAILABLE" });
          if (checkpoint.status !== "ready") return { ok: true, value: { processedCount: 0, nextCursor: null, incomplete: false } };
          if (!checkpoint.consentGranted) {
            await deps.repository.saveBatch({ checkpoint, progress: emptyGoalConversionProgress(), cursor: null, timelineCursor: null, contributions: [], completed: true }, transaction);
            return { ok: true, value: { processedCount: 0, nextCursor: null, incomplete: false } };
          }

          // One activation interval and at most 48 events bound event, timeline, output, and checkpoint rows to 100.
          const pageLimit = Math.min(command.batchSize, 48);
          const timelinePage = await deps.repository.listTimelines(deps.portfolioId, checkpoint.timelineCursor, 1, transaction);
          const eventPage = await deps.repository.listEvents({ portfolioId: deps.portfolioId,
            measurementSubject: checkpoint.measurementSubject, after: checkpoint.cursor,
            acceptedAfter: new Date(Date.parse(command.now) - 14 * 86_400_000).toISOString(), limit: pageLimit }, transaction);
          const batch = eventPage.events;
          const eventsComplete = !eventPage.hasMore;
          const completed = eventsComplete && !timelinePage.hasMore;
          const advanceToNextTimeline = eventsComplete && timelinePage.hasMore;
          const advanced = advanceGoalConversionProgress(checkpoint.progress, batch, timelinePage.timelines);
          const last = batch.at(-1);
          const cursor = advanceToNextTimeline ? null : last ? { effectiveAt: last.effectiveAt, acceptedAt: last.acceptedAt, eventId: last.eventId } : checkpoint.cursor;
          const timelineCursor = advanceToNextTimeline ? timelinePage.nextCursor : checkpoint.timelineCursor;
          const progress = advanceToNextTimeline ? emptyGoalConversionProgress() : advanced.progress;
          const saved = await deps.repository.saveBatch({ checkpoint, progress, cursor, timelineCursor,
            contributions: advanced.contributions, completed }, transaction);
          if (!saved) return { ok: true, value: { processedCount: 0, nextCursor: null, incomplete: false } };
          return { ok: true, value: { processedCount: batch.length,
            nextCursor: completed ? null : checkpoint.triggerEventId, incomplete: !completed } };
        });
      } catch {
        return unavailable();
      }
    },
  };
}
