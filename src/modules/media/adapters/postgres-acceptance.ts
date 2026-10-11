import { createHash } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { err, ok, parseStableId, type ActorContext, type IdempotencyKey, type Rejection, type StableId } from "@shared/domain";
import { sql, type Kysely } from "kysely";
import type { TransactionContext, TransactionRunner } from "../../../runtime/ports.js";
import { PostgresInfrastructureError, resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { DB } from "../../../shared/adapters/postgres/database.generated.js";
import type { AcceptOwnerMediaAssetApplicationCommand } from "../application/owner-contracts.js";
import type { MediaAcceptanceRepositoryFact, MediaAcceptanceRepositoryPort } from "../application/acceptance.js";

interface AcceptanceRow {
  readonly media_id: string; readonly owner_id: string; readonly kind: string;
  readonly declared_media_type: string; readonly declared_byte_length: number | string; readonly declared_sha256: string;
  readonly aggregate_version: number | string; readonly latest_attempt_id: string; readonly result: string;
  readonly input_object_id: string; readonly input_sha256: string; readonly detected_mime_type: string;
  readonly detected_byte_length: number | string; readonly scanner_version: string; readonly processor_version: string;
  readonly policy_version: string; readonly finding_codes: unknown; readonly sealed_outputs: unknown;
}

interface ReplayRow { readonly request_hash: string; readonly aggregate_version: number | string; readonly outcome: string; }

const POLICY_BY_KIND = {
  image: "image-webp-variants-v1",
  video: "mp4-webm-bounded-variants-1",
  document: "pdf-active-content-deny-1",
} as const;

function keyHash(key: IdempotencyKey): string { return createHash("sha256").update(key, "utf8").digest("hex"); }

async function setScope(context: TransactionContext, scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> }): Promise<void> {
  await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true), set_config('shipwithali.owner_id', ${scope.ownerId}, true)`
    .execute(resolvePostgresTransaction(context));
}

function isOwnerActor(actor: ActorContext, ownerId: StableId<"Owner">): boolean {
  return actor.kind === "owner" && actor.ownerId === ownerId;
}

function safeOutputs(value: unknown): ReadonlyArray<Record<string, unknown>> {
  let parsed = value;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed) as unknown; } catch { throw new PostgresInfrastructureError(); }
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 8) throw new PostgresInfrastructureError();
  return parsed.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new PostgresInfrastructureError();
    const record = entry as Record<string, unknown>;
    if (typeof record["objectId"] !== "string" || typeof record["sha256"] !== "string" ||
        typeof record["mimeType"] !== "string" || typeof record["byteLength"] !== "number" ||
        typeof record["objectVersion"] !== "string" || typeof record["variantName"] !== "string") {
      throw new PostgresInfrastructureError();
    }
    const objectId = parseStableId("MediaObject", record["objectId"]);
    if (!objectId.ok || !/^[0-9a-f]{64}$/u.test(record["sha256"]) || !Number.isSafeInteger(record["byteLength"]) || record["byteLength"] < 1) {
      throw new PostgresInfrastructureError();
    }
    return { objectId: objectId.value, sha256: record["sha256"], byteLength: record["byteLength"],
      mimeType: record["mimeType"], objectVersion: record["objectVersion"], variantName: record["variantName"],
      ...(typeof record["width"] === "number" ? { width: record["width"] } : {}),
      ...(typeof record["height"] === "number" ? { height: record["height"] } : {}),
      ...(typeof record["codec"] === "string" ? { codec: record["codec"] } : {}) };
  });
}

function sameAccessibilityKind(kind: string, accessibility: AcceptOwnerMediaAssetApplicationCommand["accessibility"]): boolean {
  return kind === "image" ? accessibility.kind === "described-image" || accessibility.kind === "decorative-image"
    : kind === accessibility.kind;
}

export function createPostgresMediaAcceptanceRepository(input: {
  readonly database: Kysely<DB>;
  readonly transactions: TransactionRunner;
  readonly scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> };
}): MediaAcceptanceRepositoryPort {
  return {
    async accept(command) {
      if (!isOwnerActor(command.actor, input.scope.ownerId)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      const executorScope = input.scope;
      const idempotencyKeyHash = keyHash(command.idempotencyKey);
      try {
        return await input.transactions.run(async (context) => {
          const executor = resolvePostgresTransaction(context);
          await setScope(context, executorScope);
          await sql`select set_config('lock_timeout', '3s', true), set_config('statement_timeout', '5s', true), set_config('transaction_timeout', '5s', true)`.execute(executor);
          await sql`select pg_advisory_xact_lock(hashtextextended(${command.mediaId}::text, 0))`.execute(executor);
          const existing = await sql<ReplayRow>`select request_hash, aggregate_version, outcome from media.acceptance_commands
            where portfolio_id = ${executorScope.portfolioId} and owner_id = ${executorScope.ownerId}
              and media_id = ${command.mediaId} and idempotency_key_hash = ${idempotencyKeyHash}`.execute(executor);
          if (existing.rows[0]) {
            if (existing.rows[0].request_hash !== command.requestHash) return err({ kind: "conflict", code: "IDEMPOTENCY_CONFLICT" });
            if (existing.rows[0].outcome !== "media-accepted") throw new PostgresInfrastructureError();
            return ok({ aggregateId: command.mediaId, aggregateVersion: Number(existing.rows[0].aggregate_version), outcome: "media-accepted" as const });
          }

          const locked = await sql<AcceptanceRow>`
            select a.media_id, a.owner_id, a.kind, a.declared_media_type, a.declared_byte_length, a.declared_sha256,
                   s.aggregate_version, s.latest_attempt_id, attempt.result, attempt.input_object_id, attempt.input_sha256,
                   attempt.detected_mime_type, attempt.detected_byte_length, attempt.scanner_version, attempt.processor_version,
                   attempt.policy_version, attempt.finding_codes,
                   (select jsonb_agg(jsonb_build_object(
                      'objectId', po.object_id, 'sha256', po.sha256, 'byteLength', po.byte_length,
                      'mimeType', po.mime_type, 'objectVersion', po.object_version,
                      'variantName', coalesce(outputs.variant_name, variants.variant_name, 'document'),
                      'width', coalesce(outputs.width, variants.width), 'height', coalesce(outputs.height, variants.height),
                      'codec', outputs.codec
                    ) order by po.object_id)
                      from media.processed_objects po
                      left join media.processing_attempt_outputs outputs on outputs.attempt_id = attempt.attempt_id and outputs.object_id = po.object_id
                      left join media.processing_attempt_variants variants on variants.attempt_id = attempt.attempt_id and variants.object_id = po.object_id
                     where po.media_id = a.media_id and po.portfolio_id = a.portfolio_id and po.owner_id = a.owner_id
                       and po.source_object_id = upload.media_object_id) as sealed_outputs
              from media.assets a
              join media.upload_intents upload on upload.media_id = a.media_id and upload.portfolio_id = a.portfolio_id and upload.owner_id = a.owner_id
              join media.processing_states s on s.media_id = a.media_id and s.portfolio_id = a.portfolio_id and s.owner_id = a.owner_id
              join media.processing_attempts attempt on attempt.attempt_id = s.latest_attempt_id and attempt.media_id = a.media_id
             where a.media_id = ${command.mediaId} and a.portfolio_id = ${executorScope.portfolioId} and a.owner_id = ${executorScope.ownerId}
                and attempt.input_object_id = upload.media_object_id
          `.execute(executor);
          const row = locked.rows[0];
          if (!row) return err({ kind: "not_found", code: "MEDIA_CANDIDATE_NOT_FOUND" });
          if (Number(row.aggregate_version) !== command.expectedVersion) return err({ kind: "precondition_failed", code: "MEDIA_VERSION_MISMATCH" });
          const previousDecision = await sql`select decision_id from media.decision_history
            where media_id = ${command.mediaId} and portfolio_id = ${executorScope.portfolioId} and owner_id = ${executorScope.ownerId}
            limit 1`.execute(executor);
          if (previousDecision.rows.length) return err({ kind: "conflict", code: "MEDIA_INVALID_TRANSITION" });
          if (row.result !== "passed" || row.input_sha256 !== row.declared_sha256 ||
              row.detected_mime_type !== row.declared_media_type || Number(row.detected_byte_length) !== Number(row.declared_byte_length) ||
              row.scanner_version === "unavailable" || row.processor_version === "unavailable" ||
              row.policy_version !== POLICY_BY_KIND[row.kind as keyof typeof POLICY_BY_KIND] ||
              !Array.isArray(row.finding_codes) || row.finding_codes.length !== 0) {
            return err({ kind: "conflict", code: "MEDIA_PROCESSING_EVIDENCE_INVALID" });
          }
          if (!sameAccessibilityKind(row.kind, command.accessibility)) {
            return err({ kind: "validation", code: "MEDIA_ACCESSIBILITY_KIND_MISMATCH" });
          }
          const sealedOutputs = safeOutputs(row.sealed_outputs);
          const aggregateVersion = Number(row.aggregate_version) + 1;
          const decisionId = uuidv7();
          await sql`insert into media.decision_history
            (decision_id, portfolio_id, owner_id, media_id, aggregate_version, decision, processing_attempt_id,
             input_object_id, input_sha256, detected_mime_type, detected_byte_length, scanner_version, processor_version,
             processing_policy_version, sealed_outputs, accessibility, ownership_attested_by, ownership_attested_at,
             public_suitability_attested_by, public_suitability_attested_at, decided_by, decided_at)
            values (${decisionId}, ${executorScope.portfolioId}, ${executorScope.ownerId}, ${command.mediaId}, ${aggregateVersion}, 'accepted',
             ${row.latest_attempt_id}, ${row.input_object_id}, ${row.input_sha256}, ${row.detected_mime_type}, ${Number(row.detected_byte_length)},
             ${row.scanner_version}, ${row.processor_version}, ${row.policy_version}, ${JSON.stringify(sealedOutputs)}::jsonb,
             ${JSON.stringify(command.accessibility)}::jsonb, ${executorScope.ownerId}, transaction_timestamp(),
             ${executorScope.ownerId}, transaction_timestamp(), ${executorScope.ownerId}, transaction_timestamp())`.execute(executor);
          const changed = await sql`update media.processing_states set aggregate_version = ${aggregateVersion}, updated_at = transaction_timestamp()
            where media_id = ${command.mediaId} and portfolio_id = ${executorScope.portfolioId} and owner_id = ${executorScope.ownerId}
              and aggregate_version = ${command.expectedVersion} and latest_attempt_id = ${row.latest_attempt_id}`.execute(executor);
          if (Number(changed.numAffectedRows ?? 0n) !== 1) throw new PostgresInfrastructureError();
          await sql`insert into media.acceptance_commands
            (portfolio_id, owner_id, media_id, idempotency_key_hash, request_hash, aggregate_version, outcome)
            values (${executorScope.portfolioId}, ${executorScope.ownerId}, ${command.mediaId}, ${idempotencyKeyHash}, ${command.requestHash}, ${aggregateVersion}, 'media-accepted')`.execute(executor);
          await sql`insert into operations.outbox_events (event_id, event_type, schema_version, aggregate_id, aggregate_version,
              payload, correlation_id, occurred_at, available_at)
            values (${uuidv7()}, 'media.asset_accepted.v1', 1, ${command.mediaId}, ${aggregateVersion},
              ${JSON.stringify({ mediaId: command.mediaId })}::jsonb, ${idempotencyKeyHash}, transaction_timestamp(), transaction_timestamp())`.execute(executor);
          return ok({ aggregateId: command.mediaId, aggregateVersion, outcome: "media-accepted" as const });
        });
      } catch {
        return err({ kind: "temporarily_unavailable", code: "MEDIA_ACCEPTANCE_COMMIT_FAILED" });
      }
    },

    async getAcceptanceFacts(query, transaction) {
      if (query.ownerId !== input.scope.ownerId) return err({ kind: "forbidden", code: "OWNER_SCOPE_MISMATCH" });
      const executor = resolvePostgresTransaction(transaction);
      try {
        await setScope(transaction, input.scope);
          for (const mediaAssetId of [...new Set(query.mediaAssetIds)].sort()) {
            await sql`select pg_advisory_xact_lock_shared(hashtextextended(${mediaAssetId}::text, 0))`.execute(executor);
          }
        const rows = await sql<{
          readonly media_id: string; readonly owner_id: string; readonly asset_version: number | string;
          readonly accepted: boolean; readonly safe: boolean; readonly suitable: boolean; readonly accessible: boolean;
          readonly policy_version: string | null;
        }>`
          select a.media_id, a.owner_id, coalesce(s.aggregate_version, a.aggregate_version) as asset_version,
                 coalesce(latest.result = 'passed' and latest.input_object_id = upload.media_object_id
                   and latest.input_sha256 = a.declared_sha256 and latest.detected_mime_type = a.declared_media_type
                   and latest.detected_byte_length = a.declared_byte_length
                   and latest.policy_version = case a.kind when 'image' then 'image-webp-variants-v1'
                     when 'video' then 'mp4-webm-bounded-variants-1' when 'document' then 'pdf-active-content-deny-1' end
                   and jsonb_array_length(latest.finding_codes) = 0
                   and exists (select 1 from media.processed_objects po where po.media_id = a.media_id
                     and po.portfolio_id = a.portfolio_id and po.owner_id = a.owner_id and po.source_object_id = upload.media_object_id), false) as safe,
                 coalesce(decision.decision = 'accepted' and decision.aggregate_version = s.aggregate_version, false) as accepted,
                 coalesce(decision.decision = 'accepted' and decision.aggregate_version = s.aggregate_version
                   and decision.ownership_attested_by = a.owner_id and decision.public_suitability_attested_by = a.owner_id, false) as suitable,
                 coalesce(decision.decision = 'accepted' and decision.aggregate_version = s.aggregate_version
                   and jsonb_typeof(decision.accessibility) = 'object'
                   and case a.kind
                     when 'image' then decision.accessibility->>'kind' in ('described-image', 'decorative-image')
                       and (${query.intendedUse} = 'decorative' or decision.accessibility->>'kind' <> 'decorative-image')
                     when 'video' then decision.accessibility->>'kind' = 'video'
                     when 'document' then decision.accessibility->>'kind' = 'document'
                     else false end, false) as accessible,
                 latest.policy_version
            from media.assets a
            left join media.upload_intents upload on upload.media_id = a.media_id and upload.portfolio_id = a.portfolio_id and upload.owner_id = a.owner_id
            left join media.processing_states s on s.media_id = a.media_id and s.portfolio_id = a.portfolio_id and s.owner_id = a.owner_id
            left join media.processing_attempts latest on latest.attempt_id = s.latest_attempt_id and latest.media_id = a.media_id
            left join media.decision_history decision on decision.media_id = a.media_id and decision.portfolio_id = a.portfolio_id
              and decision.owner_id = a.owner_id and decision.aggregate_version = s.aggregate_version
           where a.owner_id = ${query.ownerId} and a.portfolio_id = ${input.scope.portfolioId} and a.media_id = any(${query.mediaAssetIds}::uuid[])
            order by a.media_id
        `.execute(executor);
        const facts: MediaAcceptanceRepositoryFact[] = rows.rows.map((row) => {
          const mediaAssetId = parseStableId("MediaAsset", row.media_id);
          const ownerId = parseStableId("Owner", row.owner_id);
          if (!mediaAssetId.ok || !ownerId.ok) throw new PostgresInfrastructureError();
          return { mediaAssetId: mediaAssetId.value, ownerId: ownerId.value, assetVersion: Number(row.asset_version),
            accepted: row.accepted, safe: row.safe, suitable: row.suitable, accessible: row.accessible,
            policyVersion: row.policy_version };
        });
        if (facts.length !== new Set(query.mediaAssetIds).size) return err({ kind: "validation", code: "MEDIA_ACCEPTANCE_FACTS_INCOMPLETE" });
        return ok(facts);
      } catch {
        return err({ kind: "temporarily_unavailable", code: "MEDIA_ACCEPTANCE_FACTS_UNAVAILABLE" });
      }
    },
  };
}
