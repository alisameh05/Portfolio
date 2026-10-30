import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const OBJECT_BACKUP_ENVELOPE_VERSION = 1 as const;
export const OBJECT_BACKUP_MAX_ATTEMPTS = 3;
export const OBJECT_BACKUP_MEDIA_LOSS_WINDOW_DAYS = 7;
export const OBJECT_BACKUP_STALE_UPLOAD_HOURS = 24;
// Source contracts cap Media at 50 MiB and Owner export artifacts at 64 MiB.
// Sharding makes retained worker memory independent of the inventory total.
const MAX_OBJECT_BYTES = 67_108_864;

export type ObjectBackupItem = Readonly<{
  kind: "media" | "owner-export";
  portfolioId: string;
  mediaId?: string;
  exportId?: string;
  objectId: string;
  source: "original" | "variant" | "export-artifact";
  cvVersionIds?: readonly string[];
  variantName: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
  eligibleAt: string;
  expiresAt: string | null;
  revalidate?(): Promise<boolean>;
  read(): Promise<Uint8Array>;
}>;

export type ObjectBackupDescriptor = Readonly<Omit<ObjectBackupItem, "read" | "revalidate" | "eligibleAt" | "expiresAt"> & {
  backupObjectKey?: string;
  backupCiphertextBytes?: number;
  backupCiphertextSha256?: string;
}>;
export type ObjectBackupCatalog = Readonly<{
  version: 1;
  sourceWatermarkAt: string;
  relationalWatermarkAt: string;
  startedAt: string;
  completedAt: string;
  format: "SWOB";
  algorithm: "AES-256-GCM";
  keyVersion: string;
  objectCount: number;
  mediaCount: number;
  exportCount: number;
  mediaBytes: number;
  exportBytes: number;
  plaintextBytes: number;
  ciphertextBytes: number;
  objects: readonly ObjectBackupDescriptor[];
  excluded: readonly Readonly<{ kind: ObjectBackupItem["kind"]; objectId: string; reason: "not-yet-eligible" | "expired" | "no-longer-eligible" }>[];
  complete: true;
}>;

export type ObjectBackupAttempt = Readonly<{
  copyId: string;
  destinationName: string;
  objectKey: string;
  keyVersion: string;
  sourceWatermarkAt: string;
  relationalWatermarkAt: string;
  objectCount: number;
  mediaBytes: number;
  exportBytes: number;
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

export interface ObjectBackupSourcePort {
  capture(): Promise<Readonly<{ sourceWatermarkAt: string; relationalWatermarkAt: string; items: readonly ObjectBackupItem[] }>>;
}
export interface ObjectBackupDestinationPort {
  readonly name: string;
  put(objectKey: string, ciphertext: Uint8Array, signal?: AbortSignal): Promise<void>;
  get(objectKey: string, signal?: AbortSignal): Promise<Uint8Array>;
  delete(objectKey: string, signal?: AbortSignal): Promise<void>;
}
export interface ObjectBackupCatalogPort {
  begin(attempt: ObjectBackupAttempt): Promise<void>;
  finalizeUploading(attempt: ObjectBackupAttempt): Promise<void>;
  markUsable(copyId: string, verifiedAt: string, committedAt: string): Promise<void>;
  markFailed(copyId: string, failureCode: string): Promise<void>;
  currentUsable(destinationName: string): Promise<ObjectBackupAttempt | null>;
  listUsable(destinationName: string, limit: number): Promise<readonly ObjectBackupAttempt[]>;
  listStaleUploading(destinationName: string, attemptedBefore: string, limit: number): Promise<readonly ObjectBackupAttempt[]>;
  listExpired(destinationName: string, limit: number): Promise<readonly ObjectBackupAttempt[]>;
  acknowledgeDeletion(copyId: string, deletedAt: string): Promise<void>;
}
export interface ObjectBackupIncidentPort { recordFailure(code: string, at: string): Promise<void>; }
export type ObjectBackupKey = Readonly<{ keyVersion: string; bytes: Uint8Array }>;

function sha256(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex"), right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value as Record<string, unknown>).sort().map(k => JSON.stringify(k) + ":" + canonical((value as Record<string, unknown>)[k])).join(",") + "}";
}
function safeFailure(error: unknown): string {
  const candidate = typeof error === "object" && error !== null && "safeCode" in error && typeof (error as {safeCode?: unknown}).safeCode === "string"
    ? (error as {safeCode: string}).safeCode : "OBJECT_BACKUP_ATTEMPT_FAILED";
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(candidate) ? candidate : "OBJECT_BACKUP_ATTEMPT_FAILED";
}
function validTime(value: string): number { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : NaN; }

