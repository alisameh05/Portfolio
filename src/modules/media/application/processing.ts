import { err, ok, type ActorContext, type IdempotencyKey, type Rejection, type Result, type StableId } from "@shared/domain";
import { hashCanonicalRequest } from "../../../shared/application/idempotency.js";
import type { Clock } from "../../../runtime/ports.js";
import { MEDIA_PROCESSING_POLICY } from "../domain/policy.js";

const VIDEO_SCAN_TIMEOUT_MS = 60_000;

export interface MediaProcessingCandidate {
  readonly mediaId: StableId<string>;
  readonly ownerId: StableId<string>;
  readonly portfolioId: StableId<string>;
  readonly kind: "image" | "video" | "document";
  readonly declaredMimeType: string;
  readonly declaredByteLength: number;
  readonly declaredSha256: string;
  readonly originalFileName: string;
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
  readonly temporaryFailure?: boolean;
  readonly startedAt: string;
  readonly detectedMimeType: string;
  readonly detectedByteLength: number;
  readonly sha256: string;
  readonly inputObjectId: StableId<string>;
  readonly outputObjectId?: StableId<string>;
  readonly outputSha256?: string;
  readonly outputByteLength?: number;
  readonly outputVariants?: readonly MediaProcessingOutputVariant[];
  readonly outputMimeType?: string;
  readonly processingDurationMs?: number;
  readonly variants?: readonly { readonly name: "display" | "thumbnail"; readonly objectId: StableId<string>; readonly sha256: string; readonly byteLength: number; readonly mimeType: "image/webp"; readonly width: number; readonly height: number }[];
  readonly scannerVersion: string;
  readonly processorVersion: string;
  readonly policyVersion: string;
  readonly findings: readonly string[];
  readonly recordedAt: string;
}

export interface MediaProcessingOutputVariant {
  readonly variantName: string;
  readonly objectId: StableId<string>;
  readonly mimeType: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly objectVersion: string;
  readonly width?: number;
  readonly height?: number;
  readonly codec: string;
}

export interface MediaProcessingRepositoryPort {
  getCandidate(input: { readonly ownerId: StableId<string>; readonly mediaId: StableId<string> }): Promise<Result<MediaProcessingCandidate, Rejection>>;
  getReplay(input: { readonly ownerId: StableId<string>; readonly mediaId: StableId<string>; readonly idempotencyKey: IdempotencyKey; readonly requestHash: string }): Promise<Result<{ readonly kind: "missing" } | { readonly kind: "replay"; readonly version: number; readonly outcome: "media-processing-recorded"; readonly failureCode?: string } | { readonly kind: "conflict" }, Rejection>>;
  claimAttempt(input: { readonly candidate: MediaProcessingCandidate; readonly expectedVersion: number; readonly idempotencyKey: IdempotencyKey; readonly requestHash: string; readonly claimId: StableId<string> }): Promise<Result<{ readonly kind: "claimed" } | { readonly kind: "replay"; readonly version: number; readonly outcome: "media-processing-recorded"; readonly failureCode?: string } | { readonly kind: "conflict" } | { readonly kind: "in-progress" } | { readonly kind: "invalid-transition" } | { readonly kind: "version-mismatch" } | { readonly kind: "expired" } | { readonly kind: "candidate-stale" }, Rejection>>;
  commitAttempt(input: { readonly candidate: MediaProcessingCandidate; readonly expectedVersion: number; readonly idempotencyKey: IdempotencyKey; readonly requestHash: string; readonly claimId: StableId<string>; readonly attempt: MediaProcessingAttempt; readonly timeoutMs?: number }): Promise<Result<{ readonly version: number; readonly outcome: "media-processing-recorded"; readonly failureCode?: string }, Rejection>>;
  recordOrphan(input: { readonly candidate: MediaProcessingCandidate; readonly objectId: StableId<string>; readonly sha256: string; readonly mimeType?: string; readonly timeoutMs?: number }): Promise<Result<void, Rejection>>;
  listOrphans(input: { readonly ownerId: StableId<string>; readonly limit: number }): Promise<Result<ReadonlyArray<{ readonly mediaId: StableId<string>; readonly portfolioId: StableId<string>; readonly objectId: StableId<string>; readonly sha256: string; readonly mimeType?: string }>, Rejection>>;
  markOrphanReconciled(input: { readonly ownerId: StableId<string>; readonly objectId: StableId<string> }): Promise<Result<void, Rejection>>;
}

export interface MediaProcessingStoragePort {
  readCandidate(input: { readonly portfolioId: StableId<string>; readonly mediaId: StableId<string>; readonly uploadIntentId: StableId<string>; readonly objectId: StableId<string>; readonly maxBytes?: number; readonly timeoutMs?: number }): Promise<Result<Uint8Array, Rejection>>;
  sealProcessedObject(input: { readonly portfolioId: StableId<string>; readonly mediaId: StableId<string>; readonly outputObjectId: StableId<string>; readonly sourceObjectId: StableId<string>; readonly bytes: Uint8Array; readonly sha256: string; readonly mimeType: string; readonly timeoutMs?: number }): Promise<Result<{ readonly objectId: StableId<string>; readonly sha256: string }, Rejection>>;
  discardSealedObject(input: { readonly portfolioId: StableId<string>; readonly mediaId: StableId<string>; readonly objectId: StableId<string>; readonly sha256: string; readonly mimeType?: string; readonly timeoutMs?: number }): Promise<void>;
}

export interface TrustedByteScannerPort {
  scan(bytes: Uint8Array, options?: { readonly timeoutMs?: number }): Promise<Result<{ readonly verdict: "clean" | "unsafe" | "inconclusive"; readonly version: string }, Rejection>>;
  scanMany?(bytes: readonly Uint8Array[], options?: { readonly timeoutMs?: number }): Promise<Result<{ readonly verdict: "clean" | "unsafe" | "inconclusive"; readonly version: string }, Rejection>>;
}

export interface PdfProcessorPort {
  process(bytes: Uint8Array, options?: { readonly timeoutMs?: number }): Promise<Result<{ readonly bytes: Uint8Array; readonly version: string; readonly policyVersion: string }, Rejection>>;
}
export interface VideoProcessorPort {
  process(bytes: Uint8Array, options?: { readonly timeoutMs?: number }): Promise<Result<{
    readonly detectedMimeType: "video/mp4" | "video/webm";
    readonly variants: readonly {
      readonly variantName: string;
      readonly mimeType: "video/mp4" | "video/webm";
      readonly bytes: Uint8Array;
      readonly width: number;
      readonly height: number;
      readonly codec: string;
    }[];
    readonly version: string;
    readonly policyVersion: string;
  }, Rejection>>;
}

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

