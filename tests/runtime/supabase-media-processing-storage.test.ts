import { describe, expect, it } from "vitest";
import { createSupabaseMediaProcessingStorage } from "../../src/runtime/adapters/supabase-media-processing-storage.js";

const ids = {
  portfolioId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea1" as never,
  mediaId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec0" as never,
  uploadIntentId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec1" as never,
  objectId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec2" as never,
};

describe("Supabase Media processing Storage adapter", () => {
  it("stops a streamed candidate read at the 20 MiB PDF bound", async () => {
    let chunksRead = 0;
    let cancelled = false;
    const fetcher: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksRead += 1;
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }));
    const storage = createSupabaseMediaProcessingStorage({ storageUrl: "http://127.0.0.1:57321", serviceRoleKey: "local-service-role", fetcher });
    const result = await storage.readCandidate(ids);
    expect(result).toMatchObject({ ok: false, error: { code: "MEDIA_BYTES_OUT_OF_BOUNDS" } });
    expect(chunksRead).toBeLessThanOrEqual(22);
    expect(cancelled).toBe(true);
  });

  it("enforces the actual 50 MiB video candidate limit before reading an oversized declared body", async () => {
    let chunksRead = 0;
    const fetcher: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { chunksRead += 1; controller.enqueue(new Uint8Array(1024)); },
      cancel() {},
    }, { highWaterMark: 0 }), { headers: { "content-length": String(50 * 1024 * 1024 + 1) } });
    const storage = createSupabaseMediaProcessingStorage({ storageUrl: "http://127.0.0.1:57321", serviceRoleKey: "local-service-role", fetcher });
    const result = await storage.readCandidate({ ...ids, maxBytes: 50 * 1024 * 1024 });
    expect(result).toMatchObject({ ok: false, error: { code: "MEDIA_BYTES_OUT_OF_BOUNDS" } });
    expect(chunksRead).toBe(0);
  });

  it("aborts a candidate fetch when its remaining processing budget expires", async () => {
    let aborted = false;
    const fetcher: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
    });
    const storage = createSupabaseMediaProcessingStorage({ storageUrl: "http://127.0.0.1:57321", serviceRoleKey: "local-service-role", fetcher });
    const result = await storage.readCandidate({ ...ids, timeoutMs: 5 });
    expect(aborted).toBe(true);
    expect(result).toMatchObject({ ok: false, error: { code: "MEDIA_STORAGE_UNAVAILABLE" } });
  });

  it("checks the exact accepted PDF path before CV activation", async () => {
    const requests: Array<{ readonly url: URL; readonly method: string; readonly headers: Headers }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push({ url: new URL(input.toString()), method: init?.method ?? "GET", headers: new Headers(init?.headers) });
      return new Response(null, { status: 200 });
    };
    const storage = createSupabaseMediaProcessingStorage({ storageUrl: "http://127.0.0.1:57321", serviceRoleKey: "local-service-role", fetcher });
    const sha256 = "a".repeat(64);
    const result = await storage.preflightAcceptedPdfObject({
      portfolioId: ids.portfolioId,
      snapshot: {
        mediaAssetId: ids.mediaId,
        ownerId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec3" as never,
        assetVersion: 4,
        decisionId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec4" as never,
        objectId: ids.objectId,
        sha256,
        objectVersion: sha256,
      },
    });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(requests[0]?.method).toBe("HEAD");
    expect(requests[0]?.url.pathname).toBe(`/storage/v1/object/info/media-processed/processed/${ids.portfolioId}/${ids.mediaId}/${ids.objectId}/${sha256}.pdf`);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer local-service-role");
  });

  it("rejects a missing immutable PDF object and fails closed on Storage outages", async () => {
    const statuses = [404, 503];
    const results = [];
    for (const status of statuses) {
      const storage = createSupabaseMediaProcessingStorage({
        storageUrl: "http://127.0.0.1:57321", serviceRoleKey: "local-service-role",
        fetcher: async () => new Response(null, { status }),
      });
      results.push(await storage.preflightAcceptedPdfObject({
        portfolioId: ids.portfolioId,
        snapshot: {
          mediaAssetId: ids.mediaId, ownerId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec3" as never,
          assetVersion: 4, decisionId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec4" as never,
          objectId: ids.objectId, sha256: "a".repeat(64), objectVersion: "a".repeat(64),
        },
      }));
    }
    expect(results[0]).toMatchObject({ ok: false, error: { kind: "conflict", code: "CV_MEDIA_NOT_ELIGIBLE" } });
    expect(results[1]).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable", code: "MEDIA_STORAGE_UNAVAILABLE" } });
  });

  it("seals a create-only private WebM with its verified digest and removes the exact variant on cleanup", async () => {
    const requests: Array<{ readonly url: URL; readonly method: string; readonly headers: Headers; readonly body?: BodyInit | null }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const body = init?.body;
      requests.push({ url: new URL(input.toString()), method: init?.method ?? "GET", headers: new Headers(init?.headers), ...(body === undefined ? {} : { body }) });
      return new Response(null, { status: 200 });
    };
    const bytes = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const storage = createSupabaseMediaProcessingStorage({ storageUrl: "http://127.0.0.1:57321", serviceRoleKey: "local-service-role", fetcher });
    const sealed = await storage.sealProcessedObject({ ...ids, outputObjectId: ids.objectId, sourceObjectId: ids.objectId, bytes, sha256, mimeType: "video/webm" });
    expect(sealed).toMatchObject({ ok: true, value: { objectId: ids.objectId, sha256 } });
    expect(requests[0]?.url.pathname).toContain(`${sha256}.webm`);
    expect(requests[0]?.headers.get("content-type")).toBe("video/webm");
    expect(requests[0]?.headers.get("x-upsert")).toBe("false");
    await storage.discardSealedObject({ ...ids, sha256 });
    const deletedPrefixes = requests.filter((request) => request.method === "DELETE").map((request) => String(request.body ?? "")).join("\n");
    expect(deletedPrefixes).toContain(`${sha256}.webm`);
  });
});
import { createHash } from "node:crypto";
