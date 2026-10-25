import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StableId } from "@shared/domain";
import type { PortfolioSettings } from "@shared/domain";
import type {
  OwnerExportEntryDescriptor,
  OwnerExportPackageManifestV1_2,
  OwnerExportPackageManifestV1_3,
  OwnerExportContentEntryDescriptor,
  OwnerExportTaxonomyEntryDescriptor,
  OwnerExportDependencyDescriptor,
  OwnerExportPackageManifest,
  OwnerExportSchemaDescriptor,
  OwnerExportPackageManifestV1_4,
  OwnerExportPackageManifestV1_5,
  OwnerExportPackageManifestV1_6,
  OwnerExportAssetDescriptor,
  OwnerExportMediaEntryDescriptor,
  OwnerExportCvEntryDescriptor,
} from "./service.js";
import { isSafeOwnerExportCvMetadataV1_2, isSafeOwnerExportMediaMetadataV1_2 } from "./service.js";
import { MAX_OWNER_EXPORT_ARTIFACT_BYTES } from "./service.js";
import type { OwnerCvExportSnapshot } from "../../cv-portfolio/index.js";

const utf8 = new TextEncoder();
const RECORD_SCHEMA_URI = "urn:shipwithali:owner-export-schema:portfolio-configuration:1.1";
const MANIFEST_SCHEMA_URI = "urn:shipwithali:owner-export-schema:manifest:1.1";

export interface OwnerExportConfigurationSnapshot {
  readonly snapshotId: StableId<"OwnerExportArtifact">;
  readonly capturedAt: string;
  readonly configurationVersion: number | null;
  readonly settings: PortfolioSettings | null;
  readonly capabilities: {
    readonly currentCvAvailable: boolean;
    readonly externalLinksAvailable: boolean;
    readonly globalProjectCtaAvailable: boolean;
  };
  /** Optional policy deadline supplied by an applicable retention policy. */
  readonly policyExpiresAt?: string;
}

/** New immutable checkpoint shape used when a selected scope set is captured together. */
export interface OwnerExportSelectedSnapshot {
  readonly kind: "owner-export-snapshot-v1";
  readonly snapshotId: StableId<"OwnerExportArtifact">;
  readonly capturedAt: string;
  readonly includedScopes: readonly ("portfolio-content" | "taxonomy" | "media-metadata" | "cv-metadata" | "portfolio-configuration")[];
  readonly configuration?: OwnerExportConfigurationSnapshot;
  readonly content?: { readonly records: readonly { readonly contentId: string; readonly value: Readonly<Record<string, unknown>> }[] };
  readonly taxonomy?: { readonly records: readonly { readonly taxonomyId: string; readonly value: Readonly<Record<string, unknown>> }[] };
  readonly media?: OwnerExportMediaSnapshot;
  /** CV facts and exact Media bindings are private to the assembly checkpoint. */
  readonly cv?: OwnerCvExportSnapshot;
  /** Exact accepted PDF output objects required by retained CV versions. */
  readonly cvAssets?: readonly OwnerExportMediaAssetSnapshot[];
}

export interface OwnerExportMediaAssetSnapshot {
  readonly path: string;
  readonly mediaId: string;
  readonly variantName: string;
  readonly mediaType: OwnerExportAssetDescriptor["mediaType"];
  readonly byteLength: number;
  readonly digest: string;
  /** Opaque Media-owned object identity, retained only in the private assembly checkpoint. */
  readonly objectId: string;
  /** Private source kind used to locate the bytes; it is never included in portable records. */
  readonly source: "original" | "variant";
  /** Present only for candidate originals, whose Storage path is upload-intent scoped. */
  readonly uploadIntentId?: string;
  readonly assetVersion?: number;
  readonly decisionId?: string;
  readonly objectVersion?: string;
}

export interface OwnerExportMediaSnapshot {
  readonly records: readonly { readonly mediaId: string; readonly value: Readonly<Record<string, unknown>> }[];
  readonly assets: readonly OwnerExportMediaAssetSnapshot[];
}

export interface OwnerExportMediaObjectReaderPort {
  readMediaExportObject(input: { readonly portfolioId: StableId<"Portfolio">; readonly mediaId: string; readonly objectId: string; readonly source: "original" | "variant"; readonly uploadIntentId?: string; readonly mediaType: OwnerExportAssetDescriptor["mediaType"]; readonly expectedLength: number; readonly expectedSha256: string }): Promise<AsyncIterable<Uint8Array>>;
}

export type OwnerExportAssemblySnapshot = OwnerExportConfigurationSnapshot | OwnerExportSelectedSnapshot;

export interface BuiltOwnerExportPackage {
  readonly contentLength: number;
  readonly sha256: string;
  readonly manifest: OwnerExportPackageManifest;
  readonly content: AsyncIterable<Uint8Array>;
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (item) => item.codePointAt(0) ?? 0);
  const b = Array.from(right, (item) => item.codePointAt(0) ?? 0);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function canonicalJson(value: unknown, omitRootDigest = false): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("OWNER_EXPORT_MANIFEST_NUMBER_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("OWNER_EXPORT_MANIFEST_VALUE_INVALID");
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).filter((key) => !(omitRootDigest && key === "digest")).sort(compareCodePoints);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function updateCrc32(value: number, bytes: Uint8Array): number {
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
  return value >>> 0;
}

export interface OwnerExportStreamIntegrity {
  readonly contentLength: number;
  readonly sha256: string;
  readonly crc32: number;
}

/** Measures an artifact stream without retaining its chunks in memory. */
export async function measureOwnerExportStream(
  content: AsyncIterable<Uint8Array>,
): Promise<OwnerExportStreamIntegrity> {
  const digest = createHash("sha256");
  let contentLength = 0;
  let crc = 0xffffffff;
  for await (const chunk of content) {
    contentLength += chunk.byteLength;
    if (!Number.isSafeInteger(contentLength) || contentLength > MAX_OWNER_EXPORT_ARTIFACT_BYTES) {
      throw new RangeError("OWNER_EXPORT_ARTIFACT_LIMIT_EXCEEDED");
    }
    digest.update(chunk);
    crc = updateCrc32(crc, chunk);
  }
  return { contentLength, sha256: digest.digest("hex"), crc32: (crc ^ 0xffffffff) >>> 0 };
}

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}

export interface StoredOwnerExportZipEntry {
  readonly name: string;
  readonly contentLength: number;
  readonly crc32: number;
  readonly sha256?: string;
  readonly content: () => AsyncIterable<Uint8Array>;
}

/** Emits a deterministic ZIP with one member chunk in flight and no archive buffer. */
export function createStoredOwnerExportZip(entries: readonly StoredOwnerExportZipEntry[]): {
  readonly contentLength: number;
  readonly content: AsyncIterable<Uint8Array>;
} {
  if (entries.length < 1 || entries.length > 0xffff || new Set(entries.map((entry) => entry.name)).size !== entries.length) {
    throw new RangeError("OWNER_EXPORT_ZIP_DIRECTORY_INVALID");
  }
  const prepared: { readonly entry: StoredOwnerExportZipEntry; readonly local: Uint8Array; readonly central: Uint8Array }[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = utf8.encode(entry.name);
    const length = entry.contentLength;
    if (name.byteLength < 1 || name.byteLength > 0xffff || !Number.isSafeInteger(length) || length < 0 ||
        length > 0xffffffff || offset > 0xffffffff || !Number.isInteger(entry.crc32) || entry.crc32 < 0 || entry.crc32 > 0xffffffff) {
      throw new RangeError("OWNER_EXPORT_ZIP32_LIMIT");
    }
    const checksum = entry.crc32 >>> 0;
    const localHeader = concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0x0021),
      u32(checksum), u32(length), u32(length), u16(name.byteLength), u16(0), name,
    ]);
    const centralHeader = concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0x0021),
      u32(checksum), u32(length), u32(length), u16(name.byteLength), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name,
    ]);
    prepared.push({ entry, local: localHeader, central: centralHeader });
    offset += localHeader.byteLength + length;
  }
  if (offset > 0xffffffff) throw new RangeError("OWNER_EXPORT_ZIP32_LIMIT");
  const centralDirectory = concat(prepared.map((entry) => entry.central));
  const centralOffset = offset;
  const end = concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralDirectory.byteLength), u32(centralOffset), u16(0),
  ]);
  const contentLength = centralOffset + centralDirectory.byteLength + end.byteLength;
  if (contentLength > MAX_OWNER_EXPORT_ARTIFACT_BYTES) throw new RangeError("OWNER_EXPORT_ARTIFACT_LIMIT_EXCEEDED");
  const content: AsyncIterable<Uint8Array> = {
    async *[Symbol.asyncIterator]() {
      for (const { entry, local } of prepared) {
        yield local;
        let memberLength = 0;
        let memberCrc = 0xffffffff;
        const memberDigest = entry.sha256 === undefined ? undefined : createHash("sha256");
        for await (const chunk of entry.content()) {
          memberLength += chunk.byteLength;
          if (memberLength > entry.contentLength) throw new RangeError("OWNER_EXPORT_ZIP_MEMBER_LENGTH_MISMATCH");
          memberCrc = updateCrc32(memberCrc, chunk);
          memberDigest?.update(chunk);
          yield chunk;
        }
        if (memberLength !== entry.contentLength || ((memberCrc ^ 0xffffffff) >>> 0) !== (entry.crc32 >>> 0)) {
          throw new RangeError("OWNER_EXPORT_ZIP_MEMBER_INTEGRITY_MISMATCH");
        }
        if (entry.sha256 !== undefined && memberDigest!.digest("hex") !== entry.sha256) {
          throw new RangeError("OWNER_EXPORT_ZIP_MEMBER_INTEGRITY_MISMATCH");
        }
      }
      yield centralDirectory;
      yield end;
    },
  };
  return { contentLength, content };
}

