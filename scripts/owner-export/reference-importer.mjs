import { createHash, randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { validateOwnerExportZip } from "./validator.mjs";
import { buildOwnerExportReferenceModel } from "./reference-model.mjs";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const originalCauses = new WeakMap();

function codedError(code, stage, cause, details = {}) {
  const error = new Error(code, cause === undefined ? undefined : { cause: new Error("REFERENCE_IMPORT_CAUSE_REDACTED") });
  error.name = "ReferenceImportError";
  error.code = code;
  error.stage = stage;
  Object.assign(error, details);
  if (cause !== undefined) originalCauses.set(error, cause);
  return error;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function findEndRecord(view) {
  const earliest = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= earliest; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error("REFERENCE_IMPORT_ZIP_END_RECORD_INVALID");
}

// This parser deliberately does not use the producer or the offline validator's
// ZIP reader. It consumes bounded central-directory entries directly and never
// maps package paths onto local files or remote URLs.
function independentlyReadZip(archive) {
  if (!(archive instanceof Uint8Array) || archive.byteLength < 22 || archive.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error("REFERENCE_IMPORT_ARCHIVE_SIZE_INVALID");
  }
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = findEndRecord(view);
  const disk = view.getUint16(end + 4, true);
  const centralDisk = view.getUint16(end + 6, true);
  const diskCount = view.getUint16(end + 8, true);
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  const commentLength = view.getUint16(end + 20, true);
  if (disk !== 0 || centralDisk !== 0 || diskCount !== count || count > 512 || end + 22 + commentLength !== archive.byteLength ||
      centralOffset + centralSize !== end || count === 0) throw new Error("REFERENCE_IMPORT_ZIP_DIRECTORY_INVALID");

  const files = new Map();
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) throw new Error("REFERENCE_IMPORT_ZIP_MEMBER_INVALID");
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const checksum = view.getUint32(cursor + 16, true);
    const compressedLength = view.getUint32(cursor + 20, true);
    const expandedLength = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const memberCommentLength = view.getUint16(cursor + 32, true);
    const memberDisk = view.getUint16(cursor + 34, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    const next = nameStart + nameLength + extraLength + memberCommentLength;
    if (next > end || memberDisk !== 0 || (flags & 0x0009) !== 0 || (flags & ~0x0800) !== 0 ||
        ![0, 8].includes(method) || expandedLength > MAX_ENTRY_BYTES || compressedLength > MAX_ENTRY_BYTES || nameLength === 0 ||
        extraLength !== 0 || memberCommentLength !== 0) throw new Error("REFERENCE_IMPORT_ZIP_MEMBER_LIMIT_OR_FEATURE");
    const name = UTF8.decode(archive.subarray(nameStart, nameStart + nameLength));
    if (name.includes("\\") || name.startsWith("/") || name.split("/").some((part) => part === ".." || part === ".") || files.has(name)) {
      throw new Error("REFERENCE_IMPORT_ZIP_PATH_INVALID");
    }
    if (localOffset + 30 > centralOffset || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error("REFERENCE_IMPORT_ZIP_LOCAL_HEADER_INVALID");
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localNameStart = localOffset + 30;
    const bodyStart = localNameStart + localNameLength + localExtraLength;
    const bodyEnd = bodyStart + compressedLength;
    if (bodyEnd > centralOffset || localFlags !== flags || localMethod !== method || localExtraLength !== 0 ||
        UTF8.decode(archive.subarray(localNameStart, localNameStart + localNameLength)) !== name) {
      throw new Error("REFERENCE_IMPORT_ZIP_LOCAL_DIRECTORY_MISMATCH");
    }
    const compressed = archive.subarray(bodyStart, bodyEnd);
    const expanded = method === 0 ? new Uint8Array(compressed) : new Uint8Array(inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES }));
    if (expanded.byteLength !== expandedLength || crc32(expanded) !== checksum) throw new Error("REFERENCE_IMPORT_ZIP_CONTENT_INTEGRITY_INVALID");
    files.set(name, expanded);
    cursor = next;
  }
  if (cursor !== end) throw new Error("REFERENCE_IMPORT_ZIP_DIRECTORY_LENGTH_INVALID");
  return files;
}

