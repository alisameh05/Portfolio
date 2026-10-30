import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const RELATIONAL_BACKUP_ALGORITHM = "AES-256-GCM" as const;
export const RELATIONAL_BACKUP_ENVELOPE_VERSION = 1 as const;
export const RELATIONAL_BACKUP_MAX_ATTEMPTS = 3;

export type RelationalBackupCatalog = Readonly<{
  version: 1;
  scope: readonly string[];
  sourceWatermarkAt: string;
  startedAt: string;
  completedAt: string;
  dumpTool: string;
  dumpToolVersion: string;
  schemaCount: number;
  relationCount: number;
  migrationCount: number;
  dumpBytes: number;
  complete: true;
  managedMetadata: Readonly<{
    auth: "database-dump; reset custom credentials from protected secrets after restore";
    storage: "database metadata only; object bytes are backed up separately";
  }>;
}>;

export type RelationalBackupAttempt = Readonly<{
  copyId: string;
  destinationName: string;
  objectKey: string;
  keyVersion: string;
  dumpTool: string;
  sourceWatermarkAt: string;
  dumpBytes: number;
  ciphertextBytes: number;
  catalogSha256: string;
  ciphertextSha256: string;
  attemptedAt: string;
  verifiedAt: string | null;
  committedAt: string | null;
  retentionLifetimeHours: number | null;
  expiresAt: string | null;
  state: "uploading" | "usable" | "failed";
  failureCode: string | null;
}>;

