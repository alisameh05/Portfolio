import { sql, type Kysely } from "kysely";
import { parseStableId, type StableId } from "@shared/domain";
import type { DB } from "../../../shared/adapters/postgres/database.generated.js";
import { resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { TransactionRunner } from "../../../runtime/ports.js";
import type { OwnerMediaExportSnapshotReaderPort } from "../../media/index.js";
import type { OwnerCvExportSnapshotReaderPort } from "../../cv-portfolio/index.js";
import type { MediaObjectBackupInventoryPort, OwnerExportObjectBackupInventoryPort } from "../application/owner-object-backup-source.js";

/** Media-owned accepted originals and variants, read through the same RLS-bound seam as Owner exports. */
export function createPostgresMediaObjectBackupInventory(input: {
  readonly reader: OwnerMediaExportSnapshotReaderPort;
  readonly cvReader: OwnerCvExportSnapshotReaderPort;
  readonly transactions: TransactionRunner;
  readonly scope: Readonly<{ portfolioId: StableId<"Portfolio">; ownerId: StableId<"Owner"> }>;
}): MediaObjectBackupInventoryPort {
  return {
    async capture() {
      const captured = await input.transactions.run(async transaction => {
        const media = await input.reader.readOwnerMediaExportSnapshot(input.scope, transaction);
        const cv = await input.cvReader.readOwnerCvExportSnapshot(input.scope, transaction);
        return { media, cv };
      }, { isolationLevel: "repeatable read" });
      const snapshot = captured.media;
      if (!snapshot.ok) throw new Error("OBJECT_BACKUP_MEDIA_INVENTORY_UNAVAILABLE");
      if (!captured.cv.ok) throw new Error("OBJECT_BACKUP_CV_INVENTORY_UNAVAILABLE");
      const capturedAt = snapshot.value.capturedAt;
      const cvRefs = new Map<string, Array<Readonly<{ versionId: string; mediaAssetVersion: number; decisionId: string; sha256: string; objectVersion: string }>>>();
      for (const version of captured.cv.value.versions) {
        if (version.state !== "accepted" || !version.isCurrent) continue;
        const binding = version.acceptedMediaSnapshot;
        if (!binding) throw new Error("OBJECT_BACKUP_CV_BINDING_MISSING");
        const identity = version.mediaId + ":" + binding.mediaObjectId;
        cvRefs.set(identity, [...(cvRefs.get(identity) ?? []), Object.freeze({ versionId: version.versionId,
          mediaAssetVersion: binding.mediaAssetVersion, decisionId: binding.mediaDecisionId, sha256: binding.sha256,
          objectVersion: binding.objectVersion })]);
      }
      const acceptedVersions = new Map<StableId<"MediaAsset">, number>();
      for (const record of snapshot.value.records) {
        if (record.value["state"] !== "accepted" || record.value["byteCoverage"] !== "included" ||
            typeof record.value["aggregateVersion"] !== "number" || !Number.isSafeInteger(record.value["aggregateVersion"])) continue;
        const id = parseStableId("MediaAsset", record.mediaId);
        if (!id.ok) throw new Error("OBJECT_BACKUP_MEDIA_INVENTORY_INVALID");
        acceptedVersions.set(id.value, record.value["aggregateVersion"]);
      }
      const candidates = snapshot.value.assets.map(asset => {
        const assetVersion = acceptedVersions.get(asset.mediaId);
        if (assetVersion === undefined || asset.assetVersion !== assetVersion) throw new Error("OBJECT_BACKUP_MEDIA_INVENTORY_INVALID");
        const cvVersions = cvRefs.get(asset.mediaId + ":" + asset.objectId);
        if (cvVersions?.some(reference => reference.mediaAssetVersion !== asset.assetVersion || reference.decisionId !== asset.decisionId ||
            reference.sha256 !== asset.sha256 || reference.objectVersion !== asset.objectVersion || asset.mediaType !== "application/pdf")) {
          throw new Error("OBJECT_BACKUP_CV_BINDING_MISMATCH");
        }
        return Object.freeze({
          portfolioId: input.scope.portfolioId, mediaId: asset.mediaId, objectId: asset.objectId, source: asset.source,
          ...(cvVersions === undefined ? {} : { cvVersionIds: Object.freeze(cvVersions.map(reference => reference.versionId)) }),
          ...(asset.uploadIntentId === undefined ? {} : { uploadIntentId: asset.uploadIntentId }),
          variantName: asset.variantName, mediaType: asset.mediaType, byteLength: asset.byteLength, sha256: asset.sha256,
          eligibleAt: capturedAt, expiresAt: null,
          async revalidate() {
            const result = await input.reader.revalidateOwnerMediaExportSnapshot(input.scope, new Map([[asset.mediaId, assetVersion]]));
            return result.ok && result.value;
          },
        });
      });
      for (const identity of cvRefs.keys()) {
        const [mediaId, objectId] = identity.split(":");
        if (!candidates.some(candidate => candidate.mediaId === mediaId && candidate.objectId === objectId && candidate.source === "variant")) {
          throw new Error("OBJECT_BACKUP_CV_OBJECT_MISSING");
        }
      }
      return Object.freeze({ sourceWatermarkAt: capturedAt, relationalWatermarkAt: capturedAt, candidates: Object.freeze(candidates) });
    },
  };
}

/** Lists only completed, non-revoked export artifacts that remain inside their original privacy lifetime. */
export function createPostgresOwnerExportObjectBackupInventory(input: {
  readonly database: Kysely<DB>;
  readonly transactions: TransactionRunner;
  readonly scope: Readonly<{ portfolioId: StableId<"Portfolio">; ownerId: StableId<"Owner"> }>;
}): OwnerExportObjectBackupInventoryPort {
  return {
    async listEligible() {
      return input.transactions.run(async transaction => {
        const executor = resolvePostgresTransaction(transaction);
        await sql`select set_config('shipwithali.portfolio_id', ${input.scope.portfolioId}, true),
                         set_config('shipwithali.owner_id', ${input.scope.ownerId}, true),
                         set_config('shipwithali.worker_purpose', 'portability.owner-export-backup', true),
                         set_config('statement_timeout', '15s', true)`.execute(executor);
        const rows = await sql<{
          export_id: string; portfolio_id: string; artifact_id: string; artifact_sha256: string;
          artifact_content_length: number | string; completed_at: Date | string; expires_at: Date | string;
        }>`select export_id::text, portfolio_id::text, artifact_id::text, artifact_sha256,
                  artifact_content_length, completed_at, expires_at
             from portability.owner_exports
            where portfolio_id = ${input.scope.portfolioId}::uuid and owner_id = ${input.scope.ownerId}::uuid
              and status = 'ready' and artifact_id is not null and artifact_sha256 is not null
              and artifact_content_length > 0 and completed_at is not null and expires_at > clock_timestamp()
              and artifact_revoked_at is null and artifact_deleted_at is null
            order by completed_at, export_id`.execute(executor);
        const stamp = await sql<{ captured_at: Date | string }>`select transaction_timestamp() as captured_at`.execute(executor);
        const capturedAt = iso(stamp.rows[0]?.captured_at);
        const candidates = rows.rows.map(row => {
          const exportId = parseStableId("OwnerExport", row.export_id);
          const portfolioId = parseStableId("Portfolio", row.portfolio_id);
          const artifactId = parseStableId("OwnerExportArtifact", row.artifact_id);
          const length = Number(row.artifact_content_length), digest = row.artifact_sha256;
          if (!exportId.ok || !portfolioId.ok || !artifactId.ok || portfolioId.value !== input.scope.portfolioId ||
              !Number.isSafeInteger(length) || length < 1 || length > 67_108_864 || !/^[a-f0-9]{64}$/u.test(digest)) {
            throw new Error("OBJECT_BACKUP_EXPORT_INVENTORY_INVALID");
          }
          const expiresAt = iso(row.expires_at), eligibleAt = iso(row.completed_at);
          return Object.freeze({ portfolioId: portfolioId.value, exportId: exportId.value, artifactId: artifactId.value,
            byteLength: length, sha256: digest, eligibleAt, expiresAt,
            async revalidate() {
              const current = await input.transactions.run(async tx => {
                const checkExecutor = resolvePostgresTransaction(tx);
                await sql`select set_config('shipwithali.portfolio_id', ${input.scope.portfolioId}, true),
                                 set_config('shipwithali.owner_id', ${input.scope.ownerId}, true),
                                 set_config('shipwithali.worker_purpose', 'portability.owner-export-backup', true)`.execute(checkExecutor);
                const check = await sql<{ eligible: boolean }>`select exists (
                  select 1 from portability.owner_exports
                   where export_id = ${exportId.value}::uuid and portfolio_id = ${portfolioId.value}::uuid
                     and owner_id = ${input.scope.ownerId}::uuid and status = 'ready'
                     and artifact_id = ${artifactId.value}::uuid and artifact_sha256 = ${digest}
                     and artifact_content_length = ${length} and completed_at = ${row.completed_at}::timestamptz
                     and expires_at = ${row.expires_at}::timestamptz and expires_at > clock_timestamp()
                     and artifact_revoked_at is null and artifact_deleted_at is null
                ) as eligible`.execute(checkExecutor);
                return check.rows[0]?.eligible === true;
              }, { isolationLevel: "repeatable read" });
              return current;
            },
          });
        });
        return Object.freeze({ capturedAt, candidates: Object.freeze(candidates) });
      }, { isolationLevel: "repeatable read" });
    },
  };
}

function iso(value: Date | string | undefined): string {
  if (value === undefined) throw new Error("OBJECT_BACKUP_INVENTORY_TIMESTAMP_MISSING");
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("OBJECT_BACKUP_INVENTORY_TIMESTAMP_INVALID");
  return date.toISOString();
}