function recordIdentity(scope, value) {
  const idProperty = {
    "portfolio-content": "contentId",
    taxonomy: "taxonomyId",
    "media-metadata": "mediaId",
    "moderation-history": "feedbackId",
    "analytics-reports": "goalId",
  }[scope];
  if (idProperty === undefined) return "aggregate";
  const identity = scope === "analytics-reports" ? value?.goal?.goalId : value?.[idProperty];
  if (typeof identity !== "string" || identity.length === 0) throw new Error("REFERENCE_IMPORT_RECORD_IDENTITY_MISSING");
  return identity;
}

function parseRecords(files, manifest) {
  const records = [];
  const identities = new Set();
  for (const entry of manifest.entries) {
    const bytes = files.get(entry.path);
    if (bytes === undefined) throw new Error("REFERENCE_IMPORT_RECORD_ENTRY_MISSING");
    const text = UTF8.decode(bytes);
    const rawRecords = entry.mediaType === "application/json"
      ? (() => { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : [parsed]; })()
      : text.endsWith("\n") && text.length > 0 ? text.slice(0, -1).split("\n").map((line) => JSON.parse(line)) : [];
    if (rawRecords.length !== entry.recordCount) throw new Error("REFERENCE_IMPORT_RECORD_COUNT_MISMATCH");
    for (const raw of rawRecords) {
      const wrapped = raw !== null && typeof raw === "object" && !Array.isArray(raw) && raw.scope === entry.scope && Object.hasOwn(raw, "value");
      const value = wrapped ? raw.value : raw;
      const identity = recordIdentity(entry.scope, value);
      const identityKey = `${entry.scope}:${identity}`;
      if (identities.has(identityKey)) throw new Error("REFERENCE_IMPORT_DUPLICATE_RECORD_IDENTITY");
      identities.add(identityKey);
      records.push({ scope: entry.scope, identity, schemaVersion: entry.schemaVersion, value });
    }
  }
  return records;
}

