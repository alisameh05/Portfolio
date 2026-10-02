import type { Rejection, Result } from "@shared/domain";
import type { Clock, StableIdGenerator } from "../../../runtime/ports.js";
import type { OperationsPersistencePorts } from "../../portability-operations/index.js";
import type { PortfolioScope } from "../ports/index.js";
import type { PortfolioProfile } from "../domain/index.js";
import type { UpdatePortfolioProfileCommand } from "./service.js";
import type { PortfolioSettingsRepository } from "./settings-service.js";
import {
  changedConfigurationFields,
  executePortfolioConfigurationCommand,
  type PortfolioConfigurationCommandReceipt,
} from "./configuration-command.js";

export interface PortfolioProfileCommandService {
  updateProfile(command: UpdatePortfolioProfileCommand): Promise<Result<PortfolioProfileCommandReceipt, Rejection>>;
}

export type PortfolioProfileCommandReceipt = PortfolioConfigurationCommandReceipt;

const OPERATION_SCOPE = "portfolio-configuration.update-owner-profile";

function isValidProfile(value: unknown): value is PortfolioProfile {
  if (value === null || typeof value !== "object") return false;
  const profile = value as Partial<PortfolioProfile>;
  return typeof profile.displayName === "string" && profile.displayName.trim().length > 0 &&
      profile.displayName.length <= 100 &&
      typeof profile.headline === "string" && profile.headline.trim().length > 0 &&
      profile.headline.length <= 160 &&
      typeof profile.bio === "string" && profile.bio.trim().length > 0 &&
      profile.bio.length <= 4000 &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(
        profile.displayName + profile.headline + profile.bio,
      );
}

export function createPortfolioProfileCommandService(input: {
  readonly repository: Pick<PortfolioSettingsRepository, "getSettings" | "updateProfile">;
  readonly operations: OperationsPersistencePorts;
  readonly scope: PortfolioScope;
  readonly clock?: Clock;
  readonly ids?: StableIdGenerator;
}): PortfolioProfileCommandService {
  return {
    updateProfile(command) {
      return executePortfolioConfigurationCommand({
        command,
        operationScope: OPERATION_SCOPE,
        invalidCode: "INVALID_PORTFOLIO_PROFILE",
        request: command.profile,
        idempotencyRequest: {
          expectedVersion: command.expectedVersion,
          profile: {
            displayName: command.profile.displayName,
            headline: command.profile.headline,
            bio: command.profile.bio,
          },
        },
        isValid: isValidProfile,
        apply: (profile, context) => input.repository.updateProfile(
          input.scope,
          profile,
          command.expectedVersion,
          context,
        ),
        event: (before, profile, ownerScope) => ({
          type: "portfolio_configuration.profile_updated.v1",
          version: 1,
          value: {
            changedFields: changedConfigurationFields(before.profile, profile, ["displayName", "headline", "bio"]),
            ownerScope,
          },
        }),
        repository: input.repository,
        operations: input.operations,
        scope: input.scope,
        ...(input.clock === undefined ? {} : { clock: input.clock }),
        ...(input.ids === undefined ? {} : { ids: input.ids }),
      });
    },
  };
}
