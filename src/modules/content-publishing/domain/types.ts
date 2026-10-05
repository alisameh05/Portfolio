import type { StableId, DomainEvent } from "@shared/domain";

export type PublicLifecycle = "draft" | "published" | "hidden" | "archived";

/** Stable identity for an Owner-managed maturity value, independent of lifecycle. */
export type ProjectStatus = StableId<"ProjectStatusValue">;

export type ContentKind = "project" | "achievement" | "testimonial";

export interface ProjectStatusValue {
  readonly valueId: ProjectStatus;
  readonly label: string;
  readonly state: "active" | "retired";
}

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
  readonly aggregateVersion: number;
  readonly sequence: number;
  readonly evidenceSnapshotVersion: number;
  readonly savedAt: string;
}

export interface LanguagePublication {
  readonly locale: SupportedLocale;
  readonly currentRevisionId: StableId<"Revision">;
  readonly exactReviewId: StableId<"ContentReview">;
  readonly aggregateVersion: number;
  readonly publishedAt: string;
}

export interface ReviewRecord {
  readonly reviewId: StableId<"ContentReview">;
  readonly contentId: StableId<string>;
  readonly revisionId: StableId<"Revision">;
  readonly locale: SupportedLocale;
  readonly decision: "accepted" | "rejected";
  readonly findings: readonly string[];
  readonly reviewerId: StableId<"Owner">;
  readonly reviewedAt: string;
  readonly evidenceVersion: number;
}

export interface DraftContentPayload {
  readonly locale: SupportedLocale;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
}

export interface ProjectDraftPayload extends DraftContentPayload {
  readonly contentType: "project";
  readonly candidateSlug?: string;
  readonly caseStudy?: {
    readonly problem?: string;
    readonly ownerRole?: string;
    readonly contributions?: readonly string[];
    readonly outcomes?: readonly string[];
    readonly lessons?: string;
  };
}

export interface ProjectDraftData {
  readonly contentType: "project";
  readonly caseStudy?: ProjectDraftPayload["caseStudy"];
}

export interface AchievementDraftData {
  readonly contentType: "achievement";
  readonly achievedOn?: string;
  readonly evidence?: AchievementDraftPayload["evidence"];
}

export interface TestimonialDraftData {
  readonly contentType: "testimonial";
  readonly authorName?: string;
  readonly quote?: string;
  readonly relatedProjectId?: StableId<"Project">;
}

export type LocalizedDraftData = ProjectDraftData | AchievementDraftData | TestimonialDraftData;

export interface AchievementDraftPayload extends DraftContentPayload {
  readonly contentType: "achievement";
  readonly achievedOn?: string;
  readonly evidence?: {
    readonly claims: readonly {
      readonly claimId: StableId<"EvidenceClaim">;
      readonly text: string;
      readonly artifactIds: readonly StableId<"SupportingArtifact">[];
    }[];
  };
}

export interface TestimonialDraftPayload extends DraftContentPayload {
  readonly contentType: "testimonial";
  readonly authorName?: string;
  readonly quote?: string;
  readonly relatedProjectId?: StableId<"Project">;
  /** Persisted association is explicit even when the Owner selects the profile. */
  readonly association?:
    | { readonly type: "profile" }
    | { readonly type: "project"; readonly projectId: StableId<"Project"> };
}

export type CreateDraftPayload =
  | ProjectDraftPayload
  | AchievementDraftPayload
  | TestimonialDraftPayload;

export interface PublicLocalizedContentDto {
  readonly contentId: StableId<string>;
  readonly contentType: ContentKind;
  readonly locale: SupportedLocale;
  readonly revisionId: StableId<"Revision">;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly firstPublishedAt: string;
}

export interface PrivateRevisionPreview {
  readonly contentId: StableId<string>;
  readonly revisionId: StableId<"Revision">;
  readonly locale: SupportedLocale;
  readonly sequence: number;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly review: Pick<ReviewRecord, "decision" | "findings" | "reviewedAt"> | null;
}

export interface ContentHistoryEntry {
  readonly revisionId: StableId<"Revision">;
  readonly locale: SupportedLocale;
  readonly sequence: number;
  readonly savedAt: string;
  readonly note?: string;
  readonly reviewDecision?: ReviewRecord["decision"];
}

export interface ContentHistoryPage {
  readonly entries: readonly ContentHistoryEntry[];
  readonly nextCursor: string | null;
}

export interface ExternalLink {
  readonly id: StableId<"ExternalLink">;
  readonly label: string;
  readonly destination: string;
  readonly isAvailableInArabic: boolean;
}

export interface PublicRoute {
  readonly routeIdentity: StableId<"PublicRoute"> | null;
  readonly currentSlug: string | null;
  readonly redirects: readonly string[];
  readonly firstPublishedAt: string | null;
}

export interface Project {
  readonly id: StableId<"Project">;
  readonly lifecycle: PublicLifecycle;
  readonly status: ProjectStatus;
  readonly isFeatured: boolean;
  readonly candidateSlug: string;
  readonly publicRoute: PublicRoute;
  readonly firstPublishedAt: string | null;
  readonly publications: readonly LanguagePublication[];
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

export type ContentCreatedEvent = DomainEvent<
  "content.created.v1",
  { readonly contentId: StableId<string>; readonly contentType: ContentKind }
>;

export type RevisionReviewedEvent = DomainEvent<
  "content.revision_reviewed.v1",
  {
    readonly contentId: StableId<string>;
    readonly revisionId: StableId<"Revision">;
    readonly reviewId: StableId<"ContentReview">;
    readonly locale: SupportedLocale;
    readonly decision: ReviewRecord["decision"];
  }
>;

export type ProjectsRelatedEvent = DomainEvent<
  "content.projects_related.v1",
  { readonly projectId: StableId<"Project">; readonly relatedProjectId: StableId<"Project"> }
>;
