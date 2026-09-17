import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  zActivateOwnerAnalyticsGoalVersionBody,
  zActivateOwnerAnalyticsGoalVersionHeaders,
  zAnalyticsGoalAggregateView,
  zCreateOwnerAnalyticsGoalVersionBody,
  zCreateOwnerAnalyticsGoalVersionHeaders,
  zOwnerExportRecord,
  zOwnerExportView,
  zRequestOwnerExportBody,
  zRequestOwnerExportHeaders,
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
  goal: "01890f3e-7b2f-7cc0-98cf-5a2890378ef1",
  version: "01890f3e-7b2f-7cc0-98cf-5a2890378ef2",
  export: "01890f3e-7b2f-7cc0-98cf-5a2890378ef3",
  project: "01890f3e-7b2f-7cc0-98cf-5a2890378ef4",
  taxonomy: "01890f3e-7b2f-7cc0-98cf-5a2890378ef5",
  value: "01890f3e-7b2f-7cc0-98cf-5a2890378ef6",
  media: "01890f3e-7b2f-7cc0-98cf-5a2890378ef7",
  route: "01890f3e-7b2f-7cc0-98cf-5a2890378ef8",
};
const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const readyExport = {
  exportId: ids.export,
  state: "ready",
  schemaVersion: "1.0",
  requestedAt: "2026-09-18T00:00:00Z",
  completedAt: "2026-09-18T00:01:00Z",
  includedScopes: ["analytics-reports"],
  publicEventDataCoverage: { mode: "excluded" },
  integrityManifest: {
    packageFormat: "shipwithali-owner-export",
    schemaVersion: "1.0",
    createdAt: "2026-09-18T00:01:00Z",
    algorithm: "sha-256",
    digest,
    includedScopes: ["analytics-reports"],
    publicEventDataCoverage: { mode: "excluded" },
    entries: [{
      path: "records/analytics-reports.ndjson",
      scope: "analytics-reports",
      mediaType: "application/x-ndjson",
      recordSchema: "urn:shipwithali:owner-export-schema:analytics-reports:1.0",
      schemaPath: "schemas/analytics-reports.schema.json",
      schemaVersion: "1.0",
      digest,
      recordCount: 42,
    }],
  },
  downloadAvailable: true,
} as const;

describe("generated Owner Measurement validators", () => {
  it("accepts the declared goal-version definition and activation intent", () => {
    expect(zCreateOwnerAnalyticsGoalVersionBody.safeParse(requestExample(
      "/api/owner/v1/analytics-goals/{goalId}/versions",
      "post",
      "projectContactJourney",
    )).success).toBe(true);
    expect(zActivateOwnerAnalyticsGoalVersionBody.safeParse({
      versionId: ids.version,
    }).success).toBe(true);
    expect(zCreateOwnerAnalyticsGoalVersionBody.safeParse({
      definition: {
        name: "Scoped project view",
        steps: [{ action: "project-viewed", publicRouteIds: [ids.goal] }],
      },
    }).success).toBe(true);
    expect(zCreateOwnerAnalyticsGoalVersionBody.safeParse({
      definition: {
        name: "Old route synonym",
        steps: [{ action: "project-viewed", pageRouteIds: [ids.goal] }],
      },
    }).success).toBe(false);
  });

  it("requires idempotency and concurrency for both existing-goal mutations", () => {
    const headers = {
      "Idempotency-Key": "analytics-goal-version-1",
      "If-Match": '"2"',
    };

    expect(zCreateOwnerAnalyticsGoalVersionHeaders.safeParse(headers).success).toBe(true);
    expect(zActivateOwnerAnalyticsGoalVersionHeaders.safeParse(headers).success).toBe(true);
    expect(zCreateOwnerAnalyticsGoalVersionHeaders.safeParse({
      "Idempotency-Key": "analytics-goal-version-1",
    }).success).toBe(false);
  });

  it("keeps goal definitions closed and retains at least one immutable version", () => {
    expect(zCreateOwnerAnalyticsGoalVersionBody.safeParse({
      definition: {
        name: "Project view to contact",
        steps: [{ action: "project-viewed", providerEventId: "analytics-123" }],
      },
    }).success).toBe(false);
    expect(zAnalyticsGoalAggregateView.safeParse({
      goalId: ids.goal,
      aggregateVersion: 2,
      activeVersionId: ids.version,
      versions: [{
        versionId: ids.version,
        versionNumber: 1,
        definition: {
          name: "Project view to contact",
          steps: [{ action: "project-viewed" }, { action: "contact-channel-opened" }],
        },
        createdAt: "2026-09-18T00:00:00Z",
      }],
      activationHistory: [{
        versionId: ids.version,
        activatedAt: "2026-09-18T00:01:00Z",
      }],
    }).success).toBe(true);
    expect(zAnalyticsGoalAggregateView.safeParse({
      goalId: ids.goal,
      aggregateVersion: 1,
      activeVersionId: ids.version,
      versions: [{
        versionId: ids.version,
        versionNumber: 1,
        definition: {
          name: "Project view to contact",
          steps: [{ action: "project-viewed" }],
        },
        state: "active",
        createdAt: "2026-09-18T00:00:00Z",
        activatedAt: null,
      }],
    }).success).toBe(false);
    expect(zAnalyticsGoalAggregateView.safeParse({
      goalId: ids.goal,
      aggregateVersion: 1,
      activeVersionId: null,
      versions: [],
      activationHistory: [],
    }).success).toBe(false);
  });
});

