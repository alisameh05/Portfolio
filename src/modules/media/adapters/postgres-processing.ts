import { createHash } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { err, ok, parseStableId, type IdempotencyKey, type Rejection, type Result, type StableId } from "@shared/domain";
import { sql, type Kysely } from "kysely";
import type { TransactionContext, TransactionRunner } from "../../../runtime/ports.js";
import { PostgresInfrastructureError, resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { DB } from "../../../shared/adapters/postgres/database.generated.js";
import type { MediaProcessingAttempt, MediaProcessingCandidate, MediaProcessingRepositoryPort } from "../application/processing.js";

interface CandidateRow {
  readonly media_id: string; readonly portfolio_id: string; readonly owner_id: string; readonly kind: string;
  readonly declared_media_type: string; readonly declared_byte_length: string | number; readonly declared_sha256: string;
  readonly original_file_name: string;
  readonly upload_intent_id: string; readonly media_object_id: string; readonly expires_at: Date | string;
  readonly aggregate_version: number | string | null; readonly latest_result: string | null;
}
interface ReplayRow { readonly request_hash: string; readonly aggregate_version: number | string; readonly outcome: string; readonly failure_code: string | null; }
interface LockedRow extends CandidateRow { readonly current_version: number | string; readonly current_result: string | null; }

function keyHash(key: IdempotencyKey): string { return createHash("sha256").update(key, "utf8").digest("hex"); }
function time(value: Date | string): string { const parsed = value instanceof Date ? value : new Date(value); if (!Number.isFinite(parsed.getTime())) throw new PostgresInfrastructureError(); return parsed.toISOString(); }
function asCandidate(row: CandidateRow): MediaProcessingCandidate {
  const mediaId = parseStableId("MediaAsset", row.media_id), portfolioId = parseStableId("Portfolio", row.portfolio_id);
  const ownerId = parseStableId("Owner", row.owner_id), uploadIntentId = parseStableId("MediaUploadIntent", row.upload_intent_id);
  const mediaObjectId = parseStableId("MediaObject", row.media_object_id);
  if (!mediaId.ok || !portfolioId.ok || !ownerId.ok || !uploadIntentId.ok || !mediaObjectId.ok ||
      !["image", "video", "document"].includes(row.kind) || !Number.isSafeInteger(Number(row.declared_byte_length)) ||
      !/^[0-9a-f]{64}$/.test(row.declared_sha256)) throw new PostgresInfrastructureError();
  return { mediaId: mediaId.value, portfolioId: portfolioId.value, ownerId: ownerId.value, kind: row.kind as MediaProcessingCandidate["kind"],
    declaredMimeType: row.declared_media_type, declaredByteLength: Number(row.declared_byte_length), declaredSha256: row.declared_sha256,
    originalFileName: row.original_file_name,
    uploadIntentId: uploadIntentId.value, mediaObjectId: mediaObjectId.value, expiresAt: time(row.expires_at),
    aggregateVersion: Number(row.aggregate_version ?? 1), state: row.latest_result === "passed" ? "processed" : "upload-pending" };
}

async function setScope(context: TransactionContext, scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> }): Promise<void> {
  await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true), set_config('shipwithali.owner_id', ${scope.ownerId}, true)`
    .execute(resolvePostgresTransaction(context));
}

export function createPostgresMediaProcessingRepository(input: {
  readonly database: Kysely<DB>; readonly transactions: TransactionRunner;
  readonly scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> };
}): MediaProcessingRepositoryPort {
  return {
    async getCandidate(query) {
      try {
        return await input.transactions.run(async (context) => {
          const executor = resolvePostgresTransaction(context); await setScope(context, input.scope);
          const rows = await sql<CandidateRow>`
            select a.media_id, a.portfolio_id, a.owner_id, a.kind, a.original_file_name, a.declared_media_type, a.declared_byte_length,
                   a.declared_sha256, i.upload_intent_id, i.media_object_id, i.expires_at,
                   s.aggregate_version, latest.result as latest_result
              from media.assets a join media.upload_intents i on i.media_id = a.media_id
              left join media.processing_states s on s.media_id = a.media_id
              left join media.processing_attempts latest on latest.attempt_id = s.latest_attempt_id
             where a.media_id = ${query.mediaId} and a.owner_id = ${query.ownerId}
             order by i.created_at desc limit 1
          `.execute(executor);
          if (!rows.rows[0]) return err({ kind: "not_found", code: "MEDIA_ASSET_NOT_FOUND" });
          return ok(asCandidate(rows.rows[0]));
        });
      } catch { return err({ kind: "temporarily_unavailable", code: "MEDIA_PROCESSING_UNAVAILABLE" }); }
    },
    async getReplay(query) {
      try {
        return await input.transactions.run(async (context) => {
          const executor = resolvePostgresTransaction(context); await setScope(context, input.scope);
          const rows = await sql<ReplayRow>`select request_hash, aggregate_version, outcome, failure_code from media.processing_commands
            where portfolio_id = ${input.scope.portfolioId} and owner_id = ${query.ownerId} and media_id = ${query.mediaId}
              and idempotency_key_hash = ${keyHash(query.idempotencyKey)} limit 1`.execute(executor);
          const row = rows.rows[0];
          if (!row) return ok({ kind: "missing" } as const);
          if (row.request_hash !== query.requestHash) return ok({ kind: "conflict" } as const);
          return ok({ kind: "replay", version: Number(row.aggregate_version), outcome: row.outcome as "media-processing-recorded", ...(row.failure_code ? { failureCode: row.failure_code } : {}) } as const);
        });
      } catch { return err({ kind: "temporarily_unavailable", code: "MEDIA_PROCESSING_UNAVAILABLE" }); }
    },
    async claimAttempt(query) {
      try {
        return await input.transactions.run(async (context) => {
          const executor = resolvePostgresTransaction(context); await setScope(context, input.scope);
          await sql`set local lock_timeout = '1s'`.execute(executor);
          const key = keyHash(query.idempotencyKey);
          const existing = await sql<ReplayRow>`select request_hash, aggregate_version, outcome, failure_code from media.processing_commands
            where portfolio_id = ${input.scope.portfolioId} and owner_id = ${input.scope.ownerId} and media_id = ${query.candidate.mediaId}
              and idempotency_key_hash = ${key} limit 1`.execute(executor);
          if (existing.rows[0]) {
            if (existing.rows[0].request_hash !== query.requestHash) return ok({ kind: "conflict" } as const);
            const row = existing.rows[0];
            return ok({ kind: "replay", version: Number(row.aggregate_version), outcome: "media-processing-recorded" as const, ...(row.failure_code ? { failureCode: row.failure_code } : {}) } as const);
          }
          await sql`delete from media.processing_claims where portfolio_id = ${input.scope.portfolioId}
            and owner_id = ${input.scope.ownerId} and lease_expires_at <= transaction_timestamp()`.execute(executor);
          const currentRows = await sql<{ readonly current_version: number | string; readonly latest_result: string | null; readonly expired: boolean }>`
            select coalesce(s.aggregate_version, 1) as current_version, latest.result as latest_result,
                   (i.expires_at <= transaction_timestamp()) as expired
              from media.assets a join media.upload_intents i on i.media_id = a.media_id
              left join media.processing_states s on s.media_id = a.media_id
              left join media.processing_attempts latest on latest.attempt_id = s.latest_attempt_id
             where a.media_id = ${query.candidate.mediaId} and a.owner_id = ${input.scope.ownerId}
               and a.portfolio_id = ${input.scope.portfolioId} and i.upload_intent_id = ${query.candidate.uploadIntentId}
               and i.media_object_id = ${query.candidate.mediaObjectId}
          `.execute(executor);
          const current = currentRows.rows[0];
          if (!current) return ok({ kind: "candidate-stale" } as const);
          if (current.expired) return ok({ kind: "expired" } as const);
          if (Number(current.current_version) !== query.expectedVersion) return ok({ kind: "version-mismatch" } as const);
          if (current.latest_result === "passed") return ok({ kind: "invalid-transition" } as const);
          const claimed = await sql`insert into media.processing_claims
              (portfolio_id, owner_id, media_id, idempotency_key_hash, request_hash, claim_id, lease_expires_at)
            values (${input.scope.portfolioId}, ${input.scope.ownerId}, ${query.candidate.mediaId}, ${key}, ${query.requestHash}, ${query.claimId}, transaction_timestamp() + interval '75 seconds')
            on conflict (portfolio_id, owner_id, media_id) do update
              set idempotency_key_hash = excluded.idempotency_key_hash, request_hash = excluded.request_hash,
                  claim_id = excluded.claim_id, lease_expires_at = excluded.lease_expires_at
              where media.processing_claims.lease_expires_at <= transaction_timestamp()
            returning claim_id`.execute(executor);
          if (claimed.rows.length === 1) return ok({ kind: "claimed" } as const);
          const currentClaim = await sql<{ readonly request_hash: string; readonly idempotency_key_hash: string }>`select request_hash, idempotency_key_hash from media.processing_claims
            where portfolio_id = ${input.scope.portfolioId} and owner_id = ${input.scope.ownerId} and media_id = ${query.candidate.mediaId}
          `.execute(executor);
          return ok(currentClaim.rows[0]?.idempotency_key_hash === key && currentClaim.rows[0]?.request_hash !== query.requestHash
            ? { kind: "conflict" } as const : { kind: "in-progress" } as const);
        });
      } catch { return err({ kind: "temporarily_unavailable", code: "MEDIA_PROCESSING_CLAIM_UNAVAILABLE" }); }
    },
    async commitAttempt(query) {
      try {
        return await input.transactions.run(async (context) => {
          const executor = resolvePostgresTransaction(context); await setScope(context, input.scope);
          const timeoutMs = Math.max(1, Math.min(3_000, query.timeoutMs ?? 3_000));
          await sql`select set_config('lock_timeout', ${`${Math.min(1_000, timeoutMs)}ms`}, true)`.execute(executor);
          await sql`select set_config('statement_timeout', ${`${timeoutMs}ms`}, true)`.execute(executor);
          const key = keyHash(query.idempotencyKey);
          const releaseClaim = async () => sql`delete from media.processing_claims where portfolio_id = ${input.scope.portfolioId} and owner_id = ${input.scope.ownerId}
            and media_id = ${query.candidate.mediaId} and idempotency_key_hash = ${key} and claim_id = ${query.claimId}`.execute(executor);
          const existing = await sql<ReplayRow>`select request_hash, aggregate_version, outcome, failure_code from media.processing_commands
            where portfolio_id = ${input.scope.portfolioId} and owner_id = ${input.scope.ownerId} and media_id = ${query.candidate.mediaId}
              and idempotency_key_hash = ${key} limit 1`.execute(executor);
          if (existing.rows[0]) {
            if (existing.rows[0].request_hash !== query.requestHash) return err({ kind: "conflict", code: "IDEMPOTENCY_CONFLICT" });
            return ok({ version: Number(existing.rows[0].aggregate_version), outcome: "media-processing-recorded" as const });
          }
          const claim = await sql`select claim_id from media.processing_claims where portfolio_id = ${input.scope.portfolioId}
            and owner_id = ${input.scope.ownerId} and media_id = ${query.candidate.mediaId} and idempotency_key_hash = ${key}
            and claim_id = ${query.claimId} and lease_expires_at > transaction_timestamp() for update`.execute(executor);
          if (!claim.rows.length) return err({ kind: "temporarily_unavailable", code: "MEDIA_PROCESSING_CLAIM_EXPIRED" });
          await sql`select pg_advisory_xact_lock(hashtextextended(${query.candidate.mediaId}::text, 0))`.execute(executor);
          const locked = await sql<LockedRow>`
            select a.media_id, a.portfolio_id, a.owner_id, a.kind, a.original_file_name, a.declared_media_type, a.declared_byte_length,
                   a.declared_sha256, i.upload_intent_id, i.media_object_id, i.expires_at,
                   coalesce(s.aggregate_version, 1) as current_version,
                   latest.result as current_result
              from media.assets a join media.upload_intents i on i.media_id = a.media_id
              left join media.processing_states s on s.media_id = a.media_id
              left join media.processing_attempts latest on latest.attempt_id = s.latest_attempt_id
             where a.media_id = ${query.candidate.mediaId} and a.owner_id = ${input.scope.ownerId}
               and a.portfolio_id = ${input.scope.portfolioId} and i.upload_intent_id = ${query.candidate.uploadIntentId}
               and i.media_object_id = ${query.candidate.mediaObjectId} and i.expires_at > transaction_timestamp()
          `.execute(executor);
          const row = locked.rows[0];
          if (!row) {
            await releaseClaim();
            return err({ kind: "conflict", code: "MEDIA_CANDIDATE_STALE" });
          }
          if (row.declared_sha256 !== query.candidate.declaredSha256) {
            await releaseClaim();
            return err({ kind: "conflict", code: "MEDIA_CANDIDATE_STALE" });
          }
          if (Number(row.current_version) !== query.expectedVersion) {
            await releaseClaim();
            return err({ kind: "precondition_failed", code: "MEDIA_VERSION_MISMATCH" });
          }
          if (["accepted", "rejected"].includes(row.current_result ?? "")) {
            await releaseClaim();
            return err({ kind: "conflict", code: "MEDIA_INVALID_TRANSITION" });
          }
          const version = Number(row.current_version) + 1;
          if (query.attempt.result === "passed") {
            if (!query.attempt.outputObjectId || !query.attempt.outputSha256 || !query.attempt.outputByteLength) throw new PostgresInfrastructureError();
            if (query.candidate.kind === "image") {
              const variants = query.attempt.variants ?? [];
              const display = variants.find(({ name }) => name === "display");
              if (variants.length !== 2 || !display || display.objectId !== query.attempt.outputObjectId ||
                  display.sha256 !== query.attempt.outputSha256 || display.byteLength !== query.attempt.outputByteLength) throw new PostgresInfrastructureError();
              for (const variant of variants) {
                await sql`insert into media.processed_objects (object_id, portfolio_id, owner_id, media_id, source_object_id, sha256, byte_length, mime_type, object_version)
                  values (${variant.objectId}, ${input.scope.portfolioId}, ${input.scope.ownerId}, ${query.candidate.mediaId},
                    ${query.attempt.inputObjectId}, ${variant.sha256}, ${variant.byteLength}, ${variant.mimeType}, ${variant.sha256})`.execute(executor);
              }
            } else {
            const outputs = query.attempt.outputVariants?.length ? query.attempt.outputVariants : [{
              variantName: "document", objectId: query.attempt.outputObjectId, mimeType: "application/pdf",
              sha256: query.attempt.outputSha256, byteLength: query.attempt.outputByteLength, objectVersion: query.attempt.outputSha256,
            }];
            for (const output of outputs) {
              await sql`insert into media.processed_objects (object_id, portfolio_id, owner_id, media_id, source_object_id, sha256, byte_length, mime_type, object_version)
                values (${output.objectId}, ${input.scope.portfolioId}, ${input.scope.ownerId}, ${query.candidate.mediaId},
                  ${query.attempt.inputObjectId}, ${output.sha256}, ${output.byteLength}, ${output.mimeType}, ${output.objectVersion})`.execute(executor);
            }
            }
          }
          await sql`insert into media.processing_attempts (attempt_id, portfolio_id, owner_id, media_id, input_object_id, input_sha256,
              detected_mime_type, detected_byte_length, result, output_object_id, output_sha256, scanner_version, processor_version,
              policy_version, finding_codes, started_at, finished_at, processing_duration_ms, output_variants)
            values (${query.attempt.attemptId}, ${input.scope.portfolioId}, ${input.scope.ownerId}, ${query.candidate.mediaId},
              ${query.attempt.inputObjectId}, ${query.attempt.sha256}, ${query.attempt.detectedMimeType}, ${query.attempt.detectedByteLength},
              ${query.attempt.result}, ${query.attempt.outputObjectId ?? null}, ${query.attempt.outputSha256 ?? null},
              ${query.attempt.scannerVersion}, ${query.attempt.processorVersion}, ${query.attempt.policyVersion},
              ${JSON.stringify(query.attempt.findings)}::jsonb, ${query.attempt.startedAt}, ${query.attempt.recordedAt},
              ${query.attempt.processingDurationMs ?? null}, ${JSON.stringify(query.attempt.outputVariants ?? [])}::jsonb)`.execute(executor);
          for (const variant of query.attempt.variants ?? []) {
            await sql`insert into media.processing_attempt_variants (attempt_id, object_id, portfolio_id, owner_id, media_id,
                variant_name, source_sha256, width, height)
              values (${query.attempt.attemptId}, ${variant.objectId}, ${input.scope.portfolioId}, ${input.scope.ownerId},
                ${query.candidate.mediaId}, ${variant.name}, ${query.attempt.sha256}, ${variant.width}, ${variant.height})`.execute(executor);
          }
          for (const output of query.attempt.outputVariants ?? []) {
            await sql`insert into media.processing_attempt_outputs (attempt_id, portfolio_id, owner_id, media_id, object_id,
                variant_name, mime_type, sha256, byte_length, object_version, width, height, codec)
              values (${query.attempt.attemptId}, ${input.scope.portfolioId}, ${input.scope.ownerId}, ${query.candidate.mediaId},
                ${output.objectId}, ${output.variantName}, ${output.mimeType}, ${output.sha256}, ${output.byteLength},
                ${output.objectVersion}, ${output.width ?? null}, ${output.height ?? null}, ${output.codec})`.execute(executor);
          }
          await sql`insert into media.processing_states (media_id, portfolio_id, owner_id, aggregate_version, latest_attempt_id, updated_at)
              values (${query.candidate.mediaId}, ${query.candidate.portfolioId}, ${query.candidate.ownerId}, ${version}, ${query.attempt.attemptId}, transaction_timestamp())
            on conflict (media_id) do update set aggregate_version = excluded.aggregate_version,
              latest_attempt_id = excluded.latest_attempt_id, updated_at = excluded.updated_at`.execute(executor);
          const failureCode = query.attempt.temporaryFailure ? query.attempt.findings[0] : null;
          await sql`insert into media.processing_commands (portfolio_id, owner_id, media_id, idempotency_key_hash, request_hash,
              attempt_id, aggregate_version, outcome, failure_code)
            values (${input.scope.portfolioId}, ${input.scope.ownerId}, ${query.candidate.mediaId}, ${key}, ${query.requestHash},
              ${query.attempt.attemptId}, ${version}, 'media-processing-recorded', ${failureCode})`.execute(executor);
          await sql`insert into operations.outbox_events (event_id, event_type, schema_version, aggregate_id, aggregate_version,
              payload, correlation_id, occurred_at, available_at)
            values (${uuidv7()}, 'media.processing_recorded.v1', 1, ${query.candidate.mediaId}, ${version},
              ${JSON.stringify({ mediaId: query.candidate.mediaId, attemptId: query.attempt.attemptId, result: query.attempt.result })}::jsonb,
              ${key}, transaction_timestamp(), transaction_timestamp())`.execute(executor);
          await releaseClaim();
          return ok({ version, outcome: "media-processing-recorded" as const, ...(failureCode ? { failureCode } : {}) });
        });
      } catch { return err({ kind: "temporarily_unavailable", code: "MEDIA_PROCESSING_COMMIT_FAILED" }); }
    },
    async recordOrphan(query) {
      try {
        return await input.transactions.run(async (context) => {
          const executor = resolvePostgresTransaction(context); await setScope(context, input.scope);
          await sql`insert into media.processing_orphans (object_id, portfolio_id, owner_id, media_id, sha256, mime_type)
            values (${query.objectId}, ${query.candidate.portfolioId}, ${query.candidate.ownerId}, ${query.candidate.mediaId}, ${query.sha256}, ${query.mimeType ?? "application/pdf"})
            on conflict (object_id) do nothing`.execute(executor);
          return ok(undefined);
        });
      } catch { return err({ kind: "temporarily_unavailable", code: "MEDIA_ORPHAN_RECORD_FAILED" }); }
    },
    async listOrphans(query) {
      try {
        return await input.transactions.run(async (context) => {
          const executor = resolvePostgresTransaction(context); await setScope(context, input.scope);
          const rows = await sql<{ readonly media_id: string; readonly portfolio_id: string; readonly object_id: string; readonly sha256: string; readonly mime_type: string }>`
            select media_id, portfolio_id, object_id, sha256, mime_type from media.processing_orphans
             where owner_id = ${query.ownerId} and state = 'pending'
             order by created_at, object_id limit ${Math.max(1, Math.min(query.limit, 20))}
          `.execute(executor);
          const result = rows.rows.map((row) => {
            const mediaId = parseStableId("MediaAsset", row.media_id), portfolioId = parseStableId("Portfolio", row.portfolio_id), objectId = parseStableId("MediaObject", row.object_id);
            if (!mediaId.ok || !portfolioId.ok || !objectId.ok || !/^[0-9a-f]{64}$/.test(row.sha256)) throw new PostgresInfrastructureError();
            return { mediaId: mediaId.value, portfolioId: portfolioId.value, objectId: objectId.value, sha256: row.sha256, mimeType: row.mime_type };
          });
          return ok(result);
        });
      } catch { return err({ kind: "temporarily_unavailable", code: "MEDIA_ORPHAN_LIST_FAILED" }); }
    },
    async markOrphanReconciled(query) {
      try {
        return await input.transactions.run(async (context) => {
          const executor = resolvePostgresTransaction(context); await setScope(context, input.scope);
          await sql`update media.processing_orphans set state = 'reconciled', reconciled_at = transaction_timestamp()
             where owner_id = ${query.ownerId} and object_id = ${query.objectId} and state = 'pending'`.execute(executor);
          return ok(undefined);
        });
      } catch { return err({ kind: "temporarily_unavailable", code: "MEDIA_ORPHAN_MARK_FAILED" }); }
    },
  };
}
