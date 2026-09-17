import type { StableId, Result, Rejection } from "@shared/domain";
import type {
  Taxonomy,
  TaxonomyValue,
  TaxonomyAssignment,
  ProjectDiscoveryCard,
} from "../domain/index.js";

export interface TaxonomyRepositoryPort {
  getTaxonomyById(
    id: StableId<"Taxonomy">,
  ): Promise<Result<Taxonomy, Rejection>>;

  getTaxonomyValueById(
    id: StableId<"TaxonomyValue">,
  ): Promise<Result<TaxonomyValue, Rejection>>;

  saveTaxonomyValue(
    value: TaxonomyValue,
  ): Promise<Result<TaxonomyValue, Rejection>>;

  getAssignmentsForTarget(
    targetId: StableId<string>,
  ): Promise<Result<readonly TaxonomyAssignment[], Rejection>>;

  saveAssignment(
    assignment: TaxonomyAssignment,
  ): Promise<Result<TaxonomyAssignment, Rejection>>;

  getDiscoveryProjects(): Promise<Result<readonly ProjectDiscoveryCard[], Rejection>>;
}
