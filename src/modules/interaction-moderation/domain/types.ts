import type { StableId, DomainEvent } from "@shared/domain";

export type ReactionKind = "like" | "dislike";

export interface Reaction {
  readonly projectId: StableId<"Project">;
  readonly visitorId: StableId<"FunctionalVisitor">;
  readonly kind: ReactionKind;
  readonly updatedAt: string;
}

export type RatingValue = 1 | 2 | 3 | 4 | 5;

export interface Rating {
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
  readonly moderatedAt?: string;
}

export interface ProjectAggregate {
  readonly projectId: StableId<"Project">;
  readonly likesCount: number;
  readonly dislikesCount: number;
  readonly averageRating?: number;
  readonly ratingCount: number;
  readonly approvedFeedbackCount: number;
}

// Domain events
export type ReactionChangedEvent = DomainEvent<
  "interaction.reaction_changed.v1",
  {
    readonly projectId: StableId<"Project">;
    readonly visitorId: StableId<"FunctionalVisitor">;
    readonly kind: ReactionKind;
  }
>;

export type RatingChangedEvent = DomainEvent<
  "interaction.rating_changed.v1",
  {
    readonly projectId: StableId<"Project">;
    readonly visitorId: StableId<"FunctionalVisitor">;
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
    readonly reason?: string;
  }
>;

export type FeedbackSuppressedEvent = DomainEvent<
  "interaction.feedback_suppressed.v1",
  {
    readonly feedbackId: StableId<"Feedback">;
    readonly reason?: string;
  }
>;
