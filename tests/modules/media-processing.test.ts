import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createMediaProcessingApplicationService, type MediaProcessingCandidate, type MediaProcessingRepositoryPort } from "../../src/modules/media/application/processing.js";
import type { StableId } from "../../src/shared/domain/stable-id.js";

const ownerId = "00000000-0000-7000-8000-000000000001" as StableId<"Owner">;
const mediaId = "00000000-0000-7000-8000-000000000002" as StableId<"MediaAsset">;
const inputObjectId = "00000000-0000-7000-8000-000000000003" as StableId<"MediaObject">;
const uploadIntentId = "00000000-0000-7000-8000-000000000004" as StableId<"MediaUploadIntent">;
const outputObjectId = "00000000-0000-7000-8000-000000000005" as StableId<"MediaObject">;
const pdf = new TextEncoder().encode("%PDF-1.7\ntrusted test bytes\n%%EOF");
const output = new TextEncoder().encode("%PDF-1.7\nprocessed bytes\n%%EOF");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const candidate: MediaProcessingCandidate = {
  mediaId, ownerId, portfolioId: "00000000-0000-7000-8000-000000000006" as StableId<"Portfolio">, kind: "document",
  declaredMimeType: "application/pdf", declaredByteLength: pdf.byteLength, declaredSha256: sha(pdf),
  mediaObjectId: inputObjectId, uploadIntentId, expiresAt: "2026-10-11T00:00:00.000Z", aggregateVersion: 1, state: "upload-pending",
  originalFileName: "document.pdf",
};
const command = {
  actor: { kind: "owner" as const, ownerId, sessionId: "opaque" }, idempotencyKey: "idempotency-key-0001" as never,
  expectedVersion: 1, mediaId, result: "passed" as const, detectedMediaType: "application/pdf", detectedByteLength: pdf.byteLength, sha256: sha(pdf),
};

function harness(options: { readonly state?: MediaProcessingCandidate["state"]; readonly replay?: boolean; readonly commitError?: string; readonly bytes?: Uint8Array; readonly elapsedDuringScanMs?: number; readonly fileName?: string; readonly scannerUnavailable?: boolean; readonly sealedObjectId?: StableId<"MediaObject"> } = {}) {
  const commits: Parameters<MediaProcessingRepositoryPort["commitAttempt"]>[0][] = [];
  const orphanCalls: Parameters<MediaProcessingRepositoryPort["recordOrphan"]>[0][] = [];
  const marks: unknown[] = [];
  let nowMs = Date.parse("2026-10-10T20:00:00.000Z");
  const read = vi.fn(async () => ({ ok: true as const, value: options.bytes ?? pdf }));
  const scan = vi.fn(async () => {
    nowMs += options.elapsedDuringScanMs ?? 0;
    return { ok: true as const, value: { verdict: "clean" as const, version: "ClamAV pinned" } };
  });
  const process = vi.fn(async () => ({ ok: true as const, value: { bytes: output, version: "OCRmyPDF pinned", policyVersion: "pdf-policy-1" } }));
  const discard = vi.fn(async () => undefined);
  const repository: MediaProcessingRepositoryPort = {
    async getCandidate() { return { ok: true, value: { ...candidate, state: options.state ?? candidate.state, originalFileName: options.fileName ?? candidate.originalFileName } }; },
    async getReplay() { return options.replay ? { ok: true, value: { kind: "replay", version: 2, outcome: "media-processing-recorded" } } : { ok: true, value: { kind: "missing" } }; },
    async claimAttempt(input) {
      if (["processed", "accepted", "rejected"].includes(options.state ?? candidate.state)) return { ok: true, value: { kind: "invalid-transition" } };
      if (input.candidate.aggregateVersion !== input.expectedVersion) return { ok: true, value: { kind: "version-mismatch" } };
      return { ok: true, value: { kind: "claimed" } };
    },
    async commitAttempt(input) {
      commits.push(input);
      if (options.commitError) return { ok: false, error: { kind: "temporarily_unavailable", code: options.commitError } };
      return { ok: true, value: { version: 2, outcome: "media-processing-recorded", ...(input.attempt.temporaryFailure ? { failureCode: input.attempt.findings[0] } : {}) } };
    },
    async recordOrphan(input) { orphanCalls.push(input); return { ok: true, value: undefined }; },
    async listOrphans() { return { ok: true, value: orphanCalls.map((item) => ({ mediaId: item.candidate.mediaId, portfolioId: item.candidate.portfolioId, objectId: item.objectId, sha256: item.sha256 })) }; },
    async markOrphanReconciled(input) { marks.push(input); return { ok: true, value: undefined }; },
  };
  const service = createMediaProcessingApplicationService({
    scope: { ownerId }, repository,
    storage: {
      readCandidate: read,
      async sealProcessedObject(input) { return { ok: true, value: { objectId: options.sealedObjectId ?? outputObjectId, sha256: input.sha256 } }; },
      discardSealedObject: discard,
    },
    scanner: { scan: options.scannerUnavailable ? vi.fn(async () => ({ ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "MEDIA_SCANNER_UNAVAILABLE" } })) : scan }, processor: { process },
    digest: { sha256: sha },
    ids: { generate(kind) { return kind === "MediaProcessingAttempt" ? "00000000-0000-7000-8000-000000000007" : outputObjectId; } },
    clock: { now: () => new Date(nowMs).toISOString() },
  });
  return { service, commits, orphanCalls, marks, read, scan, process, discard };
}