function fixedBytesMember(name: string, bytes: Uint8Array): StoredOwnerExportZipEntry {
  return {
    name,
    contentLength: bytes.byteLength,
    crc32: (updateCrc32(0xffffffff, bytes) ^ 0xffffffff) >>> 0,
    content: () => ({ async *[Symbol.asyncIterator]() { yield bytes; } }),
  };
}

function readPinnedSchema(path: string): Uint8Array {
  return readFileSync(join(process.cwd(), "schemas", "owner-export", "v1.1", path));
}

function readPinnedContentSchema(path: string): Uint8Array {
  return readFileSync(join(process.cwd(), "schemas", "owner-export", "v1.2", path));
}

function readPinnedMediaSchema(path: string): Uint8Array {
  return readFileSync(join(process.cwd(), "schemas", "owner-export", "v1.4", path));
}

function readPinnedCvManifestSchema(): Uint8Array {
  return readFileSync(join(process.cwd(), "schemas", "owner-export", "v1.5", "manifest.schema.json"));
}

function readPinnedCvSchema(path: string): Uint8Array {
  return readFileSync(join(process.cwd(), "schemas", "owner-export", "v1.2", path));
}

function readPinnedTaxonomySchema(path: string): Uint8Array {
  return readFileSync(join(process.cwd(), "schemas", "owner-export", "v1.3", path));
}

/**
 * Builds a configuration-only package. The 1.2 manifest minor uses immutable
 * v1.1 record/schema URIs and carries the source aggregate version and captured
 * capability facts in an additive extension.
 */
export async function buildConfigurationOwnerExportPackage(input: {
  readonly exportId: StableId<"OwnerExport">;
  readonly snapshot: OwnerExportConfigurationSnapshot;
}): Promise<BuiltOwnerExportPackage> {
  const manifestSchema = readPinnedSchema("manifest.schema.json");
  const recordSchema = readPinnedSchema("portfolio-configuration.schema.json");
  const settings = input.snapshot.settings;
  const recordValue = settings === null ? undefined : {
    profile: settings.profile,
    contactChannels: { channels: settings.contactChannels },
    projectCta: settings.globalCta,
  };
  const recordBytes = recordValue === undefined
    ? new Uint8Array()
    : utf8.encode(`${canonicalJson({ scope: "portfolio-configuration", value: recordValue })}\n`);
  const recordCount = recordValue === undefined ? 0 : 1;
  const dependencies = settings?.profile.mediaAssetId === undefined ? [] : [{
    sourceScope: "portfolio-configuration" as const,
    sourceId: settings.profile.mediaAssetId,
    targetScope: "media-metadata" as const,
    targetId: settings.profile.mediaAssetId,
    disposition: "omitted" as const,
    reason: "scope-not-selected" as const,
  }];
  const schemas: OwnerExportSchemaDescriptor[] = [
    { kind: "manifest", path: "schemas/manifest.schema.json", schemaUri: MANIFEST_SCHEMA_URI, schemaVersion: "1.1", digest: sha256(manifestSchema) },
    { kind: "record", scope: "portfolio-configuration", path: "schemas/portfolio-configuration.schema.json", schemaUri: RECORD_SCHEMA_URI, schemaVersion: "1.1", digest: sha256(recordSchema) },
  ];
  const entryDigest = sha256(recordBytes);
  const entry: OwnerExportEntryDescriptor<"portfolio-configuration"> = {
    path: "records/portfolio-configuration.ndjson",
    scope: "portfolio-configuration" as const,
    mediaType: "application/x-ndjson" as const,
    recordSchema: RECORD_SCHEMA_URI,
    schemaPath: "schemas/portfolio-configuration.schema.json",
    schemaVersion: "1.1" as const,
    digest: entryDigest,
    recordCount,
  };
  const manifest = {
    packageFormat: "shipwithali-owner-export" as const,
    schemaVersion: "1.2" as const,
    exportId: input.exportId,
    snapshot: {
      snapshotId: input.snapshot.snapshotId,
      capturedAt: input.snapshot.capturedAt,
      consistency: "transactional" as const,
    },
    createdAt: input.snapshot.capturedAt,
    algorithm: "sha-256" as const,
    digest: "0".repeat(64),
    requiredFeatures: ["asset-integrity-v1", "dependency-coverage-v1", "record-integrity-v1", "schema-integrity-v1", "snapshot-identity-v1"] as const,
    includedScopes: ["portfolio-configuration"] as const,
    publicEventDataCoverage: { mode: "excluded" as const },
    dependencies,
    exclusions: ["raw-public-event-data", "functional-visitor-identities", "measurement-visitor-identities", "sessions", "credentials", "lab-entries"] as const,
    entries: [entry],
    schemas,
    assets: [],
    extensions: {
      configurationSnapshot: {
        aggregateVersion: input.snapshot.configurationVersion,
        availableLocales: settings === null ? [] : [...new Set(settings.contactChannels.flatMap((channel) => channel.availableLocales))].sort(),
        capabilities: input.snapshot.capabilities,
      },
    },
  } satisfies OwnerExportPackageManifestV1_2;
  const digest = sha256(utf8.encode(canonicalJson(manifest, true)));
  const completeManifest = { ...manifest, digest };
  const manifestBytes = utf8.encode(`${JSON.stringify(completeManifest)}\n`);
  const zipEntries: StoredOwnerExportZipEntry[] = [
    fixedBytesMember("manifest.json", manifestBytes),
    fixedBytesMember("schemas/manifest.schema.json", manifestSchema),
    fixedBytesMember("schemas/portfolio-configuration.schema.json", recordSchema),
    fixedBytesMember(entry.path, recordBytes),
  ];
  const archive = createStoredOwnerExportZip(zipEntries);
  const integrity = await measureOwnerExportStream(archive.content);
  if (integrity.contentLength !== archive.contentLength) throw new RangeError("OWNER_EXPORT_ZIP_LENGTH_MISMATCH");
  return { contentLength: archive.contentLength, sha256: integrity.sha256, manifest: completeManifest, content: archive.content };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodePoints);
}

function collectMediaIds(value: unknown, output: Set<string>): void {
  if (Array.isArray(value)) { for (const item of value) collectMediaIds(item, output); return; }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === "mediaAssetId" && typeof nested === "string") output.add(nested);
    else collectMediaIds(nested, output);
  }
}

