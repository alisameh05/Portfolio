import { describe, expect, it } from "vitest";
import { buildSelectedOwnerExportPackage, type OwnerExportSelectedSnapshot } from "../../src/modules/portability-operations/application/owner-export-package.js";
import type { PortfolioSettings } from "../../src/modules/portfolio-configuration/domain/index.js";
import { validateOwnerExportZip } from "../../scripts/owner-export/validator.mjs";

const id = (tail: string) => `0196a1b2-7c3d-7e11-9f22-${tail.padStart(12, "0")}`;
const ownerId = id("1");
const portfolioId = id("2");
const exportId = id("3") as Parameters<typeof buildSelectedOwnerExportPackage>[0]["exportId"];
const snapshotId = id("4") as OwnerExportSelectedSnapshot["snapshotId"];
const at = "2026-10-24T08:00:00.000Z";

function projectRecord() {
  const contentId = id("10");
  const relatedId = id("11");
  const routeId = id("12");
  const en1 = id("13"), en2 = id("14"), ar1 = id("15");
  const reviewEn1 = id("16"), reviewEn2 = id("17"), reviewAr1 = id("18");
  const reviewerId = ownerId;
  const review = (reviewId: string, revisionId: string, locale: "en" | "ar", reviewSequence = 1) => ({
    reviewId, revisionId, contentId, contentType: "project", locale, snapshotHash: "a".repeat(64),
    evidenceVersion: 1, reviewerId, reviewSequence, decision: "accepted", findings: ["Private review note."], reviewedAt: at,
  });
  const revision = (revisionId: string, locale: "en" | "ar", sequence: number, title: string, reviews: readonly unknown[], currentlyPublished: boolean) => ({
    revisionId, locale, sequence, aggregateVersion: sequence, savedAt: at, title, summary: `${title} summary`, body: `${title} body`,
    reviewed: reviews.length > 0, currentlyPublished, reviews,
    payload: {
      contentType: "project", locale, title, summary: `${title} summary`, body: `${title} body`, candidateSlug: "candidate-project",
      caseStudy: { problem: "A private problem statement." },
      evidence: { claims: [{ claimId: id("19"), text: "Evidence claim.", artifactIds: [id("20")] }],
        artifacts: [{ id: id("20"), title: "Private artifact", destinationUrl: "https://example.test/evidence", mediaAssetId: id("21") }] },
    },
  });
  return {
    contentId, contentType: "project", lifecycle: "hidden", aggregateVersion: 12, candidateSlug: null,
    firstPublishedAt: at,
    projectStatus: { valueId: id("22"), label: "Shipped", state: "active" }, featured: true,
    revisions: [revision(en1, "en", 1, "English old", [review(reviewEn1, en1, "en")], false),
      revision(en2, "en", 2, "English current", [review(reviewEn2, en2, "en")], true),
      revision(ar1, "ar", 1, "Arabic current", [review(reviewAr1, ar1, "ar")], true)],
    publications: [
      { locale: "en", revisionId: en2, reviewId: reviewEn2, publicationSequence: 2, publishedAt: at },
      { locale: "ar", revisionId: ar1, reviewId: reviewAr1, publicationSequence: 1, publishedAt: at },
    ],
    publicationHistory: [
      { locale: "en", sequence: 1, revisionId: en1, reviewId: reviewEn1, publishedAt: at },
      { locale: "en", sequence: 2, revisionId: en2, reviewId: reviewEn2, publishedAt: at },
      { locale: "ar", sequence: 1, revisionId: ar1, reviewId: reviewAr1, publishedAt: at },
    ],
    lifecycleHistory: [
      { sequence: 1, previousLifecycle: "draft", lifecycle: "published", aggregateVersion: 5, reason: null, changedAt: at },
      { sequence: 2, previousLifecycle: "published", lifecycle: "hidden", aggregateVersion: 12, reason: "Private update", changedAt: at },
    ],
    publicRouteIdentity: routeId,
    publicRoute: {
      identity: routeId, canonicalSlug: "current-project", firstPublishedAt: at,
      reservations: [
        { slug: "old-project", isCurrent: false, reservedAt: at },
        { slug: "current-project", isCurrent: true, reservedAt: at },
      ],
      history: [{ sequence: 1, fromSlug: "old-project", toSlug: "current-project", changedAt: at }],
    },
    routeHistory: [{ fromSlug: "old-project", toSlug: "current-project" }],
    relatedProjectIds: [relatedId],
    relationshipHistory: [{ leftProjectId: contentId, rightProjectId: relatedId, sequence: 1,
      initiatingProjectId: contentId, relatedProjectId: relatedId, occurredAt: at }],
    taxonomyValueIds: [id("23")],
    taxonomyAssignments: [{ taxonomyId: id("24"), kind: "technology", valueId: id("23") }],
    mediaAssetIds: [id("21")],
    evidenceItems: [{ claim: "Evidence claim.", state: "unreviewed", supportingArtifactIds: [id("20")], mediaAssetId: id("21") }],
    publicDiscoveryOrder: { firstPublishedAt: at, tieBreaker: "content-id-desc" },
  };
}