export interface MediaImageVariant {
  readonly name: "display" | "thumbnail";
  readonly bytes: Uint8Array;
  readonly mimeType: "image/webp";
  readonly width: number;
  readonly height: number;
}

export interface MediaImageProcessorPort {
  process(bytes: Uint8Array, detectedMimeType: string, options?: { readonly timeoutMs?: number }): Promise<Result<{
    readonly variants: readonly MediaImageVariant[];
    readonly version: string;
    readonly policyVersion: string;
  }, Rejection>>;
}

export interface MediaDigestPort { sha256(bytes: Uint8Array): string; }

type ImageProcessingDependencies = {
  readonly scope: { readonly ownerId: StableId<string> };
  readonly repository: MediaProcessingRepositoryPort;
  readonly storage: MediaProcessingStoragePort;
  readonly scanner: TrustedByteScannerPort;
  readonly imageProcessor: MediaImageProcessorPort;
  readonly digest: MediaDigestPort;
  readonly ids: { generate(kind: string): string };
  readonly clock: Clock;
};

function detectedImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength >= 8 && bytes.subarray(0, 8).every((value, index) => value === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])) return "image/png";
  if (bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.byteLength >= 12 && new TextDecoder("ascii").decode(bytes.subarray(0, 4)) === "RIFF" &&
      new TextDecoder("ascii").decode(bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  return undefined;
}

function imageExtensionMatches(fileName: string, mimeType: string): boolean {
  return mimeType === "image/png" ? /\.png$/iu.test(fileName)
    : mimeType === "image/jpeg" ? /\.(?:jpe?g)$/iu.test(fileName)
      : mimeType === "image/webp" ? /\.webp$/iu.test(fileName) : false;
}

async function recordImageProcessing(input: {
  readonly deps: ImageProcessingDependencies;
  readonly candidate: MediaProcessingCandidate;
  readonly command: RecordMediaProcessingCommand;
  readonly requestHash: string;
}): Promise<Result<{ readonly aggregateId: StableId<string>; readonly aggregateVersion: number; readonly outcome: "media-processing-recorded" }, Rejection>> {
  const { deps, candidate, command, requestHash } = input;
  const claimId = deps.ids.generate("MediaProcessingClaim") as StableId<string>;
  const claim = await deps.repository.claimAttempt({ candidate, expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey, requestHash, claimId });
  if (!claim.ok) return claim;
  if (claim.value.kind === "conflict") return err({ kind: "conflict", code: "IDEMPOTENCY_CONFLICT" });
  if (claim.value.kind === "in-progress") return err({ kind: "temporarily_unavailable", code: "MEDIA_PROCESSING_IN_PROGRESS" });
  if (claim.value.kind === "invalid-transition") return err({ kind: "conflict", code: "MEDIA_INVALID_TRANSITION" });
  if (claim.value.kind === "version-mismatch") return err({ kind: "precondition_failed", code: "MEDIA_VERSION_MISMATCH" });
  if (claim.value.kind === "expired") return err({ kind: "conflict", code: "MEDIA_UPLOAD_EXPIRED" });
  if (claim.value.kind === "candidate-stale") return err({ kind: "conflict", code: "MEDIA_CANDIDATE_STALE" });
  if (claim.value.kind === "replay") return claim.value.failureCode
    ? err({ kind: "temporarily_unavailable", code: claim.value.failureCode })
    : ok({ aggregateId: command.mediaId, aggregateVersion: claim.value.version, outcome: claim.value.outcome });

  const startedAt = deps.clock.now();
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + MEDIA_PROCESSING_POLICY.maxProcessingAttemptMs;
  const remainingMs = (maximum: number) => Math.max(0, Math.min(maximum, deadlineMs - Date.now() - 50));
  let processingStoppedAtMs: number | undefined;
  const stopProcessing = () => { processingStoppedAtMs ??= Date.now(); };
  const processingDurationMs = () => Math.max(0, (processingStoppedAtMs ?? Date.now()) - startedAtMs);
  const attemptWithinBudget = () => {
    return Number.isFinite(startedAtMs) && Date.now() < deadlineMs;
  };
  const failures = new Set(["MEDIA_STORAGE_UNAVAILABLE", "MEDIA_UPLOAD_OBJECT_MISSING", "MEDIA_SCANNER_UNAVAILABLE", "MEDIA_SCAN_INCONCLUSIVE", "MEDIA_PROCESSOR_UNAVAILABLE", "MEDIA_OUTPUT_SEAL_FAILED", "MEDIA_PROCESSING_TIMEOUT"]);
  const failedAttempt = async (code: string, facts: { bytes?: Uint8Array; mime?: string; hash?: string; scannerVersion?: string; processorVersion?: string; policyVersion?: string } = {}):
    Promise<Result<{ readonly aggregateId: StableId<string>; readonly aggregateVersion: number; readonly outcome: "media-processing-recorded" }, Rejection>> => {
    const attempt: MediaProcessingAttempt = { attemptId: deps.ids.generate("MediaProcessingAttempt") as StableId<string>, mediaId: candidate.mediaId,
      result: "failed", temporaryFailure: failures.has(code), startedAt, detectedMimeType: facts.mime ?? "application/octet-stream",
      detectedByteLength: facts.bytes?.byteLength ?? 0, sha256: facts.hash ?? "0".repeat(64), inputObjectId: candidate.mediaObjectId,
      processingDurationMs: processingDurationMs(),
      scannerVersion: facts.scannerVersion ?? "unavailable", processorVersion: facts.processorVersion ?? "unavailable",
      policyVersion: facts.policyVersion ?? "image-webp-variants-v1", findings: [code], recordedAt: deps.clock.now() };
    try {
      const committed = await deps.repository.commitAttempt({ candidate, expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey, requestHash, claimId, attempt,
        timeoutMs: remainingMs(3_000) || 3_000 });
      if (!committed.ok) return err(committed.error);
      if (committed.value.failureCode) return err({ kind: "temporarily_unavailable" as const, code: committed.value.failureCode });
      return ok({ aggregateId: candidate.mediaId, aggregateVersion: committed.value.version, outcome: committed.value.outcome });
    } catch { return err({ kind: "temporarily_unavailable" as const, code: "MEDIA_PROCESSING_COMMIT_FAILED" }); }
  };

  let downloaded: Result<Uint8Array, Rejection>;
  const readTimeoutMs = remainingMs(3_000);
  if (!readTimeoutMs) return failedAttempt("MEDIA_PROCESSING_TIMEOUT");
  try { downloaded = await deps.storage.readCandidate({ portfolioId: candidate.portfolioId, mediaId: candidate.mediaId, uploadIntentId: candidate.uploadIntentId,
    objectId: candidate.mediaObjectId, maxBytes: MEDIA_PROCESSING_POLICY.maxBytesByKind.image, timeoutMs: readTimeoutMs }); }
  catch { return failedAttempt("MEDIA_STORAGE_UNAVAILABLE"); }
  if (!attemptWithinBudget()) return failedAttempt("MEDIA_PROCESSING_TIMEOUT");
  if (!downloaded.ok && downloaded.error.code === "MEDIA_BYTES_OUT_OF_BOUNDS") return failedAttempt("MEDIA_BYTES_OUT_OF_BOUNDS");
  if (!downloaded.ok) return failedAttempt(downloaded.error.kind === "not_found" ? "MEDIA_UPLOAD_OBJECT_MISSING" : "MEDIA_STORAGE_UNAVAILABLE");
  const bytes = downloaded.value;
  if (bytes.byteLength < 1 || bytes.byteLength > MEDIA_PROCESSING_POLICY.maxBytesByKind.image) return failedAttempt("MEDIA_BYTES_OUT_OF_BOUNDS", { bytes });
  const mime = detectedImageMime(bytes) ?? "application/octet-stream";
  const sha256 = deps.digest.sha256(bytes);
  if (!MEDIA_PROCESSING_POLICY.allowedMimeTypes.image.includes(mime as "image/png" | "image/jpeg" | "image/webp") ||
      mime !== candidate.declaredMimeType || bytes.byteLength !== candidate.declaredByteLength || sha256 !== candidate.declaredSha256) {
    return failedAttempt("MEDIA_DECLARATION_MISMATCH", { bytes, mime, hash: sha256 });
  }
  if (!imageExtensionMatches(candidate.originalFileName, mime)) return failedAttempt("MEDIA_EXTENSION_MISMATCH", { bytes, mime, hash: sha256 });
  if (command.result !== "passed" || command.detectedMediaType !== mime || command.detectedByteLength !== bytes.byteLength || command.sha256.toLowerCase() !== sha256) {
    return failedAttempt("MEDIA_CALLER_FACTS_MISMATCH", { bytes, mime, hash: sha256 });
  }
  let scanned: Awaited<ReturnType<TrustedByteScannerPort["scan"]>>;
  const sourceScanTimeoutMs = remainingMs(60_000);
  if (sourceScanTimeoutMs < 1_000) return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256 });
  try { scanned = await deps.scanner.scan(bytes, { timeoutMs: sourceScanTimeoutMs }); } catch { return failedAttempt("MEDIA_SCANNER_UNAVAILABLE", { bytes, mime, hash: sha256 }); }
  if (!attemptWithinBudget()) return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256 });
  if (!scanned.ok) return failedAttempt("MEDIA_SCANNER_UNAVAILABLE", { bytes, mime, hash: sha256 });
  if (scanned.value.verdict !== "clean") return failedAttempt(scanned.value.verdict === "unsafe" ? "MEDIA_UNSAFE_CONTENT" : "MEDIA_SCAN_INCONCLUSIVE", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version });

  let processed: Awaited<ReturnType<MediaImageProcessorPort["process"]>> =
    err({ kind: "temporarily_unavailable" as const, code: "MEDIA_PROCESSOR_UNAVAILABLE" });
  const imageProcessorFacts = { bytes, mime, hash: sha256, scannerVersion: scanned.value.version };
  const runImageProcessor = (timeoutMs: number) => deps.imageProcessor.process(bytes, mime, { timeoutMs });
  const retryImageProcessor = async (): Promise<boolean> => {
    if (!attemptWithinBudget()) return false;
    const retryTimeoutMs = remainingMs(15_000);
    if (retryTimeoutMs < 5_000) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
    try { processed = await runImageProcessor(retryTimeoutMs); } catch { return false; }
    return attemptWithinBudget();
  };
  const imageTimeoutMs = remainingMs(15_000);
  if (imageTimeoutMs < 1_000) return failedAttempt("MEDIA_PROCESSING_TIMEOUT", imageProcessorFacts);
  try { processed = await runImageProcessor(imageTimeoutMs); }
  catch { if (!(await retryImageProcessor())) return failedAttempt("MEDIA_PROCESSOR_UNAVAILABLE", imageProcessorFacts); }
  if (!attemptWithinBudget()) return failedAttempt("MEDIA_PROCESSING_TIMEOUT", imageProcessorFacts);
  if (!processed.ok && processed.error.kind !== "validation") await retryImageProcessor();
  if (!attemptWithinBudget()) return failedAttempt("MEDIA_PROCESSING_TIMEOUT", imageProcessorFacts);
  if (!processed.ok) return failedAttempt(processed.error.kind === "validation" ? processed.error.code : processed.error.code || "MEDIA_PROCESSOR_UNAVAILABLE",
    imageProcessorFacts);
  const variants = processed.value.variants;
  const variantNames = variants.map((variant) => variant.name);
  if (variants.length !== 2 || variants.length > MEDIA_PROCESSING_POLICY.maxVariants || new Set(variantNames).size !== variants.length ||
      !variantNames.includes("display") || !variantNames.includes("thumbnail") || variants.some((variant) =>
        variant.mimeType !== "image/webp" || variant.bytes.byteLength < 1 || variant.bytes.byteLength > MEDIA_PROCESSING_POLICY.maxBytesByKind.image ||
        !Number.isSafeInteger(variant.width) || !Number.isSafeInteger(variant.height) || variant.width < 1 || variant.height < 1 ||
        variant.width * variant.height > MEDIA_PROCESSING_POLICY.maxImagePixels)) {
    return failedAttempt("MEDIA_IMAGE_OUTPUT_INVALID", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version,
      processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
  }
  const outputHashes = variants.map((variant) => deps.digest.sha256(variant.bytes));
  let outputScans: Awaited<ReturnType<TrustedByteScannerPort["scan"]>>[];
  const outputScanTimeoutMs = remainingMs(60_000);
  if (outputScanTimeoutMs < 1_000) return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version,
    processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
  if (deps.scanner.scanMany) {
    try {
      const outputScan = await deps.scanner.scanMany(variants.map((variant) => variant.bytes), { timeoutMs: outputScanTimeoutMs });
      outputScans = variants.map(() => outputScan);
    } catch { outputScans = variants.map(() => err({ kind: "temporarily_unavailable" as const, code: "MEDIA_SCANNER_UNAVAILABLE" })); }
  } else {
    outputScans = await Promise.all(variants.map(async (variant) => {
      try { return await deps.scanner.scan(variant.bytes, { timeoutMs: outputScanTimeoutMs }); }
      catch { return err({ kind: "temporarily_unavailable" as const, code: "MEDIA_SCANNER_UNAVAILABLE" }); }
    }));
  }
  if (!attemptWithinBudget()) return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version,
    processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
  if (outputScans.some((result) => !result.ok)) return failedAttempt("MEDIA_SCANNER_UNAVAILABLE", { bytes, mime, hash: sha256,
    scannerVersion: scanned.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
  const cleanScans = outputScans.map((result) => result.ok ? result.value : undefined);
  if (cleanScans.some((result) => result?.verdict !== "clean")) {
    const verdict = cleanScans.some((result) => result?.verdict === "unsafe") ? "MEDIA_OUTPUT_UNSAFE" : "MEDIA_SCAN_INCONCLUSIVE";
    return failedAttempt(verdict, { bytes, mime, hash: sha256, scannerVersion: scanned.value.version,
      processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
  }

  const sealed: { readonly name: "display" | "thumbnail"; readonly objectId: StableId<string>; readonly sha256: string; readonly byteLength: number;
    readonly mimeType: "image/webp"; readonly width: number; readonly height: number }[] = [];
  const discardOrRecordOrphan = async (object: typeof sealed[number]) => {
    stopProcessing();
    try { await deps.storage.discardSealedObject({ portfolioId: candidate.portfolioId, mediaId: candidate.mediaId,
      objectId: object.objectId, sha256: object.sha256, mimeType: object.mimeType, timeoutMs: remainingMs(3_000) || 3_000 }); return undefined; }
    catch {
      try {
        const recorded = await deps.repository.recordOrphan({ candidate, objectId: object.objectId, sha256: object.sha256, mimeType: object.mimeType,
          timeoutMs: remainingMs(3_000) || 3_000 });
        return recorded.ok ? undefined : recorded.error;
      } catch { return { kind: "temporarily_unavailable" as const, code: "MEDIA_ORPHAN_RECORD_FAILED" }; }
    }
  };
  const cleanup = async () => {
    stopProcessing();
    let failure: Rejection | undefined;
    for (const object of [...sealed].reverse()) {
      const objectFailure = await discardOrRecordOrphan(object);
      failure ??= objectFailure;
    }
    return failure;
  };
  for (let index = 0; index < variants.length; index += 1) {
    const variant = variants[index]!;
    const expectedObjectId = deps.ids.generate("MediaObject") as StableId<string>;
    if (expectedObjectId === candidate.mediaObjectId || sealed.some((item) => item.objectId === expectedObjectId)) {
      const cleanupError = await cleanup();
      if (cleanupError) return err(cleanupError);
      return failedAttempt("MEDIA_OUTPUT_OBJECT_MISMATCH", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version,
        processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
    }
    const expectedFact = { name: variant.name, objectId: expectedObjectId, sha256: outputHashes[index]!, byteLength: variant.bytes.byteLength,
      mimeType: variant.mimeType, width: variant.width, height: variant.height } as const;
    const sealTimeoutMs = remainingMs(3_000);
    if (!sealTimeoutMs) { const cleanupError = await cleanup(); if (cleanupError) return err(cleanupError); return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256,
      scannerVersion: scanned.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion }); }
    let result: Awaited<ReturnType<MediaProcessingStoragePort["sealProcessedObject"]>>;
    try { result = await deps.storage.sealProcessedObject({ portfolioId: candidate.portfolioId, mediaId: candidate.mediaId,
      outputObjectId: expectedObjectId, sourceObjectId: candidate.mediaObjectId, bytes: variant.bytes, sha256: outputHashes[index]!, mimeType: variant.mimeType, timeoutMs: sealTimeoutMs }); }
    catch {
      const orphanError = await discardOrRecordOrphan(expectedFact);
      const cleanupError = await cleanup();
      if (orphanError ?? cleanupError) return err(orphanError ?? cleanupError!);
      return failedAttempt("MEDIA_OUTPUT_SEAL_FAILED", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version,
        processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
    }
    if (!result.ok) {
      const orphanError = await discardOrRecordOrphan(expectedFact);
      const cleanupError = await cleanup();
      if (orphanError ?? cleanupError) return err(orphanError ?? cleanupError!);
      return failedAttempt("MEDIA_OUTPUT_SEAL_FAILED", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version,
        processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
    }
    const fact = { ...expectedFact, objectId: result.value.objectId, sha256: result.value.sha256 } as const;
    sealed.push(fact);
    if (fact.objectId !== expectedObjectId || fact.sha256 !== outputHashes[index]) {
      const cleanupError = await cleanup();
      if (cleanupError) return err(cleanupError);
      return failedAttempt(fact.objectId !== expectedObjectId ? "MEDIA_OUTPUT_OBJECT_MISMATCH" : "MEDIA_OUTPUT_HASH_MISMATCH", {
        bytes, mime, hash: sha256, scannerVersion: scanned.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
    }
    if (!attemptWithinBudget()) {
      const cleanupError = await cleanup();
      if (cleanupError) return err(cleanupError);
      return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version,
        processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
    }
  }
  const primary = sealed.find(({ name }) => name === "display");
  if (!primary) { const cleanupError = await cleanup(); if (cleanupError) return err(cleanupError); return failedAttempt("MEDIA_IMAGE_OUTPUT_INVALID", { bytes, mime, hash: sha256 }); }
  const scannerVersion = [...new Set([scanned.value.version, ...cleanScans.map((result) => result!.version)])].join(";").slice(0, 160);
  const attempt: MediaProcessingAttempt = { attemptId: deps.ids.generate("MediaProcessingAttempt") as StableId<string>, mediaId: candidate.mediaId,
    result: "passed", startedAt, detectedMimeType: mime, detectedByteLength: bytes.byteLength, sha256, inputObjectId: candidate.mediaObjectId,
    processingDurationMs: processingDurationMs(),
    outputObjectId: primary.objectId, outputSha256: primary.sha256, outputByteLength: primary.byteLength, outputMimeType: primary.mimeType,
    variants: sealed, scannerVersion, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion, findings: [], recordedAt: deps.clock.now() };
  if (!attemptWithinBudget()) {
    const cleanupError = await cleanup();
    if (cleanupError) return err(cleanupError);
    return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256, scannerVersion, processorVersion: processed.value.version,
      policyVersion: processed.value.policyVersion });
  }
  let committed: Awaited<ReturnType<MediaProcessingRepositoryPort["commitAttempt"]>>;
  const commitTimeoutMs = remainingMs(3_000);
  if (!commitTimeoutMs) { const cleanupError = await cleanup(); if (cleanupError) return err(cleanupError); return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256, scannerVersion,
    processorVersion: processed.value.version, policyVersion: processed.value.policyVersion }); }
  try { committed = await deps.repository.commitAttempt({ candidate, expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey, requestHash, claimId, attempt, timeoutMs: commitTimeoutMs }); }
  catch { const cleanupError = await cleanup(); return err(cleanupError ?? { kind: "temporarily_unavailable", code: "MEDIA_PROCESSING_COMMIT_FAILED" }); }
  if (!committed.ok) { const cleanupError = await cleanup(); return err(cleanupError ?? committed.error); }
  return ok({ aggregateId: candidate.mediaId, aggregateVersion: committed.value.version, outcome: committed.value.outcome });
}

export function createMediaProcessingApplicationService(deps: {
  readonly scope: { readonly ownerId: StableId<string> };
  readonly repository: MediaProcessingRepositoryPort;
  readonly storage: MediaProcessingStoragePort;
  readonly scanner: TrustedByteScannerPort;
  readonly processor: PdfProcessorPort;
  readonly videoProcessor?: VideoProcessorPort;
  readonly imageProcessor?: MediaImageProcessorPort;
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
          await deps.storage.discardSealedObject({ portfolioId: orphan.portfolioId, mediaId: orphan.mediaId, objectId: orphan.objectId, sha256: orphan.sha256, ...(orphan.mimeType === undefined ? {} : { mimeType: orphan.mimeType }) });
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
      if (replay.value.kind === "replay") return replay.value.failureCode
        ? err({ kind: "temporarily_unavailable" as const, code: replay.value.failureCode })
        : ok({ aggregateId: command.mediaId, aggregateVersion: replay.value.version, outcome: replay.value.outcome });

      const found = await deps.repository.getCandidate({ ownerId: deps.scope.ownerId, mediaId: command.mediaId });
      if (!found.ok) return found;
      const candidate = found.value;
      if (candidate.kind === "image") {
        if (!deps.imageProcessor) return err({ kind: "temporarily_unavailable", code: "MEDIA_PROCESSOR_UNAVAILABLE" });
        return await recordImageProcessing({ deps: { ...deps, imageProcessor: deps.imageProcessor }, candidate, command, requestHash });
      }
      const supportedPdf = candidate.kind === "document" && candidate.declaredMimeType === "application/pdf";
      const supportedVideo = candidate.kind === "video" && (candidate.declaredMimeType === "video/mp4" || candidate.declaredMimeType === "video/webm");
      if (!supportedPdf && !supportedVideo) return err({ kind: "validation", code: "MEDIA_PROCESSING_FORMAT_UNSUPPORTED" });
      if (supportedPdf && !/\.pdf$/i.test(candidate.originalFileName)) return err({ kind: "validation", code: "MEDIA_EXTENSION_MISMATCH" });
      if (supportedVideo && !/\.(?:mp4|webm)$/i.test(candidate.originalFileName)) return err({ kind: "validation", code: "MEDIA_EXTENSION_MISMATCH" });

      const claimId = deps.ids.generate("MediaProcessingClaim") as StableId<string>;
      const claim = await deps.repository.claimAttempt({ candidate, expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey, requestHash, claimId });
      if (!claim.ok) return claim;
      if (claim.value.kind === "conflict") return err({ kind: "conflict", code: "IDEMPOTENCY_CONFLICT" });
      if (claim.value.kind === "in-progress") return err({ kind: "temporarily_unavailable" as const, code: "MEDIA_PROCESSING_IN_PROGRESS" });
      if (claim.value.kind === "invalid-transition") return err({ kind: "conflict", code: "MEDIA_INVALID_TRANSITION" });
      if (claim.value.kind === "version-mismatch") return err({ kind: "precondition_failed", code: "MEDIA_VERSION_MISMATCH" });
      if (claim.value.kind === "expired") return err({ kind: "conflict", code: "MEDIA_UPLOAD_EXPIRED" });
      if (claim.value.kind === "candidate-stale") return err({ kind: "conflict", code: "MEDIA_CANDIDATE_STALE" });
      if (claim.value.kind === "replay") return claim.value.failureCode
        ? err({ kind: "temporarily_unavailable" as const, code: claim.value.failureCode })
        : ok({ aggregateId: command.mediaId, aggregateVersion: claim.value.version, outcome: claim.value.outcome });

      const startedAt = deps.clock.now();
      const elapsedMs = () => {
        const startedAtMs = Date.parse(startedAt), currentAtMs = Date.parse(deps.clock.now());
        return Number.isFinite(startedAtMs) && Number.isFinite(currentAtMs) ? Math.max(0, currentAtMs - startedAtMs) : MEDIA_PROCESSING_POLICY.maxProcessingAttemptMs;
      };
      const remainingBudgetMs = () => Math.max(0, MEDIA_PROCESSING_POLICY.maxProcessingAttemptMs - elapsedMs());
      const attemptWithinBudget = () => {
        return remainingBudgetMs() > 0;
      };
      const temporaryCodes = new Set(["MEDIA_STORAGE_UNAVAILABLE", "MEDIA_UPLOAD_OBJECT_MISSING", "MEDIA_SCANNER_UNAVAILABLE", "MEDIA_SCAN_INCONCLUSIVE", "MEDIA_PROCESSOR_UNAVAILABLE", "MEDIA_OUTPUT_SEAL_FAILED", "MEDIA_PROCESSING_TIMEOUT"]);
      const failedAttempt = async (code: string, facts: { bytes?: Uint8Array; mime?: string; hash?: string; scannerVersion?: string; processorVersion?: string; policyVersion?: string } = {}) => {
        const attempt: MediaProcessingAttempt = { attemptId: deps.ids.generate("MediaProcessingAttempt") as StableId<string>, mediaId: candidate.mediaId,
          result: "failed", temporaryFailure: temporaryCodes.has(code), startedAt, detectedMimeType: facts.mime ?? "application/octet-stream", detectedByteLength: facts.bytes?.byteLength ?? 0,
          sha256: facts.hash ?? "0".repeat(64), inputObjectId: candidate.mediaObjectId, processingDurationMs: elapsedMs(), scannerVersion: facts.scannerVersion ?? "unavailable",
          processorVersion: facts.processorVersion ?? "unavailable", policyVersion: facts.policyVersion ?? "media-pdf-v1", findings: [code], recordedAt: deps.clock.now() };
        try {
          // Persisting the failure receipt is bounded separately from the 60s processing window.
          const committed = await deps.repository.commitAttempt({ candidate, expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey, requestHash, claimId, attempt });
          if (!committed.ok) return err(committed.error);
          if (committed.value.failureCode) return err({ kind: "temporarily_unavailable" as const, code: committed.value.failureCode });
          return ok({ aggregateId: candidate.mediaId, aggregateVersion: committed.value.version, outcome: committed.value.outcome });
        } catch { return err({ kind: "temporarily_unavailable" as const, code: "MEDIA_PROCESSING_COMMIT_FAILED" }); }
      };

      let downloaded: Result<Uint8Array, Rejection>;
      const readTimeoutMs = Math.min(10_000, remainingBudgetMs());
      if (!readTimeoutMs) return failedAttempt("MEDIA_PROCESSING_TIMEOUT");
      try { downloaded = await deps.storage.readCandidate({ portfolioId: candidate.portfolioId, mediaId: candidate.mediaId, uploadIntentId: candidate.uploadIntentId, objectId: candidate.mediaObjectId, maxBytes: MEDIA_PROCESSING_POLICY.maxBytesByKind[candidate.kind], timeoutMs: readTimeoutMs }); }
      catch { return failedAttempt(attemptWithinBudget() ? "MEDIA_STORAGE_UNAVAILABLE" : "MEDIA_PROCESSING_TIMEOUT"); }
      if (!attemptWithinBudget()) return failedAttempt("MEDIA_PROCESSING_TIMEOUT");
      if (!downloaded.ok && downloaded.error.code === "MEDIA_BYTES_OUT_OF_BOUNDS") return failedAttempt("MEDIA_BYTES_OUT_OF_BOUNDS");
      if (!downloaded.ok) return failedAttempt(downloaded.error.kind === "not_found" ? "MEDIA_UPLOAD_OBJECT_MISSING" : "MEDIA_STORAGE_UNAVAILABLE");
      const bytes = downloaded.value;
      const maxInputBytes = MEDIA_PROCESSING_POLICY.maxBytesByKind[candidate.kind];
      if (bytes.byteLength < 1 || bytes.byteLength > maxInputBytes) return failedAttempt("MEDIA_BYTES_OUT_OF_BOUNDS", { bytes });
      const prefix = new TextDecoder("ascii").decode(bytes.subarray(0, 12));
      const mime = prefix.startsWith("%PDF-") ? "application/pdf"
        : bytes.byteLength >= 12 && prefix.slice(4, 8) === "ftyp" ? "video/mp4"
        : bytes.byteLength >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3 ? "video/webm"
        : "application/octet-stream";
      const sha256 = deps.digest.sha256(bytes);
      if (candidate.kind === "video" && ((mime === "video/mp4" && !/\.mp4$/i.test(candidate.originalFileName)) ||
          (mime === "video/webm" && !/\.webm$/i.test(candidate.originalFileName)))) return failedAttempt("MEDIA_EXTENSION_MISMATCH", { bytes, mime, hash: sha256 });
      if (mime !== candidate.declaredMimeType || bytes.byteLength !== candidate.declaredByteLength || sha256 !== candidate.declaredSha256) {
        return failedAttempt("MEDIA_DECLARATION_MISMATCH", { bytes, mime, hash: sha256 });
      }
      if (command.result !== "passed" || command.detectedMediaType !== mime || command.detectedByteLength !== bytes.byteLength || command.sha256.toLowerCase() !== sha256) {
        return failedAttempt("MEDIA_CALLER_FACTS_MISMATCH", { bytes, mime, hash: sha256 });
      }
      let scanned: Awaited<ReturnType<TrustedByteScannerPort["scan"]>>;
      const sourceScanTimeoutMs = Math.min(candidate.kind === "video" ? VIDEO_SCAN_TIMEOUT_MS : 60_000, remainingBudgetMs());
      if (!sourceScanTimeoutMs) return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256 });
      try { scanned = await deps.scanner.scan(bytes, { timeoutMs: sourceScanTimeoutMs }); } catch { return failedAttempt(attemptWithinBudget() ? "MEDIA_SCANNER_UNAVAILABLE" : "MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256 }); }
      if (!attemptWithinBudget()) return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256 });
      if (!scanned.ok) return failedAttempt(scanned.error.code === "MEDIA_PROCESSING_TIMEOUT" ? "MEDIA_PROCESSING_TIMEOUT" : "MEDIA_SCANNER_UNAVAILABLE", { bytes, mime, hash: sha256 });
      if (scanned.value.verdict !== "clean") return failedAttempt(scanned.value.verdict === "unsafe" ? "MEDIA_UNSAFE_CONTENT" : "MEDIA_SCAN_INCONCLUSIVE", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version });
      if (candidate.kind === "video") {
        if (!deps.videoProcessor) return failedAttempt("MEDIA_PROCESSOR_UNAVAILABLE", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version });
        let processedVideo: Awaited<ReturnType<VideoProcessorPort["process"]>>;
        const processorTimeoutMs = remainingBudgetMs();
        if (!processorTimeoutMs) return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version });
        try { processedVideo = await deps.videoProcessor.process(bytes, { timeoutMs: processorTimeoutMs }); }
        catch { return failedAttempt(attemptWithinBudget() ? "MEDIA_PROCESSOR_UNAVAILABLE" : "MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version }); }
        if (!attemptWithinBudget()) return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version });
        if (!processedVideo.ok) return failedAttempt(processedVideo.error.kind === "validation" || processedVideo.error.code === "MEDIA_PROCESSING_TIMEOUT" ? processedVideo.error.code : "MEDIA_PROCESSOR_UNAVAILABLE", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version });
        if (processedVideo.value.detectedMimeType !== mime || processedVideo.value.variants.length < 1 || processedVideo.value.variants.length > MEDIA_PROCESSING_POLICY.maxVariants) {
          return failedAttempt("MEDIA_VIDEO_OUTPUT_INVALID", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version, processorVersion: processedVideo.value.version, policyVersion: processedVideo.value.policyVersion });
        }
        const sealedVariants: Array<{ readonly variant: MediaProcessingOutputVariant; readonly bytes: Uint8Array }> = [];
        const cleanupVideoOutputs = async () => {
          for (const output of sealedVariants) {
            try { await deps.storage.discardSealedObject({ portfolioId: candidate.portfolioId, mediaId: candidate.mediaId, objectId: output.variant.objectId, sha256: output.variant.sha256, mimeType: output.variant.mimeType }); }
            catch { await deps.repository.recordOrphan({ candidate, objectId: output.variant.objectId, sha256: output.variant.sha256, mimeType: output.variant.mimeType }).catch(() => undefined); }
          }
        };
        for (const variant of processedVideo.value.variants) {
          if (!/^[a-z0-9-]{1,32}$/.test(variant.variantName) || !(variant.mimeType === "video/mp4" || variant.mimeType === "video/webm") ||
              variant.mimeType !== mime || variant.bytes.byteLength < 1 || variant.bytes.byteLength > MEDIA_PROCESSING_POLICY.maxBytesByKind.video ||
              !Number.isSafeInteger(variant.width) || variant.width < 1 || variant.width > 1920 || !Number.isSafeInteger(variant.height) || variant.height < 1 || variant.height > 1080 ||
              !/^[a-z0-9_]{2,16}$/.test(variant.codec)) {
            await cleanupVideoOutputs();
            return failedAttempt("MEDIA_VIDEO_OUTPUT_INVALID", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version, processorVersion: processedVideo.value.version, policyVersion: processedVideo.value.policyVersion });
          }
          let outputScan: Awaited<ReturnType<TrustedByteScannerPort["scan"]>>;
          const outputScanTimeoutMs = Math.min(VIDEO_SCAN_TIMEOUT_MS, remainingBudgetMs());
          if (!outputScanTimeoutMs) { await cleanupVideoOutputs(); return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version, processorVersion: processedVideo.value.version, policyVersion: processedVideo.value.policyVersion }); }
          try { outputScan = await deps.scanner.scan(variant.bytes, { timeoutMs: outputScanTimeoutMs }); }
          catch { await cleanupVideoOutputs(); return failedAttempt(attemptWithinBudget() ? "MEDIA_SCANNER_UNAVAILABLE" : "MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version, processorVersion: processedVideo.value.version, policyVersion: processedVideo.value.policyVersion }); }
          if (!attemptWithinBudget()) { await cleanupVideoOutputs(); return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version, processorVersion: processedVideo.value.version, policyVersion: processedVideo.value.policyVersion }); }
          if (!outputScan.ok || outputScan.value.verdict !== "clean") {
            await cleanupVideoOutputs();
            const code = !outputScan.ok ? outputScan.error.code === "MEDIA_PROCESSING_TIMEOUT" ? "MEDIA_PROCESSING_TIMEOUT" : "MEDIA_SCANNER_UNAVAILABLE" : outputScan.value.verdict === "unsafe" ? "MEDIA_OUTPUT_UNSAFE" : "MEDIA_SCAN_INCONCLUSIVE";
            return failedAttempt(code, { bytes, mime, hash: sha256, scannerVersion: outputScan.ok ? outputScan.value.version : scanned.value.version, processorVersion: processedVideo.value.version, policyVersion: processedVideo.value.policyVersion });
          }
          const outputHash = deps.digest.sha256(variant.bytes);
          const outputObjectId = deps.ids.generate("MediaObject") as StableId<string>;
          let sealed: Awaited<ReturnType<MediaProcessingStoragePort["sealProcessedObject"]>>;
          const sealTimeoutMs = Math.min(10_000, remainingBudgetMs());
          if (!sealTimeoutMs) { await cleanupVideoOutputs(); return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256, scannerVersion: outputScan.value.version, processorVersion: processedVideo.value.version, policyVersion: processedVideo.value.policyVersion }); }
          try { sealed = await deps.storage.sealProcessedObject({ portfolioId: candidate.portfolioId, mediaId: candidate.mediaId, outputObjectId,
            sourceObjectId: candidate.mediaObjectId, bytes: variant.bytes, sha256: outputHash, mimeType: variant.mimeType, timeoutMs: sealTimeoutMs }); }
          catch { await cleanupVideoOutputs(); return failedAttempt(attemptWithinBudget() ? "MEDIA_OUTPUT_SEAL_FAILED" : "MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256, scannerVersion: outputScan.value.version, processorVersion: processedVideo.value.version, policyVersion: processedVideo.value.policyVersion }); }
          if (!attemptWithinBudget()) { if (sealed.ok) { try { await deps.storage.discardSealedObject({ portfolioId: candidate.portfolioId, mediaId: candidate.mediaId, objectId: sealed.value.objectId, sha256: sealed.value.sha256, mimeType: variant.mimeType }); } catch { await deps.repository.recordOrphan({ candidate, objectId: sealed.value.objectId, sha256: sealed.value.sha256, mimeType: variant.mimeType }).catch(() => undefined); } } await cleanupVideoOutputs(); return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256, scannerVersion: outputScan.value.version, processorVersion: processedVideo.value.version, policyVersion: processedVideo.value.policyVersion }); }
          if (!sealed.ok || sealed.value.objectId !== outputObjectId || sealed.value.sha256 !== outputHash) {
            if (sealed.ok) {
              try { await deps.storage.discardSealedObject({ portfolioId: candidate.portfolioId, mediaId: candidate.mediaId, objectId: sealed.value.objectId, sha256: sealed.value.sha256, mimeType: variant.mimeType }); }
              catch { await deps.repository.recordOrphan({ candidate, objectId: sealed.value.objectId, sha256: sealed.value.sha256, mimeType: variant.mimeType }).catch(() => undefined); }
            }
            await cleanupVideoOutputs();
            return failedAttempt(sealed.ok ? "MEDIA_OUTPUT_HASH_MISMATCH" : "MEDIA_OUTPUT_SEAL_FAILED", { bytes, mime, hash: sha256, scannerVersion: outputScan.value.version, processorVersion: processedVideo.value.version, policyVersion: processedVideo.value.policyVersion });
          }
          const outputVariant: MediaProcessingOutputVariant = { variantName: variant.variantName, objectId: outputObjectId, mimeType: variant.mimeType,
            sha256: outputHash, byteLength: variant.bytes.byteLength, objectVersion: outputHash, width: variant.width, height: variant.height, codec: variant.codec };
          sealedVariants.push({ variant: outputVariant, bytes: variant.bytes });
          if (!attemptWithinBudget()) { await cleanupVideoOutputs(); return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256, scannerVersion: outputScan.value.version, processorVersion: processedVideo.value.version, policyVersion: processedVideo.value.policyVersion }); }
        }
        const primary = sealedVariants[0]!;
        const attempt: MediaProcessingAttempt = { attemptId: deps.ids.generate("MediaProcessingAttempt") as StableId<string>, mediaId: candidate.mediaId, result: "passed", startedAt,
          detectedMimeType: mime, detectedByteLength: bytes.byteLength, sha256, inputObjectId: candidate.mediaObjectId, outputObjectId: primary.variant.objectId,
          outputSha256: primary.variant.sha256, outputByteLength: primary.variant.byteLength, outputVariants: sealedVariants.map(({ variant }) => variant),
          processingDurationMs: elapsedMs(), scannerVersion: scanned.value.version, processorVersion: processedVideo.value.version, policyVersion: processedVideo.value.policyVersion, findings: [], recordedAt: deps.clock.now() };
        const commitTimeoutMs = Math.min(3_000, remainingBudgetMs());
        if (!commitTimeoutMs) {
          await cleanupVideoOutputs();
          return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version,
            processorVersion: processedVideo.value.version, policyVersion: processedVideo.value.policyVersion });
        }
        let committed: Awaited<ReturnType<MediaProcessingRepositoryPort["commitAttempt"]>>;
        try { committed = await deps.repository.commitAttempt({ candidate, expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey, requestHash, claimId, attempt, timeoutMs: commitTimeoutMs }); }
        catch { await cleanupVideoOutputs(); return err({ kind: "temporarily_unavailable", code: "MEDIA_PROCESSING_COMMIT_FAILED" }); }
        if (!committed.ok) { await cleanupVideoOutputs(); return err(committed.error); }
        return ok({ aggregateId: candidate.mediaId, aggregateVersion: committed.value.version, outcome: committed.value.outcome });
      }
      let processed: Awaited<ReturnType<PdfProcessorPort["process"]>> =
        err({ kind: "temporarily_unavailable" as const, code: "MEDIA_PROCESSOR_UNAVAILABLE" });
      const pdfProcessorFacts = { bytes, mime, hash: sha256, scannerVersion: scanned.value.version };
      const runPdfProcessor = () => deps.processor.process(bytes, { timeoutMs: remainingBudgetMs() });
      const retryPdfProcessor = async (): Promise<boolean> => {
        if (!attemptWithinBudget() || remainingBudgetMs() < 5_000) return false;
        await new Promise((resolve) => setTimeout(resolve, 250));
        try { processed = await runPdfProcessor(); } catch { return false; }
        return attemptWithinBudget();
      };
      try { processed = await runPdfProcessor(); }
      catch { if (!(await retryPdfProcessor())) return failedAttempt("MEDIA_PROCESSOR_UNAVAILABLE", pdfProcessorFacts); }
      if (!attemptWithinBudget()) return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { ...pdfProcessorFacts });
      if (!processed.ok && processed.error.kind !== "validation") await retryPdfProcessor();
      if (!attemptWithinBudget()) return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { ...pdfProcessorFacts });
      if (!processed.ok) return failedAttempt(processed.error.kind === "validation" ? processed.error.code : "MEDIA_PROCESSOR_UNAVAILABLE", pdfProcessorFacts);
      if (processed.value.bytes.byteLength < 1 || processed.value.bytes.byteLength > MEDIA_PROCESSING_POLICY.maxBytesByKind.document ||
          new TextDecoder("ascii").decode(processed.value.bytes.subarray(0, 5)) !== "%PDF-") return failedAttempt("MEDIA_PDF_OUTPUT_INVALID", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
      const outputHash = deps.digest.sha256(processed.value.bytes);
      let outputScan: Awaited<ReturnType<TrustedByteScannerPort["scan"]>>;
      const outputScanTimeoutMs = Math.min(60_000, remainingBudgetMs());
      if (!outputScanTimeoutMs) return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
      try { outputScan = await deps.scanner.scan(processed.value.bytes, { timeoutMs: outputScanTimeoutMs }); }
      catch { return failedAttempt("MEDIA_SCANNER_UNAVAILABLE", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion }); }
      if (!attemptWithinBudget()) return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
      if (!outputScan.ok) return failedAttempt("MEDIA_SCANNER_UNAVAILABLE", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
      if (outputScan.value.verdict !== "clean") return failedAttempt(outputScan.value.verdict === "unsafe" ? "MEDIA_OUTPUT_UNSAFE" : "MEDIA_SCAN_INCONCLUSIVE", { bytes, mime, hash: sha256, scannerVersion: outputScan.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
      const expectedOutputObjectId = deps.ids.generate("MediaObject") as StableId<string>;
      let sealed: Awaited<ReturnType<MediaProcessingStoragePort["sealProcessedObject"]>>;
      try { sealed = await deps.storage.sealProcessedObject({ portfolioId: candidate.portfolioId, mediaId: candidate.mediaId, outputObjectId: expectedOutputObjectId, sourceObjectId: candidate.mediaObjectId, bytes: processed.value.bytes, sha256: outputHash, mimeType: "application/pdf" }); }
      catch { return failedAttempt("MEDIA_OUTPUT_SEAL_FAILED", { bytes, mime, hash: sha256, scannerVersion: outputScan.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion }); }
      if (!sealed.ok) return failedAttempt("MEDIA_OUTPUT_SEAL_FAILED", { bytes, mime, hash: sha256, scannerVersion: scanned.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
      const discardOrRecordOrphan = async () => {
        try { await deps.storage.discardSealedObject({ portfolioId: candidate.portfolioId, mediaId: candidate.mediaId, objectId: sealed.value.objectId, sha256: sealed.value.sha256 }); }
        catch { await deps.repository.recordOrphan({ candidate, objectId: sealed.value.objectId, sha256: sealed.value.sha256 }).catch(() => undefined); }
      };
      if (sealed.value.objectId !== expectedOutputObjectId) {
        try { await deps.storage.discardSealedObject({ portfolioId: candidate.portfolioId, mediaId: candidate.mediaId, objectId: sealed.value.objectId, sha256: sealed.value.sha256 }); }
        catch { await deps.repository.recordOrphan({ candidate, objectId: sealed.value.objectId, sha256: sealed.value.sha256 }).catch(() => undefined); }
        return failedAttempt("MEDIA_OUTPUT_OBJECT_MISMATCH", { bytes, mime, hash: sha256, scannerVersion: outputScan.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion });
      }
      if (sealed.value.sha256 !== outputHash) { await discardOrRecordOrphan(); return failedAttempt("MEDIA_OUTPUT_HASH_MISMATCH", { bytes, mime, hash: sha256, scannerVersion: outputScan.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion }); }
      if (!attemptWithinBudget()) { await discardOrRecordOrphan(); return failedAttempt("MEDIA_PROCESSING_TIMEOUT", { bytes, mime, hash: sha256, scannerVersion: outputScan.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion }); }
      const attempt: MediaProcessingAttempt = { attemptId: deps.ids.generate("MediaProcessingAttempt") as StableId<string>, mediaId: candidate.mediaId, result: "passed", startedAt,
        detectedMimeType: mime, detectedByteLength: bytes.byteLength, sha256, inputObjectId: candidate.mediaObjectId, outputObjectId: sealed.value.objectId,
        outputSha256: outputHash, outputByteLength: processed.value.bytes.byteLength, scannerVersion: outputScan.value.version, processorVersion: processed.value.version, policyVersion: processed.value.policyVersion,
        findings: [], recordedAt: deps.clock.now() };
      let committed: Awaited<ReturnType<MediaProcessingRepositoryPort["commitAttempt"]>>;
      try { committed = await deps.repository.commitAttempt({ candidate, expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey, requestHash, claimId, attempt }); }
      catch { await discardOrRecordOrphan(); return err({ kind: "temporarily_unavailable", code: "MEDIA_PROCESSING_COMMIT_FAILED" }); }
      if (!committed.ok) { await discardOrRecordOrphan(); return err(committed.error); }
      return ok({ aggregateId: candidate.mediaId, aggregateVersion: committed.value.version, outcome: committed.value.outcome });
    },
  };
}
