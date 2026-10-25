import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ownerExportManifestDigest, validateOwnerExportZip } from "../../scripts/owner-export/validator.mjs";
import {
  buildCvOwnerExportPackage,
  createStoredOwnerExportZip,
  measureOwnerExportStream,
  type OwnerExportSelectedSnapshot,
} from "../../src/modules/portability-operations/application/owner-export-package.js";

const id = (tail: string) => `01890f3e-7b2f-7cc0-98cf-5a289037${tail.padStart(4, "0")}`;
const portfolioId = id("1") as never;
const mediaId = id("2");
const cvVersionId = id("3");
const mediaDecisionId = id("4");
const mediaObjectId = id("5");
const approvalId = id("6");
const activationId = id("7");
const priorCvVersionId = id("14");
const priorApprovalId = id("15");
const priorActivationId = id("16");
const timestamp = "2026-10-24T10:00:00.000Z";
const pdf = new TextEncoder().encode("accepted cv document bytes");
const digest = createHash("sha256").update(pdf).digest("hex");
const reference = `assets/media-metadata/sha256/${digest}`;

function cvAsset(overrides: Record<string, unknown> = {}) {
  return {
    path: reference,
    mediaId,
    variantName: "document",
    mediaType: "application/pdf" as const,
    byteLength: pdf.byteLength,
    digest,
    objectId: mediaObjectId,
    source: "variant" as const,
    assetVersion: 3,
    decisionId: mediaDecisionId,
    objectVersion: digest,
    ...overrides,
  } as NonNullable<OwnerExportSelectedSnapshot["cvAssets"]>[number];
}

function acceptedMediaRecord() {
  const portableAsset = { variantName: "document", mediaType: "application/pdf", byteLength: pdf.byteLength,
    digest, portableReference: reference };
  const acceptedVariant = { ...portableAsset, byteCoverage: "included" };
  return {
    mediaId,
    value: {
      mediaId, aggregateVersion: 3, kind: "document", state: "accepted", locales: [],
      accessibilityMetadata: { kind: "document", summary: "Current accessible PDF." },
      processingHistory: [], processingHistoryTruncated: false,
      decisionHistory: [{ decision: "accepted", decidedAt: timestamp }], decisionHistoryTruncated: false,
      acceptanceHistory: [{ aggregateVersion: 3, decidedAt: timestamp, inputSha256: "a".repeat(64),
        detectedMediaType: "application/pdf", detectedByteLength: pdf.byteLength, scannerVersion: "scanner-v1",
        processorVersion: "processor-v1", processingPolicyVersion: "pdf-policy-v1",
        accessibilityMetadata: { kind: "document", summary: "Current accessible PDF." }, byteCoverage: "included",
        variants: [acceptedVariant] }],
      acceptanceHistoryTruncated: false, publicationState: "accepted", publicationEligibility: "eligible",
      portableAssets: [portableAsset], byteCoverage: "included",
    } as const,
  };
}

function acceptedCvSnapshot(): NonNullable<OwnerExportSelectedSnapshot["cv"]> {
  return {
    capturedAt: timestamp,
    aggregateVersion: 4,
    currentVersionId: cvVersionId as never,
    versions: [
      {
        versionId: cvVersionId as never,
        mediaId: mediaId as never,
        locale: "en",
        label: "Current CV",
        state: "accepted",
        isCurrent: true,
        versionNumber: 2,
        registeredAt: "2026-10-20T09:00:00.000Z",
        acceptedAt: timestamp,
        acceptedMediaSnapshot: {
          mediaAssetVersion: 3,
          mediaDecisionId: mediaDecisionId as never,
          mediaObjectId: mediaObjectId as never,
          sha256: digest,
          objectVersion: digest,
        },
      },
      {
        versionId: priorCvVersionId as never,
        mediaId: mediaId as never,
        locale: "en",
        label: "Previous CV",
        state: "accepted",
        isCurrent: false,
        versionNumber: 1,
        registeredAt: "2026-10-18T09:00:00.000Z",
        acceptedAt: "2026-10-19T10:00:00.000Z",
        acceptedMediaSnapshot: {
        mediaAssetVersion: 3,
        mediaDecisionId: mediaDecisionId as never,
        mediaObjectId: mediaObjectId as never,
        sha256: digest,
        objectVersion: digest,
      },
      },
    ],
    versionsTruncated: false,
    acceptanceHistory: [
      { approvalId: approvalId as never, versionId: cvVersionId as never, acceptedAt: timestamp },
      { approvalId: priorApprovalId as never, versionId: priorCvVersionId as never, acceptedAt: "2026-10-19T10:00:00.000Z" },
    ],
    acceptanceHistoryTruncated: false,
    activationHistory: [
      { activationId: activationId as never, versionId: cvVersionId as never, activatedAt: timestamp },
      { activationId: priorActivationId as never, versionId: priorCvVersionId as never, activatedAt: "2026-10-21T10:00:00.000Z" },
    ],
    activationHistoryTruncated: false,
  };
}

