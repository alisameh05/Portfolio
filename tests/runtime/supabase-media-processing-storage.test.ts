import { describe, expect, it } from "vitest";
import { createSupabaseMediaProcessingStorage } from "../../src/runtime/adapters/supabase-media-processing-storage.js";
import { createHash } from "node:crypto";

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

  it("seals WebP variants create-only and removes only the exact extension-bound output", async () => {
    const bytes = new TextEncoder().encode("verified-webp-output");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const requests: { readonly url: string; readonly init?: RequestInit }[] = [];
    const storage = createSupabaseMediaProcessingStorage({ storageUrl: "http://127.0.0.1:57321", serviceRoleKey: "local-service-role",
      fetcher: async (input, init) => { requests.push({ url: input.toString(), ...(init === undefined ? {} : { init }) }); return new Response("{}", { status: 200 }); } });

    const sealed = await storage.sealProcessedObject({ ...ids, outputObjectId: "00000000-0000-7000-8000-000000000106" as never,
      sourceObjectId: ids.objectId, bytes, sha256, mimeType: "image/webp" });
    expect(sealed).toMatchObject({ ok: true, value: { sha256 } });
    expect(requests[0]?.url).toContain(`${sha256}.webp`);
    expect(requests[0]?.init?.headers).toMatchObject({ "content-type": "image/webp", "x-upsert": "false" });

    await storage.discardSealedObject({ ...ids, sha256, mimeType: "image/webp" });
    expect(requests[1]?.url).toMatch(/\/storage\/v1\/object\/media-processed$/u);
    expect(String(requests[1]?.init?.body)).toContain(`${sha256}.webp`);
  });
});
