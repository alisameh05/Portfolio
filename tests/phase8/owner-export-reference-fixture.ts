import { createHash } from "node:crypto";
import { createOwnerAnalyticsExportSnapshotService } from "../../src/modules/measurement/application/owner-analytics-export.js";
import { projectFeedbackOwnerExportSnapshot } from "../../src/modules/interaction-moderation/application/owner-export.js";
import type { OwnerExportSelectedSnapshot } from "../../src/modules/portability-operations/application/owner-export-package.js";
import type { StableId } from "../../src/shared/domain/index.js";

// Bind the synthetic archive clock to this run so the package's retained
// Analytics policy window cannot silently age out in later validation runs.
export const capturedAt = new Date(Date.now() - 30_000).toISOString();
export const scopeOrder = ["portfolio-content", "taxonomy", "media-metadata", "cv-metadata", "moderation-history", "analytics-reports", "portfolio-configuration"] as const;
export type ExportScope = (typeof scopeOrder)[number];
export const id = (tail: string) => `0196a1b2-7c3d-7e11-9f22-${tail.padStart(12, "0")}`;

export const fixtureIds = {
  portfolio: id("1"), owner: id("2"), snapshot: id("3"),
  hiddenProject: id("10"), publishedProject: id("11"), draftProject: id("12"), archivedAchievement: id("13"), testimonial: id("14"),
  route: id("20"), publishedRoute: id("21"),
  taxonomy: id("30"), mergedValue: id("31"), activeValue: id("32"), retiredValue: id("33"),
  imageMedia: id("40"), currentCvMedia: id("41"), previousCvMedia: id("42"), rejectedMedia: id("43"),
  currentCv: id("50"), previousCv: id("51"),
  approvedFeedback: id("60"), rejectedFeedback: id("61"), pendingFeedback: id("62"), suppressedFeedback: id("63"),
  goal: id("70"), goalV1: id("71"), goalV2: id("72"),
  imageOriginalObject: id("80"), imageVariantObject: id("81"), currentCvObject: id("82"), previousCvObject: id("83"),
} as const;

const bytes = {
  imageOriginal: new TextEncoder().encode("synthetic original image bytes"),
  imageVariant: new TextEncoder().encode("synthetic accepted image variant"),
  currentCv: new TextEncoder().encode("synthetic current accepted PDF bytes"),
  previousCv: new TextEncoder().encode("synthetic previous accepted PDF bytes"),
} as const;
const sha = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const assets = {
  imageOriginal: `assets/media-metadata/sha256/${sha(bytes.imageOriginal)}`,
  imageVariant: `assets/media-metadata/sha256/${sha(bytes.imageVariant)}`,
  currentCv: `assets/media-metadata/sha256/${sha(bytes.currentCv)}`,
  previousCv: `assets/media-metadata/sha256/${sha(bytes.previousCv)}`,
} as const;

function contentRecord(contentId: string, contentType: string, lifecycle: string, input: Record<string, unknown> = {}) {
  return {
    contentId, contentType, lifecycle, aggregateVersion: 7, candidateSlug: null, firstPublishedAt: capturedAt,
    projectStatus: null, featured: false, revisions: [], publications: [], publicationHistory: [], lifecycleHistory: [],
    publicRouteIdentity: null, publicRoute: null, routeHistory: [], relatedProjectIds: [], relationshipHistory: [],
    taxonomyValueIds: [], taxonomyAssignments: [], mediaAssetIds: [], evidenceItems: [], publicDiscoveryOrder: null,
    ...input,
  };
}

