import { err, parseStableId, type ActorContext, type IdempotencyKey, type Rejection, type Result, type StableId } from "@shared/domain";
import type { Clock, StableIdGenerator, TransactionContext } from "../../../runtime/ports.js";
import { createSystemClock, createSystemIdGenerator } from "../../../runtime/ports.js";
import { hashCanonicalRequest } from "../../../shared/application/idempotency.js";
import type { OperationsPersistencePorts, SafeResultEnvelope } from "../../portability-operations/index.js";
import type { ContentHistoryEntry, ContentHistoryPage, ContentKind, CreateDraftPayload, LocalizedDraftData, PrivateRevisionPreview, SupportedLocale } from "../domain/index.js";
import type { ChangePublicSlugCommand, CorrectCandidateSlugCommand, MediaAcceptancePort, ProjectCommandReceipt, PublishLanguageVersionCommand, ReviewRevisionCommand,
  GetPublicProjectMediaUseQuery, VisibleMediaUsageBatch, VisibleMediaUsageQuery } from "./service.js";

export interface ContentAuthoringScope {
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
}

/** Narrow cross-module seam for the Discovery card write in the publish transaction. */
export interface ProjectDiscoveryProjectionPort {
  writePublishedProjectLocale(
    input: {
      readonly contentId: StableId<"Project">;
      readonly portfolioId: StableId<"Portfolio">;
      readonly ownerId: StableId<"Owner">;
      readonly locale: SupportedLocale;
      readonly revisionId: StableId<"Revision">;
      readonly routeIdentity: StableId<"PublicRoute">;
      readonly title: string;
      readonly slug: string;
      readonly firstPublishedAt: string;
      readonly publishedAt: string;
    },
    transaction: TransactionContext,
  ): Promise<void>;
  updateProjectRouteSlug(
    input: {
      readonly contentId: StableId<"Project">;
      readonly routeIdentity: StableId<"PublicRoute">;
      readonly slug: string;
      readonly expectedLocales: readonly SupportedLocale[];
    },
    transaction: TransactionContext,
  ): Promise<void>;
}

export interface RelateProjectsInput {
  readonly projectId: StableId<"Project">;
  readonly relatedProjectId: StableId<"Project">;
  readonly scope: ContentAuthoringScope;
  readonly expectedVersion: number;
}

export interface RelateProjectsResult {
  readonly projectAggregateVersion: number;
  readonly relatedProjectAggregateVersion: number;
  readonly relatedAt: string;
}

export interface OwnerProjectRelationshipsView {
  readonly projectId: StableId<"Project">;
  readonly aggregateVersion: number;
  readonly relatedProjectIds: readonly StableId<"Project">[];
  readonly publicRoute: ContentPublicRouteFacts | null;
}

export interface PublicRelatedProjectView {
  readonly projectId: StableId<"Project">;
  readonly title: string;
  readonly slug: string;
  readonly firstPublishedAt: string;
}

export interface ContentAuthoringRevision {
  readonly revisionId: StableId<"Revision">;
  readonly contentId: StableId<string>;
  readonly contentType: ContentKind;
  readonly locale: SupportedLocale;
  readonly sequence: number;
  readonly aggregateVersion: number;
  readonly evidenceSnapshotVersion: number;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly payload: CreateDraftPayload;
  readonly savedAt: string;
  readonly reviewed: boolean;
  readonly reviewDecision?: "accepted" | "rejected";
  readonly latestReview?: ContentAuthoringReview;
}

export interface ContentAuthoringReview {
  readonly reviewId: StableId<"ContentReview">;
  readonly revisionId: StableId<"Revision">;
  readonly contentId: StableId<string>;
  readonly contentType: ContentKind;
  readonly locale: SupportedLocale;
  readonly snapshotHash: string;
  readonly evidenceVersion: number;
  readonly reviewerId: StableId<"Owner">;
  readonly reviewSequence: number;
  readonly decision: "accepted" | "rejected";
  readonly findings: readonly string[];
  readonly reviewedAt: string;
}

export interface ContentAuthoringRecord {
  readonly contentId: StableId<string>;
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
  readonly contentType: ContentKind;
  readonly lifecycle: "draft" | "published" | "hidden" | "archived";
  readonly candidateSlug: string | null;
  readonly aggregateVersion: number;
  readonly revisions: readonly ContentAuthoringRevision[];
  readonly publications?: readonly ContentAuthoringPublication[];
  readonly publicationHistory?: readonly ContentAuthoringPublicationHistory[];
  readonly revisionCounts?: Partial<Record<SupportedLocale, number>>;
  readonly publicRoute?: ContentPublicRouteFacts | null;
}

export interface ContentPublicRouteFacts {
  readonly identity: StableId<"PublicRoute">;
  readonly canonicalSlug: string;
  readonly redirects: ReadonlyArray<{ readonly fromSlug: string; readonly toSlug: string }>;
  readonly history: ReadonlyArray<{ readonly sequence: number; readonly fromSlug: string; readonly toSlug: string; readonly changedAt: string }>;
}

export interface ContentAuthoringPublication {
  readonly locale: "en" | "ar";
  readonly revisionId: StableId<"Revision">;
  readonly reviewId: StableId<"ContentReview">;
  readonly snapshotHash: string;
  readonly evidenceVersion: number;
  readonly reviewerId: StableId<"Owner">;
  readonly decision: "accepted" | "rejected";
  readonly mediaFactsVersion: string | null;
  readonly publishedAt: string;
}

export interface ContentAuthoringPublicationHistory {
  readonly locale: SupportedLocale;
  readonly sequence: number;
  readonly revisionId: StableId<"Revision">;
  readonly reviewId: StableId<"ContentReview">;
  readonly publishedAt: string;
}

export interface ChangeContentLifecycleInput {
  readonly contentId: StableId<string>;
  readonly scope: ContentAuthoringScope;
  readonly expectedVersion: number;
  readonly lifecycle: "hidden" | "archived" | "published";
  readonly reason?: string;
}

export interface ChangeContentLifecycleResult {
  readonly aggregateVersion: number;
  readonly lifecycle: "hidden" | "archived" | "published";
  readonly previousLifecycle: "draft" | "published" | "hidden" | "archived";
  readonly changed: boolean;
  readonly changedAt: string | null;
}

export interface PublishProjectLanguageInput {
  readonly contentId: StableId<string>;
  readonly scope: ContentAuthoringScope;
  readonly expectedVersion: number;
  readonly locale: SupportedLocale;
  readonly revisionId: StableId<"Revision">;
  readonly reviewId: StableId<"ContentReview">;
  readonly snapshotHash: string;
  readonly routeIdentity: StableId<"PublicRoute">;
  readonly publishedAt: string;
  readonly payload: Extract<CreateDraftPayload, { contentType: "project" }>;
  readonly mediaFactsVersion: string | null;
}

export interface PublishProjectLanguageResult {
  readonly aggregateVersion: number;
  readonly revisionId: StableId<"Revision">;
  readonly locale: SupportedLocale;
  readonly routeIdentity: StableId<"PublicRoute">;
  readonly currentSlug: string;
  readonly firstPublishedAt: string;
  readonly publishedAt: string;
}

export interface PublicAchievementTimelineEntry {
  readonly contentId: StableId<"Achievement">;
  readonly locale: SupportedLocale;
  readonly revisionId: StableId<"Revision">;
  readonly achievedOn: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly artifacts: readonly {
    readonly title: string;
    readonly destinationUrl?: string;
    readonly mediaAssetId?: StableId<"MediaAsset">;
  }[];
}

export interface PublishTestimonialLanguageInput {
  readonly contentId: StableId<string>;
  readonly scope: ContentAuthoringScope;
  readonly expectedVersion: number;
  readonly locale: SupportedLocale;
  readonly revisionId: StableId<"Revision">;
  readonly reviewId: StableId<"ContentReview">;
  readonly snapshotHash: string;
  readonly payload: Extract<CreateDraftPayload, { contentType: "testimonial" }>;
}

export interface PublishTestimonialLanguageResult {
  readonly aggregateVersion: number;
  readonly revisionId: StableId<"Revision">;
  readonly locale: SupportedLocale;
  readonly firstPublishedAt: string;
  readonly publishedAt: string;
}

export interface PublishAchievementLanguageInput {
  readonly contentId: StableId<string>;
  readonly scope: ContentAuthoringScope;
  readonly expectedVersion: number;
  readonly locale: SupportedLocale;
  readonly revisionId: StableId<"Revision">;
  readonly reviewId: StableId<"ContentReview">;
  readonly snapshotHash: string;
  readonly publishedAt: string;
  readonly payload: Extract<CreateDraftPayload, { contentType: "achievement" }>;
  readonly mediaFactsVersion: string | null;
}

export interface PublishAchievementLanguageResult {
  readonly aggregateVersion: number;
  readonly revisionId: StableId<"Revision">;
  readonly locale: SupportedLocale;
  readonly firstPublishedAt: string;
  readonly publishedAt: string;
}

export interface PublicTestimonialView {
  readonly contentId: StableId<string>;
  readonly revisionId: StableId<"Revision">;
  readonly locale: SupportedLocale;
  readonly authorName: string;
  readonly quote: string;
  readonly association: { readonly type: "profile" } | { readonly type: "project"; readonly projectId: StableId<"Project"> };
  readonly publishedAt: string;
}

export type PublicTestimonialAssociationQuery =
  | { readonly type: "profile" }
  | { readonly type: "project"; readonly projectId: StableId<"Project"> };

export interface PublicProjectContentView {
  readonly contentId: StableId<string>;
  readonly contentType: "project";
  readonly locale: SupportedLocale;
  readonly revisionId: StableId<"Revision">;
  readonly routeIdentity: StableId<"PublicRoute">;
  readonly currentSlug: string;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly firstPublishedAt: string;
  readonly publishedAt: string;
  readonly caseStudy: {
    readonly problem: string;
    readonly ownerRole: string;
    readonly contributions: readonly string[];
    readonly outcomes: readonly string[];
    readonly lessons: string;
  };
  readonly claims: readonly { readonly text: string; readonly artifacts: readonly {
    readonly title: string;
    readonly destinationUrl?: string;
    readonly mediaAssetId?: StableId<"MediaAsset">;
  }[] }[];
  readonly externalLinks: readonly {
    readonly type?: "github-repository" | "live-demo";
    readonly label: string;
    readonly destination: string;
  }[];
}

export type PublicProjectRouteResolution =
  | { readonly type: "canonical"; readonly content: PublicProjectContentView }
  | {
      readonly type: "redirect";
      readonly statusCode: 308;
      readonly contentId: StableId<string>;
      readonly routeIdentity: StableId<"PublicRoute">;
      readonly locale: SupportedLocale;
      readonly fromSlug: string;
      readonly toSlug: string;
      /** A root-relative same-origin path built only from a validated reserved slug. */
      readonly location: string;
    };

export interface CreateContentPersistenceInput {
  readonly contentId: StableId<string>;
  readonly revisionId: StableId<"Revision">;
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
  readonly candidateSlug: string | null;
  readonly payload: CreateDraftPayload;
  readonly savedAt: string;
}

export interface AppendContentRevisionInput {
  readonly contentId: StableId<string>;
  readonly scope: ContentAuthoringScope;
  readonly revisionId: StableId<"Revision">;
  readonly expectedVersion: number;
  readonly payload: CreateDraftPayload;
  readonly savedAt: string;
}

export interface ContentProjectStatusValue {
  readonly valueId: StableId<"ProjectStatusValue">;
  readonly label: string;
  readonly state: "active" | "retired";
  readonly aggregateVersion: number;
}

export interface ContentProjectStatusHistoryEntry {
  readonly operation: "created" | "renamed" | "retired";
  readonly previousLabel: string | null;
  readonly label: string;
  readonly state: "active" | "retired";
  readonly aggregateVersion: number;
  readonly changedAt: string;
}

export interface ContentProjectStatusTransition {
  readonly previousValueId: StableId<"ProjectStatusValue"> | null;
  readonly currentValueId: StableId<"ProjectStatusValue">;
  readonly aggregateVersion: number;
  readonly changedAt: string;
  readonly changed: boolean;
}

export interface ContentProjectMutation {
  readonly aggregateVersion: number;
  readonly changedAt: string | null;
  readonly changed: boolean;
}

export interface ContentProjectStatusValueChange {
  readonly value: ContentProjectStatusValue;
  readonly changed: boolean;
  readonly changedAt: string | null;
}

export interface ContentProjectOwnerView {
  readonly projectId: StableId<"Project">;
  readonly aggregateVersion: number;
  readonly statusValueId: StableId<"ProjectStatusValue"> | null;
  readonly featured: boolean;
  readonly publicRoute: {
    readonly identity: StableId<"PublicRoute">;
    readonly canonicalSlug: string;
    readonly redirects: readonly { readonly fromSlug: string; readonly toSlug: string }[];
    readonly history: readonly { readonly sequence: number; readonly fromSlug: string; readonly toSlug: string; readonly changedAt: string }[];
  } | null;
  readonly relatedProjectIds: readonly StableId<"Project">[];
  readonly relationshipHistory: readonly {
    readonly sequence: number;
    readonly relatedProjectId: StableId<"Project">;
    readonly action: "related";
    readonly changedAt: string;
  }[];
  readonly statusHistory: readonly {
    readonly sequence: number;
    readonly previousValueId: StableId<"ProjectStatusValue"> | null;
    readonly currentValueId: StableId<"ProjectStatusValue">;
    readonly aggregateVersion: number;
    readonly changedAt: string;
  }[];
  readonly taxonomyAssignments: readonly {
    readonly taxonomyId: StableId<"Taxonomy">;
    readonly taxonomyKind: string;
    readonly valueId: StableId<"TaxonomyValue">;
  }[];
}

