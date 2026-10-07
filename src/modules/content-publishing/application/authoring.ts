import { err, parseStableId, type ActorContext, type IdempotencyKey, type Rejection, type Result, type StableId } from "@shared/domain";
import type { Clock, StableIdGenerator, TransactionContext } from "../../../runtime/ports.js";
import { createSystemClock, createSystemIdGenerator } from "../../../runtime/ports.js";
import { hashCanonicalRequest } from "../../../shared/application/idempotency.js";
import type { OperationsPersistencePorts, SafeResultEnvelope } from "../../portability-operations/index.js";
import type { ContentHistoryEntry, ContentHistoryPage, ContentKind, CreateDraftPayload, LocalizedDraftData, PrivateRevisionPreview, SupportedLocale } from "../domain/index.js";
import type { MediaAcceptancePort, PublishLanguageVersionCommand, ReviewRevisionCommand } from "./service.js";

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
}

export interface ContentAuthoringPublication {
  readonly locale: "en" | "ar";
  readonly revisionId: StableId<"Revision">;
  readonly publishedAt: string;
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
    readonly label: string;
    readonly destination: string;
  }[];
}

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

export interface ContentAuthoringRepository {
  projectExists(projectId: StableId<"Project">, scope: ContentAuthoringScope, context: TransactionContext): Promise<boolean>;
  create(input: CreateContentPersistenceInput, context: TransactionContext): Promise<Result<ContentAuthoringRecord, Rejection>>;
  get(contentId: StableId<string>, scope: ContentAuthoringScope, context: TransactionContext): Promise<Result<ContentAuthoringRecord, Rejection>>;
  appendRevision(input: AppendContentRevisionInput, context: TransactionContext): Promise<Result<{ readonly record: ContentAuthoringRecord; readonly revision: ContentAuthoringRevision }, Rejection>>;
  appendReview(input: AppendContentReviewInput, context: TransactionContext): Promise<Result<{ readonly aggregateVersion: number }, Rejection>>;
  publishProjectLanguage(input: PublishProjectLanguageInput, context: TransactionContext): Promise<Result<PublishProjectLanguageResult, Rejection>>;
  publishTestimonialLanguage(input: PublishTestimonialLanguageInput, context: TransactionContext): Promise<Result<PublishTestimonialLanguageResult, Rejection>>;
  getPublicTestimonials(input: { readonly scope: ContentAuthoringScope; readonly locale: SupportedLocale; readonly association: PublicTestimonialAssociationQuery }, context: TransactionContext): Promise<Result<readonly PublicTestimonialView[], Rejection>>;
  getPublicProjectBySlug(input: { readonly slug: string; readonly locale: SupportedLocale; readonly scope: ContentAuthoringScope }, context: TransactionContext): Promise<Result<PublicProjectContentView, Rejection>>;
  listHistory(input: { readonly contentId: StableId<string>; readonly scope: ContentAuthoringScope; readonly locale?: SupportedLocale; readonly after?: { readonly locale: SupportedLocale; readonly sequence: number }; readonly limit: number }, context: TransactionContext): Promise<Result<{ readonly entries: readonly ContentHistoryEntry[]; readonly hasMore: boolean }, Rejection>>;
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
}

export interface ContentAuthoringService {
  createContent(command: CreateOwnerContentCommand): Promise<Result<CreateContentReceipt, Rejection>>;
  getOwnerContentAggregate(query: GetOwnerContentAggregateQuery): Promise<Result<OwnerContentAggregateView, Rejection>>;
  saveRevision(command: SaveContentRevisionCommand): Promise<Result<SaveContentRevisionReceipt, Rejection>>;
  previewRevision(query: { readonly actor: ActorContext; readonly contentId: StableId<string>; readonly revisionId: StableId<"Revision"> }): Promise<Result<PrivateRevisionPreview, Rejection>>;
  reviewRevision(command: ReviewRevisionCommand): Promise<Result<ReviewRevisionReceipt, Rejection>>;
  publishLanguageVersion(command: PublishLanguageVersionCommand): Promise<Result<ContentAuthoringPublicationReceipt, Rejection>>;
  getPublicProject(query: { readonly slug: string; readonly locale: SupportedLocale }): Promise<Result<PublicProjectContentView, Rejection>>;
  getPublicTestimonials(query: { readonly locale: SupportedLocale; readonly association: PublicTestimonialAssociationQuery }): Promise<Result<readonly PublicTestimonialView[], Rejection>>;
  getContentHistory(query: { readonly actor: ActorContext; readonly contentId: StableId<string>; readonly locale?: SupportedLocale; readonly limit: number; readonly cursor?: string }): Promise<Result<ContentHistoryPage, Rejection>>;
}

