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
  OwnerExportPackageManifestV1_7,
  OwnerExportAssetDescriptor,
  OwnerExportMediaEntryDescriptor,
  OwnerExportCvEntryDescriptor,
  OwnerExportModerationEntryDescriptor,
  OwnerExportAnalyticsEntryDescriptor,
  OwnerExportPackageManifestV1_8,
} from "./service.js";
import { isSafeOwnerExportCvMetadataV1_2, isSafeOwnerExportMediaMetadataV1_2, isSafeOwnerExportModerationMetadataV1_2 } from "./service.js";
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
  readonly includedScopes: readonly ("portfolio-content" | "taxonomy" | "media-metadata" | "cv-metadata" | "moderation-history" | "analytics-reports" | "portfolio-configuration")[];
  readonly policyExpiresAt?: string;
  readonly configuration?: OwnerExportConfigurationSnapshot;
  readonly content?: { readonly records: readonly { readonly contentId: string; readonly value: Readonly<Record<string, unknown>> }[] };
  readonly taxonomy?: { readonly records: readonly { readonly taxonomyId: string; readonly value: Readonly<Record<string, unknown>> }[] };
  readonly media?: OwnerExportMediaSnapshot;
  /** CV facts and exact Media bindings are private to the assembly checkpoint. */
  readonly cv?: OwnerCvExportSnapshot;
  /** Exact accepted PDF output objects required by retained CV versions. */
  readonly cvAssets?: readonly OwnerExportMediaAssetSnapshot[];
  /** Eligible Feedback values in memory for assembly; never persisted in a checkpoint. */
  readonly moderation?: { readonly records: readonly { readonly feedbackId: string; readonly value: Readonly<Record<string, unknown>> }[] };
  /** Durable comparison and invalidation facts contain no Feedback text or decision reasons. */
  readonly moderationCheckpoint?: {
    readonly recordsDigest: string;
    readonly dependencies: readonly { readonly feedbackId: string; readonly projectId: string }[];
  };
  /** Measurement-owned, privacy-projected goal history and aggregate reports. */
  readonly analytics?: { readonly records: readonly { readonly goalId: string; readonly value: Readonly<Record<string, unknown>> }[] };
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

function moderationCheckpoint(records: NonNullable<OwnerExportSelectedSnapshot["moderation"]>["records"]): NonNullable<OwnerExportSelectedSnapshot["moderationCheckpoint"]> {
  if (records.some(record => !isSafeOwnerExportModerationMetadataV1_2(record.value) || record.feedbackId !== record.value["feedbackId"])) {
    throw new TypeError("OWNER_EXPORT_MODERATION_CHECKPOINT_INVALID");
  }
  return {
    recordsDigest: sha256(canonicalJson(records)),
    dependencies: records.map(record => ({ feedbackId: record.feedbackId, projectId: String(record.value["projectId"]) })),
  };
}

/** Durable retries must not create an independent, unbounded Feedback text store. */
export function checkpointOwnerExportSnapshot(snapshot: OwnerExportAssemblySnapshot): OwnerExportAssemblySnapshot {
  if (!("kind" in snapshot) || snapshot.moderation === undefined) return snapshot;
  const { moderation, ...rest } = snapshot;
  return { ...rest, moderationCheckpoint: moderationCheckpoint(moderation.records) };
}

export function matchesOwnerExportModerationFacts(snapshot: OwnerExportSelectedSnapshot,
  records: NonNullable<OwnerExportSelectedSnapshot["moderation"]>["records"]): boolean {
  if (snapshot.moderationCheckpoint !== undefined) {
    return canonicalJson(snapshot.moderationCheckpoint) === canonicalJson(moderationCheckpoint(records));
  }
  return snapshot.moderation !== undefined && canonicalJson(snapshot.moderation.records) === canonicalJson(records);
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

function readPinnedModerationSchema(path: string): Uint8Array {
  return readFileSync(join(process.cwd(), "schemas", "owner-export", "v1.2", path));
}

function readPinnedTaxonomySchema(path: string): Uint8Array {
  return readFileSync(join(process.cwd(), "schemas", "owner-export", "v1.3", path));
}

function readPinnedAnalyticsSchema(path: string): Uint8Array {
  return readFileSync(join(process.cwd(), "schemas", "owner-export", "v1.7", path));
}

const PORTABLE_ANALYTICS_ACTIONS = new Set([
  "page-viewed", "project-viewed", "active-engagement-sampled", "media-engaged", "related-project-opened",
  "contact-channel-opened", "external-project-link-opened", "testimonial-engaged", "global-project-cta-opened",
]);
const STABLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_INSTANT_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/;
const UTC_DAY_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function onlyKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key));
}

function safeAnalyticsDefinition(value: unknown): boolean {
  if (!onlyKeys(value, ["name", "steps"]) || typeof value["name"] !== "string" || value["name"].length < 1 ||
      !Array.isArray(value["steps"]) || value["steps"].length < 1 || value["steps"].length > 10) return false;
  return value["steps"].every((step) => {
    if (!onlyKeys(step, ["action", "publicRouteIds", "projectIds"]) || typeof step["action"] !== "string" ||
        !PORTABLE_ANALYTICS_ACTIONS.has(step["action"])) return false;
    const validIds = (ids: unknown): boolean => Array.isArray(ids) && ids.every((id) => typeof id === "string" && STABLE_ID_PATTERN.test(id));
    return (step["publicRouteIds"] === undefined || validIds(step["publicRouteIds"])) &&
      (step["projectIds"] === undefined || validIds(step["projectIds"]));
  });
}

