import type {
  ContactChannel,
  ContactChannelType,
  DomainEvent,
  GlobalProjectCta,
  OwnerPortfolioSettingsView,
  PortfolioProfile,
  PortfolioSettings,
  SupportedLocale,
} from "@shared/domain";
export type {
  ContactChannel,
  ContactChannelType,
  GlobalProjectCta,
  OwnerPortfolioSettingsView,
  PortfolioProfile,
  PortfolioSettings,
  SupportedLocale,
} from "@shared/domain";

export interface PublicPortfolioCapabilities {
  readonly currentCvAvailable: boolean;
  readonly externalLinksAvailable: boolean;
}

export type PublicGlobalProjectCtaView =
  | {
    readonly availability: "available";
    readonly label: string;
    readonly destination: string;
  }
  | {
    readonly availability: "unavailable";
    readonly label: string;
    readonly unavailableFallback: string;
  };

/**
 * Narrow locale-aware public configuration view. Contains only approved
 * public fields for one locale; private Owner/session material is excluded.
 * English-only capabilities are withheld (not relabeled) in Arabic.
 */
export interface PublicPortfolioConfigurationView {
  readonly profile: PortfolioProfile;
  /** Channels filtered to the requested locale, order preserved. */
  readonly contactChannels: readonly ContactChannel[];
  /** An unavailable CTA exposes its safe fallback, never its destination. */
  readonly globalCta: PublicGlobalProjectCtaView;
  readonly capabilities: PublicPortfolioCapabilities;
  readonly locale: SupportedLocale;
}

export type PortfolioProfileUpdatedEvent = DomainEvent<
  "portfolio_configuration.profile_updated.v1",
  {
    /** Changed field names only; never copy the full biography into the outbox. */
    readonly changedFields: readonly (keyof PortfolioProfile)[];
    /** One-way stable Owner scope digest; raw Owner and provider identities stay private. */
    readonly ownerScope: string;
  }
>;

export type ContactChannelsUpdatedEvent = DomainEvent<
  "portfolio_configuration.channels_updated.v1",
  {
    /** Channel kinds only; never copy Contact destinations or labels to the outbox. */
    readonly channelTypes: readonly ContactChannelType[];
    readonly channelCount: number;
    /** One-way stable Owner scope digest; raw Owner and provider identities stay private. */
    readonly ownerScope: string;
  }
>;

export type GlobalProjectCtaUpdatedEvent = DomainEvent<
  "portfolio_configuration.cta_updated.v1",
  {
    /** Changed field names only; destinations and fallback text are not copied into audit history. */
    readonly changedFields: readonly (keyof GlobalProjectCta)[];
    /** One-way stable Owner scope digest; raw Owner and provider identities stay private. */
    readonly ownerScope: string;
  }
>;
