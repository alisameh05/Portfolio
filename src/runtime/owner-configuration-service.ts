import type { Rejection, Result, StableId } from "../shared/domain/index.js";
import type {
  PortfolioContactChannelsCommandService,
  PortfolioGlobalCtaCommandService,
  PortfolioProfileCommandService,
} from "../modules/portfolio-configuration/index.js";
import type {
  OwnerConfigurationApplicationService,
  OwnerConfigurationReceipt,
  UpdateOwnerContactChannelsApplicationCommand,
  UpdateOwnerGlobalProjectCtaApplicationCommand,
  UpdateOwnerProfileApplicationCommand,
} from "./http/owner-configuration.js";

/** Runtime translation for the secured profile, channel, and CTA commands. */
export function createOwnerConfigurationApplicationService(
  profileCommands: PortfolioProfileCommandService,
  contactChannelsCommands: PortfolioContactChannelsCommandService,
  ctaCommands: PortfolioGlobalCtaCommandService,
  portfolioId: StableId<"Portfolio">,
): OwnerConfigurationApplicationService {
  return {
    async updateOwnerProfile(
      command: UpdateOwnerProfileApplicationCommand,
    ): Promise<Result<OwnerConfigurationReceipt, Rejection>> {
      return profileCommands.updateProfile({
        actor: command.actor,
        portfolioId,
        idempotencyKey: command.idempotencyKey,
        expectedVersion: command.expectedVersion,
        correlationId: command.correlationId,
        ...(command.causationId === undefined ? {} : { causationId: command.causationId }),
        profile: {
          displayName: command.displayName,
          headline: command.headline,
          bio: command.bio,
          ...(command.mediaAssetId === undefined ? {} : { mediaAssetId: command.mediaAssetId }),
        },
      });
    },
    async updateOwnerContactChannels(
      command: UpdateOwnerContactChannelsApplicationCommand,
    ): Promise<Result<OwnerConfigurationReceipt, Rejection>> {
      return contactChannelsCommands.updateContactChannels({
        actor: command.actor,
        portfolioId,
        idempotencyKey: command.idempotencyKey,
        expectedVersion: command.expectedVersion,
        correlationId: command.correlationId,
        ...(command.causationId === undefined ? {} : { causationId: command.causationId }),
        contactChannels: command.channels,
      });
    },
    async updateOwnerGlobalProjectCta(
      command: UpdateOwnerGlobalProjectCtaApplicationCommand,
    ): Promise<Result<OwnerConfigurationReceipt, Rejection>> {
      return ctaCommands.updateGlobalCta({
        actor: command.actor,
        portfolioId,
        idempotencyKey: command.idempotencyKey,
        expectedVersion: command.expectedVersion,
        correlationId: command.correlationId,
        globalCta: {
          label: command.label,
          destination: command.destination,
          unavailableFallback: command.unavailableFallback,
        },
      });
    },
  };
}
