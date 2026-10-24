import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSupabaseMediaExportStorage } from "../../src/runtime/adapters/supabase-media-export-storage.js";

const source = new TextEncoder().encode("accepted-private-media-bytes");
const sha256 = createHash("sha256").update(source).digest("hex");
const input = {
  portfolioId: "018f0f3e-7b91-7cc2-a3b4-c5d6e7f80910" as never,
  mediaId: "018f0f3e-7b91-7cc2-a3b4-c5d6e7f80911",
  objectId: "018f0f3e-7b91-7cc2-a3b4-c5d6e7f80912",
  source: "variant" as const,
  mediaType: "application/pdf" as const,
  expectedLength: source.byteLength,
  expectedSha256: sha256,
};

async function collect(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of content) { chunks.push(chunk); length += chunk.byteLength; }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

describe("Supabase private Media export storage", () => {
  it("streams only the pinned processed object and verifies its exact length and SHA-256", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Response(source, {
      status: 200,
      headers: { "content-length": String(source.byteLength), "content-type": "application/pdf" },
    }));
    const storage = createSupabaseMediaExportStorage({
      storageUrl: "https://storage.example.test",
      serviceRoleKey: "private-storage-key",
      fetcher,
    });
    const bytes = await collect(await storage.readMediaExportObject(input));
    const [url, init] = fetcher.mock.calls[0] as [URL, RequestInit];

    expect(bytes).toEqual(source);
    expect(url.pathname).toBe(`/storage/v1/object/media-processed/processed/${input.portfolioId}/${input.mediaId}/${input.objectId}/${sha256}.pdf`);
    expect(init?.headers).toMatchObject({ apikey: "private-storage-key", authorization: "Bearer private-storage-key" });
    expect(init?.redirect).toBe("manual");
    expect(init?.method).toBeUndefined();
    expect(url.pathname).not.toContain("sign/");
  });

  it("streams the exact upload-intent-scoped original from the private candidate bucket", async () => {
    const uploadIntentId = "018f0f3e-7b91-7cc2-a3b4-c5d6e7f80913";
    const fetcher = vi.fn<typeof fetch>(async () => new Response(source, {
      status: 200, headers: { "content-length": String(source.byteLength) },
    }));
    const storage = createSupabaseMediaExportStorage({
      storageUrl: "https://storage.example.test", serviceRoleKey: "private-storage-key", fetcher,
    });
    expect(await collect(await storage.readMediaExportObject({ ...input, source: "original", uploadIntentId, mediaType: "image/png" }))).toEqual(source);
    const [url, init] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe(`/storage/v1/object/media-candidates/candidate/${input.portfolioId}/${input.mediaId}/${uploadIntentId}/${input.objectId}`);
    expect(init?.redirect).toBe("manual");
    expect(url.pathname).not.toContain("sign/");
  });

  it("cancels the private Storage response when a consumer stops before verification", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(source.subarray(0, 1)); },
      cancel: cancelled,
    });
    const storage = createSupabaseMediaExportStorage({
      storageUrl: "https://storage.example.test", serviceRoleKey: "private-storage-key",
      fetcher: async () => new Response(body, { status: 200 }),
    });
    const content = await storage.readMediaExportObject(input);
    const iterator = content[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toEqual(source.subarray(0, 1));
    await iterator.return?.();

    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("rejects missing, redirected, changed, and wrong-length objects", async () => {
    const missing = createSupabaseMediaExportStorage({ storageUrl: "https://storage.example.test", serviceRoleKey: "key",
      fetcher: async () => new Response(null, { status: 404 }) });
    await expect(missing.readMediaExportObject(input)).rejects.toThrow("MEDIA_EXPORT_OBJECT_UNAVAILABLE");

    const redirectFetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: "https://other.test/object" } }));
    const redirected = createSupabaseMediaExportStorage({ storageUrl: "https://storage.example.test", serviceRoleKey: "key", fetcher: redirectFetcher });
    await expect(redirected.readMediaExportObject(input)).rejects.toThrow("MEDIA_EXPORT_OBJECT_UNAVAILABLE");
    expect(redirectFetcher).toHaveBeenCalledOnce();
    expect(redirectFetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");

    const changed = new TextEncoder().encode("tampered-private-media-bytes");
    expect(changed.byteLength).toBe(source.byteLength);
    const changedStorage = createSupabaseMediaExportStorage({ storageUrl: "https://storage.example.test", serviceRoleKey: "key",
      fetcher: async () => new Response(changed, { status: 200, headers: { "content-length": String(source.byteLength) } }) });
    await expect(collect(await changedStorage.readMediaExportObject(input))).rejects.toThrow("MEDIA_EXPORT_OBJECT_INTEGRITY_MISMATCH");

    const shortStorage = createSupabaseMediaExportStorage({ storageUrl: "https://storage.example.test", serviceRoleKey: "key",
      fetcher: async () => new Response(source.subarray(1), { status: 200 }) });
    await expect(collect(await shortStorage.readMediaExportObject(input))).rejects.toThrow("MEDIA_EXPORT_OBJECT_LENGTH_MISMATCH");
  });

  it("requires HTTPS except on loopback and rejects malformed object identities before fetching", async () => {
    expect(() => createSupabaseMediaExportStorage({ storageUrl: "http://storage.example.test", serviceRoleKey: "key" })).toThrow(/HTTPS/u);
    const fetcher = vi.fn<typeof fetch>();
    const storage = createSupabaseMediaExportStorage({ storageUrl: "http://127.0.0.1:54321", serviceRoleKey: "key", fetcher });
    await expect(storage.readMediaExportObject({ ...input, objectId: "../../other" })).rejects.toThrow("MEDIA_EXPORT_OBJECT_INVALID");
    await expect(storage.readMediaExportObject({ ...input, source: "original", uploadIntentId: "bad" })).rejects.toThrow("MEDIA_EXPORT_OBJECT_INVALID");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
