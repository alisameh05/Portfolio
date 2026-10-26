import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  buildConfigurationOwnerExportPackage,
  createStoredOwnerExportZip,
  measureOwnerExportStream,
  type OwnerExportConfigurationSnapshot,
} from "../../src/modules/portability-operations/application/owner-export-package.js";
import { MAX_OWNER_EXPORT_ARTIFACT_BYTES, validateOwnerExportObjectRead } from "../../src/modules/portability-operations/application/service.js";
import type { PortfolioSettings } from "../../src/modules/portfolio-configuration/domain/index.js";
import { createSupabaseOwnerExportStorage } from "../../src/runtime/adapters/supabase-owner-export-storage.js";
import { validateOwnerExportZip } from "../../scripts/owner-export/validator.mjs";

const stableId = (tail: string) => `0196a1b2-7c3d-7e11-9f22-${tail.padStart(12, "0")}`;
const portfolioId = stableId("1") as PortfolioSettings["portfolioId"];
const exportId = stableId("2") as Parameters<typeof buildConfigurationOwnerExportPackage>[0]["exportId"];

it("deletes only the exact owned ZIP, reconciles missing objects, and reports retryable failures", async () => {
  let calls = 0;
  const identity = { portfolioId, exportId, artifactId: stableId("3") as OwnerExportConfigurationSnapshot["snapshotId"] };
  const storage = createSupabaseOwnerExportStorage({ storageUrl: 'http://127.0.0.1:54321', serviceRoleKey: 'synthetic-key',
    fetcher: async (url, init) => {
      expect(String(url)).toBe('http://127.0.0.1:54321/storage/v1/object/owner-exports');
      expect(init?.method).toBe('DELETE');
      expect(JSON.parse(String(init?.body))).toEqual({ prefixes: [`${portfolioId}/${exportId}/${identity.artifactId}.zip`] });
      calls++;
      if (calls === 1) return new Response(null, { status: 503 });
      if (calls === 3) return Response.json({ code: "NoSuchKey" }, { status: 404 });
      if (calls === 4) return Response.json({ code: "NoSuchBucket" }, { status: 404 });
      return new Response('[]', { status: 200 });
    } });
  expect(await storage.deleteOwnerExport({ ...identity, artifactId: '../source' as typeof identity.artifactId })).toMatchObject({ ok: false });
  expect(calls).toBe(0);
  expect(await storage.deleteOwnerExport(identity)).toMatchObject({ ok: false, error: { kind: 'temporarily_unavailable' } });
  expect(await storage.deleteOwnerExport(identity)).toMatchObject({ ok: true });
  expect(await storage.deleteOwnerExport(identity)).toMatchObject({ ok: true });
  expect(await storage.deleteOwnerExport(identity)).toMatchObject({ ok: false, error: { kind: 'temporarily_unavailable' } });
  expect(await storage.deleteOwnerExport(identity)).toMatchObject({ ok: true });
});

function snapshot(settings: PortfolioSettings | null, version: number | null): OwnerExportConfigurationSnapshot {
  return {
    snapshotId: stableId("3") as OwnerExportConfigurationSnapshot["snapshotId"],
    capturedAt: "2026-10-23T10:00:00.000Z",
    configurationVersion: version,
    settings,
    capabilities: { currentCvAvailable: true, externalLinksAvailable: false, globalProjectCtaAvailable: settings !== null },
  };
}

function zipEntry(bytes: Uint8Array, expectedName: string): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const length = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    const contentStart = nameStart + nameLength + extraLength;
    if (name === expectedName) return bytes.subarray(contentStart, contentStart + length);
    offset = contentStart + length;
  }
  throw new Error(`Missing ZIP entry: ${expectedName}`);
}

async function collectBytes(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of content) { chunks.push(chunk); size += chunk.byteLength; }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

