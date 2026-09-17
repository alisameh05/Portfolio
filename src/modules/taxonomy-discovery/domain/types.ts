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
  readonly title: string;
  readonly slug: string;
  readonly publishedAt: string;
  readonly taxonomyValues: readonly TaxonomyValue[];
  readonly isFeatured: boolean;
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
