import type { Result, Rejection } from "@shared/domain";
import type { PortfolioSettings } from "../domain/index.js";

export interface PortfolioConfigurationRepositoryPort {
  getSettings(): Promise<Result<PortfolioSettings, Rejection>>;
  saveSettings(
    settings: PortfolioSettings,
  ): Promise<Result<PortfolioSettings, Rejection>>;
}
