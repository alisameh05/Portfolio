import type { StableId, Result, Rejection, ActorContext } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import type {
  ContentHistoryPage,
  CreateDraftPayload,
  PrivateRevisionPreview,
  ProjectStatus,
  LocalizedRevision,
  PublicLocalizedContentDto,
  SupportedLocale,
} from "../domain/index.js";

export interface ExistingContentCommandContext {
  readonly actor: ActorContext;
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly correlationId: string;
}

export interface CreateContentCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly payload: CreateDraftPayload;
}

export interface SaveRevisionCommand extends ExistingContentCommandContext {
  readonly contentId: StableId<string>;
  readonly locale: SupportedLocale;
  readonly title: string;
  readonly summary: string;
  readonly caseStudyBody: string;
}

export interface PublishLanguageVersionCommand extends ExistingContentCommandContext {
  readonly contentId: StableId<string>;
  readonly locale: SupportedLocale;
  readonly revisionId: StableId<"Revision">;
}

export interface ReviewRevisionCommand extends ExistingContentCommandContext {
  readonly contentId: StableId<string>;
  readonly revisionId: StableId<"Revision">;
  readonly locale: SupportedLocale;
  readonly snapshotHash: string;
  readonly evidenceVersion: number;
  readonly decision: "accepted" | "rejected";
  readonly findings: readonly string[];
}

export interface CorrectCandidateSlugCommand extends ExistingContentCommandContext {
  readonly projectId: StableId<"Project">;
  readonly candidateSlug: string;
}

export interface HideContentCommand extends ExistingContentCommandContext {
  readonly contentId: StableId<string>;
}

export interface ArchiveContentCommand extends ExistingContentCommandContext {
  readonly contentId: StableId<string>;
}

export interface RestoreContentCommand extends ExistingContentCommandContext {
  readonly contentId: StableId<string>;
}

export interface ChangeProjectStatusCommand extends ExistingContentCommandContext {
  readonly projectId: StableId<"Project">;
  readonly statusValueId: ProjectStatus;
}

export interface SetProjectFeaturedCommand extends ExistingContentCommandContext {
  readonly projectId: StableId<"Project">;
  readonly isFeatured: boolean;
}

export interface ChangePublicSlugCommand extends ExistingContentCommandContext {
  readonly projectId: StableId<"Project">;
  readonly newSlug: string;
}

export interface PreviewRevisionQuery {
  readonly actor: ActorContext;
  readonly contentId: StableId<string>;
  readonly revisionId: StableId<"Revision">;
  readonly locale: SupportedLocale;
}

export interface ContentHistoryQuery {
  readonly actor: ActorContext;
  readonly contentId: StableId<string>;
  readonly locale?: SupportedLocale;
  /** Clamp to 1..100 before querying; default to 25. */
  readonly limit: number;
  readonly cursor?: string;
}

export interface ProjectCommandReceipt {
  readonly projectId: StableId<"Project">;
  readonly aggregateVersion: number;
  readonly outcome: string;
}

export interface MediaAcceptanceFact {
  readonly mediaAssetId: StableId<"MediaAsset">;
  readonly ownerId: StableId<"Owner">;
  readonly accepted: boolean;
  readonly safe: boolean;
  readonly suitable: boolean;
  readonly accessible: boolean;
  readonly version: number;
}

export interface MediaAcceptanceBatch {
  /** Identifies one authoritative, consistent read of the requested assets. */
  readonly consistencyVersion: string;
  /** Exactly one fact per distinct requested mediaAssetId; missing or duplicate facts reject publication. */
  readonly facts: readonly MediaAcceptanceFact[];
}

export interface MediaAcceptanceQuery {
  readonly ownerId: StableId<"Owner">;
  readonly mediaAssetIds: readonly StableId<"MediaAsset">[];
  readonly intendedUse: "project-evidence" | "achievement-evidence" | "localized-content";
  readonly locale: SupportedLocale;
}

/**
 * Implemented by Media through its module barrel in Phase 6. Until then there
 * is no production implementation and publication must reject. Missing,
 * duplicate, mismatched-owner, unsafe, unsuitable, inaccessible, or stale
 * facts also reject publication.
 */
export interface MediaAcceptancePort {
  getAcceptanceFacts(
    query: MediaAcceptanceQuery,
    transaction: TransactionContext,
  ): Promise<Result<MediaAcceptanceBatch, Rejection>>;
}

/** A transaction-bound Content read of Media currently referenced by visible publications. */
export interface VisibleMediaUsageQuery {
  readonly ownerId: StableId<"Owner">;
  readonly mediaAssetIds: readonly StableId<"MediaAsset">[];
}

