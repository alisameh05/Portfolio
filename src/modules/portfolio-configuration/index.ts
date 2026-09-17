/**
 * portfolio-configuration module public interface.
 *
 * This barrel is the single public import surface for the Portfolio Configuration module.
 * Other modules must never deep-import internal paths.
 */

export type {
  PortfolioProfile,
  ContactChannelType,
  ContactChannel,
  GlobalProjectCta,
  PortfolioSettings,
  PortfolioProfileUpdatedEvent,
  ContactChannelsUpdatedEvent,
  GlobalProjectCtaUpdatedEvent,
} from "./domain/index.js";

export type {
  GetPortfolioSettingsQuery,
  UpdatePortfolioProfileCommand,
  UpdateContactChannelsCommand,
  UpdateGlobalProjectCtaCommand,
  PortfolioConfigurationService,
} from "./application/index.js";

export type { PortfolioConfigurationRepositoryPort } from "./ports/index.js";
