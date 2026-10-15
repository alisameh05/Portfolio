import type { StableId } from "@shared/domain";
import type { BoundedWorkResult } from "@shared/application";
import type { TransactionContext } from "../../../runtime/ports.js";

export interface FeedbackRetentionBatch {
  readonly portfolioId: StableId<"Portfolio">;
  readonly jobId: StableId<"Job">;
  readonly batchSize: 25 | 50 | 100;
  readonly now: string;
}

export interface FeedbackRetentionRepositoryPort {
  processBatch(input: FeedbackRetentionBatch, transaction: TransactionContext): Promise<BoundedWorkResult>;
}
