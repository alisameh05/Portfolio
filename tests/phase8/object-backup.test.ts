import { describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createObjectBackupService,
  selectCompatibleRecoverySet,
  type ObjectBackupItem,
} from "../../src/modules/portability-operations/application/object-backup.js";
import { createOwnerObjectBackupSource } from "../../src/modules/portability-operations/application/owner-object-backup-source.js";
import type { StableId } from "@shared/domain";
import { createHttpObjectBackupDestination } from "../../src/modules/portability-operations/adapters/http-object-backup-destination.js";

const key = { keyVersion: "test-v1", bytes: new Uint8Array(32).fill(7) };
const bytes = new TextEncoder().encode("private object bytes");
const digest = createHash("sha256").update(bytes).digest("hex");
const item: ObjectBackupItem = {
  kind: "media", portfolioId: "portfolio-1", mediaId: "media-1", objectId: "object-1",
  source: "original", variantName: "original", mediaType: "image/png", byteLength: bytes.length,
  sha256: digest, eligibleAt: "2026-10-29T00:00:00.000Z", expiresAt: null,
  read: async () => Buffer.from(bytes),
};

function setup(overrides: Partial<Parameters<typeof createObjectBackupService>[0]> = {}) {
  const objects = new Map<string, Uint8Array>();
  const rows: unknown[] = [];
  const service = createObjectBackupService({
    source: { capture: async () => ({ sourceWatermarkAt: "2026-10-29T00:00:00.000Z", relationalWatermarkAt: "2026-10-29T00:00:00.000Z", items: [item] }) },
    destination: { name: "independent-store", put: async (objectKey, value) => { objects.set(objectKey, Buffer.from(value)); },
      get: async objectKey => Buffer.from(objects.get(objectKey)!), delete: async objectKey => { objects.delete(objectKey); } },
    catalog: { begin: async (entry) => { rows.push(entry); }, finalizeUploading: async () => {}, markUsable: async () => {}, markFailed: async () => {}, currentUsable: async () => null, listUsable: async () => [], listStaleUploading: async () => [], listExpired: async () => [], acknowledgeDeletion: async () => {} },
    incidents: { recordFailure: async () => {} }, key, ids: { next: () => "copy-1" },
    clock: { now: () => "2026-10-30T00:00:00.000Z" }, retentionLifetimeHours: 168,
    ...overrides,
  });
  return { service, rows, getObject: (objectKey = "objects/copy-1/catalog.swob") => objects.get(objectKey) ?? null, objects };
}