function encodeEnvelope(catalog: ObjectBackupCatalog, objects: readonly Uint8Array[], key: ObjectBackupKey, catalogOnly = false): Uint8Array {
  if (key.bytes.byteLength !== 32 || !/^[a-z0-9][a-z0-9-]{1,47}$/u.test(key.keyVersion)) throw new TypeError("OBJECT_BACKUP_KEY_INVALID");
  const catalogBytes = Buffer.from(canonical(catalog));
  const parts = [Buffer.from("SWOB"), Buffer.from([1])];
  const length = Buffer.alloc(4); length.writeUInt32BE(catalogBytes.length);
  parts.push(length, catalogBytes);
  objects.forEach((object, index) => { const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(object.byteLength)); parts.push(size, Buffer.from(object)); if (index > 1_000_000) throw new TypeError("OBJECT_BACKUP_INVENTORY_TOO_LARGE"); });
  const plaintext = Buffer.concat(parts), nonce = randomBytes(12);
  const header = Buffer.from(JSON.stringify({ version: 1, algorithm: "AES-256-GCM", keyVersion: key.keyVersion,
    nonce: nonce.toString("base64"), plaintextSha256: sha256(plaintext), catalogSha256: sha256(catalogBytes), plaintextBytes: plaintext.length,
    ...(catalogOnly ? { payloadKind: "catalog" } : { payloadKind: "objects" }) }));
  const cipher = createCipheriv("aes-256-gcm", key.bytes, nonce); cipher.setAAD(header);
  let ciphertext: Buffer;
  try { ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); }
  finally { plaintext.fill(0); catalogBytes.fill(0); }
  const prefix = Buffer.alloc(9); prefix.write("SWBE", 0, "ascii"); prefix[4] = 1; prefix.writeUInt32BE(header.length, 5);
  return Buffer.concat([prefix, header, ciphertext, cipher.getAuthTag()]);
}

