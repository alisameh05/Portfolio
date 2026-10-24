/** Real Taxonomy/Content owner-export fixture for issue #242. */
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createContentAuthoringService } from "../../src/modules/content-publishing/application/authoring.js";
import { createPostgresContentAuthoringRepository } from "../../src/modules/content-publishing/adapters/postgres-authoring.js";
import { createPostgresContentTaxonomyAssignmentsPort } from "../../src/modules/content-publishing/adapters/postgres-taxonomy-assignments.js";
import { createPostgresContentTaxonomyExportAssignmentReader } from "../../src/modules/content-publishing/adapters/postgres-taxonomy-export-reader.js";
import { createPostgresProjectDiscoveryProjectionWriter } from "../../src/modules/taxonomy-discovery/adapters/postgres-project-discovery.js";
import { createPostgresTaxonomyOwnerRepository } from "../../src/modules/taxonomy-discovery/adapters/postgres-owner-taxonomies.js";
import { createTaxonomyOwnerService } from "../../src/modules/taxonomy-discovery/application/owner-taxonomies.js";
import { createTaxonomyOwnerExportSnapshotReader, type TaxonomyOwnerExportRecord } from "../../src/modules/taxonomy-discovery/application/taxonomy-export.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPortfolioSettingsService } from "../../src/modules/portfolio-configuration/application/settings-service.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createStableId } from "../../src/shared/domain/index.js";
import { hashCanonicalRequest } from "../../src/shared/application/idempotency.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";
import { createOwnerExportSnapshotReader } from "../../src/runtime/adapters/owner-export-snapshot.js";
import { buildSelectedOwnerExportPackage, type OwnerExportSelectedSnapshot } from "../../src/modules/portability-operations/application/owner-export-package.js";
import { validateOwnerExportZip } from "../../scripts/owner-export/validator.mjs";

interface TaxonomyManifest {
  readonly entries: readonly { readonly scope: string; readonly recordCount: number; readonly digest: string }[];
  readonly dependencies: readonly {
    readonly sourceScope: string;
    readonly sourceId: string;
    readonly targetScope: string;
    readonly targetId: string;
    readonly disposition: "included" | "omitted";
    readonly reason?: string;
  }[];
}

interface TaxonomyValidation {
  readonly includedScopes: readonly string[];
  readonly manifest: TaxonomyManifest;
}

function validateTaxonomyZip(bytes: Uint8Array): TaxonomyValidation {
  return validateOwnerExportZip(bytes) as unknown as TaxonomyValidation;
}

function taxonomyRecord(value: Readonly<Record<string, unknown>>): TaxonomyOwnerExportRecord {
  return value as unknown as TaxonomyOwnerExportRecord;
}

const APPLICATION_URL = process.env["PHASE8_OWNER_EXPORT_APPLICATION_URL"];
const WORKER_URL = process.env["PHASE8_OWNER_EXPORT_WORKER_URL"];
const ADMIN_URL = process.env["PHASE8_OWNER_EXPORT_ADMIN_URL"];
const enabled = Boolean(APPLICATION_URL && WORKER_URL && ADMIN_URL);

async function archiveBytes(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of content) { chunks.push(chunk); length += chunk.byteLength; }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

