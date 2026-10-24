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
  OwnerExportDependencyDescriptor,
  OwnerExportPackageManifest,
  OwnerExportSchemaDescriptor,
} from "./service.js";
import { MAX_OWNER_EXPORT_ARTIFACT_BYTES } from "./service.js";

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
  readonly includedScopes: readonly ("portfolio-content" | "portfolio-configuration")[];
  readonly configuration?: OwnerExportConfigurationSnapshot;
  readonly content?: { readonly records: readonly { readonly contentId: string; readonly value: Readonly<Record<string, unknown>> }[] };
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
        for await (const chunk of entry.content()) {
          memberLength += chunk.byteLength;
          if (memberLength > entry.contentLength) throw new RangeError("OWNER_EXPORT_ZIP_MEMBER_LENGTH_MISMATCH");
          memberCrc = updateCrc32(memberCrc, chunk);
          yield chunk;
        }
        if (memberLength !== entry.contentLength || ((memberCrc ^ 0xffffffff) >>> 0) !== (entry.crc32 >>> 0)) {
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
  values: readonly { readonly scope: "portfolio-content" | "portfolio-configuration"; readonly value: Readonly<Record<string, unknown>> }[],
  includedScopes: readonly string[],
): OwnerExportPackageManifestV1_3["dependencies"] {
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
  const rows = new Map<string, { sourceScope: "portfolio-content" | "portfolio-configuration"; sourceId: string; targetScope: OwnerExportDependencyDescriptor["targetScope"]; targetId: string }>();
  const add = (sourceScope: "portfolio-content" | "portfolio-configuration", sourceId: string, targetScope: OwnerExportDependencyDescriptor["targetScope"], targetId: string) => {
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

/** Builds the content package v1.3 without changing the meaning of any v1.1 record. */
export async function buildSelectedOwnerExportPackage(input: {
  readonly exportId: StableId<"OwnerExport">;
  readonly snapshot: OwnerExportSelectedSnapshot;
}): Promise<BuiltOwnerExportPackage> {
  const { snapshot } = input;
  if (snapshot.kind !== "owner-export-snapshot-v1" || !snapshot.includedScopes.includes("portfolio-content") || snapshot.content === undefined) {
    throw new TypeError("OWNER_EXPORT_CONTENT_SNAPSHOT_INVALID");
  }
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