function decodeEnvelope(value: Uint8Array, key: ObjectBackupKey): Readonly<{ catalog: ObjectBackupCatalog; objects: readonly Uint8Array[]; catalogOnly: boolean }> {
  const bytes = Buffer.from(value);
  if (bytes.length < 27 || bytes.subarray(0, 4).toString() !== "SWBE" || bytes[4] !== 1) throw new TypeError("OBJECT_BACKUP_ENVELOPE_INVALID");
  const headerLength = bytes.readUInt32BE(5), end = 9 + headerLength;
  if (headerLength < 2 || end + 16 > bytes.length) throw new TypeError("OBJECT_BACKUP_ENVELOPE_INVALID");
  let header: Record<string, unknown>;
  try { header = JSON.parse(bytes.subarray(9, end).toString()) as Record<string, unknown>; } catch { throw new TypeError("OBJECT_BACKUP_ENVELOPE_INVALID"); }
  if (header["version"] !== 1 || header["algorithm"] !== "AES-256-GCM" || header["keyVersion"] !== key.keyVersion || key.bytes.byteLength !== 32 || typeof header["nonce"] !== "string") throw new TypeError("OBJECT_BACKUP_KEY_INCOMPATIBLE");
  const nonce = Buffer.from(header["nonce"], "base64"); if (nonce.length !== 12) throw new TypeError("OBJECT_BACKUP_ENVELOPE_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", key.bytes, nonce); decipher.setAAD(bytes.subarray(9, end)); decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  let plaintext: Buffer; try { plaintext = Buffer.concat([decipher.update(bytes.subarray(end, -16)), decipher.final()]); } catch { throw new TypeError("OBJECT_BACKUP_AUTHENTICATION_FAILED"); }
  try {
    if (plaintext.length !== header["plaintextBytes"] || sha256(plaintext) !== header["plaintextSha256"] || plaintext.subarray(0, 4).toString() !== "SWOB" || plaintext[4] !== 1) throw new TypeError("OBJECT_BACKUP_INTEGRITY_FAILED");
    const catalogLength = plaintext.readUInt32BE(5), catalogEnd = 9 + catalogLength;
    if (catalogLength < 2 || catalogEnd > plaintext.length) throw new TypeError("OBJECT_BACKUP_CATALOG_INVALID");
    const catalogBytes = plaintext.subarray(9, catalogEnd); if (sha256(catalogBytes) !== header["catalogSha256"]) throw new TypeError("OBJECT_BACKUP_CATALOG_INVALID");
    const catalog = JSON.parse(catalogBytes.toString()) as ObjectBackupCatalog, objects: Uint8Array[] = [];
    const catalogOnly = header["payloadKind"] === "catalog";
    if (header["payloadKind"] !== undefined && header["payloadKind"] !== "catalog" && header["payloadKind"] !== "objects") throw new TypeError("OBJECT_BACKUP_ENVELOPE_INVALID");
    let offset = catalogEnd;
    for (const descriptor of catalogOnly ? [] : catalog.objects) {
      if (offset + 8 > plaintext.length) throw new TypeError("OBJECT_BACKUP_OBJECT_TRUNCATED");
      const size = Number(plaintext.readBigUInt64BE(offset)); offset += 8;
      if (!Number.isSafeInteger(size) || size > plaintext.length - offset) throw new TypeError("OBJECT_BACKUP_OBJECT_TRUNCATED");
      const object = plaintext.subarray(offset, offset + size); offset += size;
      if (object.byteLength !== descriptor.byteLength || sha256(object) !== descriptor.sha256) throw new TypeError("OBJECT_BACKUP_OBJECT_INTEGRITY_FAILED");
      objects.push(Buffer.from(object));
    }
    if (offset !== plaintext.length || (catalogOnly ? objects.length !== 0 : objects.length !== catalog.objectCount)) throw new TypeError("OBJECT_BACKUP_INVENTORY_MISMATCH");
    return Object.freeze({ catalog, objects: Object.freeze(objects), catalogOnly });
  } finally { plaintext.fill(0); }
}

