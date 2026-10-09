import type { StableId, Result, Rejection } from "@shared/domain";
import type {
  Taxonomy,
  TaxonomyValue,
  ProjectDiscoveryPage,
  PublicDiscoveryCriteria,
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

  getDiscoveryProjects(
    query: PublicDiscoveryCriteria,
  ): Promise<Result<ProjectDiscoveryPage, Rejection>>;
}
