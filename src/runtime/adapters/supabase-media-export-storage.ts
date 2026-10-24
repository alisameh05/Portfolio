import { createHash } from "node:crypto";
import type { OwnerExportMediaObjectReaderPort } from "../../modules/portability-operations/application/owner-export-package.js";

export interface SupabaseMediaExportStorageOptions {
  readonly storageUrl: string;
  readonly serviceRoleKey: string;
  readonly candidateBucket?: string;
  readonly processedBucket?: string;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}

const MAX_MEDIA_EXPORT_OBJECT_BYTES = 50 * 1024 * 1024;
function validBucket(value: string): string {
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(value)) throw new TypeError("Invalid Media bucket.");
  return value;
}
function extension(mediaType: string): string | undefined {
  return mediaType === "application/pdf" ? "pdf" : mediaType === "image/jpeg" ? "jpeg" : mediaType === "image/png" ? "png"
    : mediaType === "image/webp" ? "webp"
    : mediaType === "video/mp4" ? "mp4" : mediaType === "video/webm" ? "webm" : undefined;
}
function id(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

/** Reads accepted immutable Media bytes directly from private Storage; no signed URL is created. */
export function createSupabaseMediaExportStorage(options: SupabaseMediaExportStorageOptions): OwnerExportMediaObjectReaderPort {
  const base = new URL(options.storageUrl);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(base.hostname))) {
    throw new TypeError("Media export Storage must use HTTPS outside loopback.");
  }
  if (options.serviceRoleKey.trim() === "") throw new TypeError("Media export Storage service role key is required.");
  const candidateBucket = validBucket(options.candidateBucket ?? "media-candidates");
  const processedBucket = validBucket(options.processedBucket ?? "media-processed");
  if (candidateBucket === processedBucket) throw new TypeError("Candidate and processed Media buckets must be separate.");
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = Math.max(1, Math.min(30_000, options.timeoutMs ?? 20_000));
  return {
    async readMediaExportObject(input: Parameters<OwnerExportMediaObjectReaderPort["readMediaExportObject"]>[0]) {
      const fileExtension = extension(input.mediaType);
      if (!fileExtension || !id(input.portfolioId) || !id(input.mediaId) || !id(input.objectId) ||
          input.source !== "original" && input.source !== "variant" ||
          input.source === "original" && !id(input.uploadIntentId ?? "") ||
          input.source === "variant" && input.uploadIntentId !== undefined ||
          !Number.isSafeInteger(input.expectedLength) || input.expectedLength < 1 || input.expectedLength > MAX_MEDIA_EXPORT_OBJECT_BYTES ||
          !/^[a-f0-9]{64}$/.test(input.expectedSha256)) throw new Error("MEDIA_EXPORT_OBJECT_INVALID");
      const bucket = input.source === "original" ? candidateBucket : processedBucket;
      const parts = input.source === "original"
        ? ["candidate", input.portfolioId, input.mediaId, input.uploadIntentId!, input.objectId]
        : ["processed", input.portfolioId, input.mediaId, input.objectId, `${input.expectedSha256}.${fileExtension}`];
      const encodedPath = parts
        .map(encodeURIComponent).join("/");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetcher(new URL(`/storage/v1/object/${encodeURIComponent(bucket)}/${encodedPath}`, base), {
        signal: controller.signal,
        redirect: "manual",
        headers: { apikey: options.serviceRoleKey, authorization: `Bearer ${options.serviceRoleKey}` },
      }).catch((error: unknown) => {
        clearTimeout(timer);
        throw error;
      });
      if (response.status !== 200 || response.body === null) {
        await response.body?.cancel().catch(() => undefined);
        clearTimeout(timer);
        throw new Error("MEDIA_EXPORT_OBJECT_UNAVAILABLE");
      }
      const contentLengthHeader = response.headers.get("content-length");
      if (contentLengthHeader !== null) {
        const declaredLength = Number(contentLengthHeader);
        if (!Number.isSafeInteger(declaredLength) || declaredLength !== input.expectedLength) {
          await response.body.cancel().catch(() => undefined);
          clearTimeout(timer);
          throw new Error("MEDIA_EXPORT_OBJECT_LENGTH_MISMATCH");
        }
      }
      const body = response.body;
      const content: AsyncIterable<Uint8Array> = {
        async *[Symbol.asyncIterator]() {
          const reader = body.getReader();
          const digest = createHash("sha256");
          let total = 0;
          let verified = false;
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              total += next.value.byteLength;
              if (total > input.expectedLength || total > MAX_MEDIA_EXPORT_OBJECT_BYTES) throw new Error("MEDIA_EXPORT_OBJECT_LENGTH_MISMATCH");
              digest.update(next.value);
              yield next.value;
            }
            if (total !== input.expectedLength) {
              throw new Error("MEDIA_EXPORT_OBJECT_LENGTH_MISMATCH");
            }
            if (digest.digest("hex") !== input.expectedSha256) {
              throw new Error("MEDIA_EXPORT_OBJECT_INTEGRITY_MISMATCH");
            }
            verified = true;
          } finally {
            if (!verified) await reader.cancel().catch(() => undefined);
            reader.releaseLock();
            clearTimeout(timer);
          }
        },
      };
      return content;
    },
  };
}