function contentRecords() {
  const hiddenRevisionEn1 = id("100"), hiddenRevisionEn2 = id("101"), hiddenRevisionAr = id("102");
  const hiddenReviewEn1 = id("103"), hiddenReviewEn2 = id("104"), hiddenReviewAr = id("105");
  const review = (reviewId: string, revisionId: string, locale: "en" | "ar", sequence: number) => ({
    reviewId, revisionId, contentId: fixtureIds.hiddenProject, contentType: "project", locale,
    snapshotHash: "a".repeat(64), evidenceVersion: 1, reviewerId: fixtureIds.owner, reviewSequence: sequence,
    decision: "accepted", findings: [], reviewedAt: capturedAt,
  });
  const revision = (revisionId: string, locale: "en" | "ar", sequence: number, title: string, accepted: boolean, current: boolean) => ({
    revisionId, locale, sequence, aggregateVersion: sequence, savedAt: capturedAt,
    title, summary: `${title} summary`, body: `${title} body`, reviewed: accepted,
    currentlyPublished: current, reviews: accepted ? [review(locale === "en" ? (sequence === 1 ? hiddenReviewEn1 : hiddenReviewEn2) : hiddenReviewAr,
      revisionId, locale, 1)] : [],
    payload: { contentType: "project", locale, title, summary: `${title} summary`, body: `${title} body`, candidateSlug: "candidate-hidden",
      caseStudy: { problem: "Synthetic private problem." },
      evidence: { claims: [{ claimId: id("106"), text: "Synthetic evidence claim.", artifactIds: [id("107")] }],
        artifacts: [{ id: id("107"), title: "Synthetic evidence", destinationUrl: "https://example.test/evidence", mediaAssetId: fixtureIds.imageMedia }] } },
  });
  const hidden = contentRecord(fixtureIds.hiddenProject, "project", "hidden", {
    aggregateVersion: 12,
    projectStatus: { valueId: fixtureIds.activeValue, label: "Shipped", state: "active" }, featured: true,
    revisions: [revision(hiddenRevisionEn1, "en", 1, "English previous", true, false), revision(hiddenRevisionEn2, "en", 2, "English current", true, true),
      revision(hiddenRevisionAr, "ar", 1, "مشروع مخفي", true, true)],
    publications: [
      { locale: "en", revisionId: hiddenRevisionEn2, reviewId: hiddenReviewEn2, publicationSequence: 2, publishedAt: capturedAt },
      { locale: "ar", revisionId: hiddenRevisionAr, reviewId: hiddenReviewAr, publicationSequence: 1, publishedAt: capturedAt },
    ],
    publicationHistory: [
      { locale: "en", sequence: 1, revisionId: hiddenRevisionEn1, reviewId: hiddenReviewEn1, publishedAt: capturedAt },
      { locale: "en", sequence: 2, revisionId: hiddenRevisionEn2, reviewId: hiddenReviewEn2, publishedAt: capturedAt },
      { locale: "ar", sequence: 1, revisionId: hiddenRevisionAr, reviewId: hiddenReviewAr, publishedAt: capturedAt },
    ],
    lifecycleHistory: [
      { sequence: 1, previousLifecycle: "draft", lifecycle: "published", aggregateVersion: 5, reason: null, changedAt: capturedAt },
      { sequence: 2, previousLifecycle: "published", lifecycle: "hidden", aggregateVersion: 12, reason: "Owner hid a synthetic fixture.", changedAt: capturedAt },
    ],
    publicRouteIdentity: fixtureIds.route,
    publicRoute: { identity: fixtureIds.route, canonicalSlug: "current-hidden-project", firstPublishedAt: capturedAt,
      reservations: [{ slug: "previous-hidden-project", isCurrent: false, reservedAt: capturedAt },
        { slug: "current-hidden-project", isCurrent: true, reservedAt: capturedAt }],
      history: [{ sequence: 1, fromSlug: "previous-hidden-project", toSlug: "current-hidden-project", changedAt: capturedAt }] },
    routeHistory: [{ fromSlug: "previous-hidden-project", toSlug: "current-hidden-project" }],
    relatedProjectIds: [fixtureIds.draftProject],
    relationshipHistory: [{ leftProjectId: fixtureIds.hiddenProject, rightProjectId: fixtureIds.draftProject, sequence: 1,
      initiatingProjectId: fixtureIds.hiddenProject, relatedProjectId: fixtureIds.draftProject, occurredAt: capturedAt }],
    taxonomyValueIds: [fixtureIds.activeValue],
    taxonomyAssignments: [{ taxonomyId: fixtureIds.taxonomy, kind: "technology", valueId: fixtureIds.activeValue }],
    mediaAssetIds: [fixtureIds.imageMedia],
    evidenceItems: [{ claim: "Synthetic evidence claim.", state: "unreviewed", supportingArtifactIds: [id("107")], mediaAssetId: fixtureIds.imageMedia }],
    publicDiscoveryOrder: { firstPublishedAt: capturedAt, tieBreaker: "content-id-desc" },
  });
  const publishedRevision = id("108");
  const publishedReviewId = id("109");
  const published = contentRecord(fixtureIds.publishedProject, "project", "published", {
    revisions: [{ revisionId: publishedRevision, locale: "en", sequence: 1, aggregateVersion: 1, savedAt: capturedAt,
      title: "Synthetic published project", summary: "Public summary.", body: "Public body.", reviewed: true, currentlyPublished: true,
      reviews: [{ reviewId: publishedReviewId, revisionId: publishedRevision, contentId: fixtureIds.publishedProject,
        contentType: "project", locale: "en", snapshotHash: "c".repeat(64), evidenceVersion: 1, reviewerId: fixtureIds.owner,
        reviewSequence: 1, decision: "accepted", findings: [], reviewedAt: capturedAt }], payload: { contentType: "project", locale: "en", title: "Synthetic published project", summary: "Public summary.",
        body: "Public body." } }],
    publications: [{ locale: "en", revisionId: publishedRevision, reviewId: publishedReviewId, publicationSequence: 1, publishedAt: capturedAt }],
    publicationHistory: [{ locale: "en", sequence: 1, revisionId: publishedRevision, reviewId: publishedReviewId, publishedAt: capturedAt }],
    lifecycleHistory: [{ sequence: 1, previousLifecycle: "draft", lifecycle: "published", aggregateVersion: 2, reason: null, changedAt: capturedAt }],
    publicRouteIdentity: fixtureIds.publishedRoute,
    publicRoute: { identity: fixtureIds.publishedRoute, canonicalSlug: "synthetic-published-project", firstPublishedAt: capturedAt,
      reservations: [{ slug: "synthetic-published-project", isCurrent: true, reservedAt: capturedAt }], history: [] },
    publicDiscoveryOrder: { firstPublishedAt: capturedAt, tieBreaker: "content-id-desc" },
  });
  const draft = contentRecord(fixtureIds.draftProject, "project", "draft", { firstPublishedAt: null, candidateSlug: "draft-only",
    revisions: [{ revisionId: id("112"), locale: "en", sequence: 1, aggregateVersion: 1, savedAt: capturedAt,
      title: "Synthetic draft project", summary: "Private draft summary.", body: "Private draft body.", reviewed: false, currentlyPublished: false,
      reviews: [], payload: { contentType: "project", locale: "en", title: "Synthetic draft project", summary: "Private draft summary.",
        body: "Private draft body.", candidateSlug: "draft-only" } }] });
  const archived = contentRecord(fixtureIds.archivedAchievement, "achievement", "archived", { firstPublishedAt: null,
    revisions: [{ revisionId: id("110"), locale: "ar", sequence: 1, aggregateVersion: 1, savedAt: capturedAt,
      title: "إنجاز مؤرشف", summary: "ملخص محفوظ", body: "سجل غير منشور", reviewed: false, currentlyPublished: false, reviews: [],
      payload: { contentType: "achievement", locale: "ar", title: "إنجاز مؤرشف", summary: "ملخص محفوظ", body: "سجل غير منشور", achievedOn: "2026-09-12" } }],
    lifecycleHistory: [{ sequence: 1, previousLifecycle: "draft", lifecycle: "archived", aggregateVersion: 2, reason: "Retained synthetic fixture.", changedAt: capturedAt }],
  });
  const testimonial = contentRecord(fixtureIds.testimonial, "testimonial", "draft", { firstPublishedAt: null,
    revisions: [{ revisionId: id("111"), locale: "en", sequence: 1, aggregateVersion: 1, savedAt: capturedAt,
      title: "Synthetic reference", summary: "Private summary.", body: "Private body.", reviewed: false, currentlyPublished: false, reviews: [],
      payload: { contentType: "testimonial", locale: "en", title: "Synthetic reference", summary: "Private summary.", body: "Private body.",
        authorName: "Synthetic private source", quote: "A retained synthetic quotation.", association: { type: "project", projectId: fixtureIds.draftProject } } }],
    relatedProjectIds: [fixtureIds.draftProject],
  });
  return [hidden, published, draft, archived, testimonial].map((value) => ({ contentId: value.contentId, value: value as Readonly<Record<string, unknown>> }));
}

