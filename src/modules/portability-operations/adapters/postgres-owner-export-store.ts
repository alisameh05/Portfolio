/**
 * postgres-owner-export-store.ts — Phase 8 #238 durable export request storage.
 *
 * The portability module's own restricted-role adapter over
 * `portability.owner_exports`. Reservations run inside the caller's atomic
 * request transaction and bind the resolved Owner identity to the transaction
 * GUCs before insertion, so the shared queue's insert policy accepts exactly
 * this actor's declared payload. Reads are pure queries over forced row-level
 * security. Guarded state transitions win only when the persisted status and
 * aggregate version still match the writer's expectation, and a winning
 * readiness slice appends the module-owned produced event to the shared
 * outbox inside the same transaction.
 *
 * Provider faults surface as `PostgresInfrastructureError`; the application
 * service maps them to the fail-closed `temporarily_unavailable` rejection.
 * No provider detail ever crosses the seam.
 */

import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";

import { parseStableId, type Result } from "@shared/domain";
import type { DB } from "../../../shared/adapters/postgres/database.generated.js";
import {
  createPostgresTransactionRunner,
  PostgresInfrastructureError,
  resolvePostgresTransaction,
} from "../../../shared/adapters/postgres/runtime.js";
import type { PostgresExecutor } from "../../../shared/adapters/postgres/runtime.js";
import type { ExportStatus } from "../domain/index.js";
import type {
  OutboxPersistencePort,
  SafeErrorCode,
} from "../application/persistence.js";
import { parseSafeErrorCode } from "../application/persistence.js";
import type {
  OwnerExportReservationInput,
  OwnerExportStorePort,
  OwnerExportTransitionInput,
  OwnerExportTransitionOutcome,
  PersistedOwnerExport,
} from "../application/owner-export-store.js";
import { OWNER_EXPORT_ASSEMBLY_JOB_TYPE, type OwnerExportPackageManifest } from "../application/service.js";
import { checkpointOwnerExportSnapshot, type OwnerExportAssemblySnapshot, type OwnerExportConfigurationSnapshot } from "../application/owner-export-package.js";
import type { TransactionContext } from "../../../runtime/ports.js";
import type { OwnerExportArtifactCleanupPort, OwnerExportInvalidationLedgerRecord } from "../application/owner-export-cleanup.js";

export const EXPORT_STATUS_VALUES: readonly ExportStatus[] = [
  "requested", "building", "ready", "failed", "expired",
];

interface ExportRow {
  export_id: string;
  portfolio_id: string;
  owner_id: string;
  included_scopes: string[];
  status: string;
  schema_version: string;
  requested_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  failed_at: Date | string | null;
  expired_at: Date | string | null;
  failure_code: string | null;
  manifest: OwnerExportPackageManifest | null;
  artifact_id: string | null;
  snapshot_id: string | null;
  snapshot_captured_at: Date | string | null;
  configuration_version: number | null;
  snapshot_data: unknown;
  candidate_artifact_id: string | null;
  candidate_sha256: string | null;
  candidate_content_length: number | string | null;
  artifact_sha256: string | null;
  artifact_content_length: number | string | null;
  expires_at: Date | string | null;
  aggregate_version: number;
  artifact_revoked_at: Date | string | null;
  artifact_deleted_at: Date | string | null;
  artifact_revocation_code: string | null;
  database_now?: Date | string;
}

