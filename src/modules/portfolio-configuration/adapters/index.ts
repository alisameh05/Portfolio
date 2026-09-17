import type { Result, Rejection } from "@shared/domain";
import { err } from "@shared/domain";
import type { PortfolioConfigurationRepositoryPort } from "../ports/index.js";
import type { PortfolioSettings } from "../domain/index.js";

/**
 * Stub repository adapter for Phase 1 skeleton.
 * Business implementation and persistence are deferred to later phases.
 */
export class StubPortfolioConfigurationRepository
  implements PortfolioConfigurationRepositoryPort
{
  async getSettings(): Promise<Result<PortfolioSettings, Rejection>> {
    return err({
      kind: "not_found",
      code: "PORTFOLIO_SETTINGS_NOT_CONFIGURED",
    });
  }

  async saveSettings(
    _settings: PortfolioSettings,
  ): Promise<Result<PortfolioSettings, Rejection>> {
    return err({
      kind: "temporarily_unavailable",
      code: "PERSISTENCE_NOT_IMPLEMENTED",
    });
  }
}
