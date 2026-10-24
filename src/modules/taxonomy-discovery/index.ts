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
  ProjectDiscoveryFacet,
  ProjectDiscoveryPage,
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
  PublicDiscoveryService,
  PublicDiscoveryReader,
  PublicDiscoveryReadQuery,
  PublicDiscoveryReadResult,
} from "./application/index.js";
export { createTaxonomyOwnerService, createPublicDiscoveryService } from "./application/index.js";
export {
  createTaxonomyOwnerExportSnapshotReader,
  type TaxonomyOwnerExportKind,
  type TaxonomyOwnerExportState,
  type TaxonomyOwnerExportScope,
  type TaxonomyOwnerExportTaxonomyFacts,
  type TaxonomyOwnerExportRepository,
  type TaxonomyOwnerExportRecord,
  type TaxonomyOwnerExportSnapshot,
  type TaxonomyOwnerExportSnapshotReader,
} from "./application/index.js";

export type { TaxonomyRepositoryPort } from "./ports/index.js";
export { createPostgresProjectDiscoveryProjectionWriter } from "./adapters/index.js";
export { createPostgresTaxonomyOwnerRepository } from "./adapters/index.js";