export interface VisibleMediaUsageFact {
  readonly mediaAssetId: StableId<"MediaAsset">;
  readonly inUse: boolean;
}

export interface VisibleMediaUsageBatch {
  /** Exactly one fact for each distinct requested Media identity, in ascending identity order. */
  readonly facts: readonly VisibleMediaUsageFact[];
}

/** Exact-locale use check against the currently published public Project projection. */
export interface GetPublicProjectMediaUseQuery {
  readonly mediaAssetId: StableId<"MediaAsset">;
  readonly locale: SupportedLocale;
}

export interface ProjectTaxonomyAssignmentCommand extends ExistingContentCommandContext {
  readonly projectId: StableId<"Project">;
  readonly valueId: StableId<"TaxonomyValue">;
}

export interface ProjectTaxonomyMergeCommand extends ExistingContentCommandContext {
  readonly sourceValueId: StableId<"TaxonomyValue">;
  readonly targetValueId: StableId<"TaxonomyValue">;
}

/** Content owns assignment writes; Taxonomy supplies the active transaction identity. */
export interface ContentTaxonomyAssignmentsPort {
  listAssignmentHistory(
    taxonomyId: StableId<"Taxonomy">,
    limit: number,
    transaction: TransactionContext,
  ): Promise<readonly {
    readonly projectId: StableId<"Project">;
    readonly valueId: StableId<"TaxonomyValue">;
    readonly aggregateVersion: number;
    readonly changedAt: string;
  }[]>;
  listProjectsWithValue(
    valueId: StableId<"TaxonomyValue">,
    limit: number,
    transaction: TransactionContext,
  ): Promise<Result<readonly StableId<"Project">[], Rejection>>;
  migrateProjectValues(
    command: Pick<ProjectTaxonomyMergeCommand, "sourceValueId" | "targetValueId"> & {
      readonly projectId: StableId<"Project">;
      readonly actorId: StableId<"Owner">;
    },
    transaction: TransactionContext,
  ): Promise<Result<{ readonly aggregateVersion: number; readonly changed: boolean }, Rejection>>;
}

export interface GetPublicContentQuery {
  readonly slug: string;
  readonly locale: SupportedLocale;
}

export interface ContentPublishingService {
  createContent(
    command: CreateContentCommand,
  ): Promise<Result<ProjectCommandReceipt, Rejection>>;

  saveRevision(
    command: SaveRevisionCommand,
  ): Promise<Result<LocalizedRevision, Rejection>>;

  publishLanguageVersion(
    command: PublishLanguageVersionCommand,
  ): Promise<Result<ProjectCommandReceipt, Rejection>>;

  reviewRevision(
    command: ReviewRevisionCommand,
  ): Promise<Result<ProjectCommandReceipt, Rejection>>;

  correctCandidateSlug(
    command: CorrectCandidateSlugCommand,
  ): Promise<Result<ProjectCommandReceipt, Rejection>>;

  previewRevision(
    query: PreviewRevisionQuery,
  ): Promise<Result<PrivateRevisionPreview, Rejection>>;

  getContentHistory(
    query: ContentHistoryQuery,
  ): Promise<Result<ContentHistoryPage, Rejection>>;

  assignProjectTaxonomyValue(
    command: ProjectTaxonomyAssignmentCommand,
    transaction: TransactionContext,
  ): Promise<Result<ProjectCommandReceipt, Rejection>>;

  migrateProjectTaxonomyValueAssignments(
    command: ProjectTaxonomyMergeCommand,
    transaction: TransactionContext,
  ): Promise<Result<ProjectCommandReceipt, Rejection>>;

  hideContent(
    command: HideContentCommand,
  ): Promise<Result<ProjectCommandReceipt, Rejection>>;

  archiveContent(
    command: ArchiveContentCommand,
  ): Promise<Result<ProjectCommandReceipt, Rejection>>;

  restoreContent(
    command: RestoreContentCommand,
  ): Promise<Result<ProjectCommandReceipt, Rejection>>;

  changeProjectStatus(
    command: ChangeProjectStatusCommand,
  ): Promise<Result<ProjectCommandReceipt, Rejection>>;

  setProjectFeatured(
    command: SetProjectFeaturedCommand,
  ): Promise<Result<ProjectCommandReceipt, Rejection>>;

  changePublicSlug(
    command: ChangePublicSlugCommand,
  ): Promise<Result<ProjectCommandReceipt, Rejection>>;

  getPublicContent(
    query: GetPublicContentQuery,
  ): Promise<Result<PublicLocalizedContentDto, Rejection>>;
}
