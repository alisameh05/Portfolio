import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { validateOwnerExportZip } from "../../scripts/owner-export/validator.mjs";
import {
  buildMediaOwnerExportPackage,
  type OwnerExportSelectedSnapshot,
} from "../../src/modules/portability-operations/application/owner-export-package.js";

const stableId = (tail: string) => `01890f3e-7b2f-7cc0-98cf-5a289037${tail.padStart(4, "0")}`;
const portfolioId = stableId("2") as never;
const timestamp = "2026-10-24T10:00:00.000Z";
const bytes = new TextEncoder().encode("portable-media-bytes");
const digest = createHash("sha256").update(bytes).digest("hex");
const reference = `assets/media-metadata/sha256/${digest}`;
const originalBytes = new TextEncoder().encode("original-source-bytes");
const originalDigest = createHash("sha256").update(originalBytes).digest("hex");
const originalReference = `assets/media-metadata/sha256/${originalDigest}`;

function acceptedRecord(mediaId: string): { readonly mediaId: string; readonly value: Readonly<Record<string, unknown>> } {
  return {
    mediaId,
    value: {
      mediaId,
      aggregateVersion: 3,
      kind: "document",
      state: "accepted",
      locales: ["en", "ar"],
      accessibilityMetadata: { kind: "document", summary: "Accepted document." },
      processingHistory: [],
      processingHistoryTruncated: false,
      decisionHistory: [{ decision: "accepted", decidedAt: timestamp }],
      decisionHistoryTruncated: false,
      acceptanceHistory: [{
        aggregateVersion: 3,
        decidedAt: timestamp,
        inputSha256: "a".repeat(64),
        detectedMediaType: "application/pdf",
        detectedByteLength: bytes.byteLength,
        scannerVersion: "scanner-v1",
        processorVersion: "processor-v1",
        processingPolicyVersion: "pdf-policy-v1",
        accessibilityMetadata: { kind: "document", summary: "Accepted document." },
        byteCoverage: "included",
        variants: [
          { variantName: "document", mediaType: "application/pdf", byteLength: bytes.byteLength,
            digest, byteCoverage: "included", portableReference: reference },
          { variantName: "original", mediaType: "application/pdf", byteLength: originalBytes.byteLength,
            digest: originalDigest, byteCoverage: "included", portableReference: originalReference },
        ],
      }],
      acceptanceHistoryTruncated: false,
      publicationState: "published",
      publicationEligibility: "eligible",
      portableAssets: [{ variantName: "document", mediaType: "application/pdf", byteLength: bytes.byteLength,
        digest, portableReference: reference }, { variantName: "original", mediaType: "application/pdf",
        byteLength: originalBytes.byteLength, digest: originalDigest, portableReference: originalReference }],
      byteCoverage: "included",
    },
  };
}

function rejectedRecord(mediaId: string) {
  return {
    mediaId,
    value: {
      mediaId,
      aggregateVersion: 4,
      kind: "video",
      state: "rejected",
      locales: [],
      accessibilityMetadata: null,
      processingHistory: [],
      processingHistoryTruncated: false,
      decisionHistory: [{ decision: "rejected", decidedAt: timestamp, reason: "UNSAFE_CONTENT" }],
      decisionHistoryTruncated: false,
      acceptanceHistory: [],
      acceptanceHistoryTruncated: false,
      publicationState: "withdrawn",
      publicationEligibility: "ineligible",
      portableAssets: [],
      byteCoverage: "excluded",
      byteExclusionReason: "rejected-or-withdrawn",
    },
  } as const;
}

function snapshot(records: readonly { readonly mediaId: string; readonly value: Readonly<Record<string, unknown>> }[], assets: NonNullable<OwnerExportSelectedSnapshot["media"]>["assets"]): OwnerExportSelectedSnapshot {
  return {
    kind: "owner-export-snapshot-v1",
    snapshotId: stableId("3") as OwnerExportSelectedSnapshot["snapshotId"],
    capturedAt: timestamp,
    includedScopes: ["media-metadata"],
    media: { records, assets },
  };
}

