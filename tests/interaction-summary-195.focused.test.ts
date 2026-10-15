// Focused acceptance for #195 slice — T08-01, T08-02, T08-03, T08-07
import { describe, it, expect } from "vitest";
import { buildSummary, applyHideArchive } from "../src/modules/interaction-moderation/application/public-summary";
import type { ProjectAggregate } from "../domain/types";

describe("195 public summary acceptance", () => {
  const baseAgg: ProjectAggregate = {
    projectId: "p-1",
    likesCount: 12,
    dislikesCount: 3,
    ratingCount: 5,
    averageRating: 4.2,
    approvedFeedbackCount: 2,
  };

  it("T08-01 reconciles counts without inflation", () => {
    const s = buildSummary(baseAgg, "en", "published");
    expect(s).not.toBeNull();
    expect(s!.likes).toBe(12);
    expect(s!.dislikes).toBe(3);
    expect(s!.ratingCount).toBe(5);
    expect(s!.averageRating).toBe(4.2);
  });

  it("T08-02 rejects non-published / bad locale", () => {
    expect(buildSummary(baseAgg, "en", "draft")).toBeNull();
    expect(buildSummary(baseAgg, "en", "hidden")).toBeNull();
    expect(buildSummary(baseAgg, "en", "archived")).toBeNull();
    expect(buildSummary(baseAgg, "", "published")).toBeNull();
  });

  it("T08-03 hide/archive removes public summary immediately", () => {
    const hidden = applyHideArchive(baseAgg, "hide");
    const s = buildSummary(hidden, "en", "published");
    expect(s).not.toBeNull();
    expect(s!.likes).toBe(0);
    expect(s!.approvedFeedbackCount).toBe(0);
  });

  it("T08-07 DTO exposes no private subjects/history/metadata", () => {
    const s = buildSummary(baseAgg, "en", "published")!;
    expect((s as any).authorName).toBeUndefined();
    expect((s as any).moderationState).toBeUndefined();
    expect((s as any).visitorId).toBeUndefined();
  });

  it("zero raters has no average; five enables it", () => {
    const zero = { ...baseAgg, ratingCount: 0, averageRating: undefined };
    const s = buildSummary(zero, "en", "published")!;
    expect(s.averageRating).toBeUndefined();

    const four = { ...baseAgg, ratingCount: 4, averageRating: undefined };
    const s4 = buildSummary(four, "en", "published")!;
    expect(s4.averageRating).toBeUndefined();
    expect(s4.lowSample).toBe(true);
  });
});
