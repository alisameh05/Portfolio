import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createSharpMediaImageProcessor } from "../../src/runtime/adapters/media-image-processing.js";

async function fixture(format: "png" | "jpeg" | "webp", width = 16, height = 8): Promise<Buffer> {
  const image = sharp({ create: { width, height, channels: 3, background: { r: 31, g: 96, b: 151 } } });
  if (format === "png") return image.png().toBuffer();
  if (format === "jpeg") return image.jpeg().toBuffer();
  return image.webp().toBuffer();
}

describe("bounded Media image processing", () => {
  it("fails closed when the shared attempt deadline leaves less than Sharp's one-second minimum", async () => {
    const result = await createSharpMediaImageProcessor().process(await fixture("png"), "image/png", { timeoutMs: 999 });
    expect(result).toMatchObject({ ok: false, error: { code: "MEDIA_PROCESSING_TIMEOUT" } });
  });

  it.each(["png", "jpeg", "webp"] as const)("decodes %s bytes and returns verified metadata-free WebP variants", async (format) => {
    const input = await fixture(format);
    const result = await createSharpMediaImageProcessor().process(input, `image/${format === "jpeg" ? "jpeg" : format}`);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.variants.map(({ name }) => name)).toEqual(["display", "thumbnail"]);
    expect(result.value.variants).toHaveLength(2);
    for (const variant of result.value.variants) {
      const metadata = await sharp(variant.bytes).metadata();
      expect(metadata.format).toBe("webp");
      expect(metadata.width).toBe(16);
      expect(metadata.height).toBe(8);
      expect(metadata.exif).toBeUndefined();
      expect(metadata.icc).toBeUndefined();
      expect(metadata.xmp).toBeUndefined();
      expect(metadata.iptc).toBeUndefined();
      expect(variant).toMatchObject({ mimeType: "image/webp", width: 16, height: 8 });
      expect(variant.bytes.byteLength).toBeGreaterThan(0);
    }
    expect(result.value.version).toContain("sharp-");
    expect(result.value.policyVersion).toContain("image-");
  });

  it("rejects unsupported and truncated bytes without returning a variant", async () => {
    const processor = createSharpMediaImageProcessor();
    await expect(processor.process(Buffer.from("<svg><script/></svg>"), "image/svg+xml"))
      .resolves.toMatchObject({ ok: false, error: { kind: "validation" } });
    await expect(processor.process(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png"))
      .resolves.toMatchObject({ ok: false, error: { kind: "validation" } });
  });

  it("rejects decoded dimensions above the effective pixel limit before encoding", async () => {
    const input = await fixture("png", 4, 4);
    const processor = createSharpMediaImageProcessor({ maxImagePixels: 15 });
    await expect(processor.process(input, "image/png"))
      .resolves.toMatchObject({ ok: false, error: { kind: "validation", code: "MEDIA_IMAGE_PIXELS_OUT_OF_BOUNDS" } });
  });

  it("rejects an actual image whose decoded dimensions exceed the 40 megapixel policy", async () => {
    const oversizedPixels = await sharp({ create: { width: 6_401, height: 6_251, channels: 3, background: "#000000" } })
      .png({ compressionLevel: 9 }).toBuffer();
    const result = await createSharpMediaImageProcessor().process(oversizedPixels, "image/png");
    expect(result).toMatchObject({ ok: false, error: { kind: "validation", code: "MEDIA_IMAGE_PIXELS_OUT_OF_BOUNDS" } });
  });

  it("rejects actual input over 10 MiB before attempting to decode it", async () => {
    const oversizedBytes = new Uint8Array(10 * 1024 * 1024 + 1);
    await expect(createSharpMediaImageProcessor().process(oversizedBytes, "image/png"))
      .resolves.toMatchObject({ ok: false, error: { kind: "validation", code: "MEDIA_BYTES_OUT_OF_BOUNDS" } });
  });

  it("re-encodes away source EXIF metadata", async () => {
    const input = await sharp({ create: { width: 9, height: 7, channels: 3, background: "red" } })
      .jpeg().withMetadata({ exif: { IFD0: { ImageDescription: "private upload metadata" } } }).toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const result = await createSharpMediaImageProcessor().process(input, "image/jpeg");

    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const variant of result.value.variants) {
        const metadata = await sharp(variant.bytes).metadata();
        expect(metadata.exif).toBeUndefined();
      }
    }
  });
});
