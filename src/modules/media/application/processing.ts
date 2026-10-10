import { err, ok, type ActorContext, type IdempotencyKey, type Rejection, type Result, type StableId } from "@shared/domain";
import { hashCanonicalRequest } from "../../../shared/application/idempotency.js";
import type { Clock } from "../../../runtime/ports.js";
import { MEDIA_PROCESSING_POLICY } from "../domain/policy.js";

export interface MediaProcessingCandidate {
  readonly mediaId: StableId<string>;
  readonly ownerId: StableId<string>;
  readonly portfolioId: StableId<string>;
  readonly kind: "image" | "video" | "document";
  readonly declaredMimeType: string;
  readonly declaredByteLength: number;
  readonly declaredSha256: string;
  readonly mediaObjectId: StableId<string>;
  readonly uploadIntentId: StableId<string>;
  readonly expiresAt: string;
  readonly aggregateVersion: number;
  readonly state: "upload-pending" | "processing" | "processed" | "accepted" | "rejected";
}

export interface MediaProcessingAttempt {
  readonly attemptId: StableId<string>;
  readonly mediaId: StableId<string>;
  readonly result: "passed" | "failed";
  readonly startedAt: string;
  readonly detectedMimeType: string;
  readonly detectedByteLength: number;
  readonly sha256: string;
  readonly inputObjectId: StableId<string>;
  readonly outputObjectId?: StableId<string>;
  readonly outputSha256?: string;
  readonly outputByteLength?: number;
  readonly scannerVersion: string;
  readonly processorVersion: string;
  readonly policyVersion: string;
  readonly findings: readonly string[];
  readonly recordedAt: string;
}

export interface MediaProcessingRepositoryPort {
  getCandidate(input: { readonly ownerId: StableId<string>; readonly mediaId: StableId<string> }): Promise<Result<MediaProcessingCandidate, Rejection>>;
  getReplay(input: { readonly ownerId: StableId<string>; readonly mediaId: StableId<string>; readonly idempotencyKey: IdempotencyKey; readonly requestHash: string }): Promise<Result<{ readonly kind: "missing" } | { readonly kind: "replay"; readonly version: number; readonly outcome: "media-processing-recorded" } | { readonly kind: "conflict" }, Rejection>>;
  commitAttempt(input: { readonly candidate: MediaProcessingCandidate; readonly expectedVersion: number; readonly idempotencyKey: IdempotencyKey; readonly requestHash: string; readonly attempt: MediaProcessingAttempt }): Promise<Result<{ readonly version: number; readonly outcome: "media-processing-recorded" }, Rejection>>;
  recordOrphan(input: { readonly candidate: MediaProcessingCandidate; readonly objectId: StableId<string>; readonly sha256: string }): Promise<Result<void, Rejection>>;
  listOrphans(input: { readonly ownerId: StableId<string>; readonly limit: number }): Promise<Result<ReadonlyArray<{ readonly mediaId: StableId<string>; readonly portfolioId: StableId<string>; readonly objectId: StableId<string>; readonly sha256: string }>, Rejection>>;
  markOrphanReconciled(input: { readonly ownerId: StableId<string>; readonly objectId: StableId<string> }): Promise<Result<void, Rejection>>;
}

export interface MediaProcessingStoragePort {
  readCandidate(input: { readonly portfolioId: StableId<string>; readonly mediaId: StableId<string>; readonly uploadIntentId: StableId<string>; readonly objectId: StableId<string> }): Promise<Result<Uint8Array, Rejection>>;
  sealProcessedPdf(input: { readonly portfolioId: StableId<string>; readonly mediaId: StableId<string>; readonly outputObjectId: StableId<string>; readonly sourceObjectId: StableId<string>; readonly bytes: Uint8Array; readonly sha256: string }): Promise<Result<{ readonly objectId: StableId<string>; readonly sha256: string }, Rejection>>;
  discardSealedObject(input: { readonly portfolioId: StableId<string>; readonly mediaId: StableId<string>; readonly objectId: StableId<string>; readonly sha256: string }): Promise<void>;
}

