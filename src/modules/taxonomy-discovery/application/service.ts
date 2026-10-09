import type { StableId, Result, Rejection, ActorContext } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import type { ContentTaxonomyAssignmentsPort } from "../../content-publishing/index.js";
import type {
  TaxonomyValue,
  ProjectDiscoveryPage,
  ProjectStatusValueView,
  ProjectStatusValueReceipt,
  ProjectStatusHistoryEntry,
  PublicDiscoveryCriteria,
} from "../domain/index.js";

export interface RenameTaxonomyValueCommand {
  readonly actor: ActorContext;
  readonly taxonomyValueId: StableId<"TaxonomyValue">;
  readonly newLabel: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface RetireTaxonomyValueCommand {
  readonly actor: ActorContext;
  readonly taxonomyValueId: StableId<"TaxonomyValue">;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface MergeTaxonomyValueCommand {
  readonly actor: ActorContext;
  readonly sourceValueId: StableId<"TaxonomyValue">;
  readonly targetValueId: StableId<"TaxonomyValue">;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly transaction: TransactionContext;
}

export interface ValidateAssignmentsQuery {
  readonly taxonomyValueIds: readonly StableId<"TaxonomyValue">[];
}

export interface GetPublicDiscoveryQuery extends PublicDiscoveryCriteria {}

export interface ProjectStatusHistoryQuery {
  readonly projectId: StableId<"Project">;
  /** Clamp to 1..100 before querying; default to 25. */
  readonly limit: number;
  readonly cursor?: string;
}

export interface ProjectStatusHistoryPage {
  readonly entries: readonly ProjectStatusHistoryEntry[];
  readonly nextCursor: string | null;
}

export interface ValidateProjectAssignmentQuery {
  readonly projectId: StableId<"Project">;
  readonly valueId: StableId<"TaxonomyValue">;
  readonly transaction: TransactionContext;
}

/** Content consumes this narrow eligibility fact inside its active transaction. */
export interface ProjectAssignmentEligibilityPort {
  isEligible(
    query: ValidateProjectAssignmentQuery,
  ): Promise<Result<boolean, Rejection>>;
}

/** Taxonomy owns value evolution and coordinates Content-owned assignment migration. */
export interface TaxonomyMergeCoordinator {
  merge(
    command: MergeTaxonomyValueCommand,
    contentAssignments: ContentTaxonomyAssignmentsPort,
  ): Promise<Result<void, Rejection>>;
}

export interface TaxonomyDiscoveryService {
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

  listProjectStatusValues(): Promise<Result<readonly ProjectStatusValueView[], Rejection>>;

  createProjectStatusValue(
    command: CreateProjectStatusValueCommand,
  ): Promise<Result<ProjectStatusValueReceipt, Rejection>>;

  renameProjectStatusValue(
    command: RenameProjectStatusValueCommand,
  ): Promise<Result<ProjectStatusValueReceipt, Rejection>>;

  retireProjectStatusValue(
    command: RetireProjectStatusValueCommand,
  ): Promise<Result<ProjectStatusValueReceipt, Rejection>>;

  getProjectStatusHistory(
    query: ProjectStatusHistoryQuery,
  ): Promise<Result<ProjectStatusHistoryPage, Rejection>>;

  getPublicDiscovery(
    query: GetPublicDiscoveryQuery,
  ): Promise<Result<ProjectDiscoveryPage, Rejection>>;
}

export interface CreateProjectStatusValueCommand {
  readonly actor: ActorContext;
  readonly label: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface RenameProjectStatusValueCommand {
  readonly actor: ActorContext;
  readonly valueId: StableId<"ProjectStatusValue">;
  readonly label: string;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface RetireProjectStatusValueCommand {
  readonly actor: ActorContext;
  readonly valueId: StableId<"ProjectStatusValue">;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}
