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

  it("rejects oversized declared bodies before reading their stream", async () => {
    let chunksRead = 0;
    const fetcher: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { chunksRead += 1; controller.enqueue(new Uint8Array(1024)); },
      cancel() {},
    }, { highWaterMark: 0 }), { headers: { "content-length": String(20 * 1024 * 1024 + 1) } });
    const storage = createSupabaseMediaProcessingStorage({ storageUrl: "http://127.0.0.1:57321", serviceRoleKey: "local-service-role", fetcher });
    const result = await storage.readCandidate(ids);
    expect(result).toMatchObject({ ok: false, error: { code: "MEDIA_BYTES_OUT_OF_BOUNDS" } });
    expect(chunksRead).toBe(0);
  });
});