export interface ContentProjectTaxonomyAssignment {
  readonly aggregateVersion: number;
  readonly changed: boolean;
  readonly changedAt: string;
}

/** Taxonomy-owned active-value facts and discovery projection writer. Calls share Content's transaction. */
export interface ProjectTaxonomyAssignmentFactsPort {
  getValueFacts(input: {
    readonly valueId: StableId<"TaxonomyValue">;
    readonly scope: ContentAuthoringScope;
  }, context: TransactionContext): Promise<Result<{
    readonly taxonomyId: StableId<"Taxonomy">;
    readonly taxonomyKind: "category" | "ai-ml-domain" | "technology" | "project-type";
    readonly label: string;
    readonly eligible: boolean;
  }, Rejection>>;
  updateProjectDiscoveryTaxonomyValue(input: {
    readonly projectId: StableId<"Project">;
    readonly valueId: StableId<"TaxonomyValue">;
    readonly scope: ContentAuthoringScope;
  }, context: TransactionContext): Promise<void>;
  mergeProjectDiscoveryTaxonomyValue(input: {
    readonly projectId: StableId<"Project">;
    readonly sourceValueId: StableId<"TaxonomyValue">;
    readonly targetValueId: StableId<"TaxonomyValue">;
    readonly scope: ContentAuthoringScope;
  }, context: TransactionContext): Promise<void>;
}

export interface ContentAuthoringRepository {
  projectExists(projectId: StableId<"Project">, scope: ContentAuthoringScope, context: TransactionContext): Promise<boolean>;
  getVisibleMediaUsage(input: { readonly mediaAssetIds: readonly StableId<"MediaAsset">[]; readonly scope: ContentAuthoringScope }, context: TransactionContext): Promise<Result<VisibleMediaUsageBatch, Rejection>>;
  getPublicProjectMediaUse(input: GetPublicProjectMediaUseQuery & { readonly scope: ContentAuthoringScope }, context: TransactionContext): Promise<Result<boolean, Rejection>>;
  create(input: CreateContentPersistenceInput, context: TransactionContext): Promise<Result<ContentAuthoringRecord, Rejection>>;
  get(contentId: StableId<string>, scope: ContentAuthoringScope, context: TransactionContext, revisionHistoryLimit?: number): Promise<Result<ContentAuthoringRecord, Rejection>>;
  correctCandidateSlug(input: { readonly contentId: StableId<string>; readonly scope: ContentAuthoringScope; readonly expectedVersion: number; readonly slug: string }, context: TransactionContext): Promise<Result<{ readonly aggregateVersion: number }, Rejection>>;
  changePublicSlug(input: { readonly contentId: StableId<string>; readonly scope: ContentAuthoringScope; readonly expectedVersion: number; readonly slug: string }, context: TransactionContext): Promise<Result<{ readonly aggregateVersion: number; readonly previousSlug: string; readonly routeIdentity: StableId<"PublicRoute"> }, Rejection>>;
  relateProjects(input: RelateProjectsInput, context: TransactionContext): Promise<Result<RelateProjectsResult, Rejection>>;
  getOwnerProjectRelationships(input: { readonly projectId: StableId<"Project">; readonly scope: ContentAuthoringScope }, context: TransactionContext): Promise<Result<OwnerProjectRelationshipsView, Rejection>>;
  getPublicRelatedProjects(input: { readonly projectId: StableId<"Project">; readonly locale: SupportedLocale; readonly limit: number; readonly scope: ContentAuthoringScope }, context: TransactionContext): Promise<Result<readonly PublicRelatedProjectView[], Rejection>>;
  changeLifecycle(input: ChangeContentLifecycleInput, context: TransactionContext): Promise<Result<ChangeContentLifecycleResult, Rejection>>;
  appendRevision(input: AppendContentRevisionInput, context: TransactionContext): Promise<Result<{ readonly record: ContentAuthoringRecord; readonly revision: ContentAuthoringRevision }, Rejection>>;
  appendReview(input: AppendContentReviewInput, context: TransactionContext): Promise<Result<{ readonly aggregateVersion: number }, Rejection>>;
  publishProjectLanguage(input: PublishProjectLanguageInput, context: TransactionContext): Promise<Result<PublishProjectLanguageResult, Rejection>>;
  publishTestimonialLanguage(input: PublishTestimonialLanguageInput, context: TransactionContext): Promise<Result<PublishTestimonialLanguageResult, Rejection>>;
  getPublicTestimonials(input: { readonly scope: ContentAuthoringScope; readonly locale: SupportedLocale; readonly association: PublicTestimonialAssociationQuery }, context: TransactionContext): Promise<Result<readonly PublicTestimonialView[], Rejection>>;
  publishAchievementLanguage(input: PublishAchievementLanguageInput, context: TransactionContext): Promise<Result<PublishAchievementLanguageResult, Rejection>>;
  getPublicProjectBySlug(input: { readonly slug: string; readonly locale: SupportedLocale; readonly scope: ContentAuthoringScope }, context: TransactionContext): Promise<Result<PublicProjectContentView, Rejection>>;
  getPublicAchievementTimeline(input: { readonly locale: SupportedLocale; readonly limit: number; readonly scope: ContentAuthoringScope }, context: TransactionContext): Promise<Result<readonly PublicAchievementTimelineEntry[], Rejection>>;
  listHistory(input: { readonly contentId: StableId<string>; readonly scope: ContentAuthoringScope; readonly locale?: SupportedLocale; readonly after?: { readonly locale: SupportedLocale; readonly sequence: number }; readonly limit: number }, context: TransactionContext): Promise<Result<{ readonly entries: readonly ContentHistoryEntry[]; readonly hasMore: boolean }, Rejection>>;
  listProjectStatusValues(scope: ContentAuthoringScope, context: TransactionContext): Promise<Result<readonly ContentProjectStatusValue[], Rejection>>;
  getProjectOwnerView(projectId: StableId<"Project">, scope: ContentAuthoringScope, context: TransactionContext): Promise<Result<ContentProjectOwnerView, Rejection>>;
  listProjectStatusHistory(input: { readonly valueId: StableId<"ProjectStatusValue">; readonly scope: ContentAuthoringScope }, context: TransactionContext): Promise<Result<readonly ContentProjectStatusHistoryEntry[], Rejection>>;
  createProjectStatusValue(input: { readonly valueId: StableId<"ProjectStatusValue">; readonly label: string; readonly scope: ContentAuthoringScope }, context: TransactionContext): Promise<Result<ContentProjectStatusValueChange, Rejection>>;
  renameProjectStatusValue(input: { readonly valueId: StableId<"ProjectStatusValue">; readonly label: string; readonly expectedVersion: number; readonly scope: ContentAuthoringScope }, context: TransactionContext): Promise<Result<ContentProjectStatusValueChange, Rejection>>;
  retireProjectStatusValue(input: { readonly valueId: StableId<"ProjectStatusValue">; readonly expectedVersion: number; readonly scope: ContentAuthoringScope }, context: TransactionContext): Promise<Result<ContentProjectStatusValueChange, Rejection>>;
  changeProjectStatus(input: { readonly projectId: StableId<"Project">; readonly valueId: StableId<"ProjectStatusValue">; readonly expectedVersion: number; readonly scope: ContentAuthoringScope }, context: TransactionContext): Promise<Result<ContentProjectStatusTransition, Rejection>>;
  setProjectFeatured(input: { readonly projectId: StableId<"Project">; readonly featured: boolean; readonly expectedVersion: number; readonly scope: ContentAuthoringScope }, context: TransactionContext): Promise<Result<ContentProjectMutation, Rejection>>;
  assignProjectTaxonomyValue(input: { readonly projectId: StableId<"Project">; readonly valueId: StableId<"TaxonomyValue">; readonly actorId: StableId<"Owner">; readonly expectedVersion: number; readonly eligible: boolean; readonly scope: ContentAuthoringScope }, context: TransactionContext): Promise<Result<ContentProjectTaxonomyAssignment, Rejection>>;
}

export interface AppendContentReviewInput {
  readonly contentId: StableId<string>;
  readonly scope: ContentAuthoringScope;
  readonly revisionId: StableId<"Revision">;
  readonly locale: SupportedLocale;
  readonly expectedVersion: number;
  readonly reviewId: StableId<"ContentReview">;
  readonly snapshotHash: string;
  readonly evidenceVersion: number;
  readonly reviewerId: StableId<"Owner">;
  readonly decision: "accepted" | "rejected";
  readonly findings: readonly string[];
  readonly reviewedAt: string;
}

export interface SaveContentRevisionCommand {
  readonly actor: ActorContext;
  readonly contentId: StableId<string>;
  readonly expectedVersion: number;
  readonly idempotencyKey: IdempotencyKey;
  readonly correlationId: string;
  readonly locale: SupportedLocale;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly draftData?: LocalizedDraftData;
}

export interface CreateOwnerContentCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly correlationId: string;
  readonly payload: CreateDraftPayload;
}

export interface GetOwnerContentAggregateQuery {
  readonly actor: ActorContext;
  readonly contentId: StableId<string>;
}

export interface ChangeContentLifecycleCommand {
  readonly actor: ActorContext;
  readonly contentId: StableId<string>;
  readonly expectedVersion: number;
  readonly idempotencyKey: IdempotencyKey;
  readonly correlationId: string;
  readonly reason?: string;
}

export interface CreateContentReceipt {
  readonly contentId: StableId<string>;
  readonly aggregateVersion: number;
  readonly revisionId: StableId<"Revision">;
  readonly outcome: "content-created";
}

export interface SaveContentRevisionReceipt {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome: "revision-saved";
  readonly revisionId: StableId<"Revision">;
}

export interface OwnerContentAggregateView {
  readonly contentId: StableId<string>;
  readonly aggregateVersion: number;
  readonly contentType: ContentKind;
  readonly lifecycle: ContentAuthoringRecord["lifecycle"];
  readonly publicRoute: ContentPublicRouteFacts | null;
  readonly routeHistory: ContentPublicRouteFacts["history"];
  readonly localizedStreams: Partial<Record<SupportedLocale, {
    readonly revisionCount: number;
    readonly currentPublishedRevisionId: StableId<string> | null;
  }>>;
  readonly revisions: readonly {
    readonly revisionId: StableId<"Revision">;
    readonly locale: SupportedLocale;
    readonly sequence: number;
    readonly reviewed: boolean;
    readonly reviewDecision?: "accepted" | "rejected";
  }[];
  readonly publicationHistory: readonly ContentAuthoringPublicationHistory[];
}

