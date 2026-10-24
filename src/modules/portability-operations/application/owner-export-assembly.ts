import { createHash } from "node:crypto";
import { err, ok, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import type { OperationsPersistencePorts, SafeErrorCode } from "./persistence.js";
import { parseSafeErrorCode } from "./persistence.js";
import type { Clock, StableIdGenerator } from "../../../runtime/ports.js";
import type { OwnerExportStorePort, PersistedOwnerExport } from "./owner-export-store.js";
import type { OwnerExportAssemblySnapshot } from "./owner-export-package.js";
import { buildConfigurationOwnerExportPackage, buildSelectedOwnerExportPackage } from "./owner-export-package.js";
import { OWNER_EXPORT_ASSEMBLY_JOB_TYPE, type OwnerExportObjectReadPort } from "./service.js";
import { OWNER_EXPORT_RETENTION_SECONDS, applyGuardedOwnerExportTransition } from "./owner-export-service.js";
import { calculateJobRetryDelayMilliseconds } from "./retry-policy.js";

const LEASE_DURATION_SECONDS = 300;
const CLAIM_LIMIT = 10;
const RETRY_FAILURE = parseSafeErrorCode("OWNER_EXPORT_ASSEMBLY_RETRY");
const PERMANENT_FAILURE = parseSafeErrorCode("OWNER_EXPORT_ASSEMBLY_FAILED");
const UNSUPPORTED_SCOPE = parseSafeErrorCode("OWNER_EXPORT_SCOPE_UNSUPPORTED");
const INVALID_JOB = parseSafeErrorCode("OWNER_EXPORT_JOB_INVALID");

export interface OwnerExportSnapshotReaderPort {
  capture(input: {
    readonly portfolioId: StableId<"Portfolio">;
    readonly ownerId: StableId<"Owner">;
    readonly snapshotId: StableId<"OwnerExportArtifact">;
    readonly includedScopes: readonly string[];
  }): Promise<Result<OwnerExportAssemblySnapshot, Rejection>>;
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
  readonly clock: Clock;
  readonly ids: StableIdGenerator;
  readonly random?: () => number;
}

export interface OwnerExportAssemblyRunResult {
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

function effectiveExpiry(completedAt: string, policyExpiresAt?: string): string {
  const defaultExpiry = Date.parse(completedAt) + OWNER_EXPORT_RETENTION_SECONDS * 1000;
  if (policyExpiresAt !== undefined) {
    const policy = Date.parse(policyExpiresAt);
    if (Number.isFinite(policy)) return new Date(Math.min(defaultExpiry, policy)).toISOString();
  }
  return new Date(defaultExpiry).toISOString();
}

async function verifyArtifact(
  content: AsyncIterable<Uint8Array>,
  contentLength: number,
  expectedSha256: string,
): Promise<boolean> {
  const digest = createHash("sha256");
  let total = 0;
  try {
    for await (const chunk of content) {
      total += chunk.byteLength;
      if (total > contentLength) return false;
      digest.update(chunk);
    }
  } catch {
    return false;
  }
  return total === contentLength && digest.digest("hex") === expectedSha256;
}

function isSupportedScopeSelection(scopes: readonly string[]): boolean {
  const supportedOrder = ["portfolio-content", "taxonomy", "portfolio-configuration"];
  const canonical = supportedOrder.filter((scope) => scopes.includes(scope));
  return canonical.length === scopes.length && canonical.every((scope, index) => scopes[index] === scope) &&
    (scopes.includes("portfolio-content") || scopes.includes("taxonomy") ||
      scopes.length === 1 && scopes[0] === "portfolio-configuration");
}

function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

/**
 * Resumable leased worker for content, taxonomy, and configuration export slices. Snapshot
 * and candidate checkpoints are write-once; external Storage work happens
 * outside database transactions, then readiness and queue completion commit
 * together under the current lease token.
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

  async function processJob(job: {
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
        if (!captured.ok) throw new Error("OWNER_EXPORT_SNAPSHOT_UNAVAILABLE");
        const saved = await deps.exports.saveOwnerExportSnapshot({
          exportId: record.exportId,
          actingJobId: jobId.value,
          leaseToken: job.leaseToken,
          snapshot: captured.value,
        });
        if (!saved.ok || saved.value !== "saved") return "stale";
        snapshot = captured.value;
      }

      const built = snapshot !== null && typeof snapshot === "object" && "kind" in snapshot
        ? await buildSelectedOwnerExportPackage({ exportId: record.exportId, snapshot })
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
      const stored = await deps.storage.writeOwnerExport({
        portfolioId: parsed.portfolioId,
        exportId: record.exportId,
        artifactId,
        content: built.content,
        contentLength: built.contentLength,
        sha256: built.sha256,
      });
      if (!stored.ok) throw new Error("OWNER_EXPORT_STORAGE_WRITE_FAILED");
      const read = await deps.storage.readOwnerExport({
        portfolioId: parsed.portfolioId,
        exportId: record.exportId,
        artifactId,
        expectedSha256: record.candidateSha256!,
        expectedContentLength: record.candidateContentLength!,
      });
      if (!read.ok || read.value.contentLength !== built.contentLength ||
          !await verifyArtifact(read.value.content, built.contentLength, built.sha256)) {
        throw new Error("OWNER_EXPORT_STORAGE_VERIFY_FAILED");
      }
      const completedAt = deps.clock.now();
      const completed = await applyGuardedOwnerExportTransition(deps.exports, {
        exportId: record.exportId,
        fromStatus: "building",
        toStatus: "ready",
        expectedAggregateVersion: record.aggregateVersion,
        leaseToken: job.leaseToken,
        transitionedAt: completedAt,
        expiresAt: effectiveExpiry(completedAt, "kind" in snapshot
          ? snapshot.configuration?.policyExpiresAt
          : snapshot.policyExpiresAt),
        actingJobId: jobId.value,
        integrityManifest: built.manifest,
        artifactId,
      });
      return completed.ok && completed.value === "applied" ? "completed" : "stale";
    } catch {
      if (record === null) return "stale";
      if (job.attemptCount >= 5) {
        const failed = await failExport(record, { jobId: jobId.value, leaseToken: job.leaseToken }, PERMANENT_FAILURE);
        return failed;
      }
      const delay = calculateJobRetryDelayMilliseconds(job.attemptCount, deps.random ?? Math.random);
      const retried = await deps.operations.jobs.scheduleRetry(job.jobId, job.leaseToken, RETRY_FAILURE, delay);
      return retried ? "retried" : "stale";
    }
  }

  return {
    async runOwnerExportAssembly(input: { readonly workerId: string }): Promise<Result<OwnerExportAssemblyRunResult, Rejection>> {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.workerId)) {
        return err({ kind: "validation", code: "OWNER_EXPORT_WORKER_CONTEXT_INVALID" });
      }
      try {
        const jobs = await deps.operations.jobs.claimDue({
          workerId: input.workerId,
          now: deps.clock.now(),
          leaseDurationSeconds: LEASE_DURATION_SECONDS,
          limit: CLAIM_LIMIT,
          jobTypes: [OWNER_EXPORT_ASSEMBLY_JOB_TYPE],
        });
        const counts = { claimed: jobs.length, completed: 0, retried: 0, failed: 0, staleLeases: 0 };
        for (const job of jobs) {
          const result = await processJob(job);
          if (result === "completed") counts.completed += 1;
          else if (result === "retried") counts.retried += 1;
          else if (result === "failed") counts.failed += 1;
          else counts.staleLeases += 1;
        }
        return ok(counts);
      } catch {
        return err({ kind: "temporarily_unavailable", code: "OWNER_EXPORT_ASSEMBLY_UNAVAILABLE" });
      }
    },
  };
}