function validNamespace(namespace) {
  if (typeof namespace !== "string" || !/^ref_[a-f0-9]{16}$/u.test(namespace)) throw new TypeError("REFERENCE_IMPORT_NAMESPACE_INVALID");
  return namespace;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

/**
 * Validate and independently decode a published Owner export before writing
 * any reconstructed record or object. `database` is an isolated PostgreSQL
 * client and `objectSink` is a caller-owned private object namespace.
 */
export async function importOwnerExportReference({ archive, database, objectSink, namespace }) {
  const safeNamespace = validNamespace(namespace);
  if (!database || typeof database.query !== "function" || !objectSink ||
      typeof objectSink.put !== "function" || typeof objectSink.removeObjects !== "function") {
    throw new TypeError("REFERENCE_IMPORT_TARGET_INVALID");
  }

  const validation = validateOwnerExportZip(archive);
  const files = independentlyReadZip(archive);
  const manifestBytes = files.get("manifest.json");
  if (manifestBytes === undefined) throw new Error("REFERENCE_IMPORT_MANIFEST_MISSING");
  const manifest = JSON.parse(UTF8.decode(manifestBytes));
  if (manifest.digest !== validation.manifest.digest || JSON.stringify(manifest.includedScopes) !== JSON.stringify(validation.includedScopes)) {
    throw new Error("REFERENCE_IMPORT_VALIDATOR_DISAGREEMENT");
  }
  const records = parseRecords(files, manifest);
  const assets = (manifest.assets ?? []).map((descriptor) => {
    const bytes = files.get(descriptor.path);
    if (bytes === undefined || bytes.byteLength !== descriptor.byteLength ||
        createHash("sha256").update(bytes).digest("hex") !== descriptor.digest) throw new Error("REFERENCE_IMPORT_ASSET_INTEGRITY_INVALID");
    if (/^(?:[a-z]+:|\/|\\)/iu.test(descriptor.path) || descriptor.path.split("/").some((part) => part === ".." || part === ".")) {
      throw new Error("REFERENCE_IMPORT_ASSET_REFERENCE_INVALID");
    }
    return { path: descriptor.path, digest: descriptor.digest, mediaType: descriptor.mediaType, bytes };
  });
  const model = buildOwnerExportReferenceModel({ records, manifest, assets });
  const dbSchema = quoteIdentifier(safeNamespace);
  const ownerToken = randomUUID();
  const importId = randomUUID();
  const ownedPaths = [];
  let transactionOpen = false;
  let reserved = false;
  let stage = "reserve";

  // Schema creation is an autocommit reservation. A collision means this
  // invocation owns nothing and therefore must not touch Storage.
  try {
    await database.query(`create schema ${dbSchema}`);
    reserved = true;
  } catch (error) {
    if (error?.code === "42P06") {
      throw codedError("REFERENCE_IMPORT_NAMESPACE_IN_USE", "reserve", undefined, { namespace: safeNamespace });
    }
    throw codedError("REFERENCE_IMPORT_RESERVATION_FAILED", "reserve", error, { namespace: safeNamespace });
  }

  try {
    await database.query(`create table ${dbSchema}.reference_owner (owner_token uuid primary key, created_at timestamptz not null default transaction_timestamp())`);
    await database.query(`insert into ${dbSchema}.reference_owner(owner_token) values ($1::uuid)`, [ownerToken]);
    await database.query(`create table ${dbSchema}.owned_objects (path text primary key, source_path text not null, sha256 text not null)`);
    // Persist each unique-path ownership intent before external I/O. The object
    // sink stamps the owner token into immutable object metadata; cleanup checks
    // that marker before deleting, so an ambiguous upload response is recoverable
    // without claiming a pre-existing collision. Object I/O stays outside every
    // PostgreSQL transaction and uploads remain no-upsert.
    stage = "source-object-copy";
    for (const asset of assets) {
      const objectPath = `imports/${importId}/${asset.path}`;
      await database.query(`insert into ${dbSchema}.owned_objects(path, source_path, sha256) values ($1,$2,$3)`,
        [objectPath, asset.path, asset.digest]);
      ownedPaths.push(objectPath);
      await objectSink.put({ namespace: safeNamespace, path: objectPath, bytes: asset.bytes,
        sourcePath: asset.path, mediaType: asset.mediaType, digest: asset.digest, ownerToken });
    }

    stage = "reference-write";
    await database.query("begin");
    transactionOpen = true;
    await database.query(`create table ${dbSchema}.package_manifest (value jsonb not null)`);
    await database.query(`create table ${dbSchema}.records (scope text not null, identity text not null, value jsonb not null, primary key(scope, identity))`);
    await database.query(`create table ${dbSchema}.assets (path text primary key, source_path text not null, sha256 text not null, media_type text not null, byte_length integer not null)`);
    await database.query(`create table ${dbSchema}.dependencies (ordinal integer primary key, value jsonb not null)`);
    await database.query(`create table ${dbSchema}.reference_model (kind text not null, identity text not null, value jsonb not null, primary key(kind, identity))`);
    await database.query(`create table ${dbSchema}.external_dependencies (ordinal integer primary key, value jsonb not null)`);
    await database.query(`insert into ${dbSchema}.package_manifest(value) values ($1::jsonb)`, [JSON.stringify(manifest)]);
    for (const record of records) {
      await database.query(`insert into ${dbSchema}.records(scope, identity, value) values ($1,$2,$3::jsonb)`,
        [record.scope, record.identity, JSON.stringify(record.value)]);
    }
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index];
      await database.query(`insert into ${dbSchema}.assets(path, source_path, sha256, media_type, byte_length) values ($1,$2,$3,$4,$5)`,
        [ownedPaths[index], asset.path, asset.digest, asset.mediaType, asset.bytes.byteLength]);
    }
    for (const [ordinal, dependency] of (manifest.dependencies ?? []).entries()) {
      await database.query(`insert into ${dbSchema}.dependencies(ordinal, value) values ($1,$2::jsonb)`, [ordinal, JSON.stringify(dependency)]);
    }
    for (const projection of model.projections) {
      await database.query(`insert into ${dbSchema}.reference_model(kind, identity, value) values ($1,$2,$3::jsonb)`,
        [projection.kind, projection.identity, JSON.stringify(projection.value)]);
    }
    for (const [ordinal, dependency] of model.externalDependencies.entries()) {
      await database.query(`insert into ${dbSchema}.external_dependencies(ordinal, value) values ($1,$2::jsonb)`,
        [ordinal, JSON.stringify(dependency)]);
    }
    await database.query("commit");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try { await database.query("rollback"); } catch { /* cleanup below determines the surfaced result */ }
    }
    const cleanupErrors = [];
    try { if (ownedPaths.length > 0) await objectSink.removeObjects(safeNamespace, [...ownedPaths], ownerToken); }
    catch (cleanupError) { cleanupErrors.push(cleanupError); }
    if (cleanupErrors.length === 0 && reserved) {
      try { await database.query(`drop schema ${dbSchema} cascade`); reserved = false; }
      catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length > 0) {
      throw codedError("REFERENCE_IMPORT_CLEANUP_FAILED", "cleanup", error, {
        namespace: safeNamespace, ownerToken, cleanupFailureCount: cleanupErrors.length,
      });
    }
    throw codedError("REFERENCE_IMPORT_FAILED", stage, error, { namespace: safeNamespace });
  }

  const recordCounts = Object.fromEntries(manifest.entries.map((entry) => [entry.scope, entry.recordCount]));
  return {
    schemaName: safeNamespace,
    includedScopes: [...manifest.includedScopes],
    recordCounts,
    totalRecords: records.length,
    assetCount: assets.length,
    assetBytes: assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0),
    dependencyCount: (manifest.dependencies ?? []).length,
    projectionCount: model.projections.length,
    externalDependencyCount: model.externalDependencies.length,
    manifestDigest: manifest.digest,
    ownerToken,
  };
}

