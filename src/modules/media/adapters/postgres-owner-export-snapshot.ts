import { err, ok, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import { sql, type Kysely } from "kysely";
import type { TransactionContext, TransactionRunner } from "../../../runtime/ports.js";
import { PostgresInfrastructureError, resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { DB } from "../../../shared/adapters/postgres/database.generated.js";
import type { OwnerMediaExportSnapshot, OwnerMediaExportSnapshotReaderPort } from "../application/owner-contracts.js";

const HISTORY_LIMIT = 100;
const MAX_MEDIA_EXPORT_ROWS = 10_000;

interface AssetRow {
  readonly media_id: string;
  readonly kind: string;
  readonly aggregate_version: number | string;
  readonly state: string;
}
interface ProcessingRow {
  readonly media_id: string;
  readonly result: string;
  readonly detected_mime_type: string;
  readonly detected_byte_length: number | string;
  readonly input_sha256: string;
  readonly finding_codes: unknown;
  readonly recorded_at: Date | string;
}
interface DecisionRow {
  readonly media_id: string;
  readonly aggregate_version: number | string;
  readonly decision: string;
  readonly decided_at: Date | string;
  readonly reason_code: string | null;
}
interface AcceptanceRow {
  readonly media_id: string;
  readonly aggregate_version: number | string;
  readonly decided_at: Date | string;
  readonly input_sha256: string;
  readonly detected_mime_type: string;
  readonly detected_byte_length: number | string;
  readonly scanner_version: string;
  readonly processor_version: string;
  readonly processing_policy_version: string;
  readonly accessibility: unknown;
  readonly sealed_outputs: unknown;
}
interface OutputRow {
  readonly media_id: string;
  readonly object_id: string;
  readonly variant_name: string;
  readonly mime_type: string;
  readonly sha256: string;
  readonly byte_length: number | string;
  readonly object_version: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly codec: string | null;
}
interface OriginalRow {
  readonly media_id: string;
  readonly object_id: string;
  readonly upload_intent_id: string;
  readonly detected_mime_type: string;
  readonly detected_byte_length: number | string;
  readonly input_sha256: string;
}

function json(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { throw new PostgresInfrastructureError(); }
}
function iso(value: Date | string): string {
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new PostgresInfrastructureError();
  return result.toISOString();
}
function integer(value: number | string, min = 0): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min) throw new PostgresInfrastructureError();
  return result;
}
function mediaType(value: string): OwnerMediaExportSnapshot["assets"][number]["mediaType"] {
  if (["application/pdf", "image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm"].includes(value)) {
    return value as OwnerMediaExportSnapshot["assets"][number]["mediaType"];
  }
  throw new PostgresInfrastructureError();
}
function boundedHistory<T extends { readonly media_id: string }>(rows: readonly T[], mediaId: string): { rows: T[]; truncated: boolean } {
  const all = rows.filter((row) => row.media_id === mediaId);
  return { rows: all.slice(0, HISTORY_LIMIT), truncated: all.length > HISTORY_LIMIT };
}
function portableVariants(value: unknown, includeBytes: boolean): readonly Record<string, unknown>[] {
  const outputs = json(value);
  if (!Array.isArray(outputs) || outputs.length < 1 || outputs.length > 8) throw new PostgresInfrastructureError();
  return outputs.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new PostgresInfrastructureError();
    const row = item as Record<string, unknown>;
    if (typeof row["variantName"] !== "string" || !/^[a-z0-9-]{1,32}$/.test(row["variantName"]) ||
        typeof row["mimeType"] !== "string" || typeof row["sha256"] !== "string" || !/^[a-f0-9]{64}$/.test(row["sha256"]) ||
        typeof row["objectVersion"] !== "string" || row["objectVersion"] !== row["sha256"]) throw new PostgresInfrastructureError();
    const type = mediaType(row["mimeType"]);
    const byteLength = integer(row["byteLength"] as number | string, 1);
    if (byteLength > 50 * 1024 * 1024) throw new PostgresInfrastructureError();
    return {
      variantName: row["variantName"], mediaType: type, byteLength, digest: row["sha256"],
      byteCoverage: includeBytes ? "included" : "excluded",
      ...(includeBytes ? { portableReference: `assets/media-metadata/sha256/${row["sha256"]}` } : {}),
      ...(Number.isSafeInteger(row["width"]) && Number(row["width"]) > 0 ? { width: row["width"] } : {}),
      ...(Number.isSafeInteger(row["height"]) && Number(row["height"]) > 0 ? { height: row["height"] } : {}),
      ...(typeof row["codec"] === "string" ? { codec: row["codec"] } : {}),
    };
  }).sort((left, right) => String(left["variantName"]).localeCompare(String(right["variantName"])));
}

