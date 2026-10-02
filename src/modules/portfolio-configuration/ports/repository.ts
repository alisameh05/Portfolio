import type { Result, Rejection, StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import type { PortfolioSettings } from "../domain/index.js";

/**
 * Explicit configured-Portfolio scope. The server resolves the stable
 * Portfolio identity from configuration; callers never invent it.
 */
export interface PortfolioScope {
  readonly portfolioId: StableId<"Portfolio">;
  /** Stable Owner configured for this Portfolio; private to persistence scope. */
  readonly ownerId: StableId<"Owner">;
}

/**
 * Provider-neutral repository contract. Every method accepts the explicit
 * transaction context and the configured Portfolio scope so authorization
 * context cannot leak across pooled requests and only the owning
 * repository can write configuration. Implementations remain fail closed
 * until their owning ticket lands.
 */
export interface PortfolioConfigurationRepositoryPort {
  getSettings(
    scope: PortfolioScope,
    context: TransactionContext,
  ): Promise<Result<PortfolioSettings, Rejection>>;
  saveSettings(
    scope: PortfolioScope,
    settings: PortfolioSettings,
    expectedVersion: number,
    context: TransactionContext,
  ): Promise<Result<PortfolioSettings, Rejection>>;
}
