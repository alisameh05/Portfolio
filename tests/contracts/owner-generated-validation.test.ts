import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  zChangeOwnerProjectPublicSlugBody,
  zContentAggregateView,
  zCreateOwnerContentBody,
  zCreateOwnerProjectStatusValueBody,
  zCreateOwnerTaxonomyValueBody,
  zCorrectOwnerProjectCandidateSlugBody,
  zProjectAggregateView,
  zProjectStatusValueReceipt,
  zPublishOwnerContentLanguageBody,
  zPublishOwnerContentLanguageHeaders,
  zPublishOwnerContentLanguagePath,
  zReviewOwnerContentRevisionBody,
  zSaveOwnerContentRevisionBody,
  zSaveOwnerContentRevisionResponse,
  zTaxonomyAggregateView,
  zUpdateOwnerContactChannelsBody,
  zUpdateOwnerGlobalProjectCtaBody,
  zUpdateOwnerProfileConfigurationBody,
} from "../../src/contracts/http/owner/v1/generated/zod.gen.js";

type ExampleOperation = {
  requestBody: {
    content: { "application/json": { examples: Record<string, { value: unknown }> } };
  };
};
const bundle = JSON.parse(
  readFileSync("openapi/generated/owner-v1.json", "utf8"),
) as { paths: Record<string, Record<string, ExampleOperation>> };
const requestExample = (path: string, method: string, name: string) =>
  bundle.paths[path]![method]!.requestBody.content["application/json"].examples[name]!.value;

const ids = {
  content: "01890f3e-7b2f-7cc0-98cf-5a2890378ef1",
  revision: "01890f3e-7b2f-7cc0-98cf-5a2890378ef2",
  route: "01890f3e-7b2f-7cc0-98cf-5a2890378ef3",
  status: "01890f3e-7b2f-7cc0-98cf-5a2890378ef4",
  related: "01890f3e-7b2f-7cc0-98cf-5a2890378ef5",
  taxonomy: "01890f3e-7b2f-7cc0-98cf-5a2890378ef6",
  value: "01890f3e-7b2f-7cc0-98cf-5a2890378ef7",
};

