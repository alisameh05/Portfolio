// Fixed-clock replay evidence for #195
// Uses pinned projection records; no production/developer data.

import { describe, it, expect } from "vitest";
import { replayFixedClock, projectFromProjection } from "../src/modules/measurement/application/interaction-integration";

describe("195 replay / measurement integration", () => {
  it("replays aggregate at fixed clock without inflation", () => {
    const clock = "2026-10-15T12:00:00Z";
    const projections = [
      { projectId: "p-1", locale: "en", computedAt: "2026-10-15T11:00:00Z", likes: 10, dislikes: 2, ratingCount: 4, sumRatings: 16, approvedFeedbackCount: 1 },
      { projectId: "p-1", locale: "en", computedAt: clock, likes: 12, dislikes: 3, ratingCount: 5, sumRatings: 21, approvedFeedbackCount: 2 },
    ];
    const agg = replayFixedClock(projections, clock);
    expect(agg.likesCount).toBe(12);
    expect(agg.ratingCount).toBe(5);
    expect(agg.averageRating).toBeCloseTo(4.2, 1);
  });

  it("older projection ignored when newer exists at clock", () => {
    const agg = replayFixedClock([
      { projectId: "p-1", locale: "en", computedAt: "2026-10-15T10:00:00Z", likes: 99, dislikes: 99, ratingCount: 99, sumRatings: 99, approvedFeedbackCount: 99 },
      { projectId: "p-1", locale: "en", computedAt: "2026-10-15T11:00:00Z", likes: 3, dislikes: 1, ratingCount: 2, sumRatings: 9, approvedFeedbackCount: 0 },
    ], "2026-10-15T11:00:00Z");
    expect(agg.likesCount).toBe(3);
  });
});