describe("trusted PDF media processing", () => {
  it("binds real input facts, scans and processes both byte streams, then records immutable output evidence", async () => {
    const h = harness();
    const result = await h.service.record(command);
    expect(result).toMatchObject({ ok: true, value: { aggregateId: mediaId, aggregateVersion: 2, outcome: "media-processing-recorded" } });
    expect(h.scan).toHaveBeenCalledTimes(2);
    expect(h.process).toHaveBeenCalledWith(pdf);
    expect(h.commits[0]?.attempt).toMatchObject({ result: "passed", inputObjectId, outputObjectId, sha256: sha(pdf), outputSha256: sha(output), scannerVersion: "ClamAV pinned", processorVersion: "OCRmyPDF pinned", policyVersion: "pdf-policy-1" });
  });

  it("records mismatched caller verdicts as failed and never scans them", async () => {
    const h = harness();
    const result = await h.service.record({ ...command, result: "failed", sha256: "f".repeat(64) });
    expect(result.ok).toBe(true);
    expect(h.commits[0]?.attempt).toMatchObject({ result: "failed", findings: ["MEDIA_CALLER_FACTS_MISMATCH"] });
    expect(h.scan).not.toHaveBeenCalled();
    expect(h.commits[0]?.attempt.outputObjectId).toBeUndefined();
  });

  it("rejects a declared PDF when actual bytes are not PDF and persists a sanitized failure", async () => {
    const h = harness({ bytes: new TextEncoder().encode("<html>spoofed</html>") });
    const result = await h.service.record(command);
    expect(result.ok).toBe(true);
    expect(h.commits[0]?.attempt).toMatchObject({ result: "failed", detectedMimeType: "application/octet-stream", findings: ["MEDIA_DECLARATION_MISMATCH"] });
    expect(h.scan).not.toHaveBeenCalled();
  });

  it("rejects a non-PDF original filename before reading or scanning bytes", async () => {
    const h = harness({ fileName: "report.png" });
    expect(await h.service.record(command)).toMatchObject({ ok: false, error: { code: "MEDIA_EXTENSION_MISMATCH" } });
    expect(h.read).not.toHaveBeenCalled();
    expect(h.scan).not.toHaveBeenCalled();
  });

  it("returns a typed temporary failure and preserves a fresh-key retry path after scanner outage", async () => {
    const h = harness({ scannerUnavailable: true });
    expect(await h.service.record(command)).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable", code: "MEDIA_SCANNER_UNAVAILABLE" } });
    expect(h.commits[0]?.attempt).toMatchObject({ result: "failed", temporaryFailure: true, findings: ["MEDIA_SCANNER_UNAVAILABLE"] });
  });

  it("discards and records an adapter-returned object when it violates the requested output ID", async () => {
    const wrongId = "00000000-0000-7000-8000-000000000099" as StableId<"MediaObject">;
    const h = harness({ sealedObjectId: wrongId });
    expect(await h.service.record(command)).toMatchObject({ ok: true });
    expect(h.discard).toHaveBeenCalledWith({ portfolioId: candidate.portfolioId, mediaId, objectId: wrongId, sha256: sha(output), mimeType: "application/pdf" });
    expect(h.commits[0]?.attempt).toMatchObject({ result: "failed", findings: ["MEDIA_OUTPUT_OBJECT_MISMATCH"] });
  });

  it("does not process terminal candidates or replay an exact successful key twice", async () => {
    const terminal = harness({ state: "accepted" });
    expect((await terminal.service.record(command)).ok).toBe(false);
    expect(terminal.read).not.toHaveBeenCalled();
    const replay = harness({ replay: true });
    expect(await replay.service.record(command)).toMatchObject({ ok: true, value: { aggregateVersion: 2 } });
    expect(replay.read).not.toHaveBeenCalled();
    expect(replay.commits).toHaveLength(0);
    const processed = harness({ state: "processed" });
    expect(await processed.service.record(command)).toMatchObject({ ok: false, error: { code: "MEDIA_INVALID_TRANSITION" } });
    expect(processed.read).not.toHaveBeenCalled();
    expect(processed.scan).not.toHaveBeenCalled();
    expect(processed.process).not.toHaveBeenCalled();
    expect(processed.commits).toHaveLength(0);
  });

  it("records an over-budget processing attempt as a failure before PDF processing", async () => {
    const h = harness({ elapsedDuringScanMs: 60_001 });
    const result = await h.service.record(command);
    expect(result).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable", code: "MEDIA_PROCESSING_TIMEOUT" } });
    expect(h.commits[0]?.attempt).toMatchObject({ result: "failed", findings: ["MEDIA_PROCESSING_TIMEOUT"] });
    expect(h.process).not.toHaveBeenCalled();
  });

  it("discards a sealed private output when the commit becomes stale", async () => {
    const h = harness({ commitError: "MEDIA_VERSION_MISMATCH" });
    expect((await h.service.record(command)).ok).toBe(false);
    expect(h.discard).toHaveBeenCalledWith({ portfolioId: candidate.portfolioId, mediaId, objectId: outputObjectId, sha256: sha(output), mimeType: "application/pdf" });
  });

  it("records private orphan metadata when cleanup fails and retries only the exact object", async () => {
    const h = harness({ commitError: "MEDIA_VERSION_MISMATCH" });
    h.discard.mockRejectedValueOnce(new Error("Storage unavailable"));
    expect((await h.service.record(command)).ok).toBe(false);
    expect(h.orphanCalls).toHaveLength(1);
    expect(await h.service.reconcileOrphanedOutputs()).toEqual({ ok: true, value: { reconciled: 1 } });
    expect(h.marks).toHaveLength(1);
    expect(h.discard).toHaveBeenCalledTimes(2);
  });
});
