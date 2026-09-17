import type { Result, Rejection, ActorContext } from "@shared/domain";
import type {
  PortfolioSettings,
  PortfolioProfile,
  ContactChannel,
  GlobalProjectCta,
} from "../domain/index.js";

export interface GetPortfolioSettingsQuery {
  readonly actor: ActorContext;
}

export interface UpdatePortfolioProfileCommand {
  readonly actor: ActorContext;
  readonly expectedVersion: number;
  readonly profile: PortfolioProfile;
}

export interface UpdateContactChannelsCommand {
  readonly actor: ActorContext;
  readonly expectedVersion: number;
  readonly contactChannels: readonly ContactChannel[];
}

export interface UpdateGlobalProjectCtaCommand {
  readonly actor: ActorContext;
  readonly expectedVersion: number;
  readonly globalCta: GlobalProjectCta;
}

export interface PortfolioConfigurationService {
  getSettings(
    query: GetPortfolioSettingsQuery,
  ): Promise<Result<PortfolioSettings, Rejection>>;

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
