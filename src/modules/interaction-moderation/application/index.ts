export type {
  SubmitReactionCommand,
  SubmitRatingCommand,
  SubmitFeedbackCommand,
  ModerateFeedbackCommand,
  GetProjectAggregateQuery,
  GetApprovedFeedbackQuery,
  InteractionModerationService,
} from "./service.js";

export {
  issueFunctionalIdentityForInteraction,
  verifyFunctionalIdentityForInteraction,
} from "./functional-identity.js";
export type {
  FunctionalInteractionAuthorizationPort,
  FunctionalIdentityOrchestrationDeps,
} from "./functional-identity.js";
