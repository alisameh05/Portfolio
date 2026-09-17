import type {
  StableId,
  IdempotencyKey,
  Result,
  Rejection,
  ActorContext,
} from "@shared/domain";
import type {
  Reaction,
  Rating,
  Feedback,
  ProjectAggregate,
  ReactionKind,
  RatingValue,
  ModerationState,
} from "../domain/index.js";

export interface SubmitReactionCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly projectId: StableId<"Project">;
  readonly kind: ReactionKind;
}

export interface SubmitRatingCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly projectId: StableId<"Project">;
  readonly value: RatingValue;
}

export interface SubmitFeedbackCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly projectId: StableId<"Project">;
  readonly authorName: string;
  readonly comment: string;
}

export interface ModerateFeedbackCommand {
  readonly actor: ActorContext;
  readonly feedbackId: StableId<"Feedback">;
  readonly decision: "approve" | "reject" | "suppress";
  readonly reason?: string;
}

export interface GetProjectAggregateQuery {
  readonly projectId: StableId<"Project">;
}

export interface GetApprovedFeedbackQuery {
  readonly projectId: StableId<"Project">;
}

export interface InteractionModerationService {
  submitReaction(
    command: SubmitReactionCommand,
  ): Promise<Result<Reaction, Rejection>>;

  submitRating(
    command: SubmitRatingCommand,
  ): Promise<Result<Rating, Rejection>>;

  submitFeedback(
    command: SubmitFeedbackCommand,
  ): Promise<Result<Feedback, Rejection>>;

  moderateFeedback(
    command: ModerateFeedbackCommand,
  ): Promise<Result<Feedback, Rejection>>;

  getProjectAggregate(
    query: GetProjectAggregateQuery,
  ): Promise<Result<ProjectAggregate, Rejection>>;

  getApprovedFeedback(
    query: GetApprovedFeedbackQuery,
  ): Promise<Result<readonly Feedback[], Rejection>>;
}
