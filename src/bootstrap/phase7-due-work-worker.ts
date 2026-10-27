import type { Rejection, Result, StableId } from "../shared/domain/index.js";
import type { OperationsPersistencePorts, OwnerExportAssemblyRunResult } from "../modules/portability-operations/index.js";
import { createDailyAggregateWorkService } from "../modules/measurement/application/daily-aggregates.js";
import { createMeasurementRetentionWorkService } from "../modules/measurement/application/retention.js";
import { createPostgresDailyAggregateRepository } from "../modules/measurement/adapters/postgres-daily-aggregates.js";
import { createPostgresMeasurementRetentionRepository } from "../modules/measurement/adapters/postgres-retention.js";
import { createFeedbackRetentionWorkService } from "../modules/interaction-moderation/application/retention.js";
import { createPostgresFeedbackRetentionRepository } from "../modules/interaction-moderation/adapters/postgres-retention.js";
import { createPhase7DueWorkService } from "../runtime/phase7-due-work.js";
import { createSystemClock, createSystemIdGenerator, type Clock, type StableIdGenerator } from "../runtime/ports.js";

/**
 * Composes the portable Phase 7 worker from the existing module-owned services.
 * The Owner assembly instance is supplied by the Portability composition root;
 * queue handling and source-table effects remain owned by their modules.
 */
export function createPhase7DueWorkWorker(input: {
  readonly portfolioId: StableId<"Portfolio">;
  readonly operations: Pick<OperationsPersistencePorts, "transactions" | "jobs">;
  readonly ownerExports: {
    runOwnerExportAssembly(args: { readonly workerId: string }): Promise<Result<OwnerExportAssemblyRunResult, Rejection>>;
  };
  readonly clock?: Clock;
  readonly ids?: StableIdGenerator;
  readonly random?: () => number;
}) {
  const clock = input.clock ?? createSystemClock();
  const ids = input.ids ?? createSystemIdGenerator();
  const daily = createDailyAggregateWorkService({ portfolioId: input.portfolioId,
    transactions: input.operations.transactions, repository: createPostgresDailyAggregateRepository() });
  const retention = createMeasurementRetentionWorkService({ portfolioId: input.portfolioId,
    transactions: input.operations.transactions, repository: createPostgresMeasurementRetentionRepository() });
  const feedbackRetention = createFeedbackRetentionWorkService({ portfolioId: input.portfolioId,
    transactions: input.operations.transactions, repository: createPostgresFeedbackRetentionRepository() });

  return createPhase7DueWorkService({
    portfolioId: input.portfolioId,
    operations: input.operations,
    measurement: { ...daily, ...retention },
    interaction: feedbackRetention,
    ownerExports: input.ownerExports,
    clock,
    ids,
    ...(input.random === undefined ? {} : { random: input.random }),
  });
}
