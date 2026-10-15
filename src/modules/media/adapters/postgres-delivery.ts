import { err, parseStableId, type StableId } from "@shared/domain";
import { sql, type Kysely } from "kysely";
import type { TransactionContext } from "../../../runtime/ports.js";
import { PostgresInfrastructureError, resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { DB } from "../../../shared/adapters/postgres/database.generated.js";
import type {
  MediaDeliveryCandidate,
  MediaDeliveryRepositoryPort,
  ResolveMediaDeliveryQuery,
} from "../application/index.js";
import type { MediaAccessibilityMetadata } from "../domain/index.js";

interface DeliveryRow {
  readonly media_id: string;
  readonly owner_id: string;
  readonly asset_version: number | string;
  readonly kind: string;
  readonly decision_accessibility: unknown;
  readonly sealed_output_count: number | string;
  readonly object_id: string;
  readonly variant_name: string;
  readonly sha256: string;
  readonly byte_length: number | string;
  readonly mime_type: string;
  readonly object_version: string;
  readonly width: number | string | null;
  readonly height: number | string | null;
  readonly codec: string | null;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { throw new PostgresInfrastructureError(); }
}

function mapAccessibility(value: unknown, kind: string): MediaAccessibilityMetadata {
  const record = parseJson(value);
  if (record === null || typeof record !== "object" || Array.isArray(record)) throw new PostgresInfrastructureError();
  const fields = record as Record<string, unknown>;
  if (kind === "image" && fields["kind"] === "described-image" && typeof fields["altText"] === "string" && fields["altText"].trim() !== "") {
    return { nonVisualDescription: fields["altText"], isDecorative: false };
  }
  if (kind === "image" && fields["kind"] === "decorative-image") return { isDecorative: true };
  if ((kind === "video" || kind === "document") && fields["kind"] === kind &&
      typeof fields["summary"] === "string" && fields["summary"].trim() !== "") {
    return { summary: fields["summary"], isDecorative: false };
  }
  throw new PostgresInfrastructureError();
}

function number(value: number | string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new PostgresInfrastructureError();
  return parsed;
}

async function setScope(context: TransactionContext, scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> }): Promise<void> {
  await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true), set_config('shipwithali.owner_id', ${scope.ownerId}, true)`
    .execute(resolvePostgresTransaction(context));
}

/** Reads only the latest accepted decision's sealed outputs through the configured Owner RLS scope. */
export function createPostgresMediaDeliveryRepository(input: {
  readonly database: Kysely<DB>;
  readonly scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> };
}): MediaDeliveryRepositoryPort {
  return {
    async getEligibleDeliveryCandidate(query: ResolveMediaDeliveryQuery & { readonly ownerId: StableId<"Owner"> }, transaction) {
      if (query.ownerId !== input.scope.ownerId) return err({ kind: "forbidden", code: "OWNER_SCOPE_MISMATCH" });
      const executor = resolvePostgresTransaction(transaction);
      try {
        await setScope(transaction, input.scope);
        await sql`select set_config('statement_timeout', '3s', true)`.execute(executor);
        const result = await sql<DeliveryRow>`
          with latest_decision as (
            select d.decision_id, d.media_id, d.portfolio_id, d.owner_id, d.aggregate_version,
                   d.decision, d.accessibility, d.sealed_outputs, d.processing_attempt_id
              from media.decision_history d
             where d.media_id = ${query.mediaAssetId}::uuid
               and d.portfolio_id = ${input.scope.portfolioId}::uuid
               and d.owner_id = ${input.scope.ownerId}::uuid
             order by d.aggregate_version desc
             limit 1
          )
          select asset.media_id::text as media_id, asset.owner_id::text as owner_id,
                 state.aggregate_version as asset_version, asset.kind,
                 decision.accessibility as decision_accessibility,
                 jsonb_array_length(decision.sealed_outputs) as sealed_output_count,
                 output.object_id::text as object_id,
                 sealed.value->>'variantName' as variant_name,
                 output.sha256, output.byte_length, output.mime_type, output.object_version,
                 attempt_output.width, attempt_output.height, attempt_output.codec
            from latest_decision decision
            join media.assets asset on asset.media_id = decision.media_id and asset.portfolio_id = decision.portfolio_id
              and asset.owner_id = decision.owner_id
            join media.processing_states state on state.media_id = asset.media_id and state.portfolio_id = asset.portfolio_id
              and state.owner_id = asset.owner_id and state.aggregate_version = decision.aggregate_version
            join media.processing_attempts attempt on attempt.attempt_id = decision.processing_attempt_id
              and attempt.media_id = asset.media_id and attempt.portfolio_id = asset.portfolio_id and attempt.owner_id = asset.owner_id
            cross join lateral jsonb_array_elements(decision.sealed_outputs) sealed(value)
            join media.processed_objects output on output.object_id = (sealed.value->>'objectId')::uuid
              and output.media_id = asset.media_id and output.portfolio_id = asset.portfolio_id and output.owner_id = asset.owner_id
              and output.sha256 = sealed.value->>'sha256' and output.object_version = sealed.value->>'objectVersion'
              and output.mime_type = sealed.value->>'mimeType' and output.byte_length = (sealed.value->>'byteLength')::bigint
            left join media.processing_attempt_outputs attempt_output on attempt_output.attempt_id = attempt.attempt_id
              and attempt_output.object_id = output.object_id
           where decision.decision = 'accepted'
             and attempt.result = 'passed'
             and attempt.input_sha256 = asset.declared_sha256
             and attempt.detected_mime_type = asset.declared_media_type
             and attempt.detected_byte_length = asset.declared_byte_length
             and attempt.scanner_version <> 'unavailable'
             and attempt.processor_version <> 'unavailable'
             and attempt.finding_codes = '[]'::jsonb
             and attempt.policy_version = case asset.kind
               when 'image' then 'image-webp-variants-v1'
               when 'video' then 'mp4-webm-bounded-variants-1'
               when 'document' then 'pdf-active-content-deny-1'
             end
             and (${query.locale} <> 'ar' or ${query.purpose} <> 'current-cv')
             and (${query.purpose} <> 'project' or asset.kind <> 'image' or decision.accessibility->>'kind' = 'described-image')
             and (${query.purpose} <> 'profile' or (asset.kind = 'image' and decision.accessibility->>'kind' = 'described-image'))
           order by sealed.value->>'variantName', output.object_id
           limit 9
        `.execute(executor);
        const rows = result.rows;
        if (rows.length === 0) return err({ kind: "not_found", code: "MEDIA_DELIVERY_NOT_ELIGIBLE" });
        const first = rows[0]!;
        const mediaAssetId = parseStableId("MediaAsset", first.media_id);
        const ownerId = parseStableId("Owner", first.owner_id);
        const assetVersion = Number(first.asset_version);
        const expectedCount = Number(first.sealed_output_count);
        if (!mediaAssetId.ok || !ownerId.ok || ownerId.value !== input.scope.ownerId ||
            !Number.isSafeInteger(assetVersion) || assetVersion < 1 || !Number.isSafeInteger(expectedCount) ||
            expectedCount < 1 || expectedCount > 8 || rows.length !== expectedCount || first.kind === "" ||
            rows.some((row) => row.media_id !== first.media_id || Number(row.asset_version) !== assetVersion)) throw new PostgresInfrastructureError();
        const variants = rows.map((row) => {
          const objectId = parseStableId("MediaObject", row.object_id);
          const byteLength = Number(row.byte_length);
          if (!objectId.ok || !/^[a-z][a-z0-9-]{0,39}$/.test(row.variant_name) ||
              !/^[0-9a-f]{64}$/.test(row.sha256) || !Number.isSafeInteger(byteLength) || byteLength < 1 ||
              row.object_version.length < 1 || row.object_version.length > 255 || row.mime_type.length > 80) throw new PostgresInfrastructureError();
          return {
            objectId: objectId.value,
            name: row.variant_name,
            mimeType: row.mime_type,
            byteLength,
            sha256: row.sha256,
            objectVersion: row.object_version,
            ...(row.width === null ? {} : { width: number(row.width)! }),
            ...(row.height === null ? {} : { height: number(row.height)! }),
            ...(row.codec === null ? {} : { codec: row.codec }),
          };
        });
        const accessibility = mapAccessibility(first.decision_accessibility, first.kind);
        if (query.purpose === "project" && accessibility.isDecorative) return err({ kind: "not_found", code: "MEDIA_DELIVERY_NOT_ELIGIBLE" });
        return { ok: true, value: { mediaAssetId: mediaAssetId.value, ownerId: ownerId.value, assetVersion, accessibility, variants } };
      } catch {
        return err({ kind: "temporarily_unavailable", code: "MEDIA_DELIVERY_UNAVAILABLE" });
      }
    },
  };
}
