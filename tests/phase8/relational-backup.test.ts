import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createRelationalBackupService,
  decodeRelationalBackupPayload,
  decryptRelationalBackupEnvelope,
  encryptRelationalBackupEnvelope,
  type RelationalBackupAttempt,
  type RelationalBackupCatalog,
} from "../../src/modules/portability-operations/application/relational-backup.js";
import { createHttpRelationalBackupDestination } from "../../src/modules/portability-operations/adapters/http-relational-backup-destination.js";

const key = Object.freeze({ keyVersion: "backup-key-2026", bytes: Buffer.alloc(32, 7) });
const migrationSql = Buffer.from("create schema recovery_fixture;\n");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const roles = Buffer.from("create role recovery_fixture;\n");
const database = Buffer.from("synthetic postgres archive");
const manifest = Buffer.from(JSON.stringify({ format: "SWDB", version: 1, database: "fixture",
  rolesBytes: roles.byteLength, databaseBytes: database.byteLength,
  rolesSha256: createHash("sha256").update(roles).digest("hex"),
  databaseSha256: createHash("sha256").update(database).digest("hex"),
  migrationHashes: { "20261030000000_recovery_fixture.sql": migrationHash },
  migrationSources: [{ file: "20261030000000_recovery_fixture.sql", sha256: migrationHash, sql: migrationSql.toString("utf8") }] }), "utf8");
const payloadPrefix = Buffer.alloc(8);
payloadPrefix.write("SWDB", 0, "ascii");
payloadPrefix.writeUInt32BE(manifest.byteLength, 4);
const dump = Buffer.concat([payloadPrefix, manifest, roles, database]);
const catalog: RelationalBackupCatalog = Object.freeze({
  version: 1,
  scope: Object.freeze(["application", "operations", "auth", "storage-metadata"]),
  sourceWatermarkAt: "2026-10-30T00:00:00.000Z",
  startedAt: "2026-10-30T00:00:00.000Z",
  completedAt: "2026-10-30T00:00:02.000Z",
  dumpTool: "pg_dump",
  dumpToolVersion: "17.6",
  schemaCount: 9,
  relationCount: 42,
  migrationCount: 1,
  dumpBytes: dump.byteLength,
  complete: true,
  managedMetadata: Object.freeze({
    auth: "database-dump; reset custom credentials from protected secrets after restore",
    storage: "database metadata only; object bytes are backed up separately",
  }),
});