export function createObjectBackupService(deps: {
  source: ObjectBackupSourcePort; destination: ObjectBackupDestinationPort; catalog: ObjectBackupCatalogPort;
  incidents: ObjectBackupIncidentPort; key: ObjectBackupKey; ids: { next(): string }; clock: { now(): string };
  retentionLifetimeHours: number | null;
}) {
  if (deps.retentionLifetimeHours !== null && (!Number.isSafeInteger(deps.retentionLifetimeHours) || deps.retentionLifetimeHours < 24 || deps.retentionLifetimeHours > 8760)) throw new TypeError("OBJECT_BACKUP_RETENTION_INVALID");
  if (!/^[a-z][a-z0-9-]{2,47}$/u.test(deps.destination.name)) throw new TypeError("OBJECT_BACKUP_DESTINATION_INVALID");
  const service = {
    async create(signal?: AbortSignal): Promise<ObjectBackupAttempt & { catalog: ObjectBackupCatalog }> {
      const attemptedAt = deps.clock.now(); let attempt: ObjectBackupAttempt | null = null;
      try {
        const captured = await deps.source.capture(), sourceWatermark = validTime(captured.sourceWatermarkAt), relationalWatermark = validTime(captured.relationalWatermarkAt);
        if (!Number.isFinite(sourceWatermark) || !Number.isFinite(relationalWatermark) || sourceWatermark > relationalWatermark) throw Object.assign(new Error(), { safeCode: "OBJECT_BACKUP_WATERMARK_INVALID" });
        const startedAt = deps.clock.now(), candidates: Array<{ item: ObjectBackupItem; descriptor: ObjectBackupDescriptor }> = [], excluded: Array<{kind: ObjectBackupItem["kind"]; objectId: string; reason: "not-yet-eligible" | "expired" | "no-longer-eligible"}> = [];
        const seenObjectIds = new Set<string>();
        for (const item of captured.items) {
          if (signal?.aborted) throw Object.assign(new Error(), { safeCode: "OBJECT_BACKUP_CANCELLED" });
          const eligibleAt = validTime(item.eligibleAt), expiresAt = item.expiresAt === null ? null : validTime(item.expiresAt);
          const eligibilityNow = validTime(deps.clock.now());
          if (!Number.isFinite(eligibleAt) || eligibleAt > eligibilityNow) { excluded.push({ kind: item.kind, objectId: item.objectId, reason: "not-yet-eligible" }); continue; }
          if (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= eligibilityNow)) { excluded.push({ kind: item.kind, objectId: item.objectId, reason: "expired" }); continue; }
          if (item.revalidate && !await item.revalidate()) { excluded.push({ kind: item.kind, objectId: item.objectId, reason: "no-longer-eligible" }); continue; }
          if (seenObjectIds.has(item.objectId)) throw Object.assign(new Error(), { safeCode: "OBJECT_BACKUP_DUPLICATE_OBJECT_ID" });
          seenObjectIds.add(item.objectId);
          if (!Number.isSafeInteger(item.byteLength) || item.byteLength < 0 || item.byteLength > MAX_OBJECT_BYTES || !/^[0-9a-f]{64}$/u.test(item.sha256)) throw Object.assign(new Error(), { safeCode: "OBJECT_BACKUP_INVENTORY_INVALID" });
          const { read: _read, revalidate: _revalidate, eligibleAt: _eligibleAt, expiresAt: _expiresAt, ...descriptor } = item;
          candidates.push({ item, descriptor: Object.freeze(descriptor) });
        }
        const id = deps.ids.next(), objectKey = `objects/${id}/catalog.swob`;
        const now = deps.clock.now(), expiresAt = deps.retentionLifetimeHours === null ? null : new Date(validTime(now) + deps.retentionLifetimeHours * 3_600_000).toISOString();
        const mediaBytes = candidates.filter(x => x.item.kind === "media").reduce((n, x) => n + x.item.byteLength, 0);
        const exportBytes = candidates.filter(x => x.item.kind === "owner-export").reduce((n, x) => n + x.item.byteLength, 0);
        attempt = Object.freeze({ copyId: id, destinationName: deps.destination.name, objectKey, keyVersion: deps.key.keyVersion,
          sourceWatermarkAt: captured.sourceWatermarkAt, relationalWatermarkAt: captured.relationalWatermarkAt, objectCount: candidates.length,
          mediaBytes, exportBytes, ciphertextBytes: 0, catalogSha256: "0".repeat(64), ciphertextSha256: "0".repeat(64), attemptedAt,
          verifiedAt: null, committedAt: null, retentionLifetimeHours: deps.retentionLifetimeHours, expiresAt, state: "uploading", failureCode: null });
        await deps.catalog.begin(attempt);
        const backed: ObjectBackupDescriptor[] = [];
        let shardBytes = 0, plaintextBytes = 0;
        for (let index = 0; index < candidates.length; index += 1) {
          if (signal?.aborted) throw Object.assign(new Error(), { safeCode: "OBJECT_BACKUP_CANCELLED" });
          const candidate = candidates[index]!;
          const sourceBytes = await candidate.item.read();
          let bytes = Buffer.from(sourceBytes);
          sourceBytes.fill(0);
          if (bytes.byteLength !== candidate.item.byteLength || !sameDigest(sha256(bytes), candidate.item.sha256)) {
            bytes.fill(0); throw Object.assign(new Error(), { safeCode: "OBJECT_BACKUP_SOURCE_INTEGRITY_FAILED" });
          }
          const expiry = candidate.item.expiresAt === null ? null : validTime(candidate.item.expiresAt);
          if (expiry !== null && expiry <= validTime(deps.clock.now()) || candidate.item.revalidate && !await candidate.item.revalidate()) {
            bytes.fill(0); throw Object.assign(new Error(), { safeCode: "OBJECT_BACKUP_SOURCE_NO_LONGER_ELIGIBLE" });
          }
          const shardKey = `objects/${id}/items/${index}.swob`;
          const shardCatalog: ObjectBackupCatalog = Object.freeze({ version: 1, sourceWatermarkAt: captured.sourceWatermarkAt,
            relationalWatermarkAt: captured.relationalWatermarkAt, startedAt, completedAt: deps.clock.now(), format: "SWOB",
            algorithm: "AES-256-GCM", keyVersion: deps.key.keyVersion, objectCount: 1,
            mediaCount: candidate.item.kind === "media" ? 1 : 0, exportCount: candidate.item.kind === "owner-export" ? 1 : 0,
            mediaBytes: candidate.item.kind === "media" ? bytes.byteLength : 0, exportBytes: candidate.item.kind === "owner-export" ? bytes.byteLength : 0,
            plaintextBytes: bytes.byteLength, ciphertextBytes: 0, objects: Object.freeze([candidate.descriptor]), excluded: Object.freeze([]), complete: true });
          const shard = encodeEnvelope(shardCatalog, [bytes], deps.key);
          bytes.fill(0);
          await retry(() => deps.destination.put(shardKey, shard, signal));
          const readBack = await deps.destination.get(shardKey, signal);
          if (readBack.byteLength !== shard.byteLength || !sameDigest(sha256(readBack), sha256(shard))) throw Object.assign(new Error(), { safeCode: "OBJECT_BACKUP_READBACK_MISMATCH" });
          let decodedShard: ReturnType<typeof decodeEnvelope>;
          try { decodedShard = decodeEnvelope(readBack, deps.key); }
          catch { throw Object.assign(new Error(), { safeCode: "OBJECT_BACKUP_READBACK_MISMATCH" }); }
          if (decodedShard.catalogOnly || decodedShard.objects.length !== 1 || decodedShard.catalog.objects[0]?.objectId !== candidate.item.objectId ||
              decodedShard.objects[0]?.byteLength !== candidate.item.byteLength || !sameDigest(sha256(decodedShard.objects[0]!), candidate.item.sha256)) {
            throw Object.assign(new Error(), { safeCode: "OBJECT_BACKUP_READBACK_MISMATCH" });
          }
          backed.push(Object.freeze({ ...candidate.descriptor, backupObjectKey: shardKey,
            backupCiphertextBytes: shard.byteLength, backupCiphertextSha256: sha256(shard) }));
          shardBytes += shard.byteLength;
          plaintextBytes += candidate.item.byteLength;
          decodedShard.objects[0]!.fill(0);
          readBack.fill(0); shard.fill(0);
        }
        for (const candidate of candidates) {
          const expiry = candidate.item.expiresAt === null ? null : validTime(candidate.item.expiresAt);
          if (expiry !== null && expiry <= validTime(deps.clock.now()) || candidate.item.revalidate && !await candidate.item.revalidate()) {
            throw Object.assign(new Error(), { safeCode: "OBJECT_BACKUP_SOURCE_NO_LONGER_ELIGIBLE" });
          }
        }
        const completedAt = deps.clock.now();
        const catalogBase: ObjectBackupCatalog = Object.freeze({ version: 1, sourceWatermarkAt: captured.sourceWatermarkAt,
          relationalWatermarkAt: captured.relationalWatermarkAt, startedAt, completedAt, format: "SWOB", algorithm: "AES-256-GCM", keyVersion: deps.key.keyVersion,
          objectCount: backed.length, mediaCount: backed.filter(x => x.kind === "media").length, exportCount: backed.filter(x => x.kind === "owner-export").length,
          mediaBytes, exportBytes, plaintextBytes, ciphertextBytes: 0, objects: Object.freeze(backed), excluded: Object.freeze(excluded), complete: true });
        let totalCiphertextBytes = shardBytes, finalCatalog = catalogBase, committedEnvelope = encodeEnvelope(catalogBase, [], deps.key, true);
        for (let i = 0; i < 4; i += 1) {
          totalCiphertextBytes = shardBytes + committedEnvelope.byteLength;
          finalCatalog = Object.freeze({ ...catalogBase, ciphertextBytes: totalCiphertextBytes });
          committedEnvelope = encodeEnvelope(finalCatalog, [], deps.key, true);
          if (finalCatalog.ciphertextBytes === shardBytes + committedEnvelope.byteLength) break;
        }
        if (finalCatalog.ciphertextBytes !== shardBytes + committedEnvelope.byteLength) throw Object.assign(new Error(), { safeCode: "OBJECT_BACKUP_CATALOG_SIZE_UNSTABLE" });
        const finalizedAttempt: ObjectBackupAttempt = Object.freeze({ ...attempt, objectCount: finalCatalog.objectCount, mediaBytes, exportBytes,
          ciphertextBytes: committedEnvelope.byteLength + shardBytes, catalogSha256: sha256(Buffer.from(canonical(finalCatalog))),
          ciphertextSha256: sha256(committedEnvelope) });
        await retry(() => deps.destination.put(objectKey, committedEnvelope, signal));
        await deps.catalog.finalizeUploading(finalizedAttempt);
        const readBack = await deps.destination.get(objectKey, signal);
        let decoded: ReturnType<typeof decodeEnvelope>;
        try { decoded = decodeEnvelope(readBack, deps.key); }
        catch { throw Object.assign(new Error(), { safeCode: "OBJECT_BACKUP_READBACK_MISMATCH" }); }
        if (readBack.byteLength !== committedEnvelope.byteLength || !sameDigest(sha256(readBack), finalizedAttempt.ciphertextSha256) || !decoded.catalogOnly ||
            decoded.catalog.ciphertextBytes !== finalizedAttempt.ciphertextBytes || !sameDigest(sha256(Buffer.from(canonical(decoded.catalog))), finalizedAttempt.catalogSha256)) throw Object.assign(new Error(), { safeCode: "OBJECT_BACKUP_READBACK_MISMATCH" });
        attempt = finalizedAttempt;
        readBack.fill(0); committedEnvelope.fill(0);
        const verifiedAt = deps.clock.now(), committedAt = deps.clock.now(); await deps.catalog.markUsable(id, verifiedAt, committedAt);
        return Object.freeze({ ...finalizedAttempt, state: "usable", verifiedAt, committedAt, catalog: decoded.catalog });
      } catch (error) {
        const code = safeFailure(error); let cleanupFailed = false;
        if (attempt) {
          let failed = false; try { await deps.catalog.markFailed(attempt.copyId, code); failed = true; } catch { cleanupFailed = true; }
          if (failed) try { await deleteAttemptObjects(deps.destination, attempt); } catch { cleanupFailed = true; }
        }
        const incident = cleanupFailed ? "OBJECT_BACKUP_CLEANUP_FAILED" : code;
        try { await deps.incidents.recordFailure(incident, deps.clock.now()); } catch { throw new ObjectBackupError("OBJECT_BACKUP_INCIDENT_WRITE_FAILED"); }
        throw new ObjectBackupError(cleanupFailed ? incident : code);
      }
    },
    async recoverTo(copy: ObjectBackupAttempt, key: ObjectBackupKey, writeObject: (descriptor: ObjectBackupDescriptor, bytes: Uint8Array) => Promise<void>, signal?: AbortSignal): Promise<ObjectBackupCatalog> {
      const envelope = await deps.destination.get(copy.objectKey, signal);
      if (!sameDigest(sha256(envelope), copy.ciphertextSha256)) throw new ObjectBackupError("OBJECT_BACKUP_CIPHERTEXT_MISMATCH");
      try {
        const decoded = decodeEnvelope(envelope, key);
        if (decoded.catalog.sourceWatermarkAt !== copy.sourceWatermarkAt || decoded.catalog.relationalWatermarkAt !== copy.relationalWatermarkAt ||
            decoded.catalog.objectCount !== copy.objectCount || decoded.catalog.keyVersion !== copy.keyVersion ||
            decoded.catalog.ciphertextBytes !== copy.ciphertextBytes || (!decoded.catalogOnly && envelope.byteLength !== copy.ciphertextBytes) ||
            sha256(Buffer.from(canonical(decoded.catalog))) !== copy.catalogSha256) throw new Error();
        if (decoded.catalogOnly && envelope.byteLength + decoded.catalog.objects.reduce((total, descriptor) => total + (descriptor.backupCiphertextBytes ?? 0), 0) !== copy.ciphertextBytes) throw new Error();
        if (!decoded.catalogOnly) {
          for (let index = 0; index < decoded.objects.length; index += 1) await writeObject(decoded.catalog.objects[index]!, decoded.objects[index]!);
        } else {
          for (const descriptor of decoded.catalog.objects) {
            if (!descriptor.backupObjectKey || !Number.isSafeInteger(descriptor.backupCiphertextBytes) || !descriptor.backupCiphertextSha256) throw new Error();
            const shard = await deps.destination.get(descriptor.backupObjectKey, signal);
            try {
              if (shard.byteLength !== descriptor.backupCiphertextBytes || !sameDigest(sha256(shard), descriptor.backupCiphertextSha256)) throw new ObjectBackupError("OBJECT_BACKUP_CIPHERTEXT_MISMATCH");
              const decodedShard = decodeEnvelope(shard, key);
              if (decodedShard.catalogOnly || decodedShard.objects.length !== 1 || decodedShard.catalog.objects[0]?.objectId !== descriptor.objectId ||
                  decodedShard.objects[0]?.byteLength !== descriptor.byteLength || !sameDigest(sha256(decodedShard.objects[0]!), descriptor.sha256)) throw new Error();
              await writeObject(descriptor, decodedShard.objects[0]!);
              decodedShard.objects[0]!.fill(0);
            } finally { shard.fill(0); }
          }
        }
        envelope.fill(0);
        return decoded.catalog;
      }
      catch (error) {
        envelope.fill(0);
        if (error instanceof ObjectBackupError) throw error;
        if (typeof error === "object" && error !== null && "safeCode" in error && typeof (error as {safeCode?: unknown}).safeCode === "string") {
          throw new ObjectBackupError(safeFailure(error));
        }
        throw new ObjectBackupError("OBJECT_BACKUP_AUTHENTICATION_FAILED");
      }
    },
    async recover(copy: ObjectBackupAttempt, key: ObjectBackupKey, signal?: AbortSignal): Promise<Readonly<{ catalog: ObjectBackupCatalog; objects: readonly Readonly<{ descriptor: ObjectBackupDescriptor; bytes: Uint8Array }>[] }>> {
      const objects: Array<Readonly<{ descriptor: ObjectBackupDescriptor; bytes: Uint8Array }>> = [];
      const catalog = await service.recoverTo(copy, key, async (descriptor, bytes) => { objects.push(Object.freeze({ descriptor, bytes: Buffer.from(bytes) })); }, signal);
      return Object.freeze({ catalog, objects: Object.freeze(objects) });
    },
    async verify(copy: ObjectBackupAttempt, key: ObjectBackupKey, signal?: AbortSignal): Promise<ObjectBackupCatalog> {
      return service.recoverTo(copy, key, async () => {}, signal);
    },
    async getLastUsable(): Promise<ObjectBackupAttempt | null> { return deps.catalog.currentUsable(deps.destination.name); },
    async listUsableCopies(limit = 100): Promise<readonly ObjectBackupAttempt[]> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new TypeError("OBJECT_BACKUP_LIST_LIMIT_INVALID");
      return deps.catalog.listUsable(deps.destination.name, limit);
    },
    async cleanupInterrupted(): Promise<number> {
      const cutoff = new Date(validTime(deps.clock.now()) - OBJECT_BACKUP_STALE_UPLOAD_HOURS * 3_600_000).toISOString();
      const copies = await deps.catalog.listStaleUploading(deps.destination.name, cutoff, 100);
      let cleaned = 0;
      for (const copy of copies) {
        try {
          await deps.catalog.markFailed(copy.copyId, "OBJECT_BACKUP_INTERRUPTED");
          await deleteAttemptObjects(deps.destination, copy);
          cleaned += 1;
        } catch {
          try { await deps.incidents.recordFailure("OBJECT_BACKUP_CLEANUP_FAILED", deps.clock.now()); }
          catch { throw new ObjectBackupError("OBJECT_BACKUP_INCIDENT_WRITE_FAILED"); }
          throw new ObjectBackupError("OBJECT_BACKUP_CLEANUP_FAILED");
        }
      }
      return cleaned;
    },
    async cleanupExpired(signal?: AbortSignal): Promise<number> {
      let deleted = 0;
      const copies = await deps.catalog.listExpired(deps.destination.name, 100);
      for (const copy of copies) {
        try {
          await deleteAttemptObjects(deps.destination, copy, signal);
          await deps.catalog.acknowledgeDeletion(copy.copyId, deps.clock.now());
          deleted += 1;
        } catch {
          try { await deps.incidents.recordFailure("OBJECT_BACKUP_CLEANUP_FAILED", deps.clock.now()); }
          catch { throw new ObjectBackupError("OBJECT_BACKUP_INCIDENT_WRITE_FAILED"); }
          throw new ObjectBackupError("OBJECT_BACKUP_CLEANUP_FAILED");
        }
      }
      return deleted;
    },
  };
  return service;
}