function expectedDependencies(
  values: readonly { readonly scope: "portfolio-content" | "taxonomy" | "portfolio-configuration"; readonly value: Readonly<Record<string, unknown>> }[],
  includedScopes: readonly string[],
): OwnerExportDependencyDescriptor[] {
  const included = new Set(includedScopes);
  const idsByScope = new Map<string, Set<string>>();
  for (const record of values) {
    const ids = idsByScope.get(record.scope) ?? new Set<string>();
    const walk = (value: unknown): void => {
      if (typeof value === "string") ids.add(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object") Object.values(value as Record<string, unknown>).forEach(walk);
    };
    walk(record.value);
    idsByScope.set(record.scope, ids);
  }
  const rows = new Map<string, { sourceScope: "portfolio-content" | "taxonomy" | "portfolio-configuration"; sourceId: string; targetScope: OwnerExportDependencyDescriptor["targetScope"]; targetId: string }>();
  const add = (sourceScope: "portfolio-content" | "taxonomy" | "portfolio-configuration", sourceId: string, targetScope: OwnerExportDependencyDescriptor["targetScope"], targetId: string) => {
    rows.set([sourceScope, sourceId, targetScope, targetId].join("|"), { sourceScope, sourceId, targetScope, targetId });
  };
  for (const record of values) {
    const value = record.value;
    if (record.scope === "portfolio-content") {
      if (Array.isArray(value["relatedProjectIds"])) for (const id of value["relatedProjectIds"]) if (typeof id === "string") add(record.scope, String(value["contentId"]), "portfolio-content", id);
      if (Array.isArray(value["taxonomyValueIds"])) for (const id of value["taxonomyValueIds"]) if (typeof id === "string") add(record.scope, String(value["contentId"]), "taxonomy", id);
      if (Array.isArray(value["mediaAssetIds"])) for (const id of value["mediaAssetIds"]) if (typeof id === "string") add(record.scope, String(value["contentId"]), "media-metadata", id);
      const mediaIds = new Set<string>();
      collectMediaIds(value["evidenceItems"], mediaIds);
      collectMediaIds(value["revisions"], mediaIds);
      for (const id of mediaIds) add(record.scope, String(value["contentId"]), "media-metadata", id);
    } else if (record.scope === "taxonomy") {
      const taxonomyId = String(value["taxonomyId"]);
      const assignments = value["assignments"];
      const assignmentHistory = value["assignmentHistory"];
      const values = value["values"];
      const evolutionHistory = value["evolutionHistory"];
      if (Array.isArray(assignments)) for (const assignment of assignments) if (assignment !== null && typeof assignment === "object") {
        const row = assignment as Record<string, unknown>;
        if (typeof row["targetId"] === "string") add(record.scope, taxonomyId, "portfolio-content", row["targetId"]);
        if (typeof row["taxonomyValueId"] === "string") add(record.scope, taxonomyId, "taxonomy", row["taxonomyValueId"]);
      }
      if (Array.isArray(assignmentHistory)) for (const assignment of assignmentHistory) if (assignment !== null && typeof assignment === "object") {
        const row = assignment as Record<string, unknown>;
        if (typeof row["targetId"] === "string") add(record.scope, taxonomyId, "portfolio-content", row["targetId"]);
        if (typeof row["taxonomyValueId"] === "string") add(record.scope, taxonomyId, "taxonomy", row["taxonomyValueId"]);
      }
      if (Array.isArray(values)) for (const item of values) if (item !== null && typeof item === "object") {
        const row = item as Record<string, unknown>;
        if (typeof row["mergedIntoValueId"] === "string") add(record.scope, taxonomyId, "taxonomy", row["mergedIntoValueId"]);
      }
      if (Array.isArray(evolutionHistory)) for (const item of evolutionHistory) if (item !== null && typeof item === "object") {
        const row = item as Record<string, unknown>;
        if (typeof row["mergedIntoValueId"] === "string") add(record.scope, taxonomyId, "taxonomy", row["mergedIntoValueId"]);
      }
    } else {
      const profile = value["profile"];
      if (profile !== null && typeof profile === "object" && typeof (profile as Record<string, unknown>)["mediaAssetId"] === "string") {
        const mediaId = (profile as Record<string, string>)["mediaAssetId"]!;
        add(record.scope, mediaId, "media-metadata", mediaId);
      }
    }
  }
  const compare = (left: string, right: string) => compareCodePoints(left, right);
  const scopeOrder = ["portfolio-content", "taxonomy", "media-metadata", "cv-metadata", "moderation-history", "analytics-reports", "portfolio-configuration"];
  return [...rows.values()].sort((left, right) =>
    scopeOrder.indexOf(left.sourceScope) - scopeOrder.indexOf(right.sourceScope) || compare(left.sourceId, right.sourceId) ||
    scopeOrder.indexOf(left.targetScope) - scopeOrder.indexOf(right.targetScope) || compare(left.targetId, right.targetId))
    .map((row) => {
      const targetExists = idsByScope.get(row.targetScope)?.has(row.targetId) === true;
      const selected = included.has(row.targetScope);
      return targetExists && selected
        ? { ...row, disposition: "included" as const }
        : { ...row, disposition: "omitted" as const, reason: selected ? "not-retained" as const : "scope-not-selected" as const };
    });
}

const MAX_PORTABLE_MEDIA_OBJECT_BYTES = 50 * 1024 * 1024;
// manifest/schema 1.4 and the independent validator cap archives at 512 members;
// a Media archive uses four fixed members, leaving at most 508 unique byte objects.
const MAX_MEDIA_EXPORT_ASSETS = 508;

function buildMediaRecordBytes(records: readonly { readonly mediaId: string; readonly value: Readonly<Record<string, unknown>> }[]): Uint8Array {
  return records.length === 0 ? new Uint8Array() : utf8.encode(
    `${records.map((record) => canonicalJson({ scope: "media-metadata", value: record.value })).join("\n")}\n`,
  );
}

/** Builds the Media-only v1.5 slice, re-reading each immutable object after measuring it. */
export async function buildMediaOwnerExportPackage(input: {
  readonly exportId: StableId<"OwnerExport">;
  readonly portfolioId: StableId<"Portfolio">;
  readonly snapshot: OwnerExportSelectedSnapshot;
  readonly objects: OwnerExportMediaObjectReaderPort;
}): Promise<BuiltOwnerExportPackage> {
  const { snapshot } = input;
  if (snapshot.kind !== "owner-export-snapshot-v1" || snapshot.includedScopes.length !== 1 ||
      snapshot.includedScopes[0] !== "media-metadata" || snapshot.media === undefined) {
    throw new TypeError("OWNER_EXPORT_MEDIA_SNAPSHOT_INVALID");
  }
  const orderedRecords = [...snapshot.media.records].sort((left, right) => compareCodePoints(left.mediaId, right.mediaId));
  if (orderedRecords.some((record, index) => !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.mediaId) ||
      record.value["mediaId"] !== record.mediaId || !isSafeOwnerExportMediaMetadataV1_2(record.value) ||
      index > 0 && orderedRecords[index - 1]!.mediaId === record.mediaId)) {
    throw new TypeError("OWNER_EXPORT_MEDIA_RECORD_INVALID");
  }
  const recordIds = new Set(orderedRecords.map((record) => record.mediaId));
  const objectsByPath = new Map<string, typeof snapshot.media.assets[number]>();
  for (const asset of snapshot.media.assets) {
    if (!recordIds.has(asset.mediaId) || asset.path !== `assets/media-metadata/sha256/${asset.digest}` ||
        !/^[a-f0-9]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 1 ||
        asset.byteLength > MAX_PORTABLE_MEDIA_OBJECT_BYTES || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(asset.objectId) ||
        asset.source !== "original" && asset.source !== "variant" ||
        asset.source === "original" && !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(asset.uploadIntentId ?? "") ||
        asset.source === "variant" && asset.uploadIntentId !== undefined) {
      throw new TypeError("OWNER_EXPORT_MEDIA_ASSET_INVALID");
    }
    const existing = objectsByPath.get(asset.path);
    if (existing !== undefined && (existing.digest !== asset.digest || existing.byteLength !== asset.byteLength || existing.mediaType !== asset.mediaType)) {
      throw new TypeError("OWNER_EXPORT_MEDIA_ASSET_CONFLICT");
    }
    if (existing === undefined || compareCodePoints(asset.mediaId, existing.mediaId) < 0 ||
        asset.mediaId === existing.mediaId && compareCodePoints(asset.variantName, existing.variantName) < 0) {
      objectsByPath.set(asset.path, asset);
    }
  }
  const assets = [...objectsByPath.values()].sort((left, right) => compareCodePoints(left.path, right.path));
  if (assets.length > MAX_MEDIA_EXPORT_ASSETS) throw new RangeError("OWNER_EXPORT_MEDIA_ENTRY_COUNT_LIMIT");
  const referencedPaths = new Set<string>();
  for (const record of orderedRecords) {
    const portableAssets = record.value["portableAssets"];
    if (!Array.isArray(portableAssets) || portableAssets.some((item) => item === null || typeof item !== "object" ||
        typeof (item as Record<string, unknown>)["portableReference"] !== "string")) {
      throw new TypeError("OWNER_EXPORT_MEDIA_REFERENCE_INVALID");
    }
    for (const item of portableAssets as readonly Record<string, unknown>[]) {
      const reference = item["portableReference"];
      const asset = typeof reference === "string" ? objectsByPath.get(reference) : undefined;
      if (asset === undefined || item["digest"] !== asset.digest || item["byteLength"] !== asset.byteLength || item["mediaType"] !== asset.mediaType) {
        throw new TypeError("OWNER_EXPORT_MEDIA_REFERENCE_INVALID");
      }
      referencedPaths.add(reference as string);
    }
  }
  if (referencedPaths.size !== objectsByPath.size) throw new TypeError("OWNER_EXPORT_MEDIA_REFERENCE_INVALID");

  const mediaSchema = readPinnedMediaSchema("media-metadata.schema.json");
  const manifestSchema = readPinnedMediaSchema("manifest.schema.json");
  const mediaBytes = buildMediaRecordBytes(orderedRecords);
  const entry: OwnerExportMediaEntryDescriptor = {
    path: "records/media-metadata.ndjson", scope: "media-metadata", mediaType: "application/x-ndjson",
    recordSchema: "urn:shipwithali:owner-export-schema:media-metadata:1.2", schemaPath: "schemas/media-metadata.schema.json",
    schemaVersion: "1.2", digest: sha256(mediaBytes), recordCount: orderedRecords.length,
  };
  const descriptors: OwnerExportAssetDescriptor[] = assets.map((asset) => ({
    path: asset.path, scope: "media-metadata", assetId: asset.mediaId,
    mediaType: asset.mediaType, byteLength: asset.byteLength, digest: asset.digest,
  }));
  const schemaDescriptors: OwnerExportSchemaDescriptor[] = [
    { kind: "manifest", path: "schemas/manifest.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:manifest:1.4", schemaVersion: "1.4", digest: sha256(manifestSchema) },
    { kind: "record", scope: "media-metadata", path: "schemas/media-metadata.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:media-metadata:1.2", schemaVersion: "1.2", digest: sha256(mediaSchema) },
  ];
  const manifest = {
    packageFormat: "shipwithali-owner-export" as const, schemaVersion: "1.5" as const, exportId: input.exportId,
    snapshot: { snapshotId: snapshot.snapshotId, capturedAt: snapshot.capturedAt, consistency: "transactional" as const },
    createdAt: snapshot.capturedAt, algorithm: "sha-256" as const, digest: "0".repeat(64),
    requiredFeatures: ["asset-integrity-v1", "dependency-coverage-v1", "record-integrity-v1", "schema-integrity-v1", "snapshot-identity-v1"] as const,
    includedScopes: ["media-metadata"] as const, publicEventDataCoverage: { mode: "excluded" as const },
    dependencies: [],
    exclusions: ["raw-public-event-data", "functional-visitor-identities", "measurement-visitor-identities", "sessions", "credentials", "lab-entries"] as const,
    entries: [entry], schemas: schemaDescriptors, assets: descriptors,
    extensions: { mediaSnapshot: { acceptanceHistory: "retained-with-explicit-truncation", byteReferences: "sha256-content-addressed", publicationEligibility: "descriptive-only" } },
  } satisfies OwnerExportPackageManifestV1_5;
  const digest = sha256(utf8.encode(canonicalJson(manifest, true)));
  const completeManifest = { ...manifest, digest };
  const manifestBytes = utf8.encode(`${JSON.stringify(completeManifest)}\n`);
  const zipEntries: StoredOwnerExportZipEntry[] = [
    fixedBytesMember("manifest.json", manifestBytes), fixedBytesMember("schemas/manifest.schema.json", manifestSchema),
    fixedBytesMember("schemas/media-metadata.schema.json", mediaSchema), fixedBytesMember(entry.path, mediaBytes),
  ];
  for (const asset of assets) {
    const firstRead = await input.objects.readMediaExportObject({
      portfolioId: input.portfolioId, mediaId: asset.mediaId, objectId: asset.objectId,
      source: asset.source, ...(asset.uploadIntentId === undefined ? {} : { uploadIntentId: asset.uploadIntentId }),
      mediaType: asset.mediaType, expectedLength: asset.byteLength, expectedSha256: asset.digest,
    });
    const measured = await measureOwnerExportStream(firstRead);
    if (measured.contentLength !== asset.byteLength || measured.sha256 !== asset.digest) {
      throw new TypeError("OWNER_EXPORT_MEDIA_OBJECT_INTEGRITY_MISMATCH");
    }
    zipEntries.push({
      name: asset.path, contentLength: measured.contentLength, crc32: measured.crc32, sha256: asset.digest,
      content: async function* () {
        const source = await input.objects.readMediaExportObject({
          portfolioId: input.portfolioId, mediaId: asset.mediaId, objectId: asset.objectId,
          source: asset.source, ...(asset.uploadIntentId === undefined ? {} : { uploadIntentId: asset.uploadIntentId }),
          mediaType: asset.mediaType, expectedLength: asset.byteLength, expectedSha256: asset.digest,
        });
        yield* source;
      },
    });
  }
  const archive = createStoredOwnerExportZip(zipEntries);
  const integrity = await measureOwnerExportStream(archive.content);
  if (integrity.contentLength !== archive.contentLength) throw new RangeError("OWNER_EXPORT_ZIP_LENGTH_MISMATCH");
  return { contentLength: archive.contentLength, sha256: integrity.sha256, manifest: completeManifest, content: archive.content };
}

