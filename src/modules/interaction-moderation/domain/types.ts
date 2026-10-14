import type { StableId, DomainEvent } from "@shared/domain";

export type ReactionKind = "like" | "dislike";

export interface Reaction {
  readonly portfolioId: StableId<"Portfolio">;
  readonly projectId: StableId<"Project">;
  readonly visitorId: StableId<"FunctionalVisitor">;
  readonly kind: ReactionKind;
  readonly updatedAt: string;
}

export type RatingValue = 1 | 2 | 3 | 4 | 5;

export interface Rating {
  readonly portfolioId: StableId<"Portfolio">;
  readonly projectId: StableId<"Project">;
  readonly visitorId: StableId<"FunctionalVisitor">;
  readonly value: RatingValue;
  readonly updatedAt: string;
}

export type ModerationState = "pending" | "approved" | "rejected" | "suppressed";

export interface Feedback {
  readonly id: StableId<"Feedback">;
  readonly projectId: StableId<"Project">;
  readonly authorName: string;
  readonly comment: string;
  readonly moderationState: ModerationState;
  readonly submittedAt: string;
  readonly portfolioId: StableId<"Portfolio">;
  readonly locale: "en" | "ar";
  readonly aggregateVersion: number;
  readonly moderatedAt?: string;
}

export type ProjectAggregate = {
  readonly projectId: StableId<"Project">;
  readonly likesCount: number;
  readonly dislikesCount: number;
  readonly ratingCount: number;
  readonly approvedFeedbackCount: number;
  readonly asOf: string;
} & (
  | { readonly ratingState: "no-data" | "low-sample"; readonly averageRating?: never }
  | { readonly ratingState: "available"; readonly averageRating: number }
);

// Domain events
export type ReactionChangedEvent = DomainEvent<
  "interaction.reaction_changed.v1",
  {
    readonly projectId: StableId<"Project">;
    readonly kind: ReactionKind;
  }
>;

export type RatingChangedEvent = DomainEvent<
  "interaction.rating_changed.v1",
  {
    readonly projectId: StableId<"Project">;
    readonly value: RatingValue;
  }
>;

export type FeedbackSubmittedEvent = DomainEvent<
  "interaction.feedback_submitted.v1",
  {
    readonly feedbackId: StableId<"Feedback">;
    readonly projectId: StableId<"Project">;
  }
>;

export type FeedbackApprovedEvent = DomainEvent<
  "interaction.feedback_approved.v1",
  {
    readonly feedbackId: StableId<"Feedback">;
    readonly projectId: StableId<"Project">;
  }
>;

export type FeedbackRejectedEvent = DomainEvent<
  "interaction.feedback_rejected.v1",
  {
    readonly feedbackId: StableId<"Feedback">;
    readonly projectId: StableId<"Project">;
  }
>;

export type FeedbackSuppressedEvent = DomainEvent<
  "interaction.feedback_suppressed.v1",
  {
    readonly feedbackId: StableId<"Feedback">;
    readonly projectId: StableId<"Project">;
  }
>;

export interface ReactionReceipt { readonly projectId: StableId<"Project">; readonly kind: ReactionKind }
export interface RatingReceipt { readonly projectId: StableId<"Project">; readonly value: RatingValue }
export interface FeedbackReceipt { readonly id: StableId<"Feedback">; readonly projectId: StableId<"Project">; readonly status: "pending" }
/** Only approved display data; no state, history, private counts, or subjects. */
export interface PublicFeedbackView {
 readonly feedbackId: StableId<"Feedback">;
 readonly projectId: StableId<"Project">;
 readonly locale: "en" | "ar";
 readonly authorName: string;
 readonly paragraph: string;
 readonly displayedAt: string;
}
export interface PublicFeedbackPage { readonly items: readonly PublicFeedbackView[]; readonly nextCursor: { readonly displayedAt: string; readonly feedbackId: StableId<"Feedback"> } | null }
