import type { StableId, DomainEvent } from "@shared/domain";

export type PublicLifecycle = "draft" | "published" | "hidden" | "archived";

/**
 * ProjectStatus represents the maturity or work-state of a Project.
 * Note: 'archived' is forbidden as a ProjectStatus because lifecycle is separate.
 */
export type ProjectStatus =
  | "shipped"
  | "active"
  | "in_progress"
  | "experimental"
  | "research"
  | "open_source";

export type SupportedLocale = "en" | "ar";

export type EvidenceState = "unreviewed" | "verified_internal" | "substantiated";

export interface SupportingArtifact {
  readonly id: StableId<"SupportingArtifact">;
  readonly title: string;
  readonly destinationUrl?: string;
  readonly mediaAssetId?: StableId<"MediaAsset">;
}

export interface EvidenceClaim {
  readonly claimText: string;
  readonly artifactIds: readonly StableId<"SupportingArtifact">[];
}

export interface EvidencePackage {
  readonly claims: readonly EvidenceClaim[];
  readonly artifacts: readonly SupportingArtifact[];
  readonly evidenceState: EvidenceState;
}

export interface LocalizedRevision {
  readonly revisionId: StableId<"Revision">;
  readonly contentId: StableId<string>;
  readonly locale: SupportedLocale;
  readonly title: string;
  readonly summary: string;
  readonly caseStudyBody: string;
  readonly evidencePackage: EvidencePackage;
  readonly version: number;
}

export interface ExternalLink {
  readonly id: StableId<"ExternalLink">;
  readonly label: string;
  readonly destination: string;
  readonly isAvailableInArabic: boolean;
}

export interface PublicRoute {
  readonly routeIdentity: StableId<"PublicRoute">;
  readonly currentSlug: string;
  readonly redirects: readonly string[];
}

export interface Project {
  readonly id: StableId<"Project">;
  readonly lifecycle: PublicLifecycle;
  readonly status: ProjectStatus;
  readonly isFeatured: boolean;
  readonly routeIdentity: StableId<"PublicRoute">;
  readonly currentSlug: string;
  readonly revisions: readonly LocalizedRevision[];
  readonly relatedProjectIds: readonly StableId<"Project">[];
  readonly externalLinks: readonly ExternalLink[];
  readonly version: number;
}

export interface Achievement {
  readonly id: StableId<"Achievement">;
  readonly lifecycle: PublicLifecycle;
  readonly timelineDate: string;
  readonly revisions: readonly LocalizedRevision[];
  readonly version: number;
}

export interface Testimonial {
  readonly id: StableId<"Testimonial">;
  readonly lifecycle: PublicLifecycle;
  readonly authorName: string;
  readonly quote: string;
  readonly projectId?: StableId<"Project">;
  readonly version: number;
}

// Domain events
export type RevisionSavedEvent = DomainEvent<
  "content.revision_saved.v1",
  {
    readonly revisionId: StableId<"Revision">;
    readonly contentId: StableId<string>;
    readonly locale: SupportedLocale;
  }
>;

export type LanguageVersionPublishedEvent = DomainEvent<
  "content.language_version_published.v1",
  {
    readonly contentId: StableId<string>;
    readonly locale: SupportedLocale;
    readonly revisionId: StableId<"Revision">;
    readonly slug: string;
  }
>;

export type ContentHiddenEvent = DomainEvent<
  "content.content_hidden.v1",
  {
    readonly contentId: StableId<string>;
  }
>;

export type ContentArchivedEvent = DomainEvent<
  "content.content_archived.v1",
  {
    readonly contentId: StableId<string>;
  }
>;

export type ContentRestoredEvent = DomainEvent<
  "content.content_restored.v1",
  {
    readonly contentId: StableId<string>;
  }
>;

export type ProjectStatusChangedEvent = DomainEvent<
  "content.project_status_changed.v1",
  {
    readonly projectId: StableId<"Project">;
    readonly previousStatus: ProjectStatus;
    readonly newStatus: ProjectStatus;
  }
>;

export type ProjectFeaturedChangedEvent = DomainEvent<
  "content.project_featured_changed.v1",
  {
    readonly projectId: StableId<"Project">;
    readonly isFeatured: boolean;
  }
>;

export type PublicRouteChangedEvent = DomainEvent<
  "content.public_route_changed.v1",
  {
    readonly routeIdentity: StableId<"PublicRoute">;
    readonly previousSlug: string;
    readonly newSlug: string;
  }
>;
