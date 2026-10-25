import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  canonicalizeOwnerExportManifest,
  MAX_OWNER_EXPORT_ARCHIVE_BYTES,
  ownerExportManifestDigest,
  validateOwnerExportZip,
} from "../../scripts/owner-export/validator.mjs";
import type { OwnerExportValidationManifestV1_1 } from "../../scripts/owner-export/validator.mjs";

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const stableId = (tail: string) => `01890f3e-7b2f-7cc0-98cf-5a2890378${tail}`;
const scopes = ["media-metadata", "cv-metadata", "analytics-reports", "portfolio-configuration"] as const;

function independentCanonicalJson(value: unknown, topLevel = true): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => independentCanonicalJson(item, false)).join(",")}]`;
  const keys = Object.keys(value).filter((key) => !(topLevel && key === "digest"));
  keys.sort((left, right) => {
    const a = Array.from(left, (character) => character.codePointAt(0)!);
    const b = Array.from(right, (character) => character.codePointAt(0)!);
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
      if (a[index] !== b[index]) return a[index]! - b[index]!;
    }
    return a.length - b.length;
  });
  return `{${keys.map((key) => `${JSON.stringify(key)}:${independentCanonicalJson((value as Record<string, unknown>)[key], false)}`).join(",")}}`;
}

function createZip(entries: readonly { name: string; bytes: Buffer; method?: 0 | 8; externalAttributes?: number }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = entry.method === 8 ? deflateRawSync(entry.bytes) : entry.bytes;
    const crc = crc32(entry.bytes);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(entry.method ?? 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.method ?? 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.externalAttributes ?? (0o100644 * 0x10000), 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    offset += local.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildRepresentativePackage(options: {
  readonly corruptRecordSameLength?: boolean;
  readonly corruptSchemaSameLength?: boolean;
  readonly corruptAssetSameLength?: boolean;
  readonly malformedRecord?: boolean;
  readonly reverseZipMembers?: boolean;
  readonly reverseAnalyticsVersions?: boolean;
  readonly emptyConfigurationAsJson?: boolean;
  readonly includeProfileMediaAsset?: boolean;
  readonly extraEntries?: readonly { name: string; bytes: Buffer }[];
  readonly adjustManifest?: (manifest: Record<string, unknown>) => void;
} = {}): Buffer {
  const manifestSchema = readFileSync("schemas/owner-export/v1.1/manifest.schema.json");
  const sourceMediaSchema = readFileSync("schemas/owner-export/v1.1/media-metadata.schema.json");
  const mediaSchema = Buffer.from(sourceMediaSchema);
  if (options.corruptSchemaSameLength) mediaSchema[mediaSchema.length - 2] = mediaSchema[mediaSchema.length - 2]! ^ 1;
  const cvSchema = readFileSync("schemas/owner-export/v1.1/cv-metadata.schema.json");
  const analyticsSchema = readFileSync("schemas/owner-export/v1.1/analytics-reports.schema.json");
  const configurationSchema = readFileSync("schemas/owner-export/v1.1/portfolio-configuration.schema.json");
  const assetId = stableId("001");
  const mediaRecord = Buffer.from(`${JSON.stringify({
    scope: "media-metadata",
    value: {
      mediaId: stableId("002"),
      kind: "image",
      state: "accepted",
      accessibilityMetadata: null,
      processingHistory: [],
      decisionHistory: [],
      processingHistoryTruncated: false,
      decisionHistoryTruncated: false,
      publicationState: "accepted",
      portableReference: `assets/media-metadata/${assetId}`,
    },
  })}\n`, "utf8");
  const analyticsVersions = [{
    versionId: stableId("006"),
    versionNumber: 1,
    definition: { name: "Project journey", steps: [{ action: "project-viewed", projectIds: [stableId("019")], publicRouteIds: [stableId("020")] }] },
    createdAt: "2026-10-23T10:00:00Z",
  }, {
    versionId: stableId("009"),
    versionNumber: 2,
    definition: { name: "Updated project journey", steps: [{ action: "project-viewed", projectIds: [stableId("019")], publicRouteIds: [stableId("020")] }] },
    createdAt: "2026-10-23T10:01:00Z",
  }];
  if (options.reverseAnalyticsVersions) analyticsVersions.reverse();
  const analyticsRecords = Buffer.from(`${JSON.stringify({
    scope: "analytics-reports",
    value: {
      goal: {
        goalId: stableId("005"),
        aggregateVersion: 1,
        activeVersionId: stableId("009"),
        versions: analyticsVersions,
        activationHistory: [
          { versionId: stableId("006"), activatedAt: "2026-10-23T10:00:00Z" },
          { versionId: stableId("009"), activatedAt: "2026-10-23T10:01:00Z" },
        ],
      },
      reports: [],
    },
  })}\n`, "utf8");
  const cvAssetId = stableId("008");
  const cvVersionId = stableId("007");
  const cvAsset = Buffer.from("%PDF-1.7\n", "utf8");
  const cvRecord = Buffer.from(`${JSON.stringify({
    scope: "cv-metadata",
    value: {
      aggregateVersion: 2,
      currentVersionId: cvVersionId,
      versionsTruncated: false,
      versions: [{
        versionId: cvVersionId,
        mediaId: stableId("002"),
        locale: "en",
        portableReference: `assets/cv-metadata/${cvAssetId}`,
        label: "Current CV",
        state: "accepted",
        isCurrent: true,
      }],
      activationHistory: [{ versionId: cvVersionId, activatedAt: "2026-10-23T10:00:00Z" }],
      activationHistoryTruncated: false,
    },
  })}\n`, "utf8");
  const configurationRecord = Buffer.from(`${JSON.stringify({
    scope: "portfolio-configuration",
    value: {
      profile: { displayName: "Owner", headline: "Builder", bio: "Bio", mediaAssetId: stableId("002") },
      contactChannels: { channels: [] },
      projectCta: { label: "Contact", destination: "https://example.test/contact", unavailableFallback: "Contact unavailable" },
    },
  })}\n`, "utf8");
  const configurationRecords = options.includeProfileMediaAsset ? configurationRecord : Buffer.alloc(0);
  const asset = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
  const assetForZip = Buffer.from(asset);
  if (options.corruptAssetSameLength) assetForZip[assetForZip.length - 1] = assetForZip[assetForZip.length - 1]! ^ 1;
  const mediaRecordForZip = options.malformedRecord ? Buffer.from("not-json\n", "utf8") : Buffer.from(mediaRecord);
  if (options.corruptRecordSameLength) mediaRecordForZip[mediaRecordForZip.length - 2] = mediaRecordForZip[mediaRecordForZip.length - 2]! ^ 1;
  const descriptorRecordBytes = options.malformedRecord ? mediaRecordForZip : mediaRecord;
  const entries = [
    { path: "records/media-metadata.ndjson", scope: "media-metadata", mediaType: "application/x-ndjson", recordSchema: "urn:shipwithali:owner-export-schema:media-metadata:1.1", schemaPath: "schemas/media-metadata.schema.json", schemaVersion: "1.1", digest: digest(descriptorRecordBytes), recordCount: 1 },
    { path: "records/cv-metadata.ndjson", scope: "cv-metadata", mediaType: "application/x-ndjson", recordSchema: "urn:shipwithali:owner-export-schema:cv-metadata:1.1", schemaPath: "schemas/cv-metadata.schema.json", schemaVersion: "1.1", digest: digest(cvRecord), recordCount: 1 },
    { path: "records/analytics-reports.ndjson", scope: "analytics-reports", mediaType: "application/x-ndjson", recordSchema: "urn:shipwithali:owner-export-schema:analytics-reports:1.1", schemaPath: "schemas/analytics-reports.schema.json", schemaVersion: "1.1", digest: digest(analyticsRecords), recordCount: 1 },
    { path: `records/portfolio-configuration.${options.emptyConfigurationAsJson ? "json" : "ndjson"}`, scope: "portfolio-configuration", mediaType: options.emptyConfigurationAsJson ? "application/json" : "application/x-ndjson", recordSchema: "urn:shipwithali:owner-export-schema:portfolio-configuration:1.1", schemaPath: "schemas/portfolio-configuration.schema.json", schemaVersion: "1.1", digest: digest(configurationRecords), recordCount: options.includeProfileMediaAsset ? 1 : 0 },
  ];
  const schemas = [
    { kind: "manifest", path: "schemas/manifest.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:manifest:1.1", schemaVersion: "1.1", digest: digest(manifestSchema) },
    { kind: "record", scope: "media-metadata", path: "schemas/media-metadata.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:media-metadata:1.1", schemaVersion: "1.1", digest: digest(sourceMediaSchema) },
    { kind: "record", scope: "cv-metadata", path: "schemas/cv-metadata.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:cv-metadata:1.1", schemaVersion: "1.1", digest: digest(cvSchema) },
    { kind: "record", scope: "analytics-reports", path: "schemas/analytics-reports.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:analytics-reports:1.1", schemaVersion: "1.1", digest: digest(analyticsSchema) },
    { kind: "record", scope: "portfolio-configuration", path: "schemas/portfolio-configuration.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:portfolio-configuration:1.1", schemaVersion: "1.1", digest: digest(configurationSchema) },
  ];
  const manifest: Record<string, unknown> = {
    packageFormat: "shipwithali-owner-export",
    schemaVersion: "1.1",
    exportId: stableId("003"),
    snapshot: { snapshotId: stableId("004"), capturedAt: "2026-10-23T10:00:00Z", consistency: "transactional" },
    createdAt: "2026-10-23T10:01:00Z",
    algorithm: "sha-256",
    digest: "",
    requiredFeatures: ["asset-integrity-v1", "dependency-coverage-v1", "record-integrity-v1", "schema-integrity-v1", "snapshot-identity-v1"],
    includedScopes: scopes,
    publicEventDataCoverage: { mode: "excluded" },
    dependencies: [
      { sourceScope: "cv-metadata", sourceId: cvVersionId, targetScope: "media-metadata", targetId: stableId("002"), disposition: "included" },
      { sourceScope: "analytics-reports", sourceId: stableId("005"), targetScope: "portfolio-content", targetId: stableId("019"), disposition: "omitted", reason: "scope-not-selected" },
      { sourceScope: "analytics-reports", sourceId: stableId("005"), targetScope: "portfolio-content", targetId: stableId("020"), disposition: "omitted", reason: "scope-not-selected" },
      ...(options.includeProfileMediaAsset ? [{ sourceScope: "portfolio-configuration", sourceId: stableId("002"), targetScope: "media-metadata", targetId: stableId("002"), disposition: "included" }] : []),
    ],
    exclusions: ["raw-public-event-data", "functional-visitor-identities", "measurement-visitor-identities", "sessions", "credentials", "lab-entries"],
    entries,
    schemas,
    assets: [
      { path: `assets/cv-metadata/${cvAssetId}`, scope: "cv-metadata", assetId: cvAssetId, mediaType: "application/pdf", byteLength: cvAsset.length, digest: digest(cvAsset) },
      { path: `assets/media-metadata/${assetId}`, scope: "media-metadata", assetId, mediaType: "image/png", byteLength: asset.length, digest: digest(asset) },
    ],
  };
  options.adjustManifest?.(manifest);
  manifest["digest"] = digest(Buffer.from(independentCanonicalJson(manifest), "utf8"));
  const zipEntries: Array<{ name: string; bytes: Buffer; method?: 0 | 8; externalAttributes?: number }> = [
    { name: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest), "utf8") },
    { name: "schemas/manifest.schema.json", bytes: manifestSchema },
    { name: "schemas/media-metadata.schema.json", bytes: mediaSchema },
    { name: "schemas/cv-metadata.schema.json", bytes: cvSchema },
    { name: "schemas/analytics-reports.schema.json", bytes: analyticsSchema },
    { name: "schemas/portfolio-configuration.schema.json", bytes: configurationSchema },
    { name: "records/media-metadata.ndjson", bytes: mediaRecordForZip, method: 8 },
    { name: "records/cv-metadata.ndjson", bytes: cvRecord, method: 8 },
    { name: "records/analytics-reports.ndjson", bytes: analyticsRecords, method: 8 },
    { name: `records/portfolio-configuration.${options.emptyConfigurationAsJson ? "json" : "ndjson"}`, bytes: configurationRecords },
    { name: `assets/cv-metadata/${cvAssetId}`, bytes: cvAsset },
    { name: `assets/media-metadata/${assetId}`, bytes: assetForZip },
    ...(options.extraEntries ?? []),
  ];
  return createZip(options.reverseZipMembers ? [...zipEntries].reverse() : zipEntries);
}

function buildModerationPackage(version: "1.0" | "1.1" | "1.7", invalidHistory?: "sequence-gap" | "state-mismatch"): Buffer {
  const recordVersion = version === "1.7" ? "1.2" : version;
  const manifestVersion = version === "1.7" ? "1.6" : version;
  const schema = readFileSync(`schemas/owner-export/v${recordVersion}/moderation-history.schema.json`);
  const manifestSchema = readFileSync(`schemas/owner-export/v${manifestVersion}/manifest.schema.json`);
  const value = {
    feedbackId: stableId("021"), projectId: stableId("022"), locale: "en", aggregateVersion: 2,
    state: "approved", authorName: "Legacy visitor", paragraph: "Retained Feedback",
    submittedAt: "2026-10-22T10:00:00Z",
    ...(version === "1.7" ? { textDisposition: "retained" } : {}),
    decisionHistory: [{ decision: invalidHistory === "state-mismatch" ? "rejected" : "approved",
      reason: "Owner decision", decidedAt: "2026-10-23T10:00:00Z",
      ...(version === "1.7" ? { sequence: invalidHistory === "sequence-gap" ? 2 : 1 } : {}) }],
  };
  const record = Buffer.from(`${JSON.stringify(version === "1.0" ? { scope: "moderation-history", ...value } : { scope: "moderation-history", value })}\n`);
  const descriptor = { path: "schemas/moderation-history.schema.json",
    schemaUri: `urn:shipwithali:owner-export-schema:moderation-history:${recordVersion}`,
    schemaVersion: recordVersion, digest: digest(schema) };
  const manifest: Record<string, unknown> = {
    packageFormat: "shipwithali-owner-export", schemaVersion: version, createdAt: "2026-10-23T10:01:00Z",
    algorithm: "sha-256", digest: "", includedScopes: ["moderation-history"], publicEventDataCoverage: { mode: "excluded" },
    entries: [{ path: "records/moderation-history.ndjson", scope: "moderation-history", mediaType: "application/x-ndjson",
      recordSchema: descriptor.schemaUri, schemaPath: descriptor.path, schemaVersion: recordVersion, digest: digest(record), recordCount: 1 }],
    ...(version === "1.0" ? {} : {
      exportId: stableId("023"), snapshot: { snapshotId: stableId("024"), capturedAt: "2026-10-23T10:00:00Z", consistency: "transactional" },
      requiredFeatures: ["asset-integrity-v1", "dependency-coverage-v1", "record-integrity-v1", "schema-integrity-v1", "snapshot-identity-v1"],
      dependencies: [{ sourceScope: "moderation-history", sourceId: value.feedbackId, targetScope: "portfolio-content",
        targetId: value.projectId, disposition: "omitted", reason: "scope-not-selected" }],
      exclusions: ["raw-public-event-data", "functional-visitor-identities", "measurement-visitor-identities", "sessions", "credentials", "lab-entries"],
      schemas: [{ kind: "manifest", path: "schemas/manifest.schema.json",
        schemaUri: `urn:shipwithali:owner-export-schema:manifest:${manifestVersion}`, schemaVersion: manifestVersion, digest: digest(manifestSchema) },
      { kind: "record", scope: "moderation-history", ...descriptor }], assets: [],
    }),
  };
  manifest["digest"] = digest(Buffer.from(independentCanonicalJson(manifest)));
  return createZip([
    { name: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest)) },
    ...(version === "1.0" ? [] : [{ name: "schemas/manifest.schema.json", bytes: manifestSchema }]),
    { name: descriptor.path, bytes: schema }, { name: "records/moderation-history.ndjson", bytes: record },
  ]);
}

function buildLegacyV1Package(): Buffer {
  const analyticsSchema = readFileSync("schemas/owner-export/v1.0/analytics-reports.schema.json");
  const record = Buffer.from(`${JSON.stringify({
    scope: "analytics-reports",
    goal: {
      goalId: stableId("011"), aggregateVersion: 1, activeVersionId: null,
      versions: [{ versionId: stableId("012"), versionNumber: 1, definition: { name: "Journey", steps: [{ action: "project-viewed" }] }, createdAt: "2026-10-23T10:00:00Z" }],
      activationHistory: [],
    },
    reports: [],
  })}\n`, "utf8");
  const manifest: Record<string, unknown> = {
    packageFormat: "shipwithali-owner-export",
    schemaVersion: "1.0",
    createdAt: "2026-10-23T10:01:00Z",
    algorithm: "sha-256",
    digest: "",
    includedScopes: ["analytics-reports"],
    publicEventDataCoverage: { mode: "excluded" },
    entries: [{
      path: "records/analytics-reports.ndjson", scope: "analytics-reports", mediaType: "application/x-ndjson",
      recordSchema: "urn:shipwithali:owner-export-schema:analytics-reports:1.0", schemaPath: "schemas/analytics-reports.schema.json",
      schemaVersion: "1.0", digest: digest(record), recordCount: 1,
    }],
  };
  manifest["digest"] = digest(Buffer.from(independentCanonicalJson(manifest), "utf8"));
  return createZip([
    { name: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest), "utf8") },
    { name: "schemas/analytics-reports.schema.json", bytes: analyticsSchema },
    { name: "records/analytics-reports.ndjson", bytes: record },
  ]);
}

describe("portable Owner export package canonicalization", () => {
  it("matches independent published canonical and exact-byte digest vectors", () => {
    const canonicalVectors = JSON.parse(readFileSync("schemas/owner-export/vectors/canonicalization-v1.json", "utf8")) as {
      cases: Array<{ input: Record<string, unknown>; canonicalUtf8: string; sha256: string }>;
    };
    for (const vector of canonicalVectors.cases) {
      expect(independentCanonicalJson(vector.input)).toBe(vector.canonicalUtf8);
      expect(canonicalizeOwnerExportManifest(vector.input)).toBe(vector.canonicalUtf8);
      expect(ownerExportManifestDigest(vector.input)).toBe(vector.sha256);
    }

    const byteVectors = JSON.parse(readFileSync("schemas/owner-export/vectors/exact-byte-sha256-v1.json", "utf8")) as {
      cases: Array<{ bytesHex: string; sha256: string }>;
    };
    for (const vector of byteVectors.cases) {
      expect(digest(Buffer.from(vector.bytesHex, "hex"))).toBe(vector.sha256);
    }
  });
});

describe("offline Owner export ZIP validation", () => {
  it("validates records, packaged schemas, actual asset bytes and empty selected scopes", () => {
    const result = validateOwnerExportZip(buildRepresentativePackage());
    const manifest = result.manifest as OwnerExportValidationManifestV1_1;

    expect(manifest.schemaVersion).toBe("1.1");
    expect(manifest.exportId).toBe(stableId("003"));
    expect(manifest.snapshot.snapshotId).toBe(stableId("004"));
    expect(result.recordCounts).toEqual({ "media-metadata": 1, "cv-metadata": 1, "analytics-reports": 1, "portfolio-configuration": 0 });
    expect(manifest.entries.find((entry) => entry.scope === "portfolio-configuration")?.digest)
      .toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(result.dependencyCount).toBe(3);
    expect(result.verifiedAssetCount).toBe(2);
  });

  it.each(["1.0", "1.1"] as const)("validates a nonempty legacy %s Moderation ZIP without sequenced decisions", version => {
    const result = validateOwnerExportZip(buildModerationPackage(version));
    expect(result.manifest.schemaVersion).toBe(version);
    expect(result.recordCounts["moderation-history"]).toBe(1);
  });

  it("enforces sequenced and state-consistent Moderation history for format 1.7", () => {
    expect(validateOwnerExportZip(buildModerationPackage("1.7")).recordCounts["moderation-history"]).toBe(1);
    for (const invalidHistory of ["sequence-gap", "state-mismatch"] as const) {
      expect(() => validateOwnerExportZip(buildModerationPackage("1.7", invalidHistory))).toThrow("PACKAGE_MODERATION_HISTORY_INVALID");
    }
  });

  it("retains the known 1.0 record meaning without inventing absent coverage", () => {
    const result = validateOwnerExportZip(buildLegacyV1Package());

    expect(result.manifest["schemaVersion"]).toBe("1.0");
    expect(result.recordCounts).toEqual({ "analytics-reports": 1 });
    expect(result.verifiedAssetCount).toBe(0);
  });

  it("verifies the optional profile media dependency against selected media records", () => {
    const result = validateOwnerExportZip(buildRepresentativePackage({ includeProfileMediaAsset: true }));

    expect(result.recordCounts["portfolio-configuration"]).toBe(1);
    expect(result.dependencyCount).toBe(4);
  });

  it("validates complete nested content, taxonomy, media, moderation, and configuration variants", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    const stable = stableId("021");
    const cases = [
      {
        scope: "portfolio-content",
        value: {
          contentId: stable, contentType: "project", lifecycle: "draft", revisions: [{ revisionId: stable, locale: "en", sequence: 1, title: "Title", summary: "Summary", body: "Body", reviewed: false, currentlyPublished: false }],
          publicRouteIdentity: null, routeHistory: [], relatedProjectIds: [], taxonomyValueIds: [], mediaAssetIds: [], evidenceItems: [{ claim: "Claim", state: "unreviewed", supportingArtifactIds: [], mediaAssetId: stable }],
        },
        invalid: { contentId: stable, contentType: "project", lifecycle: "draft", revisions: [{}], publicRouteIdentity: null, routeHistory: [], relatedProjectIds: [], taxonomyValueIds: [], mediaAssetIds: [], evidenceItems: [] },
      },
      {
        scope: "taxonomy",
        value: {
          taxonomyId: stable, aggregateVersion: 2, kind: "technology", values: [{ valueId: stable, name: "Current", state: "active" }, { valueId: stableId("022"), name: "Merged", state: "merged", mergedIntoId: stable }],
          renameHistory: [{ valueId: stable, previousName: "Old", newName: "Current", renamedAt: "2026-10-23T10:00:00Z" }], assignments: [{ targetId: stableId("023"), taxonomyValueId: stable }],
        },
        invalid: { taxonomyId: stable, aggregateVersion: 2, kind: "technology", values: [{ valueId: stable, name: "Merged", state: "merged" }], renameHistory: [], assignments: [] },
      },
      {
        scope: "media-metadata",
        value: { mediaId: stable, kind: "image", state: "accepted", accessibilityMetadata: { kind: "described-image", altText: "A chart" }, processingHistory: [{ result: "passed", detectedMediaType: "image/png", detectedByteLength: 8, sha256: "a".repeat(64), findings: [], recordedAt: "2026-10-23T10:00:00Z" }], decisionHistory: [{ decision: "accepted", decidedAt: "2026-10-23T10:00:00Z" }], processingHistoryTruncated: false, decisionHistoryTruncated: false, publicationState: "accepted", portableReference: `assets/media-metadata/${stable}` },
        invalid: { mediaId: stable, kind: "image", state: "accepted", accessibilityMetadata: { kind: "image" }, processingHistory: [{ result: "unknown" }], decisionHistory: [], publicationState: "accepted", portableReference: `assets/media-metadata/${stable}` },
      },
      {
        scope: "cv-metadata",
        value: { aggregateVersion: 2, currentVersionId: null, versions: [], versionsTruncated: false, activationHistory: [], activationHistoryTruncated: false },
        invalid: { aggregateVersion: 2, currentVersionId: null, versions: [], versionsTruncated: "yes", activationHistory: [], activationHistoryTruncated: true },
      },
      {
        scope: "moderation-history",
        value: { feedbackId: stable, projectId: stableId("024"), locale: "en", aggregateVersion: 2, state: "approved", authorName: "Author", paragraph: "Text", submittedAt: "2026-10-23T10:00:00Z", decisionHistory: [{ decision: "approved", reason: "Reviewed", decidedAt: "2026-10-23T10:00:00Z" }] },
        invalid: { feedbackId: stable, projectId: stableId("024"), locale: "en", aggregateVersion: 2, state: "approved", authorName: "Author", paragraph: "Text", submittedAt: "2026-10-23T10:00:00Z", decisionHistory: [{ decision: "approved", decidedAt: "2026-10-23T10:00:00Z" }] },
      },
      {
        scope: "portfolio-configuration",
        value: { profile: { displayName: "Owner", headline: "Builder", bio: "Bio", mediaAssetId: stable }, contactChannels: { channels: [{ channel: "email", label: "Email", destination: "mailto:owner@example.test", availableLocales: ["en"] }] }, projectCta: { label: "Contact", destination: "https://example.test/contact", unavailableFallback: "Contact unavailable" } },
        invalid: { profile: { displayName: "Owner", headline: "Builder", bio: "Bio" }, contactChannels: { channels: [{ channel: "email" }] }, projectCta: { label: "Contact", destination: "https://example.test", unavailableFallback: "Unavailable" } },
      },
    ];
    for (const { scope, value, invalid } of cases) {
      const schema = JSON.parse(readFileSync(`schemas/owner-export/v1.1/${scope}.schema.json`, "utf8"));
      const validate = ajv.compile(schema);
      expect(validate({ scope, value }), `${scope} valid variant`).toBe(true);
      expect(validate({ scope, value: invalid }), `${scope} malformed nested variant`).toBe(false);
    }

    for (const { scope, value } of cases) {
      const legacyValue = structuredClone(value) as Record<string, unknown>;
      if (scope === "portfolio-content") {
        for (const evidence of legacyValue["evidenceItems"] as Array<Record<string, unknown>>) delete evidence["mediaAssetId"];
      } else if (scope === "taxonomy") {
        for (const taxonomyValue of legacyValue["values"] as Array<Record<string, unknown>>) {
          if (taxonomyValue["mergedIntoId"] !== undefined) {
            taxonomyValue["mergedIntoValueId"] = taxonomyValue["mergedIntoId"];
            delete taxonomyValue["mergedIntoId"];
          }
        }
        legacyValue["assignments"] = (legacyValue["assignments"] as Array<Record<string, unknown>>).map(({ targetId, taxonomyValueId }) => ({
          projectId: targetId,
          valueId: taxonomyValueId,
        }));
      } else if (scope === "media-metadata") {
        delete legacyValue["processingHistoryTruncated"];
        delete legacyValue["decisionHistoryTruncated"];
      } else if (scope === "cv-metadata") {
        delete legacyValue["versionsTruncated"];
        delete legacyValue["activationHistoryTruncated"];
        for (const version of legacyValue["versions"] as Array<Record<string, unknown>>) delete version["portableReference"];
      }
      const schema = JSON.parse(readFileSync(`schemas/owner-export/v1.0/${scope}.schema.json`, "utf8"));
      const validate = ajv.compile(schema);
      expect(validate({ scope, ...legacyValue }), `${scope} immutable v1.0 flat record`).toBe(true);
      expect(validate({ scope, value }), `${scope} v1.1 wrapper is not redefined as v1.0`).toBe(false);
    }
  });

  it("allows media metadata without packaged bytes and only references accepted media bytes", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    const schema = JSON.parse(readFileSync("schemas/owner-export/v1.1/media-metadata.schema.json", "utf8"));
    const validate = ajv.compile(schema);
    const pending = {
      scope: "media-metadata",
      value: {
        mediaId: stableId("025"), kind: "image", state: "upload-pending", accessibilityMetadata: null,
        processingHistory: [], decisionHistory: [], publicationState: "private",
      },
    };

    expect(validate(pending)).toBe(true);
    expect(validate({ ...pending, value: { ...pending.value, portableReference: `assets/media-metadata/${stableId("026")}` } })).toBe(false);
  });

  it("requires bounded media and CV histories to fill the retained limit when marked truncated", () => {
    const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
    const mediaSchema = JSON.parse(readFileSync("schemas/owner-export/v1.1/media-metadata.schema.json", "utf8"));
    const cvSchema = JSON.parse(readFileSync("schemas/owner-export/v1.1/cv-metadata.schema.json", "utf8"));
    const validateMedia = ajv.compile(mediaSchema);
    const validateCv = ajv.compile(cvSchema);
    const processing = { result: "passed", detectedMediaType: "image/png", detectedByteLength: 8, sha256: "a".repeat(64), findings: [], recordedAt: "2026-10-23T10:00:00Z" };
    const decision = { decision: "accepted", decidedAt: "2026-10-23T10:00:00Z" };
    const mediaValue = {
      mediaId: stableId("027"), kind: "image", state: "accepted", accessibilityMetadata: null,
      processingHistory: Array.from({ length: 100 }, () => processing), processingHistoryTruncated: true,
      decisionHistory: Array.from({ length: 100 }, () => decision), decisionHistoryTruncated: true,
      publicationState: "accepted",
    };
    const cvValue = {
      aggregateVersion: 2, currentVersionId: null,
      versions: Array.from({ length: 100 }, (_, index) => ({
        versionId: stableId(String(index).padStart(3, "0")), mediaId: stableId("028"), locale: "en",
        label: "Registered CV", state: "registered", isCurrent: false,
      })),
      versionsTruncated: true,
      activationHistory: Array.from({ length: 100 }, (_, index) => ({
        versionId: stableId(String(index).padStart(3, "0")), activatedAt: "2026-10-23T10:00:00Z",
      })),
      activationHistoryTruncated: true,
    };

    expect(validateMedia({ scope: "media-metadata", value: mediaValue })).toBe(true);
    expect(validateMedia({ scope: "media-metadata", value: { ...mediaValue, processingHistory: mediaValue.processingHistory.slice(0, 99) } })).toBe(false);
    expect(validateCv({ scope: "cv-metadata", value: cvValue })).toBe(true);
    expect(validateCv({ scope: "cv-metadata", value: { ...cvValue, versions: cvValue.versions.slice(0, 99) } })).toBe(false);
  });

  it("accepts an additive minor that keeps the known required feature set", () => {
    const result = validateOwnerExportZip(buildRepresentativePackage({
      adjustManifest: (manifest) => {
        manifest["schemaVersion"] = "1.2";
        manifest["extensions"] = { producerNote: "preserved as opaque metadata" };
      },
    }));

    expect(result.manifest["schemaVersion"]).toBe("1.2");
    expect(result.manifest["extensions"]).toEqual({ producerNote: "preserved as opaque metadata" });
    expect(result.manifest["exportId"]).toBe(stableId("003"));
    expect(result.manifest["snapshot"]).toMatchObject({ snapshotId: stableId("004"), consistency: "transactional" });
    expect(result.manifest["entries"].map((entry) => entry.recordSchema))
      .toEqual(scopes.map((scope) => `urn:shipwithali:owner-export-schema:${scope}:1.1`));
  });

  it("rejects same-length record and schema corruption against declared bytes", () => {
    expect(() => validateOwnerExportZip(buildRepresentativePackage({ corruptRecordSameLength: true })))
      .toThrowError(expect.objectContaining({ code: "ENTRY_DIGEST_MISMATCH" }));
    expect(() => validateOwnerExportZip(buildRepresentativePackage({ corruptSchemaSameLength: true })))
      .toThrowError(expect.objectContaining({ code: "PACKAGE_SCHEMA_DIGEST_MISMATCH" }));
    expect(() => validateOwnerExportZip(buildRepresentativePackage({ corruptAssetSameLength: true })))
      .toThrowError(expect.objectContaining({ code: "PACKAGE_ASSET_DIGEST_MISMATCH" }));
    expect(() => validateOwnerExportZip(buildRepresentativePackage({
      adjustManifest: (manifest) => {
        const schemas = manifest["schemas"] as Array<Record<string, unknown>>;
        schemas[1]!["digest"] = "0".repeat(64);
      },
    }))).toThrowError(expect.objectContaining({ code: "PACKAGE_SCHEMA_DESCRIPTOR_INVALID" }));
    expect(() => validateOwnerExportZip(buildRepresentativePackage({
      adjustManifest: (manifest) => {
        const assets = manifest["assets"] as Array<Record<string, unknown>>;
        assets[0]!["byteLength"] = 10;
      },
    }))).toThrowError(expect.objectContaining({ code: "PACKAGE_ASSET_DIGEST_MISMATCH" }));
  });

  it("rejects path, duplicate, symlink, undeclared and decompression attacks", () => {
    for (const name of ["../escape", "/absolute", "c:/drive", "records\\escape", "records/%2e%2e%2fescape"]) {
      expect(() => validateOwnerExportZip(createZip([{ name, bytes: Buffer.from("x") }])))
        .toThrowError(expect.objectContaining({ code: "ARCHIVE_PATH_UNSAFE" }));
    }
    expect(() => validateOwnerExportZip(createZip([
      { name: "records/item", bytes: Buffer.from("x") },
      { name: "records/item", bytes: Buffer.from("y") },
    ]))).toThrowError(expect.objectContaining({ code: "ARCHIVE_DUPLICATE_PATH" }));
    expect(() => validateOwnerExportZip(createZip([{
      name: "manifest.json", bytes: Buffer.from('{"packageFormat":"x","packageFormat":"y"}'),
    }]))).toThrowError(expect.objectContaining({ code: "PACKAGE_JSON_DUPLICATE_KEY" }));
    expect(() => validateOwnerExportZip(createZip([{ name: "manifest.json", bytes: Buffer.from("{not-json") }])))
      .toThrowError(expect.objectContaining({ code: "PACKAGE_JSON_INVALID" }));
    expect(() => validateOwnerExportZip(createZip([{ name: "manifest.json", bytes: Buffer.from('{"number":1e999}') }])))
      .toThrowError(expect.objectContaining({ code: "PACKAGE_JSON_NUMBER_INVALID" }));
    expect(() => validateOwnerExportZip(buildRepresentativePackage({ malformedRecord: true })))
      .toThrowError(expect.objectContaining({ code: "PACKAGE_NDJSON_INVALID" }));
    expect(() => validateOwnerExportZip(createZip([
      { name: "assets/item", bytes: Buffer.from("x"), externalAttributes: 0o120777 * 0x10000 },
    ]))).toThrowError(expect.objectContaining({ code: "ARCHIVE_SYMLINK_ENTRY" }));
    expect(() => validateOwnerExportZip(buildRepresentativePackage({
      extraEntries: [{ name: "readme.txt", bytes: Buffer.from("undeclared") }],
    }))).toThrowError(expect.objectContaining({ code: "ARCHIVE_UNDECLARED_ENTRY" }));
    expect(() => validateOwnerExportZip(buildRepresentativePackage({ reverseZipMembers: true })))
      .toThrowError(expect.objectContaining({ code: "ARCHIVE_ENTRY_ORDER_INVALID" }));
    expect(() => validateOwnerExportZip(createZip([{ name: "manifest.json", bytes: Buffer.alloc(200_000), method: 8 }])))
      .toThrowError(expect.objectContaining({ code: "ARCHIVE_EXPANSION_LIMIT" }));
  });

  it("rejects unsupported majors, missing required features, and descriptor count drift", () => {
    expect(() => validateOwnerExportZip(buildRepresentativePackage({
      adjustManifest: (manifest) => { manifest["schemaVersion"] = "2.0"; },
    }))).toThrowError(expect.objectContaining({ code: "PACKAGE_VERSION_MAJOR_UNSUPPORTED" }));
    expect(() => validateOwnerExportZip(buildRepresentativePackage({
      adjustManifest: (manifest) => { manifest["requiredFeatures"] = ["record-integrity-v1"]; },
    }))).toThrowError(expect.objectContaining({ code: "PACKAGE_REQUIRED_SEMANTICS_MISSING" }));
    expect(() => validateOwnerExportZip(buildRepresentativePackage({
      adjustManifest: (manifest) => {
        const entries = manifest["entries"] as Array<Record<string, unknown>>;
        entries[0]!["recordCount"] = 2;
      },
    }))).toThrowError(expect.objectContaining({ code: "ENTRY_COUNT_MISMATCH" }));
    expect(() => validateOwnerExportZip(buildRepresentativePackage({ emptyConfigurationAsJson: true })))
      .toThrowError(expect.objectContaining({ code: "PACKAGE_NDJSON_INVALID" }));
    expect(() => validateOwnerExportZip(buildRepresentativePackage({
      adjustManifest: (manifest) => { manifest["exclusions"] = ["credentials"]; },
    }))).toThrowError(expect.objectContaining({ code: "PACKAGE_MANIFEST_INVALID" }));
    expect(() => validateOwnerExportZip(buildRepresentativePackage({
      adjustManifest: (manifest) => { manifest["dependencies"] = []; },
    }))).toThrowError(expect.objectContaining({ code: "PACKAGE_DEPENDENCY_COVERAGE_INVALID" }));
    expect(() => validateOwnerExportZip(buildRepresentativePackage({ reverseAnalyticsVersions: true })))
      .toThrowError(expect.objectContaining({ code: "PACKAGE_RECORD_ORDER_INVALID" }));
    expect(() => validateOwnerExportZip(buildRepresentativePackage({
      adjustManifest: (manifest) => {
        const id = stableId("002");
        manifest["dependencies"] = [
          { sourceScope: "media-metadata", sourceId: id, targetScope: "taxonomy", targetId: stableId("020"), disposition: "omitted", reason: "scope-not-selected" },
          { sourceScope: "media-metadata", sourceId: id, targetScope: "taxonomy", targetId: stableId("019"), disposition: "omitted", reason: "scope-not-selected" },
        ];
      },
    }))).toThrowError(expect.objectContaining({ code: "PACKAGE_DEPENDENCY_ORDER_INVALID" }));
  });

  it("validates an actual ZIP through the offline CLI without printing record data", () => {
    const directory = mkdtempSync(join(tmpdir(), "owner-export-validator-"));
    try {
      const archivePath = join(directory, "representative.zip");
      const malformedArchivePath = join(directory, "malformed.zip");
      const oversizedArchivePath = join(directory, "oversized.zip");
      writeFileSync(archivePath, buildRepresentativePackage());
      writeFileSync(malformedArchivePath, createZip([{ name: "manifest.json", bytes: Buffer.from("{not-json") }]));
      writeFileSync(oversizedArchivePath, Buffer.alloc(0));
      truncateSync(oversizedArchivePath, MAX_OWNER_EXPORT_ARCHIVE_BYTES + 1);
      const cliPath = fileURLToPath(new URL("../../scripts/owner-export/validate-cli.mjs", import.meta.url));
      const run = spawnSync(process.execPath, [cliPath, archivePath], { encoding: "utf8" });
      const failedRun = spawnSync(process.execPath, [cliPath, malformedArchivePath], { encoding: "utf8" });
      const oversizedRun = spawnSync(process.execPath, [cliPath, oversizedArchivePath], { encoding: "utf8" });

      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(JSON.parse(run.stdout)).toMatchObject({ valid: true, schemaVersion: "1.1", recordCounts: { "media-metadata": 1, "cv-metadata": 1, "analytics-reports": 1, "portfolio-configuration": 0 } });
      expect(run.stdout).not.toContain("portableReference");
      expect(failedRun.status).toBe(1);
      expect(failedRun.stderr).toContain("PACKAGE_JSON_INVALID");
      expect(oversizedRun.status).toBe(1);
      expect(oversizedRun.stderr).toContain("ARCHIVE_SIZE_LIMIT");
      expect(readdirSync(directory).sort()).toEqual(["malformed.zip", "oversized.zip", "representative.zip"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
    expect(existsSync(directory)).toBe(false);
  });
});
