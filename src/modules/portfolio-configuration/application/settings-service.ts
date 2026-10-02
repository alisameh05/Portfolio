import type {
  ActorContext,
  Rejection,
  Result,
} from "@shared/domain";
import { err } from "@shared/domain";
import type { TransactionContext, TransactionRunner } from "../../../runtime/ports.js";
import type {
  OwnerPortfolioSettingsView,
  PortfolioProfile,
  ContactChannel,
  GlobalProjectCta,
} from "../domain/index.js";
import type { PortfolioConfigurationRepositoryPort, PortfolioProfileUpdate, PortfolioScope } from "../ports/index.js";
import type { GetPortfolioSettingsQuery } from "./service.js";

export interface PortfolioSettingsRepository {
  getSettings(
    scope: PortfolioScope,
    context: TransactionContext,
  ): Promise<Result<OwnerPortfolioSettingsView, Rejection>>;
  provisionSettings(
    scope: PortfolioScope,
    settings: OwnerPortfolioSettingsView,
    context: TransactionContext,
  ): Promise<Result<OwnerPortfolioSettingsView, Rejection>>;
  updateProfile(
    scope: PortfolioScope,
    profile: PortfolioProfile,
    expectedVersion: number,
    context: TransactionContext,
  ): Promise<Result<PortfolioProfileUpdate, Rejection>>;
}

export interface PortfolioSettingsProvisioningValues {
  readonly profile: PortfolioProfile;
  readonly contactChannels: readonly ContactChannel[];
  readonly globalCta: GlobalProjectCta;
}

export interface PortfolioSettingsApplicationService {
  getSettings(
    query: GetPortfolioSettingsQuery,
  ): Promise<Result<OwnerPortfolioSettingsView, Rejection>>;
}

/** Private controlled provisioning seam; it is intentionally absent from module barrels and HTTP. */
export interface PortfolioSettingsProvisioner {
  provision(
    values: PortfolioSettingsProvisioningValues,
  ): Promise<Result<OwnerPortfolioSettingsView, Rejection>>;
}

interface ControlledPortfolioSettingsService
  extends PortfolioSettingsApplicationService, PortfolioSettingsProvisioner {}

function validation(field: string): Result<never, Rejection> {
  return err({ kind: "validation", code: "INVALID_PORTFOLIO_SETTINGS", details: { field } });
}

function meaningfulText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maximum &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function secureWebDestination(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host.endsWith(".local") ||
      /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) ||
      host.startsWith("[")
    ) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function validChannelDestination(channel: ContactChannel["channel"], destination: unknown): boolean {
  if (channel === "phone") return typeof destination === "string" && /^tel:\+[1-9]\d{7,14}$/.test(destination);
  if (channel === "email") return typeof destination === "string" && /^mailto:[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(destination);
  const url = secureWebDestination(destination);
  if (url === undefined) return false;
  const host = url.hostname.toLowerCase();
  const isHost = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  switch (channel) {
    case "linkedin": return isHost("linkedin.com");
    case "whatsapp": return host === "wa.me" || isHost("whatsapp.com");
    case "instagram": return isHost("instagram.com");
    case "other": return true;
  }
}

function validateValues(values: PortfolioSettingsProvisioningValues): string | undefined {
  if (values === null || typeof values !== "object") return "settings";
  const { profile, contactChannels, globalCta } = values;
  if (profile === null || typeof profile !== "object") return "profile";
  if (globalCta === null || typeof globalCta !== "object") return "globalCta";
  if (!meaningfulText(profile.displayName, 100)) return "profile.displayName";
  if (!meaningfulText(profile.headline, 160)) return "profile.headline";
  if (!meaningfulText(profile.bio, 4000)) return "profile.bio";
  if (!Array.isArray(contactChannels) || contactChannels.length > 20) return "contactChannels";
  for (const [index, channel] of contactChannels.entries()) {
    if (channel === null || typeof channel !== "object") return `contactChannels.${index}`;
    if (!meaningfulText(channel.label, 80)) return `contactChannels.${index}.label`;
    if (!validChannelDestination(channel.channel, channel.destination)) return `contactChannels.${index}.destination`;
    const locales = channel.availableLocales;
    if (
      !Array.isArray(locales) || locales.length < 1 || locales.length > 2 ||
      new Set(locales).size !== locales.length ||
      locales.some((locale) => locale !== "en" && locale !== "ar")
    ) return `contactChannels.${index}.availableLocales`;
  }
  if (!meaningfulText(globalCta.label, 80)) return "globalCta.label";
  if (secureWebDestination(globalCta.destination) === undefined) return "globalCta.destination";
  if (
    !meaningfulText(globalCta.unavailableFallback, 160) ||
    /[<>]/.test(globalCta.unavailableFallback)
  ) return "globalCta.unavailableFallback";
  return undefined;
}

export function createPortfolioSettingsReader(input: {
  readonly repository: Pick<PortfolioConfigurationRepositoryPort, "getSettings">;
  readonly transactions: TransactionRunner;
  readonly scope: PortfolioScope;
}): PortfolioSettingsApplicationService {
  const { repository, transactions, scope } = input;

  return {
    async getSettings(query) {
      const actor: ActorContext = query.actor;
      if (actor.kind !== "owner" || actor.ownerId !== scope.ownerId) {
        return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      }
      if (query.portfolioId !== scope.portfolioId) {
        return err({ kind: "forbidden", code: "PORTFOLIO_SCOPE_MISMATCH" });
      }
      return transactions.run((context) => repository.getSettings(scope, context));
    },
  };
}

export function createPortfolioSettingsService(input: {
  readonly repository: PortfolioSettingsRepository;
  readonly transactions: TransactionRunner;
  readonly scope: PortfolioScope;
}): ControlledPortfolioSettingsService {
  return {
    ...createPortfolioSettingsReader(input),
    async provision(values) {
      const { repository, transactions, scope } = input;
      const invalidField = validateValues(values);
      if (invalidField !== undefined) return validation(invalidField);
      const settings: OwnerPortfolioSettingsView = Object.freeze({
        portfolioId: scope.portfolioId,
        profile: Object.freeze({ ...values.profile }),
        contactChannels: Object.freeze(values.contactChannels.map((channel) => Object.freeze({
          ...channel,
          availableLocales: Object.freeze([...channel.availableLocales]),
        }))),
        globalCta: Object.freeze({ ...values.globalCta }),
        version: 1,
      });
      return transactions.run((context) => repository.provisionSettings(scope, settings, context));
    },
  };
}
