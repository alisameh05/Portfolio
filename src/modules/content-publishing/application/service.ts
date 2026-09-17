import type { StableId, Result, Rejection, ActorContext } from "@shared/domain";
import type {
  Project,
  LocalizedRevision,
  ProjectStatus,
  SupportedLocale,
} from "../domain/index.js";

export interface SaveRevisionCommand {
  readonly actor: ActorContext;
  readonly contentId: StableId<string>;
  readonly locale: SupportedLocale;
  readonly title: string;
  readonly summary: string;
  readonly caseStudyBody: string;
}

export interface PublishLanguageVersionCommand {
  readonly actor: ActorContext;
  readonly contentId: StableId<string>;
  readonly locale: SupportedLocale;
  readonly revisionId: StableId<"Revision">;
  readonly slug: string;
}

export interface HideContentCommand {
  readonly actor: ActorContext;
  readonly contentId: StableId<string>;
}

export interface ArchiveContentCommand {
  readonly actor: ActorContext;
  readonly contentId: StableId<string>;
}

export interface RestoreContentCommand {
  readonly actor: ActorContext;
  readonly contentId: StableId<string>;
}

export interface ChangeProjectStatusCommand {
  readonly actor: ActorContext;
  readonly projectId: StableId<"Project">;
  readonly status: ProjectStatus;
  readonly expectedVersion: number;
}

export interface SetProjectFeaturedCommand {
  readonly actor: ActorContext;
  readonly projectId: StableId<"Project">;
  readonly isFeatured: boolean;
  readonly expectedVersion: number;
}

export interface ChangePublicSlugCommand {
  readonly actor: ActorContext;
  readonly projectId: StableId<"Project">;
  readonly newSlug: string;
  readonly expectedVersion: number;
}

export interface GetPublicContentQuery {
  readonly slug: string;
  readonly locale: SupportedLocale;
}

export interface ContentPublishingService {
  saveRevision(
    command: SaveRevisionCommand,
  ): Promise<Result<LocalizedRevision, Rejection>>;

  publishLanguageVersion(
    command: PublishLanguageVersionCommand,
  ): Promise<Result<void, Rejection>>;

  hideContent(
    command: HideContentCommand,
  ): Promise<Result<void, Rejection>>;

  archiveContent(
    command: ArchiveContentCommand,
  ): Promise<Result<void, Rejection>>;

  restoreContent(
    command: RestoreContentCommand,
  ): Promise<Result<void, Rejection>>;

  changeProjectStatus(
    command: ChangeProjectStatusCommand,
  ): Promise<Result<Project, Rejection>>;

  setProjectFeatured(
    command: SetProjectFeaturedCommand,
  ): Promise<Result<Project, Rejection>>;

  changePublicSlug(
    command: ChangePublicSlugCommand,
  ): Promise<Result<Project, Rejection>>;

  getPublicContent(
    query: GetPublicContentQuery,
  ): Promise<Result<Project, Rejection>>;
}
