import { err, ok, type Rejection, type Result, type StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import type { PersistedOwnerExport } from "./owner-export-store.js";
import type { OwnerExportAssemblySnapshot } from "./owner-export-package.js";
import type { OperationsObservationPort } from "./service.js";
import { recordOperationsSignal } from "./operations-observability.js";

export interface OwnerExportObjectIdentity {
  readonly portfolioId: StableId<"Portfolio">;
  readonly exportId: StableId<"OwnerExport">;
  readonly artifactId: StableId<"OwnerExportArtifact">;
}

export interface OwnerExportObjectDeletePort {
  /** Idempotently deletes exactly this owned ZIP, never a source object. */
  deleteOwnerExport(input: OwnerExportObjectIdentity): Promise<Result<void, Rejection>>;
}

export interface OwnerExportInvalidationLedgerRecord {
  readonly portfolioId: StableId<"Portfolio">;
  readonly exportId: StableId<"OwnerExport">;
  readonly artifactId: StableId<"OwnerExportArtifact">;
  readonly revokedAt: string;
  readonly revocationCode: "expired" | "privacy_invalid" | "build_failed" | "prior_revocation";
  readonly artifactDeletedAt?: string;
}

/** Revocation and upload use the same database fence, including stale writers. */
export interface OwnerExportArtifactCleanupPort {
  uploadCandidate(input: OwnerExportObjectIdentity & { readonly actingJobId: StableId<"Job">; readonly leaseToken: string },
    upload: () => Promise<boolean>): Promise<boolean>;
  listOwnerExportCleanup(input: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner">;
    readonly after?: StableId<"OwnerExport">; readonly limit: number }): Promise<readonly PersistedOwnerExport[]>;
  revokeOwnerExportArtifact(input: { readonly exportId: StableId<"OwnerExport">; readonly portfolioId: StableId<"Portfolio">;
    readonly ownerId: StableId<"Owner">;
    readonly stillEligible: (record: PersistedOwnerExport, context: TransactionContext) => Promise<boolean>;
  }): Promise<PersistedOwnerExport | null>;
  markOwnerExportArtifactDeleted(input: OwnerExportObjectIdentity): Promise<void>;
  /** Bounded protected current ledger for restore-quarantine reconciliation. */
  listOwnerExportInvalidationLedger(input: { readonly after?: StableId<"OwnerExport">; readonly limit: number;
    readonly portfolioId?: StableId<"Portfolio"> }): Promise<readonly OwnerExportInvalidationLedgerRecord[]>;
}

/** @deprecated Use the scope-neutral cleanup port. */
export type OwnerExportModerationArtifactsPort = OwnerExportArtifactCleanupPort;

export function createOwnerExportArtifactCleanupService(deps: {
  readonly scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> };
  readonly artifacts: OwnerExportArtifactCleanupPort;
  readonly storage: OwnerExportObjectDeletePort;
  readonly snapshots: { revalidateOwnerExportForCleanup?(input: {
    readonly snapshot: OwnerExportAssemblySnapshot; readonly portfolioId: StableId<"Portfolio">;
    readonly ownerId: StableId<"Owner">; readonly context: TransactionContext;
  }): Promise<boolean> };
  readonly observations?: Pick<OperationsObservationPort, "recordSignal">;
}) {
  return {
    async runOwnerExportCleanup(input: { readonly after?: StableId<"OwnerExport">; readonly limit?: number } = {}) {
      const limit = input.limit ?? 25;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return err({ kind: "validation", code: "OWNER_EXPORT_CLEANUP_LIMIT_INVALID" } as const);
      }
      try {
        const page = await deps.artifacts.listOwnerExportCleanup({ ...deps.scope, limit,
          ...(input.after === undefined ? {} : { after: input.after }) });
        let deleted = 0, pending = 0;
        for (const selected of page) {
          // Re-read under the upload fence. A stale selection never revokes a
          // newly eligible snapshot or deletes before durable access denial.
          const revoked = await deps.artifacts.revokeOwnerExportArtifact({ ...deps.scope,
            exportId: selected.exportId,
            stillEligible: (record, context) => record.snapshot === undefined ? Promise.resolve(false) :
              deps.snapshots.revalidateOwnerExportForCleanup?.({ ...deps.scope, snapshot: record.snapshot, context }) ?? Promise.resolve(false),
          });
          if (revoked?.candidateArtifactId === undefined) continue;
          const identity = { portfolioId: revoked.portfolioId, exportId: revoked.exportId, artifactId: revoked.candidateArtifactId };
          let removed: Result<void, Rejection>;
          try { removed = await deps.storage.deleteOwnerExport(identity); }
          catch {
            void recordOperationsSignal(deps.observations, { kind: "storage-operation", operation: "delete", outcome: "failed" });
            pending++;
            continue;
          }
          if (!removed.ok) {
            void recordOperationsSignal(deps.observations, { kind: "storage-operation", operation: "delete", outcome: "failed" });
            pending++;
            continue;
          }
          void recordOperationsSignal(deps.observations, { kind: "storage-operation", operation: "delete", outcome: "succeeded" });
          await deps.artifacts.markOwnerExportArtifactDeleted(identity);
          deleted++;
        }
        const next = page.length === limit ? page.at(-1)?.exportId : undefined;
        return ok({ scanned: page.length, deleted, pending, incomplete: pending > 0 || next !== undefined,
          ...(next === undefined ? {} : { nextCursor: next }) });
      } catch {
        return err({ kind: "temporarily_unavailable", code: "OWNER_EXPORT_CLEANUP_UNAVAILABLE" } as const);
      }
    },
  };
}

/** @deprecated Use createOwnerExportArtifactCleanupService. */
export const createOwnerExportModerationCleanupService = createOwnerExportArtifactCleanupService;
