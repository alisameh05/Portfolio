import { createHash } from "node:crypto";
import { err, ok, type Rejection, type Result } from "@shared/domain";
import type { CurrentCvObjectDeliveryPort } from "../../modules/cv-portfolio/index.js";

const MAX_CURRENT_CV_BYTES = 25 * 1024 * 1024;
const TARGET_LIFETIME_SECONDS = 300;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface SupabaseCurrentCvDeliveryOptions {
  readonly storageUrl: string;
  readonly serviceRoleKey: string;
  readonly mode: "deployed" | "test";
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

async function readVerifiedPdf(response: Response, expectedHash: string): Promise<Uint8Array | undefined> {
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
  const expectedLength = contentLengthHeader === null ? undefined : Number(contentLengthHeader);
  const bufferCapacity = expectedLength ?? MAX_CURRENT_CV_BYTES;
  // Retain one bounded buffer while hashing; no chunk list plus concatenation copy.
  const bytes = new Uint8Array(bufferCapacity);
  const digest = createHash("sha256");
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > bufferCapacity || total > MAX_CURRENT_CV_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      bytes.set(next.value, total - next.value.byteLength);
      digest.update(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0 || (expectedLength !== undefined && total !== expectedLength)) return undefined;
  const verified = bytes.subarray(0, total);
  if (!verified.subarray(0, 5).every((byte, index) => byte === [37, 80, 68, 70, 45][index]) ||
      digest.digest("hex") !== expectedHash) return undefined;
  return verified;
}

/** Reads and signs only the content-addressed, private processed PDF snapshot. */
export function createSupabaseCurrentCvDelivery(options: SupabaseCurrentCvDeliveryOptions): CurrentCvObjectDeliveryPort {
  const base = new URL(options.storageUrl);
  if (base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "" || base.pathname !== "/") {
    throw new TypeError("Current CV Storage URL must identify an origin without credentials or a path.");
  }
  if (base.protocol !== "https:" && !(options.mode === "test" && base.protocol === "http:" && LOOPBACK_HOSTS.has(base.hostname))) {
    throw new TypeError("Current CV Storage must use HTTPS outside loopback.");
  }
  if (options.serviceRoleKey.trim() === "") throw new TypeError("Media Storage service role key is required.");
  const bucket = safeBucket(options.processedBucket);
  const fetcher = options.fetcher ?? fetch;
  const headers = { apikey: options.serviceRoleKey, authorization: `Bearer ${options.serviceRoleKey}` };
  return {
    async isAvailable({ snapshot }) {
      let path: string;
      try { path = objectPath(snapshot); } catch { return false; }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await fetcher(new URL(`/storage/v1/object/${encodeURIComponent(bucket)}/${path}`, base), {
          method: "HEAD", headers, signal: controller.signal, redirect: "manual",
        });
        return response.ok;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
    async stream({ snapshot }) {
      let path: string;
      try { path = objectPath(snapshot); } catch { return unavailable(); }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetcher(new URL(`/storage/v1/object/${encodeURIComponent(bucket)}/${path}`, base), {
          headers, signal: controller.signal, redirect: "manual",
        });
        if (!response.ok) return unavailable();
        const bytes = await readVerifiedPdf(response, snapshot.sha256);
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
          signal: AbortSignal.timeout(10_000), redirect: "manual",
        });
        if (!response.ok) return unavailable();
        const payload: unknown = await response.json();
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return unavailable();
        const record = payload as Record<string, unknown>;
        const signedURL = record["signedURL"] ?? record["signedUrl"];
        if (typeof signedURL !== "string" || signedURL.length < 1 || signedURL.length > 4096) return unavailable();
        const url = new URL(signedURL, base);
        if (url.pathname.startsWith("/object/sign/")) url.pathname = `/storage/v1${url.pathname}`;
        if (url.origin !== base.origin || url.username !== "" || url.password !== "" || url.hash !== "" ||
            url.pathname !== `/storage/v1/object/sign/${encodeURIComponent(bucket)}/${path}` ||
            !url.searchParams.has("token") || url.searchParams.get("token")?.length === 0 ||
            (disposition === "attachment" && url.searchParams.get("download") !== "cv.pdf") ||
            (disposition === "inline" && url.searchParams.has("download"))) return unavailable();
        return ok({ url: url.toString(), expiresAt });
      } catch { return unavailable(); }
    },
  };
}
