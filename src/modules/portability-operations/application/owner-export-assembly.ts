import { createHash } from "node:crypto";
import { err, ok, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import type { OperationsPersistencePorts, SafeErrorCode } from "./persistence.js";
import type { OperationsObservationPort } from "./service.js";
import { recordOperationsSignal } from "./operations-observability.js";
import { parseSafeErrorCode } from "./persistence.js";
import type { Clock, StableIdGenerator, TransactionContext } from "../../../runtime/ports.js";
import type { OwnerExportStorePort, PersistedOwnerExport } from "./owner-export-store.js";
import type { OwnerExportAssemblySnapshot } from "./owner-export-package.js";
import { buildConfigurationOwnerExportPackage, buildSelectedOwnerExportPackage, type OwnerExportMediaObjectReaderPort } from "./owner-export-package.js";
import { OWNER_EXPORT_ASSEMBLY_JOB_TYPE, OwnerExportReadIntegrityError, type OwnerExportObjectReadPort } from "./service.js";
import { applyGuardedOwnerExportTransition } from "./owner-export-service.js";
import { calculateJobRetryDelayMilliseconds } from "./retry-policy.js";
import type { OwnerExportArtifactCleanupPort, createOwnerExportArtifactCleanupService } from "./owner-export-cleanup.js";

const LEASE_DURATION_SECONDS = 300;
const CLAIM_LIMIT = 10;
const RETRY_FAILURE = parseSafeErrorCode("OWNER_EXPORT_ASSEMBLY_RETRY");
const PERMANENT_FAILURE = parseSafeErrorCode("OWNER_EXPORT_ASSEMBLY_FAILED");
const CV_HISTORY_LIMIT_EXCEEDED = parseSafeErrorCode("OWNER_EXPORT_CV_HISTORY_LIMIT_EXCEEDED");
const UNSUPPORTED_SCOPE = parseSafeErrorCode("OWNER_EXPORT_SCOPE_UNSUPPORTED");
const INVALID_JOB = parseSafeErrorCode("OWNER_EXPORT_JOB_INVALID");

export interface OwnerExportSnapshotReaderPort {
  /** Restores volatile values only while current source facts match the durable digest. */
  restoreModerationSnapshot?(input: {
    readonly snapshot: OwnerExportAssemblySnapshot;
    readonly portfolioId: StableId<"Portfolio">;
    readonly ownerId: StableId<"Owner">;
  }): Promise<Result<OwnerExportAssemblySnapshot, Rejection>>;
  capture(input: {
    readonly portfolioId: StableId<"Portfolio">;
    readonly ownerId: StableId<"Owner">;
    readonly snapshotId: StableId<"OwnerExportArtifact">;
    readonly includedScopes: readonly string[];
  }): Promise<Result<OwnerExportAssemblySnapshot, Rejection>>;
  revalidateMediaForReady?(input: {
    readonly snapshot: OwnerExportAssemblySnapshot;
    readonly portfolioId: StableId<"Portfolio">;
    readonly ownerId: StableId<"Owner">;
    readonly context: TransactionContext;
  }): Promise<boolean>;
  revalidateModerationForReady?(input: {
    readonly snapshot: OwnerExportAssemblySnapshot;
    readonly portfolioId: StableId<"Portfolio">;
    readonly ownerId: StableId<"Owner">;
    readonly context: TransactionContext;
  }): Promise<boolean>;
  revalidateOwnerExportForCleanup?(input: {
    readonly snapshot: OwnerExportAssemblySnapshot;
    readonly portfolioId: StableId<"Portfolio">;
    readonly ownerId: StableId<"Owner">;
    readonly context: TransactionContext;
  }): Promise<boolean>;
}

/** @deprecated Use the scope-aware reader port; retained for #240 adapter callers. */
export type OwnerExportConfigurationSnapshotReaderPort = OwnerExportSnapshotReaderPort;

export interface OwnerExportObjectStoragePort extends OwnerExportObjectReadPort {
  writeOwnerExport(input: {
    readonly portfolioId: StableId<"Portfolio">;
    readonly exportId: StableId<"OwnerExport">;
    readonly artifactId: StableId<"OwnerExportArtifact">;
    readonly content: AsyncIterable<Uint8Array>;
    readonly contentLength: number;
    readonly sha256: string;
  }): Promise<Result<void, Rejection>>;
}

export interface OwnerExportAssemblyDependencies {
  readonly operations: Pick<OperationsPersistencePorts, "jobs">;
  readonly exports: OwnerExportStorePort;
  readonly snapshots: OwnerExportSnapshotReaderPort;
  readonly storage: OwnerExportObjectStoragePort;
  readonly mediaObjects?: OwnerExportMediaObjectReaderPort;
  readonly clock: Clock;
  readonly ids: StableIdGenerator;
  readonly random?: () => number;
  readonly artifacts: OwnerExportArtifactCleanupPort;
  readonly cleanup?: ReturnType<typeof createOwnerExportArtifactCleanupService>;
  readonly observations?: Pick<OperationsObservationPort, "recordSignal">;
}

export interface OwnerExportAssemblyRunResult {
  /** True when the fixed claim batch filled; additional queued exports may remain. */
  readonly incompleteBacklog?: boolean;
  readonly cleanup?: { readonly scanned: number; readonly deleted: number; readonly pending: number; readonly incomplete: boolean };
  readonly claimed: number;
  readonly completed: number;
  readonly retried: number;
  readonly failed: number;
  readonly staleLeases: number;
}

function parseJob(value: unknown): {
  readonly exportId: StableId<"OwnerExport">;
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
  readonly includedScopes: readonly string[];
} | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const payload = value as Record<string, unknown>;
  const exportId = payload["exportId"];
  const portfolioId = payload["portfolioId"];
  const ownerId = payload["ownerId"];
  const rawScopes = payload["includedScopes"];
  if (typeof exportId !== "string" || typeof portfolioId !== "string" ||
      typeof ownerId !== "string" || !Array.isArray(rawScopes)) return undefined;
  const parsedExportId = parseStableId("OwnerExport", exportId);
  const parsedPortfolioId = parseStableId("Portfolio", portfolioId);
  const parsedOwnerId = parseStableId("Owner", ownerId);
  if (!parsedExportId.ok || !parsedPortfolioId.ok || !parsedOwnerId.ok) return undefined;
  const includedScopes: string[] = [];
  for (const scope of rawScopes as unknown[]) {
    if (typeof scope !== "string") return undefined;
    includedScopes.push(scope);
  }
  return {
    exportId: parsedExportId.value,
    portfolioId: parsedPortfolioId.value,
    ownerId: parsedOwnerId.value,
    includedScopes,
  };
}

