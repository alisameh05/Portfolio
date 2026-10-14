import { err, ok, parseStableId, type StableId } from "@shared/domain";
import { sql, type Kysely } from "kysely";
import type { TransactionContext, TransactionRunner } from "../../../runtime/ports.js";
import { PostgresInfrastructureError, resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { DB } from "../../../shared/adapters/postgres/database.generated.js";
import type { OwnerMediaAggregateRepositoryPort, OwnerMediaAggregateView, OwnerMediaDecisionView, OwnerMediaProcessingView } from "../application/owner-contracts.js";

const HISTORY_LIMIT = 100;

interface AssetRow {
  readonly media_id: string;
  readonly kind: string;
  readonly original_file_name: string;
  readonly declared_media_type: string;
  readonly declared_byte_length: number | string;
  readonly aggregate_version: number | string;
  readonly current_state: string;
}
interface AttemptRow {
  readonly result: string;
  readonly detected_mime_type: string;
  readonly detected_byte_length: number | string;
  readonly input_sha256: string;
  readonly finding_codes: unknown;
  readonly recorded_at: Date | string;
}
interface DecisionRow { readonly decision: string; readonly decided_at: Date | string; readonly reason: string | null; }

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new PostgresInfrastructureError();
  return date.toISOString();
}

function findings(value: unknown): ReadonlyArray<string> {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed) || parsed.length > 16 || parsed.some((entry) => typeof entry !== "string" || !/^[A-Z0-9_]{1,80}$/u.test(entry))) {
    throw new PostgresInfrastructureError();
  }
  return parsed;
}

