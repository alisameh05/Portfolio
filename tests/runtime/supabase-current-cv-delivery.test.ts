import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSupabaseCurrentCvDelivery } from "../../src/runtime/adapters/supabase-current-cv-delivery.js";
import type { CurrentCvSnapshot } from "../../src/modules/cv-portfolio/index.js";

const pdf = new TextEncoder().encode("%PDF-current-cv-private-bytes");
const sha256 = createHash("sha256").update(pdf).digest("hex");
const snapshot: CurrentCvSnapshot = {
  portfolioId: "018f0f3e-7b91-7cc2-a3b4-c5d6e7f80910" as never,
  mediaAssetId: "018f0f3e-7b91-7cc2-a3b4-c5d6e7f80911" as never,
  objectId: "018f0f3e-7b91-7cc2-a3b4-c5d6e7f80912" as never,
  sha256, objectVersion: sha256,
};

describe("Supabase Current CV private delivery", () => {
  it("reads the exact private processed PDF, validates its hash, and uses bounded chunks", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(pdf, { status: 200,
      headers: { "content-type": "application/pdf", "content-length": String(pdf.byteLength) } }));
    const storage = createSupabaseCurrentCvDelivery({ storageUrl: "http://127.0.0.1:56321", serviceRoleKey: "private-key", mode: "test",
      fetcher });
    const result = await storage.stream({ snapshot, disposition: "inline" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.value) chunks.push(chunk);
    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))).toEqual(Buffer.from(pdf));
    const [requestUrl, request] = fetcher.mock.calls[0] as [URL, RequestInit];
    expect(requestUrl.pathname).toBe(`/storage/v1/object/media-processed/processed/${snapshot.portfolioId}/${snapshot.mediaAssetId}/${snapshot.objectId}/${sha256}.pdf`);
    expect(request?.headers).toMatchObject({ apikey: "private-key", authorization: "Bearer private-key" });
    expect(request?.redirect).toBe("manual");
  });

  it("returns a short lived exact-origin signed URL with disposition encoded by Storage", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ expiresIn: 300, download: "cv.pdf" });
      return Response.json({ signedURL: `/storage/v1/object/sign/media-processed/processed/${snapshot.portfolioId}/${snapshot.mediaAssetId}/${snapshot.objectId}/${sha256}.pdf?token=one&download=cv.pdf` });
    });
    const storage = createSupabaseCurrentCvDelivery({ storageUrl: "http://127.0.0.1:56321", serviceRoleKey: "private-key", mode: "test", fetcher });
    const result = await storage.createDownloadTarget({ snapshot, disposition: "attachment" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const url = new URL(result.value.url);
      expect(url.origin).toBe("http://127.0.0.1:56321");
      expect(url.searchParams.get("download")).toBe("cv.pdf");
      expect(Date.parse(result.value.expiresAt)).toBeGreaterThan(Date.now());
      expect(Date.parse(result.value.expiresAt)).toBeLessThanOrEqual(Date.now() + 300_000);
    }
  });

  it("fails closed on mismatched bytes and a signing URL from another origin", async () => {
    const wrongBytes = new TextEncoder().encode("%PDF-wrong");
    const wrongPdfStorage = createSupabaseCurrentCvDelivery({ storageUrl: "http://127.0.0.1:56321", serviceRoleKey: "private-key", mode: "test",
      fetcher: async () => new Response(wrongBytes, { headers: { "content-type": "application/pdf" } }) });
    expect(await wrongPdfStorage.stream({ snapshot, disposition: "inline" })).toMatchObject({ ok: false,
      error: { kind: "temporarily_unavailable" } });

    const foreignTargetStorage = createSupabaseCurrentCvDelivery({ storageUrl: "http://127.0.0.1:56321", serviceRoleKey: "private-key", mode: "test",
      fetcher: async () => Response.json({ signedURL: "https://evil.example/cv.pdf" }) });
    expect(await foreignTargetStorage.createDownloadTarget({ snapshot, disposition: "inline" })).toMatchObject({ ok: false,
      error: { kind: "temporarily_unavailable" } });
  });

  it("rejects malformed snapshot path bindings and signed URLs for a different object", async () => {
    const malformed = createSupabaseCurrentCvDelivery({ storageUrl: "http://127.0.0.1:56321", serviceRoleKey: "private-key", mode: "test",
      fetcher: vi.fn<typeof fetch>() });
    expect(await malformed.stream({ snapshot: { ...snapshot, portfolioId: "../../other" as never }, disposition: "inline" }))
      .toMatchObject({ ok: false, error: { kind: "temporarily_unavailable" } });

    const wrongPath = createSupabaseCurrentCvDelivery({ storageUrl: "http://127.0.0.1:56321", serviceRoleKey: "private-key", mode: "test",
      fetcher: async () => Response.json({ signedURL: `/storage/v1/object/sign/media-processed/processed/other/${snapshot.mediaAssetId}/${snapshot.objectId}/${sha256}.pdf?token=one` }) });
    expect(await wrongPath.createDownloadTarget({ snapshot, disposition: "inline" })).toMatchObject({ ok: false,
      error: { kind: "temporarily_unavailable" } });
  });

  it("rejects deployed loopback HTTP and refuses Storage redirects", async () => {
    expect(() => createSupabaseCurrentCvDelivery({ storageUrl: "http://127.0.0.1:56321", serviceRoleKey: "private-key", mode: "deployed" }))
      .toThrow(/HTTPS/u);
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 302, headers: { location: "https://evil.example/private.pdf" },
    }));
    const storage = createSupabaseCurrentCvDelivery({ storageUrl: "http://127.0.0.1:56321", serviceRoleKey: "private-key", mode: "test", fetcher });
    expect(await storage.stream({ snapshot, disposition: "inline" })).toMatchObject({ ok: false,
      error: { kind: "temporarily_unavailable" } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });
});