type ArtifactVerificationOutcome = "verified" | "integrity-mismatch" | "read-failure";

async function verifyArtifact(
  content: AsyncIterable<Uint8Array>,
  contentLength: number,
  expectedSha256: string,
): Promise<ArtifactVerificationOutcome> {
  const digest = createHash("sha256");
  let total = 0;
  try {
    for await (const chunk of content) {
      total += chunk.byteLength;
      if (total > contentLength) return "integrity-mismatch";
      digest.update(chunk);
    }
  } catch (error) {
    return error instanceof OwnerExportReadIntegrityError ? "integrity-mismatch" : "read-failure";
  }
  return total === contentLength && digest.digest("hex") === expectedSha256
    ? "verified"
    : "integrity-mismatch";
}

function isSupportedScopeSelection(scopes: readonly string[]): boolean {
  const supportedOrder = ["portfolio-content", "taxonomy", "media-metadata", "cv-metadata", "moderation-history", "analytics-reports", "portfolio-configuration"];
  const canonical = supportedOrder.filter((scope) => scopes.includes(scope));
  return scopes.length > 0 && canonical.length === scopes.length && canonical.every((scope, index) => scopes[index] === scope);
}

function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

/**
 * Resumable leased worker for every registered Owner export scope. Snapshot
 * and candidate checkpoints are write-once. Uploads hold a bounded lifecycle
 * fence shared with cleanup. Readiness and queue completion commit under the current lease.
 */