async function retry(action: () => Promise<void>): Promise<void> { let last: unknown; for (let i = 0; i < OBJECT_BACKUP_MAX_ATTEMPTS; i++) try { await action(); return; } catch (error) { last = error; } throw last; }
async function deleteAttemptObjects(destination: ObjectBackupDestinationPort, attempt: ObjectBackupAttempt, signal?: AbortSignal): Promise<void> {
  if (!attempt.objectKey.endsWith("/catalog.swob")) { await destination.delete(attempt.objectKey, signal); return; }
  for (let index = 0; index < attempt.objectCount; index += 1) await destination.delete(`objects/${attempt.copyId}/items/${index}.swob`, signal);
  await destination.delete(attempt.objectKey, signal);
}
export class ObjectBackupError extends Error { constructor(readonly safeCode: string) { super("Object backup failed (" + safeCode + ")."); this.name = "ObjectBackupError"; } }

export function selectCompatibleRecoverySet(input: {
  relational: Readonly<{ sourceWatermarkAt: string }>;
  object: ObjectBackupCatalog;
  requiredObjectIds: readonly string[];
  integrity: "full" | "declared-loss-window";
}): Readonly<{ compatible: boolean; missingObjectIds: readonly string[]; mediaLossWindowDays: number | null; reason: string | null }> {
  const relationalAt = validTime(input.relational.sourceWatermarkAt), objectAt = validTime(input.object.sourceWatermarkAt);
  const missingObjectIds = input.requiredObjectIds.filter(id => !input.object.objects.some(item => item.objectId === id));
  if (!input.object.complete || !Number.isFinite(relationalAt) || !Number.isFinite(objectAt)) return Object.freeze({ compatible: false, missingObjectIds, mediaLossWindowDays: null, reason: "RECOVERY_CATALOG_INCOMPLETE" });
  if (missingObjectIds.length && input.integrity === "full") return Object.freeze({ compatible: false, missingObjectIds: Object.freeze(missingObjectIds), mediaLossWindowDays: null, reason: "REQUIRED_OBJECTS_MISSING" });
  const gapDays = Math.max(0, Math.floor((relationalAt - objectAt) / 86_400_000));
  if (missingObjectIds.length && input.integrity === "declared-loss-window" && gapDays > OBJECT_BACKUP_MEDIA_LOSS_WINDOW_DAYS) {
    return Object.freeze({ compatible: false, missingObjectIds: Object.freeze(missingObjectIds), mediaLossWindowDays: OBJECT_BACKUP_MEDIA_LOSS_WINDOW_DAYS, reason: "DECLARED_LOSS_WINDOW_EXCEEDED" });
  }
  return Object.freeze({ compatible: true, missingObjectIds: Object.freeze(missingObjectIds), mediaLossWindowDays: missingObjectIds.length ? OBJECT_BACKUP_MEDIA_LOSS_WINDOW_DAYS : null, reason: null });
}