function snapshot(input: {
  readonly combined?: boolean;
  readonly cv?: OwnerExportSelectedSnapshot["cv"];
  readonly cvAssets?: readonly NonNullable<OwnerExportSelectedSnapshot["cvAssets"]>[number][];
} = {}): OwnerExportSelectedSnapshot {
  const combined = input.combined ?? false;
  return {
    kind: "owner-export-snapshot-v1",
    snapshotId: id("8") as OwnerExportSelectedSnapshot["snapshotId"],
    capturedAt: timestamp,
    includedScopes: combined ? ["media-metadata", "cv-metadata"] : ["cv-metadata"],
    cv: input.cv ?? acceptedCvSnapshot(),
    cvAssets: input.cvAssets ?? [cvAsset()],
    ...(combined ? { media: { records: [acceptedMediaRecord()], assets: [cvAsset()] } } : {}),
  };
}

async function collect(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of content) { chunks.push(chunk); length += chunk.byteLength; }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

async function storedMember(name: string, bytes: Uint8Array) {
  const measured = await measureOwnerExportStream({ async *[Symbol.asyncIterator]() { yield bytes; } });
  return {
    name,
    contentLength: measured.contentLength,
    crc32: measured.crc32,
    content: () => ({ async *[Symbol.asyncIterator]() { yield bytes; } }),
  };
}

async function rewriteCvRecord(archive: Uint8Array, record: Record<string, unknown>): Promise<Uint8Array> {
  const manifest = JSON.parse(new TextDecoder().decode(storedEntry(archive, "manifest.json"))) as {
    digest: string;
    schemas: Array<{ path: string }>;
    entries: Array<{ path: string; scope: string; digest: string }>;
    assets: Array<{ path: string }>;
    dependencies: Array<Record<string, string>>;
  };
  const cvEntry = manifest.entries.find((entry) => entry.scope === "cv-metadata");
  if (cvEntry === undefined) throw new Error("OWNER_EXPORT_CV_TEST_ENTRY_MISSING");
  const cvRecordBytes = new TextEncoder().encode(`${JSON.stringify(record)}\n`);
  cvEntry.digest = createHash("sha256").update(cvRecordBytes).digest("hex");
  const value = record["value"] as { versions?: Array<{ versionId: string; mediaId: string }> };
  if (value.versions !== undefined) {
    manifest.dependencies = value.versions.map((version) => ({
      sourceScope: "cv-metadata",
      sourceId: version.versionId,
      targetScope: "media-metadata",
      targetId: version.mediaId,
      disposition: "omitted",
      reason: "scope-not-selected",
    })).sort((left, right) => left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0);
  }
  manifest.digest = ownerExportManifestDigest(manifest);
  const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
  const names = ["manifest.json", ...manifest.schemas.map((schema) => schema.path),
    ...manifest.entries.map((entry) => entry.path), ...manifest.assets.map((asset) => asset.path)];
  const entries = await Promise.all(names.map(async (name) => storedMember(name,
    name === "manifest.json" ? manifestBytes : name === cvEntry.path ? cvRecordBytes : storedEntry(archive, name))));
  return collect(createStoredOwnerExportZip(entries).content);
}

function storedEntry(archive: Uint8Array, expectedName: string): Uint8Array {
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
  throw new Error("OWNER_EXPORT_CV_TEST_ENTRY_MISSING");
}

