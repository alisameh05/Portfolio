import type { StableId } from "@shared/domain";
/** Explicitly unconfigured only for the existing fail-closed shell. Real services require configured scope before effects. */
export type PortfolioRequestScope = { readonly kind: "portfolio"; readonly portfolioId: StableId<"Portfolio"> } | { readonly kind: "unconfigured" };
export interface ApplicationRequestContext { readonly scope: PortfolioRequestScope; readonly correlationId: string }
/** Internal work limits are closed, deterministic batch sizes; no unlimited work request. */
export type WorkBatchSize = 25 | 50 | 100;
export interface BoundedWorkResult {
  readonly processedCount: number;
  readonly nextCursor: string | null;
  /** True while the owning service still has bounded batches to resume. */
  readonly incomplete: boolean;
  /** Durable data coverage is incomplete even after all batches are drained. */
  readonly coverageIncomplete?: boolean;
}