describe("object backup", () => {
  it("keeps timeout cancellation active with a caller signal", async () => {
    const destination = createHttpObjectBackupDestination({ name: "independent-store", baseUrl: "https://backup.example", bearerToken: "test", requestTimeoutMs: 1000,
      fetcher: async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true })) });
    await expect(destination.put("objects/00000000-0000-4000-8000-000000000001/catalog.swob", bytes, new AbortController().signal)).rejects.toMatchObject({ safeCode: "OBJECT_BACKUP_DESTINATION_UNAVAILABLE" });
  });

  it("enforces the exact seven day recovery boundary", async () => {
    const { service } = setup();
    const copy = await service.create();
    const input = { object: copy.catalog, requiredObjectIds: ["missing"], integrity: "declared-loss-window" as const };
    const boundary = Date.parse(copy.catalog.sourceWatermarkAt) + 7 * 86400000;
    expect(selectCompatibleRecoverySet({ ...input, relational: { sourceWatermarkAt: new Date(boundary).toISOString() } }).compatible).toBe(true);
    expect(selectCompatibleRecoverySet({ ...input, relational: { sourceWatermarkAt: new Date(boundary + 1).toISOString() } }).compatible).toBe(false);
  });

  it("writes encrypted bytes through the authenticated HTTP destination and recovers its independent disk copy", async () => {
    const root = await mkdtemp(join(tmpdir(), "phase8-object-backup-"));
    const token = randomUUID();
    await mkdir(join(root, "objects"), { recursive: true });
    const server = createServer(async (request, response) => {
      if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401).end(); return; }
      const pathname = new URL(request.url!, "http://127.0.0.1").pathname;
      const key = pathname.split("/v1/objects/independent-store/")[1]?.split("/").map(decodeURIComponent).join("/");
      if (!key || key.includes("..")) { response.writeHead(400).end(); return; }
      const path = join(root, key);
      if (request.method === "PUT") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, Buffer.concat(chunks), { flag: "wx" });
        response.writeHead(201).end(); return;
      }
      if (request.method === "GET") {
        try { response.writeHead(200, { "content-type": "application/octet-stream" }).end(await readFile(path)); }
        catch { response.writeHead(404).end(); }
        return;
      }
      if (request.method === "DELETE") { await rm(path, { force: true }); response.writeHead(204).end(); return; }
      response.writeHead(405).end();
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("OBJECT_BACKUP_TEST_SERVER_START_FAILED");
      const destination = createHttpObjectBackupDestination({ name: "independent-store", baseUrl: `http://127.0.0.1:${address.port}`,
        bearerToken: token, allowLoopbackHttp: true });
      const copyId = "00000000-0000-4000-8000-000000000001";
      const { service } = setup({ destination, ids: { next: () => copyId } });
      const copy = await service.create();
      const storedPath = join(root, "objects", copyId, "catalog.swob");
      const stored = await readFile(storedPath);
      expect(stored.byteLength + copy.catalog.objects.reduce((total, descriptor) => total + descriptor.backupCiphertextBytes!, 0)).toBe(copy.ciphertextBytes);
      expect(stored.includes(Buffer.from("private object bytes"))).toBe(false);
      const recovered = await service.recover(copy, key);
      expect(Buffer.from(recovered.objects[0]!.bytes)).toEqual(Buffer.from(bytes));
      await writeFile(storedPath, Buffer.alloc(stored.length, 0x41));
      await expect(service.recover(copy, key)).rejects.toMatchObject({ safeCode: "OBJECT_BACKUP_CIPHERTEXT_MISMATCH" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps actual Media, CV, and eligible export bytes into one exact encrypted inventory", async () => {
    const cvBytes = new TextEncoder().encode("accepted cv pdf");
    const exportBytes = new TextEncoder().encode("eligible owner export zip");
    const cvDigest = createHash("sha256").update(cvBytes).digest("hex");
    const exportDigest = createHash("sha256").update(exportBytes).digest("hex");
    const source = createOwnerObjectBackupSource({
      media: { capture: async () => ({ sourceWatermarkAt: "2026-10-29T00:00:00.000Z", relationalWatermarkAt: "2026-10-29T00:00:00.000Z", candidates: [{
        portfolioId: "portfolio-1" as StableId<"Portfolio">, mediaId: "media-1" as StableId<"MediaAsset">,
        objectId: "object-1" as StableId<"MediaObject">, source: "variant", variantName: "cv-pdf",
        mediaType: "application/pdf", byteLength: cvBytes.length, sha256: cvDigest, eligibleAt: "2026-10-29T00:00:00.000Z",
        expiresAt: null, cvVersionIds: ["cv-version-1"], revalidate: async () => true,
      }] }) },
      exports: { listEligible: async () => ({ capturedAt: "2026-10-29T00:00:00.000Z", candidates: [{ portfolioId: "portfolio-1" as StableId<"Portfolio">,
        exportId: "export-1" as StableId<"OwnerExport">, artifactId: "artifact-1" as StableId<"OwnerExportArtifact">, byteLength: exportBytes.length, sha256: exportDigest,
        eligibleAt: "2026-10-29T00:00:00.000Z", expiresAt: "2026-11-01T00:00:00.000Z", revalidate: async () => true }] }) },
      mediaObjects: {
        async readMediaExportObject() {
          return { async *[Symbol.asyncIterator]() { yield cvBytes; } };
        },
      },
      exportObjects: {
        async readOwnerExport() {
          return { ok: true as const, value: { content: { async *[Symbol.asyncIterator]() { yield exportBytes; } }, contentLength: exportBytes.length, sha256: exportDigest } };
        },
      },
    });
    const { service } = setup({ source });
    const result = await service.create();
    expect(result.catalog.objects).toMatchObject([
      { objectId: "object-1", cvVersionIds: ["cv-version-1"], byteLength: cvBytes.length, sha256: cvDigest },
      { objectId: "artifact-1", source: "export-artifact", byteLength: exportBytes.length, sha256: exportDigest },
    ]);
    expect(result.catalog.mediaCount).toBe(1);
    expect(result.catalog.exportCount).toBe(1);
  });

  it("copies and verifies actual eligible object bytes with an exact inventory", async () => {
    const { service } = setup();
    const result = await service.create();
    expect(result.state).toBe("usable");
    expect(result.catalog.objects).toMatchObject([{ objectId: "object-1", byteLength: bytes.length }]);
    expect(result.catalog.mediaCount).toBe(1);
    expect(result.catalog.mediaBytes).toBe(bytes.length);
  });

  it("releases each source byte buffer after making its encrypted shard", async () => {
    const sourceBytes = Buffer.from(bytes);
    const shardItem = { ...item, read: async () => sourceBytes };
    const { service } = setup({ source: { capture: async () => ({ sourceWatermarkAt: "2026-10-29T00:00:00.000Z",
      relationalWatermarkAt: "2026-10-29T00:00:00.000Z", items: [shardItem] }) } });
    await service.create();
    expect(sourceBytes.every(value => value === 0)).toBe(true);
  });

  it("backs up a 2 GiB logical inventory while clearing each 50 MiB source buffer before reading the next", async () => {
    const objectBytes = 50 * 1024 * 1024, objectCount = 40, payload = Buffer.alloc(objectBytes, 0x6d);
    const objectSha256 = createHash("sha256").update(payload).digest("hex");
    let lastSourceBuffer: Buffer | null = null;
    let maximumSourceBufferBytes = 0;
    const items: ObjectBackupItem[] = Array.from({ length: objectCount }, (_, index) => ({
      kind: "media", portfolioId: `portfolio-${index}`, mediaId: `media-${index}`, objectId: `object-${index}`,
      source: "original", variantName: "original", mediaType: "image/png", byteLength: objectBytes,
      sha256: objectSha256, eligibleAt: "2026-10-29T00:00:00.000Z", expiresAt: null,
      read: async () => {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (lastSourceBuffer) expect(lastSourceBuffer.every(value => value === 0)).toBe(true);
        lastSourceBuffer = Buffer.from(payload);
        maximumSourceBufferBytes = Math.max(maximumSourceBufferBytes, lastSourceBuffer.byteLength);
        return lastSourceBuffer;
      },
    }));
    let stagedKey = "", stagedBytes = Buffer.alloc(0);
    const { service } = setup({
      source: { capture: async () => ({ sourceWatermarkAt: "2026-10-29T00:00:00.000Z", relationalWatermarkAt: "2026-10-29T00:00:00.000Z", items }) },
      destination: { name: "independent-store", put: async (objectKey, bytes) => { stagedKey = objectKey; stagedBytes = Buffer.from(bytes); },
        get: async objectKey => objectKey === stagedKey ? Buffer.from(stagedBytes) : new Uint8Array(), delete: async () => { stagedBytes = Buffer.alloc(0); } },
    });
    const result = await service.create();
    expect(result.catalog.objectCount).toBe(objectCount);
    expect(result.catalog.plaintextBytes).toBe(objectBytes * objectCount);
    expect(result.catalog.objects.every(descriptor => descriptor.backupObjectKey !== undefined)).toBe(true);
    const finalSourceBuffer = lastSourceBuffer as Buffer | null;
    expect(finalSourceBuffer?.every((value: number) => value === 0)).toBe(true);
    process.stdout.write(JSON.stringify({ evidence: "bounded-object-shards", logicalPlaintextBytes: objectBytes * objectCount,
      maximumLiveSourceBufferBytes: maximumSourceBufferBytes, perObjectClearedBeforeNextRead: true }) + "\n");
  }, 120_000);

  it("does not mark a tampered read-back usable and preserves the last-good row", async () => {
    let began = false;
    const { service } = setup({
      destination: { name: "independent-store", put: async () => {}, get: async () => new Uint8Array([1]), delete: async () => {} },
      catalog: { begin: async () => { began = true; }, finalizeUploading: async () => {}, markUsable: async () => { throw new Error("must not commit"); }, markFailed: async () => {}, currentUsable: async () => null, listUsable: async () => [], listStaleUploading: async () => [], listExpired: async () => [], acknowledgeDeletion: async () => {} },
    });
    await expect(service.create()).rejects.toMatchObject({ safeCode: "OBJECT_BACKUP_READBACK_MISMATCH" });
    expect(began).toBe(true);
  });

  it("bounds denied uploads, marks the attempt failed, and leaves the last-good reference unchanged", async () => {
    let puts = 0, failed = false;
    const lastGood = { copyId: "last-good" } as Awaited<ReturnType<ReturnType<typeof createObjectBackupService>["create"]>>;
    const { service } = setup({
      destination: { name: "independent-store", put: async () => { puts += 1; throw Object.assign(new Error("private provider response"), { safeCode: "OBJECT_BACKUP_UPLOAD_FAILED" }); }, get: async () => new Uint8Array(), delete: async () => {} },
      catalog: { begin: async () => {}, finalizeUploading: async () => {}, markUsable: async () => { throw new Error("must not commit"); }, markFailed: async () => { failed = true; }, currentUsable: async () => lastGood, listUsable: async () => [lastGood], listStaleUploading: async () => [], listExpired: async () => [], acknowledgeDeletion: async () => {} },
    });
    await expect(service.create()).rejects.toMatchObject({ safeCode: "OBJECT_BACKUP_UPLOAD_FAILED" });
    expect(puts).toBe(3);
    expect(failed).toBe(true);
    expect(await service.getLastUsable()).toBe(lastGood);
  });

  it("keeps object and catalog contents encrypted and rejects an unavailable recovery key", async () => {
    const { service, getObject } = setup();
    const copy = await service.create();
    const envelope = getObject()!;
    expect(createHash("sha256").update(envelope).digest("hex")).toBe(copy.ciphertextSha256);
    expect(Buffer.from(envelope).includes(Buffer.from("private object bytes"))).toBe(false);
    const recovered = await service.recover(copy, key);
    expect(recovered.objects[0]?.descriptor.objectId).toBe("object-1");
    expect(Buffer.from(recovered.objects[0]!.bytes)).toEqual(Buffer.from(bytes));
    await expect(service.verify(copy, { keyVersion: "wrong-v1", bytes: new Uint8Array(32).fill(8) }))
      .rejects.toMatchObject({ safeCode: "OBJECT_BACKUP_AUTHENTICATION_FAILED" });
  });

  it("rejects replaced ciphertext before returning any recovered bytes", async () => {
    const { service } = setup();
    const copy = await service.create();
    const replaced = { ...copy, ciphertextSha256: "0".repeat(64) };
    await expect(service.recover(replaced, key)).rejects.toMatchObject({ safeCode: "OBJECT_BACKUP_CIPHERTEXT_MISMATCH" });
  });

  it("excludes expired source data and refuses an incompatible full-integrity set", async () => {
    const expired = { ...item, expiresAt: "2026-10-29T12:00:00.000Z" };
    const { service } = setup({ source: { capture: async () => ({ sourceWatermarkAt: "2026-10-29T00:00:00.000Z", relationalWatermarkAt: "2026-10-29T00:00:00.000Z", items: [expired] }) } });
    const copy = await service.create();
    expect(copy.catalog.objects).toHaveLength(0);
    expect(copy.catalog.excluded).toHaveLength(1);
    const relational = { sourceWatermarkAt: "2026-10-29T00:00:00.000Z" };
    expect(selectCompatibleRecoverySet({ relational, object: copy.catalog, requiredObjectIds: ["object-1"], integrity: "full" }).compatible).toBe(false);
    expect(selectCompatibleRecoverySet({ relational, object: copy.catalog, requiredObjectIds: ["object-1"], integrity: "declared-loss-window" }).compatible).toBe(true);
    expect(selectCompatibleRecoverySet({ relational: { sourceWatermarkAt: "2026-11-07T00:00:00.000Z" }, object: copy.catalog, requiredObjectIds: ["object-1"], integrity: "declared-loss-window" }).compatible).toBe(false);
    expect(selectCompatibleRecoverySet({ relational, object: copy.catalog, requiredObjectIds: [], integrity: "full" }).compatible).toBe(true);
    expect(selectCompatibleRecoverySet({ relational: { sourceWatermarkAt: "2026-10-28T00:00:00.000Z" }, object: copy.catalog, requiredObjectIds: [], integrity: "full" }).compatible).toBe(true);
  });

  it("rechecks source privacy eligibility after reading bytes", async () => {
    let checks = 0;
    const sourceItem = { ...item, revalidate: async () => ++checks === 1 };
    const { service } = setup({ source: { capture: async () => ({ sourceWatermarkAt: "2026-10-29T00:00:00.000Z", relationalWatermarkAt: "2026-10-29T00:00:00.000Z", items: [sourceItem] }) } });
    await expect(service.create()).rejects.toMatchObject({ safeCode: "OBJECT_BACKUP_SOURCE_NO_LONGER_ELIGIBLE" });
  });

  it("deletes expired copies before acknowledging the catalog tombstone", async () => {
    let acknowledged = false, deleted = false;
    let envelope: Uint8Array | null = null;
    let copy: Awaited<ReturnType<ReturnType<typeof createObjectBackupService>["create"]>> | undefined;
    const { service } = setup({
      destination: { name: "independent-store", put: async (_key, value) => { envelope = value; }, get: async () => envelope!, delete: async () => { deleted = true; } },
      catalog: {
        begin: async () => {}, finalizeUploading: async () => {}, markUsable: async () => {}, markFailed: async () => {}, currentUsable: async () => null, listUsable: async () => [], listStaleUploading: async () => [],
        listExpired: async () => copy ? [copy] : [], acknowledgeDeletion: async () => { acknowledged = true; },
      },
    });
    copy = await service.create();
    expect(await service.cleanupExpired()).toBe(1);
    expect(deleted).toBe(true);
    expect(acknowledged).toBe(true);
  });

  it("retries failed deletion of every shard on a later cleanup", async () => {
    const deleted: string[] = [];
    let deny = true, acknowledged = false;
    const copy = { copyId: "failed", objectKey: "objects/failed/catalog.swob", objectCount: 2 } as Awaited<ReturnType<ReturnType<typeof createObjectBackupService>["create"]>>;
    const { service } = setup({
      destination: { name: "independent-store", put: async () => {}, get: async () => new Uint8Array(), delete: async k => { if (deny) throw new Error("outage"); deleted.push(k); } },
      catalog: { begin: async () => {}, finalizeUploading: async () => {}, markUsable: async () => {}, markFailed: async () => {}, currentUsable: async () => null,
        listUsable: async () => [], listStaleUploading: async () => [copy], listExpired: async () => acknowledged ? [] : [copy], acknowledgeDeletion: async () => { acknowledged = true; } },
    });
    await expect(service.cleanupInterrupted()).rejects.toMatchObject({ safeCode: "OBJECT_BACKUP_CLEANUP_FAILED" });
    expect(acknowledged).toBe(false);
    deny = false;
    expect(await service.cleanupExpired()).toBe(1);
    expect(deleted).toEqual(["objects/failed/items/0.swob", "objects/failed/items/1.swob", "objects/failed/catalog.swob"]);
    expect(await service.cleanupExpired()).toBe(0);
  });

  it("marks interrupted uploads unusable before deleting their partial destination object", async () => {
    const events: string[] = [];
    const interrupted = { copyId: "interrupted", objectKey: "objects/00000000-0000-0000-0000-000000000001.swob" } as Awaited<ReturnType<ReturnType<typeof createObjectBackupService>["create"]>>;
    const { service } = setup({
      destination: { name: "independent-store", put: async () => {}, get: async () => new Uint8Array(), delete: async () => { events.push("delete"); } },
      catalog: { begin: async () => {}, finalizeUploading: async () => {}, markUsable: async () => {}, markFailed: async () => { events.push("failed"); }, currentUsable: async () => null,
        listUsable: async () => [], listStaleUploading: async () => [interrupted], listExpired: async () => [], acknowledgeDeletion: async () => {} },
    });
    expect(await service.cleanupInterrupted()).toBe(1);
    expect(events).toEqual(["failed", "delete"]);
  });
});