function privateProjectRecord() {
  const contentId = id("11");
  const revisionId = id("30");
  return {
    contentId, contentType: "project", lifecycle: "draft", aggregateVersion: 1, candidateSlug: "draft-project",
    firstPublishedAt: null, projectStatus: null, featured: false,
    revisions: [{ revisionId, locale: "en", sequence: 1, aggregateVersion: 1, savedAt: at, title: "Draft project",
      summary: "Private summary", body: "Private body", reviewed: false, currentlyPublished: false, reviews: [],
      payload: { contentType: "project", locale: "en", title: "Draft project", summary: "Private summary", body: "Private body", candidateSlug: "draft-project" } }],
    publications: [], publicationHistory: [], lifecycleHistory: [], publicRouteIdentity: null, publicRoute: null,
    routeHistory: [], relatedProjectIds: [], relationshipHistory: [], taxonomyValueIds: [], taxonomyAssignments: [],
    mediaAssetIds: [], evidenceItems: [], publicDiscoveryOrder: null,
  };
}

function achievementRecord() {
  const contentId = id("31"), revisionId = id("32");
  return {
    contentId, contentType: "achievement", lifecycle: "archived", aggregateVersion: 2, candidateSlug: null,
    firstPublishedAt: null, projectStatus: null, featured: false,
    revisions: [{ revisionId, locale: "ar", sequence: 1, aggregateVersion: 1, savedAt: at, title: "إنجاز",
      summary: "ملخص محفوظ", body: "نص غير منشور", reviewed: false, currentlyPublished: false, reviews: [],
      payload: { contentType: "achievement", locale: "ar", title: "إنجاز", summary: "ملخص محفوظ", body: "نص غير منشور", achievedOn: "2026-09-12" } }],
    publications: [], publicationHistory: [], lifecycleHistory: [{ sequence: 1, previousLifecycle: "draft", lifecycle: "archived", aggregateVersion: 2, reason: "Retained privately", changedAt: at }],
    publicRouteIdentity: null, publicRoute: null, routeHistory: [], relatedProjectIds: [], relationshipHistory: [],
    taxonomyValueIds: [], taxonomyAssignments: [], mediaAssetIds: [], evidenceItems: [], publicDiscoveryOrder: null,
  };
}

