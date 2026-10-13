import { describe, expect, it } from "vitest";
import { unsafeStableId } from "../../src/shared/domain/index.js";
import { createSupabaseMediaDeliveryStorage } from "../../src/runtime/adapters/supabase-media-delivery-storage.js";

const ids = {
  portfolioId: unsafeStableId<"Portfolio">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec0"),
  mediaAssetId: unsafeStableId<"MediaAsset">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec1"),
  objectId: unsafeStableId<"MediaObject">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec2"),
};
const sha256 = "a".repeat(64);
const now = Date.parse("2026-10-13T12:00:00.000Z");

describe("Supabase Media delivery Storage adapter", () => {
  it("signs exactly one hash-bound processed object for five minutes", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const adapter = createSupabaseMediaDeliveryStorage({
      storageUrl: "http://127.0.0.1:54321",
      serviceRoleKey: "local-service-key",
      portfolioId: ids.portfolioId,
      mode: "test",
      now: () => now,
      fetcher: async (input, init = {}) => {
        const url = new URL(input.toString());
        requests.push({ url, init });
        return new Response(JSON.stringify({ signedURL: `${url.pathname.replace("/storage/v1", "")}?token=opaque` }), { status: 200 });
      },
    });

    const result = await adapter.createSignedDeliveryTarget({
      mediaAssetId: ids.mediaAssetId,
      purpose: "project",
      locale: "ar",
      variant: { objectId: ids.objectId, name: "display", mimeType: "image/webp", byteLength: 512,
        sha256, objectVersion: sha256, width: 320, height: 240 },
    });

    expect(result).toEqual({ ok: true, value: {
      url: `http://127.0.0.1:54321/storage/v1/object/sign/media-processed/processed/${ids.portfolioId}/${ids.mediaAssetId}/${ids.objectId}/${sha256}.webp?token=opaque`,
      expiresAt: "2026-10-13T12:05:00.000Z",
    } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toContain("/object/sign/media-processed/processed/");
    expect(requests[0]?.url.pathname).not.toContain("media-candidates");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({ expiresIn: 300 });
  });

  it("rejects insecure deployed origins, credentials, mismatched signing paths, and substituted bytes", async () => {
    expect(() => createSupabaseMediaDeliveryStorage({ storageUrl: "http://127.0.0.1:54321", serviceRoleKey: "key", portfolioId: ids.portfolioId, mode: "deployed" })).toThrow();
    expect(() => createSupabaseMediaDeliveryStorage({ storageUrl: "https://user:pass@storage.example.test", serviceRoleKey: "key", portfolioId: ids.portfolioId, mode: "deployed" })).toThrow();

    const adapter = createSupabaseMediaDeliveryStorage({
      storageUrl: "https://storage.example.test",
      serviceRoleKey: "key",
      portfolioId: ids.portfolioId,
      mode: "deployed",
      now: () => now,
      fetcher: async (input) => {
        const requested = new URL(input.toString());
        return new Response(JSON.stringify({ signedURL: `https://attacker.example.test${requested.pathname}?token=opaque` }), { status: 200 });
      },
    });
    const result = await adapter.createSignedDeliveryTarget({
      mediaAssetId: ids.mediaAssetId,
      purpose: "profile",
      locale: "en",
      variant: { objectId: ids.objectId, name: "display", mimeType: "image/webp", byteLength: 512,
        sha256, objectVersion: "b".repeat(64) },
    });
    expect(result).toMatchObject({ ok: false, error: { kind: "conflict", code: "MEDIA_DELIVERY_OBJECT_INVALID" } });
  });
});
