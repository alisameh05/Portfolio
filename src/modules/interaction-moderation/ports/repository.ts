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
  ): Promise<Result<Reaction, Rejection>>;

  saveReaction(
    reaction: Reaction,
  ): Promise<Result<Reaction, Rejection>>;

  getRating(
    projectId: StableId<"Project">,
    visitorId: StableId<"FunctionalVisitor">,
  ): Promise<Result<Rating, Rejection>>;

  saveRating(
    rating: Rating,
  ): Promise<Result<Rating, Rejection>>;

  getProjectAggregate(
    projectId: StableId<"Project">,
  ): Promise<Result<ProjectAggregate, Rejection>>;
}

export interface FeedbackRepositoryPort {
  getFeedbackById(
    id: StableId<"Feedback">,
  ): Promise<Result<Feedback, Rejection>>;

  saveFeedback(
    feedback: Feedback,
  ): Promise<Result<Feedback, Rejection>>;

  getApprovedFeedbackForProject(
    projectId: StableId<"Project">,
  ): Promise<Result<readonly Feedback[], Rejection>>;
}