export interface ContentAuthoringService {
  getVisibleMediaUsage(query: VisibleMediaUsageQuery, transaction: TransactionContext): Promise<Result<VisibleMediaUsageBatch, Rejection>>;
  getPublicProjectMediaUse(query: GetPublicProjectMediaUseQuery, transaction: TransactionContext): Promise<Result<boolean, Rejection>>;
  createContent(command: CreateOwnerContentCommand): Promise<Result<CreateContentReceipt, Rejection>>;
  getOwnerContentAggregate(query: GetOwnerContentAggregateQuery): Promise<Result<OwnerContentAggregateView, Rejection>>;
  saveRevision(command: SaveContentRevisionCommand): Promise<Result<SaveContentRevisionReceipt, Rejection>>;
  previewRevision(query: { readonly actor: ActorContext; readonly contentId: StableId<string>; readonly revisionId: StableId<"Revision"> }): Promise<Result<PrivateRevisionPreview, Rejection>>;
  reviewRevision(command: ReviewRevisionCommand): Promise<Result<ReviewRevisionReceipt, Rejection>>;
  publishLanguageVersion(command: PublishLanguageVersionCommand): Promise<Result<ContentAuthoringPublicationReceipt, Rejection>>;
  correctCandidateSlug(command: CorrectCandidateSlugCommand): Promise<Result<OwnerContentRouteChangeReceipt, Rejection>>;
  changePublicSlug(command: ChangePublicSlugCommand): Promise<Result<OwnerContentRouteChangeReceipt, Rejection>>;
  relateProjects(command: RelateOwnerProjectsCommand): Promise<Result<RelateProjectsReceipt, Rejection>>;
  getOwnerProjectRelationships(query: { readonly actor: ActorContext; readonly projectId: StableId<"Project"> }): Promise<Result<OwnerProjectRelationshipsView, Rejection>>;
  getPublicRelatedProjects(query: { readonly projectId: StableId<"Project">; readonly locale: SupportedLocale; readonly limit?: number }): Promise<Result<readonly PublicRelatedProjectView[], Rejection>>;
  hideContent(command: ChangeContentLifecycleCommand): Promise<Result<ContentLifecycleReceipt, Rejection>>;
  archiveContent(command: ChangeContentLifecycleCommand): Promise<Result<ContentLifecycleReceipt, Rejection>>;
  restoreContent(command: ChangeContentLifecycleCommand): Promise<Result<ContentLifecycleReceipt, Rejection>>;
  getPublicProject(query: { readonly slug: string; readonly locale: SupportedLocale }): Promise<Result<PublicProjectContentView, Rejection>>;
  resolvePublicProjectRoute(query: { readonly slug: string; readonly locale: SupportedLocale }): Promise<Result<PublicProjectRouteResolution, Rejection>>;
  getPublicTestimonials(query: { readonly locale: SupportedLocale; readonly association: PublicTestimonialAssociationQuery }): Promise<Result<readonly PublicTestimonialView[], Rejection>>;
  /** Oldest achievement date first; ties use stable Achievement ID ascending. */
  getPublicAchievementTimeline(query: { readonly locale: SupportedLocale; readonly limit: number }): Promise<Result<readonly PublicAchievementTimelineEntry[], Rejection>>;
  getContentHistory(query: { readonly actor: ActorContext; readonly contentId: StableId<string>; readonly locale?: SupportedLocale; readonly limit: number; readonly cursor?: string }): Promise<Result<ContentHistoryPage, Rejection>>;
  listProjectStatusValues(query: { readonly actor: ActorContext }): Promise<Result<readonly ContentProjectStatusValue[], Rejection>>;
  getProjectOwnerView(query: { readonly actor: ActorContext; readonly projectId: StableId<"Project"> }): Promise<Result<ContentProjectOwnerView, Rejection>>;
  getProjectStatusHistory(query: { readonly actor: ActorContext; readonly valueId: StableId<"ProjectStatusValue"> }): Promise<Result<readonly ContentProjectStatusHistoryEntry[], Rejection>>;
  createProjectStatusValue(command: { readonly actor: ActorContext; readonly label: string; readonly idempotencyKey: IdempotencyKey; readonly correlationId: string }): Promise<Result<ContentProjectStatusValue, Rejection>>;
  renameProjectStatusValue(command: { readonly actor: ActorContext; readonly valueId: StableId<"ProjectStatusValue">; readonly label: string; readonly expectedVersion: number; readonly idempotencyKey: IdempotencyKey; readonly correlationId: string }): Promise<Result<ContentProjectStatusValue, Rejection>>;
  retireProjectStatusValue(command: { readonly actor: ActorContext; readonly valueId: StableId<"ProjectStatusValue">; readonly expectedVersion: number; readonly idempotencyKey: IdempotencyKey; readonly correlationId: string }): Promise<Result<ContentProjectStatusValue, Rejection>>;
  changeProjectStatus(command: { readonly actor: ActorContext; readonly projectId: StableId<"Project">; readonly statusValueId: StableId<"ProjectStatusValue">; readonly expectedVersion: number; readonly idempotencyKey: IdempotencyKey; readonly correlationId: string }): Promise<Result<ProjectCommandReceipt, Rejection>>;
  setProjectFeatured(command: { readonly actor: ActorContext; readonly projectId: StableId<"Project">; readonly featured: boolean; readonly expectedVersion: number; readonly idempotencyKey: IdempotencyKey; readonly correlationId: string }): Promise<Result<ProjectCommandReceipt, Rejection>>;
  assignProjectTaxonomyValue(command: { readonly actor: ActorContext; readonly projectId: StableId<"Project">; readonly valueId: StableId<"TaxonomyValue">; readonly expectedVersion: number; readonly idempotencyKey: IdempotencyKey; readonly correlationId: string }): Promise<Result<ProjectCommandReceipt, Rejection>>;
}

export interface RelateOwnerProjectsCommand {
  readonly actor: ActorContext;
  readonly projectId: StableId<"Project">;
  readonly relatedProjectId: StableId<"Project">;
  readonly expectedVersion: number;
  readonly idempotencyKey: IdempotencyKey;
  readonly correlationId: string;
}

export interface RelateProjectsReceipt {
  readonly aggregateId: StableId<"Project">;
  readonly aggregateVersion: number;
  readonly relatedProjectAggregateVersion: number;
  readonly outcome: "project-related";
}

export interface OwnerContentRouteChangeReceipt {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome: "candidate-slug-corrected" | "public-slug-changed";
  readonly slug: string;
}

export interface ContentLifecycleReceipt {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome: "content-hidden" | "content-archived" | "content-restored";
}

export interface ContentAuthoringPublicationReceipt {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome: "language-published";
  readonly revisionId: StableId<"Revision">;
  readonly locale: SupportedLocale;
  readonly currentSlug?: string | null;
  readonly routeIdentity?: StableId<"PublicRoute"> | null;
  readonly firstPublishedAt: string;
  readonly publishedAt: string;
}

export interface ReviewRevisionReceipt {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome: "revision-reviewed";
  readonly revisionId: StableId<"Revision">;
  readonly reviewId: StableId<"ContentReview">;
}

const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;
const CREATE_SCOPE = "content-publishing.create-owner-content";
const SAVE_SCOPE = "content-publishing.save-owner-content-revision";
const REVIEW_SCOPE = "content-publishing.review-owner-content-revision";
const PUBLISH_SCOPE = "content-publishing.publish-owner-project-language";
const CANDIDATE_SLUG_SCOPE = "content-publishing.correct-project-candidate-slug";
const PUBLIC_SLUG_SCOPE = "content-publishing.change-project-public-slug";
const RELATE_PROJECTS_SCOPE = "content-publishing.relate-owner-projects";
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const EXECUTABLE_MARKUP = /<\s*(?:script|iframe|object|embed|svg|math)\b|\bon[a-z]{2,}\s*=|(?:javascript|vbscript)\s*:|data\s*:\s*text\/html/i;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function rejectionOutcome(rejection: Rejection): SafeResultEnvelope {
  return {
    status: "rejected",
    kind: rejection.kind,
    code: rejection.code,
    ...(rejection.kind === "precondition_failed" && rejection.currentVersion !== undefined
      ? { currentVersion: rejection.currentVersion }
      : {}),
  };
}

function parseRejection(result: SafeResultEnvelope): Rejection {
  const kind = result["kind"];
  const code = result["code"];
  if (typeof kind !== "string" || typeof code !== "string") throw new Error("Invalid saved content operation outcome.");
  if (kind === "precondition_failed" && typeof result["currentVersion"] === "number") {
    return { kind, code, currentVersion: result["currentVersion"] };
  }
  if (["validation", "unauthenticated", "forbidden", "not_found", "conflict", "precondition_failed", "rate_limited", "temporarily_unavailable"].includes(kind)) {
    return { kind: kind as Rejection["kind"], code } as Rejection;
  }
  throw new Error("Invalid saved content operation rejection.");
}

function readReceipt<T>(result: SafeResultEnvelope): Result<T, Rejection> {
  if (result["status"] === "rejected") return err(parseRejection(result));
  if (result["status"] !== "completed" || typeof result["receipt"] !== "object" || result["receipt"] === null || Array.isArray(result["receipt"])) {
    throw new Error("Invalid saved content operation receipt.");
  }
  return { ok: true, value: result["receipt"] as T };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isCleanText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !CONTROL_CHARS.test(value) && !EXECUTABLE_MARKUP.test(value);
}

function optionalTextIsValid(value: unknown, max: number): boolean {
  return value === undefined || typeof value === "string" && value.length <= max && !CONTROL_CHARS.test(value) && !EXECUTABLE_MARKUP.test(value);
}

function optionalTextListIsValid(value: unknown, maxItems: number, maxLength: number): boolean {
  return value === undefined || Array.isArray(value) && value.length <= maxItems && value.every((item) =>
    typeof item === "string" && item.length <= maxLength && !CONTROL_CHARS.test(item) && !EXECUTABLE_MARKUP.test(item));
}

function safeWebDestination(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048 || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" && url.hash === "" &&
      ![...url.searchParams.keys()].some((key) => /(?:token|secret|signature|credential|api[-_]?key|auth)/i.test(key)) &&
      host !== "localhost" && !host.endsWith(".localhost") && !host.endsWith(".local") &&
      !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) && !host.startsWith("[");
  } catch {
    return false;
  }
}

function evidencePackageIsValid(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value) || !hasOnlyKeys(value, ["claims", "artifacts"])) return false;
  const claims = value["claims"];
  if (claims !== undefined && (!Array.isArray(claims) || claims.length > 100 || !claims.every((claim) => {
    if (!isRecord(claim) || !hasOnlyKeys(claim, ["claimId", "text", "artifactIds"])) return false;
    const claimId = claim["claimId"];
    const claimText = claim["text"];
    const artifactIds = claim["artifactIds"];
    return typeof claimId === "string" && parseStableId("EvidenceClaim", claimId).ok && isCleanText(claimText, 2_000) &&
      Array.isArray(artifactIds) && artifactIds.length <= 100 && artifactIds.every((id) => parseStableId("SupportingArtifact", id).ok) &&
      new Set(artifactIds).size === artifactIds.length;
  }))) return false;
  const artifacts = value["artifacts"];
  if (artifacts === undefined) return true;
  if (!Array.isArray(artifacts) || artifacts.length > 100) return false;
  const artifactIds = new Set<string>();
  return artifacts.every((artifact) => {
    if (!isRecord(artifact) || !hasOnlyKeys(artifact, ["id", "title", "destinationUrl", "mediaAssetId"])) return false;
    const id = artifact["id"];
    const title = artifact["title"];
    const destinationUrl = artifact["destinationUrl"];
    const mediaAssetId = artifact["mediaAssetId"];
    if (typeof id !== "string" || !parseStableId("SupportingArtifact", id).ok || artifactIds.has(id) || !isCleanText(title, 200) ||
        (destinationUrl !== undefined && !safeWebDestination(destinationUrl)) ||
        (mediaAssetId !== undefined && (typeof mediaAssetId !== "string" || !parseStableId("MediaAsset", mediaAssetId).ok))) return false;
    artifactIds.add(id);
    return true;
  });
}

function externalLinksAreValid(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 50) return false;
  const linkIds = new Set<string>();
  return value.every((link) => {
    if (!isRecord(link) || !hasOnlyKeys(link, ["id", "type", "label", "destination", "isAvailableInArabic"])) return false;
    const id = link["id"];
    const type = link["type"];
    const label = link["label"];
    const destination = link["destination"];
    const isAvailableInArabic = link["isAvailableInArabic"];
    if (typeof id !== "string" || !parseStableId("ExternalLink", id).ok || linkIds.has(id) ||
        (type !== undefined && type !== "github-repository" && type !== "live-demo") || !isCleanText(label, 120) ||
        !safeWebDestination(destination) || typeof isAvailableInArabic !== "boolean") return false;
    linkIds.add(id);
    return true;
  });
}

function payloadIsValid(payload: CreateDraftPayload): boolean {
  if (!isRecord(payload) || (payload.contentType !== "project" && payload.contentType !== "achievement" && payload.contentType !== "testimonial")) return false;
  const variantKeys = payload.contentType === "project"
    ? ["candidateSlug", "caseStudy", "evidence", "externalLinks"]
    : payload.contentType === "achievement"
      ? ["achievedOn", "evidence"]
      : ["authorName", "quote", "association", "relatedProjectId"];
  if (!hasOnlyKeys(payload, ["contentType", "locale", "title", "summary", "body", ...variantKeys])) return false;
  if (payload.locale !== "en" && payload.locale !== "ar") return false;
  if (!isCleanText(payload.title, 160) || !isCleanText(payload.summary, 500) || !isCleanText(payload.body, 50_000)) return false;
  if (payload.contentType === "project") {
    if (payload.candidateSlug !== undefined && (typeof payload.candidateSlug !== "string" || payload.candidateSlug.length > 120 || !SLUG_PATTERN.test(payload.candidateSlug))) return false;
    const study = payload.caseStudy;
    return (study === undefined || isRecord(study) && hasOnlyKeys(study, ["problem", "ownerRole", "contributions", "outcomes", "lessons"]) &&
      optionalTextIsValid(study.problem, 5_000) && optionalTextIsValid(study.ownerRole, 2_000) &&
      optionalTextIsValid(study.lessons, 5_000) && optionalTextListIsValid(study.contributions, 50, 2_000) &&
      optionalTextListIsValid(study.outcomes, 50, 2_000)) && evidencePackageIsValid(payload.evidence) && externalLinksAreValid(payload.externalLinks);
  }
  if (payload.contentType === "achievement") {
    const date = payload.achievedOn;
    const dateValid = date === undefined || typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
    return dateValid && evidencePackageIsValid(payload.evidence);
  }
  const association = payload.association ?? (payload.relatedProjectId === undefined
    ? undefined
    : { type: "project" as const, projectId: payload.relatedProjectId });
  const associationIsValid = isRecord(association) && (association["type"] === "profile"
    ? hasOnlyKeys(association, ["type"]) && payload.relatedProjectId === undefined
    : association["type"] === "project" && hasOnlyKeys(association, ["type", "projectId"]) && typeof association["projectId"] === "string" &&
      parseStableId("Project", association["projectId"]).ok &&
      (payload.relatedProjectId === undefined || payload.relatedProjectId === association["projectId"]));
  return (payload.authorName === undefined || isCleanText(payload.authorName, 200)) &&
    (payload.quote === undefined || isCleanText(payload.quote, 10_000)) && associationIsValid &&
    (payload.relatedProjectId === undefined || parseStableId("Project", payload.relatedProjectId).ok);
}

