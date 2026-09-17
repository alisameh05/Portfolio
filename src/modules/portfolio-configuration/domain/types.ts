import type { StableId, DomainEvent } from "@shared/domain";

export interface PortfolioProfile {
  readonly title: string;
  readonly ownerName: string;
  readonly headline: string;
  readonly bio: string;
  readonly supportedLocales: readonly ["en", "ar"];
}

export type ContactChannelType =
  | "linkedin"
  | "github"
  | "email"
  | "whatsapp"
  | "phone"
  | "custom";

export interface ContactChannel {
  readonly id: StableId<"ContactChannel">;
  readonly type: ContactChannelType;
  readonly label: string;
  readonly destination: string;
  readonly isPublic: boolean;
}

export interface GlobalProjectCta {
  readonly label: string;
  readonly destination: string;
  readonly fallbackDestination?: string;
  readonly isEnabled: boolean;
}

export interface PortfolioSettings {
  readonly portfolioId: StableId<"Portfolio">;
  readonly profile: PortfolioProfile;
  readonly contactChannels: readonly ContactChannel[];
  readonly globalCta: GlobalProjectCta;
  readonly version: number;
}

export type PortfolioProfileUpdatedEvent = DomainEvent<
  "portfolio_configuration.profile_updated.v1",
  {
    readonly profile: PortfolioProfile;
  }
>;

export type ContactChannelsUpdatedEvent = DomainEvent<
  "portfolio_configuration.channels_updated.v1",
  {
    readonly contactChannels: readonly ContactChannel[];
  }
>;

export type GlobalProjectCtaUpdatedEvent = DomainEvent<
  "portfolio_configuration.cta_updated.v1",
  {
    readonly globalCta: GlobalProjectCta;
  }
>;
