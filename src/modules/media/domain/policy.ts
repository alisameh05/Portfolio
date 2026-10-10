import type { MediaFileKind } from "./types.js";

export const MEDIA_PROCESSING_POLICY = {
  allowedMimeTypes: {
    image: ["image/png", "image/jpeg", "image/webp"],
    video: ["video/mp4", "video/webm"],
    document: ["application/pdf"],
  },
  maxBytesByKind: {
    image: 10 * 1024 * 1024,
    video: 50 * 1024 * 1024,
    document: 20 * 1024 * 1024,
  },
  maxImagePixels: 40_000_000,
  maxVariants: 8,
  maxProcessingAttemptMs: 60_000,
} as const satisfies {
  readonly allowedMimeTypes: Readonly<Record<MediaFileKind, readonly string[]>>;
  readonly maxBytesByKind: Readonly<Record<MediaFileKind, number>>;
  readonly maxImagePixels: number;
  readonly maxVariants: number;
  readonly maxProcessingAttemptMs: number;
};

/** Adapter limits may tighten, but never widen, the domain policy. */
export function effectiveMediaProcessingLimits(adapter: {
  readonly maxBytesByKind: Readonly<Record<MediaFileKind, number>>;
  readonly maxImagePixels: number;
  readonly maxVariants: number;
  readonly maxProcessingAttemptMs: number;
}) {
  return {
    maxBytesByKind: {
      image: Math.min(MEDIA_PROCESSING_POLICY.maxBytesByKind.image, adapter.maxBytesByKind.image),
      video: Math.min(MEDIA_PROCESSING_POLICY.maxBytesByKind.video, adapter.maxBytesByKind.video),
      document: Math.min(MEDIA_PROCESSING_POLICY.maxBytesByKind.document, adapter.maxBytesByKind.document),
    },
    maxImagePixels: Math.min(MEDIA_PROCESSING_POLICY.maxImagePixels, adapter.maxImagePixels),
    maxVariants: Math.min(MEDIA_PROCESSING_POLICY.maxVariants, adapter.maxVariants),
    maxProcessingAttemptMs: Math.min(
      MEDIA_PROCESSING_POLICY.maxProcessingAttemptMs,
      adapter.maxProcessingAttemptMs,
    ),
  };
}