function draftDataHasOnlyExpectedKeys(value: unknown): boolean {
  if (!isRecord(value) || (value["contentType"] !== "project" && value["contentType"] !== "achievement" && value["contentType"] !== "testimonial")) return false;
  const keys = value["contentType"] === "project"
    ? ["contentType", "caseStudy", "evidence", "externalLinks"]
    : value["contentType"] === "achievement"
      ? ["contentType", "achievedOn", "evidence"]
      : ["contentType", "authorName", "quote", "association", "relatedProjectId"];
  return hasOnlyKeys(value, keys);
}

function candidateFromTitle(title: string, contentId: StableId<string>): string {
  const slug = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120).replace(/-+$/g, "");
  return slug || `draft-${contentId.slice(0, 8)}`;
}

function snapshotPayload(payload: CreateDraftPayload): CreateDraftPayload {
  if (payload.contentType === "testimonial") {
    const association = payload.association ?? (payload.relatedProjectId === undefined
      ? undefined
      : { type: "project" as const, projectId: payload.relatedProjectId });
    return Object.freeze({ ...payload, ...(association === undefined ? {} : { association }) });
  }
  return Object.freeze({ ...payload });
}

function ownerAuthorized(actor: ActorContext, scope: ContentAuthoringScope): boolean {
  return actor.kind === "owner" && actor.ownerId === scope.ownerId;
}

function validCorrelation(value: string): boolean {
  return /^[\x21-\x7e]{1,128}$/.test(value);
}

function view(record: ContentAuthoringRecord): OwnerContentAggregateView {
  const localizedStreams: OwnerContentAggregateView["localizedStreams"] = {};
  for (const locale of ["en", "ar"] as const) {
    const count = record.revisionCounts?.[locale] ?? record.revisions.filter((revision) => revision.locale === locale).length;
    if (count > 0) localizedStreams[locale] = {
      revisionCount: count,
      currentPublishedRevisionId: record.publications?.find((publication) => publication.locale === locale)?.revisionId ?? null,
    };
  }
  return {
    contentId: record.contentId,
    aggregateVersion: record.aggregateVersion,
    contentType: record.contentType,
    lifecycle: record.lifecycle,
    publicRoute: record.publicRoute ?? null,
    routeHistory: record.publicRoute?.history ?? [],
    localizedStreams,
    revisions: record.revisions.slice(-200).map(({ revisionId, locale, sequence, reviewed, reviewDecision }) => ({
      revisionId, locale, sequence, reviewed, ...(reviewDecision === undefined ? {} : { reviewDecision }),
    })),
    publicationHistory: (record.publicationHistory ?? []).slice(0, 100),
  };
}

async function revisionSnapshotHash(revision: ContentAuthoringRevision): Promise<string> {
  return await hashCanonicalRequest({
    revisionId: revision.revisionId,
    contentId: revision.contentId,
    contentType: revision.contentType,
    locale: revision.locale,
    sequence: revision.sequence,
    aggregateVersion: revision.aggregateVersion,
    evidenceVersion: revision.evidenceSnapshotVersion,
    title: revision.title,
    summary: revision.summary,
    body: revision.body,
    payload: revision.payload as unknown as import("../../../shared/application/idempotency.js").CanonicalValue,
  });
}

const PLACEHOLDER_TEXT = /\b(?:todo|tbd|lorem ipsum|placeholder|insert (?:text|claim|evidence)|sample text|fake metric)\b/i;

function publishableProjectPayload(payload: CreateDraftPayload): payload is Extract<CreateDraftPayload, { contentType: "project" }> {
  if (payload.contentType !== "project" || !payloadIsValid(payload)) return false;
  const study = payload.caseStudy;
  const evidence = payload.evidence;
  if (study === undefined || !isCleanText(study.problem, 5_000) || !isCleanText(study.ownerRole, 2_000) ||
      study.contributions === undefined || study.contributions.length === 0 ||
      study.outcomes === undefined || study.outcomes.length === 0 || !isCleanText(study.lessons, 5_000) ||
      [...study.contributions, ...study.outcomes].some((text) => !isCleanText(text, 2_000) || PLACEHOLDER_TEXT.test(text))) return false;
  if (PLACEHOLDER_TEXT.test(study.problem) || PLACEHOLDER_TEXT.test(study.ownerRole) || PLACEHOLDER_TEXT.test(study.lessons)) return false;
  if (evidence === undefined || !Array.isArray(evidence.claims) || evidence.claims.length === 0 ||
      !Array.isArray(evidence.artifacts) || evidence.artifacts.length === 0) return false;
  const artifacts = new Map(evidence.artifacts.map((artifact) => [artifact.id, artifact]));
  return evidence.claims.every((claim) => isCleanText(claim.text, 2_000) && !PLACEHOLDER_TEXT.test(claim.text) &&
    claim.artifactIds.length > 0 && claim.artifactIds.every((id: StableId<"SupportingArtifact">) => {
      const artifact = artifacts.get(id);
      return artifact !== undefined && (artifact.destinationUrl !== undefined || artifact.mediaAssetId !== undefined) &&
        !PLACEHOLDER_TEXT.test(artifact.title);
    }));
}

function publishableTestimonialPayload(payload: CreateDraftPayload): payload is Extract<CreateDraftPayload, { contentType: "testimonial" }> {
  if (payload.contentType !== "testimonial" || !payloadIsValid(payload) ||
      !isCleanText(payload.authorName, 200) || !isCleanText(payload.quote, 10_000)) return false;
  const association = payload.association ?? (payload.relatedProjectId === undefined
    ? undefined
    : { type: "project" as const, projectId: payload.relatedProjectId });
  return association !== undefined && (association.type === "profile" ||
    association.type === "project" && parseStableId("Project", association.projectId).ok);
}

function publishableAchievementPayload(payload: CreateDraftPayload): payload is Extract<CreateDraftPayload, { contentType: "achievement" }> {
  if (payload.contentType !== "achievement" || !payloadIsValid(payload) || payload.achievedOn === undefined ||
      PLACEHOLDER_TEXT.test(payload.title) || PLACEHOLDER_TEXT.test(payload.summary) || PLACEHOLDER_TEXT.test(payload.body)) return false;
  const date = payload.achievedOn;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return false;
  const evidence = payload.evidence;
  if (evidence === undefined) return true; // The exact accepted Owner review is the retained internal verification.
  if (!Array.isArray(evidence.claims) || !Array.isArray(evidence.artifacts)) return false;
  const artifacts = new Map(evidence.artifacts.map((artifact) => [artifact.id, artifact]));
  return evidence.claims.every((claim) => isCleanText(claim.text, 2_000) && !PLACEHOLDER_TEXT.test(claim.text) &&
    claim.artifactIds.length > 0 && claim.artifactIds.every((id: StableId<"SupportingArtifact">) => {
      const artifact = artifacts.get(id);
      return artifact !== undefined && isCleanText(artifact.title, 200) && !PLACEHOLDER_TEXT.test(artifact.title) &&
        (artifact.destinationUrl !== undefined || artifact.mediaAssetId !== undefined);
    }));
}

