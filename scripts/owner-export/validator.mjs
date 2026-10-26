import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import Ajv2020 from "ajv/dist/2020.js";

function compareUnicodeCodePoints(left, right) {
  const leftCodePoints = Array.from(left, (character) => character.codePointAt(0));
  const rightCodePoints = Array.from(right, (character) => character.codePointAt(0));
  const length = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftCodePoints[index] !== rightCodePoints[index]) {
      return leftCodePoints[index] - rightCodePoints[index];
    }
  }
  return leftCodePoints.length - rightCodePoints.length;
}

function canonicalJson(value, omitDigest = false, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError("Owner export manifests may contain only finite safe integer numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("Owner export manifest is not a JSON value");
  }
  if (ancestors.has(value)) throw new TypeError("Owner export manifest contains a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, false, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Owner export manifest contains a non-plain object");
    }
    const keys = Object.keys(value)
      .filter((key) => !(omitDigest && key === "digest"))
      .sort(compareUnicodeCodePoints);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], false, ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Canonical UTF-8 JSON text for the package digest; only the root digest is omitted. */
export function canonicalizeOwnerExportManifest(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new TypeError("Owner export manifest must be an object");
  }
  return canonicalJson(manifest, true);
}

export function ownerExportManifestDigest(manifest) {
  return createHash("sha256").update(canonicalizeOwnerExportManifest(manifest), "utf8").digest("hex");
}

export class OwnerExportValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "OwnerExportValidationError";
    this.code = code;
  }
}

const LIMITS = Object.freeze({
  archiveBytes: 64 * 1024 * 1024,
  entryCount: 512,
  entryBytes: 50 * 1024 * 1024,
  legacyEntryBytes: 32 * 1024 * 1024,
  totalExpandedBytes: 128 * 1024 * 1024,
  assetBytes: 50 * 1024 * 1024,
  manifestBytes: 1_000_000,
  schemaBytes: 1_000_000,
  compressionRatio: 100,
  jsonDepth: 64,
  jsonNodes: 500_000,
  recordsPerScope: 100_000,
});

export const MAX_OWNER_EXPORT_ARCHIVE_BYTES = LIMITS.archiveBytes;

const SCOPES = Object.freeze([
  "portfolio-content",
  "taxonomy",
  "media-metadata",
  "cv-metadata",
  "moderation-history",
  "analytics-reports",
  "portfolio-configuration",
]);
const REQUIRED_FEATURES = Object.freeze([
  "asset-integrity-v1",
  "dependency-coverage-v1",
  "record-integrity-v1",
  "schema-integrity-v1",
  "snapshot-identity-v1",
]);
const REQUIRED_EXCLUSIONS = Object.freeze([
  "raw-public-event-data",
  "functional-visitor-identities",
  "measurement-visitor-identities",
  "sessions",
  "credentials",
  "lab-entries",
]);
const SCOPE_SET = new Set(SCOPES);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const STABLE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

function fail(code) {
  throw new OwnerExportValidationError(code);
}

function crc32(bytes) {
  let checksum = 0xffffffff;
  for (const byte of bytes) checksum = CRC32_TABLE[(checksum ^ byte) & 0xff] ^ (checksum >>> 8);
  return (checksum ^ 0xffffffff) >>> 0;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function zipPath(name, nameBytes) {
  if (
    nameBytes.length === 0 || nameBytes.length > 240 || nameBytes.some((byte) => byte >= 0x80) ||
    name.includes("\\") || name.includes("%") || name.startsWith("/") || /^[a-z]:/i.test(name) ||
    /[\u0000-\u001f\u007f]/.test(name) || name !== name.toLowerCase() || !/^[a-z0-9][a-z0-9._/-]*$/.test(name)
  ) {
    fail("ARCHIVE_PATH_UNSAFE");
  }
  const segments = name.split("/");
  if (segments.some((part) => part === "" || part === "." || part === ".." || part.endsWith("."))) {
    fail("ARCHIVE_PATH_UNSAFE");
  }
  if (segments.some((part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/.test(part))) {
    fail("ARCHIVE_PATH_UNSAFE");
  }
  if (segments.some((part) => Buffer.byteLength(part, "ascii") > 100)) fail("ARCHIVE_PATH_UNSAFE");
  return name.normalize("NFC").toLowerCase();
}

function parseZipArchive(input) {
  if (!(input instanceof Uint8Array)) fail("ARCHIVE_INPUT_INVALID");
  // Copy caller-owned bytes so validation cannot observe a concurrent mutation.
  const bytes = Buffer.from(input);
  if (bytes.length < 22 || bytes.length > LIMITS.archiveBytes) fail("ARCHIVE_SIZE_LIMIT");
  const searchStart = Math.max(0, bytes.length - 22 - 65_535);
  let endOffset = -1;
  for (let offset = bytes.length - 22; offset >= searchStart; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0 || endOffset + 22 > bytes.length) fail("ARCHIVE_STRUCTURE_INVALID");
  const diskNumber = bytes.readUInt16LE(endOffset + 4);
  const centralDisk = bytes.readUInt16LE(endOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(endOffset + 8);
  const entryCount = bytes.readUInt16LE(endOffset + 10);
  const centralSize = bytes.readUInt32LE(endOffset + 12);
  const centralOffset = bytes.readUInt32LE(endOffset + 16);
  const archiveCommentLength = bytes.readUInt16LE(endOffset + 20);
  if (
    diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount ||
    entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff ||
    archiveCommentLength !== 0 || endOffset + 22 !== bytes.length ||
    entryCount < 1 || entryCount > LIMITS.entryCount || centralOffset + centralSize !== endOffset
  ) {
    fail("ARCHIVE_STRUCTURE_INVALID");
  }

  const entries = [];
  const names = new Set();
  const ranges = [];
  let cursor = centralOffset;
  let totalExpandedBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset || bytes.readUInt32LE(cursor) !== 0x02014b50) fail("ARCHIVE_STRUCTURE_INVALID");
    const madeBy = bytes.readUInt16LE(cursor + 4);
    const versionNeeded = bytes.readUInt16LE(cursor + 6);
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const expandedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const startDisk = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const centralEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (
      nameLength === 0 || extraLength !== 0 || commentLength !== 0 || startDisk !== 0 ||
      compressedSize === 0xffffffff || expandedSize === 0xffffffff || localOffset === 0xffffffff ||
      centralEnd > endOffset || localOffset >= centralOffset || versionNeeded > 20 ||
      (flags & ~0x0800) !== 0 || (method !== 0 && method !== 8) ||
      expandedSize > LIMITS.entryBytes || compressedSize > LIMITS.archiveBytes
    ) {
      fail("ARCHIVE_STRUCTURE_INVALID");
    }
    const hostSystem = madeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    const fileType = unixMode & 0xf000;
    if (![0, 3, 10].includes(hostSystem)) fail("ARCHIVE_OS_UNSUPPORTED");
    if (fileType === 0xa000) fail("ARCHIVE_SYMLINK_ENTRY");
    if (hostSystem === 3 && fileType !== 0 && fileType !== 0x8000) fail("ARCHIVE_NONFILE_ENTRY");
    if ((externalAttributes & 0x10) !== 0) fail("ARCHIVE_NONFILE_ENTRY");

    const centralNameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    let name;
    try { name = UTF8.decode(centralNameBytes); } catch { fail("ARCHIVE_PATH_UNSAFE"); }
    const normalizedName = zipPath(name, centralNameBytes);
    if (names.has(normalizedName)) fail("ARCHIVE_DUPLICATE_PATH");
    names.add(normalizedName);
    if (
      expandedSize > 0 && compressedSize === 0 ||
      compressedSize > 0 && expandedSize / compressedSize > LIMITS.compressionRatio
    ) {
      fail("ARCHIVE_EXPANSION_LIMIT");
    }
    totalExpandedBytes += expandedSize;
    if (totalExpandedBytes > LIMITS.totalExpandedBytes) fail("ARCHIVE_EXPANSION_LIMIT");

    if (localOffset + 30 > centralOffset || bytes.readUInt32LE(localOffset) !== 0x04034b50) fail("ARCHIVE_STRUCTURE_INVALID");
    const localFlags = bytes.readUInt16LE(localOffset + 6);
    const localMethod = bytes.readUInt16LE(localOffset + 8);
    const localCrc = bytes.readUInt32LE(localOffset + 14);
    const localCompressedSize = bytes.readUInt32LE(localOffset + 18);
    const localExpandedSize = bytes.readUInt32LE(localOffset + 22);
    const localNameLength = bytes.readUInt16LE(localOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (
      localFlags !== flags || localMethod !== method || localCrc !== checksum ||
      localCompressedSize !== compressedSize || localExpandedSize !== expandedSize ||
      localNameLength !== nameLength || localExtraLength !== 0 || dataEnd > centralOffset ||
      !bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(centralNameBytes)
    ) {
      fail("ARCHIVE_STRUCTURE_INVALID");
    }
    ranges.push({ start: localOffset, end: dataEnd });
    const compressed = bytes.subarray(dataOffset, dataEnd);
    let data;
    try {
      data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: LIMITS.entryBytes });
    } catch {
      fail("ARCHIVE_EXPANSION_LIMIT");
    }
    if (data.length !== expandedSize) fail("ARCHIVE_SIZE_MISMATCH");
    if (crc32(data) !== checksum) fail("ARCHIVE_CRC_MISMATCH");
    entries.push({ name, normalizedName, bytes: data, method });
    cursor = centralEnd;
  }
  if (cursor !== endOffset) fail("ARCHIVE_STRUCTURE_INVALID");
  ranges.sort((left, right) => left.start - right.start);
  if (ranges.length === 0 || ranges[0].start !== 0) fail("ARCHIVE_STRUCTURE_INVALID");
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index - 1].end !== ranges[index].start) fail("ARCHIVE_STRUCTURE_INVALID");
  }
  if (ranges[ranges.length - 1].end !== centralOffset) fail("ARCHIVE_STRUCTURE_INVALID");
  return { bytes, entries };
}

