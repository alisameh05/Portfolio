import { describe, expect, it } from "vitest";
import { validateOwnerExportZip } from "../../scripts/owner-export/validator.mjs";
import { buildSelectedOwnerExportPackage, type OwnerExportSelectedSnapshot } from "../../src/modules/portability-operations/application/owner-export-package.js";
import { createOwnerAnalyticsExportSnapshotService } from "../../src/modules/measurement/application/owner-analytics-export.js";
import type { StableId } from "@shared/domain";

const id = (tail: string) => `0196a1b2-7c3d-7e11-9f22-${tail.padStart(12, "0")}`;
const exportedAt = "2026-10-26T10:00:00.000Z";
const scopeOrder = ["portfolio-content", "taxonomy", "media-metadata", "cv-metadata", "moderation-history", "analytics-reports", "portfolio-configuration"] as const;
const exclusions = ["raw-public-event-data", "functional-visitor-identities", "measurement-visitor-identities", "sessions", "credentials", "lab-entries"];
const projectId = id("701");
const routeId = id("702");

async function analyticsSnapshot() {
  const goalId = id("703") as StableId<"AnalyticsGoal">;
  const service = createOwnerAnalyticsExportSnapshotService({
    goals: {
      async listGoals() { return [{ goalId, aggregateVersion: 1, activeVersionId: null }]; },
      async listVersions() { return [{ versionId: id("704") as StableId<"AnalyticsGoalVersion">, versionNumber: 1,
        definition: { name: "Project views", steps: [{ action: "project-viewed" as const,
          projectIds: [projectId as StableId<"Project">], publicRouteIds: [routeId as StableId<"PublicRoute">] }] },
        createdAt: exportedAt }]; },
      async listActivations() { return []; },
      async getGoal() { return null; },
      async lockGoal() {},
      async insertGoal() {},
      async appendVersion() {},
      async activateVersion() { return 0; },
    },
    aggregates: {
      async readReport() {
        return { rows: [], asOf: exportedAt, incomplete: false };
      },
    },
  });
  const captured = await service.readOwnerAnalyticsExportSnapshot({
    portfolioId: id("707") as StableId<"Portfolio">, ownerId: id("708") as StableId<"Owner">,
    capturedAt: exportedAt, transaction: { kind: "transaction" },
  });
  if (!captured.ok) throw new Error("ANALYTICS_FIXTURE_UNAVAILABLE");
  return captured.value;
}

async function snapshot(includedScopes: readonly OwnerExportSelectedSnapshot["includedScopes"][number][]): Promise<OwnerExportSelectedSnapshot> {
  const analytics = await analyticsSnapshot();
  return {
    kind: "owner-export-snapshot-v1",
    snapshotId: id("705") as OwnerExportSelectedSnapshot["snapshotId"],
    capturedAt: exportedAt,
    includedScopes,
    policyExpiresAt: analytics.policyExpiresAt,
    configuration: { snapshotId: id("705") as OwnerExportSelectedSnapshot["snapshotId"], capturedAt: exportedAt,
      configurationVersion: null, settings: null,
      capabilities: { currentCvAvailable: false, externalLinksAvailable: false, globalProjectCtaAvailable: false } },
    content: { records: [] },
    taxonomy: { records: [] },
    media: { records: [], assets: [] },
    cv: { capturedAt: exportedAt, aggregateVersion: 1, currentVersionId: null, versions: [], versionsTruncated: false,
      acceptanceHistory: [], acceptanceHistoryTruncated: false, activationHistory: [], activationHistoryTruncated: false },
    cvAssets: [],
    moderation: { records: [] },
    moderationCheckpoint: { recordsDigest: "a".repeat(64), dependencies: [] },
    analytics,
  };
}

async function build(scopes: readonly OwnerExportSelectedSnapshot["includedScopes"][number][]) {
  const built = await buildSelectedOwnerExportPackage({
    exportId: id("706") as Parameters<typeof buildSelectedOwnerExportPackage>[0]["exportId"],
    portfolioId: id("707") as NonNullable<Parameters<typeof buildSelectedOwnerExportPackage>[0]["portfolioId"]>,
    snapshot: await snapshot(scopes),
    objects: { async readMediaExportObject() { throw new Error("empty fixtures must not read Media objects"); } },
  });
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of built.content) { chunks.push(chunk); length += chunk.byteLength; }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { built, bytes, checked: validateOwnerExportZip(bytes) };
}

describe("Issue #247 package reconciliation across registered scopes", () => {
  it("AC08 preserves exact scope coverage and privacy exclusions for every single-scope package", async () => {
    for (const scope of scopeOrder) {
      const { checked } = await build([scope]);
      expect(checked.includedScopes).toEqual([scope]);
      expect(checked.manifest.entries.map((entry) => entry.scope)).toEqual([scope]);
      expect(checked.manifest.exclusions).toEqual(exclusions);
      expect(checked.recordCounts[scope]).toBe(scope === "analytics-reports" ? 1 : scope === "cv-metadata" ? 1 : 0);
    }
  });

  it("AC08 composes cross-group selections and marks exact retained versus omitted dependencies", async () => {
    const selections: readonly (readonly OwnerExportSelectedSnapshot["includedScopes"][number][])[] = [
      ["portfolio-content", "analytics-reports"],
      ["analytics-reports", "portfolio-configuration"],
      ["media-metadata", "cv-metadata", "analytics-reports"],
    ];
    for (const scopes of selections) {
      const { checked } = await build(scopes);
      expect(checked.manifest.schemaVersion).toBe("1.9");
      expect(checked.includedScopes).toEqual(scopeOrder.filter((scope) => scopes.includes(scope)));
      expect(checked.manifest.entries.map((entry) => entry.scope)).toEqual(checked.includedScopes);
      expect(checked.manifest.exclusions).toEqual(exclusions);
      expect(checked.manifest.dependencies).toEqual(scopes.includes("analytics-reports") ? [
        { sourceScope: "analytics-reports", sourceId: id("703"), targetScope: "portfolio-content", targetId: projectId,
          disposition: "omitted", reason: scopes.includes("portfolio-content") ? "not-retained" : "scope-not-selected" },
        { sourceScope: "analytics-reports", sourceId: id("703"), targetScope: "portfolio-content", targetId: routeId,
          disposition: "omitted", reason: scopes.includes("portfolio-content") ? "not-retained" : "scope-not-selected" },
      ] : []);
    }
  });

  it("AC08 emits the complete seven-scope package in canonical order with no privacy expansion", async () => {
    const { checked } = await build(scopeOrder);
    expect(checked.manifest.schemaVersion).toBe("1.9");
    expect(checked.includedScopes).toEqual(scopeOrder);
    expect(checked.manifest.entries.map((entry) => entry.scope)).toEqual(scopeOrder);
    expect(checked.manifest.exclusions).toEqual(exclusions);
    expect(checked.manifest.dependencies).toHaveLength(2);
    expect(checked.dependencyCount).toBe(2);
  });
});
