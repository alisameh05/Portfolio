import type { Rejection, Result, StableId } from "../shared/domain/index.js";
import type {
  PortfolioContactChannelsCommandService,
  PortfolioProfileCommandService,
} from "../modules/portfolio-configuration/index.js";
import type {
  OwnerConfigurationApplicationService,
  OwnerConfigurationReceipt,
  UpdateOwnerContactChannelsApplicationCommand,
  UpdateOwnerGlobalProjectCtaApplicationCommand,
  UpdateOwnerProfileApplicationCommand,
} from "./http/owner-configuration.js";

const notImplemented: Rejection = {
  kind: "temporarily_unavailable",
  code: "RUNTIME_NOT_IMPLEMENTED",
};

/** Runtime translation for the configuration commands activated by Phase 4 #84 and #85. */
export function createOwnerConfigurationApplicationService(
  profileCommands: PortfolioProfileCommandService,
  contactChannelsCommands: PortfolioContactChannelsCommandService,
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
      _command: UpdateOwnerGlobalProjectCtaApplicationCommand,
    ): Promise<Result<OwnerConfigurationReceipt, Rejection>> {
      return { ok: false, error: notImplemented };
    },
  };
}