async function setScope(context: TransactionContext, scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> }): Promise<void> {
  await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true), set_config('shipwithali.owner_id', ${scope.ownerId}, true)`
    .execute(resolvePostgresTransaction(context));
}

export function createPostgresOwnerMediaAggregateRepository(input: {
  readonly database: Kysely<DB>;
  readonly transactions: TransactionRunner;
  readonly scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> };
}): OwnerMediaAggregateRepositoryPort {
  return {
    async getOwnerMediaAggregate(query) {
      if (query.ownerId !== input.scope.ownerId) return err({ kind: "forbidden", code: "OWNER_SCOPE_MISMATCH" });
      try {
        return await input.transactions.run(async (context) => {
          const executor = resolvePostgresTransaction(context);
          await sql`set transaction isolation level repeatable read`.execute(executor);
          await setScope(context, input.scope);
          const assets = await sql<AssetRow>`
            select a.media_id::text as media_id, a.kind, a.original_file_name, a.declared_media_type,
                   a.declared_byte_length, coalesce(s.aggregate_version, a.aggregate_version) as aggregate_version,
                   case
                     when exists (select 1 from media.rejection_history r where r.media_id = a.media_id
                       and r.portfolio_id = a.portfolio_id and r.owner_id = a.owner_id
                       and r.aggregate_version = coalesce(s.aggregate_version, a.aggregate_version)) then 'rejected'
                     when exists (select 1 from media.decision_history d where d.media_id = a.media_id
                       and d.portfolio_id = a.portfolio_id and d.owner_id = a.owner_id
                       and d.aggregate_version = coalesce(s.aggregate_version, a.aggregate_version) and d.decision = 'accepted') then 'accepted'
                     when exists (select 1 from media.processing_claims c where c.media_id = a.media_id
                       and c.portfolio_id = a.portfolio_id and c.owner_id = a.owner_id
                       and c.lease_expires_at > transaction_timestamp()) then 'processing'
                     when latest.attempt_id is not null then 'processed'
                     else 'upload-pending'
                   end as current_state
              from media.assets a
              left join media.processing_states s on s.media_id = a.media_id
                and s.portfolio_id = a.portfolio_id and s.owner_id = a.owner_id
              left join media.processing_attempts latest on latest.attempt_id = s.latest_attempt_id
             where a.media_id = ${query.mediaId}::uuid and a.portfolio_id = ${input.scope.portfolioId}::uuid
               and a.owner_id = ${input.scope.ownerId}::uuid
             limit 1`.execute(executor);
          const asset = assets.rows[0];
          if (asset === undefined) return err({ kind: "not_found", code: "MEDIA_ASSET_NOT_FOUND" });
          const attempts = await sql<AttemptRow>`
            select result, detected_mime_type, detected_byte_length, input_sha256,
                   finding_codes, finished_at as recorded_at
              from media.processing_attempts
             where media_id = ${query.mediaId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
               and owner_id = ${input.scope.ownerId}::uuid
             order by finished_at desc, attempt_id desc limit ${HISTORY_LIMIT + 1}`.execute(executor);
          const decisions = await sql<DecisionRow>`
            select decision, decided_at, null::text as reason, decision_id::text as order_id
              from media.decision_history
             where media_id = ${query.mediaId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
               and owner_id = ${input.scope.ownerId}::uuid
            union all
            select 'rejected' as decision, rejected_at as decided_at, private_reason as reason, rejection_id::text as order_id
              from media.rejection_history
             where media_id = ${query.mediaId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
               and owner_id = ${input.scope.ownerId}::uuid
             order by decided_at desc, order_id desc limit ${HISTORY_LIMIT + 1}`.execute(executor);
          const mediaId = parseStableId("MediaAsset", asset.media_id);
          const aggregateVersion = Number(asset.aggregate_version);
          const byteLength = Number(asset.declared_byte_length);
          if (!mediaId.ok || !["image", "video", "document"].includes(asset.kind) ||
              !["upload-pending", "processing", "processed", "accepted", "rejected"].includes(asset.current_state) ||
              !Number.isSafeInteger(aggregateVersion) || aggregateVersion < 1 || !Number.isSafeInteger(byteLength) || byteLength < 1) {
            throw new PostgresInfrastructureError();
          }
          const processingHistory: OwnerMediaProcessingView[] = attempts.rows.slice(0, HISTORY_LIMIT).map((row) => {
            if ((row.result !== "passed" && row.result !== "failed") || !/^[0-9a-f]{64}$/u.test(row.input_sha256) ||
                !Number.isSafeInteger(Number(row.detected_byte_length)) || Number(row.detected_byte_length) < 0) throw new PostgresInfrastructureError();
            return { result: row.result, detectedMediaType: row.detected_mime_type,
              detectedByteLength: Number(row.detected_byte_length), sha256: row.input_sha256,
              findings: findings(row.finding_codes), recordedAt: iso(row.recorded_at) };
          });
          const decisionHistory: OwnerMediaDecisionView[] = decisions.rows.slice(0, HISTORY_LIMIT).map((row) => {
            if ((row.decision !== "accepted" && row.decision !== "rejected") ||
                (row.decision === "accepted" && row.reason !== null) ||
                (row.decision === "rejected" && (typeof row.reason !== "string" || row.reason.length < 1))) throw new PostgresInfrastructureError();
            return { decision: row.decision, decidedAt: iso(row.decided_at), ...(row.reason === null ? {} : { reason: row.reason }) };
          });
          const view: OwnerMediaAggregateView = {
            mediaId: mediaId.value,
            aggregateVersion,
            kind: asset.kind as OwnerMediaAggregateView["kind"],
            originalFileName: asset.original_file_name,
            declaredMediaType: asset.declared_media_type,
            byteLength,
            state: asset.current_state as OwnerMediaAggregateView["state"],
            processingHistory,
            processingHistoryTruncated: attempts.rows.length > HISTORY_LIMIT,
            decisionHistory,
            decisionHistoryTruncated: decisions.rows.length > HISTORY_LIMIT,
          };
          return ok(view);
        });
      } catch {
        return err({ kind: "temporarily_unavailable", code: "MEDIA_OWNER_READ_FAILED" });
      }
    },
  };
}