function findEntry(entryMap, name, missingCode = "ARCHIVE_ENTRY_MISSING") {
  const entry = entryMap.get(name);
  if (entry === undefined) fail(missingCode);
  return entry.bytes;
}

function rejectDuplicateJsonKeys(text) {
  let cursor = 0;
  let nodes = 0;
  const whitespace = () => { while (/[\u0020\u0009\u000a\u000d]/.test(text[cursor] ?? "")) cursor += 1; };
  function stringToken() {
    const start = cursor;
    cursor += 1;
    while (cursor < text.length) {
      const character = text[cursor];
      if (character === "\\") { cursor += 2; continue; }
      if (character === '"') {
        cursor += 1;
        try { return JSON.parse(text.slice(start, cursor)); } catch { fail("PACKAGE_JSON_INVALID"); }
      }
      cursor += 1;
    }
    fail("PACKAGE_JSON_INVALID");
  }
  function value(depth) {
    nodes += 1;
    if (nodes > LIMITS.jsonNodes || depth > LIMITS.jsonDepth) fail("PACKAGE_JSON_LIMIT");
    whitespace();
    const next = text[cursor];
    if (next === '"') { stringToken(); return; }
    if (next === "{") {
      cursor += 1;
      whitespace();
      const keys = new Set();
      if (text[cursor] === "}") { cursor += 1; return; }
      while (cursor < text.length) {
        whitespace();
        if (text[cursor] !== '"') fail("PACKAGE_JSON_INVALID");
        const key = stringToken();
        if (keys.has(key)) fail("PACKAGE_JSON_DUPLICATE_KEY");
        keys.add(key);
        whitespace();
        if (text[cursor] !== ":") fail("PACKAGE_JSON_INVALID");
        cursor += 1;
        value(depth + 1);
        whitespace();
        if (text[cursor] === "}") { cursor += 1; return; }
        if (text[cursor] !== ",") fail("PACKAGE_JSON_INVALID");
        cursor += 1;
      }
      fail("PACKAGE_JSON_INVALID");
    }
    if (next === "[") {
      cursor += 1;
      whitespace();
      if (text[cursor] === "]") { cursor += 1; return; }
      while (cursor < text.length) {
        value(depth + 1);
        whitespace();
        if (text[cursor] === "]") { cursor += 1; return; }
        if (text[cursor] !== ",") fail("PACKAGE_JSON_INVALID");
        cursor += 1;
      }
      fail("PACKAGE_JSON_INVALID");
    }
    const start = cursor;
    while (cursor < text.length && !/[\u0020\u0009\u000a\u000d,\]}]/.test(text[cursor])) cursor += 1;
    if (cursor === start) fail("PACKAGE_JSON_INVALID");
  }
  value(0);
  whitespace();
  if (cursor !== text.length) fail("PACKAGE_JSON_INVALID");
}

function parseJsonBytes(bytes, code = "PACKAGE_JSON_INVALID") {
  if (bytes.length === 0 || bytes.length > LIMITS.entryBytes) fail(code);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail("PACKAGE_UTF8_BOM");
  let text;
  try { text = UTF8.decode(bytes); } catch { fail("PACKAGE_UTF8_INVALID"); }
  rejectDuplicateJsonKeys(text);
  let value;
  try { value = JSON.parse(text); } catch { fail(code); }
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "number" && !Number.isFinite(current)) fail("PACKAGE_JSON_NUMBER_INVALID");
    if (current !== null && typeof current === "object") {
      for (const child of Array.isArray(current) ? current : Object.values(current)) pending.push(child);
    }
  }
  return value;
}

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
function readLocalSchema(relativePath) {
  const bytes = readFileSync(new URL(`../../schemas/owner-export/${relativePath}`, import.meta.url));
  if (bytes.length > LIMITS.schemaBytes) throw new Error("local owner export schema exceeds its bound");
  const schema = parseJsonBytes(bytes, "LOCAL_SCHEMA_INVALID");
  return { bytes, schema };
}

