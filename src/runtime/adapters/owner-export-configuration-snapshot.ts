import { err, ok, type Rejection, type Result, type StableId } from "@shared/domain";
import type { PortfolioConfigurationExportSnapshotReader } from "../../modules/portfolio-configuration/index.js";
import type { OwnerExportConfigurationSnapshot } from "../../modules/portability-operations/application/owner-export-package.js";
import type { OwnerExportConfigurationSnapshotReaderPort } from "../../modules/portability-operations/application/owner-export-assembly.js";

export interface OwnerExportCapabilityFactsReader {
  read(scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> }): Promise<Pick<OwnerExportConfigurationSnapshot["capabilities"], "currentCvAvailable" | "externalLinksAvailable">>;
}

/**
 * Bridges the Configuration-owned snapshot interface into the Operations job
 * payload. Capability lookups intentionally run after the repeatable-read
 * transaction has closed.
 */
export function createOwnerExportConfigurationSnapshotReader(input: {
  readonly configuration: PortfolioConfigurationExportSnapshotReader;
  readonly capabilities: OwnerExportCapabilityFactsReader;
}): OwnerExportConfigurationSnapshotReaderPort {
  return {
    async capture(scope: {
      readonly portfolioId: StableId<"Portfolio">;
      readonly ownerId: StableId<"Owner">;
      readonly snapshotId: StableId<"OwnerExportArtifact">;
    }): Promise<Result<OwnerExportConfigurationSnapshot, Rejection>> {
      const captured = await input.configuration.capture({
        portfolioId: scope.portfolioId,
        ownerId: scope.ownerId,
      });
      if (!captured.ok) return captured;
      try {
        const capabilities = await input.capabilities.read(scope);
        return ok({
          snapshotId: scope.snapshotId,
          capturedAt: captured.value.capturedAt,
          configurationVersion: captured.value.settings?.version ?? null,
          settings: captured.value.settings,
          capabilities: {
            ...capabilities,
            globalProjectCtaAvailable: captured.value.settings !== null,
          },
        });
      } catch {
        return err({ kind: "temporarily_unavailable", code: "OWNER_EXPORT_CONFIGURATION_UNAVAILABLE" });
      }
    },
  };
}
