import type { OwnerModerationApplicationService } from "./owner-moderation.js";
import type { FeedbackWorkService } from "./work.js";
import type { ApplicationRequestContext } from "@shared/application";
import type {
  StableId,
  IdempotencyKey,
  Result,
  Rejection,
  ActorContext,
} from "@shared/domain";
import type {
  ProjectAggregate,
  ReactionKind,
  RatingValue,
  ReactionReceipt, RatingReceipt, FeedbackReceipt, PublicFeedbackPage,
} from "../domain/index.js";

export interface SubmitReactionCommand extends ApplicationRequestContext {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly projectId: StableId<"Project">;
  readonly kind: ReactionKind;
}

export interface SubmitRatingCommand extends ApplicationRequestContext {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly projectId: StableId<"Project">;
  readonly value: RatingValue;
}

export interface SubmitFeedbackCommand extends ApplicationRequestContext {
  readonly actor: { readonly kind: "visitor"; readonly consent: "granted" | "denied" | "unknown"; readonly functionalId?: never };
  readonly idempotencyKey: IdempotencyKey;
  readonly projectId: StableId<"Project">;
  readonly authorName: string;
  readonly comment: string;
  readonly locale: "en" | "ar";
}

export type ModerateFeedbackCommand = (import("./owner-moderation.js").ApproveOwnerFeedbackApplicationCommand & { readonly decision: "approve" }) | (import("./owner-moderation.js").RejectOwnerFeedbackApplicationCommand & { readonly decision: "reject" }) | (import("./owner-moderation.js").SuppressOwnerFeedbackApplicationCommand & { readonly decision: "suppress" });

export interface GetProjectAggregateQuery extends ApplicationRequestContext {
  readonly portfolioId: StableId<"Portfolio">;
  readonly locale: "en" | "ar";
  readonly projectId: StableId<"Project">;
}

export interface GetApprovedFeedbackQuery extends GetProjectAggregateQuery {
  readonly limit?: number;
  readonly cursor?: { readonly displayedAt: string; readonly feedbackId: StableId<"Feedback"> };
  readonly projectId: StableId<"Project">;
}

export interface InteractionModerationService extends OwnerModerationApplicationService, FeedbackWorkService {
  submitReaction(
    command: SubmitReactionCommand,
  ): Promise<Result<ReactionReceipt, Rejection>>;

  submitRating(
    command: SubmitRatingCommand,
  ): Promise<Result<RatingReceipt, Rejection>>;

  submitFeedback(
    command: SubmitFeedbackCommand,
  ): Promise<Result<FeedbackReceipt, Rejection>>;

  moderateFeedback(
    command: ModerateFeedbackCommand,
  ): Promise<Result<import("./owner-moderation.js").OwnerModerationCommandReceipt, Rejection>>;

  getProjectAggregate(
    query: GetProjectAggregateQuery,
  ): Promise<Result<ProjectAggregate, Rejection>>;

  getApprovedFeedback(
    query: GetApprovedFeedbackQuery,
  ): Promise<Result<PublicFeedbackPage, Rejection>>;
}
