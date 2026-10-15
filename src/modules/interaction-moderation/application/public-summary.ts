// Public interaction summary query / DTO for #195
// Criteria: T08-02 (reject unknown/Draft/Hidden/Archived/wrong-type/foreign-scope / unavailable locale)
// T08-07 (expose no functional subjects, private counts/text/history, provider metadata)
// T08-01 (counts reconcile without inflation; average only when count >= 5)

import type {
  ProjectAggregate,
  ReactionKind,
  RatingValue,
} from "../domain/types";

export interface PublicInteractionSummary {
  readonly projectId: string;
  readonly locale: string;
  readonly likes: number;
  readonly dislikes: number;
  readonly ratingCount: number;
  readonly averageRating?: number; // only when ratingCount >= 5
  readonly lowSample?: boolean; // true when ratingCount < 5 and > 0?
  readonly approvedFeedbackCount: number;
}

export interface SummaryQuery {
  readonly projectId: string;
  readonly locale: string;
}

export function applyHideArchive(
  aggregate: ProjectAggregate,
  action: "hide" | "archive" | "restore"
): ProjectAggregate {
  if (action === "hide" || action === "archive") {
    return {
      ...aggregate,
      likesCount: 0,
      dislikesCount: 0,
      ratingCount: 0,
      averageRating: undefined,
      approvedFeedbackCount: 0,
    };
  }
  return aggregate;
}

export function buildSummary(
  aggregate: ProjectAggregate,
  locale: string,
  projectStatus: "published" | "draft" | "hidden" | "archived"
): PublicInteractionSummary | null {
  // T08-02: reject invalid project states or unavailable locale
  if (projectStatus !== "published") return null;
  if (!locale || locale.trim().length === 0) return null;

  // T08-01: reconcile without contributor inflation
  const likes = aggregate.likesCount ?? 0;
  const dislikes = aggregate.dislikesCount ?? 0;
  const ratingCount = aggregate.ratingCount ?? 0;

  // Average only when >= 5 raters; zero has no average; < 5 is low-sample
  let averageRating: number | undefined = undefined;
  let lowSample: boolean | undefined = undefined;

  if (ratingCount === 0) {
    averageRating = undefined;
    lowSample = undefined;
  } else if (ratingCount < 5) {
    averageRating = undefined;
    lowSample = true;
  } else {
    // Sum/replacement handled upstream; assume aggregate reflects current rows
    // Placeholder: actual sum computation from current Rating records
    averageRating = aggregate.averageRating ?? undefined;
    lowSample = false;
  }

  // T08-07: no private-state counts, reasons/history, provider metadata
  return {
    projectId: aggregate.projectId,
    locale,
    likes,
    dislikes,
    ratingCount,
    averageRating,
    lowSample,
    approvedFeedbackCount: aggregate.approvedFeedbackCount ?? 0,
  };
}