function setup(options: { failPut?: boolean; tamperRead?: boolean; failDelete?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>();
  const attempts = new Map<string, RelationalBackupAttempt>();
  const incidents: string[] = [];
  let counter = 0;
  let nowCounter = 0;
  const service = createRelationalBackupService({
    source: { async capture() { return { dump, catalog }; } },
    destination: {
      name: "off-primary-test",
      async put(objectKey, bytes) {
        if (options.failPut) {
          objects.set(objectKey, Buffer.from(bytes).subarray(0, Math.min(bytes.byteLength, 32)));
          throw new Error("private destination error");
        }
        objects.set(objectKey, Buffer.from(bytes));
      },
      async get(objectKey) {
        const bytes = objects.get(objectKey);
        if (!bytes) throw new Error("missing object");
        if (options.tamperRead) {
          const changed = Buffer.from(bytes);
          changed[changed.length - 20] = changed[changed.length - 20]! ^ 1;
          return changed;
        }
        return bytes;
      },
      async delete(objectKey) {
        if (options.failDelete) throw new Error("private cleanup error");
        objects.delete(objectKey);
      },
    },
    catalog: {
      async begin(attempt) { attempts.set(attempt.copyId, attempt); },
      async markUsable(copyId, verifiedAt, committedAt) {
        const current = attempts.get(copyId)!;
        attempts.set(copyId, Object.freeze({ ...current, state: "usable", verifiedAt, committedAt }));
      },
      async markFailed(copyId, failureCode) {
        const current = attempts.get(copyId);
        if (current) attempts.set(copyId, Object.freeze({ ...current, state: "failed", failureCode }));
      },
      async currentUsable(destinationName) {
        return [...attempts.values()].filter(item => item.destinationName === destinationName && item.state === "usable")
          .sort((a, b) => (b.committedAt ?? "").localeCompare(a.committedAt ?? ""))[0] ?? null;
      },
    },
    incidents: { async recordFailure(code) { incidents.push(code); } },
    key,
    ids: { next() { counter += 1; return "00000000-0000-4000-8000-" + String(counter).padStart(12, "0"); } },
    clock: { now() { nowCounter += 1; return new Date(Date.parse("2026-10-30T01:00:00.000Z") + nowCounter).toISOString(); } },
    retentionLifetimeHours: 168,
  });
  return { service, objects, attempts, incidents };
}

describe("relational backup envelope", () => {
  it("authenticates the archive and versioned source catalog without exposing plaintext", () => {
    const envelope = encryptRelationalBackupEnvelope(dump, catalog, key);
    expect(Buffer.from(envelope).includes(dump)).toBe(false);
    expect(Buffer.from(envelope).includes(key.bytes)).toBe(false);
    const opened = decryptRelationalBackupEnvelope(envelope, key);
    expect(Buffer.from(opened.dump)).toEqual(dump);
    expect(opened.catalog).toEqual(catalog);
    expect(opened.ciphertextSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects missing, wrong, tampered, and incompatible keys without returning plaintext", () => {
    const envelope = encryptRelationalBackupEnvelope(dump, catalog, key);
    expect(() => decryptRelationalBackupEnvelope(envelope, { ...key, keyVersion: "missing-key" })).toThrow();
    expect(() => decryptRelationalBackupEnvelope(envelope, { ...key, bytes: Buffer.alloc(32, 8) })).toThrow();
    const tampered = Buffer.from(envelope);
    tampered[tampered.length - 20] = tampered[tampered.length - 20]! ^ 1;
    expect(() => decryptRelationalBackupEnvelope(tampered, key)).toThrow(/authentication/u);
    expect(() => encryptRelationalBackupEnvelope(dump, catalog, { ...key, bytes: Buffer.alloc(8) })).toThrow(/32 bytes/u);
  });

  it("rejects a tampered encrypted catalog", () => {
    const envelope = Buffer.from(encryptRelationalBackupEnvelope(dump, catalog, key));
    const headerLength = envelope.readUInt32BE(5);
    const ciphertextStart = 9 + headerLength;
    envelope[ciphertextStart + 7] = envelope[ciphertextStart + 7]! ^ 1;
    expect(() => decryptRelationalBackupEnvelope(envelope, key)).toThrow(/authentication/u);
  });

  it("unpacks recovery artifacts and rejects an incomplete or tampered payload", () => {
    const decoded = decodeRelationalBackupPayload(dump);
    expect(Buffer.from(decoded.roles)).toEqual(roles);
    expect(Buffer.from(decoded.database)).toEqual(database);
    expect(decoded.migrations).toEqual([{ file: "20261030000000_recovery_fixture.sql", sha256: migrationHash, sql: migrationSql }]);
    expect(() => decodeRelationalBackupPayload(Buffer.concat([dump, Buffer.from("trailing")]))).toThrow(/trailing/u);
    const tampered = Buffer.from(dump);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    expect(() => decodeRelationalBackupPayload(tampered)).toThrow();
  });
});

describe("relational backup service", () => {
  it("marks a copy usable only after read-back, authenticated decryption, and byte/catalog verification", async () => {
    const { service, attempts, objects } = setup();
    const result = await service.create();
    expect(result.state).toBe("usable");
    expect(result.sourceWatermarkAt).toBe(catalog.sourceWatermarkAt);
    expect(result.committedAt).not.toBe(result.sourceWatermarkAt);
    expect(objects.has(result.objectKey)).toBe(true);
    expect(attempts.get(result.copyId)?.state).toBe("usable");
    expect((await service.verify(result, key)).relationCount).toBe(catalog.relationCount);
    const recovered = await service.recover(result, key);
    expect(Buffer.from(recovered.payload.database)).toEqual(database);
    expect(Buffer.from(recovered.payload.roles)).toEqual(roles);
    expect(recovered.payload.migrations).toHaveLength(1);
    expect(await service.getLastUsable()).toMatchObject({ copyId: result.copyId, state: "usable" });
  });

  it("reads and verifies the off-primary copy after the source becomes unavailable", async () => {
    let sourceAvailable = true;
    const { objects, attempts } = setup();
    const service = createRelationalBackupService({
      source: { async capture() {
        if (!sourceAvailable) throw new Error("source unavailable");
        return { dump, catalog };
      } },
      destination: {
        name: "off-primary-test",
        async put(objectKey, bytes) { objects.set(objectKey, Buffer.from(bytes)); },
        async get(objectKey) { return objects.get(objectKey)!; },
        async delete(objectKey) { objects.delete(objectKey); },
      },
      catalog: {
        async begin(attempt) { attempts.set(attempt.copyId, attempt); },
        async markUsable(copyId, verifiedAt, committedAt) {
          const item = attempts.get(copyId)!;
          attempts.set(copyId, Object.freeze({ ...item, state: "usable", verifiedAt, committedAt }));
        },
        async markFailed(copyId) {
          const item = attempts.get(copyId);
          if (item) attempts.set(copyId, Object.freeze({ ...item, state: "failed" }));
        },
        async currentUsable() { return null; },
      },
      incidents: { async recordFailure() {} }, key,
      ids: { next() { return "00000000-0000-4000-8000-000000000099"; } },
      clock: { now() { return "2026-10-30T01:00:00.000Z"; } }, retentionLifetimeHours: null,
    });
    const copy = await service.create();
    sourceAvailable = false;
    await expect(service.verify(copy, key)).resolves.toMatchObject({ sourceWatermarkAt: catalog.sourceWatermarkAt });
    await expect(service.recover(copy, key)).resolves.toMatchObject({
      payload: { roles, database, migrations: [{ file: "20261030000000_recovery_fixture.sql", sha256: migrationHash, sql: migrationSql }] },
    });
  });

  it("uses bounded retries against the same immutable object key", async () => {
    const { service, objects } = setup();
    const putKeys: string[] = [];
    const retrying = createRelationalBackupService({
      source: { async capture() { return { dump, catalog }; } },
      destination: {
        name: "off-primary-test",
        async put(objectKey, bytes) {
          putKeys.push(objectKey);
          if (putKeys.length < 3) throw new Error("temporary failure");
          objects.set(objectKey, Buffer.from(bytes));
        },
        async get(objectKey) { return objects.get(objectKey)!; },
        async delete(objectKey) { objects.delete(objectKey); },
      },
      catalog: {
        async begin() {}, async markUsable() {}, async markFailed() {}, async currentUsable() { return null; },
      },
      incidents: { async recordFailure() {} }, key,
      ids: { next() { return "00000000-0000-4000-8000-000000000088"; } },
      clock: { now() { return "2026-10-30T01:00:00.000Z"; } }, retentionLifetimeHours: null,
    });
    expect((await retrying.create()).state).toBe("usable");
    expect(putKeys).toHaveLength(3);
    expect(new Set(putKeys).size).toBe(1);
    expect(await service.getLastUsable()).toBeNull();
  });

  it("preserves the prior usable reference and removes a failed partial object", async () => {
    const { service, attempts, objects, incidents } = setup({ failPut: true });
    const old: RelationalBackupAttempt = Object.freeze({
      copyId: "previous", destinationName: "off-primary-test", objectKey: "relational/previous.swab",
      keyVersion: key.keyVersion, dumpTool: catalog.dumpTool, sourceWatermarkAt: catalog.sourceWatermarkAt,
      dumpBytes: dump.byteLength, ciphertextBytes: dump.byteLength + 200, catalogSha256: "a".repeat(64),
      ciphertextSha256: "b".repeat(64), attemptedAt: catalog.startedAt, verifiedAt: catalog.completedAt,
      committedAt: catalog.completedAt, retentionLifetimeHours: 168, expiresAt: null, state: "usable", failureCode: null,
    });
    attempts.set(old.copyId, old);
    objects.set(old.objectKey, Buffer.from("old encrypted copy"));
    await expect(service.create()).rejects.toMatchObject({ safeCode: "BACKUP_ATTEMPT_FAILED" });
    expect(await service.getLastUsable()).toMatchObject({ copyId: "previous", state: "usable" });
    expect([...attempts.values()].filter(item => item.copyId !== old.copyId)[0]?.state).toBe("failed");
    expect(objects.has("relational/00000000-0000-4000-8000-000000000001.swab")).toBe(false);
    expect(incidents).toEqual(["BACKUP_ATTEMPT_FAILED"]);
  });

  it("fails closed when read-back verification fails and emits only a fixed incident code", async () => {
    const { service, objects, incidents } = setup({ tamperRead: true });
    await expect(service.create()).rejects.toMatchObject({ safeCode: "BACKUP_AUTHENTICATION_FAILED" });
    expect(objects.size).toBe(0);
    expect(incidents).toEqual(["BACKUP_AUTHENTICATION_FAILED"]);
  });

  it("returns nonzero and raises the cleanup incident when a failed partial object cannot be removed", async () => {
    const { service, objects, incidents, attempts } = setup({ failPut: true, failDelete: true });
    await expect(service.create()).rejects.toMatchObject({ safeCode: "BACKUP_CLEANUP_FAILED" });
    expect([...attempts.values()][0]?.state).toBe("failed");
    expect([...objects.keys()]).toEqual(["relational/00000000-0000-4000-8000-000000000001.swab"]);
    expect(incidents).toEqual(["BACKUP_CLEANUP_FAILED"]);
  });

  it("rejects incomplete captures before creating a catalog row", async () => {
    const { attempts, incidents } = setup();
    // The explicit capture watermark and catalog completeness gate run before upload.
    const invalid = createRelationalBackupService({
      source: { async capture() { return { dump, catalog: { ...catalog, complete: false } as unknown as RelationalBackupCatalog }; } },
      destination: { name: "off-primary-test", async put() {}, async get() { return dump; }, async delete() {} },
      catalog: {
        async begin(attempt) { attempts.set(attempt.copyId, attempt); },
        async markUsable() {}, async markFailed() {}, async currentUsable() { return null; },
      },
      incidents: { async recordFailure(code) { incidents.push(code); } },
      key, ids: { next() { return "invalid-capture"; } },
      clock: { now() { return "2026-10-30T00:00:00.000Z"; } }, retentionLifetimeHours: null,
    });
    await expect(invalid.create()).rejects.toMatchObject({ safeCode: "BACKUP_SOURCE_INCOMPLETE" });
    expect(attempts.size).toBe(0);
    expect(incidents).toContain("BACKUP_SOURCE_INCOMPLETE");
  });
});

describe("authenticated off-primary HTTP destination", () => {
  it("uploads, retrieves, authenticates, and deletes the encrypted object through an isolated endpoint", async () => {
    const objects = new Map<string, Buffer>();
    const server = createServer((request, response) => {
      if (request.headers.authorization !== "Bearer isolated-test-token") {
        response.writeHead(403).end();
        return;
      }
      const key = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "PUT") {
        const chunks: Buffer[] = [];
        request.on("data", chunk => chunks.push(Buffer.from(chunk)));
        request.on("end", () => { objects.set(key, Buffer.concat(chunks)); response.writeHead(201).end(); });
      } else if (request.method === "GET" && objects.has(key)) {
        response.writeHead(200, { "content-type": "application/octet-stream" }).end(objects.get(key));
      } else if (request.method === "DELETE") {
        objects.delete(key);
        response.writeHead(204).end();
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback test server failed to bind");
    try {
      const destination = createHttpRelationalBackupDestination({
        name: "off-primary-test", baseUrl: "http://127.0.0.1:" + address.port,
        bearerToken: "isolated-test-token", allowLoopbackHttp: true,
      });
      let sourceAvailable = true;
      const rows = new Map<string, RelationalBackupAttempt>();
      const service = createRelationalBackupService({
        source: { async capture() {
          if (!sourceAvailable) throw new Error("primary is unavailable");
          return { dump, catalog };
        } },
        destination,
        catalog: {
          async begin(attempt) { rows.set(attempt.copyId, attempt); },
          async markUsable(copyId, verifiedAt, committedAt) {
            const row = rows.get(copyId)!;
            rows.set(copyId, Object.freeze({ ...row, state: "usable", verifiedAt, committedAt }));
          },
          async markFailed(copyId) {
            const row = rows.get(copyId);
            if (row) rows.set(copyId, Object.freeze({ ...row, state: "failed" }));
          },
          async currentUsable() { return null; },
        },
        incidents: { async recordFailure() {} }, key,
        ids: { next() { return "00000000-0000-4000-8000-000000000011"; } },
        clock: { now() { return "2026-10-30T01:00:00.000Z"; } }, retentionLifetimeHours: 168,
      });
      const copy = await service.create();
      expect(copy.state).toBe("usable");
      expect(objects.size).toBe(1);
      expect([...objects.values()][0]!.includes(dump)).toBe(false);
      sourceAvailable = false;
      await expect(service.verify(copy, key)).resolves.toMatchObject({ sourceWatermarkAt: catalog.sourceWatermarkAt });
      await destination.delete(copy.objectKey);
      expect(objects.size).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("rejects non-TLS remote endpoints and refuses redirects", async () => {
    expect(() => createHttpRelationalBackupDestination({
      name: "off-primary-test", baseUrl: "http://backup.example.net", bearerToken: "test",
    })).toThrow(/HTTPS/u);
    const server = createServer((_request, response) => {
      response.writeHead(302, { location: "https://example.invalid/capture" }).end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback test server failed to bind");
    try {
      const destination = createHttpRelationalBackupDestination({
        name: "off-primary-test", baseUrl: "http://127.0.0.1:" + address.port,
        bearerToken: "isolated-test-token", allowLoopbackHttp: true,
      });
      await expect(destination.put("relational/00000000-0000-4000-8000-000000000012.swab", dump))
        .rejects.toMatchObject({ safeCode: "BACKUP_DESTINATION_UNAVAILABLE" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("fails closed on denied destination access without returning response details", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(403).end("private marker from the storage service");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback test server failed to bind");
    try {
      const destination = createHttpRelationalBackupDestination({
        name: "off-primary-test", baseUrl: "http://127.0.0.1:" + address.port,
        bearerToken: "isolated-test-token", allowLoopbackHttp: true,
      });
      await expect(destination.get("relational/00000000-0000-4000-8000-000000000013.swab"))
        .rejects.toMatchObject({ safeCode: "BACKUP_READBACK_FAILED" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
