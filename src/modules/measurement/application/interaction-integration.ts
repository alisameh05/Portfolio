// Measurement integration for #195 — aggregate projection / fixed-clock replay
// Uses measurement domain aggregates to feed public summary counts.

import type { ProjectAggregate } from "../../interaction-moderation/domain/types";

export interface AggregateProjection {
  projectId: string;
  locale: string;
  computedAt: string; // fixed clock
  likes: number;
  dislikes: number;
  ratingCount: number;
  sumRatings: number;
  approvedFeedbackCount: number;
}

export function projectFromProjection(p: AggregateProjection): ProjectAggregate {
  // T08-01: sum/replacements reflected; count = current rows
  const avg = p.ratingCount >= 5 ? (p.sumRatings / p.ratingCount) : undefined;
  return {
    projectId: p.projectId as any,
    likesCount: p.likes,
    dislikesCount: p.dislikes,
    ratingCount: p.ratingCount,
    averageRating: avg,
    approvedFeedbackCount: p.approvedFeedbackCount,
  };
}

export function replayFixedClock(
  records: AggregateProjection[],
  clock: string
): ProjectAggregate {
  // Replay synchronous: use latest projection at fixed clock
  const latest = records
    .filter((r) => r.computedAt <= clock)
    .sort((a, b) => (a.computedAt > b.computedAt ? -1 : 1))[0];
  if (!latest) throw new Error("No projection at fixed clock");
  return projectFromProjection(latest);
}
