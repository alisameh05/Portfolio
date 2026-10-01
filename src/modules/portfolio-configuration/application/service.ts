import type {
  Result,
  Rejection,
  ActorContext,
  IdempotencyKey,
  StableId,
} from "@shared/domain";
import type {
  PortfolioSettings,
  OwnerPortfolioSettingsView,
  PublicPortfolioConfigurationView,
  SupportedLocale,
  PortfolioProfile,
  ContactChannel,
  GlobalProjectCta,
} from "../domain/index.js";

/**
 * Safe correlation metadata carried by every mutating configuration command.
 * `correlationId` threads one request through state, ledger, outbox, and
 * audit; `causationId` optionally links to the causing command/event.
 * Never carries secrets, tokens, or raw identifiers.
 */
export interface ConfigurationCorrelation {
  readonly correlationId: string;
  readonly causationId?: string;
}

export interface GetPortfolioSettingsQuery {
  readonly actor: ActorContext;
  readonly portfolioId: StableId<"Portfolio">;
}

export interface GetPublicConfigurationQuery {
  readonly locale: SupportedLocale;
}

export interface UpdatePortfolioProfileCommand extends ConfigurationCorrelation {
  readonly actor: ActorContext;
  readonly portfolioId: StableId<"Portfolio">;
  readonly expectedVersion: number;
  readonly idempotencyKey: IdempotencyKey;
  readonly profile: PortfolioProfile;
}

export interface UpdateContactChannelsCommand extends ConfigurationCorrelation {
  readonly actor: ActorContext;
  readonly portfolioId: StableId<"Portfolio">;
  readonly expectedVersion: number;
  readonly idempotencyKey: IdempotencyKey;
  readonly contactChannels: readonly ContactChannel[];
}

export interface UpdateGlobalProjectCtaCommand extends ConfigurationCorrelation {
  readonly actor: ActorContext;
  readonly portfolioId: StableId<"Portfolio">;
  readonly expectedVersion: number;
  readonly idempotencyKey: IdempotencyKey;
  readonly globalCta: GlobalProjectCta;
}

export interface PortfolioConfigurationService {
  getSettings(
    query: GetPortfolioSettingsQuery,
  ): Promise<Result<OwnerPortfolioSettingsView, Rejection>>;

  getPublicConfiguration(
    query: GetPublicConfigurationQuery,
  ): Promise<Result<PublicPortfolioConfigurationView, Rejection>>;

  updateProfile(
    command: UpdatePortfolioProfileCommand,
  ): Promise<Result<PortfolioSettings, Rejection>>;

  updateContactChannels(
    command: UpdateContactChannelsCommand,
  ): Promise<Result<PortfolioSettings, Rejection>>;

  updateGlobalCta(
    command: UpdateGlobalProjectCtaCommand,
  ): Promise<Result<PortfolioSettings, Rejection>>;
}