function taxonomyRecord() {
  return {
    taxonomyId: fixtureIds.taxonomy, aggregateVersion: 7, kind: "technology",
    values: [
      { valueId: fixtureIds.mergedValue, name: "Service Layer", state: "merged", valueVersion: 3, mergedIntoValueId: fixtureIds.activeValue },
      { valueId: fixtureIds.activeValue, name: "Services", state: "active", valueVersion: 1 },
      { valueId: fixtureIds.retiredValue, name: "Legacy", state: "retired", valueVersion: 2 },
    ],
    evolutionHistory: [
      { valueId: fixtureIds.mergedValue, transitionSequence: 1, action: "created", previousName: null, name: "Service", state: "active", changedAt: capturedAt },
      { valueId: fixtureIds.mergedValue, transitionSequence: 2, action: "renamed", previousName: "Service", name: "Service Layer", state: "active", changedAt: capturedAt },
      { valueId: fixtureIds.mergedValue, transitionSequence: 3, action: "merged", previousName: "Service Layer", name: "Service Layer", state: "merged", changedAt: capturedAt, mergedIntoValueId: fixtureIds.activeValue },
      { valueId: fixtureIds.activeValue, transitionSequence: 1, action: "created", previousName: null, name: "Services", state: "active", changedAt: capturedAt },
      { valueId: fixtureIds.retiredValue, transitionSequence: 1, action: "created", previousName: null, name: "Legacy", state: "active", changedAt: capturedAt },
      { valueId: fixtureIds.retiredValue, transitionSequence: 2, action: "retired", previousName: "Legacy", name: "Legacy", state: "retired", changedAt: capturedAt },
    ],
    assignments: [{ targetId: fixtureIds.hiddenProject, taxonomyValueId: fixtureIds.activeValue, assignedAt: capturedAt }],
    assignmentHistory: [
      { targetId: fixtureIds.hiddenProject, taxonomyValueId: fixtureIds.mergedValue, sequence: 1, projectVersion: 2, changedAt: capturedAt },
      { targetId: fixtureIds.hiddenProject, taxonomyValueId: fixtureIds.activeValue, sequence: 2, projectVersion: 3, changedAt: capturedAt },
    ],
  };
}