function validUtcDay(value: string): boolean {
  if (!UTC_DAY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function safeAnalyticsValueV1_2(value: unknown): boolean {
  if (!onlyKeys(value, ["goal", "reports"]) || !onlyKeys(value["goal"], ["goalId", "aggregateVersion", "activeVersionId", "versions", "activationHistory"])) return false;
  const goal = value["goal"];
  if (typeof goal["goalId"] !== "string" || !STABLE_ID_PATTERN.test(goal["goalId"]) ||
      !Number.isSafeInteger(goal["aggregateVersion"]) || Number(goal["aggregateVersion"]) < 1 ||
      !(goal["activeVersionId"] === null || (typeof goal["activeVersionId"] === "string" && STABLE_ID_PATTERN.test(goal["activeVersionId"]))) ||
      !Array.isArray(goal["versions"]) || goal["versions"].length === 0 || !Array.isArray(goal["activationHistory"]) ||
      !goal["versions"].every((version) => onlyKeys(version, ["versionId", "versionNumber", "definition", "createdAt"]) &&
        typeof version["versionId"] === "string" && STABLE_ID_PATTERN.test(version["versionId"]) &&
        Number.isSafeInteger(version["versionNumber"]) && Number(version["versionNumber"]) > 0 &&
        safeAnalyticsDefinition(version["definition"]) && typeof version["createdAt"] === "string" && UTC_INSTANT_PATTERN.test(version["createdAt"])) ||
      !goal["activationHistory"].every((activation) => onlyKeys(activation, ["versionId", "activatedAt", "activationSequence"]) &&
        typeof activation["versionId"] === "string" && STABLE_ID_PATTERN.test(activation["versionId"]) &&
        typeof activation["activatedAt"] === "string" && UTC_INSTANT_PATTERN.test(activation["activatedAt"]) &&
        Number.isSafeInteger(activation["activationSequence"]) && Number(activation["activationSequence"]) > 0) ||
      !Array.isArray(value["reports"])) return false;
  const versionIds = new Set<string>();
  let previousVersionNumber = 0;
  for (const version of goal["versions"]) {
    if (version["versionNumber"] <= previousVersionNumber || versionIds.has(String(version["versionId"]))) return false;
    versionIds.add(String(version["versionId"]));
    previousVersionNumber = Number(version["versionNumber"]);
  }
  if (goal["activeVersionId"] !== null && !versionIds.has(String(goal["activeVersionId"]))) return false;
  for (let index = 0; index < goal["activationHistory"].length; index += 1) {
    const activation = goal["activationHistory"][index];
    if (activation["activationSequence"] !== index + 1 || !versionIds.has(String(activation["versionId"]))) return false;
  }
  if (goal["activationHistory"].length > 0 && goal["activationHistory"].at(-1)?.["versionId"] !== goal["activeVersionId"]) return false;
  return value["reports"].every((report) => {
    if (!onlyKeys(report, ["goalVersionId", "periodStartDay", "periodEndDay", "sampleState", "completeness", "asOf", "policyVersion", "sourceHorizon", "grouping", "breakdown", "countDisposition", "cells"]) ||
        typeof report["goalVersionId"] !== "string" || !STABLE_ID_PATTERN.test(report["goalVersionId"]) || !versionIds.has(report["goalVersionId"]) ||
        typeof report["periodStartDay"] !== "string" || !validUtcDay(report["periodStartDay"]) ||
        typeof report["periodEndDay"] !== "string" || !validUtcDay(report["periodEndDay"]) ||
        Date.parse(`${report["periodEndDay"]}T00:00:00Z`) < Date.parse(`${report["periodStartDay"]}T00:00:00Z`) ||
        Math.floor((Date.parse(`${report["periodEndDay"]}T00:00:00Z`) - Date.parse(`${report["periodStartDay"]}T00:00:00Z`)) / 86_400_000) + 1 > 31 ||
        typeof report["asOf"] !== "string" || !UTC_INSTANT_PATTERN.test(report["asOf"]) ||
        report["grouping"] !== "daily-goal" || report["breakdown"] !== "locale" ||
        typeof report["policyVersion"] !== "string" || report["policyVersion"].length < 1 ||
        report["sourceHorizon"] !== "accepted-events-within-14-days-of-as-of") return false;
    if (report["cells"] !== undefined) {
      if (!Array.isArray(report["cells"]) || report["cells"].length < 1 || report["cells"].length >= 500) return false;
      const seenCells = new Set<string>();
      for (const cell of report["cells"]) {
        if (!onlyKeys(cell, ["utcDay", "locale", "aggregateCount"]) || typeof cell["utcDay"] !== "string" || !validUtcDay(cell["utcDay"]) ||
            cell["utcDay"] < report["periodStartDay"] || cell["utcDay"] > report["periodEndDay"] ||
            (cell["locale"] !== "en" && cell["locale"] !== "ar") || !Number.isSafeInteger(cell["aggregateCount"]) || Number(cell["aggregateCount"]) < 1) return false;
        const key = `${cell["utcDay"]}:${cell["locale"]}`;
        if (seenCells.has(key)) return false;
        seenCells.add(key);
      }
    }
    const available = report["sampleState"] === "sufficient" && report["completeness"] === "complete" && report["countDisposition"] === "included";
    const partiallyWithheld = report["sampleState"] === "low-sample" && report["completeness"] === "complete" && report["countDisposition"] === "partially-withheld";
    const noData = report["sampleState"] === "no-data" && report["completeness"] === "complete" && report["countDisposition"] === "not-applicable";
    const withheld = (report["sampleState"] === "low-sample" || report["sampleState"] === "incomplete") &&
      report["countDisposition"] === "withheld" && report["completeness"] === (report["sampleState"] === "incomplete" ? "incomplete" : "complete");
    if (available || partiallyWithheld) return Array.isArray(report["cells"]);
    return (noData || withheld) && report["cells"] === undefined;
  });
}

function analyticsDependencies(records: readonly { readonly goalId: string; readonly value: Readonly<Record<string, unknown>> }[]): OwnerExportDependencyDescriptor[] {
  const unique = new Map<string, OwnerExportDependencyDescriptor>();
  for (const record of records) {
    const goal = record.value["goal"];
    if (goal === null || typeof goal !== "object") continue;
    const versions = (goal as Record<string, unknown>)["versions"];
    if (!Array.isArray(versions)) continue;
    for (const version of versions) {
      if (version === null || typeof version !== "object") continue;
      const definition = (version as Record<string, unknown>)["definition"];
      if (definition === null || typeof definition !== "object") continue;
      const steps = (definition as Record<string, unknown>)["steps"];
      if (!Array.isArray(steps)) continue;
      for (const step of steps) {
        if (step === null || typeof step !== "object") continue;
        const row = step as Record<string, unknown>;
        for (const [field, targetIds] of [["projectIds", row["projectIds"]], ["publicRouteIds", row["publicRouteIds"]]] as const) {
          if (!Array.isArray(targetIds)) continue;
          for (const targetId of targetIds) {
            if (typeof targetId !== "string") continue;
            const dependency = { sourceScope: "analytics-reports" as const, sourceId: record.goalId,
              targetScope: "portfolio-content" as const, targetId, disposition: "omitted" as const, reason: "scope-not-selected" as const };
            unique.set([dependency.sourceScope, dependency.sourceId, dependency.targetScope, dependency.targetId].join("|"), dependency);
          }
        }
      }
    }
  }
  return [...unique.values()].sort((left, right) => compareCodePoints(left.sourceId, right.sourceId) || compareCodePoints(left.targetId, right.targetId));
}

/** Emits the Measurement-owned Analytics view with explicit withheld-count semantics. */
export async function buildAnalyticsOwnerExportPackage(input: {
  readonly exportId: StableId<"OwnerExport">;
  readonly snapshot: OwnerExportSelectedSnapshot;
}): Promise<BuiltOwnerExportPackage> {
  const { snapshot } = input;
  if (snapshot.kind !== "owner-export-snapshot-v1" || snapshot.includedScopes.length !== 1 ||
      snapshot.includedScopes[0] !== "analytics-reports" || snapshot.analytics === undefined || snapshot.policyExpiresAt === undefined ||
      !UTC_INSTANT_PATTERN.test(snapshot.policyExpiresAt)) {
    throw new TypeError("OWNER_EXPORT_ANALYTICS_SNAPSHOT_INVALID");
  }
  const ordered = [...snapshot.analytics.records].sort((left, right) => compareCodePoints(left.goalId, right.goalId));
  if (ordered.some((record, index) => !STABLE_ID_PATTERN.test(record.goalId) || !safeAnalyticsValueV1_2(record.value) ||
      (index > 0 && ordered[index - 1]!.goalId === record.goalId) ||
      (record.value["goal"] as Record<string, unknown>)["goalId"] !== record.goalId)) {
    throw new TypeError("OWNER_EXPORT_ANALYTICS_RECORD_INVALID");
  }
  const analyticsSchema = readPinnedAnalyticsSchema("analytics-reports.schema.json");
  const manifestSchema = readPinnedAnalyticsSchema("manifest.schema.json");
  const recordBytes = ordered.length === 0 ? new Uint8Array() : utf8.encode(
    `${ordered.map((record) => canonicalJson({ scope: "analytics-reports", value: record.value })).join("\n")}\n`,
  );
  const entry: OwnerExportAnalyticsEntryDescriptor = {
    path: "records/analytics-reports.ndjson", scope: "analytics-reports", mediaType: "application/x-ndjson",
    recordSchema: "urn:shipwithali:owner-export-schema:analytics-reports:1.2", schemaPath: "schemas/analytics-reports.schema.json",
    schemaVersion: "1.2", digest: sha256(recordBytes), recordCount: ordered.length,
  };
  const schemas: OwnerExportSchemaDescriptor[] = [
    { kind: "manifest", path: "schemas/manifest.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:manifest:1.7", schemaVersion: "1.7", digest: sha256(manifestSchema) },
    { kind: "record", scope: "analytics-reports", path: "schemas/analytics-reports.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:analytics-reports:1.2", schemaVersion: "1.2", digest: sha256(analyticsSchema) },
  ];
  const manifest = {
    packageFormat: "shipwithali-owner-export" as const, schemaVersion: "1.8" as const, entries: [entry], exportId: input.exportId,
    snapshot: { snapshotId: snapshot.snapshotId, capturedAt: snapshot.capturedAt, consistency: "transactional" as const },
    createdAt: snapshot.capturedAt, algorithm: "sha-256" as const, digest: "0".repeat(64),
    requiredFeatures: ["asset-integrity-v1", "dependency-coverage-v1", "record-integrity-v1", "schema-integrity-v1", "snapshot-identity-v1"] as const,
    includedScopes: ["analytics-reports"] as const, publicEventDataCoverage: { mode: "excluded" as const },
    dependencies: analyticsDependencies(ordered),
    exclusions: ["raw-public-event-data", "functional-visitor-identities", "measurement-visitor-identities", "sessions", "credentials", "lab-entries"] as const,
    schemas, assets: [],
    extensions: { analyticsReportPolicy: { maximumPeriodDays: 31, maximumRowsPerQuery: 500, minimumObservedSubjects: 5,
      grouping: "daily-goal", breakdown: "locale", totalRows: "omitted", withheldCounts: "omitted",
      aggregateRetentionExpiresAt: snapshot.policyExpiresAt } },
  } satisfies OwnerExportPackageManifestV1_8;
  const completeManifest = { ...manifest, digest: sha256(utf8.encode(canonicalJson(manifest, true))) };
  const manifestBytes = utf8.encode(`${JSON.stringify(completeManifest)}\n`);
  const archive = createStoredOwnerExportZip([
    fixedBytesMember("manifest.json", manifestBytes), fixedBytesMember("schemas/manifest.schema.json", manifestSchema),
    fixedBytesMember("schemas/analytics-reports.schema.json", analyticsSchema), fixedBytesMember(entry.path, recordBytes),
  ]);
  const integrity = await measureOwnerExportStream(archive.content);
  if (integrity.contentLength !== archive.contentLength) throw new RangeError("OWNER_EXPORT_ZIP_LENGTH_MISMATCH");
  return { contentLength: archive.contentLength, sha256: integrity.sha256, manifest: completeManifest, content: archive.content };
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
  values: readonly { readonly scope: "portfolio-content" | "taxonomy" | "portfolio-configuration" | "moderation-history"; readonly value: Readonly<Record<string, unknown>> }[],
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
  const rows = new Map<string, { sourceScope: "portfolio-content" | "taxonomy" | "portfolio-configuration" | "moderation-history"; sourceId: string; targetScope: OwnerExportDependencyDescriptor["targetScope"]; targetId: string }>();
  const add = (sourceScope: "portfolio-content" | "taxonomy" | "portfolio-configuration" | "moderation-history", sourceId: string, targetScope: OwnerExportDependencyDescriptor["targetScope"], targetId: string) => {
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
    } else if (record.scope === "moderation-history") {
      add(record.scope, String(value["feedbackId"]), "portfolio-content", String(value["projectId"]));
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
  if (cv.versionsTruncated || cv.acceptanceHistoryTruncated || cv.activationHistoryTruncated ||
      cv.versions.length > 100 || cv.acceptanceHistory.length > 100 || cv.activationHistory.length > 100) {
    throw new TypeError("OWNER_EXPORT_CV_HISTORY_LIMIT_EXCEEDED");
  }
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
    entries, schemas, assets: descriptors, extensions: { cvSnapshot: { versionHistory: "complete-up-to-100-or-fail", acceptanceHistory: "complete-up-to-100-or-fail", activationHistory: "complete-up-to-100-or-fail", byteReferences: "sha256-content-addressed" } },
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
  const hasModeration = snapshot.includedScopes.includes("moderation-history");
  const hasConfiguration = snapshot.includedScopes.includes("portfolio-configuration");
  const canonicalScopes = ["portfolio-content", "taxonomy", "moderation-history", "portfolio-configuration"]
    .filter((scope) => snapshot.includedScopes.includes(scope as OwnerExportSelectedSnapshot["includedScopes"][number]));
  if (canonicalScopes.length !== snapshot.includedScopes.length ||
      canonicalScopes.some((scope, index) => snapshot.includedScopes[index] !== scope) ||
      !snapshot.includedScopes.includes("taxonomy") || hasContent !== (snapshot.content !== undefined) ||
      hasConfiguration !== (snapshot.configuration !== undefined) || hasModeration !== (snapshot.moderation !== undefined) || snapshot.taxonomy === undefined) {
    throw new TypeError("OWNER_EXPORT_TAXONOMY_SNAPSHOT_INVALID");
  }
  const manifestSchema = hasModeration
    ? readFileSync(join(process.cwd(), "schemas", "owner-export", "v1.6", "manifest.schema.json"))
    : readPinnedTaxonomySchema("manifest.schema.json");
  const taxonomySchema = readPinnedTaxonomySchema("taxonomy.schema.json");
  const contentSchema = hasContent ? readPinnedContentSchema("portfolio-content.schema.json") : undefined;
  const configurationSchema = hasConfiguration ? readPinnedSchema("portfolio-configuration.schema.json") : undefined;
  const moderationSchema = hasModeration ? readPinnedModerationSchema("moderation-history.schema.json") : undefined;
  const contentValues = snapshot.content?.records.map((record) => record.value) ?? [];
  const taxonomyValues = snapshot.taxonomy.records.map((record) => record.value);
  const moderationValues = snapshot.moderation?.records.map((record) => record.value) ?? [];
  if (contentValues.some((value) => typeof value["contentId"] !== "string") ||
      taxonomyValues.some((value) => typeof value["taxonomyId"] !== "string") ||
      moderationValues.some((value) => value["feedbackId"] === undefined || !isSafeOwnerExportModerationMetadataV1_2(value))) throw new TypeError("OWNER_EXPORT_TAXONOMY_RECORD_INVALID");
  const orderedContent = [...contentValues].sort((left, right) => compareCodePoints(String(left["contentId"]), String(right["contentId"])));
  const orderedTaxonomy = [...taxonomyValues].sort((left, right) => compareCodePoints(String(left["taxonomyId"]), String(right["taxonomyId"])));
  const orderedModeration = [...moderationValues].sort((left, right) => compareCodePoints(String(left["feedbackId"]), String(right["feedbackId"])));
  if (orderedModeration.some((value, index) => index > 0 && orderedModeration[index - 1]!["feedbackId"] === value["feedbackId"])) throw new TypeError("OWNER_EXPORT_MODERATION_RECORD_DUPLICATE");
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
  const moderationBytes = orderedModeration.length === 0 ? new Uint8Array() : utf8.encode(
    `${orderedModeration.map((value) => canonicalJson({ scope: "moderation-history", value })).join("\n")}\n`,
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
  const entries: (OwnerExportContentEntryDescriptor | OwnerExportTaxonomyEntryDescriptor | OwnerExportModerationEntryDescriptor | OwnerExportEntryDescriptor)[] = [];
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
  if (hasModeration) entries.push({
    path: "records/moderation-history.ndjson", scope: "moderation-history", mediaType: "application/x-ndjson",
    recordSchema: "urn:shipwithali:owner-export-schema:moderation-history:1.2", schemaPath: "schemas/moderation-history.schema.json",
    schemaVersion: "1.2", digest: sha256(moderationBytes), recordCount: orderedModeration.length,
  });
  if (hasConfiguration) entries.push({
    path: "records/portfolio-configuration.ndjson", scope: "portfolio-configuration", mediaType: "application/x-ndjson",
    recordSchema: "urn:shipwithali:owner-export-schema:portfolio-configuration:1.1", schemaPath: "schemas/portfolio-configuration.schema.json",
    schemaVersion: "1.1", digest: sha256(configurationBytes), recordCount: configurationValues.length,
  });
  const schemas: OwnerExportSchemaDescriptor[] = [
    { kind: "manifest", path: "schemas/manifest.schema.json", schemaUri: `urn:shipwithali:owner-export-schema:manifest:${hasModeration ? "1.6" : "1.3"}`, schemaVersion: hasModeration ? "1.6" : "1.3", digest: sha256(manifestSchema) },
  ];
  if (hasContent) schemas.push({
    kind: "record", scope: "portfolio-content", path: "schemas/portfolio-content.schema.json",
    schemaUri: "urn:shipwithali:owner-export-schema:portfolio-content:1.2", schemaVersion: "1.2", digest: sha256(contentSchema!),
  });
  schemas.push({ kind: "record", scope: "taxonomy", path: "schemas/taxonomy.schema.json",
    schemaUri: "urn:shipwithali:owner-export-schema:taxonomy:1.2", schemaVersion: "1.2", digest: sha256(taxonomySchema) });
  if (hasModeration) schemas.push({ kind: "record", scope: "moderation-history", path: "schemas/moderation-history.schema.json",
    schemaUri: "urn:shipwithali:owner-export-schema:moderation-history:1.2", schemaVersion: "1.2", digest: sha256(moderationSchema!) });
  if (hasConfiguration) schemas.push({ kind: "record", scope: "portfolio-configuration", path: "schemas/portfolio-configuration.schema.json",
    schemaUri: "urn:shipwithali:owner-export-schema:portfolio-configuration:1.1", schemaVersion: "1.1", digest: sha256(configurationSchema!) });
  const recordsForDependencies = [
    ...orderedContent.map((value) => ({ scope: "portfolio-content" as const, value })),
    ...orderedTaxonomy.map((value) => ({ scope: "taxonomy" as const, value })),
    ...orderedModeration.map((value) => ({ scope: "moderation-history" as const, value })),
    ...configurationValues.map((value) => ({ scope: "portfolio-configuration" as const, value: value as Readonly<Record<string, unknown>> })),
  ];
  const dependencies = expectedDependencies(recordsForDependencies, snapshot.includedScopes);
  const manifest = {
    packageFormat: "shipwithali-owner-export" as const, ...(hasModeration ? { schemaVersion: "1.7" as const, entries } : {
      schemaVersion: "1.4" as const,
      entries: entries.filter((entry): entry is Exclude<typeof entry, OwnerExportModerationEntryDescriptor> => entry.scope !== "moderation-history"),
    }), exportId: input.exportId,
    snapshot: { snapshotId: snapshot.snapshotId, capturedAt: snapshot.capturedAt, consistency: "transactional" as const },
    createdAt: snapshot.capturedAt, algorithm: "sha-256" as const, digest: "0".repeat(64),
    requiredFeatures: ["asset-integrity-v1", "dependency-coverage-v1", "record-integrity-v1", "schema-integrity-v1", "snapshot-identity-v1"] as const,
    includedScopes: [...snapshot.includedScopes], publicEventDataCoverage: { mode: "excluded" as const }, dependencies,
    exclusions: ["raw-public-event-data", "functional-visitor-identities", "measurement-visitor-identities", "sessions", "credentials", "lab-entries"] as const,
    schemas, assets: [], extensions: { taxonomySnapshot: { identity: "stable", evolutionHistory: "complete", assignmentHistory: "complete" } },
  } satisfies OwnerExportPackageManifestV1_4 | OwnerExportPackageManifestV1_7;
  const digest = sha256(utf8.encode(canonicalJson(manifest, true)));
  const completeManifest = { ...manifest, digest };
  const manifestBytes = utf8.encode(`${JSON.stringify(completeManifest)}\n`);
  const zipEntries: StoredOwnerExportZipEntry[] = [
    fixedBytesMember("manifest.json", manifestBytes), fixedBytesMember("schemas/manifest.schema.json", manifestSchema),
  ];
  if (hasContent) zipEntries.push(fixedBytesMember("schemas/portfolio-content.schema.json", contentSchema!));
  zipEntries.push(fixedBytesMember("schemas/taxonomy.schema.json", taxonomySchema));
  if (hasModeration) zipEntries.push(fixedBytesMember("schemas/moderation-history.schema.json", moderationSchema!));
  if (hasConfiguration) zipEntries.push(fixedBytesMember("schemas/portfolio-configuration.schema.json", configurationSchema!));
  if (hasContent) zipEntries.push(fixedBytesMember("records/portfolio-content.ndjson", contentBytes));
  zipEntries.push(fixedBytesMember("records/taxonomy.ndjson", taxonomyBytes));
  if (hasModeration) zipEntries.push(fixedBytesMember("records/moderation-history.ndjson", moderationBytes));
  if (hasConfiguration) zipEntries.push(fixedBytesMember("records/portfolio-configuration.ndjson", configurationBytes));
  const archive = createStoredOwnerExportZip(zipEntries);
  const integrity = await measureOwnerExportStream(archive.content);
  if (integrity.contentLength !== archive.contentLength) throw new RangeError("OWNER_EXPORT_ZIP_LENGTH_MISMATCH");
  return { contentLength: archive.contentLength, sha256: integrity.sha256, manifest: completeManifest, content: archive.content };
}

async function buildModerationOnlyOwnerExportPackage(input: {
  readonly exportId: StableId<"OwnerExport">;
  readonly snapshot: OwnerExportSelectedSnapshot;
}): Promise<BuiltOwnerExportPackage> {
  const { snapshot } = input;
  const hasConfiguration = snapshot.includedScopes.includes("portfolio-configuration");
  const canonicalScopes = ["moderation-history", "portfolio-configuration"].filter((scope) =>
    snapshot.includedScopes.includes(scope as OwnerExportSelectedSnapshot["includedScopes"][number]));
  if (snapshot.includedScopes.length !== canonicalScopes.length ||
      canonicalScopes.some((scope, index) => snapshot.includedScopes[index] !== scope) ||
      !snapshot.includedScopes.includes("moderation-history") || snapshot.moderation === undefined ||
      hasConfiguration !== (snapshot.configuration !== undefined)) throw new TypeError("OWNER_EXPORT_MODERATION_SNAPSHOT_INVALID");
  const manifestSchema = readFileSync(join(process.cwd(), "schemas", "owner-export", "v1.6", "manifest.schema.json"));
  const moderationSchema = readPinnedModerationSchema("moderation-history.schema.json");
  const configurationSchema = hasConfiguration ? readPinnedSchema("portfolio-configuration.schema.json") : undefined;
  const values = snapshot.moderation.records.map((record) => record.value);
  if (values.some((value) => !isSafeOwnerExportModerationMetadataV1_2(value))) throw new TypeError("OWNER_EXPORT_MODERATION_RECORD_INVALID");
  const ordered = [...values].sort((left, right) => compareCodePoints(String(left["feedbackId"]), String(right["feedbackId"])));
  if (ordered.some((value, index) => index > 0 && ordered[index - 1]!["feedbackId"] === value["feedbackId"])) throw new TypeError("OWNER_EXPORT_MODERATION_RECORD_DUPLICATE");
  const moderationBytes = ordered.length === 0 ? new Uint8Array() : utf8.encode(
    `${ordered.map((value) => canonicalJson({ scope: "moderation-history", value })).join("\n")}\n`,
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
  const moderationEntry: OwnerExportModerationEntryDescriptor = {
    path: "records/moderation-history.ndjson", scope: "moderation-history", mediaType: "application/x-ndjson",
    recordSchema: "urn:shipwithali:owner-export-schema:moderation-history:1.2", schemaPath: "schemas/moderation-history.schema.json",
    schemaVersion: "1.2", digest: sha256(moderationBytes), recordCount: ordered.length,
  };
  const entries: (OwnerExportModerationEntryDescriptor | OwnerExportEntryDescriptor)[] = [moderationEntry];
  if (hasConfiguration) entries.push({
    path: "records/portfolio-configuration.ndjson", scope: "portfolio-configuration", mediaType: "application/x-ndjson",
    recordSchema: RECORD_SCHEMA_URI, schemaPath: "schemas/portfolio-configuration.schema.json", schemaVersion: "1.1",
    digest: sha256(configurationBytes), recordCount: configurationValues.length,
  });
  const schemas: OwnerExportSchemaDescriptor[] = [
    { kind: "manifest", path: "schemas/manifest.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:manifest:1.6", schemaVersion: "1.6", digest: sha256(manifestSchema) },
    { kind: "record", scope: "moderation-history", path: "schemas/moderation-history.schema.json",
      schemaUri: "urn:shipwithali:owner-export-schema:moderation-history:1.2", schemaVersion: "1.2", digest: sha256(moderationSchema) },
  ];
  if (hasConfiguration) schemas.push({ kind: "record", scope: "portfolio-configuration", path: "schemas/portfolio-configuration.schema.json",
    schemaUri: RECORD_SCHEMA_URI, schemaVersion: "1.1", digest: sha256(configurationSchema!) });
  const dependencyRecords = [
    ...ordered.map((value) => ({ scope: "moderation-history" as const, value })),
    ...configurationValues.map((value) => ({ scope: "portfolio-configuration" as const, value: value as Readonly<Record<string, unknown>> })),
  ];
  const manifest = {
    packageFormat: "shipwithali-owner-export" as const, schemaVersion: "1.7" as const, exportId: input.exportId,
    snapshot: { snapshotId: snapshot.snapshotId, capturedAt: snapshot.capturedAt, consistency: "transactional" as const },
    createdAt: snapshot.capturedAt, algorithm: "sha-256" as const, digest: "0".repeat(64),
    requiredFeatures: ["asset-integrity-v1", "dependency-coverage-v1", "record-integrity-v1", "schema-integrity-v1", "snapshot-identity-v1"] as const,
    includedScopes: [...snapshot.includedScopes], publicEventDataCoverage: { mode: "excluded" as const },
    dependencies: expectedDependencies(dependencyRecords, snapshot.includedScopes),
    exclusions: ["raw-public-event-data", "functional-visitor-identities", "measurement-visitor-identities", "sessions", "credentials", "lab-entries"] as const,
    entries, schemas, assets: [], extensions: { moderationSnapshot: { retentionPolicy: "feedback-retention-v1", auditMode: "minimal-truthful" } },
  } satisfies OwnerExportPackageManifestV1_7;
  const completeManifest = { ...manifest, digest: sha256(utf8.encode(canonicalJson(manifest, true))) };
  const manifestBytes = utf8.encode(`${JSON.stringify(completeManifest)}\n`);
  const zipEntries: StoredOwnerExportZipEntry[] = [fixedBytesMember("manifest.json", manifestBytes),
    fixedBytesMember("schemas/manifest.schema.json", manifestSchema), fixedBytesMember("schemas/moderation-history.schema.json", moderationSchema)];
  if (hasConfiguration) zipEntries.push(fixedBytesMember("schemas/portfolio-configuration.schema.json", configurationSchema!));
  zipEntries.push(fixedBytesMember(moderationEntry.path, moderationBytes));
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
  if (snapshot.includedScopes.includes("analytics-reports")) {
    if (snapshot.includedScopes.length !== 1) throw new TypeError("OWNER_EXPORT_SCOPE_UNSUPPORTED");
    return buildAnalyticsOwnerExportPackage(input);
  }
  if (snapshot.includedScopes.includes("taxonomy")) return buildTaxonomyOwnerExportPackage(input);
  const hasContent = snapshot.includedScopes.includes("portfolio-content");
  const hasModeration = snapshot.includedScopes.includes("moderation-history");
  if (!hasContent && hasModeration) return buildModerationOnlyOwnerExportPackage(input);
  if (!hasContent || snapshot.content === undefined) throw new TypeError("OWNER_EXPORT_CONTENT_SNAPSHOT_INVALID");
  const hasConfiguration = snapshot.includedScopes.includes("portfolio-configuration");
  if (hasConfiguration !== (snapshot.configuration !== undefined) || hasModeration !== (snapshot.moderation !== undefined)) throw new TypeError("OWNER_EXPORT_SCOPE_SNAPSHOT_INCOMPLETE");
  const canonicalScopes = ["portfolio-content", "moderation-history", "portfolio-configuration"].filter((scope) =>
    snapshot.includedScopes.includes(scope as OwnerExportSelectedSnapshot["includedScopes"][number]));
  if (canonicalScopes.length !== snapshot.includedScopes.length || canonicalScopes.some((scope, index) => snapshot.includedScopes[index] !== scope)) {
    throw new TypeError("OWNER_EXPORT_SCOPE_UNSUPPORTED");
  }
  const manifestSchema = hasModeration
    ? readFileSync(join(process.cwd(), "schemas", "owner-export", "v1.6", "manifest.schema.json"))
    : readPinnedContentSchema("manifest.schema.json");
  const contentSchema = readPinnedContentSchema("portfolio-content.schema.json");
  const configurationSchema = hasConfiguration ? readPinnedSchema("portfolio-configuration.schema.json") : undefined;
  const moderationSchema = hasModeration ? readPinnedModerationSchema("moderation-history.schema.json") : undefined;
  const contentValues = snapshot.content.records.map((record) => record.value);
  const moderationValues = snapshot.moderation?.records.map((record) => record.value) ?? [];
  if (moderationValues.some((value) => value["feedbackId"] === undefined || !isSafeOwnerExportModerationMetadataV1_2(value))) {
    throw new TypeError("OWNER_EXPORT_MODERATION_RECORD_INVALID");
  }
  if (contentValues.some((value) => value["contentId"] === undefined)) throw new TypeError("OWNER_EXPORT_CONTENT_RECORD_INVALID");
  const orderedContent = [...contentValues].sort((left, right) => compareCodePoints(String(left["contentId"]), String(right["contentId"])));
  const orderedModeration = [...moderationValues].sort((left, right) => compareCodePoints(String(left["feedbackId"]), String(right["feedbackId"])));
  if (orderedModeration.some((value, index) => index > 0 && orderedModeration[index - 1]!["feedbackId"] === value["feedbackId"])) throw new TypeError("OWNER_EXPORT_MODERATION_RECORD_DUPLICATE");
  const contentBytes = orderedContent.length === 0 ? new Uint8Array() : utf8.encode(
    `${orderedContent.map((value) => canonicalJson({ scope: "portfolio-content", value })).join("\n")}\n`,
  );
  const moderationBytes = orderedModeration.length === 0 ? new Uint8Array() : utf8.encode(
    `${orderedModeration.map((value) => canonicalJson({ scope: "moderation-history", value })).join("\n")}\n`,
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
  const entries: (OwnerExportContentEntryDescriptor | OwnerExportModerationEntryDescriptor | OwnerExportEntryDescriptor)[] = [contentEntry];
  if (hasModeration) entries.push({
    path: "records/moderation-history.ndjson", scope: "moderation-history", mediaType: "application/x-ndjson",
    recordSchema: "urn:shipwithali:owner-export-schema:moderation-history:1.2", schemaPath: "schemas/moderation-history.schema.json",
    schemaVersion: "1.2", digest: sha256(moderationBytes), recordCount: orderedModeration.length,
  });
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
    { kind: "manifest", path: "schemas/manifest.schema.json", schemaUri: `urn:shipwithali:owner-export-schema:manifest:${hasModeration ? "1.6" : "1.2"}`, schemaVersion: hasModeration ? "1.6" : "1.2", digest: sha256(manifestSchema) },
    { kind: "record", scope: "portfolio-content", path: "schemas/portfolio-content.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:portfolio-content:1.2", schemaVersion: "1.2", digest: sha256(contentSchema) },
  ];
  if (hasModeration) schemas.push({ kind: "record", scope: "moderation-history", path: "schemas/moderation-history.schema.json",
    schemaUri: "urn:shipwithali:owner-export-schema:moderation-history:1.2", schemaVersion: "1.2", digest: sha256(moderationSchema!) });
  if (configurationSchema !== undefined) schemas.push({
    kind: "record", scope: "portfolio-configuration", path: "schemas/portfolio-configuration.schema.json",
    schemaUri: RECORD_SCHEMA_URI.replace("manifest", "portfolio-configuration"), schemaVersion: "1.1", digest: sha256(configurationSchema),
  });
  const recordsForDependencies = [
    ...orderedContent.map((value) => ({ scope: "portfolio-content" as const, value })),
    ...orderedModeration.map((value) => ({ scope: "moderation-history" as const, value })),
    ...configurationRecords.map((value) => ({ scope: "portfolio-configuration" as const, value })),
  ];
  const dependencies = expectedDependencies(recordsForDependencies, snapshot.includedScopes);
  const manifest = {
    packageFormat: "shipwithali-owner-export" as const, ...(hasModeration ? { schemaVersion: "1.7" as const, entries } : {
      schemaVersion: "1.3" as const,
      entries: entries.filter((entry): entry is Exclude<typeof entry, OwnerExportModerationEntryDescriptor> => entry.scope !== "moderation-history"),
    }), exportId: input.exportId,
    snapshot: { snapshotId: snapshot.snapshotId, capturedAt: snapshot.capturedAt, consistency: "transactional" as const },
    createdAt: snapshot.capturedAt, algorithm: "sha-256" as const, digest: "0".repeat(64),
    requiredFeatures: ["asset-integrity-v1", "dependency-coverage-v1", "record-integrity-v1", "schema-integrity-v1", "snapshot-identity-v1"] as const,
    includedScopes: [...snapshot.includedScopes], publicEventDataCoverage: { mode: "excluded" as const }, dependencies,
    exclusions: ["raw-public-event-data", "functional-visitor-identities", "measurement-visitor-identities", "sessions", "credentials", "lab-entries"] as const,
    schemas, assets: [],
    extensions: { contentSnapshot: { discoveryOrder: "first-published-at-desc-content-id-desc", privateLifecyclesIncluded: true } },
  } satisfies OwnerExportPackageManifestV1_3 | OwnerExportPackageManifestV1_7;
  const digest = sha256(utf8.encode(canonicalJson(manifest, true)));
  const completeManifest = { ...manifest, digest };
  const manifestBytes = utf8.encode(`${JSON.stringify(completeManifest)}\n`);
  const zipEntries: StoredOwnerExportZipEntry[] = [
    fixedBytesMember("manifest.json", manifestBytes), fixedBytesMember("schemas/manifest.schema.json", manifestSchema),
    fixedBytesMember("schemas/portfolio-content.schema.json", contentSchema),
  ];
  if (hasModeration) zipEntries.push(fixedBytesMember("schemas/moderation-history.schema.json", moderationSchema!));
  if (configurationSchema !== undefined) zipEntries.push(fixedBytesMember("schemas/portfolio-configuration.schema.json", configurationSchema));
  zipEntries.push(fixedBytesMember(contentEntry.path, contentBytes));
  if (hasModeration) zipEntries.push(fixedBytesMember("records/moderation-history.ndjson", moderationBytes));
  if (hasConfiguration) zipEntries.push(fixedBytesMember("records/portfolio-configuration.ndjson", configurationBytes));
  const archive = createStoredOwnerExportZip(zipEntries);
  const integrity = await measureOwnerExportStream(archive.content);
  if (integrity.contentLength !== archive.contentLength) throw new RangeError("OWNER_EXPORT_ZIP_LENGTH_MISMATCH");
  return { contentLength: archive.contentLength, sha256: integrity.sha256, manifest: completeManifest, content: archive.content };
}
