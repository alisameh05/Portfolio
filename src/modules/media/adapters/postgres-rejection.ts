import { createHash } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { err, ok, type IdempotencyKey, type Rejection, type Result, type StableId } from "@shared/domain";
import { sql } from "kysely";
import type { TransactionContext, TransactionRunner } from "../../../runtime/ports.js";
import { PostgresInfrastructureError, resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { OwnerMediaCommandReceipt } from "../application/owner-contracts.js";
import type { MediaRejectionRepositoryInput, MediaRejectionRepositoryPort } from "../application/rejection.js";

interface ReplayRow {
  readonly request_hash: string;
  readonly aggregate_version: number | string;
  readonly outcome: string;
}

interface CurrentStateRow {
  readonly aggregate_version: number | string;
  readonly has_processing_state: boolean;
  readonly was_rejected: boolean;
}

function keyHash(key: IdempotencyKey): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

async function setScope(context: TransactionContext, scope: {
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
}): Promise<void> {
  await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
                   set_config('shipwithali.owner_id', ${scope.ownerId}, true)`
    .execute(resolvePostgresTransaction(context));
}

function replayResult(row: ReplayRow, command: MediaRejectionRepositoryInput): Result<OwnerMediaCommandReceipt, Rejection> {
  if (row.request_hash !== command.requestHash) return err({ kind: "conflict", code: "IDEMPOTENCY_CONFLICT" });
  if (row.outcome !== "media-rejected") return err({ kind: "conflict", code: "MEDIA_INVALID_TRANSITION" });
  return ok({ aggregateId: command.mediaId, aggregateVersion: Number(row.aggregate_version), outcome: "media-rejected" });
}

export function createPostgresMediaRejectionRepository(input: {
  readonly transactions: TransactionRunner;
  readonly scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> };
}): MediaRejectionRepositoryPort {
  return {
    async reject(command) {
      if (command.ownerId !== input.scope.ownerId) return err({ kind: "forbidden", code: "OWNER_SCOPE_MISMATCH" });
      const executorScope = input.scope;
      const idempotencyKeyHash = keyHash(command.idempotencyKey);
      try {
        return await input.transactions.run(async (context) => {
          const executor = resolvePostgresTransaction(context);
          await setScope(context, executorScope);
          await sql`select set_config('lock_timeout', '3s', true),
                           set_config('statement_timeout', '5s', true),
                           set_config('transaction_timeout', '10s', true)`.execute(executor);

          // Every Media writer uses this exclusive lock. Content publication,
          // CV registration/approval/activation and acceptance facts use the
          // shared form before taking their own aggregate locks.
          await sql`select pg_advisory_xact_lock(hashtextextended(${command.mediaId}::text, 0))`.execute(executor);

          const prior = await sql<ReplayRow>`select request_hash, aggregate_version, outcome
            from media.acceptance_commands
            where portfolio_id = ${executorScope.portfolioId}::uuid and owner_id = ${executorScope.ownerId}::uuid
              and media_id = ${command.mediaId}::uuid and idempotency_key_hash = ${idempotencyKeyHash}`.execute(executor);
          if (prior.rows[0] !== undefined) return replayResult(prior.rows[0], command);

          const selected = await sql<CurrentStateRow>`select coalesce(state.aggregate_version, asset.aggregate_version) as aggregate_version,
              (state.media_id is not null) as has_processing_state,
              exists (select 1 from media.rejection_history rejection
                where rejection.media_id = asset.media_id and rejection.portfolio_id = asset.portfolio_id
                  and rejection.owner_id = asset.owner_id) as was_rejected
            from media.assets asset
            left join media.processing_states state on state.media_id = asset.media_id
              and state.portfolio_id = asset.portfolio_id and state.owner_id = asset.owner_id
           where asset.media_id = ${command.mediaId}::uuid and asset.portfolio_id = ${executorScope.portfolioId}::uuid
             and asset.owner_id = ${executorScope.ownerId}::uuid`.execute(executor);
          const current = selected.rows[0];
          if (current === undefined) return err({ kind: "not_found", code: "MEDIA_CANDIDATE_NOT_FOUND" });
          const currentVersion = Number(current.aggregate_version);
          if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) throw new PostgresInfrastructureError();
          if (currentVersion !== command.expectedVersion) {
            return { ok: false, error: { kind: "precondition_failed", code: "MEDIA_VERSION_MISMATCH", currentVersion } };
          }
          if (current.was_rejected) return err({ kind: "conflict", code: "MEDIA_INVALID_TRANSITION" });

          // These module-owned reads run on this same connection and transaction
          // while the exclusive Media lock remains held through commit.
          const usage = await command.getUsage(context);
          if (!usage.ok) return usage;
          if (usage.value.hasVisibleContentReference || usage.value.isCurrentCv) {
            return err({ kind: "conflict", code: "MEDIA_IN_USE" });
          }

          const aggregateVersion = currentVersion + 1;
          await sql`insert into media.rejection_history
              (rejection_id, portfolio_id, owner_id, media_id, aggregate_version, reason_code, private_reason, rejected_by)
            values (${uuidv7()}::uuid, ${executorScope.portfolioId}::uuid, ${executorScope.ownerId}::uuid,
              ${command.mediaId}::uuid, ${aggregateVersion}, 'OWNER_REJECTED', ${command.reason}, ${executorScope.ownerId}::uuid)`.execute(executor);
          const changed = current.has_processing_state
            ? await sql`update media.processing_states
                set aggregate_version = ${aggregateVersion}, updated_at = transaction_timestamp()
              where media_id = ${command.mediaId}::uuid and portfolio_id = ${executorScope.portfolioId}::uuid
                and owner_id = ${executorScope.ownerId}::uuid and aggregate_version = ${command.expectedVersion}`.execute(executor)
            : await sql`insert into media.processing_states
                (media_id, portfolio_id, owner_id, aggregate_version, latest_attempt_id, updated_at)
              values (${command.mediaId}::uuid, ${executorScope.portfolioId}::uuid, ${executorScope.ownerId}::uuid,
                ${aggregateVersion}, null, transaction_timestamp())`.execute(executor);
          if (Number(changed.numAffectedRows ?? 0n) !== 1) throw new PostgresInfrastructureError();

          // An in-flight processor may still be working on bytes, but removing
          // its leased claim and advancing the version prevents it committing.
          await sql`delete from media.processing_claims where media_id = ${command.mediaId}::uuid
            and portfolio_id = ${executorScope.portfolioId}::uuid and owner_id = ${executorScope.ownerId}::uuid`.execute(executor);
          await sql`insert into media.acceptance_commands
              (portfolio_id, owner_id, media_id, idempotency_key_hash, request_hash, aggregate_version, outcome)
            values (${executorScope.portfolioId}::uuid, ${executorScope.ownerId}::uuid, ${command.mediaId}::uuid,
              ${idempotencyKeyHash}, ${command.requestHash}, ${aggregateVersion}, 'media-rejected')`.execute(executor);
          await sql`insert into operations.outbox_events
              (event_id, event_type, schema_version, aggregate_id, aggregate_version, payload, correlation_id, occurred_at, available_at)
            values (${uuidv7()}::uuid, 'media.asset_rejected.v1', 1, ${command.mediaId}::uuid, ${aggregateVersion},
              ${JSON.stringify({ mediaAssetId: command.mediaId, reason: "OWNER_REJECTED" })}::jsonb,
              ${idempotencyKeyHash}, transaction_timestamp(), transaction_timestamp())`.execute(executor);
          return ok({ aggregateId: command.mediaId, aggregateVersion, outcome: "media-rejected" });
        });
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "55P03") {
          return err({ kind: "temporarily_unavailable", code: "MEDIA_REJECTION_LOCK_TIMEOUT" });
        }
        return err({ kind: "temporarily_unavailable", code: "MEDIA_REJECTION_COMMIT_FAILED" });
      }
    },
  };
}