function acceptedMedia(mediaId: string, kind: "image" | "document", specs: readonly { variantName: string; path: string; mediaType: string; body: Uint8Array; objectId: string; source: "original" | "variant"; uploadIntentId?: string }[]) {
  const portableAssets = specs.map((spec) => ({ variantName: spec.variantName, mediaType: spec.mediaType,
    byteLength: spec.body.byteLength, digest: sha(spec.body), portableReference: spec.path }));
  return {
    mediaId,
    value: {
      mediaId, aggregateVersion: 3, kind, state: "accepted", locales: ["en", "ar"],
      accessibilityMetadata: kind === "image" ? { kind: "described-image", altText: "Synthetic accessible image." } : { kind: "document", summary: "Synthetic accessible PDF." },
      processingHistory: [], processingHistoryTruncated: false,
      decisionHistory: [{ decision: "accepted", decidedAt: capturedAt }], decisionHistoryTruncated: false,
      acceptanceHistory: [{ aggregateVersion: 3, decidedAt: capturedAt, inputSha256: "a".repeat(64),
        detectedMediaType: kind === "image" ? "image/png" : "application/pdf", detectedByteLength: specs[0]!.body.byteLength,
        scannerVersion: "synthetic-scanner-v1", processorVersion: "synthetic-processor-v1", processingPolicyVersion: "synthetic-policy-v1",
        accessibilityMetadata: kind === "image" ? { kind: "described-image", altText: "Synthetic accessible image." } : { kind: "document", summary: "Synthetic accessible PDF." },
        byteCoverage: "included", variants: portableAssets.map((asset) => ({ ...asset, byteCoverage: "included" })) }],
      acceptanceHistoryTruncated: false, publicationState: "published", publicationEligibility: "eligible",
      portableAssets, byteCoverage: "included",
    } as Readonly<Record<string, unknown>>,
    assets: specs.map((spec) => ({ path: spec.path, mediaId, variantName: spec.variantName,
      mediaType: spec.mediaType as "image/png" | "image/webp" | "application/pdf", byteLength: spec.body.byteLength,
      digest: sha(spec.body), objectId: spec.objectId, source: spec.source,
      ...(spec.source === "original" ? { uploadIntentId: spec.uploadIntentId } : {}) })),
  };
}

