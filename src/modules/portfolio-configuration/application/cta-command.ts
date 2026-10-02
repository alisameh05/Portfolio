import type { Rejection, Result } from "@shared/domain";
import type { Clock, StableIdGenerator } from "../../../runtime/ports.js";
import type { OperationsPersistencePorts } from "../../portability-operations/index.js";
import type { PortfolioScope } from "../ports/index.js";
import type { UpdateGlobalProjectCtaCommand } from "./service.js";
import type { PortfolioSettingsRepository } from "./settings-service.js";
import { isValidGlobalProjectCta } from "./settings-service.js";
import {
  changedConfigurationFields,
  executePortfolioConfigurationCommand,
  type PortfolioConfigurationCommandReceipt,
} from "./configuration-command.js";

export interface PortfolioGlobalCtaCommandService {
  updateGlobalCta(command: UpdateGlobalProjectCtaCommand): Promise<Result<PortfolioConfigurationCommandReceipt, Rejection>>;
}

const OPERATION_SCOPE = "portfolio-configuration.update-owner-global-project-cta";

export function createPortfolioGlobalCtaCommandService(input: {
  readonly repository: Pick<PortfolioSettingsRepository, "getSettings" | "updateGlobalCta">;
  readonly operations: OperationsPersistencePorts;
  readonly scope: PortfolioScope;
  readonly clock?: Clock;
  readonly ids?: StableIdGenerator;
}): PortfolioGlobalCtaCommandService {
  return {
    updateGlobalCta(command) {
      return executePortfolioConfigurationCommand({
        command,
        operationScope: OPERATION_SCOPE,
        invalidCode: "INVALID_GLOBAL_PROJECT_CTA",
        request: command.globalCta,
        idempotencyRequest: {
          expectedVersion: command.expectedVersion,
          globalCta: {
            label: command.globalCta.label,
            destination: command.globalCta.destination,
            unavailableFallback: command.globalCta.unavailableFallback,
          },
        },
        isValid: isValidGlobalProjectCta,
        apply: (globalCta, context) => input.repository.updateGlobalCta(
          input.scope,
          globalCta,
          command.expectedVersion,
          context,
        ),
        event: (before, globalCta, ownerScope) => ({
          type: "portfolio_configuration.cta_updated.v1",
          version: 1,
          value: {
            changedFields: changedConfigurationFields(before.globalCta, globalCta, ["label", "destination", "unavailableFallback"]),
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
