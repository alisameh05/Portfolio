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
  TaxonomyValueAssignedEvent,
  TaxonomyValueRenamedEvent,
  TaxonomyValueRetiredEvent,
  TaxonomyValueMergedEvent,
} from "./domain/index.js";

export type {
  AssignTaxonomyValueCommand,
  RenameTaxonomyValueCommand,
  RetireTaxonomyValueCommand,
  MergeTaxonomyValueCommand,
  ValidateAssignmentsQuery,
  GetPublicDiscoveryQuery,
  TaxonomyDiscoveryService,
} from "./application/index.js";

export type { TaxonomyRepositoryPort } from "./ports/index.js";