describe("generated Owner Portability validators", () => {
  it("accepts the declared export request with creation-only idempotency", () => {
    expect(zRequestOwnerExportBody.safeParse(requestExample(
      "/api/owner/v1/exports",
      "post",
      "portablePortfolio",
    )).success).toBe(true);
    expect(zRequestOwnerExportHeaders.safeParse({
      "Idempotency-Key": "owner-export-1",
    }).success).toBe(true);
    expect(zRequestOwnerExportHeaders.safeParse({
      "Idempotency-Key": "owner-export-1",
      "If-Match": '"1"',
    }).success).toBe(false);
    expect(zRequestOwnerExportBody.parse({
      includedScopes: ["portfolio-content"],
    })).toEqual({ includedScopes: ["portfolio-content"] });
    expect(zRequestOwnerExportBody.safeParse({
      includedScopes: ["analytics-reports"],
      includeRetainedPublicEventData: true,
    }).success).toBe(false);
  });

  it("models a versioned domain artifact with integrity metadata", () => {
    expect(zOwnerExportView.safeParse(readyExport).success).toBe(true);
  });

  it("validates portable records for every documented export scope", () => {
    const records = [
      {
        scope: "portfolio-content",
        contentId: ids.project,
        contentType: "project",
        lifecycle: "published",
        revisions: [{
          revisionId: ids.version,
          locale: "en",
          sequence: 1,
          title: "Evidence-led portfolio",
          summary: "A portable content record.",
          body: "Documented content body.",
          reviewed: true,
          currentlyPublished: true,
        }],
        publicRouteIdentity: ids.route,
        routeHistory: [{ fromSlug: "old-portfolio", toSlug: "evidence-led-portfolio" }],
        relatedProjectIds: [],
        taxonomyValueIds: [ids.value],
        mediaAssetIds: [ids.media],
        evidenceItems: [{
          claim: "The implementation passed its contract gate.",
          state: "supported",
          supportingArtifactIds: [ids.media],
        }],
      },
      {
        scope: "taxonomy",
        taxonomyId: ids.taxonomy,
        aggregateVersion: 1,
        kind: "technology",
        values: [{ valueId: ids.value, name: "TypeScript", state: "active" }],
        renameHistory: [{
          valueId: ids.value,
          previousName: "TS",
          newName: "TypeScript",
          renamedAt: "2026-09-17T00:00:00Z",
        }],
        assignments: [{ projectId: ids.project, valueId: ids.value }],
      },
      {
        scope: "media-metadata",
        mediaId: ids.media,
        kind: "image",
        state: "accepted",
        accessibilityMetadata: { kind: "described-image", altText: "Portfolio result." },
        processingHistory: [],
        decisionHistory: [{ decision: "accepted", decidedAt: "2026-09-17T01:00:00Z" }],
        publicationState: "accepted",
        portableReference: "media/portfolio-result.png",
      },
      {
        scope: "cv-metadata",
        aggregateVersion: 1,
        currentVersionId: null,
        versions: [],
        activationHistory: [],
      },
      {
        scope: "moderation-history",
        feedbackId: ids.goal,
        projectId: ids.project,
        locale: "en",
        aggregateVersion: 1,
        state: "pending",
        authorName: "Portfolio visitor",
        paragraph: "Useful work.",
        submittedAt: "2026-09-18T00:00:00Z",
        decisionHistory: [],
      },
      {
        scope: "analytics-reports",
        goal: {
          goalId: ids.goal,
          aggregateVersion: 2,
          activeVersionId: ids.version,
          versions: [{
            versionId: ids.version,
            versionNumber: 1,
            definition: {
              name: "Project view to contact",
              steps: [{ action: "project-viewed" }, { action: "contact-channel-opened" }],
            },
            createdAt: "2026-09-01T00:00:00Z",
          }],
          activationHistory: [{ versionId: ids.version, activatedAt: "2026-09-01T01:00:00Z" }],
        },
        reports: [{
          goalVersionId: ids.version,
          periodStart: "2026-09-01T00:00:00Z",
          periodEnd: "2026-09-18T00:00:00Z",
          sampleState: "low-sample",
          aggregateCount: 3,
        }],
      },
      {
        scope: "portfolio-configuration",
        profile: {
          displayName: "Ali Sameh",
          headline: "AI/ML product engineer",
          bio: "Evidence-led portfolio owner.",
        },
        contactChannels: { channels: [] },
        projectCta: {
          label: "Discuss this project",
          destination: "https://example.com/contact",
          unavailableFallback: "Contact details are currently unavailable.",
        },
      },
    ] as const;

    for (const record of records) {
      expect(zOwnerExportRecord.safeParse(record).success).toBe(true);
    }

    const roundTripped = JSON.parse(JSON.stringify(records)) as Array<Record<string, unknown>>;
    for (const record of roundTripped) {
      expect(zOwnerExportRecord.safeParse(record).success).toBe(true);
    }
    expect(roundTripped[0]?.["taxonomyValueIds"]).toContain(ids.value);
    expect(roundTripped[1]?.["assignments"]).toContainEqual({
      projectId: ids.project,
      valueId: ids.value,
    });

    expect(zOwnerExportRecord.safeParse({
      ...records[0],
      taxonomyValueIds: undefined,
    }).success).toBe(false);
    expect(zOwnerExportRecord.safeParse({
      ...records[2],
      portableReference: undefined,
    }).success).toBe(false);
    expect(zOwnerExportRecord.safeParse({
      ...records[4],
      projectId: undefined,
    }).success).toBe(false);
    expect(zOwnerExportRecord.safeParse({
      ...records[5],
      visitorName: "Private visitor",
      feedbackText: "Private feedback",
      cvContents: "Private CV text",
      accessToken: "secret",
      ipAddress: "203.0.113.1",
    }).success).toBe(false);
  });

  it("rejects provider backups, provider fields, and malformed versions", () => {
    expect(zRequestOwnerExportBody.safeParse({
      includedScopes: ["database-backup"],
    }).success).toBe(false);
    expect(zOwnerExportView.safeParse({ ...readyExport, schemaVersion: "latest" }).success).toBe(false);
    expect(zOwnerExportView.safeParse({ ...readyExport, supabaseBucket: "backups" }).success).toBe(false);
    expect(zOwnerExportView.safeParse({
      ...readyExport,
      completedAt: null,
      integrityManifest: null,
    }).success).toBe(false);
    expect(zOwnerExportView.safeParse({
      exportId: ids.export,
      state: "failed",
      schemaVersion: "1.0",
      requestedAt: "2026-09-18T00:00:00Z",
      failedAt: "2026-09-18T00:01:00Z",
      failureCode: "package_build_failed",
      includedScopes: ["portfolio-content"],
      publicEventDataCoverage: { mode: "excluded" },
      downloadAvailable: true,
    }).success).toBe(false);
    expect(zOwnerExportView.safeParse({
      ...readyExport,
      integrityManifest: {
        ...readyExport.integrityManifest,
        entries: [{
          ...readyExport.integrityManifest.entries[0],
          recordSchema: "urn:shipwithali:owner-export-schema:analytics-reports:2.0",
        }],
      },
    }).success).toBe(false);
  });
});
