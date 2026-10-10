import type { StableId, DomainEvent } from "@shared/domain";

export type MediaSafetyStatus = "pending_scan" | "clean" | "quarantined" | "rejected";

export type MediaAcceptanceStatus = "candidate" | "accepted" | "rejected";
export type MediaFileKind = "image" | "video" | "document";

export interface MediaAccessibilityMetadata {
  readonly nonVisualDescription?: string;
  readonly isDecorative: boolean;
  readonly caption?: string;
  readonly transcriptUrl?: string;
}

export interface MediaVariant {
  readonly variantName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly width?: number;
  readonly height?: number;
  /** @deprecated Phase 6 uses MediaObjectVariant; keep this shape for callers. */
  readonly storageReference: string;
}

export interface MediaObjectVariant {
  readonly variantName: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly width?: number;
  readonly height?: number;
  /** Stable opaque identity; provider paths and object metadata stay in adapters. */
  readonly objectId: StableId<"MediaObject">;
}

export interface MediaAsset {
  readonly id: StableId<"MediaAsset">;
  readonly safetyStatus: MediaSafetyStatus;
  readonly acceptanceStatus: MediaAcceptanceStatus;
  readonly accessibility: MediaAccessibilityMetadata;
  readonly variants: readonly MediaVariant[];
  readonly ownerId: StableId<"Owner">;
  readonly createdAt: string;
  readonly version: number;
}

export interface MediaDeliveryReference {
  readonly mediaAssetId: StableId<"MediaAsset">;
  readonly url: string;
  readonly mimeType: string;
  readonly accessibility: MediaAccessibilityMetadata;
}

// Domain events
export type MediaAssetAcceptedEvent = DomainEvent<
  "media.asset_accepted.v1",
  {
    readonly mediaAssetId: StableId<"MediaAsset">;
  }
>;

export type MediaAssetRejectedEvent = DomainEvent<
  "media.asset_rejected.v1",
  {
    readonly mediaAssetId: StableId<"MediaAsset">;
    readonly reason: string;
  }
>;
