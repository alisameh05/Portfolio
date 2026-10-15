import type { StableId } from "@shared/domain";
/** Explicitly unconfigured only for the existing fail-closed shell. Real services require configured scope before effects. */
export type PortfolioRequestScope = { readonly kind: "portfolio"; readonly portfolioId: StableId<"Portfolio"> } | { readonly kind: "unconfigured" };
export interface ApplicationRequestContext { readonly scope: PortfolioRequestScope; readonly correlationId: string }
/** Internal work limits are closed, deterministic batch sizes; no unlimited work request. */
export type WorkBatchSize = 25 | 50 | 100;
export interface BoundedWorkResult { readonly processedCount: number; readonly nextCursor: string | null; readonly incomplete: boolean }
