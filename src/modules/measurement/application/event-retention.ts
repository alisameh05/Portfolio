import { err, ok, type Rejection, type Result, type StableId } from "@shared/domain";
import type { BoundedWorkResult } from "@shared/application";
import type { TransactionRunner } from "../../../runtime/ports.js";
import { requestTransactionRollback } from "../../../runtime/ports.js";
import type { MeasurementEventRetentionRepositoryPort } from "./ingest-event.js";
import type { MeasurementWorkCommand } from "./work.js";

const RETENTION_MS = 14 * 86_400_000;
const batchSizes = new Set([25, 50, 100]);

export interface MeasurementEventRetentionDependencies {
  readonly portfolioId: StableId<"Portfolio">;
  readonly transactions: TransactionRunner;
  readonly repository: MeasurementEventRetentionRepositoryPort;
}

/** Deletes only accepted raw event detail at the documented 14-day boundary. */
export function createMeasurementEventRetentionService(deps: MeasurementEventRetentionDependencies) {
  return {
    async expireDetail(command: MeasurementWorkCommand): Promise<Result<BoundedWorkResult, Rejection>> {
      if (command.actor?.kind !== "system" || command.actor.purpose !== "measurement.retention") {
        return err({ kind: "forbidden", code: "MEASUREMENT_RETENTION_FORBIDDEN" });
      }
      if (command.scope.kind !== "portfolio" || command.scope.portfolioId !== deps.portfolioId ||
          !batchSizes.has(command.batchSize) || !Number.isFinite(Date.parse(command.now))) {
        return err({ kind: "validation", code: "MEASUREMENT_RETENTION_INVALID" });
      }
      const acceptedBefore = new Date(Date.parse(command.now) - RETENTION_MS).toISOString();
      try {
        return await deps.transactions.run<Result<BoundedWorkResult, Rejection>>(async transaction => {
          try {
            const processedCount = await deps.repository.expireAcceptedEvents({
              portfolioId: deps.portfolioId, acceptedBefore, limit: command.batchSize,
            }, transaction);
            return ok({ processedCount, nextCursor: null, incomplete: processedCount === command.batchSize });
          } catch {
            return requestTransactionRollback(err({ kind: "temporarily_unavailable", code: "MEASUREMENT_RETENTION_UNAVAILABLE" }));
          }
        });
      } catch {
        return err({ kind: "temporarily_unavailable", code: "MEASUREMENT_RETENTION_UNAVAILABLE" });
      }
    },
  };
}