function toIso(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

function validModerationCheckpoint(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const checkpoint = value as Record<string, unknown>;
  if (Object.keys(checkpoint).sort().join(",") !== "dependencies,recordsDigest" ||
      typeof checkpoint["recordsDigest"] !== "string" || !/^[a-f0-9]{64}$/.test(checkpoint["recordsDigest"]) ||
      !Array.isArray(checkpoint["dependencies"])) return false;
  const ids = new Set<string>();
  return checkpoint["dependencies"].every((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const dependency = value as Record<string, unknown>;
    const feedbackId = dependency["feedbackId"], projectId = dependency["projectId"];
    if (Object.keys(dependency).sort().join(",") !== "feedbackId,projectId" ||
        typeof feedbackId !== "string" || !parseStableId("Feedback", feedbackId).ok || ids.has(feedbackId) ||
        typeof projectId !== "string" || !parseStableId("Project", projectId).ok) return false;
    ids.add(feedbackId);
    return true;
  });
}

function parseRow(row: ExportRow): PersistedOwnerExport {
  const exportId = parseStableId("OwnerExport", row.export_id);
  const portfolioId = parseStableId("Portfolio", row.portfolio_id);
  const ownerId = parseStableId("Owner", row.owner_id);
  const artifactId = row.artifact_id === null ? { ok: true as const, value: undefined } : parseStableId("OwnerExportArtifact", row.artifact_id);
  const snapshotId = row.snapshot_id === null ? { ok: true as const, value: undefined } : parseStableId("OwnerExportArtifact", row.snapshot_id);
  const candidateArtifactId = row.candidate_artifact_id === null ? { ok: true as const, value: undefined } : parseStableId("OwnerExportArtifact", row.candidate_artifact_id);
  const status = String(row.status) as ExportStatus;
  if (!exportId.ok || !portfolioId.ok || !ownerId.ok || !artifactId.ok || !snapshotId.ok || !candidateArtifactId.ok || !EXPORT_STATUS_VALUES.includes(status)) {
    throw new PostgresInfrastructureError();
  }
  const artifactRevocationCode = row.artifact_revocation_code;
  if (artifactRevocationCode !== null && artifactRevocationCode !== "expired" && artifactRevocationCode !== "privacy_invalid" &&
      artifactRevocationCode !== "build_failed" && artifactRevocationCode !== "prior_revocation") {
    throw new PostgresInfrastructureError();
  }
  if ((row.artifact_revoked_at === null) !== (artifactRevocationCode === null)) throw new PostgresInfrastructureError();
  let failureCode: SafeErrorCode | undefined;
  if (row.failure_code !== null) {
    try {
      failureCode = parseSafeErrorCode(row.failure_code);
    } catch {
      throw new PostgresInfrastructureError();
    }
  }
  const startedAt = toIso(row.started_at);
  const completedAt = toIso(row.completed_at);
  const failedAt = toIso(row.failed_at);
  const expiredAt = toIso(row.expired_at);
  const snapshotCapturedAt = toIso(row.snapshot_captured_at);
  const expiresAt = toIso(row.expires_at);
  const candidateContentLength = row.candidate_content_length === null ? undefined : Number(row.candidate_content_length);
  const artifactContentLength = row.artifact_content_length === null ? undefined : Number(row.artifact_content_length);
  let snapshot: OwnerExportAssemblySnapshot | undefined;
  if (row.snapshot_data !== null) {
    if (typeof row.snapshot_data !== "object" || Array.isArray(row.snapshot_data) ||
        snapshotId.value === undefined || snapshotCapturedAt === undefined ||
        (row.configuration_version !== null && (!Number.isSafeInteger(row.configuration_version) || row.configuration_version < 1))) {
      throw new PostgresInfrastructureError();
    }
    const data = row.snapshot_data as Record<string, unknown>;
    if (data["snapshotId"] !== snapshotId.value || data["capturedAt"] !== snapshotCapturedAt) throw new PostgresInfrastructureError();
    if (data["kind"] === "owner-export-snapshot-v1") {
      if (!Array.isArray(data["includedScopes"]) || data["includedScopes"].length < 1 ||
          data["includedScopes"].some((scope) => scope !== "portfolio-content" && scope !== "taxonomy" && scope !== "media-metadata" && scope !== "cv-metadata" && scope !== "moderation-history" && scope !== "analytics-reports" && scope !== "portfolio-configuration") ||
          data["moderation"] !== undefined ||
          data["includedScopes"].includes("moderation-history") !== (data["moderationCheckpoint"] !== undefined) ||
          data["moderationCheckpoint"] !== undefined && !validModerationCheckpoint(data["moderationCheckpoint"]) ||
          data["includedScopes"].includes("portfolio-content") !== (data["content"] !== undefined) ||
          data["includedScopes"].includes("taxonomy") !== (data["taxonomy"] !== undefined) ||
          data["includedScopes"].includes("analytics-reports") !== (data["analytics"] !== undefined) ||
          data["includedScopes"].includes("media-metadata") !== (data["media"] !== undefined) ||
          data["includedScopes"].includes("cv-metadata") !== (data["cv"] !== undefined) ||
          data["includedScopes"].includes("cv-metadata") !== (data["cvAssets"] !== undefined) ||
          data["cv"] !== undefined && (!data["cv"] || typeof data["cv"] !== "object" || Array.isArray(data["cv"]) ||
            !Array.isArray((data["cv"] as Record<string, unknown>)["versions"]) ||
            !Array.isArray((data["cv"] as Record<string, unknown>)["acceptanceHistory"]) ||
            !Array.isArray((data["cv"] as Record<string, unknown>)["activationHistory"])) ||
          data["cvAssets"] !== undefined && (!Array.isArray(data["cvAssets"]) || data["cvAssets"].some((asset) => asset === null || typeof asset !== "object" || Array.isArray(asset))) ||
          data["includedScopes"].includes("portfolio-configuration") !== (data["configuration"] !== undefined) ||
          data["content"] !== undefined && (!data["content"] || typeof data["content"] !== "object" || !Array.isArray((data["content"] as Record<string, unknown>)["records"])) ||
          data["taxonomy"] !== undefined && (!data["taxonomy"] || typeof data["taxonomy"] !== "object" || !Array.isArray((data["taxonomy"] as Record<string, unknown>)["records"])) ||
          data["analytics"] !== undefined && (!data["analytics"] || typeof data["analytics"] !== "object" || Array.isArray(data["analytics"]) ||
            !Array.isArray((data["analytics"] as Record<string, unknown>)["records"])) ||
          data["media"] !== undefined && (!data["media"] || typeof data["media"] !== "object" || Array.isArray(data["media"]) ||
            !Array.isArray((data["media"] as Record<string, unknown>)["records"]) || !Array.isArray((data["media"] as Record<string, unknown>)["assets"])) ||
          data["configuration"] !== undefined && (!data["configuration"] || typeof data["configuration"] !== "object")) {
        throw new PostgresInfrastructureError();
      }
      snapshot = data as unknown as OwnerExportAssemblySnapshot;
    } else {
      const capabilities = data["capabilities"];
      if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities) ||
          typeof (capabilities as Record<string, unknown>)["currentCvAvailable"] !== "boolean" ||
          typeof (capabilities as Record<string, unknown>)["externalLinksAvailable"] !== "boolean" ||
          typeof (capabilities as Record<string, unknown>)["globalProjectCtaAvailable"] !== "boolean") {
        throw new PostgresInfrastructureError();
      }
      snapshot = data as unknown as OwnerExportConfigurationSnapshot;
    }
  }
  for (const digest of [row.candidate_sha256, row.artifact_sha256]) {
    if (digest !== null && !/^[a-f0-9]{64}$/.test(digest)) throw new PostgresInfrastructureError();
  }
  for (const length of [candidateContentLength, artifactContentLength]) {
    if (length !== undefined && (!Number.isSafeInteger(length) || length < 1)) throw new PostgresInfrastructureError();
  }
  return {
    exportId: exportId.value,
    portfolioId: portfolioId.value,
    ownerId: ownerId.value,
    includedScopes: [...row.included_scopes] as PersistedOwnerExport["includedScopes"],
    status,
    schemaVersion: row.schema_version,
    aggregateVersion: row.aggregate_version,
    requestedAt: toIso(row.requested_at) ?? "",
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(failedAt === undefined ? {} : { failedAt }),
    ...(expiredAt === undefined ? {} : { expiredAt }),
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(row.manifest === null ? {} : { integrityManifest: row.manifest }),
    ...(artifactId.value === undefined ? {} : { artifactId: artifactId.value }),
    ...(snapshot === undefined ? {} : { snapshot }),
    ...(candidateArtifactId.value === undefined ? {} : { candidateArtifactId: candidateArtifactId.value }),
    ...(row.candidate_sha256 === null ? {} : { candidateSha256: row.candidate_sha256 }),
    ...(candidateContentLength === undefined ? {} : { candidateContentLength }),
    ...(row.artifact_sha256 === null ? {} : { artifactSha256: row.artifact_sha256 }),
    ...(artifactContentLength === undefined ? {} : { artifactContentLength }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(row.artifact_revoked_at == null ? {} : { artifactRevokedAt: toIso(row.artifact_revoked_at)! }),
    ...(row.artifact_deleted_at == null ? {} : { artifactDeletedAt: toIso(row.artifact_deleted_at)! }),
    ...(artifactRevocationCode === null ? {} : { artifactRevocationCode }),
    ...(row.database_now === undefined ? {} : { databaseNow: toIso(row.database_now)! }),
  };
}

