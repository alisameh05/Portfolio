import type { StableId, Result, Rejection } from "@shared/domain";
import { err } from "@shared/domain";
import type {
  InteractionRepositoryPort,
  FeedbackRepositoryPort,
} from "../ports/index.js";
import type {
  Reaction,
  Rating,
  Feedback,
  ProjectAggregate,
} from "../domain/index.js";

/**
 * Stub repository adapter for Phase 1 skeleton.
 * Business implementation and persistence are deferred to later phases.
 */
export class StubInteractionRepository implements InteractionRepositoryPort {
  async getReaction(
    _projectId: StableId<"Project">,
    _visitorId: StableId<"FunctionalVisitor">,
  ): Promise<Result<Reaction, Rejection>> {
    return err({ kind: "not_found", code: "REACTION_NOT_FOUND" });
  }

  async saveReaction(
    _reaction: Reaction,
  ): Promise<Result<Reaction, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "PERSISTENCE_NOT_IMPLEMENTED" });
  }

  async getRating(
    _projectId: StableId<"Project">,
    _visitorId: StableId<"FunctionalVisitor">,
  ): Promise<Result<Rating, Rejection>> {
    return err({ kind: "not_found", code: "RATING_NOT_FOUND" });
  }

  async saveRating(
    _rating: Rating,
  ): Promise<Result<Rating, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "PERSISTENCE_NOT_IMPLEMENTED" });
  }

  async getProjectAggregate(
    _projectId: StableId<"Project">,
  ): Promise<Result<ProjectAggregate, Rejection>> {
    return err({ kind: "not_found", code: "AGGREGATE_NOT_FOUND" });
  }
}

export class StubFeedbackRepository implements FeedbackRepositoryPort {
  async getFeedbackById(
    _id: StableId<"Feedback">,
  ): Promise<Result<Feedback, Rejection>> {
    return err({ kind: "not_found", code: "FEEDBACK_NOT_FOUND" });
  }

  async saveFeedback(
    _feedback: Feedback,
  ): Promise<Result<Feedback, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "PERSISTENCE_NOT_IMPLEMENTED" });
  }

  async getApprovedFeedbackForProject(
    _projectId: StableId<"Project">,
  ): Promise<Result<readonly Feedback[], Rejection>> {
    return err({ kind: "not_found", code: "APPROVED_FEEDBACK_NOT_FOUND" });
  }
}