export function createContentAuthoringService(input: {
  readonly repository: ContentAuthoringRepository;
  readonly operations: OperationsPersistencePorts;
  readonly scope: ContentAuthoringScope;
  readonly discoveryProjection: ProjectDiscoveryProjectionPort;
  readonly clock?: Clock;
  readonly ids?: StableIdGenerator;
  /** Test seam for authoritative Media facts; production intentionally has no Media acceptance adapter yet. */
  readonly mediaAcceptance?: MediaAcceptancePort;
  readonly taxonomyAssignments?: ProjectTaxonomyAssignmentFactsPort;
}): ContentAuthoringService {
  const clock = input.clock ?? createSystemClock();
  const ids = input.ids ?? createSystemIdGenerator();
  const actorScope = hashCanonicalRequest({ ownerId: input.scope.ownerId });

  async function executeIdempotently<T>(options: {
    readonly operationScope: string;
    readonly actor: ActorContext;
    readonly key: IdempotencyKey;
    readonly request: unknown;
    readonly effect: (context: TransactionContext) => Promise<SafeResultEnvelope>;
  }): Promise<Result<T, Rejection>> {
    if (!ownerAuthorized(options.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
    const [requestHash, ownerScope] = await Promise.all([
      hashCanonicalRequest(options.request as Parameters<typeof hashCanonicalRequest>[0]),
      actorScope,
    ]);
    const now = clock.now();
    const expiresAt = new Date(Date.parse(now) + IDEMPOTENCY_RETENTION_MS).toISOString();
    const execution = await input.operations.idempotency.execute({
      operationScope: options.operationScope,
      actorScope: ownerScope,
      key: options.key,
      requestHash,
      expiresAt,
    }, options.effect);
    if (execution.kind === "conflict") return err({ kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" });
    return readReceipt<T>(execution.result);
  }

  async function changeContentLifecycle(
    command: ChangeContentLifecycleCommand,
    lifecycle: ChangeContentLifecycleInput["lifecycle"],
    operationScope: string,
    outcome: ContentLifecycleReceipt["outcome"],
    eventType: "content.content_hidden.v1" | "content.content_archived.v1" | "content.content_restored.v1",
  ): Promise<Result<ContentLifecycleReceipt, Rejection>> {
    if (!ownerAuthorized(command.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
    if (!validCorrelation(command.correlationId) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1 ||
        (command.reason !== undefined && !isCleanText(command.reason, 500))) {
      return err({ kind: "validation", code: "INVALID_CONTENT_LIFECYCLE_COMMAND" });
    }
    const effect = async (context: TransactionContext): Promise<SafeResultEnvelope> => {
      const existing = await input.repository.get(command.contentId, input.scope, context);
      if (!existing.ok) return rejectionOutcome(existing.error);
      if (existing.value.aggregateVersion !== command.expectedVersion) {
        return rejectionOutcome({ kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion: existing.value.aggregateVersion });
      }
      if (lifecycle === "hidden" && existing.value.lifecycle !== "published" && existing.value.lifecycle !== "hidden" ||
          lifecycle === "archived" && existing.value.lifecycle !== "draft" && existing.value.lifecycle !== "published" &&
            existing.value.lifecycle !== "hidden" && existing.value.lifecycle !== "archived" ||
          lifecycle === "published" && existing.value.lifecycle !== "hidden" && existing.value.lifecycle !== "archived" &&
            existing.value.lifecycle !== "published") {
        return rejectionOutcome({ kind: "validation", code: "CONTENT_LIFECYCLE_TRANSITION_NOT_ALLOWED" });
      }
      if (lifecycle === "published" && existing.value.lifecycle !== "published") {
        const publications = existing.value.publications ?? [];
        if (publications.length === 0) return rejectionOutcome({ kind: "validation", code: "CONTENT_NOT_PREVIOUSLY_PUBLISHED" });
        for (const publication of publications) {
          const revision = existing.value.revisions.find((entry) => entry.revisionId === publication.revisionId);
          if (revision === undefined || revision.contentId !== existing.value.contentId || revision.contentType !== existing.value.contentType ||
              revision.locale !== publication.locale || revision.payload.locale !== publication.locale ||
              publication.decision !== "accepted" || publication.reviewerId !== input.scope.ownerId ||
              publication.evidenceVersion !== revision.evidenceSnapshotVersion ||
              publication.mediaFactsVersion !== null && !/^[\x21-\x7e]{1,128}$/.test(publication.mediaFactsVersion)) {
            return rejectionOutcome({ kind: "validation", code: "RESTORE_PUBLICATION_SNAPSHOT_INVALID" });
          }
          const snapshotHash = await revisionSnapshotHash(revision);
          if (publication.snapshotHash !== snapshotHash) {
            return rejectionOutcome({ kind: "validation", code: "RESTORE_PUBLICATION_SNAPSHOT_INVALID" });
          }
          const publishable = existing.value.contentType === "project"
            ? publishableProjectPayload(revision.payload)
            : existing.value.contentType === "achievement"
            ? publishableAchievementPayload(revision.payload)
            : publishableTestimonialPayload(revision.payload);
          if (!publishable) return rejectionOutcome({ kind: "validation", code: "RESTORE_PUBLICATION_REQUIREMENTS_NOT_MET" });
          const evidenceArtifacts = revision.payload.contentType === "project" || revision.payload.contentType === "achievement"
            ? revision.payload.evidence?.artifacts ?? []
            : [];
          const mediaAssetIds: StableId<"MediaAsset">[] = [...new Set(evidenceArtifacts
            .flatMap((artifact) => artifact.mediaAssetId === undefined ? [] : [artifact.mediaAssetId]))];
          if (mediaAssetIds.length === 0) {
            if (publication.mediaFactsVersion !== null) return rejectionOutcome({ kind: "validation", code: "RESTORE_PUBLICATION_SNAPSHOT_INVALID" });
            continue;
          }
          if (publication.mediaFactsVersion === null) return rejectionOutcome({ kind: "validation", code: "RESTORE_PUBLICATION_SNAPSHOT_INVALID" });
          if (input.mediaAcceptance === undefined) return rejectionOutcome({ kind: "temporarily_unavailable", code: "MEDIA_ACCEPTANCE_UNAVAILABLE" });
          const facts = await input.mediaAcceptance.getAcceptanceFacts({
            ownerId: input.scope.ownerId,
            mediaAssetIds,
            intendedUse: existing.value.contentType === "project" ? "project-evidence" : "achievement-evidence",
            locale: publication.locale,
          }, context);
          if (!facts.ok) return rejectionOutcome(facts.error);
          const byId = new Map(facts.value.facts.map((fact) => [fact.mediaAssetId, fact]));
          if (!/^[\x21-\x7e]{1,128}$/.test(facts.value.consistencyVersion) || byId.size !== mediaAssetIds.length ||
              facts.value.facts.length !== mediaAssetIds.length || mediaAssetIds.some((id) => {
                const fact = byId.get(id);
                return fact === undefined || fact.ownerId !== input.scope.ownerId || !fact.accepted || !fact.safe ||
                  !fact.suitable || !fact.accessible || !Number.isSafeInteger(fact.version) || fact.version < 1;
              })) return rejectionOutcome({ kind: "validation", code: "MEDIA_ACCEPTANCE_FACTS_INVALID" });
        }
      }
      const changed = await input.repository.changeLifecycle({
        contentId: command.contentId,
        scope: input.scope,
        expectedVersion: command.expectedVersion,
        lifecycle,
        ...(command.reason === undefined ? {} : { reason: command.reason }),
      }, context);
      if (!changed.ok) return rejectionOutcome(changed.error);
      if (changed.value.changed) {
        if (changed.value.changedAt === null) throw new Error("Lifecycle transition omitted its transaction timestamp.");
        await input.operations.outbox.append(context, {
          eventId: ids.generate("DomainEvent"),
          payload: { type: eventType, version: 1, value: { contentId: command.contentId, ownerScope: await actorScope } },
          aggregateId: command.contentId,
          aggregateVersion: changed.value.aggregateVersion,
          correlationId: command.correlationId,
          occurredAt: changed.value.changedAt,
          availableAt: changed.value.changedAt,
        });
      }
      return { status: "completed", receipt: {
        aggregateId: command.contentId,
        aggregateVersion: changed.value.aggregateVersion,
        outcome,
      } };
    };
    return await executeIdempotently<ContentLifecycleReceipt>({
      operationScope,
      actor: command.actor,
      key: command.idempotencyKey,
      request: { contentId: command.contentId, expectedVersion: command.expectedVersion, reason: command.reason ?? null },
      effect,
    });
  }

  return {
    async getPublicProjectMediaUse(query, transaction) {
      if (transaction?.kind !== "transaction") return err({ kind: "validation", code: "CONTENT_TRANSACTION_REQUIRED" });
      if (!parseStableId("MediaAsset", query.mediaAssetId).ok || !["en", "ar"].includes(query.locale)) {
        return err({ kind: "validation", code: "CONTENT_MEDIA_USE_QUERY_INVALID" });
      }
      return input.repository.getPublicProjectMediaUse({ ...query, scope: input.scope }, transaction);
    },

    async getVisibleMediaUsage(query, transaction) {
      if (query.ownerId !== input.scope.ownerId) return err({ kind: "forbidden", code: "OWNER_SCOPE_MISMATCH" });
      if (transaction?.kind !== "transaction") return err({ kind: "validation", code: "CONTENT_TRANSACTION_REQUIRED" });
      const mediaAssetIds = [...new Set(query.mediaAssetIds)];
      if (mediaAssetIds.length > 100 || mediaAssetIds.some((mediaAssetId) =>
        typeof mediaAssetId !== "string" || !parseStableId("MediaAsset", mediaAssetId).ok)) {
        return err({ kind: "validation", code: "CONTENT_MEDIA_USAGE_QUERY_INVALID" });
      }
      return input.repository.getVisibleMediaUsage({ mediaAssetIds: mediaAssetIds.sort(), scope: input.scope }, transaction);
    },

    async createContent(command) {
      if (!ownerAuthorized(command.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      if (!validCorrelation(command.correlationId) || !payloadIsValid(command.payload)) {
        return err({ kind: "validation", code: "INVALID_CONTENT_DRAFT" });
      }
      const contentId = parseStableId("Content", ids.generate("Content"));
      const revisionId = parseStableId("Revision", ids.generate("Revision"));
      if (!contentId.ok || !revisionId.ok) throw new Error("Stable ID generator returned an invalid identity.");
      const prepared = snapshotPayload(command.payload);
      const payload: CreateDraftPayload = prepared.contentType === "project"
        ? { ...prepared, candidateSlug: prepared.candidateSlug ?? candidateFromTitle(prepared.title, contentId.value) }
        : prepared;
      const candidateSlug = payload.contentType === "project" ? payload.candidateSlug ?? null : null;
      const savedAt = clock.now();
      const effect = async (context: TransactionContext): Promise<SafeResultEnvelope> => {
        if (payload.contentType === "testimonial" && payload.association?.type === "project" &&
            !await input.repository.projectExists(payload.association.projectId, input.scope, context)) {
          return rejectionOutcome({ kind: "validation", code: "RELATED_PROJECT_UNAVAILABLE" });
        }
        const created = await input.repository.create({
          contentId: contentId.value,
          revisionId: revisionId.value,
          portfolioId: input.scope.portfolioId,
          ownerId: input.scope.ownerId,
          candidateSlug,
          payload,
          savedAt,
        }, context);
        if (!created.ok) return rejectionOutcome(created.error);
        const receipt: CreateContentReceipt = {
          contentId: contentId.value,
          aggregateVersion: created.value.aggregateVersion,
          revisionId: revisionId.value,
          outcome: "content-created",
        };
        const ownerHash = await actorScope;
        for (const [type, eventId] of [
          ["content.created.v1", ids.generate("DomainEvent")],
          ["content.revision_saved.v1", ids.generate("DomainEvent")],
        ] as const) {
          await input.operations.outbox.append(context, {
            eventId,
            payload: {
              type,
              version: 1,
              value: { contentId: contentId.value, revisionId: revisionId.value, contentType: payload.contentType, locale: payload.locale, ownerScope: ownerHash },
            },
            aggregateId: contentId.value,
            aggregateVersion: 1,
            correlationId: command.correlationId,
            occurredAt: savedAt,
            availableAt: savedAt,
          });
        }
        return { status: "completed", receipt: {
          contentId: receipt.contentId,
          aggregateVersion: receipt.aggregateVersion,
          revisionId: receipt.revisionId,
          outcome: receipt.outcome,
        } };
      };
      const execution = await executeIdempotently<CreateContentReceipt>({
        operationScope: CREATE_SCOPE,
        actor: command.actor,
        key: command.idempotencyKey as IdempotencyKey,
        request: command.payload,
        effect,
      });
      return execution;
    },

    async getOwnerContentAggregate(query) {
      if (!ownerAuthorized(query.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      return await input.operations.transactions.run(async (context) => {
        const result = await input.repository.get(query.contentId, input.scope, context, 100);
        return result.ok ? { ok: true as const, value: view(result.value) } : result;
      });
    },

    async saveRevision(command) {
      if (!ownerAuthorized(command.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      if (!validCorrelation(command.correlationId) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1 ||
          !isCleanText(command.title, 160) || !isCleanText(command.summary, 500) || !isCleanText(command.body, 50_000) ||
          (command.locale !== "en" && command.locale !== "ar")) {
        return err({ kind: "validation", code: "INVALID_CONTENT_REVISION" });
      }
      const revisionId = parseStableId("Revision", ids.generate("Revision"));
      if (!revisionId.ok) throw new Error("Stable ID generator returned an invalid revision identity.");
      const savedAt = clock.now();
      const effect = async (context: TransactionContext): Promise<SafeResultEnvelope> => {
        const existing = await input.repository.get(command.contentId, input.scope, context);
        if (!existing.ok) return rejectionOutcome(existing.error);
        if (command.draftData !== undefined && !draftDataHasOnlyExpectedKeys(command.draftData)) {
          return rejectionOutcome({ kind: "validation", code: "INVALID_CONTENT_DRAFT" });
        }
        if (command.draftData !== undefined && command.draftData.contentType !== existing.value.contentType) {
          return rejectionOutcome({ kind: "validation", code: "CONTENT_DRAFT_TYPE_MISMATCH" });
        }
        if (existing.value.aggregateVersion !== command.expectedVersion) {
          return rejectionOutcome({ kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion: existing.value.aggregateVersion });
        }
        const orderedRevisions = [...existing.value.revisions].reverse();
        const previous = orderedRevisions.find((revision) => revision.locale === command.locale) ?? orderedRevisions[0];
        const draftData = command.draftData;
        let payload: CreateDraftPayload;
        const common = { locale: command.locale, title: command.title, summary: command.summary, body: command.body };
        if (existing.value.contentType === "project") {
          const prior = previous?.payload.contentType === "project" ? previous.payload : undefined;
          const projectData = draftData?.contentType === "project" ? draftData : undefined;
          const caseStudy = projectData?.caseStudy ?? prior?.caseStudy;
          const evidence = projectData?.evidence ?? prior?.evidence;
          const externalLinks = projectData?.externalLinks ?? prior?.externalLinks;
          payload = { contentType: "project", ...(existing.value.candidateSlug === null ? {} : { candidateSlug: existing.value.candidateSlug }), ...common,
            ...(caseStudy === undefined ? {} : { caseStudy }), ...(evidence === undefined ? {} : { evidence }),
            ...(externalLinks === undefined ? {} : { externalLinks }) };
        } else if (existing.value.contentType === "achievement") {
          const prior = previous?.payload.contentType === "achievement" ? previous.payload : undefined;
          const achievedOn = draftData?.contentType === "achievement" ? draftData.achievedOn : prior?.achievedOn;
          const evidence = draftData?.contentType === "achievement" ? draftData.evidence : prior?.evidence;
          payload = { contentType: "achievement", ...common, ...(achievedOn === undefined ? {} : { achievedOn }), ...(evidence === undefined ? {} : { evidence }) };
        } else {
          const prior = previous?.payload.contentType === "testimonial" ? previous.payload : undefined;
          const authorName = draftData?.contentType === "testimonial" ? draftData.authorName : prior?.authorName;
          const quote = draftData?.contentType === "testimonial" ? draftData.quote : prior?.quote;
          const explicitAssociation = draftData?.contentType === "testimonial" ? draftData.association : undefined;
          const legacyRelatedProjectId = draftData?.contentType === "testimonial" ? draftData.relatedProjectId : undefined;
          const association = explicitAssociation ?? (legacyRelatedProjectId === undefined
            ? prior?.association ?? (prior?.relatedProjectId === undefined ? undefined : { type: "project" as const, projectId: prior.relatedProjectId })
            : { type: "project" as const, projectId: legacyRelatedProjectId });
          payload = snapshotPayload({ contentType: "testimonial", ...common, ...(authorName === undefined ? {} : { authorName }),
            ...(quote === undefined ? {} : { quote }), ...(association === undefined ? {} : { association }) });
          if (association?.type === "project" && !await input.repository.projectExists(association.projectId, input.scope, context)) {
            return rejectionOutcome({ kind: "validation", code: "RELATED_PROJECT_UNAVAILABLE" });
          }
        }
        if (!payloadIsValid(payload)) return rejectionOutcome({ kind: "validation", code: "INVALID_CONTENT_DRAFT" });
        const appended = await input.repository.appendRevision({
          contentId: command.contentId,
          scope: input.scope,
          revisionId: revisionId.value,
          expectedVersion: command.expectedVersion,
          payload,
          savedAt,
        }, context);
        if (!appended.ok) return rejectionOutcome(appended.error);
        const receipt: SaveContentRevisionReceipt = {
          aggregateId: command.contentId,
          aggregateVersion: appended.value.record.aggregateVersion,
          outcome: "revision-saved",
          revisionId: revisionId.value,
        };
        await input.operations.outbox.append(context, {
          eventId: ids.generate("DomainEvent"),
          payload: { type: "content.revision_saved.v1", version: 1, value: { contentId: command.contentId, revisionId: revisionId.value, locale: command.locale, ownerScope: await actorScope } },
          aggregateId: command.contentId,
          aggregateVersion: appended.value.record.aggregateVersion,
          correlationId: command.correlationId,
          occurredAt: savedAt,
          availableAt: savedAt,
        });
        return { status: "completed", receipt: {
          aggregateId: receipt.aggregateId,
          aggregateVersion: receipt.aggregateVersion,
          outcome: receipt.outcome,
          revisionId: receipt.revisionId,
        } };
      };
      return await executeIdempotently<SaveContentRevisionReceipt>({
        operationScope: SAVE_SCOPE,
        actor: command.actor,
        key: command.idempotencyKey,
        request: { contentId: command.contentId, expectedVersion: command.expectedVersion, locale: command.locale, title: command.title, summary: command.summary, body: command.body, draftData: command.draftData ?? null },
        effect,
      });
    },

    async previewRevision(query) {
      if (!ownerAuthorized(query.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      return await input.operations.transactions.run(async (context) => {
        const record = await input.repository.get(query.contentId, input.scope, context);
        if (!record.ok) return record;
        const revision = record.value.revisions.find((entry) => entry.revisionId === query.revisionId);
        if (revision === undefined) return err({ kind: "not_found", code: "REVISION_NOT_FOUND" });
        const snapshotHash = await revisionSnapshotHash(revision);
        const latest = revision.latestReview;
        if (latest !== undefined &&
            (latest.snapshotHash !== snapshotHash || latest.evidenceVersion !== revision.evidenceSnapshotVersion)) {
          return err({ kind: "temporarily_unavailable", code: "CONTENT_REVIEW_INTEGRITY_FAILED" });
        }
        return {
          ok: true as const,
          value: {
            contentId: revision.contentId,
            revisionId: revision.revisionId,
            locale: revision.locale,
            sequence: revision.sequence,
            title: revision.title,
            summary: revision.summary,
            body: revision.body,
            snapshotHash,
            evidenceVersion: revision.evidenceSnapshotVersion,
            review: latest === undefined ? null : {
              reviewId: latest.reviewId,
              decision: latest.decision,
              findings: latest.findings,
              reviewedAt: latest.reviewedAt,
              snapshotHash: latest.snapshotHash,
              evidenceVersion: latest.evidenceVersion,
            },
          },
        };
      });
    },

    async reviewRevision(command) {
      if (!ownerAuthorized(command.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      if (!validCorrelation(command.correlationId) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1 ||
          (command.locale !== "en" && command.locale !== "ar") || !/^[0-9a-f]{64}$/.test(command.snapshotHash) ||
          !Number.isSafeInteger(command.evidenceVersion) || command.evidenceVersion < 1 ||
          (command.decision !== "accepted" && command.decision !== "rejected") || !Array.isArray(command.findings) ||
          command.findings.length > 100 || !command.findings.every((finding) => isCleanText(finding, 1_000))) {
        return err({ kind: "validation", code: "INVALID_REVISION_REVIEW" });
      }
      const reviewId = parseStableId("ContentReview", ids.generate("ContentReview"));
      if (!reviewId.ok) throw new Error("Stable ID generator returned an invalid review identity.");
      const reviewedAt = clock.now();
      const effect = async (context: TransactionContext): Promise<SafeResultEnvelope> => {
        const existing = await input.repository.get(command.contentId, input.scope, context);
        if (!existing.ok) return rejectionOutcome(existing.error);
        if (existing.value.aggregateVersion !== command.expectedVersion) {
          return rejectionOutcome({ kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion: existing.value.aggregateVersion });
        }
        const revision = existing.value.revisions.find((entry) => entry.revisionId === command.revisionId);
        if (revision === undefined) return rejectionOutcome({ kind: "not_found", code: "REVISION_NOT_FOUND" });
        if (revision.locale !== command.locale) return rejectionOutcome({ kind: "validation", code: "REVISION_LOCALE_MISMATCH" });
        const actualHash = await revisionSnapshotHash(revision);
        if (actualHash !== command.snapshotHash || revision.evidenceSnapshotVersion !== command.evidenceVersion) {
          return rejectionOutcome({ kind: "conflict", code: "REVISION_SNAPSHOT_MISMATCH" });
        }
        const appended = await input.repository.appendReview({
          contentId: command.contentId,
          scope: input.scope,
          revisionId: command.revisionId,
          locale: command.locale,
          expectedVersion: command.expectedVersion,
          reviewId: reviewId.value,
          snapshotHash: actualHash,
          evidenceVersion: revision.evidenceSnapshotVersion,
          reviewerId: input.scope.ownerId,
          decision: command.decision,
          findings: command.findings,
          reviewedAt,
        }, context);
        if (!appended.ok) return rejectionOutcome(appended.error);
        const receipt: ReviewRevisionReceipt = {
          aggregateId: command.contentId,
          aggregateVersion: appended.value.aggregateVersion,
          outcome: "revision-reviewed",
          revisionId: command.revisionId,
          reviewId: reviewId.value,
        };
        await input.operations.outbox.append(context, {
          eventId: ids.generate("DomainEvent"),
          payload: { type: "content.revision_reviewed.v1", version: 1, value: {
            contentId: command.contentId,
            revisionId: command.revisionId,
            reviewId: reviewId.value,
            locale: command.locale,
            decision: command.decision,
            ownerScope: await actorScope,
          } },
          aggregateId: command.contentId,
          aggregateVersion: appended.value.aggregateVersion,
          correlationId: command.correlationId,
          occurredAt: reviewedAt,
          availableAt: reviewedAt,
        });
        return { status: "completed", receipt: {
          aggregateId: receipt.aggregateId,
          aggregateVersion: receipt.aggregateVersion,
          outcome: receipt.outcome,
          revisionId: receipt.revisionId,
          reviewId: receipt.reviewId,
        } };
      };
      return await executeIdempotently<ReviewRevisionReceipt>({
        operationScope: REVIEW_SCOPE,
        actor: command.actor,
        key: command.idempotencyKey as IdempotencyKey,
        request: {
          contentId: command.contentId,
          revisionId: command.revisionId,
          expectedVersion: command.expectedVersion,
          locale: command.locale,
          snapshotHash: command.snapshotHash,
          evidenceVersion: command.evidenceVersion,
          decision: command.decision,
          findings: command.findings,
        },
        effect,
      });
    },

    async publishLanguageVersion(command) {
      if (!ownerAuthorized(command.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      if (!validCorrelation(command.correlationId) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1 ||
          (command.locale !== "en" && command.locale !== "ar") || !parseStableId("Revision", command.revisionId).ok) {
        return err({ kind: "validation", code: "INVALID_CONTENT_PUBLICATION" });
      }
      const publishedAt = clock.now();
      const effect = async (context: TransactionContext): Promise<SafeResultEnvelope> => {
        const existing = await input.repository.get(command.contentId, input.scope, context);
        if (!existing.ok) return rejectionOutcome(existing.error);
        if (existing.value.aggregateVersion !== command.expectedVersion) {
          return rejectionOutcome({ kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion: existing.value.aggregateVersion });
        }
        if (existing.value.contentType !== "project" && existing.value.contentType !== "achievement" && existing.value.contentType !== "testimonial") return rejectionOutcome({ kind: "validation", code: "CONTENT_TYPE_NOT_PUBLISHABLE" });
        const explicitFirstPublishFromArchive = existing.value.lifecycle === "archived" && (existing.value.publications ?? []).length === 0;
        if (existing.value.lifecycle !== "draft" && existing.value.lifecycle !== "published" && !explicitFirstPublishFromArchive) {
          return rejectionOutcome({ kind: "validation", code: "CONTENT_LIFECYCLE_NOT_PUBLISHABLE" });
        }
        const revision = existing.value.revisions.find((entry) => entry.revisionId === command.revisionId);
        if (revision === undefined) return rejectionOutcome({ kind: "not_found", code: "REVISION_NOT_FOUND" });
        if (revision.locale !== command.locale) return rejectionOutcome({ kind: "validation", code: "REVISION_LOCALE_MISMATCH" });
        if (existing.value.contentType === "testimonial") {
          if (!publishableTestimonialPayload(revision.payload)) {
            return rejectionOutcome({ kind: "validation", code: "TESTIMONIAL_PUBLICATION_REQUIREMENTS_NOT_MET" });
          }
          const snapshotHash = await revisionSnapshotHash(revision);
          const review = revision.latestReview;
          if (review === undefined || review.decision !== "accepted" || review.revisionId !== revision.revisionId ||
              review.contentId !== revision.contentId || review.contentType !== "testimonial" || review.locale !== command.locale ||
              review.reviewerId !== input.scope.ownerId || review.snapshotHash !== snapshotHash ||
              review.evidenceVersion !== revision.evidenceSnapshotVersion) {
            return rejectionOutcome({ kind: "validation", code: "ACCEPTED_REVISION_REVIEW_REQUIRED" });
          }
          const published = await input.repository.publishTestimonialLanguage({
            contentId: command.contentId,
            scope: input.scope,
            expectedVersion: command.expectedVersion,
            locale: command.locale,
            revisionId: revision.revisionId,
            reviewId: review.reviewId,
            snapshotHash,
            payload: revision.payload,
          }, context);
          if (!published.ok) return rejectionOutcome(published.error);
          const ownerHash = await actorScope;
          await input.operations.outbox.append(context, {
            eventId: ids.generate("DomainEvent"),
            payload: { type: "content.testimonial_language_version_published.v1", version: 1, value: {
              contentId: command.contentId,
              locale: command.locale,
              revisionId: revision.revisionId,
              ownerScope: ownerHash,
            } },
            aggregateId: command.contentId,
            aggregateVersion: published.value.aggregateVersion,
            correlationId: command.correlationId,
            occurredAt: published.value.publishedAt,
            availableAt: published.value.publishedAt,
          });
          return { status: "completed", receipt: {
            aggregateId: command.contentId,
            aggregateVersion: published.value.aggregateVersion,
            outcome: "language-published",
            revisionId: published.value.revisionId,
            locale: published.value.locale,
            firstPublishedAt: published.value.firstPublishedAt,
            publishedAt: published.value.publishedAt,
          } };
        }
        if (existing.value.contentType !== "project" && existing.value.contentType !== "achievement") return rejectionOutcome({ kind: "validation", code: "CONTENT_TYPE_NOT_PUBLISHABLE" });
        if (existing.value.contentType === "project" && !publishableProjectPayload(revision.payload) ||
            existing.value.contentType === "achievement" && !publishableAchievementPayload(revision.payload)) {
          return rejectionOutcome({ kind: "validation", code: existing.value.contentType === "project" ? "PROJECT_PUBLICATION_REQUIREMENTS_NOT_MET" : "ACHIEVEMENT_PUBLICATION_REQUIREMENTS_NOT_MET" });
        }
        const snapshotHash = await revisionSnapshotHash(revision);
        const review = revision.latestReview;
        if (review === undefined || review.decision !== "accepted" || review.revisionId !== revision.revisionId ||
            review.contentId !== revision.contentId || review.contentType !== existing.value.contentType || review.locale !== command.locale ||
            review.reviewerId !== input.scope.ownerId || review.snapshotHash !== snapshotHash ||
            review.evidenceVersion !== revision.evidenceSnapshotVersion) {
          return rejectionOutcome({ kind: "validation", code: "ACCEPTED_REVISION_REVIEW_REQUIRED" });
        }
        const evidenceArtifacts = revision.payload.contentType === "project" || revision.payload.contentType === "achievement"
          ? revision.payload.evidence?.artifacts ?? []
          : [];
        const mediaAssetIds: StableId<"MediaAsset">[] = [...new Set(evidenceArtifacts
          .flatMap((artifact) => artifact.mediaAssetId === undefined ? [] : [artifact.mediaAssetId]))];
        let mediaFactsVersion: string | null = null;
        if (mediaAssetIds.length > 0) {
          if (input.mediaAcceptance === undefined) return rejectionOutcome({ kind: "temporarily_unavailable", code: "MEDIA_ACCEPTANCE_UNAVAILABLE" });
          const facts = await input.mediaAcceptance.getAcceptanceFacts({
            ownerId: input.scope.ownerId,
            mediaAssetIds,
            intendedUse: existing.value.contentType === "project" ? "project-evidence" : "achievement-evidence",
            locale: command.locale,
          }, context);
          if (!facts.ok) return rejectionOutcome(facts.error);
          const byId = new Map(facts.value.facts.map((fact) => [fact.mediaAssetId, fact]));
          if (!/^[\x21-\x7e]{1,128}$/.test(facts.value.consistencyVersion) || byId.size !== mediaAssetIds.length ||
              facts.value.facts.length !== mediaAssetIds.length || mediaAssetIds.some((id) => {
                const fact = byId.get(id);
                return fact === undefined || fact.ownerId !== input.scope.ownerId || !fact.accepted || !fact.safe || !fact.suitable || !fact.accessible ||
                  !Number.isSafeInteger(fact.version) || fact.version < 1;
              })) return rejectionOutcome({ kind: "validation", code: "MEDIA_ACCEPTANCE_FACTS_INVALID" });
          mediaFactsVersion = facts.value.consistencyVersion;
        }
        const published = existing.value.contentType === "project"
          ? await (() => {
            const routeIdentity = parseStableId("PublicRoute", ids.generate("PublicRoute"));
            if (!routeIdentity.ok) throw new Error("Stable ID generator returned an invalid public route identity.");
            return input.repository.publishProjectLanguage({
          contentId: command.contentId,
          scope: input.scope,
          expectedVersion: command.expectedVersion,
          locale: command.locale,
          revisionId: revision.revisionId,
          reviewId: review.reviewId,
          snapshotHash,
          routeIdentity: routeIdentity.value,
          publishedAt,
          payload: revision.payload as Extract<CreateDraftPayload, { contentType: "project" }>,
          mediaFactsVersion,
            }, context);
          })()
          : await input.repository.publishAchievementLanguage({
            contentId: command.contentId,
            scope: input.scope,
            expectedVersion: command.expectedVersion,
            locale: command.locale,
            revisionId: revision.revisionId,
            reviewId: review.reviewId,
            snapshotHash,
            publishedAt,
            payload: revision.payload as Extract<CreateDraftPayload, { contentType: "achievement" }>,
            mediaFactsVersion,
          }, context);
        if (!published.ok) return rejectionOutcome(published.error);
        if (existing.value.contentType === "project") {
          const projectPublication = published.value as PublishProjectLanguageResult;
          await input.discoveryProjection.writePublishedProjectLocale({
            contentId: command.contentId as StableId<"Project">,
            portfolioId: input.scope.portfolioId,
            ownerId: input.scope.ownerId,
            locale: command.locale,
            revisionId: projectPublication.revisionId,
            routeIdentity: projectPublication.routeIdentity,
            title: revision.title,
            slug: projectPublication.currentSlug,
            firstPublishedAt: projectPublication.firstPublishedAt,
            publishedAt: projectPublication.publishedAt,
          }, context);
        }
        const publication = published.value;
        const projectPublication = existing.value.contentType === "project" ? publication as PublishProjectLanguageResult : undefined;
        const ownerHash = await actorScope;
        await input.operations.outbox.append(context, {
          eventId: ids.generate("DomainEvent"),
          payload: { type: "content.language_version_published.v1", version: 1, value: {
            contentId: command.contentId,
            locale: command.locale,
            revisionId: revision.revisionId,
            ...(projectPublication === undefined ? {} : { slug: projectPublication.currentSlug, routeIdentity: projectPublication.routeIdentity }),
            ownerScope: ownerHash,
          } },
          aggregateId: command.contentId,
          aggregateVersion: published.value.aggregateVersion,
          correlationId: command.correlationId,
          occurredAt: publication.publishedAt,
          availableAt: publication.publishedAt,
        });
        return { status: "completed", receipt: {
          aggregateId: command.contentId,
          aggregateVersion: publication.aggregateVersion,
          outcome: "language-published",
          revisionId: publication.revisionId,
          locale: publication.locale,
          currentSlug: projectPublication?.currentSlug ?? null,
          routeIdentity: projectPublication?.routeIdentity ?? null,
          firstPublishedAt: publication.firstPublishedAt,
          publishedAt: publication.publishedAt,
        } };
      };
      return await executeIdempotently<ContentAuthoringPublicationReceipt>({
        operationScope: PUBLISH_SCOPE,
        actor: command.actor,
        key: command.idempotencyKey as IdempotencyKey,
        request: { contentId: command.contentId, expectedVersion: command.expectedVersion, locale: command.locale, revisionId: command.revisionId },
        effect,
      });
    },

    async correctCandidateSlug(command) {
      if (!ownerAuthorized(command.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      if (!validCorrelation(command.correlationId) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1 ||
          !parseStableId("Project", command.projectId).ok || !SLUG_PATTERN.test(command.candidateSlug) || command.candidateSlug.length > 120) {
        return err({ kind: "validation", code: "INVALID_PROJECT_CANDIDATE_SLUG" });
      }
      const effect = async (context: TransactionContext): Promise<SafeResultEnvelope> => {
        const existing = await input.repository.get(command.projectId, input.scope, context);
        if (!existing.ok) return rejectionOutcome(existing.error);
        if (existing.value.contentType !== "project") return rejectionOutcome({ kind: "validation", code: "CONTENT_TYPE_NOT_PROJECT" });
        if (existing.value.publicRoute !== null && existing.value.publicRoute !== undefined ||
            existing.value.lifecycle !== "draft" && existing.value.lifecycle !== "archived") {
          return rejectionOutcome({ kind: "validation", code: "PROJECT_CANDIDATE_SLUG_NOT_EDITABLE" });
        }
        if (existing.value.aggregateVersion !== command.expectedVersion) {
          return rejectionOutcome({ kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion: existing.value.aggregateVersion });
        }
        const changed = await input.repository.correctCandidateSlug({
          contentId: command.projectId, scope: input.scope, expectedVersion: command.expectedVersion, slug: command.candidateSlug,
        }, context);
        if (!changed.ok) return rejectionOutcome(changed.error);
        const receipt: OwnerContentRouteChangeReceipt = {
          aggregateId: command.projectId, aggregateVersion: changed.value.aggregateVersion,
          outcome: "candidate-slug-corrected", slug: command.candidateSlug,
        };
        const eventTime = clock.now();
        await input.operations.outbox.append(context, {
          eventId: ids.generate("DomainEvent"),
          payload: { type: "content.project_candidate_slug_corrected.v1", version: 1, value: {
            contentId: command.projectId, slug: command.candidateSlug, ownerScope: await actorScope,
          } },
          aggregateId: command.projectId, aggregateVersion: receipt.aggregateVersion,
          correlationId: command.correlationId, occurredAt: eventTime, availableAt: eventTime,
        });
        return { status: "completed", receipt: { aggregateId: receipt.aggregateId, aggregateVersion: receipt.aggregateVersion, outcome: receipt.outcome, slug: receipt.slug } };
      };
      return await executeIdempotently<OwnerContentRouteChangeReceipt>({
        operationScope: CANDIDATE_SLUG_SCOPE, actor: command.actor, key: command.idempotencyKey as IdempotencyKey,
        request: { projectId: command.projectId, expectedVersion: command.expectedVersion, candidateSlug: command.candidateSlug }, effect,
      });
    },

    async changePublicSlug(command) {
      if (!ownerAuthorized(command.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      if (!validCorrelation(command.correlationId) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1 ||
          !parseStableId("Project", command.projectId).ok || !SLUG_PATTERN.test(command.newSlug) || command.newSlug.length > 120) {
        return err({ kind: "validation", code: "INVALID_PUBLIC_PROJECT_SLUG" });
      }
      const effect = async (context: TransactionContext): Promise<SafeResultEnvelope> => {
        const existing = await input.repository.get(command.projectId, input.scope, context);
        if (!existing.ok) return rejectionOutcome(existing.error);
        if (existing.value.contentType !== "project") return rejectionOutcome({ kind: "validation", code: "CONTENT_TYPE_NOT_PROJECT" });
        if (existing.value.aggregateVersion !== command.expectedVersion) {
          return rejectionOutcome({ kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion: existing.value.aggregateVersion });
        }
        if (existing.value.publicRoute == null) return rejectionOutcome({ kind: "validation", code: "PROJECT_PUBLIC_ROUTE_REQUIRED" });
        const changed = await input.repository.changePublicSlug({
          contentId: command.projectId, scope: input.scope, expectedVersion: command.expectedVersion, slug: command.newSlug,
        }, context);
        if (!changed.ok) return rejectionOutcome(changed.error);
        await input.discoveryProjection.updateProjectRouteSlug({
          contentId: command.projectId,
          routeIdentity: changed.value.routeIdentity,
          slug: command.newSlug,
          expectedLocales: (existing.value.publications ?? []).map((publication) => publication.locale),
        }, context);
        const receipt: OwnerContentRouteChangeReceipt = {
          aggregateId: command.projectId, aggregateVersion: changed.value.aggregateVersion,
          outcome: "public-slug-changed", slug: command.newSlug,
        };
        const eventTime = clock.now();
        await input.operations.outbox.append(context, {
          eventId: ids.generate("DomainEvent"),
          payload: { type: "content.public_route_changed.v1", version: 1, value: {
            routeIdentity: changed.value.routeIdentity,
            previousSlug: changed.value.previousSlug, newSlug: command.newSlug, ownerScope: await actorScope,
          } },
          aggregateId: command.projectId, aggregateVersion: receipt.aggregateVersion,
          correlationId: command.correlationId, occurredAt: eventTime, availableAt: eventTime,
        });
        return { status: "completed", receipt: { aggregateId: receipt.aggregateId, aggregateVersion: receipt.aggregateVersion, outcome: receipt.outcome, slug: receipt.slug } };
      };
      return await executeIdempotently<OwnerContentRouteChangeReceipt>({
        operationScope: PUBLIC_SLUG_SCOPE, actor: command.actor, key: command.idempotencyKey as IdempotencyKey,
        request: { projectId: command.projectId, expectedVersion: command.expectedVersion, slug: command.newSlug }, effect,
      });
    },

    async relateProjects(command) {
      if (!ownerAuthorized(command.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      if (!validCorrelation(command.correlationId) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1 ||
          !parseStableId("Project", command.projectId).ok || !parseStableId("Project", command.relatedProjectId).ok ||
          command.projectId === command.relatedProjectId) {
        return err({ kind: "validation", code: "INVALID_PROJECT_RELATIONSHIP_COMMAND" });
      }
      const effect = async (context: TransactionContext): Promise<SafeResultEnvelope> => {
        const related = await input.repository.relateProjects({
          projectId: command.projectId,
          relatedProjectId: command.relatedProjectId,
          scope: input.scope,
          expectedVersion: command.expectedVersion,
        }, context);
        if (!related.ok) return rejectionOutcome(related.error);
        const ownerHash = await actorScope;
        await input.operations.outbox.append(context, {
          eventId: ids.generate("DomainEvent"),
          payload: { type: "content.projects_related.v1", version: 1, value: {
            projectId: command.projectId,
            relatedProjectId: command.relatedProjectId,
            ownerScope: ownerHash,
          } },
          aggregateId: command.projectId,
          aggregateVersion: related.value.projectAggregateVersion,
          correlationId: command.correlationId,
          occurredAt: related.value.relatedAt,
          availableAt: related.value.relatedAt,
        });
        return { status: "completed", receipt: {
          aggregateId: command.projectId,
          aggregateVersion: related.value.projectAggregateVersion,
          relatedProjectAggregateVersion: related.value.relatedProjectAggregateVersion,
          outcome: "project-related",
        } };
      };
      return await executeIdempotently<RelateProjectsReceipt>({
        operationScope: RELATE_PROJECTS_SCOPE,
        actor: command.actor,
        key: command.idempotencyKey,
        request: { projectId: command.projectId, relatedProjectId: command.relatedProjectId, expectedVersion: command.expectedVersion },
        effect,
      });
    },

    async getOwnerProjectRelationships(query) {
      if (!ownerAuthorized(query.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      if (!parseStableId("Project", query.projectId).ok) return err({ kind: "validation", code: "INVALID_PROJECT_RELATIONSHIP_QUERY" });
      return await input.operations.transactions.run((context) => input.repository.getOwnerProjectRelationships({
        projectId: query.projectId,
        scope: input.scope,
      }, context));
    },

    async getPublicRelatedProjects(query) {
      const limit = query.limit ?? 10;
      if (!parseStableId("Project", query.projectId).ok || (query.locale !== "en" && query.locale !== "ar") ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return err({ kind: "validation", code: "INVALID_PUBLIC_RELATED_PROJECTS_QUERY" });
      }
      return await input.operations.transactions.run((context) => input.repository.getPublicRelatedProjects({
        projectId: query.projectId,
        locale: query.locale,
        limit,
        scope: input.scope,
      }, context));
    },

    async hideContent(command) {
      return await changeContentLifecycle(
        command, "hidden", "content-publishing.hide-owner-content", "content-hidden", "content.content_hidden.v1",
      );
    },

    async archiveContent(command) {
      return await changeContentLifecycle(
        command, "archived", "content-publishing.archive-owner-content", "content-archived", "content.content_archived.v1",
      );
    },

    async restoreContent(command) {
      return await changeContentLifecycle(
        command, "published", "content-publishing.restore-owner-content", "content-restored", "content.content_restored.v1",
      );
    },

    async getPublicProject(query) {
      if (query.locale !== "en" && query.locale !== "ar" || !SLUG_PATTERN.test(query.slug)) {
        return err({ kind: "validation", code: "INVALID_PUBLIC_CONTENT_QUERY" });
      }
      return await input.operations.transactions.run((context) => input.repository.getPublicProjectBySlug({
        slug: query.slug,
        locale: query.locale,
        scope: input.scope,
      }, context));
    },

    async resolvePublicProjectRoute(query) {
      const result = await this.getPublicProject(query);
      if (!result.ok) return result;
      if (result.value.currentSlug === query.slug) return { ok: true, value: { type: "canonical", content: result.value } };
      return { ok: true, value: {
        type: "redirect", statusCode: 308, contentId: result.value.contentId,
        routeIdentity: result.value.routeIdentity, locale: result.value.locale,
        fromSlug: query.slug, toSlug: result.value.currentSlug,
        location: `/projects/${encodeURIComponent(result.value.currentSlug)}`,
      } };
    },

    async getPublicTestimonials(query) {
      if ((query.locale !== "en" && query.locale !== "ar") ||
          (query.association.type === "project" && !parseStableId("Project", query.association.projectId).ok)) {
        return err({ kind: "validation", code: "INVALID_PUBLIC_TESTIMONIAL_QUERY" });
      }
      return await input.operations.transactions.run((context) => input.repository.getPublicTestimonials({
        scope: input.scope,
        locale: query.locale,
        association: query.association,
      }, context));
    },
    async getPublicAchievementTimeline(query) {
      if ((query.locale !== "en" && query.locale !== "ar") || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100) {
        return err({ kind: "validation", code: "INVALID_ACHIEVEMENT_TIMELINE_QUERY" });
      }
      return await input.operations.transactions.run((context) => input.repository.getPublicAchievementTimeline({
        locale: query.locale,
        limit: query.limit,
        scope: input.scope,
      }, context));
    },

    async getContentHistory(query) {
      if (!ownerAuthorized(query.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 100 ||
          (query.locale !== undefined && query.locale !== "en" && query.locale !== "ar")) {
        return err({ kind: "validation", code: "INVALID_CONTENT_HISTORY_QUERY" });
      }
      let after: { locale: SupportedLocale; sequence: number } | undefined;
      if (query.cursor !== undefined) {
        const match = /^(en|ar):([1-9][0-9]*)$/.exec(query.cursor);
        if (match === null || !Number.isSafeInteger(Number(match[2]))) return err({ kind: "validation", code: "INVALID_CONTENT_HISTORY_CURSOR" });
        after = { locale: match[1] as SupportedLocale, sequence: Number(match[2]) };
      }
      return await input.operations.transactions.run(async (context) => {
        if (after !== undefined && query.locale !== undefined && after.locale !== query.locale) {
          return err({ kind: "validation", code: "CONTENT_HISTORY_CURSOR_SCOPE_MISMATCH" });
        }
        const listed = await input.repository.listHistory({
          contentId: query.contentId,
          scope: input.scope,
          ...(query.locale === undefined ? {} : { locale: query.locale }),
          ...(after === undefined ? {} : { after }),
          limit: query.limit,
        }, context);
        if (!listed.ok) return listed;
        const aggregate = await input.repository.get(query.contentId, input.scope, context);
        if (!aggregate.ok) return aggregate;
        const entries = listed.value.entries;
        const last = entries.at(-1);
        return { ok: true as const, value: {
          entries,
          routeHistory: aggregate.value.publicRoute?.history ?? [],
          nextCursor: listed.value.hasMore && last !== undefined ? `${last.locale}:${last.sequence}` : null,
        } };
      });
    },

    async listProjectStatusValues(query) {
      if (!ownerAuthorized(query.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      return await input.operations.transactions.run((context) => input.repository.listProjectStatusValues(input.scope, context));
    },

    async getProjectOwnerView(query) {
      if (!ownerAuthorized(query.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      return await input.operations.transactions.run((context) => input.repository.getProjectOwnerView(query.projectId, input.scope, context));
    },

    async getProjectStatusHistory(query) {
      if (!ownerAuthorized(query.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      return await input.operations.transactions.run((context) => input.repository.listProjectStatusHistory({
        valueId: query.valueId,
        scope: input.scope,
      }, context));
    },

    async createProjectStatusValue(command) {
      if (!ownerAuthorized(command.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      const label = command.label.trim().replace(/\s+/g, " ");
      if (!validCorrelation(command.correlationId) || !isCleanText(label, 100) || label.toLowerCase() === "archived") {
        return err({ kind: "validation", code: "INVALID_PROJECT_STATUS_LABEL" });
      }
      const valueId = parseStableId("ProjectStatusValue", ids.generate("ProjectStatusValue"));
      if (!valueId.ok) throw new Error("Stable ID generator returned an invalid ProjectStatusValue identity.");
      return await executeIdempotently<ContentProjectStatusValue>({
        operationScope: "content-publishing.create-project-status-value",
        actor: command.actor,
        key: command.idempotencyKey,
        request: { label },
        effect: async (context) => {
          const created = await input.repository.createProjectStatusValue({ valueId: valueId.value, label, scope: input.scope }, context);
          if (!created.ok) return rejectionOutcome(created.error);
          const changedAt = created.value.changedAt;
          if (changedAt === null) throw new Error("Status creation omitted its transaction timestamp.");
          await input.operations.outbox.append(context, {
            eventId: ids.generate("DomainEvent"),
            payload: { type: "content.project_status_value_created.v1", version: 1, value: {
              valueId: valueId.value, ownerScope: await actorScope,
            } },
            aggregateId: valueId.value,
            aggregateVersion: created.value.value.aggregateVersion,
            correlationId: command.correlationId,
            occurredAt: changedAt,
            availableAt: changedAt,
          });
          return { status: "completed", receipt: created.value.value as unknown as import("../../../shared/application/idempotency.js").CanonicalValue };
        },
      });
    },

    async renameProjectStatusValue(command) {
      if (!ownerAuthorized(command.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      const label = command.label.trim().replace(/\s+/g, " ");
      if (!validCorrelation(command.correlationId) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1 ||
          !isCleanText(label, 100) || label.toLowerCase() === "archived") {
        return err({ kind: "validation", code: "INVALID_PROJECT_STATUS_RENAME" });
      }
      return await executeIdempotently<ContentProjectStatusValue>({
        operationScope: "content-publishing.rename-project-status-value",
        actor: command.actor,
        key: command.idempotencyKey,
        request: { valueId: command.valueId, label, expectedVersion: command.expectedVersion },
        effect: async (context) => {
          const changed = await input.repository.renameProjectStatusValue({
            valueId: command.valueId, label, expectedVersion: command.expectedVersion, scope: input.scope,
          }, context);
          if (!changed.ok) return rejectionOutcome(changed.error);
          const changedAt = changed.value.changedAt;
          if (changed.value.changed && changedAt !== null) await input.operations.outbox.append(context, {
            eventId: ids.generate("DomainEvent"),
            payload: { type: "content.project_status_value_renamed.v1", version: 1, value: {
              valueId: command.valueId, ownerScope: await actorScope,
            } },
            aggregateId: command.valueId,
            aggregateVersion: changed.value.value.aggregateVersion,
            correlationId: command.correlationId,
            occurredAt: changedAt,
            availableAt: changedAt,
          });
          return { status: "completed", receipt: changed.value.value as unknown as import("../../../shared/application/idempotency.js").CanonicalValue };
        },
      });
    },

    async retireProjectStatusValue(command) {
      if (!ownerAuthorized(command.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      if (!validCorrelation(command.correlationId) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) {
        return err({ kind: "validation", code: "INVALID_PROJECT_STATUS_RETIREMENT" });
      }
      return await executeIdempotently<ContentProjectStatusValue>({
        operationScope: "content-publishing.retire-project-status-value",
        actor: command.actor,
        key: command.idempotencyKey,
        request: { valueId: command.valueId, expectedVersion: command.expectedVersion },
        effect: async (context) => {
          const changed = await input.repository.retireProjectStatusValue({
            valueId: command.valueId, expectedVersion: command.expectedVersion, scope: input.scope,
          }, context);
          if (!changed.ok) return rejectionOutcome(changed.error);
          const changedAt = changed.value.changedAt;
          if (changed.value.changed && changedAt !== null) await input.operations.outbox.append(context, {
            eventId: ids.generate("DomainEvent"),
            payload: { type: "content.project_status_value_retired.v1", version: 1, value: {
              valueId: command.valueId, ownerScope: await actorScope,
            } },
            aggregateId: command.valueId,
            aggregateVersion: changed.value.value.aggregateVersion,
            correlationId: command.correlationId,
            occurredAt: changedAt,
            availableAt: changedAt,
          });
          return { status: "completed", receipt: changed.value.value as unknown as import("../../../shared/application/idempotency.js").CanonicalValue };
        },
      });
    },

    async changeProjectStatus(command) {
      if (!ownerAuthorized(command.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      if (!validCorrelation(command.correlationId) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) {
        return err({ kind: "validation", code: "INVALID_PROJECT_STATUS_COMMAND" });
      }
      return await executeIdempotently<ProjectCommandReceipt>({
        operationScope: "content-publishing.change-project-status",
        actor: command.actor,
        key: command.idempotencyKey,
        request: { projectId: command.projectId, statusValueId: command.statusValueId, expectedVersion: command.expectedVersion },
        effect: async (context) => {
          const changed = await input.repository.changeProjectStatus({
            projectId: command.projectId, valueId: command.statusValueId, expectedVersion: command.expectedVersion, scope: input.scope,
          }, context);
          if (!changed.ok) return rejectionOutcome(changed.error);
          if (changed.value.changed) await input.operations.outbox.append(context, {
            eventId: ids.generate("DomainEvent"),
            payload: { type: "content.project_status_changed.v1", version: 1, value: {
              projectId: command.projectId, previousStatus: changed.value.previousValueId,
              newStatus: changed.value.currentValueId, ownerScope: await actorScope,
            } },
            aggregateId: command.projectId,
            aggregateVersion: changed.value.aggregateVersion,
            correlationId: command.correlationId,
            occurredAt: changed.value.changedAt,
            availableAt: changed.value.changedAt,
          });
          return { status: "completed", receipt: {
            projectId: command.projectId,
            aggregateVersion: changed.value.aggregateVersion,
            outcome: "project-status-changed",
          } };
        },
      });
    },

    async setProjectFeatured(command) {
      if (!ownerAuthorized(command.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      if (!validCorrelation(command.correlationId) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1 ||
          typeof command.featured !== "boolean") return err({ kind: "validation", code: "INVALID_PROJECT_FEATURED_COMMAND" });
      return await executeIdempotently<ProjectCommandReceipt>({
        operationScope: "content-publishing.set-project-featured",
        actor: command.actor,
        key: command.idempotencyKey,
        request: { projectId: command.projectId, featured: command.featured, expectedVersion: command.expectedVersion },
        effect: async (context) => {
          const changed = await input.repository.setProjectFeatured({
            projectId: command.projectId, featured: command.featured, expectedVersion: command.expectedVersion, scope: input.scope,
          }, context);
          if (!changed.ok) return rejectionOutcome(changed.error);
          if (changed.value.changed && changed.value.changedAt !== null) await input.operations.outbox.append(context, {
            eventId: ids.generate("DomainEvent"),
            payload: { type: "content.project_featured_changed.v1", version: 1, value: {
              projectId: command.projectId, featured: command.featured, ownerScope: await actorScope,
            } },
            aggregateId: command.projectId,
            aggregateVersion: changed.value.aggregateVersion,
            correlationId: command.correlationId,
            occurredAt: changed.value.changedAt,
            availableAt: changed.value.changedAt,
          });
          return { status: "completed", receipt: {
            projectId: command.projectId,
            aggregateVersion: changed.value.aggregateVersion,
            outcome: "project-featured-changed",
          } };
        },
      });
    },

    async assignProjectTaxonomyValue(command) {
      if (!ownerAuthorized(command.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      if (!validCorrelation(command.correlationId) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1 ||
          !parseStableId("Project", command.projectId).ok || !parseStableId("TaxonomyValue", command.valueId).ok) {
        return err({ kind: "validation", code: "INVALID_PROJECT_TAXONOMY_ASSIGNMENT" });
      }
      if (input.taxonomyAssignments === undefined) return err({ kind: "temporarily_unavailable", code: "TAXONOMY_ASSIGNMENTS_UNAVAILABLE" });
      return await executeIdempotently<ProjectCommandReceipt>({
        operationScope: "content-publishing.assign-project-taxonomy-value",
        actor: command.actor,
        key: command.idempotencyKey,
        request: { projectId: command.projectId, valueId: command.valueId, expectedVersion: command.expectedVersion },
        effect: async (context) => {
          // Lock order: Taxonomy root/value (shared) before Content Project (exclusive).
          // Retirement and merge take the same Taxonomy-first order before touching assignments.
          const facts = await input.taxonomyAssignments!.getValueFacts({ valueId: command.valueId, scope: input.scope }, context);
          if (!facts.ok) return rejectionOutcome(facts.error);
          const assigned = await input.repository.assignProjectTaxonomyValue({
            projectId: command.projectId, valueId: command.valueId, actorId: input.scope.ownerId,
            expectedVersion: command.expectedVersion, eligible: facts.value.eligible, scope: input.scope,
          }, context);
          if (!assigned.ok) return rejectionOutcome(assigned.error);
          if (assigned.value.changed) {
            await input.taxonomyAssignments!.updateProjectDiscoveryTaxonomyValue({
              projectId: command.projectId, valueId: command.valueId, scope: input.scope,
            }, context);
            const ownerScope = await actorScope;
            await input.operations.outbox.append(context, {
              eventId: ids.generate("DomainEvent"),
              payload: { type: "content.project_taxonomy_value_assigned.v1", version: 1, value: {
                projectId: command.projectId, taxonomyId: facts.value.taxonomyId, valueId: command.valueId, ownerScope,
              } },
              aggregateId: command.projectId,
              aggregateVersion: assigned.value.aggregateVersion,
              correlationId: command.correlationId,
              occurredAt: assigned.value.changedAt,
              availableAt: assigned.value.changedAt,
            });
          }
          return { status: "completed", receipt: {
            projectId: command.projectId,
            aggregateVersion: assigned.value.aggregateVersion,
            outcome: "taxonomy-value-assigned",
          } };
        },
      });
    },
  };
}
