import type { StableId, Result, Rejection } from "@shared/domain";
import { err } from "@shared/domain";
import type { TaxonomyRepositoryPort } from "../ports/index.js";
import type {
  Taxonomy,
  TaxonomyValue,
  TaxonomyAssignment,
  ProjectDiscoveryCard,
} from "../domain/index.js";

export { createPostgresProjectDiscoveryProjectionWriter } from "./postgres-project-discovery.js";
export { createPostgresTaxonomyOwnerRepository } from "./postgres-owner-taxonomies.js";

/**
 * Stub repository adapter for Phase 1 skeleton.
 * Business implementation and persistence are deferred to later phases.
 */
export class StubTaxonomyRepository implements TaxonomyRepositoryPort {
  async getTaxonomyById(
    _id: StableId<"Taxonomy">,
  ): Promise<Result<Taxonomy, Rejection>> {
    return err({ kind: "not_found", code: "TAXONOMY_NOT_FOUND" });
  }

  async getTaxonomyValueById(
    _id: StableId<"TaxonomyValue">,
  ): Promise<Result<TaxonomyValue, Rejection>> {
    return err({ kind: "not_found", code: "TAXONOMY_VALUE_NOT_FOUND" });
  }

  async saveTaxonomyValue(
    _value: TaxonomyValue,
  ): Promise<Result<TaxonomyValue, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "PERSISTENCE_NOT_IMPLEMENTED" });
  }

  async getAssignmentsForTarget(
    _targetId: StableId<string>,
  ): Promise<Result<readonly TaxonomyAssignment[], Rejection>> {
    return err({ kind: "not_found", code: "ASSIGNMENTS_NOT_FOUND" });
  }

  async saveAssignment(
    _assignment: TaxonomyAssignment,
  ): Promise<Result<TaxonomyAssignment, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "PERSISTENCE_NOT_IMPLEMENTED" });
  }

  async getDiscoveryProjects(): Promise<Result<readonly ProjectDiscoveryCard[], Rejection>> {
    return err({ kind: "not_found", code: "DISCOVERY_PROJECTS_NOT_FOUND" });
  }
}