const mediaSpecs = [
  { variantName: "original", path: assets.imageOriginal, mediaType: "image/png", body: bytes.imageOriginal, objectId: fixtureIds.imageOriginalObject, source: "original" as const, uploadIntentId: id("90") },
  { variantName: "display", path: assets.imageVariant, mediaType: "image/webp", body: bytes.imageVariant, objectId: fixtureIds.imageVariantObject, source: "variant" as const },
  { variantName: "document", path: assets.currentCv, mediaType: "application/pdf", body: bytes.currentCv, objectId: fixtureIds.currentCvObject, source: "variant" as const },
  { variantName: "document", path: assets.previousCv, mediaType: "application/pdf", body: bytes.previousCv, objectId: fixtureIds.previousCvObject, source: "variant" as const },
] as const;

function mediaSnapshot() {
  const image = acceptedMedia(fixtureIds.imageMedia, "image", mediaSpecs.slice(0, 2));
  const current = acceptedMedia(fixtureIds.currentCvMedia, "document", [mediaSpecs[2]!]);
  const previous = acceptedMedia(fixtureIds.previousCvMedia, "document", [mediaSpecs[3]!]);
  const rejected = {
    mediaId: fixtureIds.rejectedMedia,
    value: { mediaId: fixtureIds.rejectedMedia, aggregateVersion: 4, kind: "video", state: "rejected", locales: [], accessibilityMetadata: null,
      processingHistory: [], processingHistoryTruncated: false, decisionHistory: [{ decision: "rejected", decidedAt: capturedAt, reason: "UNSAFE_CONTENT" }],
      decisionHistoryTruncated: false, acceptanceHistory: [], acceptanceHistoryTruncated: false, publicationState: "withdrawn",
      publicationEligibility: "ineligible", portableAssets: [], byteCoverage: "excluded", byteExclusionReason: "rejected-or-withdrawn" },
  };
  const accepted = [image, current, previous];
  return {
    records: [...accepted.map(({ mediaId, value }) => ({ mediaId, value })), rejected],
    assets: accepted.flatMap((item) => item.assets),
  };
}

