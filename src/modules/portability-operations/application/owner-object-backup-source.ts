import type { StableId } from "@shared/domain";
import type { OwnerExportObjectReadPort } from "./service.js";
import type { OwnerExportMediaObjectReaderPort } from "./owner-export-package.js";
import type { ObjectBackupItem, ObjectBackupSourcePort } from "./object-backup.js";

const SUPPORTED_MEDIA_TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm"] as const;
type SupportedMediaType = typeof SUPPORTED_MEDIA_TYPES[number];
function supportedMediaType(value: string): value is SupportedMediaType { return SUPPORTED_MEDIA_TYPES.includes(value as SupportedMediaType); }

export type MediaObjectBackupCandidate = Readonly<{
  portfolioId: StableId<"Portfolio">;
  mediaId: StableId<"MediaAsset">;
  objectId: StableId<"MediaObject">;
  source: "original" | "variant";
  cvVersionIds?: readonly string[];
  uploadIntentId?: StableId<"MediaUploadIntent">;
  variantName: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  eligibleAt: string;
  expiresAt: string | null;
  revalidate(): Promise<boolean>;
}>;

export type OwnerExportObjectBackupCandidate = Readonly<{
  portfolioId: StableId<"Portfolio">;
  exportId: StableId<"OwnerExport">;
  artifactId: StableId<"OwnerExportArtifact">;
  byteLength: number;
  sha256: string;
  eligibleAt: string;
  expiresAt: string;
  revalidate(): Promise<boolean>;
}>;

export interface MediaObjectBackupInventoryPort {
  capture(): Promise<Readonly<{ sourceWatermarkAt: string; relationalWatermarkAt: string; candidates: readonly MediaObjectBackupCandidate[] }>>;
}
export interface OwnerExportObjectBackupInventoryPort {
  listEligible(): Promise<Readonly<{ capturedAt: string; candidates: readonly OwnerExportObjectBackupCandidate[] }>>;
}

async function collect(content: AsyncIterable<Uint8Array>, expectedLength: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = []; let length = 0;
  for await (const part of content) {
    length += part.byteLength;
    if (length > expectedLength) throw new Error("OBJECT_BACKUP_SOURCE_LENGTH_MISMATCH");
    parts.push(part);
  }
  if (length !== expectedLength) throw new Error("OBJECT_BACKUP_SOURCE_LENGTH_MISMATCH");
  return Buffer.concat(parts.map(part => Buffer.from(part)), length);
}

/** Composes owner-module inventories with their protected object read ports. */
export function createOwnerObjectBackupSource(input: {
  media: MediaObjectBackupInventoryPort;
  exports: OwnerExportObjectBackupInventoryPort;
  mediaObjects: OwnerExportMediaObjectReaderPort;
  exportObjects: OwnerExportObjectReadPort;
}): ObjectBackupSourcePort {
  return {
    async capture() {
      const media = await input.media.capture();
      const exportSnapshot = await input.exports.listEligible();
      const exportCandidates = exportSnapshot.candidates;
      const items: ObjectBackupItem[] = media.candidates.map(candidate => {
        if (!supportedMediaType(candidate.mediaType)) throw new Error("OBJECT_BACKUP_MEDIA_TYPE_UNSUPPORTED");
        const mediaType = candidate.mediaType;
        return {
          kind: "media", portfolioId: candidate.portfolioId, mediaId: candidate.mediaId, objectId: candidate.objectId,
          source: candidate.source, variantName: candidate.variantName, mediaType,
          ...(candidate.cvVersionIds === undefined ? {} : { cvVersionIds: candidate.cvVersionIds }),
          byteLength: candidate.byteLength, sha256: candidate.sha256, eligibleAt: candidate.eligibleAt, expiresAt: candidate.expiresAt,
          revalidate: candidate.revalidate,
          read: async () => collect(await input.mediaObjects.readMediaExportObject({
            portfolioId: candidate.portfolioId, mediaId: candidate.mediaId, objectId: candidate.objectId,
            source: candidate.source, ...(candidate.uploadIntentId === undefined ? {} : { uploadIntentId: candidate.uploadIntentId }), mediaType,
            expectedLength: candidate.byteLength, expectedSha256: candidate.sha256,
          }), candidate.byteLength),
        };
      });
      for (const candidate of exportCandidates) {
        items.push({ kind: "owner-export", portfolioId: candidate.portfolioId, exportId: candidate.exportId,
          objectId: candidate.artifactId, source: "export-artifact", variantName: "complete-package", mediaType: "application/zip",
          byteLength: candidate.byteLength, sha256: candidate.sha256, eligibleAt: candidate.eligibleAt, expiresAt: candidate.expiresAt,
          revalidate: candidate.revalidate,
          read: async () => {
            const result = await input.exportObjects.readOwnerExport({ portfolioId: candidate.portfolioId, exportId: candidate.exportId,
              artifactId: candidate.artifactId, expectedSha256: candidate.sha256, expectedContentLength: candidate.byteLength });
            if (!result.ok) throw new Error("OBJECT_BACKUP_EXPORT_OBJECT_UNAVAILABLE");
            return collect(result.value.content, candidate.byteLength);
          },
        });
      }
      const sourceWatermarkAt = Date.parse(media.sourceWatermarkAt) <= Date.parse(exportSnapshot.capturedAt)
        ? media.sourceWatermarkAt : exportSnapshot.capturedAt;
      const relationalWatermarkAt = Date.parse(media.relationalWatermarkAt) >= Date.parse(exportSnapshot.capturedAt)
        ? media.relationalWatermarkAt : exportSnapshot.capturedAt;
      return Object.freeze({ sourceWatermarkAt, relationalWatermarkAt,
        items: Object.freeze(items) });
    },
  };
}
