import type { StableId, DomainEvent } from "@shared/domain";

/**
 * Supported public locales. English and Arabic streams are independent;
 * Arabic presentation never falls back to English text. English-only
 * destinations remain truthfully identified as unavailable in Arabic.
 * Matches `Locale` in `openapi/owner-v1/components/common.yaml`.
 */
export type SupportedLocale = "en" | "ar";

/**
 * Committed Contact channel enum. Matches
 * `ContactChannel.channel` in `openapi/owner-v1/components/configuration.yaml`.
 * Skeleton-only values (`github`, `custom`) are retired: use `other` for
 * non-listed destinations and `email` for mail destinations.
 */
export type ContactChannelType =
  | "linkedin"
  | "whatsapp"
  | "instagram"
  | "phone"
  | "email"
  | "other";

/**
 * Public profile DTO. Handwritten provider-neutral contract matching
 * `ProfileUpdate` transport (`displayName`, `headline`, `bio`).
 * Skeleton-only `title`/`ownerName` are retired; no generated or
 * provider type may enter this contract.
 */
export interface PortfolioProfile {
  readonly displayName: string;
  readonly headline: string;
  readonly bio: string;
}

/**
 * Single ordered Contact channel. Matches `ContactChannel` transport:
 * `channel`, `label`, `destination`, `availableLocales`.
 * Order in `contactChannels` is significant; an empty list is valid.
 * `availableLocales` holds unique `en`/`ar` values; transport enforces
 * 1..N unique items, domain preserves them without reinterpretation.
 */
export interface ContactChannel {
  readonly channel: ContactChannelType;
  readonly label: string;
  readonly destination: string;
  readonly availableLocales: readonly SupportedLocale[];
}

/**
 * Single portfolio-wide Global project CTA. Matches `ProjectCtaUpdate`
 * transport: `label`, `destination`, and required `unavailableFallback`
 * as safe non-executable text (never reinterpreted as a URL).
 * No per-Project override or invented fallback URL exists.
 */
export interface GlobalProjectCta {
  readonly label: string;
  readonly destination: string;
  readonly unavailableFallback: string;
}

export interface PortfolioSettings {
  readonly portfolioId: StableId<"Portfolio">;
  readonly profile: PortfolioProfile;
  /** Ordered channels; empty is valid, at most twenty per transport limits. */
  readonly contactChannels: readonly ContactChannel[];
  readonly globalCta: GlobalProjectCta;
  readonly version: number;
}

/**
 * Owner settings view: committed application state and version for the
 * configured Portfolio. Never exposes identity mappings, sessions, keys,
 * or audit metadata; it is an application view, not raw tables.
 */
export type OwnerPortfolioSettingsView = PortfolioSettings;

/**
 * Narrow locale-aware public configuration view. Contains only approved
 * public fields for one locale; private Owner/session material is excluded.
 * English-only capabilities are withheld (not relabeled) in Arabic.
 */
export interface PublicPortfolioConfigurationView {
  readonly profile: PortfolioProfile;
  /** Channels filtered to the requested locale, order preserved. */
  readonly contactChannels: readonly ContactChannel[];
  readonly globalCta: GlobalProjectCta;
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
    readonly contactChannels: readonly ContactChannel[];
  }
>;

export type GlobalProjectCtaUpdatedEvent = DomainEvent<
  "portfolio_configuration.cta_updated.v1",
  {
    readonly globalCta: GlobalProjectCta;
  }
>;
