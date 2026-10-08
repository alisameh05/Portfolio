/**
 * taxonomy-discovery module public interface.
 *
 * This barrel is the single public import surface for the Taxonomy and Discovery module.
 * Other modules must never deep-import internal paths.
 */

export type {
  Taxonomy,
  TaxonomyValue,
  TaxonomyAssignment,
  ProjectDiscoveryCard,
  PublicDiscoveryCriteria,
  ProjectStatusValueView,
  ProjectStatusValueReceipt,
  ProjectStatusHistoryEntry,
  TaxonomyValueAssignedEvent,
  TaxonomyValueRenamedEvent,
  TaxonomyValueRetiredEvent,
  TaxonomyValueMergedEvent,
} from "./domain/index.js";

export type {
  TaxonomyKind,
  TaxonomyValueView as OwnerTaxonomyValueView,
  OwnerTaxonomyView,
  TaxonomyOwnerScope,
  TaxonomyOwnerRepository,
  CreateOwnerTaxonomyValueCommand,
  RenameOwnerTaxonomyValueCommand,
  RetireOwnerTaxonomyValueCommand,
  TaxonomyEvolutionResult,
  TaxonomyOwnerService,
  RenameTaxonomyValueCommand,
  RetireTaxonomyValueCommand,
  MergeTaxonomyValueCommand,
  ValidateAssignmentsQuery,
  GetPublicDiscoveryQuery,
  ProjectStatusHistoryQuery,
  ProjectStatusHistoryPage,
  ValidateProjectAssignmentQuery,
  ProjectAssignmentEligibilityPort,
  TaxonomyMergeCoordinator,
  CreateProjectStatusValueCommand,
  RenameProjectStatusValueCommand,
  RetireProjectStatusValueCommand,
  TaxonomyDiscoveryService,
} from "./application/index.js";
export { createTaxonomyOwnerService } from "./application/index.js";

export type { TaxonomyRepositoryPort } from "./ports/index.js";
export { createPostgresProjectDiscoveryProjectionWriter } from "./adapters/index.js";
export { createPostgresTaxonomyOwnerRepository } from "./adapters/index.js";
