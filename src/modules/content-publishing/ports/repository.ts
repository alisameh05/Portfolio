import type { StableId, Result, Rejection } from "@shared/domain";
import type { Project, Achievement, Testimonial } from "../domain/index.js";

export interface ContentRepositoryPort {
  getProjectById(
    id: StableId<"Project">,
  ): Promise<Result<Project, Rejection>>;

  saveProject(
    project: Project,
  ): Promise<Result<Project, Rejection>>;

  getAchievementById(
    id: StableId<"Achievement">,
  ): Promise<Result<Achievement, Rejection>>;

  saveAchievement(
    achievement: Achievement,
  ): Promise<Result<Achievement, Rejection>>;

  getTestimonialById(
    id: StableId<"Testimonial">,
  ): Promise<Result<Testimonial, Rejection>>;

  saveTestimonial(
    testimonial: Testimonial,
  ): Promise<Result<Testimonial, Rejection>>;
}