export interface RelationalBackupSourcePort {
  capture(signal?: AbortSignal): Promise<Readonly<{ dump: Uint8Array; catalog: RelationalBackupCatalog }>>;
}
export interface RelationalBackupDestinationPort {
  readonly name: string;
  put(objectKey: string, ciphertext: Uint8Array, signal?: AbortSignal): Promise<void>;
  get(objectKey: string, signal?: AbortSignal): Promise<Uint8Array>;
  delete(objectKey: string, signal?: AbortSignal): Promise<void>;
}
export interface RelationalBackupCatalogPort {
  begin(attempt: RelationalBackupAttempt): Promise<void>;
  markUsable(copyId: string, verifiedAt: string, committedAt: string): Promise<void>;
  markFailed(copyId: string, failureCode: string): Promise<void>;
  currentUsable(destinationName: string): Promise<RelationalBackupAttempt | null>;
}
export interface RelationalBackupIncidentPort {
  recordFailure(code: string, at: string): Promise<void>;
}
export type RelationalBackupKey = Readonly<{ keyVersion: string; bytes: Uint8Array }>;
export type RelationalBackupPayload = Readonly<{
  database: Uint8Array;
  roles: Uint8Array;
  migrations: readonly Readonly<{ file: string; sha256: string; sql: Uint8Array }>[];
}>;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const record = value as Record<string, unknown>;
  return "{" + Object.keys(record).sort().map(key =>
    JSON.stringify(key) + ":" + canonicalJson(record[key])).join(",") + "}";
}
function equalDigest(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function encryptRelationalBackupEnvelope(
  dump: Uint8Array,
  catalog: RelationalBackupCatalog,
  key: RelationalBackupKey,
): Uint8Array {
  if (key.bytes.byteLength !== 32) throw new TypeError("BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/u.test(key.keyVersion)) throw new TypeError("Backup key version is invalid.");
  const nonce = randomBytes(12);
  const catalogBytes = Buffer.from(canonicalJson(catalog), "utf8");
  const payloadPrefix = Buffer.alloc(4);
  payloadPrefix.writeUInt32BE(catalogBytes.byteLength);
  const plaintext = Buffer.concat([payloadPrefix, catalogBytes, Buffer.from(dump)]);
  const header = Buffer.from(JSON.stringify({
    version: RELATIONAL_BACKUP_ENVELOPE_VERSION,
    algorithm: RELATIONAL_BACKUP_ALGORITHM,
    keyVersion: key.keyVersion,
    nonce: nonce.toString("base64"),
    catalogSha256: sha256(catalogBytes),
    plaintextSha256: sha256(plaintext),
    plaintextBytes: plaintext.byteLength,
  }), "utf8");
  const cipher = createCipheriv("aes-256-gcm", key.bytes, nonce);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const prefix = Buffer.alloc(9);
  prefix.write("SWAB", 0, "ascii");
  prefix[4] = RELATIONAL_BACKUP_ENVELOPE_VERSION;
  prefix.writeUInt32BE(header.byteLength, 5);
  return Buffer.concat([prefix, header, ciphertext, tag]);
}

export function decryptRelationalBackupEnvelope(envelope: Uint8Array, key: RelationalBackupKey): Readonly<{
  dump: Uint8Array;
  catalog: RelationalBackupCatalog;
  ciphertextSha256: string;
}> {
  const bytes = Buffer.from(envelope);
  if (bytes.byteLength < 9 + 2 + 16 || bytes.subarray(0, 4).toString("ascii") !== "SWAB" ||
      bytes[4] !== RELATIONAL_BACKUP_ENVELOPE_VERSION) {
    throw new TypeError("Backup envelope is malformed or unsupported.");
  }
  const headerLength = bytes.readUInt32BE(5);
  if (headerLength < 2 || headerLength > 1_048_576 || 9 + headerLength + 16 > bytes.byteLength) {
    throw new TypeError("Backup envelope is malformed or unsupported.");
  }
  const headerBytes = bytes.subarray(9, 9 + headerLength);
  let header: Record<string, unknown>;
  try { header = JSON.parse(headerBytes.toString("utf8")) as Record<string, unknown>; }
  catch { throw new TypeError("Backup envelope is malformed or unsupported."); }
  if (header['version'] !== RELATIONAL_BACKUP_ENVELOPE_VERSION || header['algorithm'] !== RELATIONAL_BACKUP_ALGORITHM ||
      header['keyVersion'] !== key.keyVersion || key.bytes.byteLength !== 32 || typeof header['nonce'] !== "string") {
    throw new TypeError("Backup envelope version or key is incompatible.");
  }
  const nonce = Buffer.from(header['nonce'], "base64");
  if (nonce.byteLength !== 12 || typeof header['catalogSha256'] !== "string" ||
      typeof header['plaintextSha256'] !== "string" || typeof header['plaintextBytes'] !== "number") {
    throw new TypeError("Backup envelope is malformed or unsupported.");
  }
  const tagOffset = bytes.byteLength - 16;
  const ciphertext = bytes.subarray(9 + headerLength, tagOffset);
  const decipher = createDecipheriv("aes-256-gcm", key.bytes, nonce);
  decipher.setAAD(headerBytes);
  decipher.setAuthTag(bytes.subarray(tagOffset));
  let plaintext: Buffer;
  try { plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]); }
  catch { throw new TypeError("Backup ciphertext authentication failed."); }
  if (!equalDigest(sha256(plaintext), header['plaintextSha256']) || plaintext.byteLength !== header['plaintextBytes'] ||
      plaintext.byteLength < 4) {
    throw new TypeError("Backup plaintext integrity check failed.");
  }
  const catalogLength = plaintext.readUInt32BE(0);
  if (catalogLength < 2 || catalogLength > plaintext.byteLength - 4) {
    throw new TypeError("Backup catalog is malformed.");
  }
  const catalogBytes = plaintext.subarray(4, 4 + catalogLength);
  if (!equalDigest(sha256(catalogBytes), header['catalogSha256'])) throw new TypeError("Backup catalog integrity check failed.");
  let catalog: RelationalBackupCatalog;
  try { catalog = JSON.parse(catalogBytes.toString("utf8")) as RelationalBackupCatalog; }
  catch { throw new TypeError("Backup catalog is malformed."); }
  const dump = plaintext.subarray(4 + catalogLength);
  if (dump.byteLength !== catalog.dumpBytes) throw new TypeError("Backup dump length does not match catalog.");
  return Object.freeze({ dump, catalog: Object.freeze(catalog), ciphertextSha256: sha256(ciphertext) });
}

