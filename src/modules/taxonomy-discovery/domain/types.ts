import type { StableId, DomainEvent } from "@shared/domain";

export interface Taxonomy {
  readonly id: StableId<"Taxonomy">;
  readonly name: string;
  readonly purpose: string;
}

export interface TaxonomyValue {
  readonly id: StableId<"TaxonomyValue">;
  readonly taxonomyId: StableId<"Taxonomy">;
  readonly slug: string;
  readonly label: string;
  readonly isRetired: boolean;
  readonly mergedIntoId?: StableId<"TaxonomyValue">;
}

export interface TaxonomyAssignment {
  readonly targetId: StableId<string>;
  readonly taxonomyValueId: StableId<"TaxonomyValue">;
  readonly assignedAt: string;
}

export interface ProjectDiscoveryCard {
  readonly projectId: StableId<"Project">;
  readonly locale: "en" | "ar";
  readonly title: string;
  readonly slug: string;
  readonly firstPublishedAt: string;
  readonly taxonomyValues: readonly Pick<TaxonomyValue, "id" | "taxonomyId" | "slug" | "label">[];
  readonly isFeatured: boolean;
}

export interface PublicDiscoveryCriteria {
  readonly locale: "en" | "ar";
  readonly taxonomyValueIds?: readonly StableId<"TaxonomyValue">[];
  /** Clamp to 1..100 before querying; default to 25. */
  readonly limit: number;
  readonly cursor?: string;
}

export interface ProjectStatusValueView {
  readonly valueId: StableId<"ProjectStatusValue">;
  readonly label: string;
  readonly state: "active" | "retired";
}

export interface ProjectStatusValueReceipt extends ProjectStatusValueView {
  readonly aggregateVersion: number;
  readonly outcome:
    | "project-status-value-created"
    | "project-status-value-renamed"
    | "project-status-value-retired";
}

export interface ProjectStatusHistoryEntry {
  readonly previousValueId: StableId<"ProjectStatusValue"> | null;
  readonly currentValueId: StableId<"ProjectStatusValue">;
  readonly changedAt: string;
}

// Domain events
export type TaxonomyValueAssignedEvent = DomainEvent<
  "taxonomy.value_assigned.v1",
  {
    readonly targetId: StableId<string>;
    readonly taxonomyValueId: StableId<"TaxonomyValue">;
  }
>;

export type TaxonomyValueRenamedEvent = DomainEvent<
  "taxonomy.value_renamed.v1",
  {
    readonly taxonomyValueId: StableId<"TaxonomyValue">;
    readonly previousLabel: string;
    readonly newLabel: string;
  }
>;

export type TaxonomyValueRetiredEvent = DomainEvent<
  "taxonomy.value_retired.v1",
  {
    readonly taxonomyValueId: StableId<"TaxonomyValue">;
  }
>;

export type TaxonomyValueMergedEvent = DomainEvent<
  "taxonomy.value_merged.v1",
  {
    readonly sourceValueId: StableId<"TaxonomyValue">;
    readonly targetValueId: StableId<"TaxonomyValue">;
  }
>;
