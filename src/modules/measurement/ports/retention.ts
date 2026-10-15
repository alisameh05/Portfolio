import type { StableId } from "@shared/domain";
import type { BoundedWorkResult } from "@shared/application";
import type { TransactionContext } from "../../../runtime/ports.js";

export type MeasurementRetentionKind = "detail" | "aggregates" | "withdrawal";

export interface MeasurementRetentionBatch {
  readonly kind: MeasurementRetentionKind;
  readonly portfolioId: StableId<"Portfolio">;
  readonly jobId: StableId<"Job">;
  readonly now: string;
  readonly batchSize: 25 | 50 | 100;
}

export interface MeasurementRetentionRepositoryPort {
  processBatch(input: MeasurementRetentionBatch, transaction: TransactionContext): Promise<BoundedWorkResult>;
}