/** Decode the versioned SWDB payload emitted by the backup capture command. */
export function decodeRelationalBackupPayload(dump: Uint8Array): RelationalBackupPayload {
  const bytes = Buffer.from(dump);
  if (bytes.byteLength < 8 || bytes.subarray(0, 4).toString("ascii") !== "SWDB") {
    throw new TypeError("Backup payload is malformed or unsupported.");
  }
  const manifestLength = bytes.readUInt32BE(4);
  if (manifestLength < 2 || manifestLength > bytes.byteLength - 8) {
    throw new TypeError("Backup payload manifest is malformed.");
  }
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(bytes.subarray(8, 8 + manifestLength).toString("utf8")) as Record<string, unknown>; }
  catch { throw new TypeError("Backup payload manifest is malformed."); }
  const rolesLength = manifest['rolesBytes'];
  const databaseLength = manifest['databaseBytes'];
  if (manifest['format'] !== "SWDB" || manifest['version'] !== 1 ||
      !Number.isSafeInteger(rolesLength) || (rolesLength as number) < 0 ||
      !Number.isSafeInteger(databaseLength) || (databaseLength as number) < 1 ||
      typeof manifest['rolesSha256'] !== "string" || !/^[0-9a-f]{64}$/u.test(manifest['rolesSha256']) ||
      typeof manifest['databaseSha256'] !== "string" || !/^[0-9a-f]{64}$/u.test(manifest['databaseSha256']) ||
      !Array.isArray(manifest['migrationSources'])) {
    throw new TypeError("Backup payload manifest is incompatible.");
  }
  const dataStart = 8 + manifestLength;
  const rolesEnd = dataStart + (rolesLength as number);
  const databaseEnd = rolesEnd + (databaseLength as number);
  if (!Number.isSafeInteger(databaseEnd) || databaseEnd > bytes.byteLength) {
    throw new TypeError("Backup payload lengths are invalid.");
  }
  const roles = bytes.subarray(dataStart, rolesEnd);
  const database = bytes.subarray(rolesEnd, databaseEnd);
  if (!equalDigest(sha256(roles), manifest['rolesSha256']) || !equalDigest(sha256(database), manifest['databaseSha256'])) {
    throw new TypeError("Backup archive component integrity check failed.");
  }
  const migrations: Array<{ file: string; sha256: string; sql: Uint8Array }> = [];
  const seen = new Set<string>();
  for (const entry of manifest['migrationSources']) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TypeError("Backup migration manifest is malformed.");
    }
    const migration = entry as Record<string, unknown>;
    if (typeof migration['file'] !== "string" || !/^[0-9]{14}_[a-z0-9_]+\.sql$/u.test(migration['file']) ||
        seen.has(migration['file']) || typeof migration['sha256'] !== "string" || !/^[0-9a-f]{64}$/u.test(migration['sha256']) ||
        typeof migration['sql'] !== "string") {
      throw new TypeError("Backup migration manifest is malformed.");
    }
    const sql = Buffer.from(migration['sql'], "utf8");
    if (!equalDigest(sha256(sql), migration['sha256'])) throw new TypeError("Backup migration integrity check failed.");
    seen.add(migration['file']);
    migrations.push(Object.freeze({ file: migration['file'], sha256: migration['sha256'], sql }));
  }
  if (databaseEnd !== bytes.byteLength || manifest['migrationHashes'] === null ||
      typeof manifest['migrationHashes'] !== "object" || Array.isArray(manifest['migrationHashes'])) {
    throw new TypeError("Backup payload has trailing bytes or an invalid migration catalog.");
  }
  const hashes = manifest['migrationHashes'] as Record<string, unknown>;
  if (seen.size !== Object.keys(hashes).length || migrations.some(item => hashes[item.file] !== item.sha256)) {
    throw new TypeError("Backup migration catalog does not match its payload.");
  }
  return Object.freeze({ database, roles, migrations: Object.freeze(migrations) });
}