/** Builds CV v1.6 with exact accepted Media PDF bytes, retaining source-owned lifecycle identities. */
export async function buildCvOwnerExportPackage(input: {
  readonly exportId: StableId<"OwnerExport">;
  readonly portfolioId: StableId<"Portfolio">;
  readonly snapshot: OwnerExportSelectedSnapshot;
  readonly objects: OwnerExportMediaObjectReaderPort;
}): Promise<BuiltOwnerExportPackage> {
  const { snapshot } = input;
  const hasMedia = snapshot.includedScopes.includes("media-metadata");
  const expectedScopes = hasMedia ? ["media-metadata", "cv-metadata"] : ["cv-metadata"];
  if (snapshot.kind !== "owner-export-snapshot-v1" || !sameStringArray(snapshot.includedScopes, expectedScopes) ||
      snapshot.cv === undefined || snapshot.cvAssets === undefined ||
      hasMedia !== (snapshot.media !== undefined) || snapshot.configuration !== undefined || snapshot.content !== undefined || snapshot.taxonomy !== undefined) {
    throw new TypeError("OWNER_EXPORT_CV_SNAPSHOT_INVALID");
  }
  const cv = snapshot.cv;
  const currentCount = cv.versions.filter((version) => version.isCurrent).length;
  if ((cv.currentVersionId === null && currentCount !== 0) || (cv.currentVersionId !== null && currentCount !== 1) ||
      cv.currentVersionId !== null && !cv.versions.some((version) => version.versionId === cv.currentVersionId && version.isCurrent && version.state === "accepted")) {
    throw new TypeError("OWNER_EXPORT_CV_CURRENT_POINTER_INVALID");
  }
  const acceptedAssets = new Map<string, OwnerExportMediaAssetSnapshot>();
  for (const asset of snapshot.cvAssets) {
    if (asset.source !== "variant" || asset.mediaType !== "application/pdf" || asset.uploadIntentId !== undefined ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(asset.mediaId) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(asset.objectId) ||
        !Number.isSafeInteger(asset.assetVersion) || (asset.assetVersion ?? 0) < 1 ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(asset.decisionId ?? "") ||
        typeof asset.objectVersion !== "string" || asset.objectVersion.length < 1 || asset.objectVersion.length > 255 ||
        !/^[a-f0-9]{64}$/.test(asset.digest) || asset.objectVersion !== asset.digest ||
        !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 1 || asset.byteLength > MAX_PORTABLE_MEDIA_OBJECT_BYTES ||
        asset.path !== `assets/media-metadata/sha256/${asset.digest}`) {
      throw new TypeError("OWNER_EXPORT_CV_ASSET_INVALID");
    }
    const key = `${asset.mediaId}|${asset.objectId}|${asset.digest}`;
    const existing = acceptedAssets.get(key);
    if (existing !== undefined && (existing.byteLength !== asset.byteLength || existing.objectVersion !== asset.objectVersion ||
        existing.assetVersion !== asset.assetVersion || existing.decisionId !== asset.decisionId)) {
      throw new TypeError("OWNER_EXPORT_CV_ASSET_CONFLICT");
    }
    acceptedAssets.set(key, asset);
  }
  const versionAssets = new Map<string, OwnerExportMediaAssetSnapshot>();
  const versions = [...cv.versions].sort((left, right) => right.versionNumber - left.versionNumber || compareCodePoints(left.versionId, right.versionId));
  for (const version of versions) {
    if (version.state === "registered") {
      if (version.acceptedAt !== undefined || version.acceptedMediaSnapshot !== undefined) throw new TypeError("OWNER_EXPORT_CV_VERSION_INVALID");
      continue;
    }
    const binding = version.acceptedMediaSnapshot;
    if (version.acceptedAt === undefined || binding === undefined) throw new TypeError("OWNER_EXPORT_CV_VERSION_INVALID");
    const asset = [...acceptedAssets.values()].find((candidate) => candidate.mediaId === version.mediaId &&
      candidate.objectId === binding.mediaObjectId && candidate.assetVersion === binding.mediaAssetVersion &&
      candidate.decisionId === binding.mediaDecisionId && candidate.digest === binding.sha256 &&
      candidate.objectVersion === binding.objectVersion);
    if (asset === undefined) throw new TypeError("OWNER_EXPORT_CV_REQUIRED_BYTES_MISSING");
    versionAssets.set(version.versionId, asset);
  }
  const referencedAcceptedAssetKeys = new Set([...versionAssets.values()].map((asset) => `${asset.mediaId}|${asset.objectId}|${asset.digest}`));
  if (referencedAcceptedAssetKeys.size !== acceptedAssets.size || [...acceptedAssets.keys()].some((key) => !referencedAcceptedAssetKeys.has(key))) {
    throw new TypeError("OWNER_EXPORT_CV_ASSET_UNREFERENCED");
  }
  const cvValue = {
    aggregateVersion: cv.aggregateVersion,
    currentVersionId: cv.currentVersionId,
    versions: versions.map((version) => ({
      versionId: version.versionId,
      mediaId: version.mediaId,
      versionNumber: version.versionNumber,
      locale: version.locale,
      registeredAt: version.registeredAt,
      ...(version.acceptedAt === undefined ? {} : { acceptedAt: version.acceptedAt }),
      ...(version.state === "accepted" ? { portableReference: versionAssets.get(version.versionId)!.path } : {}),
      label: version.label,
      state: version.state,
      isCurrent: version.isCurrent,
    })),
    versionsTruncated: cv.versionsTruncated,
    acceptanceHistory: cv.acceptanceHistory.map((entry) => ({ approvalId: entry.approvalId, versionId: entry.versionId, acceptedAt: entry.acceptedAt })),
    acceptanceHistoryTruncated: cv.acceptanceHistoryTruncated,
    activationHistory: cv.activationHistory.map((entry) => ({ activationId: entry.activationId, versionId: entry.versionId, activatedAt: entry.activatedAt })),
    activationHistoryTruncated: cv.activationHistoryTruncated,
  };
  if (!isSafeOwnerExportCvMetadataV1_2(cvValue)) throw new TypeError("OWNER_EXPORT_CV_RECORD_INVALID");
  const cvBytes = utf8.encode(`${canonicalJson({ scope: "cv-metadata", value: cvValue })}\n`);
  const cvSchema = readPinnedCvSchema("cv-metadata.schema.json");
  const manifestSchema = readPinnedCvManifestSchema();
  const mediaRecords = hasMedia ? [...snapshot.media!.records].sort((left, right) => compareCodePoints(left.mediaId, right.mediaId)) : [];
  if (hasMedia && mediaRecords.some((record, index) => record.value["mediaId"] !== record.mediaId ||
      !isSafeOwnerExportMediaMetadataV1_2(record.value) || index > 0 && mediaRecords[index - 1]!.mediaId === record.mediaId)) {
    throw new TypeError("OWNER_EXPORT_MEDIA_RECORD_INVALID");
  }
  const allAssets = [...(snapshot.media?.assets ?? []), ...snapshot.cvAssets];
  const objectsByPath = new Map<string, OwnerExportMediaAssetSnapshot>();
  for (const asset of allAssets) {
    if (asset.path !== `assets/media-metadata/sha256/${asset.digest}` || !/^[a-f0-9]{64}$/.test(asset.digest) ||
        !Number.isSafeInteger(asset.byteLength) || asset.byteLength < 1 || asset.byteLength > MAX_PORTABLE_MEDIA_OBJECT_BYTES ||
        !/^[0-9a-f-]{36}$/.test(asset.objectId) || (asset.source !== "original" && asset.source !== "variant") ||
        asset.source === "original" && !/^[0-9a-f-]{36}$/.test(asset.uploadIntentId ?? "") ||
        asset.source === "variant" && asset.uploadIntentId !== undefined) throw new TypeError("OWNER_EXPORT_CV_ASSET_INVALID");
    const existing = objectsByPath.get(asset.path);
    if (existing !== undefined && (existing.digest !== asset.digest || existing.byteLength !== asset.byteLength || existing.mediaType !== asset.mediaType)) {
      throw new TypeError("OWNER_EXPORT_CV_ASSET_CONFLICT");
    }
    if (existing === undefined || compareCodePoints(asset.mediaId, existing.mediaId) < 0 ||
        asset.mediaId === existing.mediaId && compareCodePoints(asset.variantName, existing.variantName) < 0) objectsByPath.set(asset.path, asset);
  }
  const assets = [...objectsByPath.values()].sort((left, right) => compareCodePoints(left.path, right.path));
  if (assets.length > MAX_MEDIA_EXPORT_ASSETS - (hasMedia ? 2 : 0)) throw new RangeError("OWNER_EXPORT_MEDIA_ENTRY_COUNT_LIMIT");
  const referencedPaths = new Set<string>();
  for (const version of cvValue.versions) if (version.portableReference !== undefined) referencedPaths.add(version.portableReference);
  for (const record of mediaRecords) {
    const portableAssets = record.value["portableAssets"];
    if (!Array.isArray(portableAssets)) throw new TypeError("OWNER_EXPORT_MEDIA_REFERENCE_INVALID");
    for (const value of portableAssets) {
      if (value === null || typeof value !== "object") throw new TypeError("OWNER_EXPORT_MEDIA_REFERENCE_INVALID");
      const ref = (value as Record<string, unknown>)["portableReference"];
      const asset = typeof ref === "string" ? objectsByPath.get(ref) : undefined;
      if (asset === undefined || (value as Record<string, unknown>)["digest"] !== asset.digest ||
          (value as Record<string, unknown>)["byteLength"] !== asset.byteLength || (value as Record<string, unknown>)["mediaType"] !== asset.mediaType) {
        throw new TypeError("OWNER_EXPORT_MEDIA_REFERENCE_INVALID");
      }
      referencedPaths.add(ref as string);
    }
  }
  if (referencedPaths.size !== objectsByPath.size || assets.some((asset) => !referencedPaths.has(asset.path))) throw new TypeError("OWNER_EXPORT_MEDIA_REFERENCE_INVALID");
  const cvEntry: OwnerExportCvEntryDescriptor = { path: "records/cv-metadata.ndjson", scope: "cv-metadata", mediaType: "application/x-ndjson",
    recordSchema: "urn:shipwithali:owner-export-schema:cv-metadata:1.2", schemaPath: "schemas/cv-metadata.schema.json", schemaVersion: "1.2", digest: sha256(cvBytes), recordCount: 1 };
  const entries: (OwnerExportCvEntryDescriptor | OwnerExportMediaEntryDescriptor)[] = [];
  let mediaBytes: Uint8Array | undefined;
  if (hasMedia) {
    mediaBytes = buildMediaRecordBytes(mediaRecords);
    entries.push({ path: "records/media-metadata.ndjson", scope: "media-metadata", mediaType: "application/x-ndjson",
      recordSchema: "urn:shipwithali:owner-export-schema:media-metadata:1.2", schemaPath: "schemas/media-metadata.schema.json", schemaVersion: "1.2",
      digest: sha256(mediaBytes), recordCount: mediaRecords.length });
  }
  entries.push(cvEntry);
  const descriptors: OwnerExportAssetDescriptor[] = assets.map((asset) => ({ path: asset.path, scope: "media-metadata", assetId: asset.mediaId,
    mediaType: asset.mediaType, byteLength: asset.byteLength, digest: asset.digest, ...(asset.variantName === "original" ? {} : { variantName: asset.variantName }) }));
  const schemas: OwnerExportSchemaDescriptor[] = [
    { kind: "manifest", path: "schemas/manifest.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:manifest:1.5", schemaVersion: "1.5", digest: sha256(manifestSchema) },
  ];
  if (hasMedia) schemas.push({ kind: "record", scope: "media-metadata", path: "schemas/media-metadata.schema.json",
    schemaUri: "urn:shipwithali:owner-export-schema:media-metadata:1.2", schemaVersion: "1.2", digest: sha256(readPinnedMediaSchema("media-metadata.schema.json")) });
  schemas.push({ kind: "record", scope: "cv-metadata", path: "schemas/cv-metadata.schema.json",
    schemaUri: "urn:shipwithali:owner-export-schema:cv-metadata:1.2", schemaVersion: "1.2", digest: sha256(cvSchema) });
  const mediaIds = new Set(mediaRecords.map((record) => record.mediaId));
  const dependencies = versions.map((version) => ({ sourceScope: "cv-metadata" as const, sourceId: version.versionId,
    targetScope: "media-metadata" as const, targetId: version.mediaId,
    disposition: hasMedia && mediaIds.has(version.mediaId) ? "included" as const : "omitted" as const,
    ...(hasMedia && mediaIds.has(version.mediaId) ? {} : { reason: hasMedia ? "not-retained" as const : "scope-not-selected" as const }),
  })).sort((left, right) => compareCodePoints(left.sourceId, right.sourceId) || compareCodePoints(left.targetId, right.targetId));
  const manifest = {
    packageFormat: "shipwithali-owner-export" as const, schemaVersion: "1.6" as const, exportId: input.exportId,
    snapshot: { snapshotId: snapshot.snapshotId, capturedAt: snapshot.capturedAt, consistency: "transactional" as const },
    createdAt: snapshot.capturedAt, algorithm: "sha-256" as const, digest: "0".repeat(64),
    requiredFeatures: ["asset-integrity-v1", "dependency-coverage-v1", "record-integrity-v1", "schema-integrity-v1", "snapshot-identity-v1"] as const,
    includedScopes: [...snapshot.includedScopes], publicEventDataCoverage: { mode: "excluded" as const }, dependencies,
    exclusions: ["raw-public-event-data", "functional-visitor-identities", "measurement-visitor-identities", "sessions", "credentials", "lab-entries"] as const,
    entries, schemas, assets: descriptors, extensions: { cvSnapshot: { acceptanceHistory: "retained-with-explicit-truncation", activationHistory: "retained-with-explicit-truncation", byteReferences: "sha256-content-addressed" } },
  } satisfies OwnerExportPackageManifestV1_6;
  const digest = sha256(utf8.encode(canonicalJson(manifest, true)));
  const completeManifest = { ...manifest, digest };
  const manifestBytes = utf8.encode(`${JSON.stringify(completeManifest)}\n`);
  const zipEntries: StoredOwnerExportZipEntry[] = [fixedBytesMember("manifest.json", manifestBytes), fixedBytesMember("schemas/manifest.schema.json", manifestSchema)];
  if (hasMedia) {
    zipEntries.push(fixedBytesMember("schemas/media-metadata.schema.json", readPinnedMediaSchema("media-metadata.schema.json")));
  }
  zipEntries.push(fixedBytesMember("schemas/cv-metadata.schema.json", cvSchema));
  if (hasMedia) zipEntries.push(fixedBytesMember("records/media-metadata.ndjson", mediaBytes!));
  zipEntries.push(fixedBytesMember(cvEntry.path, cvBytes));
  for (const asset of assets) {
    const firstRead = await input.objects.readMediaExportObject({ portfolioId: input.portfolioId, mediaId: asset.mediaId,
      objectId: asset.objectId, source: asset.source, ...(asset.uploadIntentId === undefined ? {} : { uploadIntentId: asset.uploadIntentId }),
      mediaType: asset.mediaType, expectedLength: asset.byteLength, expectedSha256: asset.digest });
    const measured = await measureOwnerExportStream(firstRead);
    if (measured.contentLength !== asset.byteLength || measured.sha256 !== asset.digest) throw new TypeError("OWNER_EXPORT_CV_OBJECT_INTEGRITY_MISMATCH");
    zipEntries.push({ name: asset.path, contentLength: measured.contentLength, crc32: measured.crc32, sha256: asset.digest,
      content: async function* () {
        const source = await input.objects.readMediaExportObject({ portfolioId: input.portfolioId, mediaId: asset.mediaId, objectId: asset.objectId,
          source: asset.source, ...(asset.uploadIntentId === undefined ? {} : { uploadIntentId: asset.uploadIntentId }),
          mediaType: asset.mediaType, expectedLength: asset.byteLength, expectedSha256: asset.digest });
        yield* source;
      } });
  }
  const archive = createStoredOwnerExportZip(zipEntries);
  const integrity = await measureOwnerExportStream(archive.content);
  if (integrity.contentLength !== archive.contentLength) throw new RangeError("OWNER_EXPORT_ZIP_LENGTH_MISMATCH");
  return { contentLength: archive.contentLength, sha256: integrity.sha256, manifest: completeManifest, content: archive.content };
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function buildTaxonomyOwnerExportPackage(input: {
  readonly exportId: StableId<"OwnerExport">;
  readonly snapshot: OwnerExportSelectedSnapshot;
}): Promise<BuiltOwnerExportPackage> {
  const { snapshot } = input;
  const hasContent = snapshot.includedScopes.includes("portfolio-content");
  const hasConfiguration = snapshot.includedScopes.includes("portfolio-configuration");
  const canonicalScopes = ["portfolio-content", "taxonomy", "portfolio-configuration"]
    .filter((scope) => snapshot.includedScopes.includes(scope as OwnerExportSelectedSnapshot["includedScopes"][number]));
  if (canonicalScopes.length !== snapshot.includedScopes.length ||
      canonicalScopes.some((scope, index) => snapshot.includedScopes[index] !== scope) ||
      !snapshot.includedScopes.includes("taxonomy") || hasContent !== (snapshot.content !== undefined) ||
      hasConfiguration !== (snapshot.configuration !== undefined) || snapshot.taxonomy === undefined) {
    throw new TypeError("OWNER_EXPORT_TAXONOMY_SNAPSHOT_INVALID");
  }
  const manifestSchema = readPinnedTaxonomySchema("manifest.schema.json");
  const taxonomySchema = readPinnedTaxonomySchema("taxonomy.schema.json");
  const contentSchema = hasContent ? readPinnedContentSchema("portfolio-content.schema.json") : undefined;
  const configurationSchema = hasConfiguration ? readPinnedSchema("portfolio-configuration.schema.json") : undefined;
  const contentValues = snapshot.content?.records.map((record) => record.value) ?? [];
  const taxonomyValues = snapshot.taxonomy.records.map((record) => record.value);
  if (contentValues.some((value) => typeof value["contentId"] !== "string") ||
      taxonomyValues.some((value) => typeof value["taxonomyId"] !== "string")) throw new TypeError("OWNER_EXPORT_TAXONOMY_RECORD_INVALID");
  const orderedContent = [...contentValues].sort((left, right) => compareCodePoints(String(left["contentId"]), String(right["contentId"])));
  const orderedTaxonomy = [...taxonomyValues].sort((left, right) => compareCodePoints(String(left["taxonomyId"]), String(right["taxonomyId"])));
  const contentIds = new Map(orderedContent.map((value) => [String(value["contentId"]), value]));
  const taxonomyValuesById = new Map<string, Record<string, unknown>>();
  for (const taxonomy of orderedTaxonomy) {
    if (!Array.isArray(taxonomy["values"]) || !Array.isArray(taxonomy["assignments"]) ||
        !Array.isArray(taxonomy["assignmentHistory"]) || !Array.isArray(taxonomy["evolutionHistory"])) {
      throw new TypeError("OWNER_EXPORT_TAXONOMY_RECORD_INVALID");
    }
    for (const item of taxonomy["values"]) {
      if (item === null || typeof item !== "object" || typeof (item as Record<string, unknown>)["valueId"] !== "string") {
        throw new TypeError("OWNER_EXPORT_TAXONOMY_VALUE_INVALID");
      }
      const valueId = String((item as Record<string, unknown>)["valueId"]);
      if (taxonomyValuesById.has(valueId)) throw new TypeError("OWNER_EXPORT_TAXONOMY_VALUE_DUPLICATE");
      taxonomyValuesById.set(valueId, taxonomy);
    }
  }
  if (hasContent) {
    for (const content of orderedContent) {
      if (!Array.isArray(content["taxonomyValueIds"]) || content["taxonomyValueIds"].some((valueId) => !taxonomyValuesById.has(String(valueId)))) {
        throw new TypeError("OWNER_EXPORT_TAXONOMY_CONTENT_REFERENCE_DANGLING");
      }
    }
  }
  for (const taxonomy of orderedTaxonomy) {
    const assignments = [...(taxonomy["assignments"] as readonly unknown[]), ...(taxonomy["assignmentHistory"] as readonly unknown[])];
    for (const assignment of assignments) {
      if (assignment === null || typeof assignment !== "object") throw new TypeError("OWNER_EXPORT_TAXONOMY_ASSIGNMENT_INVALID");
      const row = assignment as Record<string, unknown>;
      if (typeof row["taxonomyValueId"] !== "string" || taxonomyValuesById.get(row["taxonomyValueId"]) !== taxonomy) {
        throw new TypeError("OWNER_EXPORT_TAXONOMY_ASSIGNMENT_DANGLING");
      }
      if (hasContent) {
        const target = typeof row["targetId"] === "string" ? contentIds.get(row["targetId"]) : undefined;
        if (target?.["contentType"] !== "project") throw new TypeError("OWNER_EXPORT_TAXONOMY_PROJECT_REFERENCE_DANGLING");
      }
    }
  }
  const contentBytes = orderedContent.length === 0 ? new Uint8Array() : utf8.encode(
    `${orderedContent.map((value) => canonicalJson({ scope: "portfolio-content", value })).join("\n")}\n`,
  );
  const taxonomyBytes = orderedTaxonomy.length === 0 ? new Uint8Array() : utf8.encode(
    `${orderedTaxonomy.map((value) => canonicalJson({ scope: "taxonomy", value })).join("\n")}\n`,
  );
  const settings = snapshot.configuration?.settings;
  const configurationValues = settings === undefined || settings === null ? [] : [{
    profile: settings.profile,
    contactChannels: { channels: settings.contactChannels },
    projectCta: settings.globalCta,
  }];
  const configurationBytes = configurationValues.length === 0 ? new Uint8Array() : utf8.encode(
    `${canonicalJson({ scope: "portfolio-configuration", value: configurationValues[0] })}\n`,
  );
  const entries: (OwnerExportContentEntryDescriptor | OwnerExportTaxonomyEntryDescriptor | OwnerExportEntryDescriptor)[] = [];
  if (hasContent) entries.push({
    path: "records/portfolio-content.ndjson", scope: "portfolio-content", mediaType: "application/x-ndjson",
    recordSchema: "urn:shipwithali:owner-export-schema:portfolio-content:1.2", schemaPath: "schemas/portfolio-content.schema.json",
    schemaVersion: "1.2", digest: sha256(contentBytes), recordCount: orderedContent.length,
  });
  entries.push({
    path: "records/taxonomy.ndjson", scope: "taxonomy", mediaType: "application/x-ndjson",
    recordSchema: "urn:shipwithali:owner-export-schema:taxonomy:1.2", schemaPath: "schemas/taxonomy.schema.json",
    schemaVersion: "1.2", digest: sha256(taxonomyBytes), recordCount: orderedTaxonomy.length,
  });
  if (hasConfiguration) entries.push({
    path: "records/portfolio-configuration.ndjson", scope: "portfolio-configuration", mediaType: "application/x-ndjson",
    recordSchema: "urn:shipwithali:owner-export-schema:portfolio-configuration:1.1", schemaPath: "schemas/portfolio-configuration.schema.json",
    schemaVersion: "1.1", digest: sha256(configurationBytes), recordCount: configurationValues.length,
  });
  const schemas: OwnerExportSchemaDescriptor[] = [
    { kind: "manifest", path: "schemas/manifest.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:manifest:1.3", schemaVersion: "1.3", digest: sha256(manifestSchema) },
  ];
  if (hasContent) schemas.push({
    kind: "record", scope: "portfolio-content", path: "schemas/portfolio-content.schema.json",
    schemaUri: "urn:shipwithali:owner-export-schema:portfolio-content:1.2", schemaVersion: "1.2", digest: sha256(contentSchema!),
  });
  schemas.push({ kind: "record", scope: "taxonomy", path: "schemas/taxonomy.schema.json",
    schemaUri: "urn:shipwithali:owner-export-schema:taxonomy:1.2", schemaVersion: "1.2", digest: sha256(taxonomySchema) });
  if (hasConfiguration) schemas.push({ kind: "record", scope: "portfolio-configuration", path: "schemas/portfolio-configuration.schema.json",
    schemaUri: "urn:shipwithali:owner-export-schema:portfolio-configuration:1.1", schemaVersion: "1.1", digest: sha256(configurationSchema!) });
  const recordsForDependencies = [
    ...orderedContent.map((value) => ({ scope: "portfolio-content" as const, value })),
    ...orderedTaxonomy.map((value) => ({ scope: "taxonomy" as const, value })),
    ...configurationValues.map((value) => ({ scope: "portfolio-configuration" as const, value: value as Readonly<Record<string, unknown>> })),
  ];
  const dependencies = expectedDependencies(recordsForDependencies, snapshot.includedScopes);
  const manifest = {
    packageFormat: "shipwithali-owner-export" as const, schemaVersion: "1.4" as const, exportId: input.exportId,
    snapshot: { snapshotId: snapshot.snapshotId, capturedAt: snapshot.capturedAt, consistency: "transactional" as const },
    createdAt: snapshot.capturedAt, algorithm: "sha-256" as const, digest: "0".repeat(64),
    requiredFeatures: ["asset-integrity-v1", "dependency-coverage-v1", "record-integrity-v1", "schema-integrity-v1", "snapshot-identity-v1"] as const,
    includedScopes: [...snapshot.includedScopes], publicEventDataCoverage: { mode: "excluded" as const }, dependencies,
    exclusions: ["raw-public-event-data", "functional-visitor-identities", "measurement-visitor-identities", "sessions", "credentials", "lab-entries"] as const,
    entries, schemas, assets: [], extensions: { taxonomySnapshot: { identity: "stable", evolutionHistory: "complete", assignmentHistory: "complete" } },
  } satisfies OwnerExportPackageManifestV1_4;
  const digest = sha256(utf8.encode(canonicalJson(manifest, true)));
  const completeManifest = { ...manifest, digest };
  const manifestBytes = utf8.encode(`${JSON.stringify(completeManifest)}\n`);
  const zipEntries: StoredOwnerExportZipEntry[] = [
    fixedBytesMember("manifest.json", manifestBytes), fixedBytesMember("schemas/manifest.schema.json", manifestSchema),
  ];
  if (hasContent) zipEntries.push(fixedBytesMember("schemas/portfolio-content.schema.json", contentSchema!));
  zipEntries.push(fixedBytesMember("schemas/taxonomy.schema.json", taxonomySchema));
  if (hasConfiguration) zipEntries.push(fixedBytesMember("schemas/portfolio-configuration.schema.json", configurationSchema!));
  if (hasContent) zipEntries.push(fixedBytesMember("records/portfolio-content.ndjson", contentBytes));
  zipEntries.push(fixedBytesMember("records/taxonomy.ndjson", taxonomyBytes));
  if (hasConfiguration) zipEntries.push(fixedBytesMember("records/portfolio-configuration.ndjson", configurationBytes));
  const archive = createStoredOwnerExportZip(zipEntries);
  const integrity = await measureOwnerExportStream(archive.content);
  if (integrity.contentLength !== archive.contentLength) throw new RangeError("OWNER_EXPORT_ZIP_LENGTH_MISMATCH");
  return { contentLength: archive.contentLength, sha256: integrity.sha256, manifest: completeManifest, content: archive.content };
}

/** Builds the content package v1.3 without changing the meaning of any v1.1 record. */
export async function buildSelectedOwnerExportPackage(input: {
  readonly exportId: StableId<"OwnerExport">;
  readonly snapshot: OwnerExportSelectedSnapshot;
}): Promise<BuiltOwnerExportPackage> {
  const { snapshot } = input;
  if (snapshot.kind !== "owner-export-snapshot-v1") {
    throw new TypeError("OWNER_EXPORT_CONTENT_SNAPSHOT_INVALID");
  }
  if (snapshot.includedScopes.includes("taxonomy")) return buildTaxonomyOwnerExportPackage(input);
  if (!snapshot.includedScopes.includes("portfolio-content") || snapshot.content === undefined) throw new TypeError("OWNER_EXPORT_CONTENT_SNAPSHOT_INVALID");
  const hasConfiguration = snapshot.includedScopes.includes("portfolio-configuration");
  if (hasConfiguration !== (snapshot.configuration !== undefined)) throw new TypeError("OWNER_EXPORT_SCOPE_SNAPSHOT_INCOMPLETE");
  const manifestSchema = readPinnedContentSchema("manifest.schema.json");
  const contentSchema = readPinnedContentSchema("portfolio-content.schema.json");
  const configurationSchema = hasConfiguration ? readPinnedSchema("portfolio-configuration.schema.json") : undefined;
  const contentValues = snapshot.content.records.map((record) => record.value);
  if (contentValues.some((value) => value["contentId"] === undefined)) throw new TypeError("OWNER_EXPORT_CONTENT_RECORD_INVALID");
  const orderedContent = [...contentValues].sort((left, right) => compareCodePoints(String(left["contentId"]), String(right["contentId"])));
  const contentBytes = orderedContent.length === 0 ? new Uint8Array() : utf8.encode(
    `${orderedContent.map((value) => canonicalJson({ scope: "portfolio-content", value })).join("\n")}\n`,
  );
  let configurationBytes = new Uint8Array();
  let configurationRecords: Readonly<Record<string, unknown>>[] = [];
  if (snapshot.configuration?.settings !== undefined && snapshot.configuration.settings !== null) {
    const settings = snapshot.configuration.settings;
    configurationRecords = [{
      profile: settings.profile,
      contactChannels: { channels: settings.contactChannels },
      projectCta: settings.globalCta,
    }];
    configurationBytes = utf8.encode(`${canonicalJson({ scope: "portfolio-configuration", value: configurationRecords[0] })}\n`);
  }
  const contentEntry: OwnerExportContentEntryDescriptor = {
    path: "records/portfolio-content.ndjson", scope: "portfolio-content", mediaType: "application/x-ndjson",
    recordSchema: "urn:shipwithali:owner-export-schema:portfolio-content:1.2",
    schemaPath: "schemas/portfolio-content.schema.json", schemaVersion: "1.2", digest: sha256(contentBytes), recordCount: orderedContent.length,
  };
  const entries: (OwnerExportContentEntryDescriptor | OwnerExportEntryDescriptor)[] = [contentEntry];
  if (hasConfiguration) {
    const settings = snapshot.configuration?.settings;
    entries.push({
      path: "records/portfolio-configuration.ndjson", scope: "portfolio-configuration", mediaType: "application/x-ndjson",
      recordSchema: RECORD_SCHEMA_URI.replace("manifest", "portfolio-configuration") as OwnerExportEntryDescriptor["recordSchema"],
      schemaPath: "schemas/portfolio-configuration.schema.json", schemaVersion: "1.1", digest: sha256(configurationBytes),
      recordCount: configurationRecords.length,
    });
    void settings;
  }
  const schemas: OwnerExportSchemaDescriptor[] = [
    { kind: "manifest", path: "schemas/manifest.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:manifest:1.2", schemaVersion: "1.2", digest: sha256(manifestSchema) },
    { kind: "record", scope: "portfolio-content", path: "schemas/portfolio-content.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:portfolio-content:1.2", schemaVersion: "1.2", digest: sha256(contentSchema) },
  ];
  if (configurationSchema !== undefined) schemas.push({
    kind: "record", scope: "portfolio-configuration", path: "schemas/portfolio-configuration.schema.json",
    schemaUri: RECORD_SCHEMA_URI.replace("manifest", "portfolio-configuration"), schemaVersion: "1.1", digest: sha256(configurationSchema),
  });
  const recordsForDependencies = [
    ...orderedContent.map((value) => ({ scope: "portfolio-content" as const, value })),
    ...configurationRecords.map((value) => ({ scope: "portfolio-configuration" as const, value })),
  ];
  const dependencies = expectedDependencies(recordsForDependencies, snapshot.includedScopes);
  const manifest = {
    packageFormat: "shipwithali-owner-export" as const, schemaVersion: "1.3" as const, exportId: input.exportId,
    snapshot: { snapshotId: snapshot.snapshotId, capturedAt: snapshot.capturedAt, consistency: "transactional" as const },
    createdAt: snapshot.capturedAt, algorithm: "sha-256" as const, digest: "0".repeat(64),
    requiredFeatures: ["asset-integrity-v1", "dependency-coverage-v1", "record-integrity-v1", "schema-integrity-v1", "snapshot-identity-v1"] as const,
    includedScopes: [...snapshot.includedScopes], publicEventDataCoverage: { mode: "excluded" as const }, dependencies,
    exclusions: ["raw-public-event-data", "functional-visitor-identities", "measurement-visitor-identities", "sessions", "credentials", "lab-entries"] as const,
    entries, schemas, assets: [],
    extensions: { contentSnapshot: { discoveryOrder: "first-published-at-desc-content-id-desc", privateLifecyclesIncluded: true } },
  } satisfies OwnerExportPackageManifestV1_3;
  const digest = sha256(utf8.encode(canonicalJson(manifest, true)));
  const completeManifest = { ...manifest, digest };
  const manifestBytes = utf8.encode(`${JSON.stringify(completeManifest)}\n`);
  const zipEntries: StoredOwnerExportZipEntry[] = [
    fixedBytesMember("manifest.json", manifestBytes), fixedBytesMember("schemas/manifest.schema.json", manifestSchema),
    fixedBytesMember("schemas/portfolio-content.schema.json", contentSchema),
  ];
  if (configurationSchema !== undefined) zipEntries.push(fixedBytesMember("schemas/portfolio-configuration.schema.json", configurationSchema));
  zipEntries.push(fixedBytesMember(contentEntry.path, contentBytes));
  if (hasConfiguration) zipEntries.push(fixedBytesMember("records/portfolio-configuration.ndjson", configurationBytes));
  const archive = createStoredOwnerExportZip(zipEntries);
  const integrity = await measureOwnerExportStream(archive.content);
  if (integrity.contentLength !== archive.contentLength) throw new RangeError("OWNER_EXPORT_ZIP_LENGTH_MISMATCH");
  return { contentLength: archive.contentLength, sha256: integrity.sha256, manifest: completeManifest, content: archive.content };
}
