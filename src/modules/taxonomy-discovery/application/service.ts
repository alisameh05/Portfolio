import type { StableId, Result, Rejection, ActorContext } from "@shared/domain";
import type {
  TaxonomyValue,
  ProjectDiscoveryCard,
} from "../domain/index.js";

export interface AssignTaxonomyValueCommand {
  readonly actor: ActorContext;
  readonly targetId: StableId<string>;
  readonly taxonomyValueId: StableId<"TaxonomyValue">;
}

export interface RenameTaxonomyValueCommand {
  readonly actor: ActorContext;
  readonly taxonomyValueId: StableId<"TaxonomyValue">;
  readonly newLabel: string;
}

export interface RetireTaxonomyValueCommand {
  readonly actor: ActorContext;
  readonly taxonomyValueId: StableId<"TaxonomyValue">;
}

export interface MergeTaxonomyValueCommand {
  readonly actor: ActorContext;
  readonly sourceValueId: StableId<"TaxonomyValue">;
  readonly targetValueId: StableId<"TaxonomyValue">;
}

export interface ValidateAssignmentsQuery {
  readonly taxonomyValueIds: readonly StableId<"TaxonomyValue">[];
}

export interface GetPublicDiscoveryQuery {
  readonly taxonomyValueId?: StableId<"TaxonomyValue">;
}

export interface TaxonomyDiscoveryService {
  assignTaxonomyValue(
    command: AssignTaxonomyValueCommand,
  ): Promise<Result<void, Rejection>>;

  renameTaxonomyValue(
    command: RenameTaxonomyValueCommand,
  ): Promise<Result<TaxonomyValue, Rejection>>;

  retireTaxonomyValue(
    command: RetireTaxonomyValueCommand,
  ): Promise<Result<TaxonomyValue, Rejection>>;

  mergeTaxonomyValue(
    command: MergeTaxonomyValueCommand,
  ): Promise<Result<void, Rejection>>;

  validateAssignments(
    query: ValidateAssignmentsQuery,
  ): Promise<Result<boolean, Rejection>>;

  getPublicDiscovery(
    query: GetPublicDiscoveryQuery,
  ): Promise<Result<readonly ProjectDiscoveryCard[], Rejection>>;
}