const EXPORT_COLUMNS = sql.raw(`export_id, portfolio_id, owner_id, included_scopes, status, schema_version,
  requested_at, started_at, completed_at, failed_at, expired_at, failure_code, manifest, artifact_id,
  snapshot_id, snapshot_captured_at, configuration_version, snapshot_data, candidate_artifact_id,
  candidate_sha256, candidate_content_length, artifact_sha256, artifact_content_length, expires_at, aggregate_version,
  artifact_revoked_at, artifact_deleted_at, artifact_revocation_code`);

export interface PostgresOwnerExportStoreOptions {
  readonly outbox: OutboxPersistencePort;
}

export function createPostgresOwnerExportStore(
  database: Kysely<DB>,
  options: PostgresOwnerExportStoreOptions,
): OwnerExportStorePort & OwnerExportArtifactCleanupPort {
  const { outbox } = options;
  const transactions = createPostgresTransactionRunner(database);

  async function reserveOwnerExport(
    input: OwnerExportReservationInput,
    context: TransactionContext,
  ): Promise<void> {
    const executor = resolvePostgresTransaction(context);
    await sql`select set_config('shipwithali.portfolio_id', ${input.portfolioId}, true),
                     set_config('shipwithali.owner_id', ${input.ownerId}, true)`.execute(executor);
    try {
      await sql`
        insert into portability.owner_exports (
          export_id, portfolio_id, owner_id, included_scopes, status,
          schema_version, requested_at, aggregate_version
        ) values (
          ${input.exportId}::uuid, ${input.portfolioId}::uuid, ${input.ownerId}::uuid,
          ${input.includedScopes}::text[], 'requested',
          ${input.schemaVersion}, ${input.requestedAt}::timestamptz, 1
        )
      `.execute(executor);
    } catch {
      throw new PostgresInfrastructureError();
    }
  }

  async function findOwnerExport(input: {
    readonly exportId: PersistedOwnerExport["exportId"];
    readonly portfolioId: PersistedOwnerExport["portfolioId"];
    readonly ownerId: PersistedOwnerExport["ownerId"];
  }): Promise<PersistedOwnerExport | null> {
    return transactions.run(async (context) => {
      const executor = resolvePostgresTransaction(context);
      try {
        await sql`select set_config('shipwithali.portfolio_id', ${input.portfolioId}, true),
                         set_config('shipwithali.owner_id', ${input.ownerId}, true)`.execute(executor);
        const result = await sql<ExportRow>`
          select ${EXPORT_COLUMNS}, clock_timestamp() as database_now
            from portability.owner_exports
           where export_id = ${input.exportId}::uuid
             and portfolio_id = ${input.portfolioId}::uuid
             and owner_id = ${input.ownerId}::uuid
        `.execute(executor);
        const row = result.rows[0];
        return row === undefined ? null : parseRow(row);
      } catch {
        throw new PostgresInfrastructureError();
      }
    });
  }

  async function lockCurrentLease(executor: PostgresExecutor, input: {
    readonly actingJobId: string;
    readonly leaseToken: string;
    readonly exportId: string;
  }): Promise<boolean> {
    const result = await sql<{ job_id: string }>`
      select job.job_id::text
        from operations.jobs job
        join portability.owner_exports export on export.export_id = ${input.exportId}::uuid
       where job.job_id = ${input.actingJobId}::uuid
         and job.job_type = ${OWNER_EXPORT_ASSEMBLY_JOB_TYPE}
         and job.payload_version = 1
         and job.payload->>'exportId' = export.export_id::text
         and job.payload->>'portfolioId' = export.portfolio_id::text
         and job.payload->>'ownerId' = export.owner_id::text
         and job.payload->'includedScopes' = to_jsonb(export.included_scopes)
         and job.status = 'leased'
         and job.lease_token = ${input.leaseToken}
         and job.lease_expires_at > clock_timestamp()
       for update of job
    `.execute(executor);
    return result.rows.length === 1;
  }

  async function saveOwnerExportSnapshot(input: Parameters<OwnerExportStorePort["saveOwnerExportSnapshot"]>[0]) {
    return transactions.run(async (context) => {
      const executor = resolvePostgresTransaction(context);
      try {
        if (!await lockCurrentLease(executor, input)) return { ok: true as const, value: "stale" as const };
        const updated = await sql`
          update portability.owner_exports
             set snapshot_id = ${input.snapshot.snapshotId}::uuid,
                 snapshot_captured_at = ${input.snapshot.capturedAt}::timestamptz,
                 configuration_version = ${"kind" in input.snapshot
                   ? input.snapshot.configuration?.configurationVersion ?? null
                   : input.snapshot.configurationVersion},
                 snapshot_data = ${JSON.stringify(checkpointOwnerExportSnapshot(input.snapshot))}::jsonb
           where export_id = ${input.exportId}::uuid
             and status = 'building' and snapshot_id is null and snapshot_data is null
        `.execute(executor);
        return { ok: true as const, value: Number(updated.numAffectedRows ?? 0) === 1 ? "saved" as const : "stale" as const };
      } catch {
        throw new PostgresInfrastructureError();
      }
    });
  }

  async function saveOwnerExportCandidate(input: Parameters<OwnerExportStorePort["saveOwnerExportCandidate"]>[0]) {
    if (!/^[a-f0-9]{64}$/.test(input.sha256) || !Number.isSafeInteger(input.contentLength) || input.contentLength < 1) {
      return { ok: false as const, error: { kind: "validation" as const, code: "EXPORT_CANDIDATE_INVALID" } };
    }
    return transactions.run(async (context) => {
      const executor = resolvePostgresTransaction(context);
      try {
        if (!await lockCurrentLease(executor, input)) return { ok: true as const, value: "stale" as const };
        const updated = await sql`
          update portability.owner_exports
             set candidate_artifact_id = ${input.artifactId}::uuid,
                 candidate_sha256 = ${input.sha256},
                 candidate_content_length = ${input.contentLength}
           where export_id = ${input.exportId}::uuid
             and status = 'building' and snapshot_data is not null
             and candidate_artifact_id is null and candidate_sha256 is null
        `.execute(executor);
        return { ok: true as const, value: Number(updated.numAffectedRows ?? 0) === 1 ? "saved" as const : "stale" as const };
      } catch {
        throw new PostgresInfrastructureError();
      }
    });
  }

  async function applyOwnerExportTransition(
    input: OwnerExportTransitionInput,
  ): Promise<Result<OwnerExportTransitionOutcome, never>> {
    return transactions.run(async (context) => {
      const executor = resolvePostgresTransaction(context);
      const failedAt = input.toStatus === "failed" ? input.transitionedAt : null;
      const expiredAt = input.toStatus === "expired" ? input.transitionedAt : null;
      try {
        if (input.toStatus !== "expired" && input.leaseToken === undefined) {
          return { ok: true as const, value: { kind: "stale" as const } };
        }
        if (input.leaseToken !== undefined && !await lockCurrentLease(executor, {
          actingJobId: input.actingJobId,
          leaseToken: input.leaseToken,
          exportId: input.exportId,
        })) {
          return { ok: true as const, value: { kind: "stale" as const } };
        }
        if (input.precondition !== undefined && !await input.precondition(context)) throw new PostgresInfrastructureError();
        const result = await sql<ExportRow>`
          with completion_clock as materialized (select clock_timestamp() as completed_at)
          update portability.owner_exports
             set status = ${input.toStatus},
                 started_at = case
                   when ${input.toStatus} = 'building' then ${input.transitionedAt}::timestamptz
                   else started_at end,
                 completed_at = case
                   when ${input.toStatus} = 'ready' then completion_clock.completed_at
                   else completed_at end,
                 failed_at = ${failedAt}::timestamptz,
                 expired_at = ${expiredAt}::timestamptz,
                 failure_code = ${input.failureCode ?? null},
                 manifest = ${input.integrityManifest === undefined
                   ? null
                   : JSON.stringify(input.integrityManifest) as unknown as string}::jsonb,
                 artifact_id = case when ${input.toStatus} = 'ready' then candidate_artifact_id
                   else ${input.artifactId ?? null}::uuid end,
                 artifact_sha256 = case when ${input.toStatus} = 'ready' then candidate_sha256 else artifact_sha256 end,
                 artifact_content_length = case when ${input.toStatus} = 'ready' then candidate_content_length else artifact_content_length end,
                 expires_at = case when ${input.toStatus} = 'ready'
                   then least(completion_clock.completed_at + interval '7 days',
                     coalesce(${input.policyExpiresAt ?? null}::timestamptz, 'infinity'::timestamptz))
                   else expires_at end,
                 aggregate_version = ${input.expectedAggregateVersion} + 1
           from completion_clock
           where export_id = ${input.exportId}::uuid
             and status = ${input.fromStatus}
             and aggregate_version = ${input.expectedAggregateVersion}
             and (${input.toStatus} <> 'ready' or
               (candidate_artifact_id is not null and candidate_artifact_id = ${input.artifactId ?? null}::uuid
                and candidate_sha256 is not null and candidate_content_length is not null))
          returning ${EXPORT_COLUMNS}
        `.execute(executor);
        const row = result.rows[0];
        if (row === undefined) {
          return { ok: true as const, value: { kind: "stale" as const } };
        }
        const persisted = parseRow(row);
        if (input.toStatus === "ready") {
          const manifest = input.integrityManifest;
          if (manifest === undefined) throw new PostgresInfrastructureError();
          const recordCounts: Record<string, number> = {};
          for (const entry of manifest.entries) {
            recordCounts[entry.scope] = entry.recordCount;
          }
          await outbox.append(context, {
            eventId: randomUUID(),
            payload: {
              type: "portability.export_produced.v1",
              version: 1,
              value: {
                exportId: input.exportId,
                manifest: {
                  schemaVersion: "1.0",
                  exportId: input.exportId,
                  checksumSha256: manifest.digest,
                  recordCounts,
                },
              },
            },
            aggregateId: input.exportId,
            aggregateVersion: input.expectedAggregateVersion + 1,
            correlationId: input.exportId,
            causationId: input.actingJobId,
            occurredAt: persisted.completedAt ?? input.transitionedAt,
            availableAt: persisted.completedAt ?? input.transitionedAt,
          });
        }
        const queueTransition = input.toStatus === "ready" && input.leaseToken !== undefined
          ? await sql`update operations.jobs
                set status = 'completed', completed_at = ${persisted.completedAt ?? input.transitionedAt}::timestamptz,
                    lease_owner = null, lease_token = null, lease_expires_at = null
              where job_id = ${input.actingJobId}::uuid and status = 'leased' and lease_token = ${input.leaseToken}`.execute(executor)
          : input.toStatus === "failed" && input.leaseToken !== undefined
            ? await sql`update operations.jobs
                  set status = 'dead', last_error_code = ${input.failureCode},
                      lease_owner = null, lease_token = null, lease_expires_at = null
                where job_id = ${input.actingJobId}::uuid and status = 'leased' and lease_token = ${input.leaseToken}`.execute(executor)
            : undefined;
        if (queueTransition !== undefined && Number(queueTransition.numAffectedRows ?? 0) !== 1) {
          throw new PostgresInfrastructureError();
        }
        return { ok: true as const, value: { kind: "applied" as const, result: persisted } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    });
  }

  const artifacts: OwnerExportModerationArtifactsPort = {
    async uploadCandidate(input, upload) {
      return transactions.run(async context => {
        const executor = resolvePostgresTransaction(context);
        if (!await lockCurrentLease(executor, input)) return false;
        const locked = await sql`select export_id from portability.owner_exports
          where export_id = ${input.exportId}::uuid and portfolio_id = ${input.portfolioId}::uuid
            and candidate_artifact_id = ${input.artifactId}::uuid and status = 'building'
            and artifact_revoked_at is null for update`.execute(executor);
        if (locked.rows.length !== 1) return false;
        // Retain this row lock across the bounded Storage write/verification.
        // Cleanup cannot acknowledge deletion while an earlier upload is live.
        return upload();
      });
    },
    async listOwnerExportCleanup(input) {
      return transactions.run(async context => {
        const result = await sql<ExportRow>`select ${EXPORT_COLUMNS} from portability.owner_exports
          where portfolio_id = ${input.portfolioId}::uuid and owner_id = ${input.ownerId}::uuid
            and candidate_artifact_id is not null and artifact_deleted_at is null
            and (${input.after ?? null}::uuid is null or export_id > ${input.after ?? null}::uuid)
          order by export_id limit ${input.limit}`.execute(resolvePostgresTransaction(context));
        return result.rows.map(parseRow);
      });
    },
    async revokeOwnerExportArtifact(input) {
      return transactions.run(async context => {
        const executor = resolvePostgresTransaction(context);
        const locked = await sql<ExportRow & { cleanup_now: Date | string }>`select ${EXPORT_COLUMNS}, clock_timestamp() as cleanup_now from portability.owner_exports
          where export_id = ${input.exportId}::uuid and portfolio_id = ${input.portfolioId}::uuid
            and owner_id = ${input.ownerId}::uuid
            and candidate_artifact_id is not null and artifact_deleted_at is null for update`.execute(executor);
        const row = locked.rows[0];
        if (row === undefined) return null;
        const record = parseRow(row);
        if (record.artifactRevokedAt !== undefined) return record;
        if (record.candidateArtifactId === undefined) throw new PostgresInfrastructureError();
        const policyExpiry = record.snapshot !== undefined && 'kind' in record.snapshot ? record.snapshot.policyExpiresAt : undefined;
        const deadline = record.expiresAt ?? policyExpiry;
        const cleanupNow = Date.parse(row.cleanup_now instanceof Date ? row.cleanup_now.toISOString() : row.cleanup_now);
        const expired = deadline !== undefined && cleanupNow >= Date.parse(deadline);
        const stillEligible = record.status === 'failed' || record.status === 'expired' ? false : await input.stillEligible(record, context);
        if (record.status !== 'failed' && record.status !== 'expired' && !expired && stillEligible) return null;
        const revocationCode = record.status === 'failed' ? 'build_failed' : expired || record.status === 'expired' ? 'expired' : 'privacy_invalid';
        const revokedAt = row.cleanup_now instanceof Date ? row.cleanup_now.toISOString() : new Date(row.cleanup_now).toISOString();
        // Only module-owned rows change. The five-state lifecycle is retained;
        // queue redelivery observes a terminal record and cannot resurrect it.
        const updated = await sql<ExportRow>`update portability.owner_exports set
          artifact_revoked_at = ${revokedAt}::timestamptz,
          artifact_revocation_code = ${revocationCode},
          status = case when status = 'ready' then 'expired' when status = 'building' then 'failed' else status end,
          expired_at = case when status = 'ready' then ${revokedAt}::timestamptz else expired_at end,
          failed_at = case when status = 'building' then ${revokedAt}::timestamptz else failed_at end,
          failure_code = case when status = 'building' then 'OWNER_EXPORT_PRIVACY_CHANGED' else failure_code end,
          aggregate_version = aggregate_version + 1
          where export_id = ${input.exportId}::uuid returning ${EXPORT_COLUMNS}`.execute(executor);
        if (updated.rows[0] === undefined) return null;
        await sql`insert into portability.owner_export_invalidation_ledger (
            export_id, portfolio_id, artifact_id, revoked_at, revocation_code
          ) values (${record.exportId}::uuid, ${record.portfolioId}::uuid,
            ${record.candidateArtifactId}::uuid, ${revokedAt}::timestamptz, ${revocationCode})
          on conflict (export_id) do nothing`.execute(executor);
        return parseRow(updated.rows[0]);
      });
    },
    async markOwnerExportArtifactDeleted(input) {
      await transactions.run(async context => {
        const executor = resolvePostgresTransaction(context);
        const deleted = await sql`update portability.owner_exports
            set artifact_deleted_at = greatest(clock_timestamp(), artifact_revoked_at)
          where export_id = ${input.exportId}::uuid and portfolio_id = ${input.portfolioId}::uuid
            and candidate_artifact_id = ${input.artifactId}::uuid and artifact_revoked_at is not null
            and artifact_deleted_at is null and status in ('failed', 'expired')
          `.execute(executor);
        if (Number(deleted.numAffectedRows ?? 0) !== 1) return;
        const ledgerUpdate = await sql`update portability.owner_export_invalidation_ledger as ledger
          set artifact_deleted_at = export.artifact_deleted_at
          from portability.owner_exports as export
          where ledger.export_id = ${input.exportId}::uuid and ledger.portfolio_id = ${input.portfolioId}::uuid
            and ledger.artifact_id = ${input.artifactId}::uuid and ledger.artifact_deleted_at is null
            and export.export_id = ledger.export_id and export.portfolio_id = ledger.portfolio_id
            and export.candidate_artifact_id = ledger.artifact_id and export.artifact_revoked_at = ledger.revoked_at
            and export.artifact_revocation_code = ledger.revocation_code and export.artifact_deleted_at is not null
            and export.status in ('failed', 'expired')`.execute(executor);
        if (Number(ledgerUpdate.numAffectedRows ?? 0) !== 1) throw new PostgresInfrastructureError();
      });
    },
    async listOwnerExportInvalidationLedger(input) {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new TypeError("OWNER_EXPORT_LEDGER_LIMIT_INVALID");
      return transactions.run(async context => {
        const result = await sql<{ export_id: string; portfolio_id: string; artifact_id: string;
          revoked_at: Date | string; revocation_code: string; artifact_deleted_at: Date | string | null }>`
          select export_id, portfolio_id, artifact_id, revoked_at, revocation_code, artifact_deleted_at
            from portability.owner_export_invalidation_ledger
           where (${input.after ?? null}::uuid is null or export_id > ${input.after ?? null}::uuid)
             and (${input.portfolioId ?? null}::uuid is null or portfolio_id = ${input.portfolioId ?? null}::uuid)
           order by export_id limit ${input.limit}
        `.execute(resolvePostgresTransaction(context));
        return result.rows.map((row): OwnerExportInvalidationLedgerRecord => {
          const exportId = parseStableId("OwnerExport", row.export_id);
          const portfolioId = parseStableId("Portfolio", row.portfolio_id);
          const artifactId = parseStableId("OwnerExportArtifact", row.artifact_id);
          if (!exportId.ok || !portfolioId.ok || !artifactId.ok ||
              !["expired", "privacy_invalid", "build_failed", "prior_revocation"].includes(row.revocation_code)) {
            throw new PostgresInfrastructureError();
          }
          const revokedAt = row.revoked_at instanceof Date ? row.revoked_at.toISOString() : new Date(row.revoked_at).toISOString();
          const artifactDeletedAt = row.artifact_deleted_at == null ? undefined :
            row.artifact_deleted_at instanceof Date ? row.artifact_deleted_at.toISOString() : new Date(row.artifact_deleted_at).toISOString();
          return { exportId: exportId.value, portfolioId: portfolioId.value, artifactId: artifactId.value,
            revokedAt, revocationCode: row.revocation_code as OwnerExportInvalidationLedgerRecord["revocationCode"],
            ...(artifactDeletedAt === undefined ? {} : { artifactDeletedAt }) };
        });
      });
    },
  };
  return { reserveOwnerExport, findOwnerExport, saveOwnerExportSnapshot, saveOwnerExportCandidate, applyOwnerExportTransition, ...artifacts };
}
