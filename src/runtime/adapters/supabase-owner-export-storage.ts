import { createHash } from "node:crypto";
import { err, ok, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import { MAX_OWNER_EXPORT_ARTIFACT_BYTES, type OwnerExportObjectReadPort, type OwnerExportObjectReadRequest } from "../../modules/portability-operations/application/service.js";
import type { OwnerExportObjectDeletePort } from "../../modules/portability-operations/application/owner-export-cleanup.js";

export interface OwnerExportObjectWritePort {
  writeOwnerExport(input: {
    readonly portfolioId: StableId<"Portfolio">;
    readonly exportId: StableId<"OwnerExport">;
    readonly artifactId: StableId<"OwnerExportArtifact">;
    readonly content: AsyncIterable<Uint8Array>;
    readonly contentLength: number;
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

function toVerifiedReadableStream(
  content: AsyncIterable<Uint8Array>,
  expectedLength: number,
  expectedSha256: string,
): ReadableStream<Uint8Array> {
  const iterator = content[Symbol.asyncIterator]();
  const digest = createHash("sha256");
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          if (total !== expectedLength || digest.digest("hex") !== expectedSha256) {
            throw new Error("OWNER_EXPORT_UPLOAD_STREAM_INTEGRITY_MISMATCH");
          }
          controller.close();
          return;
        }
        total += next.value.byteLength;
        if (total > expectedLength) throw new Error("OWNER_EXPORT_UPLOAD_STREAM_LENGTH_MISMATCH");
        digest.update(next.value);
        controller.enqueue(next.value);
      } catch (error) {
        await iterator.return?.();
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  }, { highWaterMark: 1 });
}

/** Private server-side Storage adapter; provider paths and credentials stay inside this closure. */
export function createSupabaseOwnerExportStorage(options: SupabaseOwnerExportStorageOptions): OwnerExportObjectReadPort & OwnerExportObjectWritePort & OwnerExportObjectDeletePort {
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
    if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1 ||
        input.contentLength > MAX_OWNER_EXPORT_ARTIFACT_BYTES || !/^[a-f0-9]{64}$/.test(input.sha256) ||
        input.content === null || typeof input.content[Symbol.asyncIterator] !== "function") {
      return err({ kind: "validation" as const, code: "EXPORT_OBJECT_CANDIDATE_INVALID" });
    }
    const requestPath = `/storage/v1/object/${encodeURIComponent(bucket)}/${pathFor(input)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const requestInit: RequestInit & { duplex: "half" } = {
        method: "POST",
        signal: controller.signal,
        duplex: "half",
        headers: {
          ...headers,
          "content-type": "application/vnd.shipwithali.owner-export+zip",
          "content-length": String(input.contentLength),
          "x-upsert": "false",
        },
        body: toVerifiedReadableStream(input.content, input.contentLength, input.sha256),
      };
      const response = await fetcher(new URL(requestPath, base), requestInit);
      if (response.ok) return ok(undefined);
      if (response.status === 409 || response.status === 400) {
        const existing = await readOwnerExport({
          portfolioId: input.portfolioId,
          exportId: input.exportId,
          artifactId: input.artifactId,
          expectedSha256: input.sha256,
          expectedContentLength: input.contentLength,
        });
        if (existing.ok && await verifyStream(existing.value.content, input.contentLength, input.sha256)) return ok(undefined);
      }
      return unavailable();
    } catch {
      return unavailable();
    } finally {
      clearTimeout(timer);
    }
  }

  return { readOwnerExport, writeOwnerExport,
    async deleteOwnerExport(input) {
      if (!parseStableId("Portfolio", input.portfolioId).ok || !parseStableId("OwnerExport", input.exportId).ok ||
          !parseStableId("OwnerExportArtifact", input.artifactId).ok) return err({ kind: "validation", code: "EXPORT_OBJECT_DELETE_INVALID" });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // Use the Storage API: deleting metadata with SQL would orphan bytes.
        const response = await fetcher(new URL(`/storage/v1/object/${encodeURIComponent(bucket)}`, base), {
          method: "DELETE", signal: controller.signal, redirect: "error",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ prefixes: [[input.portfolioId, input.exportId, `${input.artifactId}.zip`].join("/")] }),
        });
        return response.ok ? ok(undefined) : unavailable();
      } catch { return unavailable(); }
      finally { clearTimeout(timer); }
    },
  };
}
