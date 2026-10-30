import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHttpObjectBackupDestination } from "../../src/modules/portability-operations/adapters/http-object-backup-destination.js";
import { createObjectBackupService, selectCompatibleRecoverySet, type ObjectBackupAttempt, type ObjectBackupItem } from "../../src/modules/portability-operations/application/object-backup.js";

const image = "public.ecr.aws/localstack/localstack:4.5.0";
const bucket = "phase8-object-backup";
const s3Key = "test", s3Secret = "test";

function hash(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function hmac(key: Uint8Array | string, value: string): Buffer { return createHmac("sha256", key).update(value).digest(); }
function signingKey(date: string): Buffer {
  return hmac(hmac(hmac(hmac("AWS4" + s3Secret, date), "us-east-1"), "s3"), "aws4_request");
}
async function signedS3(endpoint: string, method: string, pathname: string, body = Buffer.alloc(0)): Promise<Response> {
  const target = new URL(pathname, endpoint), payloadHash = hash(body);
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/gu, ""), date = timestamp.slice(0, 8);
  const headers = `host:${target.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${timestamp}`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const request = [method, target.pathname, "", headers, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/us-east-1/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", timestamp, scope, hash(Buffer.from(request))].join("\n");
  const signature = createHmac("sha256", signingKey(date)).update(toSign).digest("hex");
  return fetch(target, { method, ...(method === "GET" || method === "DELETE" ? {} : { body }),
    headers: { "x-amz-content-sha256": payloadHash, "x-amz-date": timestamp,
      authorization: `AWS4-HMAC-SHA256 Credential=${s3Key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` } });
}

describe("isolated S3 object backup evidence", () => {
  it("stores Media, CV variant, and export bytes in disposable S3 and preserves last good after denied upload", async () => {
    const name = `phase8-object-backup-${randomUUID().replaceAll("-", "")}`;
    let port = 0, denyUploads = false, containerStarted = false;
    let evidence: Readonly<{ objects: number; media: number; exports: number }> | null = null;
    const gateway = createServer(async (request, response) => {
      if (request.headers.authorization !== "Bearer isolated-token") { response.writeHead(401).end(); return; }
      const pathname = new URL(request.url!, "http://127.0.0.1").pathname;
      const prefix = "/v1/objects/isolated-store/";
      const objectKey = pathname.startsWith(prefix) ? pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/") : "";
      if (!/^objects\/[0-9a-f-]{36}(?:\.swob|\/(?:catalog\.swob|items\/[0-9]{1,7}\.swob))$/u.test(objectKey)) { response.writeHead(400).end(); return; }
      if (request.method === "PUT" && denyUploads && objectKey.endsWith("/items/1.swob")) { response.writeHead(403).end(); return; }
      const chunks: Buffer[] = [];
      if (request.method === "PUT") for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const upstream = await signedS3(`http://127.0.0.1:${port}`, request.method!, `/${bucket}/${objectKey}`,
        request.method === "PUT" ? Buffer.concat(chunks) : Buffer.alloc(0));
      if (!upstream.ok) { response.writeHead(upstream.status).end(); return; }
      response.writeHead(request.method === "PUT" ? 201 : request.method === "DELETE" ? 204 : 200);
      if (request.method === "GET") response.end(Buffer.from(await upstream.arrayBuffer())); else response.end();
    });
    try {
      execFileSync("docker", ["run", "-d", "--rm", "--name", name, "-e", "SERVICES=s3", "-e", "AWS_DEFAULT_REGION=us-east-1",
        "-p", "127.0.0.1::4566", image], { stdio: "ignore" });
      containerStarted = true;
      const portText = execFileSync("docker", ["port", name, "4566/tcp"], { encoding: "utf8" }).trim();
      port = Number(portText.slice(portText.lastIndexOf(":") + 1));
      if (!Number.isSafeInteger(port) || port < 1) throw new Error("ISOLATED_S3_PORT_INVALID");
      const endpoint = `http://127.0.0.1:${port}`;
      let healthy = false;
      for (let i = 0; i < 90; i += 1) {
        try { const result = await fetch(endpoint + "/_localstack/health"); healthy = result.ok; if (healthy) break; } catch { /* starting */ }
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      if (!healthy) throw new Error("ISOLATED_S3_START_FAILED");
      const created = await signedS3(endpoint, "PUT", `/${bucket}`);
      if (!created.ok) throw new Error("ISOLATED_S3_BUCKET_CREATE_FAILED");
      await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
      const address = gateway.address();
      if (!address || typeof address === "string") throw new Error("ISOLATED_GATEWAY_START_FAILED");
      const destination = createHttpObjectBackupDestination({ name: "isolated-store", baseUrl: `http://127.0.0.1:${address.port}`,
        bearerToken: "isolated-token", allowLoopbackHttp: true });
      const payloads = [Buffer.from("synthetic media original"), Buffer.from("synthetic accepted CV variant"), Buffer.from("eligible owner export")];
      const items: ObjectBackupItem[] = payloads.map((data, index) => ({ kind: index === 2 ? "owner-export" : "media",
        portfolioId: "portfolio-fixture", ...(index === 2 ? { exportId: "export-fixture" } : { mediaId: `media-${index}` }),
        objectId: `object-${index}`, source: index === 1 ? "variant" : index === 2 ? "export-artifact" : "original",
        variantName: index === 1 ? "cv-pdf" : index === 2 ? "owner-export" : "original",
        mediaType: index === 2 ? "application/zip" : index === 1 ? "application/pdf" : "image/png",
        byteLength: data.length, sha256: hash(data), eligibleAt: "2026-10-29T00:00:00.000Z", expiresAt: null,
        read: async () => Buffer.from(data) }));
      let id = 1, usable: ObjectBackupAttempt | null = null;
      const attempts: ObjectBackupAttempt[] = [];
      const service = createObjectBackupService({
        source: { capture: async () => ({ sourceWatermarkAt: "2026-10-29T00:00:00.000Z", relationalWatermarkAt: "2026-10-30T00:00:00.000Z", items }) },
        destination, catalog: { begin: async attempt => { attempts.push(attempt); }, finalizeUploading: async attempt => {
          const position = attempts.findIndex(current => current.copyId === attempt.copyId); attempts[position] = attempt;
        }, markUsable: async (copyId, verifiedAt, committedAt) => {
          usable = { ...attempts.find(attempt => attempt.copyId === copyId)!, state: "usable", verifiedAt, committedAt };
        }, markFailed: async () => {}, currentUsable: async () => usable, listUsable: async () => usable ? [usable] : [],
        listStaleUploading: async () => [], listExpired: async () => [], acknowledgeDeletion: async () => {} },
        incidents: { recordFailure: async () => {} }, key: { keyVersion: "isolated-v1", bytes: Buffer.alloc(32, 9) },
        ids: { next: () => `00000000-0000-4000-8000-${String(id++).padStart(12, "0")}` },
        clock: { now: () => "2026-10-30T00:00:00.000Z" }, retentionLifetimeHours: 168,
      });
      const first = await service.create();
      expect(first.catalog.objects.map(object => object.objectId)).toEqual(["object-0", "object-1", "object-2"]);
      expect(first.catalog.mediaCount).toBe(2);
      expect(first.catalog.exportCount).toBe(1);
      const requiredIds = first.catalog.objects.map(object => object.objectId);
      expect(selectCompatibleRecoverySet({ relational: { sourceWatermarkAt: first.relationalWatermarkAt },
        object: first.catalog, requiredObjectIds: requiredIds, integrity: "full" }).compatible).toBe(true);
      expect(selectCompatibleRecoverySet({ relational: { sourceWatermarkAt: first.relationalWatermarkAt }, object: first.catalog,
        requiredObjectIds: [...requiredIds, "newer-required-object"], integrity: "full" }).compatible).toBe(false);
      const independent = await signedS3(endpoint, "GET", `/${bucket}/${first.objectKey}`);
      const stored = Buffer.from(await independent.arrayBuffer());
      expect(stored.byteLength + first.catalog.objects.reduce((total, descriptor) => total + descriptor.backupCiphertextBytes!, 0)).toBe(first.ciphertextBytes);
      expect(stored.includes(payloads[0]!)).toBe(false);
      const recovered = await service.recover(first, { keyVersion: "isolated-v1", bytes: Buffer.alloc(32, 9) });
      expect(recovered.objects.map(object => Buffer.from(object.bytes))).toEqual(payloads);
      const shardKey = first.catalog.objects[0]!.backupObjectKey!;
      const shardResponse = await signedS3(endpoint, "GET", `/${bucket}/${shardKey}`);
      const shardBytes = Buffer.from(await shardResponse.arrayBuffer());
      expect(shardResponse.ok).toBe(true);
      expect((await signedS3(endpoint, "PUT", `/${bucket}/${shardKey}`, Buffer.alloc(shardBytes.length, 0x41))).ok).toBe(true);
      await expect(service.recover(first, { keyVersion: "isolated-v1", bytes: Buffer.alloc(32, 9) }))
        .rejects.toMatchObject({ safeCode: "OBJECT_BACKUP_CIPHERTEXT_MISMATCH" });
      expect((await signedS3(endpoint, "PUT", `/${bucket}/${shardKey}`, shardBytes)).ok).toBe(true);
      expect((await signedS3(endpoint, "DELETE", `/${bucket}/${shardKey}`)).ok).toBe(true);
      await expect(service.recover(first, { keyVersion: "isolated-v1", bytes: Buffer.alloc(32, 9) }))
        .rejects.toMatchObject({ safeCode: "OBJECT_BACKUP_READBACK_FAILED" });
      expect((await signedS3(endpoint, "PUT", `/${bucket}/${shardKey}`, shardBytes)).ok).toBe(true);
      const objectPath = `/${bucket}/${first.objectKey}`;
      const corrupted = await signedS3(endpoint, "PUT", objectPath, Buffer.alloc(stored.length, 0x41));
      expect(corrupted.ok).toBe(true);
      await expect(service.recover(first, { keyVersion: "isolated-v1", bytes: Buffer.alloc(32, 9) }))
        .rejects.toMatchObject({ safeCode: "OBJECT_BACKUP_CIPHERTEXT_MISMATCH" });
      const restored = await signedS3(endpoint, "PUT", objectPath, stored);
      expect(restored.ok).toBe(true);
      const deleted = await signedS3(endpoint, "DELETE", objectPath);
      expect(deleted.ok).toBe(true);
      await expect(service.recover(first, { keyVersion: "isolated-v1", bytes: Buffer.alloc(32, 9) }))
        .rejects.toMatchObject({ safeCode: "OBJECT_BACKUP_READBACK_FAILED" });
      const restoredAgain = await signedS3(endpoint, "PUT", objectPath, stored);
      expect(restoredAgain.ok).toBe(true);
      denyUploads = true;
      await expect(service.create()).rejects.toMatchObject({ safeCode: "OBJECT_BACKUP_UPLOAD_FAILED" });
      expect(await service.getLastUsable()).toBe(usable);
      const partialObject = await signedS3(endpoint, "GET", `/${bucket}/objects/00000000-0000-4000-8000-000000000002/items/0.swob`);
      expect(partialObject.status).toBe(404);
      evidence = { objects: recovered.objects.length, media: recovered.catalog.mediaCount, exports: recovered.catalog.exportCount };
    } finally {
      if (gateway.listening) await new Promise<void>(resolve => gateway.close(() => resolve()));
      if (containerStarted) execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
      if (evidence) process.stdout.write(JSON.stringify({ evidence: "isolated-s3", ...evidence, ciphertextVerified: true,
        plaintextAbsent: true, deniedUploadPreservedLastGood: true, ownedContainerRemoved: true }) + "\n");
    }
  }, 180_000);
});
