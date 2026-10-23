import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildConfigurationOwnerExportPackage, type OwnerExportConfigurationSnapshot } from "../../src/modules/portability-operations/application/owner-export-package.js";
import { MAX_OWNER_EXPORT_ARTIFACT_BYTES, validateOwnerExportObjectRead } from "../../src/modules/portability-operations/application/service.js";
import type { PortfolioSettings } from "../../src/modules/portfolio-configuration/domain/index.js";
import { createSupabaseOwnerExportStorage } from "../../src/runtime/adapters/supabase-owner-export-storage.js";
import { validateOwnerExportZip } from "../../scripts/owner-export/validator.mjs";

const stableId = (tail: string) => `0196a1b2-7c3d-7e11-9f22-${tail.padStart(12, "0")}`;
const portfolioId = stableId("1") as PortfolioSettings["portfolioId"];
const exportId = stableId("2") as Parameters<typeof buildConfigurationOwnerExportPackage>[0]["exportId"];

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

describe("configuration Owner export assembly", () => {
  it("emits the retained configuration version, locales and capabilities in a validator-approved 1.2 package", () => {
    const settings: PortfolioSettings = {
      portfolioId,
      version: 42,
      profile: { displayName: "Ada", headline: "Builder", bio: "A retained profile." },
      contactChannels: [{ channel: "email", label: "Email", destination: "ada@example.test", availableLocales: ["en", "ar"] }],
      globalCta: { label: "Work together", destination: "https://example.test/work", unavailableFallback: "Contact me" },
    };
    const built = buildConfigurationOwnerExportPackage({ exportId, snapshot: snapshot(settings, 42) });
    const validated = validateOwnerExportZip(built.bytes);
    const record = JSON.parse(new TextDecoder().decode(zipEntry(built.bytes, "records/portfolio-configuration.ndjson"))) as unknown;

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
  });

  it("represents an explicitly empty selected configuration scope as zero-byte NDJSON", () => {
    const built = buildConfigurationOwnerExportPackage({ exportId, snapshot: snapshot(null, null) });
    const validated = validateOwnerExportZip(built.bytes);
    const [entry] = validated.manifest.entries;

    expect(entry).toMatchObject({
      scope: "portfolio-configuration",
      mediaType: "application/x-ndjson",
      digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      recordCount: 0,
    });
    expect(zipEntry(built.bytes, "records/portfolio-configuration.ndjson")).toHaveLength(0);
    expect(MAX_OWNER_EXPORT_ARTIFACT_BYTES).toBe(64 * 1024 * 1024);
  });

  it("streams an archive larger than 25 MB with bounded queueing and rejects limit-plus-one", async () => {
    const totalBytes = 26_000_000;
    const chunk = new Uint8Array(64 * 1024).fill(7);
    const digest = createHash("sha256");
    for (let remaining = totalBytes; remaining > 0; remaining -= chunk.byteLength) {
      digest.update(chunk.subarray(0, Math.min(chunk.byteLength, remaining)));
    }
    const expectedSha256 = digest.digest("hex");
    let produced = 0;
    let consumed = 0;
    let maxQueued = 0;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= totalBytes) { controller.close(); return; }
        const next = chunk.subarray(0, Math.min(chunk.byteLength, totalBytes - produced));
        produced += next.byteLength;
        maxQueued = Math.max(maxQueued, produced - consumed);
        controller.enqueue(next);
      },
    }), { headers: { "content-length": String(totalBytes) } });
    const storage = createSupabaseOwnerExportStorage({
      storageUrl: "http://127.0.0.1:54321",
      serviceRoleKey: "test-service-role-key",
      fetcher: async () => response,
    });
    const read = await storage.readOwnerExport({
      portfolioId,
      exportId,
      artifactId: stableId("3") as OwnerExportConfigurationSnapshot["snapshotId"],
      expectedSha256,
      expectedContentLength: totalBytes,
    });
    expect(read.ok).toBe(true);
    let streamed = 0;
    if (read.ok) {
      for await (const part of read.value.content) {
        consumed += part.byteLength;
        streamed += part.byteLength;
      }
    }
    expect(streamed).toBe(totalBytes);
    expect(maxQueued).toBeLessThanOrEqual(2 * 64 * 1024);
    const oversized = validateOwnerExportObjectRead({
      contentLength: MAX_OWNER_EXPORT_ARTIFACT_BYTES + 1,
      sha256: expectedSha256,
      content: (async function* () { yield chunk; })(),
    });
    expect(oversized.ok).toBe(false);
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
