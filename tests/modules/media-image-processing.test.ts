import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createMediaProcessingApplicationService, type MediaProcessingCandidate, type MediaProcessingRepositoryPort } from "../../src/modules/media/application/processing.js";
import type { StableId } from "../../src/shared/domain/stable-id.js";

const ownerId = "00000000-0000-7000-8000-000000000101" as StableId<"Owner">;
const mediaId = "00000000-0000-7000-8000-000000000102" as StableId<"MediaAsset">;
const inputObjectId = "00000000-0000-7000-8000-000000000103" as StableId<"MediaObject">;
const uploadIntentId = "00000000-0000-7000-8000-000000000104" as StableId<"MediaUploadIntent">;
const portfolioId = "00000000-0000-7000-8000-000000000105" as StableId<"Portfolio">;
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
const display = new TextEncoder().encode("webp-display");
const thumbnail = new TextEncoder().encode("webp-thumbnail");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const candidate: MediaProcessingCandidate = {
  mediaId, ownerId, portfolioId, kind: "image", declaredMimeType: "image/png", declaredByteLength: png.byteLength, declaredSha256: sha(png),
  originalFileName: "portrait.png", mediaObjectId: inputObjectId, uploadIntentId, expiresAt: "2026-10-11T00:00:00.000Z", aggregateVersion: 1, state: "upload-pending",
};
const command = { actor: { kind: "owner" as const, ownerId, sessionId: "opaque" }, idempotencyKey: "image-key-0001" as never,
  expectedVersion: 1, mediaId, result: "passed" as const, detectedMediaType: "image/png", detectedByteLength: png.byteLength, sha256: sha(png) };

function harness(options: { readonly replay?: boolean; readonly unsafeOutput?: boolean; readonly commitError?: string; readonly fileName?: string; readonly commitDelayMs?: number; readonly advanceBeforeCommitMs?: number; readonly discardError?: boolean; readonly orphanError?: string } = {}) {
  const commits: Parameters<MediaProcessingRepositoryPort["commitAttempt"]>[0][] = [];
  const sealed: Parameters<NonNullable<MediaProcessingRepositoryPort["recordOrphan"]>>[0][] = [];
  const discarded: unknown[] = [];
  let objectSequence = 110;
  const repository: MediaProcessingRepositoryPort = {
    async getCandidate() { return { ok: true, value: { ...candidate, originalFileName: options.fileName ?? candidate.originalFileName } }; },
    async getReplay() { return options.replay ? { ok: true, value: { kind: "replay", version: 2, outcome: "media-processing-recorded" } } : { ok: true, value: { kind: "missing" } }; },
    async claimAttempt() { return { ok: true, value: { kind: "claimed" } }; },
    async commitAttempt(input) {
      commits.push(input);
      if (options.commitDelayMs) {
        const timeoutMs = input.timeoutMs ?? 3_000;
        if (options.commitDelayMs > timeoutMs) return { ok: false, error: { kind: "temporarily_unavailable", code: "MEDIA_PROCESSING_COMMIT_TIMEOUT" } };
      }
      if (options.commitError) return { ok: false, error: { kind: "temporarily_unavailable", code: options.commitError } };
      return { ok: true, value: { version: 2, outcome: "media-processing-recorded" } };
    },
    async recordOrphan(input) { sealed.push(input); return options.orphanError
      ? { ok: false, error: { kind: "temporarily_unavailable" as const, code: options.orphanError } }
      : { ok: true, value: undefined }; },
    async listOrphans() { return { ok: true, value: [] }; },
    async markOrphanReconciled() { return { ok: true, value: undefined }; },
  };
  const scan = vi.fn(async (bytes: Uint8Array, _options?: { readonly timeoutMs?: number }) => ({ ok: true as const, value: { verdict: options.unsafeOutput && bytes === thumbnail ? "unsafe" as const : "clean" as const, version: "ClamAV-1.4.3/27927" } }));
  const sealProcessedObject = vi.fn(async (input: { readonly outputObjectId: StableId<string>; readonly sha256: string }) => {
    return { ok: true as const, value: { objectId: input.outputObjectId, sha256: input.sha256 } };
  });
  const service = createMediaProcessingApplicationService({
    scope: { ownerId }, repository,
    storage: {
      async readCandidate() { return { ok: true as const, value: png }; },
      sealProcessedObject,
      async discardSealedObject(input) { discarded.push(input); if (options.discardError) throw new Error("Storage unavailable"); },
    },
    scanner: { scan },
    processor: { async process() { throw new Error("PDF processor must not run for an image candidate"); } },
    imageProcessor: { async process() {
      if (options.advanceBeforeCommitMs) vi.setSystemTime(Date.now() + options.advanceBeforeCommitMs);
      return { ok: true as const, value: { version: "sharp-0.35.4;libvips-8.17.3", policyVersion: "image-webp-variants-v1", variants: [
      { name: "display" as const, bytes: display, mimeType: "image/webp" as const, width: 16, height: 8 },
      { name: "thumbnail" as const, bytes: thumbnail, mimeType: "image/webp" as const, width: 16, height: 8 },
    ] } }; } },
    digest: { sha256: sha },
    ids: { generate(kind) { if (kind === "MediaProcessingAttempt") return "00000000-0000-7000-8000-000000000109"; if (kind === "MediaProcessingClaim") return "00000000-0000-7000-8000-000000000108"; objectSequence += 1; return `00000000-0000-7000-8000-0000000001${objectSequence}`; } },
    clock: { now: () => "2026-10-11T00:00:00.000Z" },
  });
  return { service, commits, sealed, discarded, scan, sealProcessedObject };
}

