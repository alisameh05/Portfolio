/**
 * interaction-moderation module public interface.
 *
 * This barrel is the single public import surface for the Interaction and Moderation module.
 * Other modules must never deep-import internal paths.
 */

export type {
  ReactionKind,
  Reaction,
  RatingValue,
  Rating,
  ModerationState,
  Feedback,
  ProjectAggregate,
  ReactionChangedEvent,
  RatingChangedEvent,
  FeedbackSubmittedEvent,
  FeedbackApprovedEvent,
  FeedbackRejectedEvent,
  FeedbackSuppressedEvent,
} from "./domain/index.js";

export type {
  SubmitReactionCommand,
  SubmitRatingCommand,
  SubmitFeedbackCommand,
  ModerateFeedbackCommand,
  GetProjectAggregateQuery,
  GetApprovedFeedbackQuery,
  InteractionModerationService,
  FunctionalInteractionAuthorizationPort,
  FunctionalIdentityOrchestrationDeps,
} from "./application/index.js";

export {
  issueFunctionalIdentityForInteraction,
  verifyFunctionalIdentityForInteraction,
} from "./application/index.js";

export type {
  InteractionRepositoryPort,
  FeedbackRepositoryPort,
} from "./ports/index.js";

export type { GetOwnerFeedbackModerationQuery, ApproveOwnerFeedbackApplicationCommand, RejectOwnerFeedbackApplicationCommand, SuppressOwnerFeedbackApplicationCommand, OwnerModerationDecisionView, OwnerFeedbackModerationView, OwnerModerationCommandReceipt, OwnerModerationApplicationService } from "./application/owner-moderation.js";

export type { ReactionReceipt, RatingReceipt, FeedbackReceipt, PublicFeedbackView, PublicFeedbackPage } from "./domain/types.js";
export { createReactionApplicationService } from "./application/reactions.js";
export type { ReactionRepositoryPort } from "./application/reactions.js";
export { createFunctionalInteractionContext } from "./application/functional-context.js";
export type { FunctionalInteractionContextPort } from "./application/functional-context.js";

export type { FeedbackWorkCommand, FeedbackWorkService } from "./application/work.js";
export { createRatingApplicationService } from "./application/ratings.js";
export type { RatingRepositoryPort } from "./application/ratings.js";
export { createFeedbackApplicationService } from "./application/feedback.js";
export type { FeedbackSubmissionRepositoryPort } from "./application/feedback.js";
export { createOwnerFeedbackModerationService } from "./application/moderation.js";
export { createProjectInteractionSummaryService } from "./application/public-summary.js";
export type { InteractionSummaryRepositoryPort } from "./application/public-summary.js";
export type { ModerationRepositoryPort, ModerationApplicationDeps, RetainedModerationDecision } from "./application/moderation.js";