describe("generated Owner v1 validators", () => {
  it("accepts every declared request example", () => {
    for (const kind of ["project", "achievement", "testimonial"]) {
      expect(zCreateOwnerContentBody.safeParse(requestExample(
        "/api/owner/v1/content", "post", kind,
      )).success).toBe(true);
    }
    expect(zUpdateOwnerProfileConfigurationBody.safeParse(requestExample(
      "/api/owner/v1/configuration/profile", "put", "profile",
    )).success).toBe(true);
    expect(zUpdateOwnerContactChannelsBody.safeParse(requestExample(
      "/api/owner/v1/configuration/contact-channels", "put", "linkedin",
    )).success).toBe(true);
    expect(zUpdateOwnerGlobalProjectCtaBody.safeParse(requestExample(
      "/api/owner/v1/configuration/project-cta", "put", "discuss",
    )).success).toBe(true);
    expect(zSaveOwnerContentRevisionBody.safeParse(requestExample(
      "/api/owner/v1/content/{contentId}/revisions", "post", "english",
    )).success).toBe(true);
    expect(zPublishOwnerContentLanguageBody.safeParse(requestExample(
      "/api/owner/v1/content/{contentId}/commands/publish-language", "post", "publishEnglish",
    )).success).toBe(true);
    expect(zChangeOwnerProjectPublicSlugBody.safeParse(requestExample(
      "/api/owner/v1/projects/{projectId}/commands/change-slug", "post", "canonical",
    )).success).toBe(true);
    expect(zReviewOwnerContentRevisionBody.safeParse(requestExample(
      "/api/owner/v1/content/{contentId}/revisions/{revisionId}/review", "post", "accepted",
    )).success).toBe(true);
    expect(zCreateOwnerTaxonomyValueBody.safeParse(requestExample(
      "/api/owner/v1/taxonomies/{taxonomyId}/values", "post", "technology",
    )).success).toBe(true);
    expect(zCreateOwnerProjectStatusValueBody.safeParse(requestExample(
      "/api/owner/v1/project-status-values", "post", "shipped",
    )).success).toBe(true);
  });

  it("accepts representative independent-locale command inputs", () => {
    expect(zSaveOwnerContentRevisionBody.safeParse({
      locale: "ar",
      title: "مشروع",
      summary: "ملخص مستقل",
      body: "محتوى تمت مراجعته بصورة مستقلة.",
    }).success).toBe(true);
    expect(zPublishOwnerContentLanguageBody.safeParse({
      locale: "en",
      revisionId: ids.revision,
    }).success).toBe(true);
  });

  it("requires strict headers and stable path identity", () => {
    expect(zPublishOwnerContentLanguageHeaders.safeParse({
      "Idempotency-Key": "publish-en-42",
      "If-Match": '"7"',
    }).success).toBe(true);
    expect(zPublishOwnerContentLanguageHeaders.safeParse({
      "Idempotency-Key": "publish-en-42",
    }).success).toBe(false);
    expect(zPublishOwnerContentLanguageHeaders.safeParse({
      "Idempotency-Key": "contains space",
      "If-Match": '"7"',
    }).success).toBe(false);
    expect(zPublishOwnerContentLanguageHeaders.safeParse({
      "Idempotency-Key": "publish-en-42",
      "If-Match": "7",
    }).success).toBe(false);
    expect(zPublishOwnerContentLanguagePath.safeParse({ contentId: ids.content }).success).toBe(true);
    expect(zPublishOwnerContentLanguagePath.safeParse({ contentId: "project-slug" }).success).toBe(false);
  });

  it("rejects unknown and provider-shaped command properties", () => {
    expect(zCreateOwnerContentBody.safeParse({
      contentType: "project",
      locale: "en",
      title: "Atlas Search",
      summary: "A bounded search workflow.",
      body: "Draft overview.",
      candidateSlug: "atlas-search",
      supabaseProjectId: "private",
    }).success).toBe(false);
    expect(zUpdateOwnerProfileConfigurationBody.safeParse({
      displayName: "Ali Sameh",
      headline: "Engineer",
      bio: "Bio",
      supabaseUserId: "provider-123",
    }).success).toBe(false);
    expect(zUpdateOwnerContactChannelsBody.safeParse({
      channels: [{
        channel: "linkedin",
        label: "LinkedIn",
        destination: "https://www.linkedin.com/in/example",
        availableLocales: ["en"],
        accessToken: "secret",
      }],
    }).success).toBe(false);
    expect(zPublishOwnerContentLanguageBody.safeParse({
      locale: "en",
      revisionId: ids.revision,
      publishArabicToo: true,
    }).success).toBe(false);
  });

  it("rejects mismatched content kinds and unsupported locales in strict Draft payloads", () => {
    const base = {
      contentType: "project",
      locale: "en",
      title: "Atlas Search",
      summary: "A bounded search workflow.",
      body: "Draft overview.",
      candidateSlug: "atlas-search",
    };
    expect(zCreateOwnerContentBody.safeParse({ ...base, locale: "fr" }).success).toBe(false);
    expect(zCreateOwnerContentBody.safeParse({
      ...base,
      testimonial: { authorName: "A", quote: "B" },
    }).success).toBe(false);
    expect(zCorrectOwnerProjectCandidateSlugBody.safeParse({ candidateSlug: "draft-2" }).success).toBe(true);
    expect(zCorrectOwnerProjectCandidateSlugBody.safeParse({ candidateSlug: "Draft 2" }).success).toBe(false);
    expect(zCreateOwnerProjectStatusValueBody.safeParse({ label: "Shipped", privateNote: "leak" }).success).toBe(false);
  });

  it("accepts reference-only evidence, media, and Project links in create and localized save contracts", () => {
    const artifact = { id: ids.value, title: "Demo", mediaAssetId: ids.taxonomy, destinationUrl: "https://example.com/demo" };
    const projectLink = { id: ids.route, label: "Live project", destination: "https://example.com/project", isAvailableInArabic: true };
    expect(zCreateOwnerContentBody.safeParse({
      contentType: "project", locale: "en", title: "Atlas", summary: "Draft", body: "Draft body",
      evidence: { artifacts: [artifact] }, externalLinks: [projectLink],
    }).success).toBe(true);
    expect(zSaveOwnerContentRevisionBody.safeParse({
      locale: "ar", title: "أطلس", summary: "مسودة", body: "محتوى أولي",
      draftData: { contentType: "project", evidence: { artifacts: [artifact] }, externalLinks: [projectLink] },
    }).success).toBe(true);
    expect(zCreateOwnerContentBody.safeParse({
      contentType: "achievement", locale: "en", title: "Milestone", summary: "Draft", body: "Draft body",
      evidence: { artifacts: [artifact] },
    }).success).toBe(true);
    expect(zSaveOwnerContentRevisionBody.safeParse({
      locale: "ar", title: "إنجاز", summary: "مسودة", body: "محتوى أولي",
      draftData: { contentType: "achievement", evidence: { artifacts: [artifact] } },
    }).success).toBe(true);
    expect(zCreateOwnerContentBody.safeParse({
      contentType: "project", locale: "en", title: "Atlas", summary: "Draft", body: "Draft body",
      evidence: { artifacts: [{ ...artifact, mediaAssetId: "not-an-id" }] },
    }).success).toBe(false);
  });

  it("validates narrow aggregate views without table or provider fields", () => {
    expect(zContentAggregateView.safeParse({
      contentId: ids.content,
      aggregateVersion: 7,
      contentType: "project",
      lifecycle: "published",
      localizedStreams: {
        en: { revisionCount: 3, currentPublishedRevisionId: ids.revision },
        ar: { revisionCount: 1, currentPublishedRevisionId: null },
      },
      revisions: [
        { revisionId: ids.revision, locale: "en", sequence: 3, reviewed: true },
      ],
    }).success).toBe(true);
    expect(zContentAggregateView.safeParse({
      contentId: ids.content,
      aggregateVersion: 7,
      contentType: "project",
      lifecycle: "published",
      localizedStreams: {
        en: { revisionCount: 3, currentPublishedRevisionId: ids.revision },
        duplicateEnglish: { revisionCount: 1, currentPublishedRevisionId: null },
      },
      revisions: [],
    }).success).toBe(false);
    expect(zContentAggregateView.safeParse({
      contentId: ids.content,
      aggregateVersion: 7,
      contentType: "project",
      lifecycle: "published",
      localizedStreams: { en: { revisionCount: 3 } },
      revisions: [],
    }).success).toBe(false);
    expect(zSaveOwnerContentRevisionResponse.safeParse({
      aggregateId: ids.content,
      aggregateVersion: 8,
      outcome: "revision-saved",
      revisionId: ids.revision,
    }).success).toBe(true);
    expect(zProjectStatusValueReceipt.safeParse({
      valueId: ids.status,
      label: "Shipped",
      state: "active",
      aggregateVersion: 2,
      outcome: "project-status-value-created",
    }).success).toBe(true);
    expect(zProjectStatusValueReceipt.safeParse({
      valueId: ids.status,
      label: "Shipped",
      state: "active",
      aggregateVersion: 2,
      outcome: "project-status-value-created",
      ownerEmail: "private@example.test",
    }).success).toBe(false);
    expect(zProjectAggregateView.safeParse({
      projectId: ids.content,
      aggregateVersion: 7,
      statusValueId: ids.status,
      featured: true,
      publicRoute: {
        identity: ids.route,
        canonicalSlug: "evidence-led-portfolio",
        redirects: [
          { fromSlug: "old-portfolio", toSlug: "evidence-led-portfolio" },
        ],
      },
      relatedProjectIds: [ids.related],
      taxonomyAssignments: [
        { taxonomyId: ids.taxonomy, taxonomyKind: "technology", valueId: ids.value },
      ],
    }).success).toBe(true);
    expect(zProjectAggregateView.safeParse({
      projectId: ids.content,
      aggregateVersion: 7,
      featured: false,
      publicRoute: null,
      relatedProjectIds: [],
      taxonomyAssignments: [],
    }).success).toBe(false);
    expect(zTaxonomyAggregateView.safeParse({
      taxonomyId: ids.taxonomy,
      aggregateVersion: 4,
      kind: "technology",
      values: [{ valueId: ids.value, name: "TypeScript", state: "active" }],
    }).success).toBe(true);
    expect(zTaxonomyAggregateView.safeParse({
      taxonomyId: ids.taxonomy,
      aggregateVersion: 4,
      kind: "technology",
      values: [{ valueId: ids.value, name: "Legacy", state: "merged" }],
    }).success).toBe(false);
    expect(zTaxonomyAggregateView.safeParse({
      taxonomyId: ids.taxonomy,
      aggregateVersion: 4,
      kind: "technology",
      values: [{
        valueId: ids.value,
        name: "TypeScript",
        state: "active",
        mergedIntoValueId: ids.related,
      }],
    }).success).toBe(false);
    expect(zTaxonomyAggregateView.safeParse({
      taxonomyId: ids.taxonomy,
      aggregateVersion: 4,
      kind: "technology",
      values: [{
        valueId: ids.value,
        name: "Legacy",
        state: "merged",
        mergedIntoValueId: ids.related,
      }],
    }).success).toBe(true);
    expect(zTaxonomyAggregateView.safeParse({
      taxonomyId: ids.taxonomy,
      aggregateVersion: 4,
      kind: "technology",
      values: [],
      tableName: "taxonomy_values",
    }).success).toBe(false);
  });
});