function mediaAsset(mediaId: string, objectId: string) {
  return { path: reference, mediaId, variantName: "document", mediaType: "application/pdf" as const,
    byteLength: bytes.byteLength, digest, objectId, source: "variant" as const };
}

function originalAsset(mediaId: string, objectId: string, uploadIntentId: string) {
  return { path: originalReference, mediaId, variantName: "original", mediaType: "application/pdf" as const,
    byteLength: originalBytes.byteLength, digest: originalDigest, objectId, source: "original" as const, uploadIntentId };
}

async function collect(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of content) { chunks.push(chunk); length += chunk.byteLength; }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function zipEntry(archive: Uint8Array, expectedName: string): Uint8Array {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const length = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameOffset = offset + 30;
    const name = new TextDecoder().decode(archive.subarray(nameOffset, nameOffset + nameLength));
    const bodyOffset = nameOffset + nameLength + extraLength;
    if (name === expectedName) return archive.subarray(bodyOffset, bodyOffset + length);
    offset = bodyOffset + length;
  }
  throw new Error("OWNER_EXPORT_MEDIA_TEST_ENTRY_MISSING");
}

describe("Issue #243 Media-only portable packages", () => {
  it("packages accepted bytes, deduplicates shared digests, and passes the independent validator", async () => {
    const lowerMediaId = stableId("10");
    const higherMediaId = stableId("20");
    const objects = [mediaAsset(higherMediaId, stableId("200")), mediaAsset(lowerMediaId, stableId("100")),
      originalAsset(higherMediaId, stableId("201"), stableId("21")), originalAsset(lowerMediaId, stableId("101"), stableId("11"))];
    const reads: string[] = [];
    const built = await buildMediaOwnerExportPackage({
      exportId: stableId("1") as never,
      portfolioId,
      snapshot: snapshot([acceptedRecord(higherMediaId), acceptedRecord(lowerMediaId)], objects),
      objects: {
        async readMediaExportObject(input) {
          reads.push(`${input.source}:${input.objectId}`);
          const body = input.source === "original" ? originalBytes : bytes;
          return { async *[Symbol.asyncIterator]() { yield body.subarray(0, 5); yield body.subarray(5); } };
        },
      },
    });
    const archive = await collect(built.content);
    const validated = validateOwnerExportZip(archive);
    const manifest = validated.manifest as unknown as { schemaVersion: string; includedScopes: string[]; assets: Array<{ path: string; assetId: string }> };
    const recordText = new TextDecoder().decode(zipEntry(archive, "records/media-metadata.ndjson"));

    expect(manifest).toMatchObject({ schemaVersion: "1.5", includedScopes: ["media-metadata"] });
    expect(validated.recordCounts).toEqual({ "media-metadata": 2 });
    expect(manifest.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: reference, assetId: lowerMediaId, scope: "media-metadata",
        mediaType: "application/pdf", byteLength: bytes.byteLength, digest }),
      expect.objectContaining({ path: originalReference, assetId: lowerMediaId, scope: "media-metadata",
        mediaType: "application/pdf", byteLength: originalBytes.byteLength, digest: originalDigest }),
    ]));
    expect(reads).toHaveLength(6);
    expect(new Set(reads)).toEqual(new Set([`variant:${stableId("100")}`, `original:${stableId("101")}`]));
    expect(zipEntry(archive, reference)).toEqual(bytes);
    expect(zipEntry(archive, originalReference)).toEqual(originalBytes);
    expect(recordText.match(/"mediaId"/gu)).toHaveLength(2);
    expect(new TextDecoder().decode(archive)).not.toMatch(/media-processed|signedURL|objectId|phase-private-storage/u);
  });

  it.each(["missing", "same-length replacement"] as const)("fails closed for %s required accepted bytes", async (failure) => {
    const mediaId = stableId("30");
    let reads = 0;
    const sourceAssets = [mediaAsset(mediaId, stableId("300")), originalAsset(mediaId, stableId("301"), stableId("31"))];
    const readCounts = new Map<string, number>();
    const building = buildMediaOwnerExportPackage({
      exportId: stableId("4") as never,
      portfolioId,
      snapshot: snapshot([acceptedRecord(mediaId)], sourceAssets),
      objects: {
        async readMediaExportObject(input) {
          reads += 1;
          if (failure === "missing") throw new Error("object missing");
          const body = input.source === "original" ? originalBytes : bytes;
          const count = (readCounts.get(input.objectId) ?? 0) + 1;
          readCounts.set(input.objectId, count);
          const replacement = body.slice(); replacement[0] ^= 1;
          const response = count === 1 ? body : replacement;
          return { async *[Symbol.asyncIterator]() { yield response; } };
        },
      },
    });
    if (failure === "missing") await expect(building).rejects.toThrow();
    else await expect(building).rejects.toThrow("OWNER_EXPORT_ZIP_MEMBER_INTEGRITY_MISMATCH");
  });

  it("records rejected bytes as excluded without reading or declaring any object", async () => {
    const mediaId = stableId("40");
    let reads = 0;
    const built = await buildMediaOwnerExportPackage({
      exportId: stableId("5") as never,
      portfolioId,
      snapshot: snapshot([rejectedRecord(mediaId)], []),
      objects: { async readMediaExportObject() { reads += 1; throw new Error("rejected bytes must not be read"); } },
    });
    const archive = await collect(built.content);
    const validated = validateOwnerExportZip(archive);
    const record = JSON.parse(new TextDecoder().decode(zipEntry(archive, "records/media-metadata.ndjson"))) as { value: Record<string, unknown> };
    expect(validated.verifiedAssetCount).toBe(0);
    expect(record.value).toMatchObject({ byteCoverage: "excluded", byteExclusionReason: "rejected-or-withdrawn", portableAssets: [] });
    expect(reads).toBe(0);
  });

  it("rejects an accepted object above the 50 MiB per-object bound before opening Storage", async () => {
    const mediaId = stableId("50");
    const record = acceptedRecord(mediaId);
    const portableAssets = record.value["portableAssets"] as Array<Record<string, unknown>>;
    const oversized = { ...record, value: { ...record.value, portableAssets: [{ ...portableAssets[0], byteLength: 50 * 1024 * 1024 + 1 }] } };
    let reads = 0;
    await expect(buildMediaOwnerExportPackage({
      exportId: stableId("6") as never,
      portfolioId,
      snapshot: snapshot([oversized], []),
      objects: { async readMediaExportObject() { reads += 1; throw new Error("oversized object must not be read"); } },
    })).rejects.toThrow("OWNER_EXPORT_MEDIA_RECORD_INVALID");
    expect(reads).toBe(0);
  });

  it("rejects packages whose unique assets exceed the validator's 512-member limit", async () => {
    const mediaId = stableId("60");
    const record = acceptedRecord(mediaId);
    const portableAssets = Array.from({ length: 509 }, (_, index) => {
      const assetDigest = index.toString(16).padStart(64, "0");
      return { variantName: `asset-${index}`, mediaType: "application/pdf", byteLength: 1,
        digest: assetDigest, portableReference: `assets/media-metadata/sha256/${assetDigest}` };
    });
    const assets = portableAssets.map((asset, index) => ({ path: asset.portableReference, mediaId,
      variantName: asset.variantName, mediaType: "application/pdf" as const, byteLength: 1,
      digest: asset.digest, objectId: stableId(String(1000 + index)), source: "variant" as const }));
    await expect(buildMediaOwnerExportPackage({
      exportId: stableId("7") as never,
      portfolioId,
      snapshot: snapshot([{ ...record, value: { ...record.value, portableAssets } }], assets),
      objects: { async readMediaExportObject() { throw new Error("member limit must fail before Storage"); } },
    })).rejects.toThrow("OWNER_EXPORT_MEDIA_ENTRY_COUNT_LIMIT");
  });
});