export function createRelationalBackupService(deps: {
  source: RelationalBackupSourcePort;
  destination: RelationalBackupDestinationPort;
  catalog: RelationalBackupCatalogPort;
  incidents: RelationalBackupIncidentPort;
  key: RelationalBackupKey;
  ids: { next(): string };
  clock: { now(): string };
  retentionLifetimeHours: number | null;
}) {
  if (deps.retentionLifetimeHours !== null &&
      (!Number.isSafeInteger(deps.retentionLifetimeHours) || deps.retentionLifetimeHours < 24 || deps.retentionLifetimeHours > 8760)) {
    throw new TypeError("Relational backup retention must be between 24 and 8760 hours.");
  }
  if (!/^[a-z][a-z0-9-]{2,47}$/u.test(deps.destination.name)) throw new TypeError("Relational backup destination name is invalid.");
  return {
    async create(signal?: AbortSignal): Promise<RelationalBackupAttempt & { catalog: RelationalBackupCatalog }> {
      const attemptedAt = deps.clock.now();
      let copyId: string | null = null;
      let objectKey: string | null = null;
      try {
        const captured = await deps.source.capture(signal);
        if (signal?.aborted) throw Object.assign(new Error(), { safeCode: "BACKUP_CANCELLED" });
        const watermarkAt = Date.parse(captured.catalog.sourceWatermarkAt);
        const startedAt = Date.parse(captured.catalog.startedAt);
        const completedAt = Date.parse(captured.catalog.completedAt);
        if (!captured.catalog.complete || captured.catalog.version !== RELATIONAL_BACKUP_ENVELOPE_VERSION ||
            captured.catalog.dumpBytes !== captured.dump.byteLength || !Number.isFinite(watermarkAt) ||
            !Number.isFinite(startedAt) || !Number.isFinite(completedAt) || startedAt > completedAt || watermarkAt > completedAt ||
            captured.catalog.scope.length === 0 || new Set(captured.catalog.scope).size !== captured.catalog.scope.length ||
            !Number.isSafeInteger(captured.catalog.schemaCount) || captured.catalog.schemaCount < 0 ||
            !Number.isSafeInteger(captured.catalog.relationCount) || captured.catalog.relationCount < 0 ||
            !Number.isSafeInteger(captured.catalog.migrationCount) || captured.catalog.migrationCount < 0 ||
            !Number.isSafeInteger(captured.catalog.dumpBytes) || captured.catalog.dumpBytes < 1) {
          throw Object.assign(new Error(), { safeCode: "BACKUP_SOURCE_INCOMPLETE" });
        }
        const envelope = encryptRelationalBackupEnvelope(captured.dump, captured.catalog, deps.key);
        copyId = deps.ids.next();
        objectKey = "relational/" + copyId + ".swab";
        const now = deps.clock.now();
        const expiresAt = deps.retentionLifetimeHours === null ? null :
          new Date(Date.parse(now) + deps.retentionLifetimeHours * 3_600_000).toISOString();
        const ciphertextSha256 = sha256(envelope);
        const initial: RelationalBackupAttempt = Object.freeze({
          copyId, destinationName: deps.destination.name, objectKey, keyVersion: deps.key.keyVersion,
          dumpTool: captured.catalog.dumpTool, sourceWatermarkAt: captured.catalog.sourceWatermarkAt,
          dumpBytes: captured.dump.byteLength, ciphertextBytes: envelope.byteLength,
          catalogSha256: sha256(Buffer.from(canonicalJson(captured.catalog), "utf8")), ciphertextSha256,
          attemptedAt, verifiedAt: null, committedAt: null, retentionLifetimeHours: deps.retentionLifetimeHours,
          expiresAt, state: "uploading", failureCode: null,
        });
        await deps.catalog.begin(initial);
        await boundedRetry(() => deps.destination.put(objectKey!, envelope, signal));
        const readBack = await deps.destination.get(objectKey, signal);
        let verified: ReturnType<typeof decryptRelationalBackupEnvelope>;
        try { verified = decryptRelationalBackupEnvelope(readBack, deps.key); }
        catch { throw Object.assign(new Error(), { safeCode: "BACKUP_AUTHENTICATION_FAILED" }); }
        if (!equalDigest(sha256(Buffer.from(readBack)), ciphertextSha256) ||
            !equalDigest(sha256(verified.dump), sha256(captured.dump)) ||
            !equalDigest(sha256(Buffer.from(canonicalJson(verified.catalog))), initial.catalogSha256)) {
          throw Object.assign(new Error(), { safeCode: "BACKUP_READBACK_MISMATCH" });
        }
        const verifiedAt = deps.clock.now();
        const committedAt = deps.clock.now();
        await deps.catalog.markUsable(copyId, verifiedAt, committedAt);
        return Object.freeze({ ...initial, state: "usable", verifiedAt, committedAt, catalog: captured.catalog });
      } catch (error) {
        const proposedCode = typeof error === "object" && error !== null && "safeCode" in error &&
          typeof (error as { safeCode?: unknown }).safeCode === "string"
          ? (error as { safeCode: string }).safeCode : "BACKUP_ATTEMPT_FAILED";
        const safeCode = /^[A-Z][A-Z0-9_]{0,63}$/u.test(proposedCode) ? proposedCode : "BACKUP_ATTEMPT_FAILED";
        let cleanupFailed = false;
        if (copyId) {
          try { await deps.catalog.markFailed(copyId, safeCode); } catch { cleanupFailed = true; }
          if (objectKey) {
            // Cleanup must remain possible after a cancelled upload/read signal.
            try { await deps.destination.delete(objectKey); } catch { cleanupFailed = true; }
          }
        }
        const incidentCode = cleanupFailed ? "BACKUP_CLEANUP_FAILED" : safeCode;
        let reportingFailed = false;
        try { await deps.incidents.recordFailure(incidentCode, deps.clock.now()); } catch { reportingFailed = true; }
        throw new RelationalBackupError(cleanupFailed ? "BACKUP_CLEANUP_FAILED" :
          reportingFailed ? "BACKUP_INCIDENT_WRITE_FAILED" : safeCode);
      }
    },
    async verify(copy: RelationalBackupAttempt, key: RelationalBackupKey, signal?: AbortSignal): Promise<RelationalBackupCatalog> {
      const envelope = await deps.destination.get(copy.objectKey, signal);
      if (envelope.byteLength !== copy.ciphertextBytes || !equalDigest(sha256(envelope), copy.ciphertextSha256)) {
        throw new RelationalBackupError("BACKUP_CIPHERTEXT_MISMATCH");
      }
      try {
        const verified = decryptRelationalBackupEnvelope(envelope, key);
        if (verified.catalog.dumpBytes !== copy.dumpBytes || verified.catalog.sourceWatermarkAt !== copy.sourceWatermarkAt ||
            key.keyVersion !== copy.keyVersion ||
            !equalDigest(sha256(Buffer.from(canonicalJson(verified.catalog), "utf8")), copy.catalogSha256)) {
          throw new RelationalBackupError("BACKUP_CATALOG_MISMATCH");
        }
        return verified.catalog;
      }
      catch (error) {
        if (error instanceof RelationalBackupError) throw error;
        throw new RelationalBackupError("BACKUP_AUTHENTICATION_FAILED");
      }
    },
    async recover(copy: RelationalBackupAttempt, key: RelationalBackupKey, signal?: AbortSignal): Promise<Readonly<{
      catalog: RelationalBackupCatalog;
      payload: RelationalBackupPayload;
    }>> {
      const envelope = await deps.destination.get(copy.objectKey, signal);
      if (envelope.byteLength !== copy.ciphertextBytes || !equalDigest(sha256(envelope), copy.ciphertextSha256)) {
        throw new RelationalBackupError("BACKUP_CIPHERTEXT_MISMATCH");
      }
      let verified: ReturnType<typeof decryptRelationalBackupEnvelope>;
      try { verified = decryptRelationalBackupEnvelope(envelope, key); }
      catch { throw new RelationalBackupError("BACKUP_AUTHENTICATION_FAILED"); }
      if (verified.catalog.dumpBytes !== copy.dumpBytes || verified.catalog.sourceWatermarkAt !== copy.sourceWatermarkAt ||
          key.keyVersion !== copy.keyVersion ||
          !equalDigest(sha256(Buffer.from(canonicalJson(verified.catalog), "utf8")), copy.catalogSha256)) {
        throw new RelationalBackupError("BACKUP_CATALOG_MISMATCH");
      }
      try {
        const payload = decodeRelationalBackupPayload(verified.dump);
        if (payload.migrations.length !== verified.catalog.migrationCount) {
          throw new TypeError("Backup migration count does not match its catalog.");
        }
        return Object.freeze({ catalog: verified.catalog, payload });
      } catch {
        throw new RelationalBackupError("BACKUP_PAYLOAD_INVALID");
      }
    },
    async getLastUsable(): Promise<RelationalBackupAttempt | null> {
      return deps.catalog.currentUsable(deps.destination.name);
    },
  };
}

async function boundedRetry(operation: () => Promise<void>): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RELATIONAL_BACKUP_MAX_ATTEMPTS; attempt += 1) {
    try { await operation(); return; }
    catch (error) { lastError = error; }
  }
  throw lastError;
}

export class RelationalBackupError extends Error {
  readonly safeCode: string;
  constructor(safeCode: string) {
    super("Relational backup failed (" + safeCode + ").");
    this.name = "RelationalBackupError";
    this.safeCode = safeCode;
  }
}
