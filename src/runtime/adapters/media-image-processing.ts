import sharp from "sharp";
import { err, ok, type Rejection, type Result } from "@shared/domain";
import type { MediaImageProcessorPort, MediaImageVariant } from "../../modules/media/application/processing.js";
import { MEDIA_PROCESSING_POLICY } from "../../modules/media/domain/policy.js";

const IMAGE_POLICY_VERSION = "image-webp-variants-v1";
const PROCESS_TIMEOUT_MS = 15_000;
const VARIANTS = [
  { name: "display", width: 1280 },
  { name: "thumbnail", width: 320 },
] as const;
const MIME_BY_FORMAT = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;

function invalid(code: string): Result<never, Rejection> {
  return err({ kind: "validation", code });
}

function declaredMimeForFormat(format: string | undefined): string | undefined {
  return format === "jpg" ? "image/jpeg" : format && format in MIME_BY_FORMAT
    ? MIME_BY_FORMAT[format as keyof typeof MIME_BY_FORMAT]
    : undefined;
}

export function createSharpMediaImageProcessor(options: {
  readonly maxBytes?: number;
  readonly maxImagePixels?: number;
  readonly maxVariants?: number;
} = {}): MediaImageProcessorPort {
  const maxBytes = Math.min(options.maxBytes ?? MEDIA_PROCESSING_POLICY.maxBytesByKind.image, MEDIA_PROCESSING_POLICY.maxBytesByKind.image);
  const maxImagePixels = Math.min(options.maxImagePixels ?? MEDIA_PROCESSING_POLICY.maxImagePixels, MEDIA_PROCESSING_POLICY.maxImagePixels);
  const maxVariants = Math.min(options.maxVariants ?? MEDIA_PROCESSING_POLICY.maxVariants, MEDIA_PROCESSING_POLICY.maxVariants);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxImagePixels) || maxImagePixels < 1 ||
      !Number.isSafeInteger(maxVariants) || maxVariants < 1) throw new TypeError("Invalid Media image processing limits.");

  return {
    async process(bytes, declaredMimeType, processOptions) {
      if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) return invalid("MEDIA_BYTES_OUT_OF_BOUNDS");
      let stage: "inspect" | "encode" | "verify" = "inspect";
      const requestedTimeout = processOptions?.timeoutMs;
      if (Number.isSafeInteger(requestedTimeout) && (requestedTimeout ?? 0) < 1_000) {
        return err({ kind: "temporarily_unavailable", code: "MEDIA_PROCESSING_TIMEOUT" });
      }
      const timeoutMs = Number.isSafeInteger(requestedTimeout) && (requestedTimeout ?? 0) > 0
        ? Math.min(PROCESS_TIMEOUT_MS, requestedTimeout!) : PROCESS_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      const inputPipeline = () => {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw new Error("MEDIA_PROCESSING_TIMEOUT");
        return sharp(bytes, { failOn: "error", limitInputPixels: maxImagePixels, sequentialRead: true })
          .timeout({ seconds: Math.max(1, Math.floor(remainingMs / 1_000)) });
      };
      try {
        const metadata = await inputPipeline().metadata();
        if (Date.now() >= deadline) return err({ kind: "temporarily_unavailable", code: "MEDIA_PROCESSING_TIMEOUT" });
        const mimeType = declaredMimeForFormat(metadata.format);
        if (!mimeType || mimeType !== declaredMimeType || !Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height)) {
          return invalid("MEDIA_IMAGE_FORMAT_MISMATCH");
        }
        if ((metadata.width as number) < 1 || (metadata.height as number) < 1 ||
            (metadata.width as number) * (metadata.height as number) > maxImagePixels) {
          return invalid("MEDIA_IMAGE_PIXELS_OUT_OF_BOUNDS");
        }
        if ((metadata.pages ?? 1) !== 1) return invalid("MEDIA_IMAGE_MULTIPAGE_UNSUPPORTED");

        const variants: MediaImageVariant[] = [];
        stage = "encode";
        for (const definition of VARIANTS.slice(0, maxVariants)) {
          const { data, info } = await inputPipeline()
            .rotate()
            .resize({ width: definition.width, height: definition.width, fit: "inside", withoutEnlargement: true })
            .webp({ quality: 82, effort: 4, smartSubsample: true })
            .toBuffer({ resolveWithObject: true });
          if (info.format !== "webp" || info.width < 1 || info.height < 1 || data.byteLength < 1 || data.byteLength > maxBytes) {
            return invalid("MEDIA_IMAGE_OUTPUT_INVALID");
          }
          stage = "verify";
          const outputMetadata = await sharp(data, { failOn: "error", limitInputPixels: maxImagePixels }).metadata();
          if (outputMetadata.format !== "webp" || outputMetadata.width !== info.width || outputMetadata.height !== info.height ||
              outputMetadata.exif !== undefined || outputMetadata.icc !== undefined || outputMetadata.xmp !== undefined || outputMetadata.iptc !== undefined ||
              outputMetadata.pages !== undefined && outputMetadata.pages !== 1) {
            return invalid("MEDIA_IMAGE_OUTPUT_INVALID");
          }
          await sharp(data, { failOn: "error", limitInputPixels: maxImagePixels }).stats();
          variants.push({ name: definition.name, bytes: new Uint8Array(data), mimeType: "image/webp", width: info.width, height: info.height });
          if (Date.now() >= deadline) return err({ kind: "temporarily_unavailable", code: "MEDIA_PROCESSING_TIMEOUT" });
          stage = "encode";
        }
        if (variants.length < 1 || variants.length > MEDIA_PROCESSING_POLICY.maxVariants) return invalid("MEDIA_IMAGE_OUTPUT_INVALID");
        return ok({ variants, version: `sharp-${sharp.versions.sharp};libvips-${sharp.versions.vips ?? "unknown"}`.slice(0, 150), policyVersion: IMAGE_POLICY_VERSION });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "";
        if (/timeout/iu.test(message)) return err({ kind: "temporarily_unavailable", code: "MEDIA_PROCESSING_TIMEOUT" });
        if (stage === "inspect" && /pixel.{0,20}limit|limit.{0,20}pixel/iu.test(message)) return invalid("MEDIA_IMAGE_PIXELS_OUT_OF_BOUNDS");
        if (stage === "inspect") return invalid("MEDIA_IMAGE_DECODE_INVALID");
        if (stage === "verify") return invalid("MEDIA_IMAGE_OUTPUT_INVALID");
        return err({ kind: "temporarily_unavailable", code: "MEDIA_PROCESSOR_UNAVAILABLE" });
      }
    },
  };
}