describe("Media image processing application interface", () => {
  it("scans source and every output, seals both immutable variants and commits their byte-bound facts", async () => {
    const h = harness();
    expect(await h.service.record(command)).toMatchObject({ ok: true, value: { aggregateVersion: 2 } });
    expect(h.scan).toHaveBeenCalledTimes(3);
    for (const [, options] of h.scan.mock.calls) expect(options?.timeoutMs).toEqual(expect.any(Number));
    expect(h.sealProcessedObject).toHaveBeenCalledTimes(2);
    expect(h.sealProcessedObject).toHaveBeenNthCalledWith(1, expect.objectContaining({ mimeType: "image/webp", bytes: display, sha256: sha(display) }));
    expect(h.commits[0]?.attempt).toMatchObject({
      result: "passed", detectedMimeType: "image/png", inputObjectId, sha256: sha(png),
      outputMimeType: "image/webp", processorVersion: "sharp-0.35.4;libvips-8.17.3", policyVersion: "image-webp-variants-v1",
      variants: [
        { name: "display", sha256: sha(display), byteLength: display.byteLength, mimeType: "image/webp", width: 16, height: 8 },
        { name: "thumbnail", sha256: sha(thumbnail), byteLength: thumbnail.byteLength, mimeType: "image/webp", width: 16, height: 8 },
      ],
    });
  });

  it("does not let a caller's extension choose an image processor for mismatched bytes", async () => {
    const h = harness({ fileName: "upload.jpg" });
    expect(await h.service.record(command)).toMatchObject({ ok: true });
    expect(h.scan).not.toHaveBeenCalled();
    expect(h.sealProcessedObject).not.toHaveBeenCalled();
    expect(h.commits[0]?.attempt).toMatchObject({ result: "failed", findings: ["MEDIA_EXTENSION_MISMATCH"] });
  });

  it("retains no image object when any output is unsafe or the database commit becomes stale", async () => {
    const unsafe = harness({ unsafeOutput: true });
    expect(await unsafe.service.record(command)).toMatchObject({ ok: true });
    expect(unsafe.sealProcessedObject).not.toHaveBeenCalled();
    expect(unsafe.commits[0]?.attempt).toMatchObject({ result: "failed", findings: ["MEDIA_OUTPUT_UNSAFE"] });

    const stale = harness({ commitError: "MEDIA_VERSION_MISMATCH" });
    expect(await stale.service.record(command)).toMatchObject({ ok: false });
    expect(stale.discarded).toHaveLength(2);
    expect(stale.discarded).toEqual(expect.arrayContaining([
      expect.objectContaining({ sha256: sha(display), mimeType: "image/webp" }),
      expect.objectContaining({ sha256: sha(thumbnail), mimeType: "image/webp" }),
    ]));
  });

  it("bounds a database commit by the remaining attempt time and does not report success when that bound expires", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ commitDelayMs: 2_000, advanceBeforeCommitMs: 58_500 });
      const result = await h.service.record(command);
      expect(result).toMatchObject({ ok: false, error: { code: "MEDIA_PROCESSING_COMMIT_TIMEOUT" } });
      expect(h.commits[0]?.timeoutMs).toBeGreaterThan(0);
      expect(h.commits[0]?.timeoutMs).toBeLessThan(2_000);
    } finally { vi.useRealTimers(); }
  });

  it("surfaces orphan persistence failure with the exact private object facts after cleanup fails", async () => {
    const h = harness({ commitError: "MEDIA_VERSION_MISMATCH", discardError: true, orphanError: "DATABASE_UNAVAILABLE" });
    const result = await h.service.record(command);
    expect(result).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable", code: "DATABASE_UNAVAILABLE" } });
    expect(h.discarded).toHaveLength(2);
    expect(h.sealed).toHaveLength(2);
    expect(h.sealed).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidate, objectId: expect.any(String), sha256: sha(display), mimeType: "image/webp" }),
      expect.objectContaining({ candidate, objectId: expect.any(String), sha256: sha(thumbnail), mimeType: "image/webp" }),
    ]));
  });
});
