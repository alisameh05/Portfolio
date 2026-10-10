import { createHash } from "node:crypto";
import { err, ok, type Rejection, type Result, type StableId } from "@shared/domain";
import type { MediaProcessingStoragePort } from "../../modules/media/application/processing.js";

export interface SupabaseMediaProcessingStorageOptions {
  readonly storageUrl: string;
  readonly serviceRoleKey: string;
  readonly candidateBucket?: string;
  readonly processedBucket?: string;
  readonly fetcher?: typeof fetch;
}

function unavailable(): Result<never, Rejection> { return err({ kind: "temporarily_unavailable", code: "MEDIA_STORAGE_UNAVAILABLE" }); }
function bucket(value: string | undefined, fallback: string): string {
  const result = value ?? fallback;
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(result)) throw new TypeError("Invalid Media bucket.");
  return result;
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Reads only the intent-bound candidate and writes create-only processed PDFs. */
export function createSupabaseMediaProcessingStorage(options: SupabaseMediaProcessingStorageOptions): MediaProcessingStoragePort {
  const base = new URL(options.storageUrl);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(base.hostname))) throw new TypeError("Media Storage must use HTTPS outside loopback.");
  if (options.serviceRoleKey.trim() === "") throw new TypeError("Media Storage service role key is required.");
  const candidateBucket = bucket(options.candidateBucket, "media-candidates");
  const processedBucket = bucket(options.processedBucket, "media-processed");
  if (candidateBucket === processedBucket) throw new TypeError("Candidate and processed buckets must be separate.");
  const fetcher = options.fetcher ?? fetch;
  const headers = { apikey: options.serviceRoleKey, authorization: `Bearer ${options.serviceRoleKey}` };
  const request = (path: string, init?: RequestInit) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    return fetcher(new URL(`/storage/v1${path}`, base), { ...init, signal: controller.signal, headers: { ...headers, ...(init?.headers ?? {}) } })
      .finally(() => clearTimeout(timer));
  };
  const objectPath = (...parts: string[]) => parts.map((part) => encodeURIComponent(part)).join("/");
  return {
    async readCandidate(input) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      try {
        const path = objectPath("candidate", input.portfolioId, input.mediaId, input.uploadIntentId, input.objectId);
        const response = await fetcher(new URL(`/storage/v1/object/${encodeURIComponent(candidateBucket)}/${path}`, base), {
          signal: controller.signal, headers,
        });
        if (!response.ok) return unavailable();
        const bytes = await readBounded(response, 20 * 1024 * 1024);
        if (!bytes) return err({ kind: "validation", code: "MEDIA_BYTES_OUT_OF_BOUNDS" });
        return ok(bytes);
      } catch { return unavailable(); }
      finally { clearTimeout(timer); }
    },
    async sealProcessedPdf(input) {
      try {
        const digest = createHash("sha256").update(input.bytes).digest("hex");
        if (digest !== input.sha256 || !/^[0-9a-f]{64}$/.test(input.sha256)) return err({ kind: "validation", code: "MEDIA_OUTPUT_HASH_MISMATCH" });
        const path = objectPath("processed", input.portfolioId, input.mediaId, input.outputObjectId, `${input.sha256}.pdf`);
        const response = await request(`/object/${encodeURIComponent(processedBucket)}/${path}`, {
          method: "POST",
          headers: { "content-type": "application/pdf", "x-upsert": "false" },
          body: (() => { const copy = new ArrayBuffer(input.bytes.byteLength); new Uint8Array(copy).set(input.bytes); return copy; })(),
        });
        if (!response.ok) return unavailable();
        return ok({ objectId: input.outputObjectId as StableId<string>, sha256: digest });
      } catch { return unavailable(); }
    },
    async discardSealedObject(input) {
      if (!/^[0-9a-f-]{36}$/i.test(input.objectId) || !/^[0-9a-f]{64}$/.test(input.sha256)) return;
      const exactPath = objectPath("processed", input.portfolioId, input.mediaId, input.objectId, `${input.sha256}.pdf`);
      try {
        const response = await request(`/object/${encodeURIComponent(processedBucket)}`, {
          method: "DELETE", headers: { "content-type": "application/json" },
          body: JSON.stringify({ prefixes: [decodeURIComponent(exactPath)] }),
        });
        if (!response.ok && response.status !== 404) throw new Error("MEDIA_STORAGE_CLEANUP_UNAVAILABLE");
      } catch { throw new Error("MEDIA_STORAGE_CLEANUP_UNAVAILABLE"); }
    },
  };
}