const localManifest10 = readLocalSchema("v1.0/manifest.schema.json");
const localManifest11 = readLocalSchema("v1.1/manifest.schema.json");
const localManifest12 = readLocalSchema("v1.2/manifest.schema.json");
const localManifest13 = readLocalSchema("v1.3/manifest.schema.json");
const localManifest14 = readLocalSchema("v1.4/manifest.schema.json");
const localManifest15 = readLocalSchema("v1.5/manifest.schema.json");
const localManifest16 = readLocalSchema("v1.6/manifest.schema.json");
const localManifest17 = readLocalSchema("v1.7/manifest.schema.json");
const manifestValidators = new Map([
  ["1.0", ajv.compile(localManifest10.schema)],
  ["1.1", ajv.compile(localManifest11.schema)],
  ["1.3", ajv.compile(localManifest12.schema)],
  ["1.4", ajv.compile(localManifest13.schema)],
  ["1.5", ajv.compile(localManifest14.schema)],
  ["1.6", ajv.compile(localManifest15.schema)],
  ["1.7", ajv.compile(localManifest16.schema)],
  ["1.8", ajv.compile(localManifest17.schema)],
]);
function readLocalRecordSchemas(schemaVersion) {
  return new Map(SCOPES.map((scope) => {
    const source = readLocalSchema(`v${schemaVersion}/${scope}.schema.json`);
    const expectedUri = `urn:shipwithali:owner-export-schema:${scope}:${schemaVersion}`;
    if (source.schema.$id !== expectedUri) throw new Error(`invalid local schema identity for ${scope}`);
    return [scope, { ...source, validate: ajv.compile(source.schema), uri: expectedUri }];
  }));
}
const localRecordSchemas10 = readLocalRecordSchemas("1.0");
const localRecordSchemas11 = readLocalRecordSchemas("1.1");
const localRecordSchemas12 = new Map(localRecordSchemas11);
{
  const scope = "portfolio-content";
  const source = readLocalSchema("v1.2/portfolio-content.schema.json");
  const expectedUri = `urn:shipwithali:owner-export-schema:${scope}:1.2`;
  if (source.schema.$id !== expectedUri) throw new Error(`invalid local schema identity for ${scope}`);
  localRecordSchemas12.set(scope, { ...source, validate: ajv.compile(source.schema), uri: expectedUri });
}
const localRecordSchemas13 = new Map(localRecordSchemas11);
localRecordSchemas13.set("portfolio-content", localRecordSchemas12.get("portfolio-content"));
const taxonomySchema13 = readLocalSchema("v1.3/taxonomy.schema.json");
if (taxonomySchema13.schema.$id !== "urn:shipwithali:owner-export-schema:taxonomy:1.2") {
  throw new Error("invalid local taxonomy schema identity");
}
localRecordSchemas12.set("taxonomy", { ...taxonomySchema13, validate: ajv.compile(taxonomySchema13.schema), uri: taxonomySchema13.schema.$id });
const localRecordSchemas15 = new Map(localRecordSchemas12);
const mediaSchema14 = readLocalSchema("v1.4/media-metadata.schema.json");
if (mediaSchema14.schema.$id !== "urn:shipwithali:owner-export-schema:media-metadata:1.2") {
  throw new Error("invalid local Media schema identity");
}
localRecordSchemas15.set("media-metadata", { ...mediaSchema14, validate: ajv.compile(mediaSchema14.schema), uri: mediaSchema14.schema.$id });
const localRecordSchemas16 = new Map(localRecordSchemas15);
const cvSchema16 = readLocalSchema("v1.2/cv-metadata.schema.json");
if (cvSchema16.schema.$id !== "urn:shipwithali:owner-export-schema:cv-metadata:1.2") throw new Error("invalid local CV schema identity");
localRecordSchemas16.set("cv-metadata", { ...cvSchema16, validate: ajv.compile(cvSchema16.schema), uri: cvSchema16.schema.$id });
const localRecordSchemas17 = new Map(localRecordSchemas16);
const moderationSchema17 = readLocalSchema("v1.2/moderation-history.schema.json");
if (moderationSchema17.schema.$id !== "urn:shipwithali:owner-export-schema:moderation-history:1.2") throw new Error("invalid local Moderation schema identity");
localRecordSchemas17.set("moderation-history", { ...moderationSchema17, validate: ajv.compile(moderationSchema17.schema), uri: moderationSchema17.schema.$id });
const localRecordSchemas18 = new Map(localRecordSchemas17);
const analyticsSchema18 = readLocalSchema("v1.7/analytics-reports.schema.json");
if (analyticsSchema18.schema.$id !== "urn:shipwithali:owner-export-schema:analytics-reports:1.2") throw new Error("invalid local Analytics schema identity");
localRecordSchemas18.set("analytics-reports", { ...analyticsSchema18, validate: ajv.compile(analyticsSchema18.schema), uri: analyticsSchema18.schema.$id });
function recordSchemasForVersion(version) {
  return version === "1.0" ? localRecordSchemas10 : version === "1.3" ? localRecordSchemas13 : version === "1.4" ? localRecordSchemas12 : version === "1.5" ? localRecordSchemas15 : version === "1.6" ? localRecordSchemas16 : version === "1.7" ? localRecordSchemas17 : version === "1.8" ? localRecordSchemas18 : localRecordSchemas11;
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function supportedManifestVersion(manifest) {
  const version = manifest?.schemaVersion;
  if (typeof version !== "string" || !/^[1-9][0-9]*\.(?:0|[1-9][0-9]*)$/.test(version)) fail("PACKAGE_VERSION_INVALID");
  const [major, minor] = version.split(".").map(Number);
  if (major !== 1) fail("PACKAGE_VERSION_MAJOR_UNSUPPORTED");
  if (minor === 0) return "1.0";
  if (minor === 3) return "1.3";
  if (minor === 4) return "1.4";
  if (minor === 5) return "1.5";
  if (minor === 6) return "1.6";
  if (minor === 7) return "1.7";
  if (minor === 8) return "1.8";
  if (minor === undefined || minor < 1) fail("PACKAGE_VERSION_MINOR_UNSUPPORTED");
  return "1.1";
}

function checkRequiredFeatures(manifest) {
  if (!Array.isArray(manifest.requiredFeatures)) fail("PACKAGE_REQUIRED_SEMANTICS_MISSING");
  if (manifest.requiredFeatures.some((feature) => !REQUIRED_FEATURES.includes(feature))) fail("PACKAGE_REQUIRED_SEMANTICS_UNSUPPORTED");
  if (manifest.requiredFeatures.length !== REQUIRED_FEATURES.length ||
    REQUIRED_FEATURES.some((feature, index) => manifest.requiredFeatures[index] !== feature)) {
    fail("PACKAGE_REQUIRED_SEMANTICS_MISSING");
  }
}

function validateSchema(validator, value, code) {
  if (!validator(value)) fail(code);
}

function validateEntryDescriptor(entry, version) {
  if (!object(entry) || !SCOPE_SET.has(entry.scope)) fail("PACKAGE_ENTRY_DESCRIPTOR_INVALID");
  const extension = entry.mediaType === "application/x-ndjson" ? "ndjson" : entry.mediaType === "application/json" ? "json" : "";
  const schemaVersion = version === "1.0" ? "1.0" :
    (version === "1.3" || version === "1.4" || version === "1.5" || version === "1.7" || version === "1.8") && entry.scope === "portfolio-content" ||
    (version === "1.4" || version === "1.5" || version === "1.7" || version === "1.8") && entry.scope === "taxonomy" || (version === "1.5" || version === "1.6" || version === "1.7" || version === "1.8") && entry.scope === "media-metadata" ||
    (version === "1.6" || version === "1.7" || version === "1.8") && entry.scope === "cv-metadata" ||
    (version === "1.7" || version === "1.8") && entry.scope === "moderation-history" || version === "1.8" && entry.scope === "analytics-reports" ? "1.2" : "1.1";
  const schema = recordSchemasForVersion(version).get(entry.scope);
  if (
    extension === "" || entry.path !== `records/${entry.scope}.${extension}` ||
    entry.recordSchema !== schema.uri || entry.schemaPath !== `schemas/${entry.scope}.schema.json` ||
    entry.schemaVersion !== schemaVersion || !DIGEST_PATTERN.test(entry.digest) ||
    !Number.isSafeInteger(entry.recordCount) || entry.recordCount < 0 || entry.recordCount > LIMITS.recordsPerScope
  ) {
    fail("PACKAGE_ENTRY_DESCRIPTOR_INVALID");
  }
  if (version === "1.0" && entry.scope === "media-metadata" && entry.recordCount > 0) {
    // Legacy 1.0 never declared portable asset-byte coverage.
    fail("PACKAGE_LEGACY_ASSET_UNSUPPORTED");
  }
}

function verifySchemaEntries(manifest, version, entryMap) {
  const usedScopes = manifest.entries.map((entry) => entry.scope);
  const schemaVersion = version === "1.0" ? "1.0" : "1.1";
  const localRecordSchemas = recordSchemasForVersion(version);
  const schemaDescriptors = version === "1.0" ? undefined : manifest.schemas;
  const expectedDescriptors = [];
  if (version !== "1.0") {
    const manifestSchema = version === "1.8" ? localManifest17 : version === "1.7" ? localManifest16 : version === "1.6" ? localManifest15 : version === "1.5" ? localManifest14 : version === "1.4" ? localManifest13 : version === "1.3" ? localManifest12 : localManifest11;
    const manifestSchemaVersion = version === "1.8" ? "1.7" : version === "1.7" ? "1.6" : version === "1.6" ? "1.5" : version === "1.5" ? "1.4" : version === "1.4" ? "1.3" : version === "1.3" ? "1.2" : "1.1";
    expectedDescriptors.push({
      kind: "manifest", path: "schemas/manifest.schema.json", schemaUri: `urn:shipwithali:owner-export-schema:manifest:${manifestSchemaVersion}`,
      schemaVersion: manifestSchemaVersion, digest: sha256(manifestSchema.bytes), source: manifestSchema,
    });
  }
  for (const scope of usedScopes) {
    const source = localRecordSchemas.get(scope);
    const recordVersion = (version === "1.3" || version === "1.4" || version === "1.5" || version === "1.6" || version === "1.7" || version === "1.8") && scope === "portfolio-content" ||
      (version === "1.4" || version === "1.5" || version === "1.7" || version === "1.8") && scope === "taxonomy" || (version === "1.5" || version === "1.6" || version === "1.7" || version === "1.8") && scope === "media-metadata" ||
      (version === "1.6" || version === "1.7" || version === "1.8") && scope === "cv-metadata" ||
      (version === "1.7" || version === "1.8") && scope === "moderation-history"
      ? "1.2" : version === "1.8" && scope === "analytics-reports" ? "1.2" : schemaVersion;
    expectedDescriptors.push({
      kind: "record", scope, path: `schemas/${scope}.schema.json`, schemaUri: source.uri,
      schemaVersion: recordVersion, digest: sha256(source.bytes), source,
    });
  }
  if (version !== "1.0") {
    if (!Array.isArray(schemaDescriptors) || schemaDescriptors.length !== expectedDescriptors.length) fail("PACKAGE_SCHEMA_COVERAGE_INVALID");
    for (let index = 0; index < expectedDescriptors.length; index += 1) {
      const expected = expectedDescriptors[index];
      const actual = schemaDescriptors[index];
      if (
        !object(actual) || actual.kind !== expected.kind || actual.path !== expected.path ||
        actual.scope !== expected.scope || actual.schemaUri !== expected.schemaUri ||
        actual.schemaVersion !== expected.schemaVersion || actual.digest !== expected.digest
      ) {
        fail("PACKAGE_SCHEMA_DESCRIPTOR_INVALID");
      }
      const bytes = findEntry(entryMap, expected.path, "PACKAGE_SCHEMA_MISSING");
      if (!bytes.equals(expected.source.bytes) || sha256(bytes) !== actual.digest) fail("PACKAGE_SCHEMA_DIGEST_MISMATCH");
      const embedded = parseJsonBytes(bytes, "PACKAGE_SCHEMA_INVALID");
      if (embedded.$id !== expected.schemaUri) fail("PACKAGE_SCHEMA_IDENTITY_INVALID");
    }
  } else {
    for (const expected of expectedDescriptors) {
      const bytes = findEntry(entryMap, expected.path, "PACKAGE_SCHEMA_MISSING");
      if (!bytes.equals(expected.source.bytes)) fail("PACKAGE_SCHEMA_IDENTITY_INVALID");
      const embedded = parseJsonBytes(bytes, "PACKAGE_SCHEMA_INVALID");
      if (embedded.$id !== expected.schemaUri) fail("PACKAGE_SCHEMA_IDENTITY_INVALID");
    }
  }
  return expectedDescriptors;
}

function recordsFromEntry(bytes, descriptor, validateRecord) {
  if (sha256(bytes) !== descriptor.digest) fail("ENTRY_DIGEST_MISMATCH");
  if (descriptor.recordCount === 0) {
    if (bytes.length !== 0) fail("ENTRY_EMPTY_BYTES_INVALID");
    if (descriptor.mediaType !== "application/x-ndjson") fail("PACKAGE_NDJSON_INVALID");
    return [];
  }
  const text = (() => {
    if (bytes.length > LIMITS.entryBytes) fail("ENTRY_SIZE_LIMIT");
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail("PACKAGE_UTF8_BOM");
    try { return UTF8.decode(bytes); } catch { fail("PACKAGE_UTF8_INVALID"); }
  })();
  let records;
  if (descriptor.mediaType === "application/x-ndjson") {
    if (!text.endsWith("\n") || text.includes("\r")) fail("PACKAGE_NDJSON_INVALID");
    const lines = text.slice(0, -1).split("\n");
    if (lines.length === 0 || lines.some((line) => line.length === 0)) fail("PACKAGE_NDJSON_INVALID");
    if (lines.length > LIMITS.recordsPerScope) fail("ENTRY_RECORD_LIMIT");
    records = lines.map((line) => parseJsonBytes(Buffer.from(line, "utf8"), "PACKAGE_NDJSON_INVALID"));
  } else {
    const parsed = parseJsonBytes(bytes, "PACKAGE_JSON_INVALID");
    if (!Array.isArray(parsed)) fail("PACKAGE_JSON_INVALID");
    if (parsed.length > LIMITS.recordsPerScope) fail("ENTRY_RECORD_LIMIT");
    records = parsed;
  }
  if (records.length !== descriptor.recordCount) fail("ENTRY_COUNT_MISMATCH");
  for (const record of records) validateSchema(validateRecord, record, "PACKAGE_RECORD_INVALID");
  return records;
}

function scopeOrder(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0 || new Set(scopes).size !== scopes.length || scopes.some((scope) => !SCOPE_SET.has(scope))) {
    fail("PACKAGE_SCOPE_COVERAGE_INVALID");
  }
  return [...scopes].sort((left, right) => SCOPES.indexOf(left) - SCOPES.indexOf(right));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareUtcInstant(left, right) {
  const [leftBase, leftFraction = ""] = left.replace(/Z$/, "").split(".");
  const [rightBase, rightFraction = ""] = right.replace(/Z$/, "").split(".");
  const baseOrder = compareText(leftBase, rightBase);
  return baseOrder === 0
    ? compareText(leftFraction.padEnd(9, "0"), rightFraction.padEnd(9, "0"))
    : baseOrder;
}

function addUtcCalendarMonths(value, months) {
  const date = new Date(Date.parse(value));
  const originalDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCFullYear(date.getUTCFullYear() + Math.floor(months / 12));
  date.setUTCMonth(date.getUTCMonth() + months % 12);
  const finalDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(originalDay, finalDay));
  return date.getTime();
}

