import type { StableId, DomainEvent } from "@shared/domain";

export type CurrentCvDisposition = "inline" | "attachment";

export interface CvVersion {
  readonly id: StableId<"CvVersion">;
  readonly mediaAssetId: StableId<"MediaAsset">;
  readonly versionNumber: number;
  readonly uploadedAt: string;
  readonly isCurrent: boolean;
  readonly locale: "en";
}

// Domain events
export type CurrentCvChangedEvent = DomainEvent<
  "cv.current_changed.v1",
  {
    readonly previousCurrentCvId?: StableId<"CvVersion">;
    readonly newCurrentCvId: StableId<"CvVersion">;
    readonly activatedAt: string;
  }
>;
