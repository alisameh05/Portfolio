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
import type { OwnerExportPackageManifest } from "../application/service.js";
import type { OwnerExportConfigurationSnapshot } from "../application/owner-export-package.js";
import type { TransactionContext } from "../../../runtime/ports.js";

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
}

function toIso(value: Date | string | null): string | undefined {
  if (value === null) return undefined;
  return value instanceof Date ? value.toISOString() : value;
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
  let snapshot: OwnerExportConfigurationSnapshot | undefined;
  if (row.snapshot_data !== null) {
    if (typeof row.snapshot_data !== "object" || Array.isArray(row.snapshot_data) ||
        snapshotId.value === undefined || snapshotCapturedAt === undefined ||
        (row.configuration_version !== null && (!Number.isSafeInteger(row.configuration_version) || row.configuration_version < 1))) {
      throw new PostgresInfrastructureError();
    }
    const data = row.snapshot_data as Record<string, unknown>;
    const capabilities = data["capabilities"];
    if (data["snapshotId"] !== snapshotId.value || data["capturedAt"] !== snapshotCapturedAt ||
        !capabilities || typeof capabilities !== "object" || Array.isArray(capabilities) ||
        typeof (capabilities as Record<string, unknown>)["currentCvAvailable"] !== "boolean" ||
        typeof (capabilities as Record<string, unknown>)["externalLinksAvailable"] !== "boolean" ||
        typeof (capabilities as Record<string, unknown>)["globalProjectCtaAvailable"] !== "boolean") {
      throw new PostgresInfrastructureError();
    }
    snapshot = data as unknown as OwnerExportConfigurationSnapshot;
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
  };
}

const EXPORT_COLUMNS = sql.raw(`export_id, portfolio_id, owner_id, included_scopes, status, schema_version,
  requested_at, started_at, completed_at, failed_at, expired_at, failure_code, manifest, artifact_id,
  snapshot_id, snapshot_captured_at, configuration_version, snapshot_data, candidate_artifact_id,
  candidate_sha256, candidate_content_length, artifact_sha256, artifact_content_length, expires_at, aggregate_version`);

export interface PostgresOwnerExportStoreOptions {
  readonly outbox: OutboxPersistencePort;
}

export function createPostgresOwnerExportStore(
  database: Kysely<DB>,
  options: PostgresOwnerExportStoreOptions,
): OwnerExportStorePort {
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
          select ${EXPORT_COLUMNS}
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
  }): Promise<boolean> {
    const result = await sql<{ job_id: string }>`
      select job_id::text
        from operations.jobs
       where job_id = ${input.actingJobId}::uuid
         and status = 'leased'
         and lease_token = ${input.leaseToken}
         and lease_expires_at > clock_timestamp()
       for update
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
                 configuration_version = ${input.snapshot.configurationVersion},
                 snapshot_data = ${JSON.stringify(input.snapshot)}::jsonb
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
        if (input.leaseToken !== undefined && !await lockCurrentLease(executor, { actingJobId: input.actingJobId, leaseToken: input.leaseToken })) {
          return { ok: true as const, value: { kind: "stale" as const } };
        }
        const result = await sql<ExportRow>`
          update portability.owner_exports
             set status = ${input.toStatus},
                 started_at = case
                   when ${input.toStatus} = 'building' then ${input.transitionedAt}::timestamptz
                   else started_at end,
                 completed_at = case
                   when ${input.toStatus} = 'ready' then ${input.transitionedAt}::timestamptz
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
                   then coalesce(${input.expiresAt ?? null}::timestamptz, ${input.transitionedAt}::timestamptz + interval '7 days')
                   else expires_at end,
                 aggregate_version = ${input.expectedAggregateVersion} + 1
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
            occurredAt: input.transitionedAt,
            availableAt: input.transitionedAt,
          });
        }
        const queueTransition = input.toStatus === "ready" && input.leaseToken !== undefined
          ? await sql`update operations.jobs
                set status = 'completed', completed_at = ${input.transitionedAt}::timestamptz,
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

  return { reserveOwnerExport, findOwnerExport, saveOwnerExportSnapshot, saveOwnerExportCandidate, applyOwnerExportTransition };
}
