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
  const status = String(row.status) as ExportStatus;
  if (!exportId.ok || !portfolioId.ok || !ownerId.ok || !artifactId.ok || !EXPORT_STATUS_VALUES.includes(status)) {
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
  return {
    exportId: exportId.value,
    portfolioId: portfolioId.value,
    ownerId: ownerId.value,
    includedScopes: [...row.included_scopes] as PersistedOwnerExport["includedScopes"],
    status,
    schemaVersion: row.schema_version,
    requestedAt: toIso(row.requested_at) ?? "",
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(failedAt === undefined ? {} : { failedAt }),
    ...(expiredAt === undefined ? {} : { expiredAt }),
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(row.manifest === null ? {} : { integrityManifest: row.manifest }),
    ...(artifactId.value === undefined ? {} : { artifactId: artifactId.value }),
  };
}

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
    try {
      const result = await sql<ExportRow>`
        select export_id, portfolio_id, owner_id, included_scopes, status, schema_version,
               requested_at, started_at, completed_at, failed_at, expired_at,
               failure_code, manifest, artifact_id, aggregate_version
          from portability.owner_exports
         where export_id = ${input.exportId}::uuid
           and portfolio_id = ${input.portfolioId}::uuid
           and owner_id = ${input.ownerId}::uuid
      `.execute(database);
      const row = result.rows[0];
      return row === undefined ? null : parseRow(row);
    } catch {
      throw new PostgresInfrastructureError();
    }
  }

  async function applyOwnerExportTransition(
    input: OwnerExportTransitionInput,
  ): Promise<Result<OwnerExportTransitionOutcome, never>> {
    return transactions.run(async (context) => {
      const executor = resolvePostgresTransaction(context);
      const failedAt = input.toStatus === "failed" ? input.transitionedAt : null;
      const expiredAt = input.toStatus === "expired" ? input.transitionedAt : null;
      try {
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
                 artifact_id = ${input.artifactId ?? null}::uuid,
                 aggregate_version = ${input.expectedAggregateVersion} + 1
           where export_id = ${input.exportId}::uuid
             and status = ${input.fromStatus}
             and aggregate_version = ${input.expectedAggregateVersion}
          returning export_id, portfolio_id, owner_id, included_scopes, status, schema_version,
                    requested_at, started_at, completed_at, failed_at, expired_at,
                    failure_code, manifest, artifact_id, aggregate_version
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
        return { ok: true as const, value: { kind: "applied" as const, result: persisted } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    });
  }

  return { reserveOwnerExport, findOwnerExport, applyOwnerExportTransition };
}