function testimonialRecord() {
  const contentId = id("33"), revisionId = id("34");
  return {
    contentId, contentType: "testimonial", lifecycle: "draft", aggregateVersion: 1, candidateSlug: null,
    firstPublishedAt: null, projectStatus: null, featured: false,
    revisions: [{ revisionId, locale: "en", sequence: 1, aggregateVersion: 1, savedAt: at, title: "Private reference",
      summary: "Draft summary", body: "Draft body", reviewed: false, currentlyPublished: false, reviews: [],
      payload: { contentType: "testimonial", locale: "en", title: "Private reference", summary: "Draft summary", body: "Draft body",
        authorName: "Private source", quote: "A retained private quote.", association: { type: "project", projectId: id("11") } } }],
    publications: [], publicationHistory: [], lifecycleHistory: [], publicRouteIdentity: null, publicRoute: null,
    routeHistory: [], relatedProjectIds: [id("11")], relationshipHistory: [], taxonomyValueIds: [], taxonomyAssignments: [],
    mediaAssetIds: [], evidenceItems: [], publicDiscoveryOrder: null,
  };
}

function snapshot(scopes: OwnerExportSelectedSnapshot["includedScopes"]): OwnerExportSelectedSnapshot {
  const settings: PortfolioSettings = {
    portfolioId: portfolioId as PortfolioSettings["portfolioId"], version: 7,
    profile: { displayName: "Ada", headline: "Engineer", bio: "Portable owner settings.", mediaAssetId: id("21") as NonNullable<PortfolioSettings["profile"]["mediaAssetId"]> },
    contactChannels: [{ channel: "email", label: "Email", destination: "mailto:ada@example.test", availableLocales: ["en", "ar"] }],
    globalCta: { label: "Contact", destination: "https://example.test/contact", unavailableFallback: "Email me" },
  };
  const configuration = scopes.includes("portfolio-configuration") ? {
    snapshotId: snapshotId as OwnerExportSelectedSnapshot["snapshotId"], capturedAt: at, configurationVersion: settings.version, settings,
    capabilities: { currentCvAvailable: false, externalLinksAvailable: false, globalProjectCtaAvailable: true },
  } : undefined;
  const records = [projectRecord(), privateProjectRecord(), achievementRecord(), testimonialRecord()]
    .map((value) => ({ contentId: String(value.contentId), value: value as unknown as Readonly<Record<string, unknown>> }));
  return {
    kind: "owner-export-snapshot-v1", snapshotId: snapshotId as OwnerExportSelectedSnapshot["snapshotId"], capturedAt: at,
    includedScopes: scopes, content: { records }, ...(configuration === undefined ? {} : { configuration }),
  };
}

function zipEntry(bytes: Uint8Array, nameExpected: string): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const length = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true), extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30, name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    const contentStart = nameStart + nameLength + extraLength;
    if (name === nameExpected) return bytes.subarray(contentStart, contentStart + length);
    offset = contentStart + length;
  }
  throw new Error(`OWNER_EXPORT_TEST_ARCHIVE_ENTRY_MISSING:${nameExpected}`);
}

async function packageFor(scopes: OwnerExportSelectedSnapshot["includedScopes"]) {
  const built = await buildSelectedOwnerExportPackage({ exportId: exportId as Parameters<typeof buildSelectedOwnerExportPackage>[0]["exportId"], snapshot: snapshot(scopes) });
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const part of built.content) { parts.push(part); length += part.byteLength; }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return { built, bytes };
}