/** Reads only Media-owned export facts under the purpose-specific worker RLS policy. */
export function createPostgresOwnerMediaExportSnapshotReader(input: {
  readonly database: Kysely<DB>;
  readonly transactions: TransactionRunner;
}): OwnerMediaExportSnapshotReaderPort {
  return {
    async readOwnerMediaExportSnapshot(scope, context): Promise<Result<OwnerMediaExportSnapshot, Rejection>> {
      const executor = resolvePostgresTransaction(context);
      try {
        await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
                         set_config('shipwithali.owner_id', ${scope.ownerId}, true),
                         set_config('shipwithali.worker_purpose', 'media.owner-export', true),
                         set_config('statement_timeout', '15s', true)`.execute(executor);
        const stamp = await sql<{ captured_at: Date | string }>`select transaction_timestamp() as captured_at`.execute(executor);
        const capturedAt = stamp.rows[0]?.captured_at;
        if (capturedAt === undefined) throw new PostgresInfrastructureError();
        const assets = await sql<AssetRow>`
          select a.media_id::text as media_id, a.kind,
                 coalesce(state.aggregate_version, a.aggregate_version) as aggregate_version,
                 case
                   when exists (select 1 from media.rejection_history rejected
                     where rejected.media_id = a.media_id and rejected.portfolio_id = a.portfolio_id
                       and rejected.owner_id = a.owner_id
                       and rejected.aggregate_version = coalesce(state.aggregate_version, a.aggregate_version)) then 'rejected'
                   when exists (select 1 from media.decision_history accepted
                     where accepted.media_id = a.media_id and accepted.portfolio_id = a.portfolio_id
                       and accepted.owner_id = a.owner_id and accepted.decision = 'accepted'
                       and accepted.aggregate_version = coalesce(state.aggregate_version, a.aggregate_version)) then 'accepted'
                   when exists (select 1 from media.processing_claims claim
                     where claim.media_id = a.media_id and claim.portfolio_id = a.portfolio_id
                       and claim.owner_id = a.owner_id and claim.lease_expires_at > transaction_timestamp()) then 'processing'
                   when state.latest_attempt_id is not null then 'processed'
                   else 'upload-pending'
                 end as state
            from media.assets a
            left join media.processing_states state on state.media_id = a.media_id
              and state.portfolio_id = a.portfolio_id and state.owner_id = a.owner_id
           where a.portfolio_id = ${scope.portfolioId}::uuid and a.owner_id = ${scope.ownerId}::uuid
           order by a.media_id limit ${MAX_MEDIA_EXPORT_ROWS + 1}
        `.execute(executor);
        if (assets.rows.length > MAX_MEDIA_EXPORT_ROWS) throw new PostgresInfrastructureError();
        const ids = assets.rows.map((row) => row.media_id);
        if (ids.length === 0) return ok({ capturedAt: iso(capturedAt), records: [], assets: [] });
        const processing = await sql<ProcessingRow>`
          with ranked as (
            select media_id, result, detected_mime_type, detected_byte_length, input_sha256, finding_codes,
                   finished_at as recorded_at, attempt_id,
                   row_number() over (partition by media_id order by finished_at desc, attempt_id desc) as history_order
              from media.processing_attempts
             where portfolio_id = ${scope.portfolioId}::uuid and owner_id = ${scope.ownerId}::uuid and media_id = any(${ids}::uuid[])
          )
          select media_id::text, result, detected_mime_type, detected_byte_length, input_sha256, finding_codes, recorded_at
            from ranked where history_order <= ${HISTORY_LIMIT + 1}
           order by media_id, history_order
        `.execute(executor);
        const decisions = await sql<DecisionRow>`
          with all_decisions as (
            select media_id, aggregate_version, decision, decided_at, reason_code
              from media.decision_history
             where portfolio_id = ${scope.portfolioId}::uuid and owner_id = ${scope.ownerId}::uuid and media_id = any(${ids}::uuid[])
            union all
            select media_id, aggregate_version, 'rejected', rejected_at, reason_code
              from media.rejection_history
             where portfolio_id = ${scope.portfolioId}::uuid and owner_id = ${scope.ownerId}::uuid and media_id = any(${ids}::uuid[])
          ), ranked as (
            select *, row_number() over (partition by media_id order by decided_at desc, aggregate_version desc) as history_order
              from all_decisions
          )
          select media_id::text, aggregate_version, decision, decided_at, reason_code
            from ranked where history_order <= ${HISTORY_LIMIT + 1}
           order by media_id, history_order
        `.execute(executor);
        const acceptances = await sql<AcceptanceRow>`
          with ranked as (
            select media_id, aggregate_version, decided_at, input_sha256, detected_mime_type,
                   detected_byte_length, scanner_version, processor_version, processing_policy_version,
                   accessibility, sealed_outputs,
                   row_number() over (partition by media_id order by aggregate_version desc) as history_order
              from media.decision_history
             where portfolio_id = ${scope.portfolioId}::uuid and owner_id = ${scope.ownerId}::uuid
               and media_id = any(${ids}::uuid[]) and decision = 'accepted'
          )
          select media_id::text, aggregate_version, decided_at, input_sha256, detected_mime_type,
                 detected_byte_length, scanner_version, processor_version, processing_policy_version,
                 accessibility, sealed_outputs
            from ranked where history_order <= ${HISTORY_LIMIT + 1}
           order by media_id, history_order
        `.execute(executor);
        const outputRows = await sql<OutputRow>`
          with latest_accepted as (
            select distinct on (decision.media_id) decision.media_id, decision.portfolio_id, decision.owner_id,
                   decision.aggregate_version, decision.sealed_outputs
              from media.decision_history decision
              join media.processing_states state on state.media_id = decision.media_id
                and state.portfolio_id = decision.portfolio_id and state.owner_id = decision.owner_id
                and state.aggregate_version = decision.aggregate_version
             where decision.portfolio_id = ${scope.portfolioId}::uuid and decision.owner_id = ${scope.ownerId}::uuid
               and decision.media_id = any(${ids}::uuid[]) and decision.decision = 'accepted'
             order by decision.media_id, decision.aggregate_version desc
          )
          select accepted.media_id::text, object.object_id::text,
                 sealed.value->>'variantName' as variant_name, object.mime_type as mime_type,
                 object.sha256, object.byte_length, object.object_version,
                 coalesce(video.width, image.width) as width,
                 coalesce(video.height, image.height) as height, video.codec
            from latest_accepted accepted
            cross join lateral jsonb_array_elements(accepted.sealed_outputs) sealed(value)
            join media.processed_objects object on object.object_id = (sealed.value->>'objectId')::uuid
              and object.media_id = accepted.media_id and object.portfolio_id = accepted.portfolio_id and object.owner_id = accepted.owner_id
              and object.sha256 = sealed.value->>'sha256' and object.object_version = sealed.value->>'objectVersion'
              and object.mime_type = sealed.value->>'mimeType' and object.byte_length = (sealed.value->>'byteLength')::bigint
            left join media.processing_attempt_outputs video on video.object_id = object.object_id and video.media_id = object.media_id
            left join media.processing_attempt_variants image on image.object_id = object.object_id and image.media_id = object.media_id
           order by accepted.media_id, sealed.value->>'variantName'
        `.execute(executor);
        const originalRows = await sql<OriginalRow>`
          select decision.media_id::text, decision.input_object_id::text as object_id,
                 upload.upload_intent_id::text, decision.detected_mime_type,
                 decision.detected_byte_length, decision.input_sha256
            from media.decision_history decision
            join media.processing_states state on state.media_id = decision.media_id
              and state.portfolio_id = decision.portfolio_id and state.owner_id = decision.owner_id
              and state.aggregate_version = decision.aggregate_version
            left join media.upload_intents upload on upload.media_id = decision.media_id
              and upload.portfolio_id = decision.portfolio_id and upload.owner_id = decision.owner_id
              and upload.media_object_id = decision.input_object_id
           where decision.portfolio_id = ${scope.portfolioId}::uuid and decision.owner_id = ${scope.ownerId}::uuid
             and decision.media_id = any(${ids}::uuid[]) and decision.decision = 'accepted'
           order by decision.media_id
        `.execute(executor);
        const outputsByMedia = new Map<string, OutputRow[]>();
        for (const row of outputRows.rows) outputsByMedia.set(row.media_id, [...(outputsByMedia.get(row.media_id) ?? []), row]);
        const originalsByMedia = new Map<string, OriginalRow>();
        for (const row of originalRows.rows) {
          if (originalsByMedia.has(row.media_id) || !row.upload_intent_id) throw new PostgresInfrastructureError();
          originalsByMedia.set(row.media_id, row);
        }
        const portableAssets: OwnerMediaExportSnapshot["assets"][number][] = [];
        const records = assets.rows.map((asset) => {
          const mediaId = parseStableId("MediaAsset", asset.media_id);
          const version = integer(asset.aggregate_version, 1);
          if (!mediaId.ok || !["image", "video", "document"].includes(asset.kind) ||
              !["upload-pending", "processing", "processed", "accepted", "rejected"].includes(asset.state)) throw new PostgresInfrastructureError();
          const processHistory = boundedHistory(processing.rows, asset.media_id);
          const decisionHistory = boundedHistory(decisions.rows, asset.media_id);
          const acceptanceHistory = boundedHistory(acceptances.rows, asset.media_id);
          const currentOutputs = asset.state === "accepted" ? (outputsByMedia.get(asset.media_id) ?? []) : [];
          if (asset.state === "accepted" && currentOutputs.length === 0) throw new PostgresInfrastructureError();
          const currentAccepted = acceptanceHistory.rows.find((row) => Number(row.aggregate_version) === version);
          const accessibility = currentAccepted === undefined ? null : json(currentAccepted.accessibility);
          const accessibilityKind = accessibility !== null && typeof accessibility === "object" && !Array.isArray(accessibility)
            ? (accessibility as Record<string, unknown>)["kind"] : undefined;
          const publicationEligible = asset.state === "accepted" &&
            (asset.kind === "image" ? accessibilityKind === "described-image" || accessibilityKind === "decorative-image" : accessibilityKind === asset.kind);
          const currentOriginal = asset.state === "accepted" ? originalsByMedia.get(asset.media_id) : undefined;
          if (asset.state === "accepted" && currentOriginal === undefined) throw new PostgresInfrastructureError();
          const originalAsset = currentOriginal === undefined ? undefined : (() => {
            const objectId = parseStableId("MediaObject", currentOriginal.object_id);
            const uploadIntentId = parseStableId("MediaUploadIntent", currentOriginal.upload_intent_id);
            const sha256 = currentOriginal.input_sha256;
            const byteLength = integer(currentOriginal.detected_byte_length, 1);
            if (!objectId.ok || !uploadIntentId.ok || !/^[a-f0-9]{64}$/.test(sha256) || byteLength > 50 * 1024 * 1024) {
              throw new PostgresInfrastructureError();
            }
            const type = mediaType(currentOriginal.detected_mime_type);
            const reference = `assets/media-metadata/sha256/${sha256}`;
            const original = { mediaId: mediaId.value, objectId: objectId.value, source: "original" as const,
              uploadIntentId: uploadIntentId.value, variantName: "original", mediaType: type, byteLength, sha256 };
            portableAssets.push(original);
            const portable = { variantName: "original", mediaType: type, byteLength, digest: sha256, portableReference: reference };
            return { portable, acceptance: { ...portable, byteCoverage: "included" as const } };
          })();
          const portableOutputFacts = currentOutputs.map((row) => {
            const objectId = parseStableId("MediaObject", row.object_id);
            const sha256 = row.sha256;
            const byteLength = integer(row.byte_length, 1);
            if (!objectId.ok || !/^[a-f0-9]{64}$/.test(sha256) || row.object_version !== sha256 ||
                !/^[a-z0-9-]{1,32}$/.test(row.variant_name)) throw new PostgresInfrastructureError();
            const type = mediaType(row.mime_type);
            if (byteLength > 50 * 1024 * 1024) throw new PostgresInfrastructureError();
            const ref = `assets/media-metadata/sha256/${sha256}`;
            portableAssets.push({ mediaId: mediaId.value, objectId: objectId.value, source: "variant",
              variantName: row.variant_name, mediaType: type, byteLength, sha256 });
            return { variantName: row.variant_name, mediaType: type, byteLength, digest: sha256, portableReference: ref,
              ...(row.width === null ? {} : { width: integer(row.width, 1) }),
              ...(row.height === null ? {} : { height: integer(row.height, 1) }),
              ...(row.codec === null ? {} : { codec: row.codec }) };
          });
          const processingHistory = processHistory.rows.map((row) => {
            const findings = json(row.finding_codes);
            if ((row.result !== "passed" && row.result !== "failed") || !Array.isArray(findings) || findings.length > 16 ||
                findings.some((item) => typeof item !== "string" || !/^[A-Z0-9_]{1,80}$/.test(item)) ||
                !/^[a-f0-9]{64}$/.test(row.input_sha256)) throw new PostgresInfrastructureError();
            return { result: row.result, detectedMediaType: row.detected_mime_type,
              detectedByteLength: integer(row.detected_byte_length), sha256: row.input_sha256,
              findings, recordedAt: iso(row.recorded_at) };
          });
          const portableDecisions = decisionHistory.rows.map((row) => ({
            decision: row.decision, decidedAt: iso(row.decided_at),
            ...(row.reason_code === null ? {} : { reason: row.reason_code }),
          }));
          const portableAcceptanceHistory = acceptanceHistory.rows.map((row) => ({
            aggregateVersion: integer(row.aggregate_version, 2), decidedAt: iso(row.decided_at),
            inputSha256: row.input_sha256, detectedMediaType: row.detected_mime_type,
            detectedByteLength: integer(row.detected_byte_length, 1), scannerVersion: row.scanner_version,
            processorVersion: row.processor_version, processingPolicyVersion: row.processing_policy_version,
            accessibilityMetadata: json(row.accessibility),
            byteCoverage: Number(row.aggregate_version) === version && asset.state === "accepted" ? "included" : "excluded",
            variants: [
              ...portableVariants(row.sealed_outputs, Number(row.aggregate_version) === version && asset.state === "accepted"),
              ...(Number(row.aggregate_version) === version && asset.state === "accepted" && originalAsset !== undefined ? [originalAsset.acceptance] : []),
            ].sort((left, right) => String(left["variantName"]).localeCompare(String(right["variantName"]))),
          }));
          const locales: string[] = [];
          const publicationState = asset.state === "rejected" ? "withdrawn" : asset.state === "accepted" ? "accepted" : "private";
          return { mediaId: mediaId.value, value: {
            mediaId: mediaId.value, aggregateVersion: version, kind: asset.kind, state: asset.state,
            locales, accessibilityMetadata: accessibility,
            processingHistory, processingHistoryTruncated: processHistory.truncated,
            decisionHistory: portableDecisions, decisionHistoryTruncated: decisionHistory.truncated,
            acceptanceHistory: portableAcceptanceHistory, acceptanceHistoryTruncated: acceptanceHistory.truncated,
            publicationState, publicationEligibility: publicationEligible ? "eligible" : "ineligible",
            portableAssets: [...(originalAsset === undefined ? [] : [originalAsset.portable]), ...portableOutputFacts], byteCoverage: asset.state === "accepted" ? "included" : "excluded",
            ...(asset.state === "accepted" ? {} : { byteExclusionReason: asset.state === "rejected" ? "rejected-or-withdrawn" : "not-accepted" }),
          } satisfies Record<string, unknown> };
        });
        return ok({ capturedAt: iso(capturedAt), records, assets: portableAssets });
      } catch {
        return err({ kind: "temporarily_unavailable", code: "MEDIA_OWNER_EXPORT_UNAVAILABLE" });
      }
    },
    async revalidateOwnerMediaExportSnapshot(scope, mediaVersions, context) {
      const verify = async (transaction: TransactionContext): Promise<Result<boolean, Rejection>> => {
        try {
          const executor = resolvePostgresTransaction(transaction);
          await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
                           set_config('shipwithali.owner_id', ${scope.ownerId}, true),
                           set_config('shipwithali.worker_purpose', 'media.owner-export', true)`.execute(executor);
          if (mediaVersions.size === 0) return ok(true);
          const ids = [...mediaVersions.keys()].sort();
          // Every Media writer takes this exclusive aggregate lock. Share the
          // same lock until the ready transition commits so rejection or a new
          // acceptance cannot race the final eligibility check. This requires
          // no UPDATE privilege on Media tables.
          for (const mediaId of ids) {
            await sql`select pg_advisory_xact_lock_shared(hashtextextended(${mediaId}::text, 0))`.execute(executor);
          }
          const result = await sql<{ media_id: string; aggregate_version: number | string; state: string }>`
            select a.media_id::text as media_id,
                   coalesce(state.aggregate_version, a.aggregate_version) as aggregate_version,
                   case
                     when exists (select 1 from media.rejection_history rejected where rejected.media_id = a.media_id
                       and rejected.portfolio_id = a.portfolio_id and rejected.owner_id = a.owner_id
                       and rejected.aggregate_version = coalesce(state.aggregate_version, a.aggregate_version)) then 'rejected'
                     when exists (select 1 from media.decision_history accepted where accepted.media_id = a.media_id
                       and accepted.portfolio_id = a.portfolio_id and accepted.owner_id = a.owner_id and accepted.decision = 'accepted'
                       and accepted.aggregate_version = coalesce(state.aggregate_version, a.aggregate_version)) then 'accepted'
                     else 'other'
                   end as state
              from media.assets a join media.processing_states state on state.media_id = a.media_id
               and state.portfolio_id = a.portfolio_id and state.owner_id = a.owner_id
             where a.portfolio_id = ${scope.portfolioId}::uuid and a.owner_id = ${scope.ownerId}::uuid
               and a.media_id = any(${ids}::uuid[])
             order by a.media_id
          `.execute(executor);
          if (result.rows.length !== mediaVersions.size) return ok(false);
          return ok(result.rows.every((row) => mediaVersions.get(row.media_id as StableId<"MediaAsset">) === Number(row.aggregate_version) && row.state === "accepted"));
        } catch {
          return err({ kind: "temporarily_unavailable", code: "MEDIA_OWNER_EXPORT_UNAVAILABLE" });
        }
      };
      if (context !== undefined) return verify(context);
      try { return await input.transactions.run(verify, { isolationLevel: "repeatable read" }); }
      catch { return err({ kind: "temporarily_unavailable", code: "MEDIA_OWNER_EXPORT_UNAVAILABLE" }); }
    },
  };
}