export interface TrustedByteScannerPort {
  scan(bytes: Uint8Array): Promise<Result<{ readonly verdict: "clean" | "unsafe" | "inconclusive"; readonly version: string }, Rejection>>;
}

export interface PdfProcessorPort {
  process(bytes: Uint8Array): Promise<Result<{ readonly bytes: Uint8Array; readonly version: string; readonly policyVersion: string }, Rejection>>;
}

export interface MediaDigestPort { sha256(bytes: Uint8Array): string; }

export interface RecordMediaProcessingCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly mediaId: StableId<string>;
  readonly result: "passed" | "failed";
  readonly detectedMediaType: string;
  readonly detectedByteLength: number;
  readonly sha256: string;
}

export interface MediaProcessingApplicationService {
  record(command: RecordMediaProcessingCommand): Promise<Result<{ readonly aggregateId: StableId<string>; readonly aggregateVersion: number; readonly outcome: "media-processing-recorded" }, Rejection>>;
  reconcileOrphanedOutputs(): Promise<Result<{ readonly reconciled: number }, Rejection>>;
}

export function createMediaProcessingApplicationService(deps: {
  readonly scope: { readonly ownerId: StableId<string> };
  readonly repository: MediaProcessingRepositoryPort;
  readonly storage: MediaProcessingStoragePort;
  readonly scanner: TrustedByteScannerPort;
  readonly processor: PdfProcessorPort;
  readonly digest: MediaDigestPort;
  readonly ids: { generate(kind: string): string };
  readonly clock: Clock;
}): MediaProcessingApplicationService {
  return {
    async reconcileOrphanedOutputs() {
      const listed = await deps.repository.listOrphans({ ownerId: deps.scope.ownerId, limit: 20 });
      if (!listed.ok) return listed;
      let reconciled = 0;
      for (const orphan of listed.value) {
        try {
          await deps.storage.discardSealedObject({ portfolioId: orphan.portfolioId, mediaId: orphan.mediaId, objectId: orphan.objectId, sha256: orphan.sha256 });
          const marked = await deps.repository.markOrphanReconciled({ ownerId: deps.scope.ownerId, objectId: orphan.objectId });
          if (!marked.ok) return marked;
          reconciled += 1;
        } catch { return err({ kind: "temporarily_unavailable" as const, code: "MEDIA_ORPHAN_RECONCILIATION_UNAVAILABLE" }); }
      }
      return ok({ reconciled });
    },
    async record(command) {
      if (command.actor.kind !== "owner" || command.actor.ownerId !== deps.scope.ownerId) return err({ kind: "forbidden", code: "MEDIA_OWNER_SCOPE_FORBIDDEN" });
      if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) return err({ kind: "validation", code: "MEDIA_VERSION_INVALID" });
      const requestHash = await hashCanonicalRequest({ mediaId: command.mediaId, expectedVersion: command.expectedVersion,
        result: command.result, detectedMediaType: command.detectedMediaType, detectedByteLength: command.detectedByteLength,
        sha256: command.sha256.toLowerCase() });
      const replay = await deps.repository.getReplay({ ownerId: deps.scope.ownerId, mediaId: command.mediaId, idempotencyKey: command.idempotencyKey, requestHash });
      if (!replay.ok) return replay;
      if (replay.value.kind === "conflict") return err({ kind: "conflict", code: "IDEMPOTENCY_CONFLICT" });
      if (replay.value.kind === "replay") return ok({ aggregateId: command.mediaId, aggregateVersion: replay.value.version, outcome: replay.value.outcome });

      const found = await deps.repository.getCandidate({ ownerId: deps.scope.ownerId, mediaId: command.mediaId });
      if (!found.ok) return found;
      const candidate = found.value;
      if (candidate.state === "accepted" || candidate.state === "rejected") return err({ kind: "conflict", code: "MEDIA_INVALID_TRANSITION" });
      if (candidate.aggregateVersion !== command.expectedVersion) return err({ kind: "precondition_failed", code: "MEDIA_VERSION_MISMATCH" });
      if (Date.parse(candidate.expiresAt) <= Date.parse(deps.clock.now())) return err({ kind: "conflict", code: "MEDIA_UPLOAD_EXPIRED" });
      if (candidate.kind !== "document" || candidate.declaredMimeType !== "application/pdf") return err({ kind: "validation", code: "MEDIA_PROCESSING_FORMAT_UNSUPPORTED" });

      const startedAt = deps.clock.now();
      const failedAttempt = async (code: string, facts: { bytes?: Uint8Array; mime?: string; hash?: string; scannerVersion?: string; processorVersion?: string; policyVersion?: string } = {}) => {
        const attempt: MediaProcessingAttempt = { attemptId: deps.ids.generate("MediaProcessingAttempt") as StableId<string>, mediaId: candidate.mediaId,
          result: "failed", startedAt, detectedMimeType: facts.mime ?? "application/octet-stream", detectedByteLength: facts.bytes?.byteLength ?? 0,
          sha256: facts.hash ?? "0".repeat(64), inputObjectId: candidate.mediaObjectId, scannerVersion: facts.scannerVersion ?? "unavailable",
          processorVersion: facts.processorVersion ?? "unavailable", policyVersion: facts.policyVersion ?? "media-pdf-v1", findings: [code], recordedAt: deps.clock.now() };
        try {
          const committed = await deps.repository.commitAttempt({ candidate, expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey, requestHash, attempt });
          if (!committed.ok) return err(committed.error);
          return ok({ aggregateId: candidate.mediaId, aggregateVersion: committed.value.version, outcome: committed.value.outcome });
        } catch { return err({ kind: "temporarily_unavailable" as const, code: "MEDIA_PROCESSING_COMMIT_FAILED" }); }
      };

      let downloaded: Result<Uint8Array, Rejection>;
      try { downloaded = await deps.storage.readCandidate({ portfolioId: candidate.portfolioId, mediaId: candidate.mediaId, uploadIntentId: candidate.uploadIntentId, objectId: candidate.mediaObjectId }); }
      catch { return failedAttempt("MEDIA_STORAGE_UNAVAILABLE"); }
      if (!downloaded.ok) return failedAttempt(downloaded.error.kind === "not_found" ? "MEDIA_UPLOAD_OBJECT_MISSING" : "MEDIA_STORAGE_UNAVAILABLE");
      const bytes = downloaded.value;
      if (bytes.byteLength < 1 || bytes.byteLength > MEDIA_PROCESSING_POLICY.maxBytesByKind.document) return failedAttempt("MEDIA_BYTES_OUT_OF_BOUNDS", { bytes });
      const mime = bytes.byteLength >= 5 && new TextDecoder("ascii").decode(bytes.subarray(0, 5)) === "%PDF-" ? "application/pdf" : "application/octet-stream";
      const sha256 = deps.digest.sha256(bytes);
      if (mime !== candidate.declaredMimeType || bytes.byteLength !== candidate.declaredByteLength || sha256 !== candidate.declaredSha256) {
        return failedAttempt("MEDIA_DECLARATION_MISMATCH", { bytes, mime, hash: sha256 });
      }
      if (command.result !== "passed" || command.detectedMediaType !== mime || command.detectedByteLength !== bytes.byteLength || command.sha256.toLowerCase() !== sha256) {
        return failedAttempt("MEDIA_CALLER_FACTS_MISMATCH", { bytes, mime, hash: sha256 });
      }
      let scanned: Awaited<ReturnType<TrustedByteScannerPort["scan"]>>;
      try { scanned = await deps.scanner.scan(bytes); } catch { return failedAttempt("MEDIA_SCANNER_UNAVAILABLE", { bytes, mime, hash: sha256 }); }
      if (!scanned.ok) return failedAttempt("MEDIA_SCANNER_UNAVAILABLE", { bytes, mime, hash: sha256 });
      if (scanned.value.verdict !== "clean") return failedAttempt(scanned.value.verdict === "unsafe" ? "MEDIA_UNSAFE_CONTENT" : "MEDIA_SCAN_INCONCLUSIVE", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version });
      let processed: Awaited<ReturnType<PdfProcessorPort["process"]>>;
      try { processed = await deps.processor.process(bytes); } catch { return failedAttempt("MEDIA_PROCESSOR_UNAVAILABLE", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version }); }
      if (!processed.ok) return failedAttempt(processed.error.kind === "validation" ? processed.error.code : "MEDIA_PROCESSOR_UNAVAILABLE", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version });
      if (processed.value.bytes.byteLength < 1 || processed.value.bytes.byteLength > MEDIA_PROCESSING_POLICY.maxBytesByKind.document ||
          new TextDecoder("ascii").decode(processed.value.bytes.subarray(0, 5)) !== "%PDF-") return failedAttempt("MEDIA_PDF_OUTPUT_INVALID", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
      const outputHash = deps.digest.sha256(processed.value.bytes);
      let outputScan: Awaited<ReturnType<TrustedByteScannerPort["scan"]>>;
      try { outputScan = await deps.scanner.scan(processed.value.bytes); }
      catch { return failedAttempt("MEDIA_SCANNER_UNAVAILABLE", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion }); }
      if (!outputScan.ok) return failedAttempt("MEDIA_SCANNER_UNAVAILABLE", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
      if (outputScan.value.verdict !== "clean") return failedAttempt(outputScan.value.verdict === "unsafe" ? "MEDIA_OUTPUT_UNSAFE" : "MEDIA_SCAN_INCONCLUSIVE", { bytes, mime, hash: sha256, scannerVersion: outputScan.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
      const expectedOutputObjectId = deps.ids.generate("MediaObject") as StableId<string>;
      let sealed: Awaited<ReturnType<MediaProcessingStoragePort["sealProcessedPdf"]>>;
      try { sealed = await deps.storage.sealProcessedPdf({ portfolioId: candidate.portfolioId, mediaId: candidate.mediaId, outputObjectId: expectedOutputObjectId, sourceObjectId: candidate.mediaObjectId, bytes: processed.value.bytes, sha256: outputHash }); }
      catch { return failedAttempt("MEDIA_OUTPUT_SEAL_FAILED", { bytes, mime, hash: sha256, scannerVersion: outputScan.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion }); }
      if (!sealed.ok) return failedAttempt("MEDIA_OUTPUT_SEAL_FAILED", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
      const discardOrRecordOrphan = async () => {
        try { await deps.storage.discardSealedObject({ portfolioId: candidate.portfolioId, mediaId: candidate.mediaId, objectId: sealed.value.objectId, sha256: outputHash }); }
        catch { await deps.repository.recordOrphan({ candidate, objectId: sealed.value.objectId, sha256: outputHash }).catch(() => undefined); }
      };
      if (sealed.value.sha256 !== outputHash) { await discardOrRecordOrphan(); return failedAttempt("MEDIA_OUTPUT_HASH_MISMATCH", { bytes, mime, hash: sha256, scannerVersion: outputScan.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion }); }
      const attempt: MediaProcessingAttempt = { attemptId: deps.ids.generate("MediaProcessingAttempt") as StableId<string>, mediaId: candidate.mediaId, result: "passed", startedAt,
        detectedMimeType: mime, detectedByteLength: bytes.byteLength, sha256, inputObjectId: candidate.mediaObjectId, outputObjectId: sealed.value.objectId,
        outputSha256: outputHash, outputByteLength: processed.value.bytes.byteLength, scannerVersion: outputScan.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion,
        findings: [], recordedAt: deps.clock.now() };
      let committed: Awaited<ReturnType<MediaProcessingRepositoryPort["commitAttempt"]>>;
      try { committed = await deps.repository.commitAttempt({ candidate, expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey, requestHash, attempt }); }
      catch { await discardOrRecordOrphan(); return err({ kind: "temporarily_unavailable", code: "MEDIA_PROCESSING_COMMIT_FAILED" }); }
      if (!committed.ok) { await discardOrRecordOrphan(); return err(committed.error); }
      return ok({ aggregateId: candidate.mediaId, aggregateVersion: committed.value.version, outcome: committed.value.outcome });
    },
  };
}