function objectReader(read: (count: number) => Uint8Array = () => pdf) {
  let count = 0;
  return {
    get count() { return count; },
    async readMediaExportObject() {
      const value = read(++count);
      return { async *[Symbol.asyncIterator]() { yield value; } };
    },
  };
}

describe("Issue #244 CV export package 1.6", () => {
  it("exports retained CV identities, real approval and activation history, and verified accepted PDF bytes", async () => {
    const objects = objectReader();
    const built = await buildCvOwnerExportPackage({ exportId: id("9") as never, portfolioId, snapshot: snapshot(), objects });
    const archive = await collect(built.content);
    const validated = validateOwnerExportZip(archive);
    const record = JSON.parse(new TextDecoder().decode(storedEntry(archive, "records/cv-metadata.ndjson"))) as { value: Record<string, unknown> };
    expect(validated.manifest).toMatchObject({ schemaVersion: "1.6", includedScopes: ["cv-metadata"],
      schemas: [expect.objectContaining({ schemaUri: "urn:shipwithali:owner-export-schema:manifest:1.5", schemaVersion: "1.5" })],
      assets: [{ path: reference, scope: "media-metadata" }] });
    expect(record.value).toMatchObject({ currentVersionId: cvVersionId,
      versions: [
        { versionId: cvVersionId, mediaId, versionNumber: 2, registeredAt: "2026-10-20T09:00:00.000Z", acceptedAt: timestamp, portableReference: reference, isCurrent: true },
        { versionId: priorCvVersionId, mediaId, versionNumber: 1, registeredAt: "2026-10-18T09:00:00.000Z", acceptedAt: "2026-10-19T10:00:00.000Z", portableReference: reference, isCurrent: false },
      ],
      acceptanceHistory: [
        { approvalId, versionId: cvVersionId, acceptedAt: timestamp },
        { approvalId: priorApprovalId, versionId: priorCvVersionId, acceptedAt: "2026-10-19T10:00:00.000Z" },
      ],
      activationHistory: [
        { activationId, versionId: cvVersionId, activatedAt: timestamp },
        { activationId: priorActivationId, versionId: priorCvVersionId, activatedAt: "2026-10-21T10:00:00.000Z" },
      ] });
    expect(validated.recordCounts).toEqual({ "cv-metadata": 1 });
    expect(validated.verifiedAssetCount).toBe(1);
    expect(storedEntry(archive, reference)).toEqual(pdf);
    expect(JSON.stringify(record)).not.toMatch(/objectId|decisionId|objectVersion|ownerId|portfolioId/u);
    expect(objects.count).toBeGreaterThanOrEqual(2);
    const acceptances = record.value["acceptanceHistory"] as Array<Record<string, unknown>>;
    const firstAcceptance = acceptances[0];
    if (firstAcceptance === undefined) throw new Error("OWNER_EXPORT_CV_TEST_ACCEPTANCE_MISSING");
    const tamperedRecord = { ...record, value: { ...record.value,
      acceptanceHistory: [{ ...firstAcceptance, acceptedAt: "2026-10-25T10:00:00.000Z" }, ...acceptances.slice(1)] } };
    const tamperedArchive = await rewriteCvRecord(archive, tamperedRecord);
    expect(() => validateOwnerExportZip(tamperedArchive)).toThrow("CV_SNAPSHOT_FACTS_INVALID");
  });

  it("rejects an omitted acceptance inside the retained history prefix after digest recomputation", async () => {
    const built = await buildCvOwnerExportPackage({ exportId: id("9") as never, portfolioId, snapshot: snapshot(), objects: objectReader() });
    const archive = await collect(built.content);
    const truncatedValue = JSON.parse(new TextDecoder().decode(storedEntry(archive, "records/cv-metadata.ndjson"))) as {
      scope: string;
      value: Record<string, unknown>;
    };
    const versions = truncatedValue.value["versions"] as Array<Record<string, unknown>>;
    const currentVersion = versions.find((version) => version["isCurrent"] === true);
    if (currentVersion === undefined) throw new Error("OWNER_EXPORT_CV_TEST_CURRENT_VERSION_MISSING");
    currentVersion["acceptedAt"] = "2026-10-24T10:00:45.000Z";
    truncatedValue.value["versions"] = [
      ...versions,
      ...Array.from({ length: 98 }, (_, index) => ({
        versionId: id(String(500 + index)), mediaId, versionNumber: 100 - index, locale: "en",
        registeredAt: "2026-10-01T00:00:00.000Z", label: "Retained historical registration", state: "registered", isCurrent: false,
      })),
    ].sort((left, right) => Number(right["versionNumber"]) - Number(left["versionNumber"]));
    truncatedValue.value["versionsTruncated"] = true;
    truncatedValue.value["acceptanceHistory"] = Array.from({ length: 100 }, (_, index) => ({
      approvalId: id(String(700 + index)),
      versionId: id(String(900 + index)),
      acceptedAt: new Date(Date.UTC(2026, 9, 24, 10, 1, 39 - index)).toISOString(),
    }));
    truncatedValue.value["acceptanceHistoryTruncated"] = true;
    const activations = truncatedValue.value["activationHistory"] as Array<Record<string, unknown>>;
    const currentActivation = activations.find((activation) => activation["versionId"] === cvVersionId);
    if (currentActivation === undefined) throw new Error("OWNER_EXPORT_CV_TEST_CURRENT_ACTIVATION_MISSING");
    currentActivation["activatedAt"] = "2026-10-24T10:00:46.000Z";
    const omittedRecentAcceptance = await rewriteCvRecord(archive, truncatedValue);
    expect(() => validateOwnerExportZip(omittedRecentAcceptance)).toThrow("CV_SNAPSHOT_FACTS_INVALID");
  });

  it("represents no Current CV with retained versions and no invented activation history", async () => {
    const retained = acceptedCvSnapshot();
    const cv = {
      ...retained,
      currentVersionId: null,
      versions: retained.versions.map((version) => ({ ...version, isCurrent: false })),
      activationHistory: [],
    } as NonNullable<OwnerExportSelectedSnapshot["cv"]>;
    const built = await buildCvOwnerExportPackage({ exportId: id("10") as never, portfolioId,
      snapshot: snapshot({ cv }), objects: objectReader() });
    const archive = await collect(built.content);
    const validated = validateOwnerExportZip(archive);
    const record = JSON.parse(new TextDecoder().decode(storedEntry(archive, "records/cv-metadata.ndjson"))) as { value: Record<string, unknown> };
    expect(record.value).toMatchObject({ currentVersionId: null,
      versions: [
        { versionId: cvVersionId, isCurrent: false, state: "accepted" },
        { versionId: priorCvVersionId, isCurrent: false, state: "accepted" },
      ],
      acceptanceHistory: [{ approvalId }, { approvalId: priorApprovalId }], activationHistory: [] });
    expect(validated.verifiedAssetCount).toBe(1);
  });

  it("deduplicates an accepted PDF referenced by both selected scopes", async () => {
    const built = await buildCvOwnerExportPackage({ exportId: id("11") as never, portfolioId,
      snapshot: snapshot({ combined: true }), objects: objectReader() });
    const archive = await collect(built.content);
    const validated = validateOwnerExportZip(archive);
    const assets = "assets" in validated.manifest ? validated.manifest.assets : undefined;
    expect(assets).toHaveLength(1);
    expect(validated.includedScopes).toEqual(["media-metadata", "cv-metadata"]);
    expect(validated.verifiedAssetCount).toBe(1);
    expect(storedEntry(archive, reference)).toEqual(pdf);
  });

  it.each(["missing", "corrupt"] as const)("does not build a byte-complete package when required CV bytes are %s", async (failure) => {
    const objects = objectReader((count) => {
      if (failure === "missing") throw new Error("private PDF unavailable");
      const replacement = pdf.slice();
      replacement[0] = (replacement[0] ?? 0) ^ count;
      return replacement;
    });
    await expect(buildCvOwnerExportPackage({ exportId: id("12") as never, portfolioId, snapshot: snapshot(), objects }))
      .rejects.toThrow();
  });

  it("fails closed when a retained CV's exact accepted Media binding is stale", async () => {
    const staleAsset = cvAsset({ decisionId: id("99") });
    await expect(buildCvOwnerExportPackage({ exportId: id("13") as never, portfolioId,
      snapshot: snapshot({ cvAssets: [staleAsset] }), objects: objectReader() })).rejects.toThrow("OWNER_EXPORT_CV_REQUIRED_BYTES_MISSING");
  });
});