describe("content Owner export acceptance (#241)", () => {
  it("exports all private content histories, exact locale pointers, durable routes, and dependencies in a content-only package", async () => {
    const { built, bytes } = await packageFor(["portfolio-content"]);
    const validated = validateOwnerExportZip(bytes);
    const records = new TextDecoder().decode(zipEntry(bytes, "records/portfolio-content.ndjson")).trim().split("\n").map((line) => JSON.parse(line));
    const project = records.find((record) => record.value.contentId === id("10"))!.value;

    expect(validated.manifest.schemaVersion).toBe("1.3");
    expect(validated.includedScopes).toEqual(["portfolio-content"]);
    expect(validated.recordCounts).toEqual({ "portfolio-content": 4 });
    expect(project).toMatchObject({
      lifecycle: "hidden", projectStatus: { label: "Shipped", state: "active" }, featured: true,
      revisions: [
        { locale: "en", sequence: 1, currentlyPublished: false, reviews: [{ decision: "accepted" }] },
        { locale: "en", sequence: 2, currentlyPublished: true, reviews: [{ decision: "accepted" }] },
        { locale: "ar", sequence: 1, currentlyPublished: true, reviews: [{ decision: "accepted" }] },
      ],
      publications: [{ locale: "en", publicationSequence: 2 }, { locale: "ar", publicationSequence: 1 }],
      publicationHistory: expect.arrayContaining([
        expect.objectContaining({ locale: "en", sequence: 1 }),
        expect.objectContaining({ locale: "en", sequence: 2 }),
        expect.objectContaining({ locale: "ar", sequence: 1 }),
      ]),
      publicRoute: { canonicalSlug: "current-project", reservations: [{ slug: "old-project", isCurrent: false }, { slug: "current-project", isCurrent: true }] },
      routeHistory: [{ fromSlug: "old-project", toSlug: "current-project" }],
      relatedProjectIds: [id("11")], taxonomyAssignments: [{ taxonomyId: id("24"), valueId: id("23") }],
      mediaAssetIds: [id("21")], publicDiscoveryOrder: { firstPublishedAt: at, tieBreaker: "content-id-desc" },
    });
    expect(records.map((record) => record.value.lifecycle)).toEqual(["hidden", "draft", "archived", "draft"]);
    expect(new TextDecoder().decode(zipEntry(bytes, "records/portfolio-content.ndjson"))).not.toContain("portfolio-configuration");
    const dependencies = (validated.manifest as unknown as { dependencies: readonly unknown[] }).dependencies;
    expect(dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceScope: "portfolio-content", sourceId: id("10"), targetScope: "portfolio-content", targetId: id("11"), disposition: "included" }),
      expect.objectContaining({ sourceScope: "portfolio-content", sourceId: id("10"), targetScope: "taxonomy", targetId: id("23"), disposition: "omitted", reason: "scope-not-selected" }),
      expect.objectContaining({ sourceScope: "portfolio-content", sourceId: id("10"), targetScope: "media-metadata", targetId: id("21"), disposition: "omitted", reason: "scope-not-selected" }),
    ]));
    expect(validated.verifiedSchemaCount).toBe(2);
    expect(validated.dependencyCount).toBe(dependencies.length);
    expect(built.contentLength).toBe(bytes.byteLength);
  });

  it("combines exactly selected content and configuration rows and declares omitted cross-scope dependencies", async () => {
    const { built, bytes } = await packageFor(["portfolio-content", "portfolio-configuration"]);
    const validated = validateOwnerExportZip(bytes);
    const configuration = JSON.parse(new TextDecoder().decode(zipEntry(bytes, "records/portfolio-configuration.ndjson")));
    expect(validated.includedScopes).toEqual(["portfolio-content", "portfolio-configuration"]);
    expect(validated.recordCounts).toEqual({ "portfolio-content": 4, "portfolio-configuration": 1 });
    expect(configuration.value.profile.displayName).toBe("Ada");
    const dependencies = (validated.manifest as unknown as { dependencies: readonly unknown[] }).dependencies;
    expect(dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceScope: "portfolio-content", targetScope: "media-metadata", disposition: "omitted", reason: "scope-not-selected" }),
      expect.objectContaining({ sourceScope: "portfolio-configuration", targetScope: "media-metadata", disposition: "omitted", reason: "scope-not-selected" }),
    ]));
    if (built.manifest.schemaVersion !== "1.3") throw new Error("OWNER_EXPORT_CONTENT_SCHEMA_VERSION_INVALID");
    expect(built.manifest.schemas.map((schema) => schema.schemaVersion)).toEqual(["1.2", "1.2", "1.1"]);
  });
});
