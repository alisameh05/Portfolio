/**
 * content-publishing module public interface.
 *
 * This barrel is the single public import surface for the Content and Publishing module.
 * Other modules must never deep-import internal paths.
 */

export type {
  PublicLifecycle,
  ProjectStatus,
  SupportedLocale,
  EvidenceState,
  SupportingArtifact,
  EvidenceClaim,
  EvidencePackage,
  ExternalLink,
  PublicRoute,
  Project,
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
} from "./domain/index.js";

export type {
  SaveRevisionCommand,
  PublishLanguageVersionCommand,
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