function cvSnapshot() {
  return {
    capturedAt,
    aggregateVersion: 5,
    currentVersionId: fixtureIds.currentCv as StableId<"CvVersion">,
    versions: [
      { versionId: fixtureIds.currentCv as StableId<"CvVersion">, mediaId: fixtureIds.currentCvMedia as StableId<"MediaAsset">,
        locale: "en" as const, label: "Current synthetic CV", state: "accepted" as const, isCurrent: true, versionNumber: 2,
        registeredAt: "2026-10-20T09:00:00.000Z", acceptedAt: capturedAt,
        acceptedMediaSnapshot: { mediaAssetVersion: 3, mediaDecisionId: id("120"), mediaObjectId: fixtureIds.currentCvObject,
          sha256: sha(bytes.currentCv), objectVersion: sha(bytes.currentCv) } },
      { versionId: fixtureIds.previousCv as StableId<"CvVersion">, mediaId: fixtureIds.previousCvMedia as StableId<"MediaAsset">,
        locale: "en" as const, label: "Previous synthetic CV", state: "accepted" as const, isCurrent: false, versionNumber: 1,
        registeredAt: "2026-10-18T09:00:00.000Z", acceptedAt: "2026-10-19T10:00:00.000Z",
        acceptedMediaSnapshot: { mediaAssetVersion: 2, mediaDecisionId: id("121"), mediaObjectId: fixtureIds.previousCvObject,
          sha256: sha(bytes.previousCv), objectVersion: sha(bytes.previousCv) } },
    ],
    versionsTruncated: false,
    acceptanceHistory: [
      { approvalId: id("122") as StableId<"CvApproval">, versionId: fixtureIds.currentCv as StableId<"CvVersion">, acceptedAt: capturedAt },
      { approvalId: id("123") as StableId<"CvApproval">, versionId: fixtureIds.previousCv as StableId<"CvVersion">, acceptedAt: "2026-10-19T10:00:00.000Z" },
    ],
    acceptanceHistoryTruncated: false,
    activationHistory: [
      { activationId: id("124") as StableId<"CvActivation">, versionId: fixtureIds.currentCv as StableId<"CvVersion">, activatedAt: capturedAt },
      { activationId: id("125") as StableId<"CvActivation">, versionId: fixtureIds.previousCv as StableId<"CvVersion">, activatedAt: "2026-10-21T10:00:00.000Z" },
    ],
    activationHistoryTruncated: false,
  };
}

function moderationSnapshot() {
  const projected = projectFeedbackOwnerExportSnapshot({ capturedAt, records: [
    { feedbackId: fixtureIds.approvedFeedback, projectId: fixtureIds.hiddenProject, locale: "en", aggregateVersion: 3, state: "approved",
      authorName: "Synthetic retained name", paragraph: "Synthetic retained Feedback text.", submittedAt: "2026-10-20T10:00:00.000Z", textErasedAt: null,
      decisions: [{ sequence: 1, decision: "approved", reason: "Synthetic lawful approval audit.", decidedAt: "2026-10-21T10:00:00.000Z" }] },
    { feedbackId: fixtureIds.rejectedFeedback, projectId: fixtureIds.hiddenProject, locale: "ar", aggregateVersion: 2, state: "rejected",
      authorName: "Synthetic rejected name", paragraph: "Synthetic rejected Feedback text.", submittedAt: "2026-10-24T10:00:00.000Z", textErasedAt: null,
      decisions: [{ sequence: 1, decision: "rejected", reason: "Synthetic rejection audit.", decidedAt: "2026-10-25T10:00:00.000Z" }] },
    { feedbackId: fixtureIds.pendingFeedback, projectId: fixtureIds.hiddenProject, locale: "en", aggregateVersion: 1, state: "pending",
      authorName: "Synthetic pending name", paragraph: "Synthetic pending Feedback text.", submittedAt: "2026-10-25T10:00:00.000Z", textErasedAt: null,
      decisions: [] },
    { feedbackId: fixtureIds.suppressedFeedback, projectId: fixtureIds.hiddenProject, locale: "en", aggregateVersion: 5, state: "suppressed",
      authorName: "Synthetic expired name", paragraph: "Synthetic expired text must be absent.", submittedAt: "2024-01-30T10:00:00.000Z", textErasedAt: null,
      decisions: [{ sequence: 1, decision: "approved", reason: "Prior lawful approval.", decidedAt: "2024-01-31T10:00:00.000Z" },
        { sequence: 2, decision: "suppressed", reason: "Expired suppression rationale must be absent.", decidedAt: "2024-01-31T10:00:00.000Z" }] },
  ] as never });
  return { records: projected.records };
}

