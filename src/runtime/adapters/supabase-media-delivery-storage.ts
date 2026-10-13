import { err, type StableId } from "@shared/domain";
import type { MediaDeliveryStoragePort } from "../../modules/media/index.js";

const SIGNED_URL_LIFETIME_SECONDS = 5 * 60;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface SupabaseMediaDeliveryStorageOptions {
  readonly storageUrl: string;
  readonly serviceRoleKey: string;
  readonly portfolioId: StableId<"Portfolio">;
  readonly mode: "deployed" | "test";
  readonly candidateBucket?: string;
  readonly processedBucket?: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
}

function bucket(value: string | undefined, fallback: string): string {
  const name = value ?? fallback;
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(name)) throw new TypeError("Invalid Media bucket.");
  return name;
}

function configuredBase(raw: string, mode: SupabaseMediaDeliveryStorageOptions["mode"]): URL {
  const base = new URL(raw);
  if (base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "" || base.pathname !== "/") {
    throw new TypeError("Media Storage origin must not contain credentials or a path.");
  }
  if (base.protocol !== "https:" && !(mode === "test" && base.protocol === "http:" && LOOPBACK_HOSTS.has(base.hostname))) {
    throw new TypeError("Media Storage origin must use HTTPS outside isolated loopback tests.");
  }
  return base;
}

function extension(mimeType: string): string | undefined {
  return mimeType === "application/pdf" ? "pdf" : mimeType === "image/webp" ? "webp"
    : mimeType === "video/mp4" ? "mp4" : mimeType === "video/webm" ? "webm" : undefined;
}

function encodedPath(parts: readonly string[]): string {
  return parts.map(encodeURIComponent).join("/");
}

function parseSignedTarget(value: unknown, base: URL, bucketName: string, path: string): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const raw = record["signedURL"] ?? record["signedUrl"];
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 4096) return undefined;
  try {
    const target = new URL(raw, base);
    if (target.pathname.startsWith("/object/sign/")) target.pathname = `/storage/v1${target.pathname}`;
    const expected = `/storage/v1/object/sign/${encodeURIComponent(bucketName)}/${path}`;
    if (target.origin !== base.origin || target.pathname !== expected || target.searchParams.get("token")?.length === 0 ||
        !target.searchParams.has("token") || target.username !== "" || target.password !== "" || target.hash !== "") return undefined;
    return target.toString();
  } catch { return undefined; }
}

/** Signs only a content-hash-bound processed variant from the private bucket. */
export function createSupabaseMediaDeliveryStorage(options: SupabaseMediaDeliveryStorageOptions): MediaDeliveryStoragePort {
  const base = configuredBase(options.storageUrl, options.mode);
  if (options.serviceRoleKey.trim() === "") throw new TypeError("Media Storage service key is required.");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(options.portfolioId)) {
    throw new TypeError("Invalid configured Portfolio identity.");
  }
  const candidateBucket = bucket(options.candidateBucket, "media-candidates");
  const processedBucket = bucket(options.processedBucket, "media-processed");
  if (candidateBucket === processedBucket) throw new TypeError("Media buckets must be separate.");
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;

  return {
    async createSignedDeliveryTarget(input) {
      const fileExtension = extension(input.variant.mimeType);
      if (!fileExtension || input.variant.objectVersion !== input.variant.sha256 ||
          !/^[0-9a-f]{64}$/.test(input.variant.sha256) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.mediaAssetId) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.variant.objectId)) {
        return err({ kind: "conflict", code: "MEDIA_DELIVERY_OBJECT_INVALID" });
      }
      const path = encodedPath(["processed", options.portfolioId, input.mediaAssetId, input.variant.objectId,
        `${input.variant.sha256}.${fileExtension}`]);
      const expiry = now() + SIGNED_URL_LIFETIME_SECONDS * 1000;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await fetcher(new URL(`/storage/v1/object/sign/${encodeURIComponent(processedBucket)}/${path}`, base), {
          method: "POST",
          signal: controller.signal,
          headers: {
            apikey: options.serviceRoleKey,
            authorization: `Bearer ${options.serviceRoleKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ expiresIn: SIGNED_URL_LIFETIME_SECONDS }),
        });
        if (!response.ok) return err({ kind: "temporarily_unavailable", code: "MEDIA_DELIVERY_UNAVAILABLE" });
        const body: unknown = await response.json();
        const url = parseSignedTarget(body, base, processedBucket, path);
        if (!url) return err({ kind: "temporarily_unavailable", code: "MEDIA_DELIVERY_UNAVAILABLE" });
        return { ok: true, value: { url, expiresAt: new Date(expiry).toISOString() } };
      } catch {
        return err({ kind: "temporarily_unavailable", code: "MEDIA_DELIVERY_UNAVAILABLE" });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