export async function cleanupOwnerExportReference({ database, objectSink, namespace, ownerToken }) {
  const safeNamespace = validNamespace(namespace);
  if (!database || typeof database.query !== "function" || !objectSink || typeof objectSink.removeObjects !== "function" ||
      typeof ownerToken !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(ownerToken)) {
    throw codedError("REFERENCE_IMPORT_CLEANUP_OWNERSHIP_INVALID", "cleanup");
  }
  const dbSchema = quoteIdentifier(safeNamespace);
  try {
    const exists = await database.query("select to_regclass($1)::text as relation", [`${safeNamespace}.reference_owner`]);
    if (exists.rows?.[0]?.relation == null) return { alreadyClean: true, removedObjectCount: 0 };
    const owner = await database.query(`select owner_token::text as owner_token from ${dbSchema}.reference_owner limit 1`);
    if (owner.rows?.[0]?.owner_token !== ownerToken) throw codedError("REFERENCE_IMPORT_CLEANUP_OWNERSHIP_INVALID", "cleanup");
    const objects = await database.query(`select path from ${dbSchema}.owned_objects order by path`);
    const paths = objects.rows.map((row) => row.path).filter((path) => typeof path === "string");
    if (paths.length > 0) await objectSink.removeObjects(safeNamespace, paths, ownerToken);
    await database.query(`drop schema ${dbSchema} cascade`);
    return { alreadyClean: false, removedObjectCount: paths.length };
  } catch (error) {
    if (error?.code === "REFERENCE_IMPORT_CLEANUP_OWNERSHIP_INVALID") throw error;
    throw codedError("REFERENCE_IMPORT_CLEANUP_FAILED", "cleanup", error, { namespace: safeNamespace, ownerToken });
  }
}

export const independentlyReadOwnerExportZip = independentlyReadZip;
