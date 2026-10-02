import type { Result, Rejection } from "@shared/domain";
import { err } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import type {
  PortfolioConfigurationRepositoryPort,
  PortfolioAggregateUpdate,
  PortfolioScope,
} from "../ports/index.js";
import type { ContactChannel, PortfolioProfile, PortfolioSettings } from "../domain/index.js";

export { createPostgresPortfolioSettingsRepository } from "./postgres-settings.js";

/**
 * Stub repository adapter reconciled with Spec #77 contracts (#79).
 * Signatures accept explicit provider-neutral transaction context and
 * configured Portfolio scope; business persistence remains deferred to
 * its owning ticket and stays fail closed.
 */
export class StubPortfolioConfigurationRepository
  implements PortfolioConfigurationRepositoryPort
{
  async getSettings(
    _scope: PortfolioScope,
    _context: TransactionContext,
  ): Promise<Result<PortfolioSettings, Rejection>> {
    return err({
      kind: "not_found",
      code: "PORTFOLIO_SETTINGS_NOT_CONFIGURED",
    });
  }

  async saveSettings(
    _scope: PortfolioScope,
    _settings: PortfolioSettings,
    _expectedVersion: number,
    _context: TransactionContext,
  ): Promise<Result<PortfolioSettings, Rejection>> {
    return err({
      kind: "temporarily_unavailable",
      code: "PERSISTENCE_NOT_IMPLEMENTED",
    });
  }

  async updateProfile(
    _scope: PortfolioScope,
    _profile: PortfolioProfile,
    _expectedVersion: number,
    _context: TransactionContext,
  ): Promise<Result<PortfolioAggregateUpdate, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "PERSISTENCE_NOT_IMPLEMENTED" });
  }

  async updateContactChannels(
    _scope: PortfolioScope,
    _channels: readonly ContactChannel[],
    _expectedVersion: number,
    _context: TransactionContext,
  ): Promise<Result<PortfolioAggregateUpdate, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "PERSISTENCE_NOT_IMPLEMENTED" });
  }
}
