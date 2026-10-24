import type { StableId, Result, Rejection } from "@shared/domain";
import { err } from "@shared/domain";
import type { ContentRepositoryPort } from "../ports/index.js";
import type { Project, Achievement, Testimonial } from "../domain/index.js";

/**
 * Stub repository adapter for Phase 1 skeleton.
 * Business implementation and persistence are deferred to later phases.
 */
export class StubContentRepository implements ContentRepositoryPort {
  async getProjectById(
    _id: StableId<"Project">,
  ): Promise<Result<Project, Rejection>> {
    return err({ kind: "not_found", code: "PROJECT_NOT_FOUND" });
  }

  async saveProject(
    _project: Project,
  ): Promise<Result<Project, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "PERSISTENCE_NOT_IMPLEMENTED" });
  }

  async getAchievementById(
    _id: StableId<"Achievement">,
  ): Promise<Result<Achievement, Rejection>> {
    return err({ kind: "not_found", code: "ACHIEVEMENT_NOT_FOUND" });
  }

  async saveAchievement(
    _achievement: Achievement,
  ): Promise<Result<Achievement, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "PERSISTENCE_NOT_IMPLEMENTED" });
  }

  async getTestimonialById(
    _id: StableId<"Testimonial">,
  ): Promise<Result<Testimonial, Rejection>> {
    return err({ kind: "not_found", code: "TESTIMONIAL_NOT_FOUND" });
  }

  async saveTestimonial(
    _testimonial: Testimonial,
  ): Promise<Result<Testimonial, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "PERSISTENCE_NOT_IMPLEMENTED" });
  }
}

export { createPostgresContentAuthoringRepository } from "./postgres-authoring.js";
export { createPostgresContentTaxonomyAssignmentsPort } from "./postgres-taxonomy-assignments.js";
export { createPostgresContentTaxonomyExportAssignmentReader } from "./postgres-taxonomy-export-reader.js";
