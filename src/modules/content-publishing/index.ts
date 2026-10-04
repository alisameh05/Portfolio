/**
 * content-publishing module public interface.
 *
 * This barrel is the single public import surface for the Content and Publishing module.
 * Other modules must never deep-import internal paths.
 */

export type {
  PublicLifecycle,
  ProjectStatus,
  ProjectStatusValue,
  ContentKind,
  SupportedLocale,
  EvidenceState,
  SupportingArtifact,
  EvidenceClaim,
  EvidencePackage,
  ExternalLink,
  PublicRoute,
  Project,
  LanguagePublication,
  ReviewRecord,
  DraftContentPayload,
  ProjectDraftPayload,
  AchievementDraftPayload,
  TestimonialDraftPayload,
  CreateDraftPayload,
  PublicLocalizedContentDto,
  PrivateRevisionPreview,
  ContentHistoryEntry,
  ContentHistoryPage,
  Achievement,
  Testimonial,
  RevisionSavedEvent,
  LanguageVersionPublishedEvent,
  ContentHiddenEvent,
  ContentArchivedEvent,
  ContentRestoredEvent,
  ProjectStatusChangedEvent,
  ProjectFeaturedChangedEvent,
  PublicRouteChangedEvent,
  ContentCreatedEvent,
  RevisionReviewedEvent,
  ProjectsRelatedEvent,
} from "./domain/index.js";

export type {
  SaveRevisionCommand,
  ExistingContentCommandContext,
  CreateContentCommand,
  PublishLanguageVersionCommand,
  ReviewRevisionCommand,
  CorrectCandidateSlugCommand,
  PreviewRevisionQuery,
  ContentHistoryQuery,
  ProjectCommandReceipt,
  MediaAcceptanceFact,
  MediaAcceptanceBatch,
  MediaAcceptanceQuery,
  MediaAcceptancePort,
  ProjectTaxonomyAssignmentCommand,
  ProjectTaxonomyMergeCommand,
  ContentTaxonomyAssignmentsPort,
  HideContentCommand,
  ArchiveContentCommand,
  RestoreContentCommand,
  ChangeProjectStatusCommand,
  SetProjectFeaturedCommand,
  ChangePublicSlugCommand,
  GetPublicContentQuery,
  ContentPublishingService,
} from "./application/index.js";

export type { ContentRepositoryPort } from "./ports/index.js";
