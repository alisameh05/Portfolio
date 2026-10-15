import type { TransactionContext } from "../../../runtime/ports.js";
import type { StableId, Result, Rejection } from "@shared/domain";
import type {
  Reaction,
  Rating,
  Feedback,
  ProjectAggregate,
} from "../domain/index.js";

export interface InteractionRepositoryPort {
  getReaction(
    projectId: StableId<"Project">,
    visitorId: StableId<"FunctionalVisitor">,
    portfolioId: StableId<"Portfolio">,
    transaction: TransactionContext,
  ): Promise<Result<Reaction, Rejection>>;

  saveReaction(
    reaction: Reaction,
    portfolioId: StableId<"Portfolio">,
    transaction: TransactionContext,
  ): Promise<Result<Reaction, Rejection>>;

  getRating(
    projectId: StableId<"Project">,
    visitorId: StableId<"FunctionalVisitor">,
    portfolioId: StableId<"Portfolio">,
    transaction: TransactionContext,
  ): Promise<Result<Rating, Rejection>>;

  saveRating(
    rating: Rating,
    portfolioId: StableId<"Portfolio">,
    transaction: TransactionContext,
  ): Promise<Result<Rating, Rejection>>;

  getProjectAggregate(
    projectId: StableId<"Project">,
    portfolioId: StableId<"Portfolio">,
    transaction: TransactionContext,
  ): Promise<Result<ProjectAggregate, Rejection>>;
}

export interface FeedbackRepositoryPort {
  getFeedbackById(
    id: StableId<"Feedback">,
    portfolioId: StableId<"Portfolio">,
    transaction: TransactionContext,
  ): Promise<Result<Feedback, Rejection>>;

  saveFeedback(
    feedback: Feedback,
    portfolioId: StableId<"Portfolio">,
    transaction: TransactionContext,
  ): Promise<Result<Feedback, Rejection>>;

  getApprovedFeedbackForProject(
    projectId: StableId<"Project">,
    portfolioId: StableId<"Portfolio">,
    transaction: TransactionContext,
  ): Promise<Result<readonly Feedback[], Rejection>>;
}