describe.runIf(enabled)("Phase 8 #242 real taxonomy export fixture", () => {
  it("AC01-06 captures complete taxonomy facts across an atomic merge and validates purpose and cleanup", async () => {
    if (!APPLICATION_URL || !WORKER_URL || !ADMIN_URL) throw new Error("PHASE8_OWNER_EXPORT_DATABASE_REQUIRED");
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const application = createPostgresRuntimeDatabase(APPLICATION_URL);
    const worker = createPostgresRuntimeDatabase(WORKER_URL);
    const scope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    const actor = { kind: "owner" as const, ownerId: scope.ownerId, sessionId: "phase8-owner-taxonomy-export" };
    const key = (value: string) => value as never;
    const ownerScopeHash = await hashCanonicalRequest({ ownerId: scope.ownerId });
    const operations = createPostgresOperationsPersistence(application.database);
    const repository = createPostgresContentAuthoringRepository();
    const taxonomyRepository = createPostgresTaxonomyOwnerRepository();
    const discovery = createPostgresProjectDiscoveryProjectionWriter();
    const taxonomy = createTaxonomyOwnerService({
      repository: taxonomyRepository,
      operations,
      scope,
      contentAssignments: createPostgresContentTaxonomyAssignmentsPort({ scope, discovery }),
      ids: createSystemIdGenerator(),
    });
    const content = createContentAuthoringService({
      repository,
      operations,
      scope,
      discoveryProjection: discovery,
      taxonomyAssignments: discovery,
      clock: { now: () => "2030-10-24T10:00:00.000Z" },
    });
    const snapshotRepository = createTaxonomyOwnerExportSnapshotReader({
      repository: taxonomyRepository,
      assignments: createPostgresContentTaxonomyExportAssignmentReader(),
    });
    const snapshotReader = createOwnerExportSnapshotReader({
      configuration: createPostgresPortfolioSettingsRepository(),
      content: repository,
      taxonomy: snapshotRepository,
      transactions: worker.transactions,
      capabilities: { async read() { return { currentCvAvailable: false, externalLinksAvailable: false }; } },
    });
    const fixtureIds: string[] = [];
    const fixtureTables = [
      "content.public_project_locales", "content.public_testimonial_locales", "content.public_achievement_locales",
      "taxonomy.project_discovery_taxonomy_values", "taxonomy.project_discovery_locales", "content.public_route_history",
      "content.public_route_reservations", "content.publication_history", "content.testimonial_publication_history",
      "content.language_publications", "content.testimonial_language_publications", "content.revision_reviews",
      "content.lifecycle_history", "content.project_status_history", "content.project_status_value_history",
      "content.project_relationship_history", "content.project_relationship_views", "content.project_relationships",
      "content.project_taxonomy_assignment_history", "content.project_taxonomy_assignments", "content.revisions",
      "content.public_routes", "content.items", "content.project_status_values", "taxonomy.value_history",
      "taxonomy.taxonomy_values", "taxonomy.roots",
    ] as const;
    let cleanupSucceeded = false;

    async function capture(scopes: readonly ("portfolio-content" | "taxonomy")[], reader = snapshotReader) {
      const result = await reader.capture({
        portfolioId: scope.portfolioId, ownerId: scope.ownerId,
        snapshotId: createStableId("OwnerExportArtifact"), includedScopes: scopes,
      });
      if (!result.ok) throw new Error("PHASE8_OWNER_TAXONOMY_SNAPSHOT_FAILED:" + result.error.code);
      if (!("kind" in result.value)) throw new Error("PHASE8_OWNER_TAXONOMY_SNAPSHOT_KIND_MISSING");
      return result.value;
    }

    async function workerCount(table: "taxonomy.roots" | "taxonomy.taxonomy_values" | "taxonomy.value_history" | "content.project_taxonomy_assignment_history", ownerId: string, purpose: string): Promise<number> {
      const probe = new Client({ connectionString: WORKER_URL });
      await probe.connect();
      try {
        await probe.query("begin");
        await probe.query(
          "select set_config('shipwithali.portfolio_id', $1, true), set_config('shipwithali.owner_id', $2, true), set_config('shipwithali.worker_purpose', $3, true)",
          [scope.portfolioId, ownerId, purpose],
        );
        const result = await probe.query(`select count(*)::int as count from ${table}`);
        await probe.query("rollback");
        return Number(result.rows[0]?.["count"] ?? 0);
      } finally { await probe.end(); }
    }

    try {
      const settings = createPortfolioSettingsService({
        repository: createPostgresPortfolioSettingsRepository(), transactions: application.transactions, scope,
      });
      const provisioned = await settings.provision({
        profile: { displayName: "Taxonomy fixture", headline: "Engineer", bio: "Synthetic taxonomy scope." },
        contactChannels: [{ channel: "email", label: "Email", destination: "mailto:owner@example.test", availableLocales: ["en"] }],
        globalCta: { label: "Contact", destination: "https://example.test/contact", unavailableFallback: "Contact the owner" },
      });
      if (!provisioned.ok) throw new Error("PHASE8_OWNER_TAXONOMY_SETTINGS_FAILED:" + provisioned.error.code);

      const project = await content.createContent({
        actor,
        idempotencyKey: key("phase8-taxonomy-project-create"),
        correlationId: "phase8-taxonomy-project-create",
        payload: {
          contentType: "project", locale: "en", title: "Taxonomy project", summary: "Project fixture summary",
          body: "Project fixture body", candidateSlug: "taxonomy-project",
          caseStudy: { problem: "Problem", ownerRole: "Owner", contributions: ["Built the service"], outcomes: ["Shipped"], lessons: "Keep history" },
        },
      });
      if (!project.ok) throw new Error("PHASE8_OWNER_TAXONOMY_PROJECT_FAILED:" + project.error.code);
      const projectId = project.value.contentId;
      fixtureIds.push(projectId);

      const stableTaxonomyId = "01890f3e-7b2f-7cc0-98cf-5a2890378ef8" as never;
      const initial = await taxonomy.getOwnerTaxonomy({ actor, taxonomyId: stableTaxonomyId });
      if (!initial.ok) throw new Error("PHASE8_OWNER_TAXONOMY_ROOT_FAILED:" + initial.error.code);
      const rootId = initial.value.taxonomyId;
      fixtureIds.push(rootId);
      const createValue = async (name: string, expectedVersion: number, requestKey: string) => {
        const created = await taxonomy.createOwnerTaxonomyValue({
          actor, idempotencyKey: key(requestKey), taxonomyId: rootId, expectedVersion, name,
        });
        if (!created.ok) throw new Error("PHASE8_OWNER_TAXONOMY_VALUE_FAILED:" + created.error.code);
        const current = await taxonomy.getOwnerTaxonomy({ actor, taxonomyId: rootId });
        if (!current.ok) throw new Error("PHASE8_OWNER_TAXONOMY_VALUE_READ_FAILED:" + current.error.code);
        const value = current.value.values.find((item) => item.name === name);
        if (value === undefined) throw new Error("PHASE8_OWNER_TAXONOMY_VALUE_MISSING");
        return { aggregateVersion: created.value.aggregateVersion, valueId: value.valueId };
      };
      const source = await createValue("Service", initial.value.aggregateVersion, "phase8-taxonomy-source-create");
      const target = await createValue("Services", source.aggregateVersion, "phase8-taxonomy-target-create");
      const retired = await createValue("Legacy", target.aggregateVersion, "phase8-taxonomy-retired-create");
      const renamed = await taxonomy.renameOwnerTaxonomyValue({
        actor, idempotencyKey: key("phase8-taxonomy-source-rename"), expectedVersion: retired.aggregateVersion,
        valueId: source.valueId, name: "Service Layer",
      });
      if (!renamed.ok) throw new Error("PHASE8_OWNER_TAXONOMY_RENAME_FAILED:" + renamed.error.code);
      const retiredResult = await taxonomy.retireOwnerTaxonomyValue({
        actor, idempotencyKey: key("phase8-taxonomy-value-retire"), expectedVersion: renamed.value.aggregateVersion,
        valueId: retired.valueId,
      });
      if (!retiredResult.ok) throw new Error("PHASE8_OWNER_TAXONOMY_RETIRE_FAILED:" + retiredResult.error.code);
      fixtureIds.push(source.valueId, target.valueId, retired.valueId);

      const assigned = await content.assignProjectTaxonomyValue({
        actor, projectId: projectId as never, valueId: source.valueId, expectedVersion: project.value.aggregateVersion,
        idempotencyKey: key("phase8-taxonomy-source-assign"), correlationId: "phase8-taxonomy-source-assign",
      });
      if (!assigned.ok) throw new Error("PHASE8_OWNER_TAXONOMY_ASSIGN_FAILED:" + assigned.error.code);

      let reachedAssignments!: () => void;
      let releaseAssignments!: () => void;
      const reached = new Promise<void>((resolve) => { reachedAssignments = resolve; });
      const barrier = new Promise<void>((resolve) => { releaseAssignments = resolve; });
      const assignmentReader = createPostgresContentTaxonomyExportAssignmentReader();
      const delayedAssignments = {
        async readOwnerExportAssignments(readScope: Parameters<typeof assignmentReader.readOwnerExportAssignments>[0], context: Parameters<typeof assignmentReader.readOwnerExportAssignments>[1]) {
          reachedAssignments();
          await barrier;
          return assignmentReader.readOwnerExportAssignments(readScope, context);
        },
      };
      const raceSnapshot = createTaxonomyOwnerExportSnapshotReader({ repository: taxonomyRepository, assignments: delayedAssignments });
      const raceReader = createOwnerExportSnapshotReader({
        configuration: createPostgresPortfolioSettingsRepository(), content: repository, taxonomy: raceSnapshot,
        transactions: worker.transactions, capabilities: { async read() { return { currentCvAvailable: false, externalLinksAvailable: false }; } },
      });
      const beforeMergePromise = capture(["taxonomy"], raceReader);
      await Promise.race([reached, beforeMergePromise.then(() => { throw new Error("PHASE8_OWNER_TAXONOMY_CAPTURE_COMPLETED_BEFORE_ASSIGNMENT_BARRIER"); })]);
      const merged = await taxonomy.mergeOwnerTaxonomyValue({
        actor, idempotencyKey: key("phase8-taxonomy-source-merge"), expectedVersion: retiredResult.value.aggregateVersion,
        sourceValueId: source.valueId, targetValueId: target.valueId,
      });
      if (!merged.ok) throw new Error("PHASE8_OWNER_TAXONOMY_MERGE_FAILED:" + merged.error.code);
      releaseAssignments();
      const beforeMerge = await beforeMergePromise;
      const beforeTaxonomy = taxonomyRecord(beforeMerge.taxonomy!.records.find((record) => record.taxonomyId === rootId)!.value);
      expect(beforeTaxonomy.aggregateVersion).toBe(retiredResult.value.aggregateVersion);
      expect(beforeTaxonomy.values.find((item) => item.valueId === source.valueId)?.state).toBe("active");
      expect(beforeTaxonomy.assignments).toEqual(expect.arrayContaining([expect.objectContaining({ targetId: projectId, taxonomyValueId: source.valueId })]));
      expect(beforeTaxonomy.evolutionHistory.some((event) => event.action === "merged")).toBe(false);

      const taxonomyOnly = await capture(["taxonomy"]);
      const taxRecords = taxonomyOnly.taxonomy!.records.map((record) => taxonomyRecord(record.value));
      const taxRecord = taxRecords.find((record) => record.taxonomyId === rootId)!;
      expect(taxRecords.map((record) => record.kind).sort()).toEqual(["ai-ml-domain", "category", "project-type", "technology"]);
      expect(taxRecord.values.find((item) => item.valueId === source.valueId)).toMatchObject({ state: "merged", name: "Service Layer", mergedIntoValueId: target.valueId });
      expect(taxRecord.values.find((item) => item.valueId === retired.valueId)).toMatchObject({ state: "retired", name: "Legacy" });
      expect(taxRecord.evolutionHistory.filter((event) => event.valueId === source.valueId).map((event) => event.action)).toEqual(["created", "renamed", "merged"]);
      expect(taxRecord.evolutionHistory.filter((event) => event.valueId === retired.valueId).map((event) => event.action)).toEqual(["created", "retired"]);
      expect(taxRecord.evolutionHistory.filter((event) => event.valueId === target.valueId).map((event) => event.action)).toEqual(["created"]);
      expect(taxRecord.evolutionHistory.at(0)).toMatchObject({ valueId: [source.valueId, target.valueId, retired.valueId].sort()[0] });
      expect(taxRecord.evolutionHistory.find((event) => event.action === "merged")).toMatchObject({ valueId: source.valueId, mergedIntoValueId: target.valueId });
      expect(taxRecord.assignments).toEqual(expect.arrayContaining([expect.objectContaining({ targetId: projectId, taxonomyValueId: target.valueId })]));
      expect(taxRecord.assignmentHistory.map((entry) => entry.taxonomyValueId)).toEqual([source.valueId, target.valueId]);

      const taxPackage = await buildSelectedOwnerExportPackage({ exportId: createStableId("OwnerExport"), snapshot: taxonomyOnly as OwnerExportSelectedSnapshot });
      const taxValidation = validateTaxonomyZip(await archiveBytes(taxPackage.content));
      expect(taxValidation.includedScopes).toEqual(["taxonomy"]);
      expect(taxValidation.manifest.entries).toHaveLength(1);
      expect(taxValidation.manifest.dependencies).toEqual(expect.arrayContaining([
        expect.objectContaining({ sourceScope: "taxonomy", sourceId: rootId, targetScope: "portfolio-content", targetId: projectId, disposition: "omitted", reason: "scope-not-selected" }),
      ]));

      const full = await capture(["portfolio-content", "taxonomy"]);
      const fullPackage = await buildSelectedOwnerExportPackage({ exportId: createStableId("OwnerExport"), snapshot: full as OwnerExportSelectedSnapshot });
      const fullValidation = validateTaxonomyZip(await archiveBytes(fullPackage.content));
      expect(fullValidation.includedScopes).toEqual(["portfolio-content", "taxonomy"]);
      expect(fullValidation.manifest.dependencies.filter((edge) => edge.targetScope === "portfolio-content")
        .every((edge) => edge.disposition === "included")).toBe(true);

      expect(await workerCount("taxonomy.roots", scope.ownerId, "taxonomy.owner-export")).toBe(4);
      expect(await workerCount("taxonomy.taxonomy_values", scope.ownerId, "taxonomy.owner-export")).toBeGreaterThanOrEqual(3);
      expect(await workerCount("taxonomy.value_history", scope.ownerId, "taxonomy.owner-export")).toBe(6);
      expect(await workerCount("taxonomy.value_history", scope.ownerId, "content.owner-export")).toBe(0);
      expect(await workerCount("taxonomy.value_history", createStableId("Owner"), "taxonomy.owner-export")).toBe(0);
      expect(await workerCount("content.project_taxonomy_assignment_history", scope.ownerId, "content.owner-export")).toBe(2);
      expect(await workerCount("content.project_taxonomy_assignment_history", scope.ownerId, "taxonomy.owner-export")).toBe(0);
      await expect(admin.query("select has_table_privilege('shipwithali_worker', 'taxonomy.taxonomy_values', 'insert') as can_insert, has_table_privilege('shipwithali_worker', 'taxonomy.taxonomy_values', 'update') as can_update")).resolves.toMatchObject({ rows: [{ can_insert: false, can_update: false }] });
    } finally {
      try {
        await admin.query("begin");
        await admin.query("set local session_replication_role = replica");
        await admin.query("delete from operations.idempotency_records where actor_scope = $1", [ownerScopeHash]);
        if (fixtureIds.length > 0) await admin.query("delete from operations.outbox_events where aggregate_id = any($1::uuid[])", [fixtureIds]);
        for (const table of fixtureTables) await admin.query(`delete from ${table} where portfolio_id = $1::uuid`, [scope.portfolioId]);
        await admin.query("delete from portfolio_config.contact_channels where portfolio_id = $1::uuid", [scope.portfolioId]);
        await admin.query("delete from portfolio_config.settings where portfolio_id = $1::uuid", [scope.portfolioId]);
        const remaining: number[] = [];
        for (const table of fixtureTables) {
          const result = await admin.query(`select count(*)::int as count from ${table} where portfolio_id = $1::uuid`, [scope.portfolioId]);
          remaining.push(Number(result.rows[0]?.["count"] ?? -1));
        }
        const settingsRemaining = await admin.query("select count(*)::int as count from portfolio_config.settings where portfolio_id = $1::uuid", [scope.portfolioId]);
        const idempotencyRemaining = await admin.query("select count(*)::int as count from operations.idempotency_records where actor_scope = $1", [ownerScopeHash]);
        const outboxRemaining = await admin.query("select count(*)::int as count from operations.outbox_events where aggregate_id = any($1::uuid[])", [fixtureIds]);
        remaining.push(Number(settingsRemaining.rows[0]?.["count"] ?? -1), Number(idempotencyRemaining.rows[0]?.["count"] ?? -1), Number(outboxRemaining.rows[0]?.["count"] ?? -1));
        cleanupSucceeded = remaining.every((count) => count === 0);
        if (cleanupSucceeded) await admin.query("commit");
      } finally {
        if (!cleanupSucceeded) await admin.query("rollback").catch(() => undefined);
        await application.resource.close();
        await worker.resource.close();
        await admin.end();
      }
    }
    expect(cleanupSucceeded).toBe(true);
  }, 30_000);
});
