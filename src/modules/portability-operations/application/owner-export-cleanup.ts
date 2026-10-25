import { err, ok, type Rejection, type Result, type StableId } from "@shared/domain";
import type { Clock, TransactionContext } from "../../../runtime/ports.js";
import type { PersistedOwnerExport } from "./owner-export-store.js";
import type { OwnerExportAssemblySnapshot } from "./owner-export-package.js";

export interface OwnerExportObjectIdentity {
  readonly portfolioId: StableId<"Portfolio">;
  readonly exportId: StableId<"OwnerExport">;
  readonly artifactId: StableId<"OwnerExportArtifact">;
}

export interface OwnerExportObjectDeletePort {
  /** Idempotently deletes exactly this owned ZIP, never a source object. */
  deleteOwnerExport(input: OwnerExportObjectIdentity): Promise<Result<void, Rejection>>;
}

/** Revocation and upload use the same database fence, including stale writers. */
export interface OwnerExportModerationArtifactsPort {
  uploadCandidate(input: OwnerExportObjectIdentity & { readonly actingJobId: StableId<"Job">; readonly leaseToken: string },
    upload: () => Promise<boolean>): Promise<boolean>;
  listModerationCleanup(input: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner">;
    readonly after?: StableId<"OwnerExport">; readonly limit: number }): Promise<readonly PersistedOwnerExport[]>;
  revokeModerationArtifact(input: { readonly exportId: StableId<"OwnerExport">; readonly portfolioId: StableId<"Portfolio">;
    readonly ownerId: StableId<"Owner">; readonly now: string;
    readonly stillEligible: (record: PersistedOwnerExport, context: TransactionContext) => Promise<boolean>;
  }): Promise<PersistedOwnerExport | null>;
  markModerationArtifactDeleted(input: OwnerExportObjectIdentity): Promise<void>;
}

export function createOwnerExportModerationCleanupService(deps: {
  readonly scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> };
  readonly artifacts: OwnerExportModerationArtifactsPort;
  readonly storage: OwnerExportObjectDeletePort;
  readonly snapshots: { revalidateModerationForReady?(input: {
    readonly snapshot: OwnerExportAssemblySnapshot; readonly portfolioId: StableId<"Portfolio">;
    readonly ownerId: StableId<"Owner">; readonly context: TransactionContext;
  }): Promise<boolean> };
  readonly clock: Clock;
}) {
  return {
    async runOwnerExportCleanup(input: { readonly after?: StableId<"OwnerExport">; readonly limit?: number } = {}) {
      const limit = input.limit ?? 25;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return err({ kind: "validation", code: "OWNER_EXPORT_CLEANUP_LIMIT_INVALID" } as const);
      }
      try {
        const page = await deps.artifacts.listModerationCleanup({ ...deps.scope, limit,
          ...(input.after === undefined ? {} : { after: input.after }) });
        let deleted = 0, pending = 0;
        for (const selected of page) {
          // Re-read under the upload fence. A stale selection never revokes a
          // newly eligible snapshot or deletes before durable access denial.
          const revoked = await deps.artifacts.revokeModerationArtifact({ ...deps.scope,
            exportId: selected.exportId, now: deps.clock.now(),
            stillEligible: (record, context) => record.snapshot === undefined ? Promise.resolve(false) :
              deps.snapshots.revalidateModerationForReady?.({ ...deps.scope, snapshot: record.snapshot, context }) ?? Promise.resolve(false),
          });
          if (revoked?.candidateArtifactId === undefined) continue;
          const identity = { portfolioId: revoked.portfolioId, exportId: revoked.exportId, artifactId: revoked.candidateArtifactId };
          const removed = await deps.storage.deleteOwnerExport(identity);
          if (!removed.ok) { pending++; continue; }
          await deps.artifacts.markModerationArtifactDeleted(identity);
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
