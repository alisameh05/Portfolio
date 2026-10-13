import { createHash } from "node:crypto";
import { err, ok, type Rejection, type Result } from "@shared/domain";
import type { CurrentCvObjectDeliveryPort } from "../../modules/cv-portfolio/index.js";

const MAX_CURRENT_CV_BYTES = 25 * 1024 * 1024;
const TARGET_LIFETIME_SECONDS = 300;

export interface SupabaseCurrentCvDeliveryOptions {
  readonly storageUrl: string;
  readonly serviceRoleKey: string;
  readonly processedBucket?: string;
  readonly fetcher?: typeof fetch;
}

function unavailable(): Result<never, Rejection> {
  return err({ kind: "temporarily_unavailable", code: "CURRENT_CV_STORAGE_UNAVAILABLE" });
}

function safeBucket(value: string | undefined): string {
  const bucket = value ?? "media-processed";
  if (!/^[a-z][a-z0-9-]{2,62}$/u.test(bucket)) throw new TypeError("Invalid processed Media bucket.");
  return bucket;
}

function objectPath(snapshot: Parameters<CurrentCvObjectDeliveryPort["stream"]>[0]["snapshot"]): string {
  const stableId = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  if (!stableId.test(snapshot.portfolioId) || !stableId.test(snapshot.mediaAssetId) || !stableId.test(snapshot.objectId) ||
      !/^[0-9a-f]{64}$/u.test(snapshot.sha256) || snapshot.objectVersion !== snapshot.sha256) {
    throw new TypeError("Invalid immutable Current CV object binding.");
  }
  return ["processed", snapshot.portfolioId, snapshot.mediaAssetId, snapshot.objectId, `${snapshot.sha256}.pdf`]
    .map((segment) => encodeURIComponent(segment)).join("/");
}

async function readBoundedPdf(response: Response, expectedHash: string): Promise<Uint8Array | undefined> {
  if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/pdf") return undefined;
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > MAX_CURRENT_CV_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
  }
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_CURRENT_CV_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return undefined;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (!bytes.subarray(0, 5).every((byte, index) => byte === [37, 80, 68, 70, 45][index]) ||
      createHash("sha256").update(bytes).digest("hex") !== expectedHash) return undefined;
  return bytes;
}

/** Reads and signs only the content-addressed, private processed PDF snapshot. */
export function createSupabaseCurrentCvDelivery(options: SupabaseCurrentCvDeliveryOptions): CurrentCvObjectDeliveryPort {
  const base = new URL(options.storageUrl);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(base.hostname))) {
    throw new TypeError("Current CV Storage must use HTTPS outside loopback.");
  }
  if (options.serviceRoleKey.trim() === "") throw new TypeError("Media Storage service role key is required.");
  const bucket = safeBucket(options.processedBucket);
  const fetcher = options.fetcher ?? fetch;
  const headers = { apikey: options.serviceRoleKey, authorization: `Bearer ${options.serviceRoleKey}` };
  return {
    async stream({ snapshot }) {
      let path: string;
      try { path = objectPath(snapshot); } catch { return unavailable(); }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetcher(new URL(`/storage/v1/object/${encodeURIComponent(bucket)}/${path}`, base), {
          headers, signal: controller.signal,
        });
        if (!response.ok) return unavailable();
        const bytes = await readBoundedPdf(response, snapshot.sha256);
        if (bytes === undefined) return unavailable();
        const chunkSize = 64 * 1024;
        return ok((async function* () {
          for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
            yield bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength));
          }
        })());
      } catch { return unavailable(); }
      finally { clearTimeout(timer); }
    },
    async createDownloadTarget({ snapshot, disposition }) {
      let path: string;
      try { path = objectPath(snapshot); } catch { return unavailable(); }
      const expiresAt = new Date(Date.now() + TARGET_LIFETIME_SECONDS * 1_000).toISOString();
      try {
        const response = await fetcher(new URL(`/storage/v1/object/sign/${encodeURIComponent(bucket)}/${path}`, base), {
          method: "POST", headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ expiresIn: TARGET_LIFETIME_SECONDS,
            ...(disposition === "attachment" ? { download: "cv.pdf" } : {}) }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) return unavailable();
        const payload: unknown = await response.json();
        if (typeof payload !== "object" || payload === null || !("signedURL" in payload) || typeof payload.signedURL !== "string") return unavailable();
        const url = new URL(payload.signedURL, base);
        if (url.origin !== base.origin || url.username !== "" || url.password !== "" ||
            url.pathname !== `/storage/v1/object/sign/${encodeURIComponent(bucket)}/${path}` ||
            (disposition === "attachment" && url.searchParams.get("download") !== "cv.pdf") ||
            (disposition === "inline" && url.searchParams.has("download"))) return unavailable();
        return ok({ url: url.toString(), expiresAt });
      } catch { return unavailable(); }
    },
  };
}
