/**
 * portfolio-configuration module public interface.
 *
 * This barrel is the single public import surface for the Portfolio Configuration module.
 * Other modules must never deep-import internal paths.
 */

export type {
  SupportedLocale,
  PortfolioProfile,
  ContactChannelType,
  ContactChannel,
  GlobalProjectCta,
  PortfolioSettings,
  OwnerPortfolioSettingsView,
  PublicPortfolioConfigurationView,
  PortfolioProfileUpdatedEvent,
  ContactChannelsUpdatedEvent,
  GlobalProjectCtaUpdatedEvent,
} from "./domain/index.js";

export type {
  ConfigurationCorrelation,
  GetPortfolioSettingsQuery,
  GetPublicConfigurationQuery,
  UpdatePortfolioProfileCommand,
  UpdateContactChannelsCommand,
  UpdateGlobalProjectCtaCommand,
  PortfolioConfigurationService,
} from "./application/index.js";

export type {
  PortfolioScope,
  PortfolioConfigurationRepositoryPort,
} from "./ports/index.js";
