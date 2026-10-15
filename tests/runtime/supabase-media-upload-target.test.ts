import { describe, expect, it } from "vitest";
import { createSupabaseMediaUploadTargetAdapter } from "../../src/runtime/adapters/supabase-media-upload-target.js";

const ids = {
  portfolioId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea1" as never,
  mediaId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec0" as never,
  uploadIntentId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec1" as never,
  mediaObjectId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec2" as never,
};

describe("Supabase private candidate upload adapter", () => {
  it("creates private separated buckets and one no-upsert target under generated IDs", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(input.toString());
      calls.push(init === undefined ? { url } : { url, init });
      if (url.pathname.endsWith("/storage/v1/bucket/media-candidates") || url.pathname.endsWith("/storage/v1/bucket/media-processed")) {
        return new Response(JSON.stringify({ public: false, file_size_limit: 52_428_800, allowed_mime_types: ["image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm", "application/pdf"] }), { status: 200 });
      }
      if (url.pathname.includes("/object/upload/sign/")) {
        return new Response(JSON.stringify({ url: `${url.pathname.replace("/storage/v1", "")}?token=opaque-storage-capability`, token: "opaque-storage-capability" }), { status: 200 });
      }
      throw new Error(`Unexpected Storage request: ${url.pathname}`);
    };
    const adapter = createSupabaseMediaUploadTargetAdapter({
      storageUrl: "http://127.0.0.1:57321",
      serviceRoleKey: "local-service-role",
      fetcher,
      now: () => Date.parse("2026-10-10T19:00:00.000Z"),
    });
    const result = await adapter.prepare({ ...ids, mimeType: "image/png", byteLength: 2048 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.expiresAt).toBe("2026-10-10T21:00:00.000Z");
    const target = new URL(result.value.uploadTarget);
    expect(target.pathname).toContain(`/candidate/${ids.portfolioId}/${ids.mediaId}/${ids.uploadIntentId}/${ids.mediaObjectId}`);
    expect(target.searchParams.get("token")).toBe("opaque-storage-capability");
    const signingCall = calls.find((call) => call.url.pathname.includes("/object/upload/sign/"));
    expect(signingCall?.init?.method).toBe("POST");
    expect(signingCall?.init?.headers).toMatchObject({ "x-upsert": "false" });
    expect(calls.slice(0, 2).map((call) => call.url.pathname)).toEqual([
      "/storage/v1/bucket/media-candidates",
      "/storage/v1/bucket/media-processed",
    ]);
    for (const call of calls) {
      expect(call.init?.headers).toMatchObject({ authorization: "Bearer local-service-role" });
    }
  });

  it("fails closed when either namespace is public or cannot be verified", async () => {
    const adapter = createSupabaseMediaUploadTargetAdapter({
      storageUrl: "https://storage.example.test",
      serviceRoleKey: "server-only-key",
      fetcher: async () => new Response(JSON.stringify({ public: true, file_size_limit: 52_428_800, allowed_mime_types: [] }), { status: 200 }),
    });
    const result = await adapter.prepare({ ...ids, mimeType: "image/png", byteLength: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MEDIA_STORAGE_BUCKET_UNAVAILABLE");
  });

  it("rejects a same-origin signed URL for a different object", async () => {
    const adapter = createSupabaseMediaUploadTargetAdapter({
      storageUrl: "http://127.0.0.1:57321",
      serviceRoleKey: "local-service-role",
      fetcher: async (input) => {
        const url = new URL(input.toString());
        if (url.pathname.endsWith("/storage/v1/bucket/media-candidates") || url.pathname.endsWith("/storage/v1/bucket/media-processed")) {
          return new Response(JSON.stringify({ public: false, file_size_limit: 52_428_800, allowed_mime_types: ["image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm", "application/pdf"] }), { status: 200 });
        }
        if (url.pathname.includes("/object/upload/sign/")) {
          return new Response(JSON.stringify({ url: "/storage/v1/object/upload/sign/media-candidates/candidate/other-owner/other-media/other-intent/other-object?token=opaque-storage-capability", token: "opaque-storage-capability" }), { status: 200 });
        }
        throw new Error(`Unexpected Storage request: ${url.pathname}`);
      },
    });
    const result = await adapter.prepare({ ...ids, mimeType: "image/png", byteLength: 2048 });
    expect(result).toEqual({ ok: false, error: { kind: "temporarily_unavailable", code: "MEDIA_STORAGE_TARGET_INVALID" } });
  });

  it("refuses a shared candidate and processed bucket", () => {
    expect(() => createSupabaseMediaUploadTargetAdapter({
      storageUrl: "https://storage.example.test",
      serviceRoleKey: "server-only-key",
      candidateBucket: "same-bucket",
      processedBucket: "same-bucket",
    })).toThrow();
  });
});