async function analyticsSnapshot() {
  const analytics = createOwnerAnalyticsExportSnapshotService({
    goals: {
      async listGoals() { return [{ goalId: fixtureIds.goal as StableId<"AnalyticsGoal">, aggregateVersion: 5,
        activeVersionId: fixtureIds.goalV2 as StableId<"AnalyticsGoalVersion"> }]; },
      async listVersions() { return [
        { versionId: fixtureIds.goalV1 as StableId<"AnalyticsGoalVersion">, versionNumber: 1,
          definition: { name: "Synthetic project interest", steps: [{ action: "project-viewed" as const,
            projectIds: [fixtureIds.hiddenProject as StableId<"Project">], publicRouteIds: [fixtureIds.route as StableId<"PublicRoute">] }] },
          createdAt: "2026-10-01T10:00:00.000Z" },
        { versionId: fixtureIds.goalV2 as StableId<"AnalyticsGoalVersion">, versionNumber: 2,
          definition: { name: "Synthetic route interest", steps: [{ action: "page-viewed" as const,
            projectIds: [fixtureIds.publishedProject as StableId<"Project">], publicRouteIds: [fixtureIds.publishedRoute as StableId<"PublicRoute">] }] },
          createdAt: "2026-10-02T10:00:00.000Z" },
      ]; },
      async listActivations() { return [
        { versionId: fixtureIds.goalV1 as StableId<"AnalyticsGoalVersion">, activatedAt: "2026-10-03T10:00:00.000Z", activationSequence: 1 },
        { versionId: fixtureIds.goalV2 as StableId<"AnalyticsGoalVersion">, activatedAt: "2026-10-04T10:00:00.000Z", activationSequence: 2 },
      ]; },
      async getGoal() { return null; }, async lockGoal() {}, async insertGoal() {}, async appendVersion() {}, async activateVersion() { return 0; },
    },
    aggregates: { async readReport(input) {
      return { rows: [{ date: input.startDay, metric: "goal", metricKey: "synthetic", goalId: fixtureIds.goal,
        goalVersionId: input.goalVersionId!, count: 12, sum: 0, dimensions: { locale: "ar" }, observedSubjects: 2,
        returningSubjects: 0, policyVersion: "phase7.daily.v2", asOf: capturedAt, incomplete: false,
        definitionSnapshot: {}, hasSmallDimensionCell: true }], asOf: capturedAt, incomplete: false } as never;
    } },
  });
  const result = await analytics.readOwnerAnalyticsExportSnapshot({ portfolioId: fixtureIds.portfolio as StableId<"Portfolio">,
    ownerId: fixtureIds.owner as StableId<"Owner">, capturedAt, transaction: { kind: "transaction" } });
  if (!result.ok) throw new Error("REFERENCE_FIXTURE_ANALYTICS_INVALID");
  return result.value;
}

export function mediaBytesByObjectId() {
  return new Map<string, Uint8Array>([
    [fixtureIds.imageOriginalObject, bytes.imageOriginal], [fixtureIds.imageVariantObject, bytes.imageVariant],
    [fixtureIds.currentCvObject, bytes.currentCv], [fixtureIds.previousCvObject, bytes.previousCv],
  ]);
}

export function expectedFacts() {
  return {
    contentIds: [fixtureIds.hiddenProject, fixtureIds.publishedProject, fixtureIds.draftProject, fixtureIds.archivedAchievement, fixtureIds.testimonial],
    hiddenProject: { lifecycle: "hidden", featured: true, projectStatus: { label: "Shipped", state: "active" },
      revisions: [{ revisionId: id("100"), locale: "en", sequence: 1, currentlyPublished: false },
        { revisionId: id("101"), locale: "en", sequence: 2, currentlyPublished: true },
        { revisionId: id("102"), locale: "ar", sequence: 1, currentlyPublished: true }],
      publications: [{ locale: "en", revisionId: id("101"), publicationSequence: 2 }, { locale: "ar", revisionId: id("102"), publicationSequence: 1 }],
      route: { identity: fixtureIds.route, canonicalSlug: "current-hidden-project" }, relatedProjectIds: [fixtureIds.draftProject],
      taxonomyValueId: fixtureIds.activeValue, mediaId: fixtureIds.imageMedia },
    taxonomy: { taxonomyId: fixtureIds.taxonomy, mergedValue: fixtureIds.mergedValue, activeValue: fixtureIds.activeValue, retiredValue: fixtureIds.retiredValue },
    mediaIds: [fixtureIds.imageMedia, fixtureIds.currentCvMedia, fixtureIds.previousCvMedia, fixtureIds.rejectedMedia],
    currentCv: fixtureIds.currentCv, previousCv: fixtureIds.previousCv,
    feedbackIds: [fixtureIds.approvedFeedback, fixtureIds.rejectedFeedback, fixtureIds.pendingFeedback, fixtureIds.suppressedFeedback],
    goalId: fixtureIds.goal,
    assetDigests: [sha(bytes.imageOriginal), sha(bytes.imageVariant), sha(bytes.currentCv), sha(bytes.previousCv)],
    privacyMarkersExcluded: ["Synthetic expired name", "Synthetic expired text must be absent.", "Expired suppression rationale must be absent."],
  };
}

