import { createHash } from "node:crypto";
import { err, ok, type Rejection, type Result, type StableId } from "@shared/domain";
import type { OwnerExportObjectReadPort, OwnerExportObjectReadRequest } from "../../modules/portability-operations/application/service.js";

export interface OwnerExportObjectWritePort {
  writeOwnerExport(input: {
    readonly portfolioId: StableId<"Portfolio">;
    readonly exportId: StableId<"OwnerExport">;
    readonly artifactId: StableId<"OwnerExportArtifact">;
    readonly bytes: Uint8Array;
    readonly sha256: string;
  }): Promise<Result<void, Rejection>>;
}

export interface SupabaseOwnerExportStorageOptions {
  readonly storageUrl: string;
  readonly serviceRoleKey: string;
  readonly bucket?: string;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}

const MAX_TIMEOUT_MS = 30_000;
function unavailable(): Result<never, Rejection> {
  return err({ kind: "temporarily_unavailable", code: "OWNER_EXPORT_ARTIFACT_UNAVAILABLE" });
}

function validBucket(value: string): string {
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(value)) throw new TypeError("Invalid Owner export bucket.");
  return value;
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function verifyStream(
  content: AsyncIterable<Uint8Array>,
  expectedLength: number,
  expectedSha256: string,
): Promise<boolean> {
  const digest = createHash("sha256");
  let total = 0;
  try {
    for await (const chunk of content) {
      total += chunk.byteLength;
      if (total > expectedLength) return false;
      digest.update(chunk);
    }
  } catch {
    return false;
  }
  return total === expectedLength && digest.digest("hex") === expectedSha256;
}

/** Private server-side Storage adapter; provider paths and credentials stay inside this closure. */
export function createSupabaseOwnerExportStorage(options: SupabaseOwnerExportStorageOptions): OwnerExportObjectReadPort & OwnerExportObjectWritePort {
  const base = new URL(options.storageUrl);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "::1", "[::1]"].includes(base.hostname))) {
    throw new TypeError("Owner export Storage must use HTTPS outside loopback.");
  }
  if (options.serviceRoleKey.trim() === "") throw new TypeError("Owner export Storage service role key is required.");
  const bucket = validBucket(options.bucket ?? "owner-exports");
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = Math.max(1, Math.min(MAX_TIMEOUT_MS, options.timeoutMs ?? 15_000));
  const headers = { apikey: options.serviceRoleKey, authorization: `Bearer ${options.serviceRoleKey}` };
  const pathFor = (input: Pick<OwnerExportObjectReadRequest, "portfolioId" | "exportId" | "artifactId">) =>
    [input.portfolioId, input.exportId, `${input.artifactId}.zip`].map((part) => encodeURIComponent(part)).join("/");

  async function readOwnerExport(input: OwnerExportObjectReadRequest) {
    if (!Number.isSafeInteger(input.expectedContentLength) || input.expectedContentLength < 1 ||
        !/^[a-f0-9]{64}$/.test(input.expectedSha256)) return err({ kind: "validation" as const, code: "EXPORT_OBJECT_READ_INVALID" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(new URL(`/storage/v1/object/${encodeURIComponent(bucket)}/${pathFor(input)}`, base), {
        signal: controller.signal,
        headers,
      });
      if (!response.ok || response.body === null) {
        clearTimeout(timer);
        return unavailable();
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength !== input.expectedContentLength) {
        await response.body.cancel().catch(() => undefined);
        clearTimeout(timer);
        return err({ kind: "validation" as const, code: "EXPORT_OBJECT_LENGTH_MISMATCH" });
      }
      const body = response.body;
      const content: AsyncIterable<Uint8Array> = {
        async *[Symbol.asyncIterator]() {
          const reader = body.getReader();
          const digest = createHash("sha256");
          let total = 0;
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              total += next.value.byteLength;
              if (total > input.expectedContentLength) throw new Error("OWNER_EXPORT_STREAM_LENGTH_MISMATCH");
              digest.update(next.value);
              yield next.value;
            }
            if (total !== input.expectedContentLength || digest.digest("hex") !== input.expectedSha256) {
              throw new Error("OWNER_EXPORT_STREAM_INTEGRITY_MISMATCH");
            }
          } finally {
            if (controller.signal.aborted) await reader.cancel().catch(() => undefined);
            reader.releaseLock();
            clearTimeout(timer);
          }
        },
      };
      return ok({ contentLength: input.expectedContentLength, sha256: input.expectedSha256, content });
    } catch {
      clearTimeout(timer);
      return unavailable();
    }
  }

  async function writeOwnerExport(input: Parameters<OwnerExportObjectWritePort["writeOwnerExport"]>[0]) {
    if (hash(input.bytes) !== input.sha256 || input.bytes.byteLength < 1) {
      return err({ kind: "validation" as const, code: "EXPORT_OBJECT_CANDIDATE_INVALID" });
    }
    const requestPath = `/storage/v1/object/${encodeURIComponent(bucket)}/${pathFor(input)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = new ArrayBuffer(input.bytes.byteLength);
      new Uint8Array(body).set(input.bytes);
      const response = await fetcher(new URL(requestPath, base), {
        method: "POST",
        signal: controller.signal,
        headers: { ...headers, "content-type": "application/vnd.shipwithali.owner-export+zip", "x-upsert": "false" },
        body,
      });
      if (response.ok) return ok(undefined);
      if (response.status === 409 || response.status === 400) {
        const existing = await readOwnerExport({ ...input, expectedContentLength: input.bytes.byteLength });
        if (existing.ok && await verifyStream(existing.value.content, input.bytes.byteLength, input.sha256)) return ok(undefined);
      }
      return unavailable();
    } catch {
      return unavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  return { readOwnerExport, writeOwnerExport };
}