export function createOwnerExportAssemblyService(deps: OwnerExportAssemblyDependencies) {
  async function failExport(
    record: PersistedOwnerExport,
    job: { readonly jobId: StableId<"Job">; readonly leaseToken: string },
    code: SafeErrorCode,
  ): Promise<"failed" | "stale"> {
    const transition = await applyGuardedOwnerExportTransition(deps.exports, {
      exportId: record.exportId,
      fromStatus: record.status,
      toStatus: "failed",
      expectedAggregateVersion: record.aggregateVersion,
      leaseToken: job.leaseToken,
      transitionedAt: deps.clock.now(),
      actingJobId: job.jobId,
      failureCode: code,
    });
    if (!transition.ok) return "stale";
    return transition.value === "applied" ? "failed" : "stale";
  }

  async function processJobUnobserved(job: {
    readonly jobId: string;
    readonly payload: { readonly type: string; readonly version: number; readonly value: Readonly<Record<string, unknown>> };
    readonly leaseToken: string;
    readonly attemptCount: number;
  }): Promise<"completed" | "retried" | "failed" | "stale"> {
    const jobId = parseStableId("Job", job.jobId);
    const parsed = job.payload.type === OWNER_EXPORT_ASSEMBLY_JOB_TYPE && job.payload.version === 1
      ? parseJob(job.payload.value)
      : undefined;
    if (!jobId.ok || parsed === undefined) {
      const failed = await deps.operations.jobs.fail(job.jobId, job.leaseToken, INVALID_JOB);
      return failed ? "failed" : "stale";
    }
    let record: PersistedOwnerExport | null;
    try {
      record = await deps.exports.findOwnerExport({
        exportId: parsed.exportId,
        portfolioId: parsed.portfolioId,
        ownerId: parsed.ownerId,
      });
    } catch {
      record = null;
    }
    if (record === null) {
      const failed = await deps.operations.jobs.fail(job.jobId, job.leaseToken, INVALID_JOB);
      return failed ? "failed" : "stale";
    }
    if (record.status === "ready" || record.status === "failed" || record.status === "expired") {
      const completed = await deps.operations.jobs.complete(job.jobId, job.leaseToken, deps.clock.now());
      return completed ? "completed" : "stale";
    }
    if (!sameScopes(parsed.includedScopes, record.includedScopes)) {
      return failExport(record, { jobId: jobId.value, leaseToken: job.leaseToken }, INVALID_JOB);
    }
    if (!isSupportedScopeSelection(record.includedScopes)) {
      const failed = await failExport(record, { jobId: jobId.value, leaseToken: job.leaseToken }, UNSUPPORTED_SCOPE);
      return failed;
    }
    if (record.status === "requested") {
      const started = await applyGuardedOwnerExportTransition(deps.exports, {
        exportId: record.exportId,
        fromStatus: "requested",
        toStatus: "building",
        expectedAggregateVersion: record.aggregateVersion,
        leaseToken: job.leaseToken,
        transitionedAt: deps.clock.now(),
        actingJobId: jobId.value,
      });
      if (!started.ok || started.value !== "applied") return "stale";
      record = await deps.exports.findOwnerExport({ exportId: parsed.exportId, portfolioId: parsed.portfolioId, ownerId: parsed.ownerId });
      if (record === null) return "stale";
    }

    try {
      let snapshot = record.snapshot;
      if (snapshot === undefined) {
        const snapshotId = parseStableId("OwnerExportArtifact", deps.ids.generate("OwnerExportArtifact"));
        if (!snapshotId.ok) throw new Error("OWNER_EXPORT_SNAPSHOT_ID_INVALID");
        const captured = await deps.snapshots.capture({
          portfolioId: parsed.portfolioId,
          ownerId: parsed.ownerId,
          snapshotId: snapshotId.value,
          includedScopes: record.includedScopes,
        });
        if (!captured.ok) {
          if (captured.error.code === CV_HISTORY_LIMIT_EXCEEDED) {
            return await failExport(record, { jobId: jobId.value, leaseToken: job.leaseToken }, CV_HISTORY_LIMIT_EXCEEDED);
          }
          throw new Error("OWNER_EXPORT_SNAPSHOT_UNAVAILABLE");
        }
        const saved = await deps.exports.saveOwnerExportSnapshot({
          exportId: record.exportId,
          actingJobId: jobId.value,
          leaseToken: job.leaseToken,
          snapshot: captured.value,
        });
        if (!saved.ok || saved.value !== "saved") return "stale";
        snapshot = captured.value;
      }

      if ("kind" in snapshot && snapshot.moderationCheckpoint !== undefined) {
        const restored = await deps.snapshots.restoreModerationSnapshot?.({ snapshot, portfolioId: parsed.portfolioId, ownerId: parsed.ownerId });
        if (restored !== undefined && !restored.ok && restored.error.code === "OWNER_EXPORT_MODERATION_CHANGED") {
          return await failExport(record, { jobId: jobId.value, leaseToken: job.leaseToken }, PERMANENT_FAILURE);
        }
        if (restored === undefined || !restored.ok) throw new Error("OWNER_EXPORT_MODERATION_UNAVAILABLE");
        snapshot = restored.value;
      }
      const built = snapshot !== null && typeof snapshot === "object" && "kind" in snapshot
        ? await buildSelectedOwnerExportPackage({ exportId: record.exportId, snapshot, portfolioId: parsed.portfolioId,
          ...(deps.mediaObjects === undefined ? {} : { objects: deps.mediaObjects }) })
        : await buildConfigurationOwnerExportPackage({ exportId: record.exportId, snapshot });
      if (record.candidateArtifactId === undefined || record.candidateSha256 === undefined || record.candidateContentLength === undefined) {
        const candidateArtifactId = parseStableId("OwnerExportArtifact", deps.ids.generate("OwnerExportArtifact"));
        if (!candidateArtifactId.ok) throw new Error("OWNER_EXPORT_ARTIFACT_ID_INVALID");
        const saved = await deps.exports.saveOwnerExportCandidate({
          exportId: record.exportId,
          actingJobId: jobId.value,
          leaseToken: job.leaseToken,
          artifactId: candidateArtifactId.value,
          sha256: built.sha256,
          contentLength: built.contentLength,
        });
        if (!saved.ok || saved.value !== "saved") return "stale";
        record = await deps.exports.findOwnerExport({ exportId: parsed.exportId, portfolioId: parsed.portfolioId, ownerId: parsed.ownerId });
        if (record === null) return "stale";
      }
      if (record.candidateArtifactId === undefined || record.candidateSha256 !== built.sha256 ||
          record.candidateContentLength !== built.contentLength) throw new Error("OWNER_EXPORT_CANDIDATE_MISMATCH");
      const artifactId = record.candidateArtifactId;
      const uploadRecord = record;
      const upload = async () => {
        let stored: Result<void, Rejection>;
        try {
          stored = await deps.storage.writeOwnerExport({
            portfolioId: parsed.portfolioId,
            exportId: uploadRecord.exportId,
            artifactId,
            content: built.content,
            contentLength: built.contentLength,
            sha256: built.sha256,
          });
        } catch {
          void recordOperationsSignal(deps.observations, { kind: "storage-operation", operation: "write", outcome: "failed" });
          throw new Error("OWNER_EXPORT_STORAGE_WRITE_FAILED");
        }
        if (!stored.ok) {
          void recordOperationsSignal(deps.observations, { kind: "storage-operation", operation: "write", outcome: "failed" });
          throw new Error("OWNER_EXPORT_STORAGE_WRITE_FAILED");
        }
        void recordOperationsSignal(deps.observations, { kind: "storage-operation", operation: "write", outcome: "succeeded", bytes: built.contentLength });
        let read: Awaited<ReturnType<OwnerExportObjectStoragePort["readOwnerExport"]>>;
        try {
          read = await deps.storage.readOwnerExport({
            portfolioId: parsed.portfolioId,
            exportId: uploadRecord.exportId,
            artifactId,
            expectedSha256: uploadRecord.candidateSha256!,
            expectedContentLength: uploadRecord.candidateContentLength!,
          });
        } catch {
          void recordOperationsSignal(deps.observations, { kind: "storage-operation", operation: "read", outcome: "failed" });
          throw new Error("OWNER_EXPORT_STORAGE_VERIFY_FAILED");
        }
        if (!read.ok) {
          void recordOperationsSignal(deps.observations, { kind: "storage-operation", operation: "read", outcome: "failed" });
          throw new Error("OWNER_EXPORT_STORAGE_VERIFY_FAILED");
        }
        const verification = read.value.contentLength === built.contentLength
          ? await verifyArtifact(read.value.content, built.contentLength, built.sha256)
          : "integrity-mismatch";
        if (verification !== "verified") {
          if (verification === "integrity-mismatch") {
            void recordOperationsSignal(deps.observations, { kind: "owner-export-integrity", outcome: "failed" });
          }
          void recordOperationsSignal(deps.observations, { kind: "storage-operation", operation: "read", outcome: "failed" });
          throw new Error("OWNER_EXPORT_STORAGE_VERIFY_FAILED");
        }
        void recordOperationsSignal(deps.observations, { kind: "owner-export-integrity", outcome: "verified" });
        void recordOperationsSignal(deps.observations, { kind: "storage-operation", operation: "read", outcome: "succeeded", bytes: read.value.contentLength });
        return true;
      };
      const uploaded = await deps.artifacts.uploadCandidate({ portfolioId: parsed.portfolioId,
        exportId: record.exportId, artifactId, actingJobId: jobId.value, leaseToken: job.leaseToken }, upload);
      if (!uploaded) return "stale";
      const completedAt = deps.clock.now();
      const policyExpiresAt = "kind" in snapshot
        ? snapshot.policyExpiresAt ?? snapshot.configuration?.policyExpiresAt
        : snapshot.policyExpiresAt;
      const completed = await applyGuardedOwnerExportTransition(deps.exports, {
        exportId: record.exportId,
        fromStatus: "building",
        toStatus: "ready",
        expectedAggregateVersion: record.aggregateVersion,
        leaseToken: job.leaseToken,
        transitionedAt: completedAt,
        ...(policyExpiresAt === undefined ? {} : { policyExpiresAt }),
        actingJobId: jobId.value,
        integrityManifest: built.manifest,
        artifactId,
        precondition: async (context) => {
          const input = { snapshot, portfolioId: parsed.portfolioId, ownerId: parsed.ownerId, context };
          if ((uploadRecord.includedScopes.includes("media-metadata") || uploadRecord.includedScopes.includes("cv-metadata")) &&
              !await deps.snapshots.revalidateMediaForReady?.(input)) return false;
          if (uploadRecord.includedScopes.includes("moderation-history") &&
              !await deps.snapshots.revalidateModerationForReady?.(input)) return false;
          return true;
        },
      });
      return completed.ok && completed.value === "applied" ? "completed" : "stale";
    } catch (error) {
      if (record === null) return "stale";
      if (error instanceof Error && error.message === "OWNER_EXPORT_CV_HISTORY_LIMIT_EXCEEDED") {
        return await failExport(record, { jobId: jobId.value, leaseToken: job.leaseToken }, CV_HISTORY_LIMIT_EXCEEDED);
      }
      if (job.attemptCount >= 5) {
        const failed = await failExport(record, { jobId: jobId.value, leaseToken: job.leaseToken }, PERMANENT_FAILURE);
        return failed;
      }
      const delay = calculateJobRetryDelayMilliseconds(job.attemptCount, deps.random ?? Math.random);
      const retried = await deps.operations.jobs.scheduleRetry(job.jobId, job.leaseToken, RETRY_FAILURE, delay);
      return retried ? "retried" : "stale";
    }
  }

  async function processJob(job: {
    readonly jobId: string;
    readonly payload: { readonly type: string; readonly version: number; readonly value: Readonly<Record<string, unknown>> };
    readonly leaseToken: string;
    readonly attemptCount: number;
  }): Promise<"completed" | "retried" | "failed" | "stale"> {
    const startedAt = Date.parse(deps.clock.now());
    const outcome = await processJobUnobserved(job);
    const endedAt = Date.parse(deps.clock.now());
    void recordOperationsSignal(deps.observations, {
      kind: "owner-export-build", outcome,
      durationMs: Number.isFinite(startedAt) && Number.isFinite(endedAt)
        ? Math.max(0, Math.min(86_400_000, endedAt - startedAt)) : Number.NaN,
    });
    return outcome;
  }

  let cleanupCursor: StableId<"OwnerExport"> | undefined;
  return {
    async runOwnerExportCleanup() {
      if (deps.cleanup === undefined) return err({ kind: "temporarily_unavailable", code: "OWNER_EXPORT_CLEANUP_UNAVAILABLE" } as const);
        const result = await deps.cleanup.runOwnerExportCleanup(cleanupCursor === undefined ? {} : { after: cleanupCursor });
      if (result.ok) cleanupCursor = result.value.nextCursor;
      return result;
    },
    async runOwnerExportAssembly(input: {
      readonly workerId: string;
      readonly maxClaims?: number;
      readonly shouldStop?: () => boolean;
    }): Promise<Result<OwnerExportAssemblyRunResult, Rejection>> {
      const maxClaims = input.maxClaims ?? CLAIM_LIMIT;
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.workerId) || !Number.isSafeInteger(maxClaims) ||
          maxClaims < 0 || maxClaims > CLAIM_LIMIT ||
          (input.shouldStop !== undefined && typeof input.shouldStop !== "function")) {
        return err({ kind: "validation", code: "OWNER_EXPORT_WORKER_CONTEXT_INVALID" });
      }
      try {
        let cleanup: OwnerExportAssemblyRunResult["cleanup"];
        if (input.shouldStop?.()) {
          return ok({ claimed: 0, completed: 0, retried: 0, failed: 0, staleLeases: 0, incompleteBacklog: true });
        }
        if (deps.cleanup !== undefined) {
          const cleaned = await deps.cleanup.runOwnerExportCleanup({
            ...(cleanupCursor === undefined ? {} : { after: cleanupCursor }),
            ...(input.shouldStop === undefined ? {} : { shouldStop: input.shouldStop }),
          });
          if (!cleaned.ok) return cleaned;
          cleanupCursor = cleaned.value.nextCursor;
          cleanup = cleaned.value;
        }
        const counts = { claimed: 0, completed: 0, retried: 0, failed: 0, staleLeases: 0 };
        let halted = false;
        while (counts.claimed < maxClaims) {
          if (input.shouldStop?.()) { halted = true; break; }
          const jobs = await deps.operations.jobs.claimDue({
            workerId: input.workerId,
            now: deps.clock.now(),
            leaseDurationSeconds: LEASE_DURATION_SECONDS,
            limit: 1,
            jobTypes: [OWNER_EXPORT_ASSEMBLY_JOB_TYPE],
          });
          const job = jobs[0];
          if (job === undefined) break;
          counts.claimed += 1;
          const result = await processJob(job);
          if (result === "completed") counts.completed += 1;
          else if (result === "retried") counts.retried += 1;
          else if (result === "failed") counts.failed += 1;
          else counts.staleLeases += 1;
          if (input.shouldStop?.()) { halted = true; break; }
        }
        return ok({ ...counts, incompleteBacklog: halted || counts.claimed === maxClaims,
          ...(cleanup === undefined ? {} : { cleanup }) });
      } catch {
        return err({ kind: "temporarily_unavailable", code: "OWNER_EXPORT_ASSEMBLY_UNAVAILABLE" });
      }
    },
  };
}