export async function snapshotFor(scopes: readonly ExportScope[], snapshotId = fixtureIds.snapshot): Promise<OwnerExportSelectedSnapshot> {
  const media = mediaSnapshot();
  const analytics = await analyticsSnapshot();
  const settings = {
    portfolioId: fixtureIds.portfolio as never, version: 7,
    profile: { displayName: "Synthetic owner", headline: "Portable fixture", bio: "Synthetic test data only.", mediaAssetId: fixtureIds.imageMedia as never },
    contactChannels: [{ channel: "email" as const, label: "Email", destination: "mailto:synthetic@example.test", availableLocales: ["en" as const, "ar" as const] }],
    globalCta: { label: "Synthetic contact", destination: "https://example.test/contact", unavailableFallback: "Synthetic fallback" },
  };
  return {
    kind: "owner-export-snapshot-v1", snapshotId: snapshotId as OwnerExportSelectedSnapshot["snapshotId"], capturedAt,
    includedScopes: [...scopes],
    ...(scopes.includes("portfolio-configuration") ? { configuration: { snapshotId: snapshotId as OwnerExportSelectedSnapshot["snapshotId"],
      capturedAt, configurationVersion: settings.version, settings, capabilities: { currentCvAvailable: true, externalLinksAvailable: true,
        globalProjectCtaAvailable: true } } } : {}),
    ...(scopes.includes("portfolio-content") ? { content: { records: contentRecords() } } : {}),
    ...(scopes.includes("taxonomy") ? { taxonomy: { records: [{ taxonomyId: fixtureIds.taxonomy, value: taxonomyRecord() }] } } : {}),
    ...(scopes.includes("media-metadata") ? { media: media as OwnerExportSelectedSnapshot["media"] } : {}),
    ...(scopes.includes("cv-metadata") ? { cv: cvSnapshot() as unknown as OwnerExportSelectedSnapshot["cv"],
      cvAssets: media.assets.filter((asset) => asset.mediaId === fixtureIds.currentCvMedia || asset.mediaId === fixtureIds.previousCvMedia)
        .map((asset) => ({ ...asset,
          assetVersion: asset.mediaId === fixtureIds.currentCvMedia ? 3 : 2,
          decisionId: asset.mediaId === fixtureIds.currentCvMedia ? id("120") : id("121"),
          objectVersion: asset.digest,
        })) } : {}),
    ...(scopes.includes("moderation-history") ? { moderation: moderationSnapshot(),
      moderationCheckpoint: { recordsDigest: "b".repeat(64), dependencies: [fixtureIds.approvedFeedback, fixtureIds.rejectedFeedback,
        fixtureIds.pendingFeedback, fixtureIds.suppressedFeedback].map((feedbackId) => ({ feedbackId, projectId: fixtureIds.hiddenProject })) } } : {}),
    ...(scopes.includes("analytics-reports") ? { analytics: { records: analytics.records, policyExpiresAt: analytics.policyExpiresAt }, policyExpiresAt: analytics.policyExpiresAt } : {}),
  } as OwnerExportSelectedSnapshot;
}