export interface ContentAuthoringPublicationReceipt {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome: "language-published";
  readonly revisionId: StableId<"Revision">;
  readonly locale: SupportedLocale;
  readonly currentSlug?: string;
  readonly routeIdentity?: StableId<"PublicRoute">;
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
    if (!isRecord(link) || !hasOnlyKeys(link, ["id", "label", "destination", "isAvailableInArabic"])) return false;
    const id = link["id"];
    const label = link["label"];
    const destination = link["destination"];
    const isAvailableInArabic = link["isAvailableInArabic"];
    if (typeof id !== "string" || !parseStableId("ExternalLink", id).ok || linkIds.has(id) || !isCleanText(label, 120) ||
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
    const count = record.revisions.filter((revision) => revision.locale === locale).length;
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
    localizedStreams,
    revisions: record.revisions.map(({ revisionId, locale, sequence, reviewed, reviewDecision }) => ({
      revisionId, locale, sequence, reviewed, ...(reviewDecision === undefined ? {} : { reviewDecision }),
    })),
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

export function createContentAuthoringService(input: {
  readonly repository: ContentAuthoringRepository;
  readonly operations: OperationsPersistencePorts;
  readonly scope: ContentAuthoringScope;
  readonly discoveryProjection: ProjectDiscoveryProjectionPort;
  readonly clock?: Clock;
  readonly ids?: StableIdGenerator;
  /** Test seam for authoritative Media facts; production intentionally has no Media acceptance adapter yet. */
  readonly mediaAcceptance?: MediaAcceptancePort;
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

  return {
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
        const result = await input.repository.get(query.contentId, input.scope, context);
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
        if (existing.value.lifecycle !== "draft" && existing.value.lifecycle !== "published") {
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
        if (existing.value.contentType !== "project") return rejectionOutcome({ kind: "validation", code: "CONTENT_TYPE_NOT_PUBLISHABLE" });
        if (!publishableProjectPayload(revision.payload)) return rejectionOutcome({ kind: "validation", code: "PROJECT_PUBLICATION_REQUIREMENTS_NOT_MET" });
        const snapshotHash = await revisionSnapshotHash(revision);
        const review = revision.latestReview;
        if (review === undefined || review.decision !== "accepted" || review.revisionId !== revision.revisionId ||
            review.contentId !== revision.contentId || review.contentType !== "project" || review.locale !== command.locale ||
            review.reviewerId !== input.scope.ownerId || review.snapshotHash !== snapshotHash ||
            review.evidenceVersion !== revision.evidenceSnapshotVersion) {
          return rejectionOutcome({ kind: "validation", code: "ACCEPTED_REVISION_REVIEW_REQUIRED" });
        }
        const mediaAssetIds = [...new Set((revision.payload.evidence?.artifacts ?? [])
          .flatMap((artifact) => artifact.mediaAssetId === undefined ? [] : [artifact.mediaAssetId]))];
        let mediaFactsVersion: string | null = null;
        if (mediaAssetIds.length > 0) {
          if (input.mediaAcceptance === undefined) return rejectionOutcome({ kind: "temporarily_unavailable", code: "MEDIA_ACCEPTANCE_UNAVAILABLE" });
          const facts = await input.mediaAcceptance.getAcceptanceFacts({
            ownerId: input.scope.ownerId,
            mediaAssetIds,
            intendedUse: "project-evidence",
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
        const routeIdentity = parseStableId("PublicRoute", ids.generate("PublicRoute"));
        if (!routeIdentity.ok) throw new Error("Stable ID generator returned an invalid public route identity.");
        const published = await input.repository.publishProjectLanguage({
          contentId: command.contentId,
          scope: input.scope,
          expectedVersion: command.expectedVersion,
          locale: command.locale,
          revisionId: revision.revisionId,
          reviewId: review.reviewId,
          snapshotHash,
          routeIdentity: routeIdentity.value,
          publishedAt,
          payload: revision.payload,
          mediaFactsVersion,
        }, context);
        if (!published.ok) return rejectionOutcome(published.error);
        await input.discoveryProjection.writePublishedProjectLocale({
          contentId: command.contentId as StableId<"Project">,
          portfolioId: input.scope.portfolioId,
          ownerId: input.scope.ownerId,
          locale: command.locale,
          revisionId: published.value.revisionId,
          routeIdentity: published.value.routeIdentity,
          title: revision.title,
          slug: published.value.currentSlug,
          firstPublishedAt: published.value.firstPublishedAt,
          publishedAt: published.value.publishedAt,
        }, context);
        const ownerHash = await actorScope;
        await input.operations.outbox.append(context, {
          eventId: ids.generate("DomainEvent"),
          payload: { type: "content.language_version_published.v1", version: 1, value: {
            contentId: command.contentId,
            locale: command.locale,
            revisionId: revision.revisionId,
            slug: published.value.currentSlug,
            routeIdentity: published.value.routeIdentity,
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
          currentSlug: published.value.currentSlug,
          routeIdentity: published.value.routeIdentity,
          firstPublishedAt: published.value.firstPublishedAt,
          publishedAt: published.value.publishedAt,
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
        const entries = listed.value.entries;
        const last = entries.at(-1);
        return { ok: true as const, value: {
          entries,
          nextCursor: listed.value.hasMore && last !== undefined ? `${last.locale}:${last.sequence}` : null,
        } };
      });
    },
  };
}