function measurementAggregateExpiryAt(utcDay) {
  const [year, month, day] = utcDay.split("-").map(Number);
  const targetMonth = month - 1 + 13;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = targetMonth % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return Date.UTC(targetYear, normalizedMonth, Math.min(day, lastDay));
}

function verifyAnalyticsRetention(manifest, records) {
  const capturedAt = manifest.snapshot.capturedAt;
  const captureTime = Date.parse(capturedAt);
  const captureDay = capturedAt.slice(0, 10);
  let earliest = captureDay;
  let previousDay = new Date(Date.parse(`${earliest}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  while (measurementAggregateExpiryAt(previousDay) > captureTime) {
    earliest = previousDay;
    previousDay = new Date(Date.parse(`${earliest}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  }
  const policy = manifest.extensions?.analyticsReportPolicy;
  if (!object(policy) || Object.keys(policy).sort().join(",") !== "aggregateRetentionExpiresAt,breakdown,grouping,maximumPeriodDays,maximumRowsPerQuery,minimumObservedSubjects,totalRows,withheldCounts" ||
      policy.maximumPeriodDays !== 31 || policy.maximumRowsPerQuery !== 500 || policy.minimumObservedSubjects !== 5 ||
      policy.grouping !== "daily-goal" || policy.breakdown !== "locale" || policy.totalRows !== "omitted" || policy.withheldCounts !== "omitted" ||
      policy.aggregateRetentionExpiresAt !== new Date(measurementAggregateExpiryAt(earliest)).toISOString()) {
    fail("PACKAGE_ANALYTICS_POLICY_INVALID");
  }
  for (const record of records) {
    for (const version of record.value.goal.versions) {
      const reports = record.value.reports.filter((report) => report.goalVersionId === version.versionId);
      let expectedStart = earliest;
      let index = 0;
      while (expectedStart <= captureDay) {
        const expectedEnd = new Date(Math.min(Date.parse(`${captureDay}T00:00:00Z`),
          Date.parse(`${expectedStart}T00:00:00Z`) + 30 * 86_400_000)).toISOString().slice(0, 10);
        const report = reports[index++];
        const reportAsOf = report ? Date.parse(report.asOf) : Number.NaN;
        if (!report || report.periodStartDay !== expectedStart || report.periodEndDay !== expectedEnd ||
            report.periodEndDay > captureDay || measurementAggregateExpiryAt(report.periodStartDay) <= captureTime ||
            !Number.isFinite(reportAsOf) || reportAsOf > captureTime || Object.hasOwn(report, "aggregateCount")) {
          fail("PACKAGE_ANALYTICS_RETENTION_INVALID");
        }
        if (report.cells !== undefined) {
          if (!Array.isArray(report.cells) || report.cells.length > 499) fail("PACKAGE_ANALYTICS_REPORT_INVALID");
          const seenCells = new Set();
          for (const cell of report.cells) {
            const key = `${cell.utcDay}:${cell.locale}`;
            const cellTime = Date.parse(`${cell.utcDay}T00:00:00Z`);
            if (!Number.isFinite(cellTime) || new Date(cellTime).toISOString().slice(0, 10) !== cell.utcDay ||
                cell.utcDay < report.periodStartDay || cell.utcDay > report.periodEndDay || seenCells.has(key)) {
              fail("PACKAGE_ANALYTICS_REPORT_INVALID");
            }
            seenCells.add(key);
          }
        }
        expectedStart = new Date(Date.parse(`${expectedEnd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      }
      if (index !== reports.length) fail("PACKAGE_ANALYTICS_RETENTION_INVALID");
    }
  }
}

function verifyModerationRetention(records, capturedAt) {
  const captureTime = Date.parse(capturedAt);
  for (const record of records) {
    const value = record.value;
    if ((value.state === "pending" || value.state === "rejected") &&
        captureTime >= Date.parse(value.submittedAt) + 90 * 86_400_000) {
      fail("PACKAGE_MODERATION_RETENTION_INVALID");
    }
    if (value.state === "suppressed") {
      const lastDecision = value.decisionHistory.at(-1);
      if (lastDecision === undefined || lastDecision.decision !== "suppressed") fail("PACKAGE_MODERATION_HISTORY_INVALID");
      if (value.textDisposition === "retained" && captureTime >= addUtcCalendarMonths(lastDecision.decidedAt, 12)) {
        fail("PACKAGE_MODERATION_RETENTION_INVALID");
      }
    }
  }
}

function verifyRecordOrdering(scope, records, version) {
  const valueOf = (record) => version === "1.0" ? record : record.value;
  if (scope === "cv-metadata" || scope === "portfolio-configuration") {
    if (records.length > 1) fail("PACKAGE_RECORD_ORDER_INVALID");
  } else {
    let previousId = "";
    for (const record of records) {
      const value = valueOf(record);
      const identity = scope === "portfolio-content" ? value.contentId
        : scope === "taxonomy" ? value.taxonomyId
          : scope === "media-metadata" ? value.mediaId
            : scope === "moderation-history" ? value.feedbackId
              : value.goal.goalId;
      if (typeof identity !== "string" || !STABLE_ID_PATTERN.test(identity) || identity <= previousId) {
        fail("PACKAGE_RECORD_ORDER_INVALID");
      }
      previousId = identity;
    }
  }

  if (scope === "portfolio-content") {
    const localeOrder = new Map([["en", 0], ["ar", 1]]);
    for (const record of records) {
      let previous;
      for (const revision of valueOf(record).revisions) {
        if (!object(revision) || !localeOrder.has(revision.locale) || !Number.isSafeInteger(revision.sequence) ||
          typeof revision.revisionId !== "string" || !STABLE_ID_PATTERN.test(revision.revisionId)) {
          fail("PACKAGE_RECORD_ORDER_INVALID");
        }
        const current = { locale: localeOrder.get(revision.locale), sequence: revision.sequence, revisionId: revision.revisionId };
        if (previous !== undefined && (
          current.locale < previous.locale || current.locale === previous.locale && current.sequence < previous.sequence ||
          current.locale === previous.locale && current.sequence === previous.sequence && current.revisionId <= previous.revisionId
        )) fail("PACKAGE_RECORD_ORDER_INVALID");
        previous = current;
      }
    }
  } else if (scope === "cv-metadata") {
    for (const record of records) {
      const value = valueOf(record);
      const currentVersions = value.versions.filter((version) => version.isCurrent);
      if (value.currentVersionId === null && currentVersions.length !== 0 ||
        value.currentVersionId !== null && (currentVersions.length !== 1 || currentVersions[0].versionId !== value.currentVersionId || currentVersions[0].state !== "accepted")) {
        fail("PACKAGE_RECORD_CURRENT_CV_INVALID");
      }
      let previous;
      for (const activation of value.activationHistory) {
        const previousKey = previous === undefined ? undefined : (version === "1.6" || version === "1.7") ? previous.activationId : previous.versionId;
        const activationKey = (version === "1.6" || version === "1.7") ? activation.activationId : activation.versionId;
        if (previous !== undefined && (
          compareUtcInstant(previous.activatedAt, activation.activatedAt) < 0 ||
          compareUtcInstant(previous.activatedAt, activation.activatedAt) === 0 && previousKey < activationKey
        )) fail("PACKAGE_RECORD_ORDER_INVALID");
        previous = activation;
      }
    }
  } else if (scope === "analytics-reports") {
    for (const record of records) {
      const goal = valueOf(record).goal;
      for (let index = 1; index < goal.versions.length; index += 1) {
        if (goal.versions[index - 1].versionNumber >= goal.versions[index].versionNumber) fail("PACKAGE_RECORD_ORDER_INVALID");
      }
      for (let index = 1; index < goal.activationHistory.length; index += 1) {
        const previous = goal.activationHistory[index - 1];
        const current = goal.activationHistory[index];
        if (version === "1.8"
          ? current.activationSequence !== previous.activationSequence + 1
          : compareUtcInstant(previous.activatedAt, current.activatedAt) > 0 ||
            compareUtcInstant(previous.activatedAt, current.activatedAt) === 0 && previous.versionId >= current.versionId) {
          fail("PACKAGE_RECORD_ORDER_INVALID");
        }
      }
      if (version === "1.8" && goal.activationHistory.length > 0 && goal.activationHistory[0].activationSequence !== 1) {
        fail("PACKAGE_RECORD_ORDER_INVALID");
      }
      const reports = valueOf(record).reports;
      if (version === "1.8") {
        const versionOrder = new Map(goal.versions.map((item, index) => [item.versionId, index]));
        let previousVersionIndex = -1;
        let previousEndDay;
        for (const report of reports) {
          const currentVersionIndex = versionOrder.get(report.goalVersionId);
          if (currentVersionIndex === undefined || currentVersionIndex < previousVersionIndex ||
              currentVersionIndex === previousVersionIndex && previousEndDay !== undefined && report.periodStartDay <= previousEndDay ||
              (Date.parse(`${report.periodEndDay}T00:00:00Z`) - Date.parse(`${report.periodStartDay}T00:00:00Z`)) / 86_400_000 >= 31) {
            fail("PACKAGE_ANALYTICS_REPORT_ORDER_INVALID");
          }
          if (currentVersionIndex !== previousVersionIndex) previousEndDay = undefined;
          previousVersionIndex = currentVersionIndex;
          previousEndDay = report.periodEndDay;
        }
        continue;
      }
      for (let index = 1; index < reports.length; index += 1) {
        const previous = reports[index - 1];
        const current = reports[index];
        if (compareUtcInstant(previous.periodStart, current.periodStart) > 0 ||
          compareUtcInstant(previous.periodStart, current.periodStart) === 0 && compareUtcInstant(previous.periodEnd, current.periodEnd) > 0 ||
          compareUtcInstant(previous.periodStart, current.periodStart) === 0 && compareUtcInstant(previous.periodEnd, current.periodEnd) === 0 && previous.goalVersionId >= current.goalVersionId) {
          fail("PACKAGE_RECORD_ORDER_INVALID");
        }
      }
    }
  } else if (scope === "moderation-history" && version === "1.7") {
    for (const record of records) {
      const value = valueOf(record);
      const history = value.decisionHistory;
      if (value.state === "pending" ? history.length !== 0 : history.length === 0 || history.at(-1).decision !== value.state) {
        fail("PACKAGE_MODERATION_HISTORY_INVALID");
      }
      for (let index = 0; index < history.length; index += 1) {
        if (history[index].sequence !== index + 1) fail("PACKAGE_MODERATION_HISTORY_INVALID");
      }
      if (value.textDisposition === "erased" && (Object.hasOwn(value, "authorName") || Object.hasOwn(value, "paragraph"))) {
        fail("PACKAGE_MODERATION_ERASURE_INVALID");
      }
    }
  }
}

/** Independently checks CV version/history links after the record schema passes. */
function verifyCvSnapshotFacts(records) {
  const require = condition => { if (!condition) fail("CV_SNAPSHOT_FACTS_INVALID"); };
  for (const record of records) {
    const value = record.value;
    require(value.versionsTruncated === false && value.acceptanceHistoryTruncated === false && value.activationHistoryTruncated === false);
    const versions = new Map();
    let previousVersionNumber;
    for (const version of value.versions) {
      require(!versions.has(version.versionId) &&
        (previousVersionNumber === undefined || previousVersionNumber > version.versionNumber));
      versions.set(version.versionId, version);
      previousVersionNumber = version.versionNumber;
    }
    const currentVersions = [...versions.values()].filter(version => version.isCurrent);
    if (value.currentVersionId === null) {
      require(currentVersions.length === 0 && value.activationHistory.length === 0);
    } else {
      require(currentVersions.length === 1 && currentVersions[0].versionId === value.currentVersionId && currentVersions[0].state === "accepted");
    }

    const acceptancesByVersion = new Map();
    let previousAcceptance;
    const approvalIds = new Set();
    for (const acceptance of value.acceptanceHistory) {
      require(!approvalIds.has(acceptance.approvalId));
      approvalIds.add(acceptance.approvalId);
      if (previousAcceptance !== undefined && (
        compareUtcInstant(previousAcceptance.acceptedAt, acceptance.acceptedAt) < 0 ||
        compareUtcInstant(previousAcceptance.acceptedAt, acceptance.acceptedAt) === 0 && previousAcceptance.approvalId < acceptance.approvalId
      )) fail("CV_SNAPSHOT_FACTS_INVALID");
      previousAcceptance = acceptance;
      const version = versions.get(acceptance.versionId);
      require(version !== undefined && version.state === "accepted" && version.acceptedAt === acceptance.acceptedAt &&
        compareUtcInstant(acceptance.acceptedAt, version.registeredAt) >= 0);
      const count = (acceptancesByVersion.get(acceptance.versionId) ?? 0) + 1;
      require(count === 1);
      acceptancesByVersion.set(acceptance.versionId, count);
    }
    for (const version of versions.values()) {
      if (version.state === "accepted") {
        require(version.acceptedAt !== undefined && compareUtcInstant(version.acceptedAt, version.registeredAt) >= 0);
        require(acceptancesByVersion.has(version.versionId));
      } else {
        require(!acceptancesByVersion.has(version.versionId));
      }
    }

    const activationIds = new Set();
    let previousActivation;
    for (const activation of value.activationHistory) {
      require(!activationIds.has(activation.activationId));
      if (previousActivation !== undefined && (
        compareUtcInstant(previousActivation.activatedAt, activation.activatedAt) < 0 ||
        compareUtcInstant(previousActivation.activatedAt, activation.activatedAt) === 0 && previousActivation.activationId < activation.activationId
      )) fail("CV_SNAPSHOT_FACTS_INVALID");
      previousActivation = activation;
      activationIds.add(activation.activationId);
      const version = versions.get(activation.versionId);
      require(version !== undefined && version.state === "accepted" && version.acceptedAt !== undefined &&
        compareUtcInstant(activation.activatedAt, version.acceptedAt) >= 0);
    }
    if (value.currentVersionId !== null) {
      require(value.activationHistory.length > 0 && value.activationHistory[0].versionId === value.currentVersionId);
    }
  }
}

function verifyContentSnapshotFacts(records) {
  const require = condition => { if (!condition) fail("CONTENT_SNAPSHOT_FACTS_INVALID"); };
  const stable = value => typeof value === "string" && STABLE_ID_PATTERN.test(value);
  const utc = value => typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/.test(value);
  for (const record of records) {
    const value = record.value;
    const revisionsByLocale = new Map([["en", []], ["ar", []]]);
    const revisionById = new Map();
    for (const revision of value.revisions) {
      require(revisionsByLocale.has(revision.locale) && !revisionById.has(revision.revisionId) && utc(revision.savedAt));
      const stream = revisionsByLocale.get(revision.locale);
      require(revision.sequence === stream.length + 1);
      require(revision.payload.contentType === value.contentType && revision.payload.locale === revision.locale &&
        revision.payload.title === revision.title && revision.payload.summary === revision.summary && revision.payload.body === revision.body);
      let previousReviewSequence = 0;
      const reviewIds = new Set();
      for (const review of revision.reviews) {
        require(review.revisionId === revision.revisionId && review.contentId === value.contentId &&
          review.contentType === value.contentType && review.locale === revision.locale && review.reviewSequence === previousReviewSequence + 1 &&
          !reviewIds.has(review.reviewId) && utc(review.reviewedAt));
        previousReviewSequence = review.reviewSequence;
        reviewIds.add(review.reviewId);
      }
      stream.push(revision);
      revisionById.set(revision.revisionId, revision);
    }
    const historiesByLocale = new Map([["en", []], ["ar", []]]);
    for (const publication of value.publicationHistory) {
      const history = historiesByLocale.get(publication.locale);
      require(history !== undefined && publication.sequence === history.length + 1 && utc(publication.publishedAt));
      const revision = revisionById.get(publication.revisionId);
      require(revision !== undefined && revision.locale === publication.locale &&
        revision.reviews.some(review => review.reviewId === publication.reviewId && review.decision === "accepted"));
      history.push(publication);
    }
    const currentByLocale = new Map();
    for (const publication of value.publications) {
      require(!currentByLocale.has(publication.locale) && utc(publication.publishedAt));
      const history = historiesByLocale.get(publication.locale);
      const latest = history?.at(-1);
      require(latest !== undefined && latest.sequence === publication.publicationSequence && latest.revisionId === publication.revisionId &&
        latest.reviewId === publication.reviewId && latest.publishedAt === publication.publishedAt);
      const revision = revisionById.get(publication.revisionId);
      require(revision !== undefined && revision.locale === publication.locale &&
        revision.reviews.some(review => review.reviewId === publication.reviewId && review.decision === "accepted"));
      currentByLocale.set(publication.locale, publication);
    }
    for (const revision of value.revisions) {
      require(revision.currentlyPublished === (currentByLocale.get(revision.locale)?.revisionId === revision.revisionId));
    }
    let previousLifecycle;
    let sequence = 0;
    for (const entry of value.lifecycleHistory) {
      sequence += 1;
      require(entry.sequence === sequence && (previousLifecycle === undefined || entry.previousLifecycle === previousLifecycle));
      previousLifecycle = entry.lifecycle;
    }
    require(value.lifecycleHistory.length === 0 || previousLifecycle === value.lifecycle);
    if (value.publicRoute === null) {
      require(value.publicRouteIdentity === null && value.routeHistory.length === 0 &&
        (value.contentType !== "project" || value.lifecycle === "draft" && value.firstPublishedAt === null));
    } else {
      const route = value.publicRoute;
      require(value.contentType === "project" && value.publicRouteIdentity === route.identity && stable(route.identity) &&
        value.firstPublishedAt === route.firstPublishedAt && route.reservations.length > 0 && utc(route.firstPublishedAt));
      const current = route.reservations.filter(reservation => reservation.isCurrent);
      require(current.length === 1 && current[0].slug === route.canonicalSlug);
      for (let index = 0; index < route.history.length; index += 1) {
        const event = route.history[index];
        require(event.sequence === index + 1 && event.fromSlug !== event.toSlug && utc(event.changedAt));
        if (index > 0) require(route.history[index - 1].toSlug === event.fromSlug);
      }
      if (route.history.length > 0) require(route.history.at(-1).toSlug === route.canonicalSlug);
      const reserved = new Set(route.reservations.map(reservation => reservation.slug));
      require(reserved.size === route.reservations.length && route.history.every(event => reserved.has(event.fromSlug) && reserved.has(event.toSlug)));
      require(value.routeHistory.length === route.reservations.filter(reservation => !reservation.isCurrent).length &&
        value.routeHistory.every(redirect => reserved.has(redirect.fromSlug) && redirect.toSlug === route.canonicalSlug));
    }
    if (value.firstPublishedAt === null) require(value.publicDiscoveryOrder === null);
    else require(utc(value.firstPublishedAt) && value.publicDiscoveryOrder?.firstPublishedAt === value.firstPublishedAt &&
      value.publicDiscoveryOrder?.tieBreaker === "content-id-desc");
    require(value.relationshipHistory.every(entry => stable(entry.leftProjectId) && stable(entry.rightProjectId) &&
      entry.leftProjectId < entry.rightProjectId && entry.sequence > 0 && utc(entry.occurredAt)));
    require(value.taxonomyAssignments.every(assignment => stable(assignment.taxonomyId) && stable(assignment.valueId)));
  }
}

function verifyTaxonomySnapshotFacts(records, contentRecords, includedScopes) {
  const require = condition => { if (!condition) fail("TAXONOMY_SNAPSHOT_FACTS_INVALID"); };
  const stable = value => typeof value === "string" && STABLE_ID_PATTERN.test(value);
  const utc = value => typeof value === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/.test(value);
  const projects = new Map((contentRecords ?? []).map(record => [record.value.contentId, record.value]));
  const selectedContent = includedScopes.includes("portfolio-content");
  const globalValueIds = new Set();
  const taxonomyKinds = new Map();
  const currentAssignmentsByProject = new Map();
  const assignmentSequences = new Map();
  for (const record of records) {
    const value = record.value;
    require(stable(value.taxonomyId) && Number.isSafeInteger(value.aggregateVersion) && value.aggregateVersion >= 1);
    taxonomyKinds.set(value.taxonomyId, value.kind);
    const valuesById = new Map();
    for (let index = 0; index < value.values.length; index += 1) {
      const item = value.values[index];
      require(stable(item.valueId) && (index === 0 || value.values[index - 1].valueId < item.valueId) &&
        !globalValueIds.has(item.valueId) && Number.isSafeInteger(item.valueVersion) && item.valueVersion >= 1 &&
        ["active", "retired", "merged"].includes(item.state));
      globalValueIds.add(item.valueId);
      valuesById.set(item.valueId, item);
      require((item.state === "merged") === (item.mergedIntoValueId !== undefined));
      if (item.mergedIntoValueId !== undefined) require(stable(item.mergedIntoValueId) && item.mergedIntoValueId !== item.valueId);
    }
    require(value.evolutionHistory.length === value.aggregateVersion - 1);
    const historyByValue = new Map();
    let previousEvent;
    for (const event of value.evolutionHistory) {
      require(stable(event.valueId) && valuesById.has(event.valueId) && Number.isSafeInteger(event.transitionSequence) &&
        event.transitionSequence > 0 &&
        utc(event.changedAt) && ["created", "renamed", "retired", "merged"].includes(event.action) &&
        ["active", "retired", "merged"].includes(event.state));
      if (previousEvent !== undefined) require(previousEvent.valueId < event.valueId ||
        previousEvent.valueId === event.valueId && previousEvent.transitionSequence < event.transitionSequence);
      previousEvent = event;
      const history = historyByValue.get(event.valueId) ?? [];
      history.push(event);
      historyByValue.set(event.valueId, history);
    }
    for (const item of value.values) {
      const history = historyByValue.get(item.valueId) ?? [];
      require(history.length === item.valueVersion && history.length > 0);
      let currentName;
      let currentState;
      history.forEach((event, index) => {
        require(event.transitionSequence === index + 1);
        if (index === 0) {
          require(event.action === "created" && event.previousName === null && event.state === "active");
        } else if (event.action === "renamed") {
          require(currentState === "active" && event.previousName === currentName && event.name !== currentName && event.state === "active");
        } else if (event.action === "retired") {
          require(currentState === "active" && event.previousName === currentName && event.name === currentName && event.state === "retired");
        } else if (event.action === "merged") {
          require((currentState === "active" || currentState === "retired") && event.previousName === currentName &&
            event.name === currentName && event.state === "merged" && stable(event.mergedIntoValueId) &&
            valuesById.has(event.mergedIntoValueId) && event.mergedIntoValueId !== item.valueId);
          require(item.mergedIntoValueId === event.mergedIntoValueId);
        } else require(false);
        currentName = event.name;
        currentState = event.state;
      });
      require(currentName === item.name && currentState === item.state);
    }
    const assignments = new Set();
    let previousAssignment;
    for (const assignment of value.assignments) {
      const key = `${assignment.targetId}|${assignment.taxonomyValueId}`;
      require(stable(assignment.targetId) && stable(assignment.taxonomyValueId) && valuesById.has(assignment.taxonomyValueId) &&
        utc(assignment.assignedAt) && !assignments.has(key));
      if (previousAssignment !== undefined) require(previousAssignment.targetId < assignment.targetId ||
        previousAssignment.targetId === assignment.targetId && previousAssignment.taxonomyValueId < assignment.taxonomyValueId);
      previousAssignment = assignment;
      assignments.add(key);
      if (selectedContent) {
        require(projects.get(assignment.targetId)?.contentType === "project");
        const projectAssignments = currentAssignmentsByProject.get(assignment.targetId) ?? new Set();
        projectAssignments.add(`${value.taxonomyId}|${assignment.taxonomyValueId}`);
        currentAssignmentsByProject.set(assignment.targetId, projectAssignments);
      }
    }
    let previousHistory;
    for (const assignment of value.assignmentHistory) {
      require(stable(assignment.targetId) && stable(assignment.taxonomyValueId) && valuesById.has(assignment.taxonomyValueId) &&
        Number.isSafeInteger(assignment.sequence) && assignment.sequence > 0 && Number.isSafeInteger(assignment.projectVersion) &&
        assignment.projectVersion > 1 && utc(assignment.changedAt));
      if (previousHistory !== undefined) require(previousHistory.targetId < assignment.targetId ||
        previousHistory.targetId === assignment.targetId && previousHistory.sequence < assignment.sequence);
      previousHistory = assignment;
      const history = assignmentSequences.get(assignment.targetId) ?? [];
      history.push(assignment.sequence);
      assignmentSequences.set(assignment.targetId, history);
      if (selectedContent) require(projects.get(assignment.targetId)?.contentType === "project");
    }
  }
  for (const sequences of assignmentSequences.values()) {
    sequences.sort((left, right) => left - right);
    for (let index = 0; index < sequences.length; index += 1) require(sequences[index] === index + 1);
  }
  if (selectedContent) {
    for (const project of projects.values()) {
      if (project.contentType !== "project") continue;
      const projectAssignments = new Set();
      for (const assignment of project.taxonomyAssignments) {
        require(object(assignment) && stable(assignment.taxonomyId) && stable(assignment.valueId) &&
          taxonomyKinds.get(assignment.taxonomyId) === assignment.kind && globalValueIds.has(assignment.valueId));
        const key = `${assignment.taxonomyId}|${assignment.valueId}`;
        require(!projectAssignments.has(key));
        projectAssignments.add(key);
      }
      const taxonomyAssignments = currentAssignmentsByProject.get(project.contentId) ?? new Set();
      require(projectAssignments.size === taxonomyAssignments.size &&
        [...projectAssignments].every(key => taxonomyAssignments.has(key)));

      const assignmentValueIds = new Set([...projectAssignments].map(key => key.slice(key.lastIndexOf("|") + 1)));
      const projectedValueIds = new Set(project.taxonomyValueIds);
      require(project.taxonomyValueIds.length === projectedValueIds.size && assignmentValueIds.size === projectedValueIds.size &&
        [...assignmentValueIds].every(valueId => projectedValueIds.has(valueId)));
    }
  }
}

function verifyManifestSemantics(manifest, version) {
  const scopeList = scopeOrder(manifest.includedScopes);
  if (scopeList.some((scope, index) => manifest.includedScopes[index] !== scope)) fail("PACKAGE_SCOPE_ORDER_INVALID");
  if (!Array.isArray(manifest.entries) || manifest.entries.length !== scopeList.length) fail("PACKAGE_ENTRY_COVERAGE_INVALID");
  const entryScopes = new Set();
  for (let index = 0; index < manifest.entries.length; index += 1) {
    const entry = manifest.entries[index];
    validateEntryDescriptor(entry, version);
    if (entry.scope !== scopeList[index] || entryScopes.has(entry.scope)) fail("PACKAGE_ENTRY_COVERAGE_INVALID");
    entryScopes.add(entry.scope);
  }
  if (manifest.publicEventDataCoverage?.mode !== "excluded") fail("PACKAGE_PUBLIC_EVENT_COVERAGE_INVALID");
  if (version !== "1.0") {
    checkRequiredFeatures(manifest);
    if (!STABLE_ID_PATTERN.test(manifest.exportId) || !object(manifest.snapshot) ||
      !STABLE_ID_PATTERN.test(manifest.snapshot.snapshotId) || manifest.snapshot.consistency !== "transactional") {
      fail("PACKAGE_IDENTITY_INVALID");
    }
    if (!Array.isArray(manifest.dependencies) || !Array.isArray(manifest.exclusions) || !Array.isArray(manifest.assets)) {
      fail("PACKAGE_REQUIRED_SEMANTICS_MISSING");
    }
    if (manifest.exclusions.length !== REQUIRED_EXCLUSIONS.length ||
      REQUIRED_EXCLUSIONS.some((exclusion, index) => manifest.exclusions[index] !== exclusion)) {
      fail("PACKAGE_EXCLUSIONS_INVALID");
    }
  }
  if (!DIGEST_PATTERN.test(manifest.digest) || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/.test(manifest.createdAt)) {
    fail("PACKAGE_MANIFEST_INVALID");
  }
  return scopeList;
}

function verifyAssets(manifest, version, entryMap, recordsByScope) {
  if (version === "1.0") return [];
  const assets = manifest.assets;
  const assetPaths = new Set();
  let previousPath = "";
  for (const descriptor of assets) {
    const mediaBytesPackage = (version === "1.5" || version === "1.6" || version === "1.7") && object(descriptor) && descriptor.scope === "media-metadata";
    const validPath = object(descriptor) && (mediaBytesPackage
      ? descriptor.path === `assets/media-metadata/sha256/${descriptor.digest}`
      : descriptor.path === `assets/${descriptor.scope}/${descriptor.assetId}`);
    if (!object(descriptor) || !["media-metadata", "cv-metadata"].includes(descriptor.scope) ||
      !STABLE_ID_PATTERN.test(descriptor.assetId) || !validPath ||
      mediaBytesPackage && descriptor.variantName !== undefined && (typeof descriptor.variantName !== "string" || !/^[a-z0-9-]{1,32}$/.test(descriptor.variantName)) ||
      !mediaBytesPackage && descriptor.variantName !== undefined ||
      !DIGEST_PATTERN.test(descriptor.digest) || !Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength < 1 ||
      descriptor.byteLength > (mediaBytesPackage ? LIMITS.assetBytes : 25_000_000) || !["application/pdf", "image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm"].includes(descriptor.mediaType)) {
      fail("PACKAGE_ASSET_DESCRIPTOR_INVALID");
    }
    if (descriptor.path <= previousPath || assetPaths.has(descriptor.path)) fail("PACKAGE_ASSET_ORDER_INVALID");
    previousPath = descriptor.path;
    assetPaths.add(descriptor.path);
    const bytes = findEntry(entryMap, descriptor.path, "PACKAGE_ASSET_MISSING");
    if (bytes.length !== descriptor.byteLength || sha256(bytes) !== descriptor.digest) fail("PACKAGE_ASSET_DIGEST_MISMATCH");
  }
  const referencedAssetPaths = new Set();
  for (const [scope, records] of recordsByScope) {
    const visit = (value) => {
      if (typeof value === "string" && value.startsWith("assets/")) {
        const expectedPrefix = `assets/${scope}/`;
        const cvMediaReference = (version === "1.6" || version === "1.7") && scope === "cv-metadata" && value.startsWith("assets/media-metadata/sha256/");
        if (!value.startsWith(expectedPrefix) && !cvMediaReference || !assetPaths.has(value)) fail("PACKAGE_ASSET_REFERENCE_INVALID");
        referencedAssetPaths.add(value);
      } else if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (object(value)) {
        Object.values(value).forEach(visit);
      }
    };
    records.forEach(visit);
  }
  if (referencedAssetPaths.size !== assetPaths.size) fail("PACKAGE_ASSET_REFERENCE_INVALID");
  if (version === "1.5" || version === "1.6" || version === "1.7") {
    const descriptors = new Map(assets.map((descriptor) => [descriptor.path, descriptor]));
    for (const record of recordsByScope.get("media-metadata") ?? []) {
      for (const portable of record.value.portableAssets) {
        const descriptor = descriptors.get(portable.portableReference);
        if (!descriptor || descriptor.digest !== portable.digest || descriptor.byteLength !== portable.byteLength ||
          descriptor.mediaType !== portable.mediaType || !portable.portableReference.endsWith(`/${portable.digest}`)) {
          fail("PACKAGE_ASSET_REFERENCE_INVALID");
        }
      }
    }
  }
  if (version === "1.6" || version === "1.7") {
    const descriptors = new Map(assets.map((descriptor) => [descriptor.path, descriptor]));
    for (const record of recordsByScope.get("cv-metadata") ?? []) {
      for (const versionRecord of record.value.versions) {
        if (versionRecord.state !== "accepted") continue;
        const descriptor = descriptors.get(versionRecord.portableReference);
        if (!descriptor || descriptor.scope !== "media-metadata" || descriptor.mediaType !== "application/pdf" ||
            descriptor.digest !== versionRecord.portableReference.slice("assets/media-metadata/sha256/".length)) fail("PACKAGE_ASSET_REFERENCE_INVALID");
      }
    }
  }
  return assets;
}

function expectedDependencies(recordsByScope) {
  const expected = new Map();
  const add = (sourceScope, sourceId, targetScope, targetId) => {
    if (typeof sourceId !== "string" || !STABLE_ID_PATTERN.test(sourceId) ||
      typeof targetId !== "string" || !STABLE_ID_PATTERN.test(targetId)) {
      fail("PACKAGE_REFERENCE_INVALID");
    }
    const key = [sourceScope, sourceId, targetScope, targetId].join("|");
    expected.set(key, { sourceScope, sourceId, targetScope, targetId });
  };
  const collectMediaAssetIds = (value, sourceScope, sourceId) => {
    if (Array.isArray(value)) {
      value.forEach((item) => collectMediaAssetIds(item, sourceScope, sourceId));
    } else if (object(value)) {
      for (const [key, nested] of Object.entries(value)) {
        if (key === "mediaAssetId") add(sourceScope, sourceId, "media-metadata", nested);
        else collectMediaAssetIds(nested, sourceScope, sourceId);
      }
    }
  };

  for (const [scope, records] of recordsByScope) {
    for (const record of records) {
      const value = record.value;
      if (scope === "portfolio-content") {
        for (const targetId of value.relatedProjectIds) add(scope, value.contentId, scope, targetId);
        for (const targetId of value.taxonomyValueIds) add(scope, value.contentId, "taxonomy", targetId);
        for (const targetId of value.mediaAssetIds) add(scope, value.contentId, "media-metadata", targetId);
        collectMediaAssetIds(value.evidenceItems, scope, value.contentId);
        collectMediaAssetIds(value.revisions, scope, value.contentId);
      } else if (scope === "taxonomy") {
        for (const assignment of value.assignments) {
          if (object(assignment) && assignment.targetId !== undefined) add(scope, value.taxonomyId, "portfolio-content", assignment.targetId);
          if (object(assignment) && assignment.taxonomyValueId !== undefined) add(scope, value.taxonomyId, scope, assignment.taxonomyValueId);
        }
        for (const assignment of value.assignmentHistory ?? []) {
          if (object(assignment) && assignment.targetId !== undefined) add(scope, value.taxonomyId, "portfolio-content", assignment.targetId);
          if (object(assignment) && assignment.taxonomyValueId !== undefined) add(scope, value.taxonomyId, scope, assignment.taxonomyValueId);
        }
        for (const taxonomyValue of value.values) {
          if (object(taxonomyValue)) {
            const targetId = taxonomyValue.mergedIntoValueId ?? taxonomyValue.mergedIntoId;
            if (targetId !== undefined) add(scope, value.taxonomyId, scope, targetId);
          }
        }
        for (const event of value.evolutionHistory ?? []) {
          if (object(event) && event.mergedIntoValueId !== undefined) add(scope, value.taxonomyId, scope, event.mergedIntoValueId);
        }
      } else if (scope === "cv-metadata") {
        for (const version of value.versions) {
          if (object(version)) add(scope, version.versionId, "media-metadata", version.mediaId);
        }
      } else if (scope === "portfolio-configuration") {
        const mediaAssetId = object(value.profile) ? value.profile.mediaAssetId : undefined;
        if (mediaAssetId !== undefined) add(scope, mediaAssetId, "media-metadata", mediaAssetId);
      } else if (scope === "moderation-history") {
        add(scope, value.feedbackId, "portfolio-content", value.projectId);
      } else if (scope === "analytics-reports") {
        const goal = value.goal;
        for (const version of goal.versions) {
          for (const step of version.definition.steps) {
            for (const targetId of step.projectIds ?? []) add(scope, goal.goalId, "portfolio-content", targetId);
            for (const targetId of step.publicRouteIds ?? []) add(scope, goal.goalId, "portfolio-content", targetId);
          }
        }
      }
    }
  }
  return expected;
}

function verifyDependencies(manifest, version, recordsByScope) {
  if (version === "1.0") return [];
  const knownIdsByScope = new Map(SCOPES.map((scope) => [scope, new Set()]));
  for (const [scope, records] of recordsByScope) {
    const ids = knownIdsByScope.get(scope);
    const walk = (value) => {
      if (typeof value === "string" && STABLE_ID_PATTERN.test(value)) ids.add(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (object(value)) Object.values(value).forEach(walk);
    };
    records.forEach(walk);
  }
  const includedScopes = new Set(manifest.includedScopes);
  const seen = new Set();
  const expected = expectedDependencies(recordsByScope);
  let previousDependency;
  for (const dependency of manifest.dependencies) {
    if (!object(dependency) || !SCOPE_SET.has(dependency.sourceScope) || !SCOPE_SET.has(dependency.targetScope) ||
      !STABLE_ID_PATTERN.test(dependency.sourceId) || !STABLE_ID_PATTERN.test(dependency.targetId) ||
      !["included", "omitted"].includes(dependency.disposition)) {
      fail("PACKAGE_DEPENDENCY_INVALID");
    }
    const key = [dependency.sourceScope, dependency.sourceId, dependency.targetScope, dependency.targetId].join("|");
    if (seen.has(key)) fail("PACKAGE_DEPENDENCY_DUPLICATE");
    seen.add(key);
    if (previousDependency !== undefined) {
      const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
      const order = [
        SCOPES.indexOf(previousDependency.sourceScope) - SCOPES.indexOf(dependency.sourceScope),
        compareText(previousDependency.sourceId, dependency.sourceId),
        SCOPES.indexOf(previousDependency.targetScope) - SCOPES.indexOf(dependency.targetScope),
        compareText(previousDependency.targetId, dependency.targetId),
      ];
      const firstDifference = order.find((comparison) => comparison !== 0);
      if (firstDifference !== undefined && firstDifference > 0) fail("PACKAGE_DEPENDENCY_ORDER_INVALID");
      if (firstDifference === undefined) fail("PACKAGE_DEPENDENCY_DUPLICATE");
    }
    previousDependency = dependency;
    if (!includedScopes.has(dependency.sourceScope) || !knownIdsByScope.get(dependency.sourceScope).has(dependency.sourceId)) {
      fail("PACKAGE_DEPENDENCY_SOURCE_INVALID");
    }
    if (dependency.disposition === "included") {
      if (dependency.reason !== undefined || !includedScopes.has(dependency.targetScope) ||
        !knownIdsByScope.get(dependency.targetScope).has(dependency.targetId)) fail("PACKAGE_DEPENDENCY_TARGET_INVALID");
    } else {
      if (typeof dependency.reason !== "string" || includedScopes.has(dependency.targetScope) &&
        knownIdsByScope.get(dependency.targetScope).has(dependency.targetId) ||
        !includedScopes.has(dependency.targetScope) && dependency.reason !== "scope-not-selected" ||
        includedScopes.has(dependency.targetScope) && dependency.reason === "scope-not-selected") {
        fail("PACKAGE_DEPENDENCY_TARGET_INVALID");
      }
    }
  }
  if (seen.size !== expected.size || [...expected.keys()].some((key) => !seen.has(key))) {
    fail("PACKAGE_DEPENDENCY_COVERAGE_INVALID");
  }
  return manifest.dependencies;
}

/**
 * Validate an Owner export ZIP without network, provider adapters, model mutation,
 * filesystem extraction, or exporter state. The ZIP byte digest is returned separately.
 */
export function validateOwnerExportZip(input) {
  const { bytes: archiveBytes, entries } = parseZipArchive(input);
  const entryMap = new Map(entries.map((entry) => [entry.name, entry]));
  if (entryMap.size !== entries.length) fail("ARCHIVE_DUPLICATE_PATH");
  const manifestBytes = findEntry(entryMap, "manifest.json");
  if (manifestBytes.length > LIMITS.manifestBytes) fail("PACKAGE_MANIFEST_SIZE_LIMIT");
  const manifest = parseJsonBytes(manifestBytes);
  if (!object(manifest) || manifest.packageFormat !== "shipwithali-owner-export") fail("PACKAGE_FORMAT_UNSUPPORTED");
  const version = supportedManifestVersion(manifest);
  if (version !== "1.5" && version !== "1.6" && version !== "1.7" && version !== "1.8" && entries.some((entry) => entry.bytes.length > LIMITS.legacyEntryBytes)) fail("ENTRY_SIZE_LIMIT");
  if (version !== "1.0") {
    checkRequiredFeatures(manifest);
    const requiredProperties = ["exportId", "snapshot", "dependencies", "exclusions", "schemas", "assets"];
    if (requiredProperties.some((property) => !Object.hasOwn(manifest, property))) fail("PACKAGE_REQUIRED_SEMANTICS_MISSING");
  }
  const validator = manifestValidators.get(version);
  if (validator === undefined) fail("PACKAGE_SCHEMA_UNSUPPORTED");
  validateSchema(validator, manifest, "PACKAGE_MANIFEST_INVALID");
  if (ownerExportManifestDigest(manifest) !== manifest.digest) fail("MANIFEST_DIGEST_MISMATCH");
  const includedScopes = verifyManifestSemantics(manifest, version);
  if (version === "1.3" && (includedScopes.some(scope => !["portfolio-content", "portfolio-configuration"].includes(scope)) ||
      !includedScopes.includes("portfolio-content"))) fail("PACKAGE_SCOPE_UNSUPPORTED");
  if (version === "1.4" && (includedScopes.some(scope => !["portfolio-content", "taxonomy", "portfolio-configuration"].includes(scope)) ||
      !includedScopes.includes("taxonomy"))) fail("PACKAGE_SCOPE_UNSUPPORTED");
  if (version === "1.7" && (includedScopes.some(scope => !["portfolio-content", "taxonomy", "moderation-history", "portfolio-configuration"].includes(scope)) ||
      !includedScopes.includes("moderation-history"))) fail("PACKAGE_SCOPE_UNSUPPORTED");
  if (version === "1.8" && (includedScopes.length !== 1 || includedScopes[0] !== "analytics-reports")) fail("PACKAGE_SCOPE_UNSUPPORTED");
  if (version === "1.5" && (includedScopes.length !== 1 || includedScopes[0] !== "media-metadata")) fail("PACKAGE_SCOPE_UNSUPPORTED");
  if (version === "1.6" && (!includedScopes.includes("cv-metadata") || includedScopes.some((scope) => !["cv-metadata", "media-metadata"].includes(scope)))) fail("PACKAGE_SCOPE_UNSUPPORTED");
  const descriptors = verifySchemaEntries(manifest, version, entryMap);
  const recordsByScope = new Map();
  const recordCounts = {};
  for (const descriptor of manifest.entries) {
    const validatorForScope = recordSchemasForVersion(version).get(descriptor.scope).validate;
    const records = recordsFromEntry(findEntry(entryMap, descriptor.path), descriptor, validatorForScope);
    verifyRecordOrdering(descriptor.scope, records, version);
    if (version === "1.8" && descriptor.scope === "analytics-reports") {
      verifyAnalyticsRetention(manifest, records);
    }
    recordsByScope.set(descriptor.scope, records);
    recordCounts[descriptor.scope] = records.length;
  }
  if (version === "1.3" || (version === "1.4" || version === "1.7") && includedScopes.includes("portfolio-content")) {
    verifyContentSnapshotFacts(recordsByScope.get("portfolio-content"));
  }
  if (version === "1.4" || version === "1.7" && includedScopes.includes("taxonomy")) verifyTaxonomySnapshotFacts(
    recordsByScope.get("taxonomy"), recordsByScope.get("portfolio-content"), includedScopes,
  );
  if (version === "1.6") verifyCvSnapshotFacts(recordsByScope.get("cv-metadata"));
  if (version === "1.7") verifyModerationRetention(recordsByScope.get("moderation-history"), manifest.snapshot.capturedAt);
  const assets = verifyAssets(manifest, version, entryMap, recordsByScope);
  const dependencies = verifyDependencies(manifest, version, recordsByScope);

  const declaredPaths = new Set(["manifest.json", ...descriptors.map((item) => item.path), ...manifest.entries.map((item) => item.schemaPath), ...manifest.entries.map((item) => item.path), ...assets.map((item) => item.path)]);
  const expectedArchiveOrder = ["manifest.json", ...descriptors.map((item) => item.path), ...manifest.entries.map((item) => item.path), ...assets.map((item) => item.path)];
  for (const name of entryMap.keys()) if (!declaredPaths.has(name)) fail("ARCHIVE_UNDECLARED_ENTRY");
  for (const name of declaredPaths) if (!entryMap.has(name)) fail("ARCHIVE_ENTRY_MISSING");
  if (entries.length !== declaredPaths.size) fail("ARCHIVE_DUPLICATE_PATH");
  if (entries.some((entry, index) => entry.name !== expectedArchiveOrder[index])) fail("ARCHIVE_ENTRY_ORDER_INVALID");

  return {
    manifest,
    includedScopes,
    recordCounts,
    verifiedSchemaCount: descriptors.length,
    verifiedAssetCount: assets.length,
    dependencyCount: dependencies.length,
    archiveDigest: sha256(archiveBytes),
  };
}