describe("configuration Owner export assembly", () => {
  it("emits the retained configuration version, locales and capabilities in a validator-approved 1.2 package", async () => {
    const settings: PortfolioSettings = {
      portfolioId,
      version: 42,
      profile: { displayName: "Ada", headline: "Builder", bio: "A retained profile." },
      contactChannels: [{ channel: "email", label: "Email", destination: "ada@example.test", availableLocales: ["en", "ar"] }],
      globalCta: { label: "Work together", destination: "https://example.test/work", unavailableFallback: "Contact me" },
    };
    const built = await buildConfigurationOwnerExportPackage({ exportId, snapshot: snapshot(settings, 42) });
    const bytes = await collectBytes(built.content);
    const validated = validateOwnerExportZip(bytes);
    const record = JSON.parse(new TextDecoder().decode(zipEntry(bytes, "records/portfolio-configuration.ndjson"))) as unknown;

    expect(validated.manifest.schemaVersion).toBe("1.2");
    expect(validated.manifest.extensions).toMatchObject({
      configurationSnapshot: {
        aggregateVersion: 42,
        availableLocales: ["ar", "en"],
        capabilities: { currentCvAvailable: true, externalLinksAvailable: false, globalProjectCtaAvailable: true },
      },
    });
    expect(record).toMatchObject({
      scope: "portfolio-configuration",
      value: {
        profile: { displayName: "Ada" },
        contactChannels: { channels: [{ availableLocales: ["en", "ar"] }] },
        projectCta: { unavailableFallback: "Contact me" },
      },
    });
    expect(built.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(built.contentLength).toBe(bytes.byteLength);
  });

  it("keeps configuration package bytes stable when persisted JSON key order changes", async () => {
    const firstSettings: PortfolioSettings = {
      portfolioId,
      version: 42,
      profile: { displayName: "Ada", headline: "Builder", bio: "A retained profile." },
      contactChannels: [{ channel: "email", label: "Email", destination: "ada@example.test", availableLocales: ["en", "ar"] }],
      globalCta: { label: "Work together", destination: "https://example.test/work", unavailableFallback: "Contact me" },
    };
    const restoredSettings: PortfolioSettings = {
      portfolioId,
      version: 42,
      profile: { bio: "A retained profile.", headline: "Builder", displayName: "Ada" },
      contactChannels: [{ availableLocales: ["en", "ar"], destination: "ada@example.test", label: "Email", channel: "email" }],
      globalCta: { unavailableFallback: "Contact me", destination: "https://example.test/work", label: "Work together" },
    };

    const first = await buildConfigurationOwnerExportPackage({ exportId, snapshot: snapshot(firstSettings, 42) });
    const restored = await buildConfigurationOwnerExportPackage({ exportId, snapshot: snapshot(restoredSettings, 42) });

    expect(restored.contentLength).toBe(first.contentLength);
    expect(restored.sha256).toBe(first.sha256);
  });

  it("represents an explicitly empty selected configuration scope as zero-byte NDJSON", async () => {
    const built = await buildConfigurationOwnerExportPackage({ exportId, snapshot: snapshot(null, null) });
    const bytes = await collectBytes(built.content);
    const validated = validateOwnerExportZip(bytes);
    const [entry] = validated.manifest.entries;

    expect(entry).toMatchObject({
      scope: "portfolio-configuration",
      mediaType: "application/x-ndjson",
      digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      recordCount: 0,
    });
    expect(zipEntry(bytes, "records/portfolio-configuration.ndjson")).toHaveLength(0);
    expect(MAX_OWNER_EXPORT_ARTIFACT_BYTES).toBe(64 * 1024 * 1024);
  });

  it("generates and uploads an archive larger than 25 MB with bounded backpressure and rejects limit-plus-one", async () => {
    const totalBytes = 26_000_000;
    const chunk = new Uint8Array(64 * 1024).fill(7);
    let pressureMeasurement = false;
    let produced = 0;
    let consumedPayload = 0;
    let maxQueued = 0;
    const syntheticContent = () => ({
      async *[Symbol.asyncIterator]() {
        let generated = 0;
        while (generated < totalBytes) {
          const next = chunk.subarray(0, Math.min(chunk.byteLength, totalBytes - generated));
          generated += next.byteLength;
          if (pressureMeasurement) {
            produced += next.byteLength;
            maxQueued = Math.max(maxQueued, produced - consumedPayload);
          }
          yield next;
        }
      },
    });
    const memberIntegrity = await measureOwnerExportStream(syntheticContent());
    const archive = createStoredOwnerExportZip([{
      name: "records/synthetic.ndjson",
      contentLength: memberIntegrity.contentLength,
      crc32: memberIntegrity.crc32,
      content: syntheticContent,
    }]);
    const archiveIntegrity = await measureOwnerExportStream(archive.content);
    expect(archiveIntegrity.contentLength).toBeGreaterThan(25_000_000);
    let uploadedLength = 0;
    let uploadCalls = 0;
    const storage = createSupabaseOwnerExportStorage({
      storageUrl: "http://127.0.0.1:54321",
      serviceRoleKey: "test-service-role-key",
      fetcher: async (_url, init) => {
        uploadCalls += 1;
        expect(init?.headers).toMatchObject({ "content-length": String(archiveIntegrity.contentLength), "x-upsert": "false" });
        const reader = (init?.body as ReadableStream<Uint8Array>).getReader();
        const digest = createHash("sha256");
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          uploadedLength += next.value.byteLength;
          digest.update(next.value);
          if (next.value.byteLength > 0 && next.value.every((byte) => byte === 7)) consumedPayload += next.value.byteLength;
        }
        expect(digest.digest("hex")).toBe(archiveIntegrity.sha256);
        return new Response(null, { status: 201 });
      },
    });
    pressureMeasurement = true;
    const written = await storage.writeOwnerExport({
      portfolioId,
      exportId,
      artifactId: stableId("3") as OwnerExportConfigurationSnapshot["snapshotId"],
      content: archive.content,
      contentLength: archiveIntegrity.contentLength,
      sha256: archiveIntegrity.sha256,
    });
    expect(written.ok).toBe(true);
    expect(uploadedLength).toBe(archiveIntegrity.contentLength);
    expect(maxQueued).toBeLessThanOrEqual(2 * 64 * 1024);
    const oversized = validateOwnerExportObjectRead({
      contentLength: MAX_OWNER_EXPORT_ARTIFACT_BYTES + 1,
      sha256: archiveIntegrity.sha256,
      content: (async function* () { yield chunk; })(),
    });
    expect(oversized.ok).toBe(false);
    const oversizedArchive = () => createStoredOwnerExportZip([{
      name: "records/too-large.ndjson",
      contentLength: MAX_OWNER_EXPORT_ARTIFACT_BYTES + 1,
      crc32: 0,
      content: async function* () { },
    }]);
    expect(oversizedArchive).toThrow("OWNER_EXPORT_ARTIFACT_LIMIT_EXCEEDED");
    const rejectedWrite = await storage.writeOwnerExport({
      portfolioId,
      exportId,
      artifactId: stableId("3") as OwnerExportConfigurationSnapshot["snapshotId"],
      content: (async function* () { })(),
      contentLength: MAX_OWNER_EXPORT_ARTIFACT_BYTES + 1,
      sha256: archiveIntegrity.sha256,
    });
    expect(rejectedWrite.ok).toBe(false);
    expect(uploadCalls).toBe(1);
  });

  it("propagates interrupted object streams instead of reporting a complete download", async () => {
    const controllerError = new Error("storage stream interrupted");
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(1, 2));
        controller.error(controllerError);
      },
    }), { headers: { "content-length": "4" } });
    const storage = createSupabaseOwnerExportStorage({
      storageUrl: "http://127.0.0.1:54321",
      serviceRoleKey: "test-service-role-key",
      fetcher: async () => response,
    });
    const read = await storage.readOwnerExport({
      portfolioId,
      exportId,
      artifactId: stableId("3") as OwnerExportConfigurationSnapshot["snapshotId"],
      expectedSha256: "a".repeat(64),
      expectedContentLength: 4,
    });
    expect(read.ok).toBe(true);
    if (read.ok) {
      await expect(async () => {
        for await (const _part of read.value.content) { /* drain the response */ }
      }).rejects.toThrow("storage stream interrupted");
    }
  });
});
