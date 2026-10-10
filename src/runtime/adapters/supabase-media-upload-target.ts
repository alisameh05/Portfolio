import type { MediaUploadTargetPort } from "../../modules/media/application/upload-intent.js";
import type { Rejection, Result } from "@shared/domain";

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const SIGNED_UPLOAD_LIFETIME_SECONDS = 2 * 60 * 60;
const ALLOWED_MIME_TYPES = [
  "image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm", "application/pdf",
] as const;

export interface SupabaseMediaUploadTargetOptions {
  readonly storageUrl: string;
  readonly serviceRoleKey: string;
  readonly candidateBucket?: string;
  readonly processedBucket?: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
}

function failure(code: string): Result<never, Rejection> {
  return { ok: false, error: { kind: "temporarily_unavailable", code } };
}

function apiHeaders(key: string): HeadersInit {
  return { apikey: key, authorization: `Bearer ${key}` };
}

function bucketName(value: string | undefined, fallback: string): string {
  const name = value ?? fallback;
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(name)) throw new TypeError("Invalid private Media bucket name.");
  return name;
}

function safeBase(raw: string): URL {
  const base = new URL(raw);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(base.hostname))) {
    throw new TypeError("Media Storage endpoint must use HTTPS outside loopback.");
  }
  base.pathname = base.pathname.replace(/\/$/, "");
  return base;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSignedTarget(data: unknown, base: URL, bucket: string, objectPath: string): string | undefined {
  if (!isRecord(data)) return undefined;
  const target = data["signedUrl"] ?? data["signedURL"] ?? data["url"];
  if (typeof target === "string" && target.length > 0) {
    try {
      const url = new URL(target, base);
      if (url.pathname.startsWith("/object/upload/sign/")) {
        url.pathname = `/storage/v1${url.pathname}`;
      }
      if (url.origin === base.origin && url.searchParams.has("token")) return url.toString();
    } catch { return undefined; }
  }
  const token = data["token"];
  if (typeof token !== "string" || token.length < 16) return undefined;
  return new URL(`/storage/v1/object/upload/sign/${encodeURIComponent(bucket)}/${objectPath.split("/").map(encodeURIComponent).join("/")}?token=${encodeURIComponent(token)}`, base).toString();
}

/** Supabase Storage adapter: only the exact private candidate target is signed. */
export function createSupabaseMediaUploadTargetAdapter(
  options: SupabaseMediaUploadTargetOptions,
): MediaUploadTargetPort {
  const base = safeBase(options.storageUrl);
  if (options.serviceRoleKey.trim() === "") throw new TypeError("Media Storage service key is required.");
  const candidateBucket = bucketName(options.candidateBucket, "media-candidates");
  const processedBucket = bucketName(options.processedBucket, "media-processed");
  if (candidateBucket === processedBucket) throw new TypeError("Candidate and processed Media buckets must be separate.");
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;

  async function request(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetcher(new URL(path, base), {
        ...init,
        headers: { ...apiHeaders(options.serviceRoleKey), ...(init?.headers ?? {}) },
      });
    } catch {
      throw new Error("MEDIA_STORAGE_UNAVAILABLE");
    }
  }

  async function ensurePrivateBucket(bucket: string): Promise<boolean> {
    let response = await request(`/storage/v1/bucket/${encodeURIComponent(bucket)}`);
    let missingBucket = response.status === 404;
    if (response.status === 400) {
      try {
        const error: unknown = await response.clone().json();
        missingBucket = isRecord(error) && error["code"] === "NoSuchBucket" && error["statusCode"] === "404";
      } catch { /* A malformed error is not treated as a missing bucket. */ }
    }
    if (missingBucket) {
      response = await request("/storage/v1/bucket", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: bucket,
          name: bucket,
          public: false,
          file_size_limit: MAX_UPLOAD_BYTES,
          allowed_mime_types: ALLOWED_MIME_TYPES,
        }),
      });
      if (![200, 201, 409].includes(response.status)) return false;
      response = await request(`/storage/v1/bucket/${encodeURIComponent(bucket)}`);
    }
    if (!response.ok) return false;
    let metadata: unknown;
    try { metadata = await response.json(); } catch { return false; }
    if (!isRecord(metadata) || metadata["public"] !== false ||
        Number(metadata["file_size_limit"]) !== MAX_UPLOAD_BYTES || !Array.isArray(metadata["allowed_mime_types"])) return false;
    const actualTypes = metadata["allowed_mime_types"].filter((value): value is string => typeof value === "string").sort();
    return actualTypes.length === ALLOWED_MIME_TYPES.length &&
      actualTypes.every((value, index) => value === [...ALLOWED_MIME_TYPES].sort()[index]);
  }

  return {
    async prepare(input) {
      if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > MAX_UPLOAD_BYTES) {
        return { ok: false, error: { kind: "validation", code: "MEDIA_UPLOAD_SIZE_OUT_OF_BOUNDS" } };
      }
      if (!(await ensurePrivateBucket(candidateBucket)) || !(await ensurePrivateBucket(processedBucket))) {
        return failure("MEDIA_STORAGE_BUCKET_UNAVAILABLE");
      }
      const objectPath = `candidate/${input.portfolioId}/${input.mediaId}/${input.uploadIntentId}/${input.mediaObjectId}`;
      const startedAt = now();
      try {
        const response = await request(`/storage/v1/object/upload/sign/${encodeURIComponent(candidateBucket)}/${objectPath.split("/").map(encodeURIComponent).join("/")}`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-upsert": "false" },
          body: JSON.stringify({}),
        });
        if (!response.ok) return failure("MEDIA_STORAGE_TARGET_UNAVAILABLE");
        const data: unknown = await response.json();
        const uploadTarget = parseSignedTarget(data, base, candidateBucket, objectPath);
        if (uploadTarget === undefined) return failure("MEDIA_STORAGE_TARGET_INVALID");
        return {
          ok: true,
          value: {
            uploadTarget,
            expiresAt: new Date(startedAt + SIGNED_UPLOAD_LIFETIME_SECONDS * 1000).toISOString(),
          },
        };
      } catch {
        return failure("MEDIA_STORAGE_TARGET_UNAVAILABLE");
      }
    },

    async removeAbandoned(input) {
      const objectPath = `candidate/${input.portfolioId}/${input.mediaId}/${input.uploadIntentId}/${input.mediaObjectId}`;
      try {
        const response = await request(`/storage/v1/object/${encodeURIComponent(candidateBucket)}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prefixes: [objectPath] }),
        });
        if (response.ok || response.status === 404) return { ok: true, value: undefined };
        return failure("MEDIA_STORAGE_CLEANUP_UNAVAILABLE");
      } catch {
        return failure("MEDIA_STORAGE_CLEANUP_UNAVAILABLE");
      }
    },
  };
}
