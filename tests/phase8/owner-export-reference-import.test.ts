import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanupOwnerExportReference, independentlyReadOwnerExportZip, importOwnerExportReference } from "../../scripts/owner-export/reference-importer.mjs";
import { buildOwnerExportReferenceModel } from "../../scripts/owner-export/reference-model.mjs";
import { ownerExportManifestDigest, validateOwnerExportZip } from "../../scripts/owner-export/validator.mjs";
import { buildSelectedOwnerExportPackage, createStoredOwnerExportZip } from "../../src/modules/portability-operations/application/owner-export-package.js";
import { expectedFacts, fixtureIds, mediaBytesByObjectId, scopeOrder, snapshotFor } from "./owner-export-reference-fixture.js";

async function collect(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of content) { chunks.push(chunk); length += chunk.byteLength; }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function fullArchive() {
  const data = mediaBytesByObjectId();
  const snapshot = await snapshotFor(scopeOrder);
  const built = await buildSelectedOwnerExportPackage({
    exportId: fixtureIds.snapshot as never,
    portfolioId: fixtureIds.portfolio as never,
    snapshot,
    objects: { async readMediaExportObject(input) {
      const body = data.get(input.objectId);
      if (body === undefined) throw new Error("REFERENCE_FIXTURE_OBJECT_MISSING");
      return { async *[Symbol.asyncIterator]() { yield body; } };
    } },
  });
  return collect(built.content);
}

async function archiveWithRelatedProjectTarget(targetId: string) {
  const snapshot = await snapshotFor(scopeOrder);
  const content = snapshot.content;
  if (content === undefined) throw new Error("REFERENCE_FIXTURE_CONTENT_MISSING");
  const records = content.records.map((record) => record.contentId !== fixtureIds.hiddenProject ? record : {
    ...record,
    value: { ...record.value, relatedProjectIds: [targetId] as never[] },
  });
  const alteredSnapshot = { ...snapshot, content: { ...content, records } } as typeof snapshot;
  const data = mediaBytesByObjectId();
  const built = await buildSelectedOwnerExportPackage({ exportId: fixtureIds.snapshot as never, portfolioId: fixtureIds.portfolio as never, snapshot: alteredSnapshot,
    objects: { async readMediaExportObject(input) {
      const body = data.get(input.objectId);
      if (body === undefined) throw new Error("REFERENCE_FIXTURE_OBJECT_MISSING");
      return { async *[Symbol.asyncIterator]() { yield body; } };
    } },
  });
  return collect(built.content);
}

function referenceDatabase(options: { occupied?: string; fail?: (sql: string, parameters?: readonly unknown[]) => boolean } = {}) {
  const calls: { sql: string; parameters?: readonly unknown[] }[] = [];
  const schemas = new Map<string, { ownerToken?: string; paths: string[] }>();
  const database = { async query(sql: string, parameters?: readonly unknown[]) {
    calls.push({ sql, ...(parameters === undefined ? {} : { parameters }) });
    const schema = sql.match(/(?:create schema|drop schema) "([a-z0-9_]+)"/iu)?.[1];
    if (sql.startsWith("create schema ") && schema !== undefined) {
      if (schema === options.occupied || schemas.has(schema)) throw Object.assign(new Error("provider detail must stay private"), { code: "42P06" });
      schemas.set(schema, { paths: [] });
    }
    if (options.fail?.(sql, parameters)) throw new Error("https://storage.example.test/service_role=secret-token");
    if (sql.includes("insert into \"") && sql.includes(".reference_owner")) {
      const key = sql.match(/insert into "([a-z0-9_]+)"\.reference_owner/iu)?.[1];
      if (key !== undefined) schemas.get(key)!.ownerToken = String(parameters?.[0]);
    }
    if (sql.includes(".owned_objects(path")) {
      const key = sql.match(/insert into "([a-z0-9_]+)"\.owned_objects/iu)?.[1];
      if (key !== undefined) schemas.get(key)!.paths.push(String(parameters?.[0]));
    }
    if (sql.startsWith("select to_regclass")) {
      const key = String(parameters?.[0]).split(".")[0] ?? "";
      return { rows: [{ relation: schemas.has(key) ? `${key}.reference_owner` : null }] };
    }
    if (sql.includes("from \"") && sql.includes(".reference_owner")) {
      const key = sql.match(/from "([a-z0-9_]+)"\.reference_owner/iu)?.[1];
      return { rows: key === undefined || !schemas.get(key)?.ownerToken ? [] : [{ owner_token: schemas.get(key)!.ownerToken }] };
    }
    if (sql.includes("from \"") && sql.includes(".owned_objects")) {
      const key = sql.match(/from "([a-z0-9_]+)"\.owned_objects/iu)?.[1];
      return { rows: schemas.get(key ?? "")?.paths.map((path) => ({ path })) ?? [] };
    }
    if (sql.startsWith("drop schema ") && schema !== undefined) schemas.delete(schema);
    return { rows: [] };
  } };
  return { database, calls, schemas };
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function repack(entries: Map<string, Uint8Array>) {
  const zip = createStoredOwnerExportZip([...entries].map(([name, body]) => ({ name, contentLength: body.byteLength,
    crc32: crc32(body), content: () => ({ async *[Symbol.asyncIterator]() { yield body; } }) })));
  return collect(zip.content);
}

async function rewriteManifest(archive: Uint8Array, mutate: (manifest: Record<string, unknown>) => void) {
  const entries = independentlyReadOwnerExportZip(archive);
  const manifest = JSON.parse(new TextDecoder().decode(entries.get("manifest.json")!)) as Record<string, unknown>;
  mutate(manifest);
  manifest["digest"] = ownerExportManifestDigest(manifest);
  entries.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
  return repack(entries);
}

async function rewriteRecordArchive(
  archive: Uint8Array,
  scope: string,
  identityProperty: string,
  identity: string,
  updateRecord: (value: Record<string, unknown>) => void,
  updateManifest: (manifest: Record<string, unknown>) => void = () => {},
) {
  const entries = independentlyReadOwnerExportZip(archive);
  const manifest = JSON.parse(new TextDecoder().decode(entries.get("manifest.json")!)) as Record<string, unknown>;
  const descriptors = manifest["entries"] as Array<{ scope: string; path: string; digest: string }>;
  const descriptor = descriptors.find((entry) => entry.scope === scope);
  if (descriptor === undefined) throw new Error("REFERENCE_FIXTURE_ENTRY_MISSING");
  const recordBytes = entries.get(descriptor.path);
  if (recordBytes === undefined) throw new Error("REFERENCE_FIXTURE_RECORD_BYTES_MISSING");
  let matched = false;
  const lines = new TextDecoder().decode(recordBytes).trimEnd().split("\n").map((line) => {
    const record = JSON.parse(line) as { scope?: unknown; value?: unknown };
    if (record.scope === scope && record.value !== null && typeof record.value === "object" && !Array.isArray(record.value) &&
        (record.value as Record<string, unknown>)[identityProperty] === identity) {
      updateRecord(record.value as Record<string, unknown>);
      matched = true;
    }
    return JSON.stringify(record);
  });
  if (!matched) throw new Error("REFERENCE_FIXTURE_RECORD_MISSING");
  const updatedBytes = new TextEncoder().encode(`${lines.join("\n")}\n`);
  entries.set(descriptor.path, updatedBytes);
  descriptor.digest = createHash("sha256").update(updatedBytes).digest("hex");
  updateManifest(manifest);
  manifest["digest"] = ownerExportManifestDigest(manifest);
  entries.set("manifest.json", new TextEncoder().encode(JSON.stringify(manifest)));
  return repack(entries);
}

function addOmittedDependency(manifest: Record<string, unknown>, edge: {
  sourceScope: string; sourceId: string; targetScope: string; targetId: string;
}) {
  const dependencies = manifest["dependencies"] as Array<Record<string, unknown>>;
  dependencies.push({ ...edge, disposition: "omitted", reason: "not-retained" });
  const order = ["portfolio-content", "taxonomy", "media-metadata", "cv-metadata", "moderation-history", "analytics-reports", "portfolio-configuration"];
  const compare = (left: unknown, right: unknown) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;
  dependencies.sort((left, right) => order.indexOf(String(left["sourceScope"])) - order.indexOf(String(right["sourceScope"])) ||
    compare(left["sourceId"], right["sourceId"]) || order.indexOf(String(left["targetScope"])) - order.indexOf(String(right["targetScope"])) ||
    compare(left["targetId"], right["targetId"]));
}

async function legacyV1Archive(options: { includeContent?: boolean; duplicateRevisionId?: boolean } = {}) {
  const contentSchema = new Uint8Array(readFileSync("schemas/owner-export/v1.0/portfolio-content.schema.json"));
  const analyticsSchema = new Uint8Array(readFileSync("schemas/owner-export/v1.0/analytics-reports.schema.json"));
  const includeContent = options.includeContent ?? true;
  const contentId = "0196a1b2-7c3d-7e11-9f22-000000000901";
  const routeId = "0196a1b2-7c3d-7e11-9f22-000000000902";
  const englishRevisionId = "0196a1b2-7c3d-7e11-9f22-000000000903";
  const arabicRevisionId = options.duplicateRevisionId ? englishRevisionId : "0196a1b2-7c3d-7e11-9f22-000000000904";
  const goalId = "0196a1b2-7c3d-7e11-9f22-000000000905";
  const versionId = "0196a1b2-7c3d-7e11-9f22-000000000906";
  const contentRecord = new TextEncoder().encode(`${JSON.stringify({ scope: "portfolio-content", contentId, contentType: "project", lifecycle: "published",
    revisions: [
      { revisionId: englishRevisionId, locale: "en", sequence: 2, title: "Legacy project", summary: "English summary", body: "English body", reviewed: true, currentlyPublished: true },
      { revisionId: arabicRevisionId, locale: "ar", sequence: 1, title: "مشروع قديم", summary: "ملخص", body: "المحتوى", reviewed: true, currentlyPublished: true },
    ],
    publicRouteIdentity: routeId, routeHistory: [{ fromSlug: "old-legacy-project", toSlug: "legacy-project" }],
    relatedProjectIds: [], taxonomyValueIds: [], mediaAssetIds: [], evidenceItems: [],
  })}\n`);
  const analyticsRecord = new TextEncoder().encode(`${JSON.stringify({ scope: "analytics-reports", goal: {
    goalId, aggregateVersion: 2, activeVersionId: versionId,
    versions: [{ versionId, versionNumber: 2,
      definition: { name: "Legacy project journey", steps: [{ action: "project-viewed", projectIds: [contentId] }] },
      createdAt: "2026-10-25T10:00:00Z" }],
    activationHistory: [{ versionId, activatedAt: "2026-10-25T10:01:00Z" }],
  }, reports: [
    { goalVersionId: versionId, periodStart: "2026-10-01T00:00:00Z", periodEnd: "2026-10-02T00:00:00Z", sampleState: "suppressed", aggregateCount: 7 },
    { goalVersionId: versionId, periodStart: "2026-10-02T00:00:00Z", periodEnd: "2026-10-03T00:00:00Z", sampleState: "sufficient", aggregateCount: 12 },
  ] })}\n`);
  const contentPath = "records/portfolio-content.ndjson";
  const analyticsPath = "records/analytics-reports.ndjson";
  const entries = [
    ...(includeContent ? [{ path: contentPath, scope: "portfolio-content", mediaType: "application/x-ndjson",
      recordSchema: "urn:shipwithali:owner-export-schema:portfolio-content:1.0", schemaPath: "schemas/portfolio-content.schema.json",
      schemaVersion: "1.0", digest: createHash("sha256").update(contentRecord).digest("hex"), recordCount: 1 }] : []),
    { path: analyticsPath, scope: "analytics-reports", mediaType: "application/x-ndjson",
      recordSchema: "urn:shipwithali:owner-export-schema:analytics-reports:1.0", schemaPath: "schemas/analytics-reports.schema.json",
      schemaVersion: "1.0", digest: createHash("sha256").update(analyticsRecord).digest("hex"), recordCount: 1 },
  ];
  const manifest: Record<string, unknown> = {
    packageFormat: "shipwithali-owner-export", schemaVersion: "1.0", createdAt: "2026-10-25T10:01:00Z",
    algorithm: "sha-256", digest: "", includedScopes: includeContent ? ["portfolio-content", "analytics-reports"] : ["analytics-reports"],
    publicEventDataCoverage: { mode: "excluded" }, entries,
  };
  manifest["digest"] = ownerExportManifestDigest(manifest);
  const archiveEntries: Array<[string, Uint8Array]> = [
    ["manifest.json", new TextEncoder().encode(JSON.stringify(manifest))],
    ...(includeContent ? ([ ["schemas/portfolio-content.schema.json", contentSchema] ] as Array<[string, Uint8Array]>) : []),
    ["schemas/analytics-reports.schema.json", analyticsSchema],
    ...(includeContent ? ([ [contentPath, contentRecord] ] as Array<[string, Uint8Array]>) : []),
    [analyticsPath, analyticsRecord],
  ];
  return { archive: await repack(new Map(archiveEntries)), contentId, routeId, englishRevisionId, arabicRevisionId, goalId, versionId };
}

async function wrappedLegacyArchive(options: { manifestVersion: "1.1" | "1.2"; scopes: Array<"portfolio-content" | "analytics-reports">;
  contentFacts: "omitted" | "explicit" }) {
  const contentId = "0196a1b2-7c3d-7e11-9f22-000000000911";
  const routeId = "0196a1b2-7c3d-7e11-9f22-000000000912";
  const revisionId = "0196a1b2-7c3d-7e11-9f22-000000000913";
  const goalId = "0196a1b2-7c3d-7e11-9f22-000000000914";
  const firstVersionId = "0196a1b2-7c3d-7e11-9f22-000000000915";
  const activeVersionId = "0196a1b2-7c3d-7e11-9f22-000000000916";
  const relatedProjectId = "0196a1b2-7c3d-7e11-9f22-000000000919";
  const contentValues: Array<Record<string, unknown>> = [
    {
      contentId, contentType: "project", lifecycle: "published",
      ...(options.contentFacts === "explicit" ? { projectStatus: null, featured: false } : {}),
      revisions: [{ revisionId, locale: "en", sequence: 2, title: "Legacy wrapped project", summary: "A preserved summary.",
        body: "A preserved body.", reviewed: true, currentlyPublished: true }],
      publicRouteIdentity: routeId, routeHistory: [{ fromSlug: "old-wrapped-project", toSlug: "wrapped-project" }],
      relatedProjectIds: [relatedProjectId], taxonomyValueIds: [], mediaAssetIds: [], evidenceItems: [],
    },
    {
      contentId: relatedProjectId, contentType: "project", lifecycle: "draft",
      ...(options.contentFacts === "explicit" ? { projectStatus: null, featured: false } : {}),
      revisions: [{ revisionId: "0196a1b2-7c3d-7e11-9f22-000000000920", locale: "en", sequence: 1,
        title: "Related draft project", summary: "A current relationship target.", body: "A preserved target body.",
        reviewed: false, currentlyPublished: false }],
      publicRouteIdentity: null, routeHistory: [], relatedProjectIds: [], taxonomyValueIds: [], mediaAssetIds: [], evidenceItems: [],
    },
  ];
  const analyticsValue: Record<string, unknown> = {
      goal: {
        goalId, aggregateVersion: 3, activeVersionId,
        versions: [
          { versionId: firstVersionId, versionNumber: 1,
            definition: { name: "Earlier journey", steps: [{ action: "project-viewed", projectIds: [contentId], publicRouteIds: [routeId] }] },
            createdAt: "2026-10-01T10:00:00Z" },
          { versionId: activeVersionId, versionNumber: 2,
            definition: { name: "Current journey", steps: [{ action: "project-viewed", projectIds: [contentId], publicRouteIds: [routeId] }] },
            createdAt: "2026-10-02T10:00:00Z" },
        ],
        activationHistory: [
          { versionId: firstVersionId, activatedAt: "2026-10-01T11:00:00Z" },
          { versionId: activeVersionId, activatedAt: "2026-10-02T11:00:00Z" },
        ],
      },
      reports: [
        { goalVersionId: activeVersionId, periodStart: "2026-10-01T00:00:00Z", periodEnd: "2026-10-02T00:00:00Z", sampleState: "suppressed", aggregateCount: 7 },
        { goalVersionId: activeVersionId, periodStart: "2026-10-02T00:00:00Z", periodEnd: "2026-10-03T00:00:00Z", sampleState: "sufficient", aggregateCount: 12 },
      ],
  };
  const scopeOrder = ["portfolio-content", "analytics-reports"] as const;
  const scopes = scopeOrder.filter((scope) => options.scopes.includes(scope));
  if (scopes.length === 0) throw new Error("REFERENCE_FIXTURE_SCOPE_REQUIRED");
  const scopeValues = new Map<string, Array<Record<string, unknown>>>([
    ["portfolio-content", contentValues], ["analytics-reports", [analyticsValue]],
  ]);
  const records = new Map(scopes.map((scope) => [scope, new TextEncoder().encode(
    `${scopeValues.get(scope)!.map((value) => JSON.stringify({ scope, value })).join("\n")}\n`)]));
  const entries = scopes.map((scope) => ({ path: `records/${scope}.ndjson`, scope, mediaType: "application/x-ndjson",
    recordSchema: `urn:shipwithali:owner-export-schema:${scope}:1.1`, schemaPath: `schemas/${scope}.schema.json`, schemaVersion: "1.1",
    digest: createHash("sha256").update(records.get(scope)!).digest("hex"), recordCount: scopeValues.get(scope)!.length }));
  const dependencies = [
    ...(scopes.includes("portfolio-content") ? [{ sourceScope: "portfolio-content", sourceId: contentId,
      targetScope: "portfolio-content", targetId: relatedProjectId, disposition: "included" }] : []),
    ...(scopes.includes("analytics-reports") ? [contentId, routeId].map((targetId) => ({
      sourceScope: "analytics-reports", sourceId: goalId, targetScope: "portfolio-content", targetId,
      disposition: scopes.includes("portfolio-content") ? "included" : "omitted",
      ...(!scopes.includes("portfolio-content") ? { reason: "scope-not-selected" } : {}),
    })) : []),
  ];
  const manifestSchema = new Uint8Array(readFileSync("schemas/owner-export/v1.1/manifest.schema.json"));
  const schemaBytes = new Map<string, Uint8Array>([["schemas/manifest.schema.json", manifestSchema]]);
  for (const scope of scopes) schemaBytes.set(`schemas/${scope}.schema.json`,
    new Uint8Array(readFileSync(`schemas/owner-export/v1.1/${scope}.schema.json`)));
  const schemas = [
    { kind: "manifest", path: "schemas/manifest.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:manifest:1.1", schemaVersion: "1.1",
      digest: createHash("sha256").update(manifestSchema).digest("hex") },
    ...scopes.map((scope) => ({ kind: "record", scope, path: `schemas/${scope}.schema.json`,
      schemaUri: `urn:shipwithali:owner-export-schema:${scope}:1.1`, schemaVersion: "1.1",
      digest: createHash("sha256").update(schemaBytes.get(`schemas/${scope}.schema.json`)!).digest("hex") })),
  ];
  const manifest: Record<string, unknown> = {
    packageFormat: "shipwithali-owner-export", schemaVersion: options.manifestVersion,
    exportId: "0196a1b2-7c3d-7e11-9f22-000000000917",
    snapshot: { snapshotId: "0196a1b2-7c3d-7e11-9f22-000000000918", capturedAt: "2026-10-03T00:00:00Z", consistency: "transactional" },
    createdAt: "2026-10-03T00:00:00Z", algorithm: "sha-256", digest: "",
    requiredFeatures: ["asset-integrity-v1", "dependency-coverage-v1", "record-integrity-v1", "schema-integrity-v1", "snapshot-identity-v1"],
    includedScopes: scopes, publicEventDataCoverage: { mode: "excluded" }, dependencies,
    exclusions: ["raw-public-event-data", "functional-visitor-identities", "measurement-visitor-identities", "sessions", "credentials", "lab-entries"],
    entries, schemas, assets: [],
    ...(options.manifestVersion === "1.2" ? { extensions: { configurationSnapshot: { aggregateVersion: null, availableLocales: [],
      capabilities: { currentCvAvailable: false, externalLinksAvailable: false, globalProjectCtaAvailable: false } } } } : {}),
  };
  manifest["digest"] = ownerExportManifestDigest(manifest);
  const archiveEntries = new Map<string, Uint8Array>([["manifest.json", new TextEncoder().encode(JSON.stringify(manifest))], ...schemaBytes]);
  for (const scope of scopes) archiveEntries.set(`records/${scope}.ndjson`, records.get(scope)!);
  return { archive: await repack(archiveEntries), contentId, relatedProjectId, routeId, revisionId, goalId, firstVersionId, activeVersionId };
}

describe("Issue #250 independent reference importer", () => {
  it("independently parses and reconstructs every selected scope, history, dependency and byte reference", async () => {
    const archive = await fullArchive();
    const checked = validateOwnerExportZip(archive);
    const facts = expectedFacts();
    expect(checked.includedScopes).toEqual(scopeOrder);
    expect(checked.recordCounts).toMatchObject({ "portfolio-content": 5, taxonomy: 1, "media-metadata": 4,
      "cv-metadata": 1, "moderation-history": 4, "analytics-reports": 1, "portfolio-configuration": 1 });

    const { database, calls } = referenceDatabase();
    const uploaded = new Map<string, Uint8Array>();
    const removed: string[][] = [];
    const objectSink = {
      async put(input: { namespace: string; path: string; sourcePath: string; bytes: Uint8Array; digest: string }) {
        expect(createHash("sha256").update(input.bytes).digest("hex")).toBe(input.digest);
        uploaded.set(`${input.namespace}/${input.path}`, input.bytes.slice());
      },
      async removeObjects(namespace: string, paths: string[]) {
        removed.push([...paths]);
        for (const path of paths) uploaded.delete(`${namespace}/${path}`);
      },
    };
    const namespace = "ref_0123456789abcdef";
    const imported = await importOwnerExportReference({ archive, database, objectSink, namespace });
    expect(imported).toMatchObject({ includedScopes: scopeOrder, recordCounts: checked.recordCounts, totalRecords: 17, dependencyCount: checked.dependencyCount });
    expect(imported.assetCount).toBe(4);
    expect(imported.assetBytes).toBeGreaterThan(0);
    expect(calls[0]?.sql).toBe(`create schema "${namespace}"`);
    expect(calls.findIndex((call) => call.sql === "begin")).toBeGreaterThan(calls.findIndex((call) => call.sql.includes(".owned_objects")));
    expect(calls.at(-1)?.sql).toBe("commit");
    expect(calls.some((call) => call.sql.includes("create schema"))).toBe(true);
    const declaredAssets = (checked.manifest as unknown as { assets: Array<{ path: string }> }).assets;
    expect([...uploaded.keys()].map((key) => key.split("/").slice(3).join("/")).sort()).toEqual(declaredAssets.map((asset) => asset.path).sort());
    expect([...uploaded.keys()].every((key) => /^ref_[a-f0-9]{16}\/imports\/[0-9a-f-]{36}\//u.test(key))).toBe(true);
    expect([...uploaded.values()].map((body) => createHash("sha256").update(body).digest("hex")).sort()).toEqual([...facts.assetDigests].sort());
    expect(removed).toHaveLength(0);

    const insertedValues = calls.flatMap((call) => call.parameters?.[2] === undefined ? [] : [String(call.parameters[2])]);
    const importedJson = insertedValues.join("\n");
    expect(importedJson).toContain(facts.hiddenProject.route.identity);
    expect(importedJson).toContain(facts.currentCv);
    expect(importedJson).toContain(facts.goalId);
    for (const marker of facts.privacyMarkersExcluded) expect(importedJson).not.toContain(marker);
    expect(importedJson).not.toMatch(/visitor|session|raw-event/iu);
    expect(importedJson).not.toContain("media-processed");

    const projections = new Map(calls.filter((call) => call.sql.includes("insert into \"") && call.sql.includes(".reference_model"))
      .map((call) => [String(call.parameters?.[0]) + ":" + String(call.parameters?.[1]), JSON.parse(String(call.parameters?.[2])) as Record<string, unknown>]));
    expect(projections.get(`content-item:${fixtureIds.hiddenProject}`)).toMatchObject({
      lifecycle: "hidden", featured: true, publicLocales: [], publiclyDiscoverable: false,
    });
    expect(projections.get(`content-item:${fixtureIds.publishedProject}`)).toMatchObject({
      lifecycle: "published", publicLocales: ["en"], publiclyDiscoverable: true,
    });
    const strictContent = projections.get(`content-item:${fixtureIds.hiddenProject}`);
    expect(strictContent).toMatchObject({ lifecycleHistoryAvailable: true, relationshipHistoryAvailable: true,
      lifecycleHistory: expect.arrayContaining([expect.objectContaining({ lifecycle: "hidden", sequence: 2 })]),
      relationshipHistory: [expect.objectContaining({ relatedProjectId: fixtureIds.draftProject, sequence: 1 })] });
    expect(projections.get(`content-relationship:${fixtureIds.hiddenProject}:${fixtureIds.draftProject}`)).toMatchObject({
      contentId: fixtureIds.hiddenProject, relatedContentId: fixtureIds.draftProject, selected: true, historyAvailable: true,
      history: [expect.objectContaining({ relatedProjectId: fixtureIds.draftProject, sequence: 1 })],
    });
    expect(projections.get(`content-taxonomy-assignment:${fixtureIds.hiddenProject}:${fixtureIds.taxonomy}:${fixtureIds.activeValue}`))
      .toMatchObject({ selectedTaxonomy: true, currentMeaningId: fixtureIds.activeValue });
    expect(projections.get(`public-route:${facts.hiddenProject.route.identity}`)).toMatchObject({
      canonicalSlug: "current-hidden-project", redirects: [{ fromSlug: "previous-hidden-project", toSlug: "current-hidden-project" }],
    });
    expect(projections.get(`taxonomy-value:${fixtureIds.mergedValue}`)).toMatchObject({
      state: "merged", mergedIntoValueId: fixtureIds.activeValue, currentMeaningId: fixtureIds.activeValue,
    });
    expect(projections.get("cv-portfolio:aggregate")).toMatchObject({
      currentVersionId: facts.currentCv, currentVersion: { versionId: facts.currentCv },
    });
    expect(projections.get(`moderation-feedback:${fixtureIds.suppressedFeedback}`)).toMatchObject({
      state: "suppressed", retainedText: null,
    });
    expect(projections.get(`analytics-goal:${facts.goalId}`)).toMatchObject({
      activeVersionId: fixtureIds.goalV2, activationHistory: [{ activationSequence: 1 }, { activationSequence: 2 }],
    });
    const goalProjection = projections.get(`analytics-goal:${facts.goalId}`)!;
    expect((goalProjection["reports"] as Array<Record<string, unknown>>).length).toBeGreaterThan(0);
    expect((goalProjection["reports"] as Array<Record<string, unknown>>).every((report) =>
      report["countDisposition"] === "withheld" && !Object.hasOwn(report, "cells"))).toBe(true);
    expect(projections.get("portfolio-configuration:aggregate")).toMatchObject({
      profile: { displayName: "Synthetic owner" }, globalCta: { label: "Synthetic contact" },
    });
  });

  it("rejects corrupt, hostile and unsupported packages before any database or object mutation", async () => {
    const archive = await fullArchive();
    const calls: string[] = [];
    const writes: string[] = [];
    const database = { async query(sql: string) { calls.push(sql); return { rows: [] }; } };
    const objectSink = {
      async put(input: { path: string }) { writes.push(input.path); },
      async removeObjects(_namespace: string, paths: string[]) { writes.push(...paths.map((path) => `cleanup:${path}`)); },
    };
    const corrupt = archive.slice();
    const corruptionOffset = Math.floor(corrupt.byteLength / 2);
    corrupt[corruptionOffset] = corrupt[corruptionOffset]! ^ 0xff;
    const unsupported = await rewriteManifest(archive, (manifest) => { manifest["schemaVersion"] = "2.0"; });
    const hostileEntries = independentlyReadOwnerExportZip(archive);
    const contentBytes = hostileEntries.get("records/portfolio-content.ndjson")!;
    hostileEntries.delete("records/portfolio-content.ndjson");
    hostileEntries.set("../../outside", contentBytes);
    const hostile = await repack(hostileEntries);
    await expect(importOwnerExportReference({ archive: corrupt, database, objectSink, namespace: "ref_1111111111111111" })).rejects.toThrow();
    await expect(importOwnerExportReference({ archive: hostile, database, objectSink, namespace: "ref_1212121212121212" })).rejects.toThrow();
    await expect(importOwnerExportReference({ archive: unsupported, database, objectSink, namespace: "ref_1313131313131313" })).rejects.toThrow();
    await expect(importOwnerExportReference({ archive: new TextEncoder().encode("../../outside.zip"), database, objectSink,
      namespace: "ref_2222222222222222" })).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("rejects included project relationships that target a nested revision or a non-project record before writes", async () => {
    const source = await snapshotFor(scopeOrder);
    const hidden = source.content?.records.find((record) => record.contentId === fixtureIds.hiddenProject);
    const revisions = (hidden?.value as unknown as { revisions?: Array<{ revisionId: string }> } | undefined)?.revisions;
    const nestedRevisionId = revisions?.[0]?.revisionId;
    expect(nestedRevisionId).toBeDefined();
    const cases = [nestedRevisionId!, fixtureIds.archivedAchievement];

    for (const targetId of cases) {
      const archive = await archiveWithRelatedProjectTarget(targetId);
      if (targetId === nestedRevisionId) expect(() => validateOwnerExportZip(archive)).toThrow("PACKAGE_DEPENDENCY_TARGET_INVALID");
      else expect(validateOwnerExportZip(archive).includedScopes).toEqual(scopeOrder);
      const { database, calls } = referenceDatabase();
      let writes = 0;
      const objectSink = {
        async put() { writes += 1; },
        async removeObjects() { writes += 1; },
      };
      const importing = importOwnerExportReference({ archive, database, objectSink, namespace: "ref_5353535353535353" });
      if (targetId === nestedRevisionId) await expect(importing).rejects.toMatchObject({ code: "PACKAGE_DEPENDENCY_TARGET_INVALID" });
      else await expect(importing).rejects.toMatchObject({ code: "REFERENCE_IMPORT_MODEL_DEPENDENCY_TARGET_KIND_INVALID" });
      expect(calls).toEqual([]);
      expect(writes).toBe(0);
    }
  });

  it("rejects an offline-valid dangling current Project relationship declared not-retained before writes", async () => {
    const missingProjectId = "0196a1b2-7c3d-7e11-9f22-000000000999";
    const archive = await rewriteRecordArchive(await fullArchive(), "portfolio-content", "contentId", fixtureIds.hiddenProject,
      (value) => { value["relatedProjectIds"] = [missingProjectId]; }, (manifest) => {
      const dependencies = manifest["dependencies"] as Array<Record<string, unknown>>;
      const edge = dependencies.find((candidate) => candidate["sourceScope"] === "portfolio-content" &&
        candidate["sourceId"] === fixtureIds.hiddenProject && candidate["targetScope"] === "portfolio-content" &&
        candidate["targetId"] === fixtureIds.draftProject);
      if (edge === undefined) throw new Error("REFERENCE_FIXTURE_DEPENDENCY_MISSING");
      edge["targetId"] = missingProjectId;
      edge["disposition"] = "omitted";
      edge["reason"] = "not-retained";
    });
    const checked = validateOwnerExportZip(archive);
    const dependency = (checked.manifest["dependencies"] as Array<Record<string, unknown>>).find((edge) =>
      edge["sourceScope"] === "portfolio-content" && edge["sourceId"] === fixtureIds.hiddenProject &&
      edge["targetScope"] === "portfolio-content" && edge["targetId"] === missingProjectId);
    expect(dependency).toMatchObject({ disposition: "omitted", reason: "not-retained" });

    const { database, calls } = referenceDatabase();
    let storageWrites = 0;
    const objectSink = { async put() { storageWrites += 1; }, async removeObjects() { storageWrites += 1; } };
    await expect(importOwnerExportReference({ archive, database, objectSink, namespace: "ref_5454545454545454" }))
      .rejects.toMatchObject({ code: "REFERENCE_IMPORT_MODEL_DEPENDENCY_TARGET_KIND_INVALID" });
    expect(calls).toEqual([]);
    expect(storageWrites).toBe(0);
  });

  it("requires selected Taxonomy current and historical Project references to resolve before import writes", async () => {
    const missingProjectId = "0196a1b2-7c3d-7e11-9f22-000000000998";
    const archive = await rewriteRecordArchive(await fullArchive(), "taxonomy", "taxonomyId", fixtureIds.taxonomy, (value) => {
      const assignments = value["assignments"] as Array<Record<string, unknown>>;
      assignments[0] = { ...assignments[0]!, targetId: missingProjectId };
    }, (manifest) => addOmittedDependency(manifest, { sourceScope: "taxonomy", sourceId: fixtureIds.taxonomy,
      targetScope: "portfolio-content", targetId: missingProjectId }));
    expect(() => validateOwnerExportZip(archive)).toThrow("TAXONOMY_SNAPSHOT_FACTS_INVALID");

    const { database, calls } = referenceDatabase();
    let storageWrites = 0;
    const objectSink = { async put() { storageWrites += 1; }, async removeObjects() { storageWrites += 1; } };
    await expect(importOwnerExportReference({ archive, database, objectSink, namespace: "ref_5656565656565656" }))
      .rejects.toThrow("TAXONOMY_SNAPSHOT_FACTS_INVALID");
    expect(calls).toEqual([]);
    expect(storageWrites).toBe(0);

    for (const referenceField of ["assignments", "assignmentHistory"] as const) {
      const value: Record<string, unknown> = { taxonomyId: fixtureIds.taxonomy, values: [{ valueId: fixtureIds.activeValue }],
        [referenceField]: [{ targetId: missingProjectId, taxonomyValueId: fixtureIds.activeValue }] };
      const modelManifest = { schemaVersion: "1.9", includedScopes: ["portfolio-content", "taxonomy"], dependencies: [
        { sourceScope: "taxonomy", sourceId: fixtureIds.taxonomy, targetScope: "portfolio-content", targetId: missingProjectId,
          disposition: "omitted", reason: "not-retained" },
        { sourceScope: "taxonomy", sourceId: fixtureIds.taxonomy, targetScope: "taxonomy", targetId: fixtureIds.activeValue,
          disposition: "included" },
      ] };
      let modelFailure: unknown;
      try {
        buildOwnerExportReferenceModel({ records: [{ scope: "taxonomy", identity: fixtureIds.taxonomy, value }],
          manifest: modelManifest, assets: [] });
      } catch (error) { modelFailure = error; }
      expect(modelFailure).toMatchObject({ code: "REFERENCE_IMPORT_MODEL_DEPENDENCY_TARGET_KIND_INVALID" });
    }
  });

  it("preserves lawful partial-scope and Moderation not-retained Project omissions", async () => {
    const sink = { async put() {}, async removeObjects() {} };
    const partialSnapshot = await snapshotFor(["moderation-history"]);
    const partialPackage = await buildSelectedOwnerExportPackage({ exportId: fixtureIds.snapshot as never, snapshot: partialSnapshot });
    const partialArchive = await collect(partialPackage.content);
    expect(validateOwnerExportZip(partialArchive).includedScopes).toEqual(["moderation-history"]);
    const partialTarget = referenceDatabase();
    await importOwnerExportReference({ archive: partialArchive, database: partialTarget.database, objectSink: sink,
      namespace: "ref_5757575757575757" });
    const partialExternal = partialTarget.calls.filter((call) => call.sql.trimStart().startsWith("insert into") && call.sql.includes(".external_dependencies"))
      .map((call) => JSON.parse(String(call.parameters?.[1])) as Record<string, unknown>);
    expect(partialExternal).toHaveLength(4);
    expect(partialExternal.every((edge) => edge["reason"] === "scope-not-selected" && edge["disposition"] === "omitted")).toBe(true);

    const missingProjectId = "0196a1b2-7c3d-7e11-9f22-000000000997";
    const moderationArchive = await rewriteRecordArchive(await fullArchive(), "moderation-history", "feedbackId", fixtureIds.pendingFeedback,
      (value) => { value["projectId"] = missingProjectId; }, (manifest) => {
        const dependencies = manifest["dependencies"] as Array<Record<string, unknown>>;
        const edge = dependencies.find((candidate) => candidate["sourceScope"] === "moderation-history" &&
          candidate["sourceId"] === fixtureIds.pendingFeedback && candidate["targetScope"] === "portfolio-content" &&
          candidate["targetId"] === fixtureIds.hiddenProject);
        if (edge === undefined) throw new Error("REFERENCE_FIXTURE_DEPENDENCY_MISSING");
        edge["targetId"] = missingProjectId;
        edge["disposition"] = "omitted";
        edge["reason"] = "not-retained";
      });
    const moderationCheck = validateOwnerExportZip(moderationArchive);
    expect((moderationCheck.manifest["dependencies"] as Array<Record<string, unknown>>).find((edge) =>
      edge["sourceScope"] === "moderation-history" && edge["sourceId"] === fixtureIds.pendingFeedback &&
      edge["targetId"] === missingProjectId)).toMatchObject({ disposition: "omitted", reason: "not-retained" });
    const moderationTarget = referenceDatabase();
    await importOwnerExportReference({ archive: moderationArchive, database: moderationTarget.database, objectSink: sink,
      namespace: "ref_5858585858585858" });
    const moderationExternal = moderationTarget.calls.filter((call) => call.sql.trimStart().startsWith("insert into") && call.sql.includes(".external_dependencies"))
      .map((call) => JSON.parse(String(call.parameters?.[1])) as Record<string, unknown>);
    expect(moderationExternal).toEqual([expect.objectContaining({ sourceScope: "moderation-history", sourceId: fixtureIds.pendingFeedback,
      targetScope: "portfolio-content", targetId: missingProjectId, disposition: "omitted", reason: "not-retained" })]);
  });

  it("reserves an existing namespace without touching its pre-existing object sentinel", async () => {
    const archive = await fullArchive();
    const namespace = "ref_5151515151515151";
    const { database, calls } = referenceDatabase({ occupied: namespace });
    const sentinel = new TextEncoder().encode("foreign sentinel");
    const objects = new Map([[`${namespace}/sentinel.txt`, sentinel]]);
    let puts = 0;
    let deletes = 0;
    const objectSink = {
      async put(input: { namespace: string; path: string; bytes: Uint8Array }) {
        puts += 1;
        const key = `${input.namespace}/${input.path}`;
        if (objects.has(key)) throw new Error("OBJECT_ALREADY_EXISTS");
        objects.set(key, input.bytes.slice());
      },
      async removeObjects(_namespace: string, paths: string[]) {
        deletes += paths.length;
        for (const path of paths) objects.delete(`${_namespace}/${path}`);
      },
    };
    await expect(importOwnerExportReference({ archive, database, objectSink, namespace }))
      .rejects.toMatchObject({ code: "REFERENCE_IMPORT_NAMESPACE_IN_USE", stage: "reserve" });
    expect(calls.map((call) => call.sql)).toEqual([`create schema "${namespace}"`]);
    expect(puts).toBe(0);
    expect(deletes).toBe(0);
    expect(objects.get(`${namespace}/sentinel.txt`)).toEqual(sentinel);
  });

  it("cleans only exact invocation-owned objects after a partial upload and database failure", async () => {
    const archive = await fullArchive();
    const namespace = "ref_6161616161616161";
    let trackedObjects = 0;
    const { database } = referenceDatabase({ fail: (sql) => sql.trimStart().startsWith("insert into") && sql.includes(".owned_objects") && ++trackedObjects === 2 });
    const objects = new Map<string, Uint8Array>([
      [`${namespace}/foreign-sentinel`, new TextEncoder().encode("foreign")],
      ["source-bucket/source-object", new TextEncoder().encode("source")],
      ["target-bucket/winning-object", new TextEncoder().encode("winner")],
    ]);
    const removed: string[] = [];
    const objectSink = {
      async put(input: { namespace: string; path: string; bytes: Uint8Array }) {
        const key = `${input.namespace}/${input.path}`;
        if (objects.has(key)) throw new Error("OBJECT_ALREADY_EXISTS");
        objects.set(key, input.bytes.slice());
      },
      async removeObjects(targetNamespace: string, paths: string[]) {
        removed.push(...paths);
        for (const path of paths) objects.delete(`${targetNamespace}/${path}`);
      },
    };
    await expect(importOwnerExportReference({ archive, database, objectSink, namespace }))
      .rejects.toMatchObject({ code: "REFERENCE_IMPORT_FAILED", stage: "source-object-copy" });
    // The second ownership intent fails before its upload starts, so only the
    // first exact invocation path is eligible for removal.
    expect(removed).toHaveLength(1);
    expect(removed.every((path) => path.startsWith("imports/"))).toBe(true);
    expect([...objects.keys()].sort()).toEqual([
      `${namespace}/foreign-sentinel`, "source-bucket/source-object", "target-bucket/winning-object",
    ].sort());
  });

  it("surfaces safe cleanup failure details and retries cleanup using its owned-object ledger", async () => {
    const archive = await fullArchive();
    const namespace = "ref_7171717171717171";
    const { database } = referenceDatabase({ fail: (sql) => sql.trimStart().startsWith("insert into") && sql.includes(".records") });
    const objects = new Map<string, Uint8Array>([[`${namespace}/foreign-sentinel`, new TextEncoder().encode("foreign")]]);
    let failCleanup = true;
    const objectSink = {
      async put(input: { namespace: string; path: string; bytes: Uint8Array }) {
        objects.set(`${input.namespace}/${input.path}`, input.bytes.slice());
      },
      async removeObjects(targetNamespace: string, paths: string[]) {
        if (failCleanup) {
          failCleanup = false;
          throw new Error("https://storage.example.test/service_role=private-token");
        }
        for (const path of paths) objects.delete(`${targetNamespace}/${path}`);
      },
    };
    let failure: (Error & { code?: string; stage?: string; namespace?: string; ownerToken?: string; cause?: Error }) | undefined;
    try { await importOwnerExportReference({ archive, database, objectSink, namespace }); }
    catch (error) { failure = error as typeof failure; }
    expect(failure).toMatchObject({ code: "REFERENCE_IMPORT_CLEANUP_FAILED", stage: "cleanup", namespace });
    expect(failure?.ownerToken).toMatch(/^[0-9a-f-]{36}$/iu);
    expect(failure?.message).toBe("REFERENCE_IMPORT_CLEANUP_FAILED");
    expect(failure?.cause?.message).toBe("REFERENCE_IMPORT_CAUSE_REDACTED");
    expect(JSON.stringify(failure)).not.toMatch(/storage\.example|private-token|service_role/iu);
    const remainingOwned = [...objects.keys()].filter((key) => key.startsWith(`${namespace}/imports/`));
    expect(remainingOwned.length).toBeGreaterThan(0);
    await expect(importOwnerExportReference({ archive, database, objectSink, namespace }))
      .rejects.toMatchObject({ code: "REFERENCE_IMPORT_NAMESPACE_IN_USE" });
    await cleanupOwnerExportReference({ database, objectSink, namespace, ownerToken: failure!.ownerToken });
    expect([...objects.keys()].filter((key) => key.startsWith(`${namespace}/imports/`))).toHaveLength(0);
    expect(objects.has(`${namespace}/foreign-sentinel`)).toBe(true);
  });

  it("retains durable ownership across upload response loss and cleanup outage, then retries only its exact owned key", async () => {
    const archive = await fullArchive();
    const namespace = "ref_7272727272727272";
    const { database, schemas } = referenceDatabase();
    const objects = new Map<string, { bytes: Uint8Array; ownerToken: string }>([
      [`${namespace}/foreign-sentinel`, { bytes: new TextEncoder().encode("foreign"), ownerToken: "foreign-owner" }],
      ["source-bucket/source-object", { bytes: new TextEncoder().encode("source"), ownerToken: "source-owner" }],
      ["target-bucket/winning-object", { bytes: new TextEncoder().encode("winner"), ownerToken: "winner-owner" }],
    ]);
    let losePutResponse = true;
    let failDelete = true;
    const removed: string[][] = [];
    const objectSink = {
      async put(input: { namespace: string; path: string; bytes: Uint8Array; ownerToken: string }) {
        const key = `${input.namespace}/${input.path}`;
        if (objects.has(key)) throw new Error("OBJECT_ALREADY_EXISTS");
        // Simulate the remote service committing bytes while its response is lost.
        objects.set(key, { bytes: input.bytes.slice(), ownerToken: input.ownerToken });
        if (losePutResponse) { losePutResponse = false; throw new Error("UPLOAD_RESPONSE_LOST"); }
      },
      async removeObjects(targetNamespace: string, paths: string[], ownerToken: string) {
        removed.push([...paths]);
        if (failDelete) { failDelete = false; throw new Error("STORAGE_TEMPORARILY_UNAVAILABLE"); }
        for (const path of paths) {
          const key = `${targetNamespace}/${path}`;
          const object = objects.get(key);
          if (object?.ownerToken === ownerToken) objects.delete(key);
          else if (object !== undefined) throw new Error("FOREIGN_OBJECT_MUST_NOT_BE_DELETED");
        }
      },
    };

    let failure: (Error & { code?: string; stage?: string; namespace?: string; ownerToken?: string }) | undefined;
    try { await importOwnerExportReference({ archive, database, objectSink, namespace }); }
    catch (error) { failure = error as typeof failure; }
    expect(failure).toMatchObject({ code: "REFERENCE_IMPORT_CLEANUP_FAILED", stage: "cleanup", namespace });
    expect(failure?.ownerToken).toMatch(/^[0-9a-f-]{36}$/iu);
    const schema = schemas.get(namespace);
    expect(schema?.ownerToken).toBe(failure?.ownerToken);
    expect(schema?.paths).toHaveLength(1);
    const ownedPath = schema!.paths[0]!;
    expect(objects.get(`${namespace}/${ownedPath}`)?.ownerToken).toBe(failure?.ownerToken);
    expect(removed).toEqual([[ownedPath]]);

    await cleanupOwnerExportReference({ database, objectSink, namespace, ownerToken: failure!.ownerToken! });
    expect(objects.has(`${namespace}/${ownedPath}`)).toBe(false);
    expect(objects.has(`${namespace}/foreign-sentinel`)).toBe(true);
    expect(objects.has("source-bucket/source-object")).toBe(true);
    expect(objects.has("target-bucket/winning-object")).toBe(true);
    await expect(cleanupOwnerExportReference({ database, objectSink, namespace, ownerToken: failure!.ownerToken! }))
      .resolves.toMatchObject({ alreadyClean: true });
  });

  it("retains and retries a token-marked partial object after cleanup is unavailable", async () => {
    const archive = await fullArchive();
    const namespace = "ref_7373737373737373";
    const { database, schemas } = referenceDatabase();
    const objects = new Map<string, { bytes: Uint8Array; ownerToken: string }>([
      [`${namespace}/foreign-sentinel`, { bytes: new TextEncoder().encode("foreign"), ownerToken: "foreign-owner" }],
      ["source-bucket/source-object", { bytes: new TextEncoder().encode("source"), ownerToken: "source-owner" }],
      ["target-bucket/winning-object", { bytes: new TextEncoder().encode("winner"), ownerToken: "winner-owner" }],
    ]);
    let failDelete = true;
    let expectedUploadLength = 0;
    const objectSink = {
      async put(input: { namespace: string; path: string; bytes: Uint8Array; ownerToken: string }) {
        const key = `${input.namespace}/${input.path}`;
        if (objects.has(key)) throw new Error("OBJECT_ALREADY_EXISTS");
        // Model a remote partial write that retained its invocation metadata.
        expectedUploadLength = input.bytes.byteLength;
        objects.set(key, { bytes: input.bytes.slice(0, Math.max(1, Math.floor(input.bytes.byteLength / 2))), ownerToken: input.ownerToken });
        throw new Error("UPLOAD_INTERRUPTED_AFTER_PARTIAL_WRITE");
      },
      async removeObjects(targetNamespace: string, paths: string[], ownerToken: string) {
        if (failDelete) { failDelete = false; throw new Error("STORAGE_TEMPORARILY_UNAVAILABLE"); }
        for (const path of paths) {
          const key = `${targetNamespace}/${path}`;
          const object = objects.get(key);
          if (object?.ownerToken === ownerToken) objects.delete(key);
          else if (object !== undefined) throw new Error("FOREIGN_OBJECT_MUST_NOT_BE_DELETED");
        }
      },
    };
    let failure: (Error & { code?: string; ownerToken?: string }) | undefined;
    try { await importOwnerExportReference({ archive, database, objectSink, namespace }); }
    catch (error) { failure = error as typeof failure; }
    expect(failure).toMatchObject({ code: "REFERENCE_IMPORT_CLEANUP_FAILED" });
    const ownedPath = schemas.get(namespace)?.paths[0];
    expect(ownedPath).toBeDefined();
    const partial = objects.get(`${namespace}/${ownedPath}`);
    expect(partial?.ownerToken).toBe(failure?.ownerToken);
    expect(partial?.bytes.byteLength).toBeLessThan(expectedUploadLength);
    await cleanupOwnerExportReference({ database, objectSink, namespace, ownerToken: failure!.ownerToken! });
    expect(objects.has(`${namespace}/${ownedPath}`)).toBe(false);
    expect(objects.has(`${namespace}/foreign-sentinel`)).toBe(true);
    expect(objects.has("source-bucket/source-object")).toBe(true);
    expect(objects.has("target-bucket/winning-object")).toBe(true);
  });

  it("never deletes an object that won the exact-key no-upsert collision", async () => {
    const archive = await fullArchive();
    const namespace = "ref_7474747474747474";
    const { database, schemas } = referenceDatabase();
    const objects = new Map<string, { ownerToken: string; bytes: Uint8Array }>();
    let collisionKey: string | undefined;
    const sentinel = new TextEncoder().encode("foreign winner");
    const objectSink = {
      async put(input: { namespace: string; path: string }) {
        collisionKey = `${input.namespace}/${input.path}`;
        objects.set(collisionKey, { ownerToken: "foreign-owner", bytes: sentinel });
        throw new Error("OBJECT_ALREADY_EXISTS");
      },
      async removeObjects(targetNamespace: string, paths: string[], ownerToken: string) {
        for (const path of paths) {
          const key = `${targetNamespace}/${path}`;
          const object = objects.get(key);
          if (object?.ownerToken === ownerToken) objects.delete(key);
          else if (object !== undefined) throw new Error("FOREIGN_OBJECT_MUST_NOT_BE_DELETED");
        }
      },
    };
    await expect(importOwnerExportReference({ archive, database, objectSink, namespace }))
      .rejects.toMatchObject({ code: "REFERENCE_IMPORT_CLEANUP_FAILED", namespace });
    expect(collisionKey).toBeDefined();
    expect(objects.get(collisionKey!)?.ownerToken).toBe("foreign-owner");
    const ownerToken = schemas.get(namespace)?.ownerToken;
    expect(schemas.get(namespace)?.paths).toHaveLength(1);
    // Once the independent winner is removed by its owner, retry sees the key
    // absent and can safely discard the retained intent/schema.
    objects.delete(collisionKey!);
    await expect(cleanupOwnerExportReference({ database, objectSink, namespace, ownerToken: ownerToken! }))
      .resolves.toMatchObject({ alreadyClean: false });
    expect(schemas.has(namespace)).toBe(false);
  });

  it("interprets offline-valid v1.0 Content and referenced Analytics without fabricating missing history or declarations", async () => {
    const { database, calls } = referenceDatabase();
    const sink = { async put() {}, async removeObjects() {} };
    const legacy = await legacyV1Archive();
    const checked = validateOwnerExportZip(legacy.archive);
    expect(checked.manifest["schemaVersion"]).toBe("1.0");
    expect(checked.includedScopes).toEqual(["portfolio-content", "analytics-reports"]);
    expect(checked.manifest["dependencies"]).toBeUndefined();
    const importedLegacy = await importOwnerExportReference({ archive: legacy.archive, database, objectSink: sink, namespace: "ref_3131313131313131" });
    expect(importedLegacy).toMatchObject({ includedScopes: ["portfolio-content", "analytics-reports"],
      recordCounts: { "portfolio-content": 1, "analytics-reports": 1 }, totalRecords: 2, dependencyCount: 0, externalDependencyCount: 0 });
    const legacyProjections = calls.filter((call) => call.sql.includes("insert into \"ref_3131313131313131\".reference_model"))
      .map((call) => ({ kind: call.parameters?.[0], identity: call.parameters?.[1], value: JSON.parse(String(call.parameters?.[2])) as Record<string, unknown> }));
    const legacyContent = legacyProjections.find((row) => row.kind === "content-item" && row.identity === legacy.contentId)?.value;
    expect(legacyContent).toMatchObject({ lifecycle: "published", publicLocales: ["ar", "en"],
      publications: null, publicationHistory: null, publicationHistoryAvailable: false,
      publicationInterpretation: "legacy-current-flags-only", firstPublishedAt: null, discoveryOrderAvailable: false,
      routeReservationHistoryAvailable: false, lifecycleHistoryAvailable: false, relationshipHistoryAvailable: false });
    expect(Object.hasOwn(legacyContent!, "projectStatus")).toBe(false);
    expect(Object.hasOwn(legacyContent!, "featured")).toBe(false);
    expect(Object.hasOwn(legacyContent!, "lifecycleHistory")).toBe(false);
    expect(Object.hasOwn(legacyContent!, "relationshipHistory")).toBe(false);
    expect(legacyContent?.["revisions"]).toEqual([
      expect.objectContaining({ revisionId: legacy.englishRevisionId, locale: "en", reviewed: true, currentlyPublished: true }),
      expect.objectContaining({ revisionId: legacy.arabicRevisionId, locale: "ar", reviewed: true, currentlyPublished: true }),
    ]);
    expect((legacyContent?.["revisions"] as Array<Record<string, unknown>>).every((revision) =>
      !Object.hasOwn(revision, "reviewId") && !Object.hasOwn(revision, "reviewedAt"))).toBe(true);
    expect(legacyProjections.find((row) => row.kind === "public-route" && row.identity === legacy.routeId)?.value)
      .toMatchObject({ canonicalSlug: null, canonicalSlugAvailable: false, reservations: null,
        redirects: [{ fromSlug: "old-legacy-project", toSlug: "legacy-project" }], publiclyResolvable: null });
    const legacyGoal = legacyProjections.find((row) => row.kind === "analytics-goal" && row.identity === legacy.goalId)?.value;
    expect(legacyGoal).toMatchObject({ activeVersionId: legacy.versionId, activationSequenceAvailable: false,
      activationHistory: [{ versionId: legacy.versionId, activatedAt: "2026-10-25T10:01:00Z" }] });
    const legacyReports = legacyGoal?.["reports"] as Array<Record<string, unknown>>;
    expect(legacyReports[0]).toMatchObject({ sampleState: "suppressed", countDisposition: "withheld", withheldCount: true });
    expect(Object.hasOwn(legacyReports[0]!, "aggregateCount")).toBe(false);
    expect(legacyReports[1]).toMatchObject({ sampleState: "sufficient", countDisposition: "included", aggregateCount: 12 });
    expect(calls.some((call) => call.sql.includes(".dependencies(ordinal"))).toBe(false);

    const partial = await legacyV1Archive({ includeContent: false });
    const checkedPartial = validateOwnerExportZip(partial.archive);
    expect(checkedPartial.includedScopes).toEqual(["analytics-reports"]);
    expect(checkedPartial.manifest["dependencies"]).toBeUndefined();
    const importedPartial = await importOwnerExportReference({ archive: partial.archive, database, objectSink: sink, namespace: "ref_3232323232323232" });
    expect(importedPartial).toMatchObject({ includedScopes: ["analytics-reports"], dependencyCount: 0, externalDependencyCount: 1 });
    const inferred = calls.filter((call) => call.sql.includes("insert into \"ref_3232323232323232\".external_dependencies"))
      .map((call) => JSON.parse(String(call.parameters?.[1])) as Record<string, unknown>);
    expect(inferred).toEqual([expect.objectContaining({ sourceScope: "analytics-reports", targetScope: "portfolio-content",
      targetId: partial.contentId, disposition: "unspecified-legacy", reason: "scope-not-selected-inferred", declarationAvailable: false })]);

    const invalid = await legacyV1Archive({ duplicateRevisionId: true });
    expect(validateOwnerExportZip(invalid.archive).manifest["schemaVersion"]).toBe("1.0");
    const invalidCalls: string[] = [];
    const invalidWrites: string[] = [];
    await expect(importOwnerExportReference({ archive: invalid.archive,
      database: { async query(sql: string) { invalidCalls.push(sql); return { rows: [] }; } },
      objectSink: { async put(input: { path: string }) { invalidWrites.push(input.path); }, async removeObjects() {} },
      namespace: "ref_3333333333333333" })).rejects.toMatchObject({ code: "REFERENCE_IMPORT_MODEL_REVISION_IDENTITY_INVALID" });
    expect(invalidCalls).toEqual([]);
    expect(invalidWrites).toEqual([]);
  });

  it("imports schema 1.1 Content and Analytics records with legacy history semantics in manifest 1.1 and 1.2", async () => {
    let fixtureNumber = 0;
    const scopeSelections: Array<Array<"portfolio-content" | "analytics-reports">> = [
      ["portfolio-content", "analytics-reports"], ["portfolio-content"], ["analytics-reports"],
    ];
    for (const manifestVersion of ["1.1", "1.2"] as const) {
      for (const contentFacts of ["omitted", "explicit"] as const) for (const scopes of scopeSelections) {
        const fixture = await wrappedLegacyArchive({ manifestVersion, scopes, contentFacts });
        const checked = validateOwnerExportZip(fixture.archive);
        expect(checked.manifest["schemaVersion"]).toBe(manifestVersion);
        expect(checked.includedScopes).toEqual(scopes);
        expect(checked.manifest["entries"]).toEqual(expect.arrayContaining(scopes.map((scope) =>
          expect.objectContaining({ scope, schemaVersion: "1.1", recordSchema: `urn:shipwithali:owner-export-schema:${scope}:1.1` }))));
        const declaredDependencies = checked.manifest["dependencies"] as Array<Record<string, unknown>>;
        if (scopes.includes("portfolio-content")) expect(declaredDependencies).toContainEqual(expect.objectContaining({
          sourceScope: "portfolio-content", sourceId: fixture.contentId, targetScope: "portfolio-content",
          targetId: fixture.relatedProjectId, disposition: "included",
        }));

        const { database, calls } = referenceDatabase();
        const namespace = `ref_${(++fixtureNumber).toString(16).padStart(16, "0")}`;
        const imported = await importOwnerExportReference({ archive: fixture.archive, database,
          objectSink: { async put() {}, async removeObjects() {} }, namespace });
        expect(imported).toMatchObject({ includedScopes: scopes, totalRecords: (scopes.includes("portfolio-content") ? 2 : 0) +
          (scopes.includes("analytics-reports") ? 1 : 0),
          dependencyCount: (scopes.includes("portfolio-content") ? 1 : 0) + (scopes.includes("analytics-reports") ? 2 : 0),
          externalDependencyCount: scopes.includes("analytics-reports") && !scopes.includes("portfolio-content") ? 2 : 0 });
        const projections = calls.filter((call) => call.sql.startsWith("insert into") && call.sql.includes(`"${namespace}".reference_model`))
          .map((call) => ({ kind: call.parameters?.[0], identity: call.parameters?.[1],
            value: JSON.parse(String(call.parameters?.[2])) as Record<string, unknown> }));

        if (scopes.includes("portfolio-content")) {
          const content = projections.find((row) => row.kind === "content-item" && row.identity === fixture.contentId)?.value;
          expect(content).toMatchObject({ contentId: fixture.contentId, lifecycle: "published",
            publicLocales: ["en"], publiclyDiscoverable: true, publications: null, publicationHistory: null,
            publicationHistoryAvailable: false, publicationInterpretation: "legacy-current-flags-only",
            firstPublishedAt: null, discoveryOrderAvailable: false, routeReservationHistoryAvailable: false,
            lifecycleHistoryAvailable: false, relationshipHistoryAvailable: false, relatedProjectIds: [fixture.relatedProjectId] });
          if (contentFacts === "omitted") {
            expect(Object.hasOwn(content!, "projectStatus")).toBe(false);
            expect(Object.hasOwn(content!, "featured")).toBe(false);
          } else {
            expect(content).toMatchObject({ projectStatus: null, featured: false });
          }
          expect(Object.hasOwn(content!, "lifecycleHistory")).toBe(false);
          expect(Object.hasOwn(content!, "relationshipHistory")).toBe(false);
          expect(content?.["revisions"]).toEqual([expect.objectContaining({ revisionId: fixture.revisionId, locale: "en",
            sequence: 2, reviewed: true, currentlyPublished: true })]);
          const relationship = projections.find((row) => row.kind === "content-relationship" &&
            row.identity === `${fixture.contentId}:${fixture.relatedProjectId}`)?.value;
          expect(relationship).toMatchObject({ contentId: fixture.contentId, relatedContentId: fixture.relatedProjectId,
            selected: true, historyAvailable: false });
          expect(Object.hasOwn(relationship!, "history")).toBe(false);
          expect(projections.find((row) => row.kind === "content-item" && row.identity === fixture.relatedProjectId)?.value)
            .toMatchObject({ contentId: fixture.relatedProjectId, contentType: "project", lifecycle: "draft" });
          const revision = content?.["revisions"] as Array<Record<string, unknown>>;
          expect(revision.every((item) => !Object.hasOwn(item, "reviewId") && !Object.hasOwn(item, "reviewedAt"))).toBe(true);
          expect(projections.find((row) => row.kind === "public-route" && row.identity === fixture.routeId)?.value)
            .toMatchObject({ contentId: fixture.contentId, canonicalSlug: null, canonicalSlugAvailable: false,
              reservations: null, routeReservationHistoryAvailable: false,
              redirects: [{ fromSlug: "old-wrapped-project", toSlug: "wrapped-project" }], publiclyResolvable: null });
        }

        if (scopes.includes("analytics-reports")) {
          const goal = projections.find((row) => row.kind === "analytics-goal" && row.identity === fixture.goalId)?.value;
          expect(goal).toMatchObject({ goalId: fixture.goalId, activeVersionId: fixture.activeVersionId,
            activationSequenceAvailable: false, activationHistory: [
              { versionId: fixture.firstVersionId, activatedAt: "2026-10-01T11:00:00Z" },
              { versionId: fixture.activeVersionId, activatedAt: "2026-10-02T11:00:00Z" },
            ] });
          const history = goal?.["activationHistory"] as Array<Record<string, unknown>>;
          expect(history.every((event) => !Object.hasOwn(event, "activationSequence"))).toBe(true);
          expect(goal?.["reports"]).toEqual([
            { goalVersionId: fixture.activeVersionId, sampleState: "suppressed", countDisposition: "withheld", withheldCount: true },
            { goalVersionId: fixture.activeVersionId, sampleState: "sufficient", countDisposition: "included", aggregateCount: 12 },
          ]);
          const external = calls.filter((call) => call.sql.startsWith("insert into") && call.sql.includes(`"${namespace}".external_dependencies`))
            .map((call) => JSON.parse(String(call.parameters?.[1])) as Record<string, unknown>);
          if (scopes.length === 1) {
            expect(external).toEqual(expect.arrayContaining([
              expect.objectContaining({ targetId: fixture.contentId, disposition: "omitted", reason: "scope-not-selected" }),
              expect.objectContaining({ targetId: fixture.routeId, disposition: "omitted", reason: "scope-not-selected" }),
            ]));
            expect(external.every((edge) => !Object.hasOwn(edge, "declarationAvailable"))).toBe(true);
            expect(projections.some((row) => row.kind === "content-item" || row.kind === "public-route")).toBe(false);
          }
        }
      }
    }
  });

  it("preserves additive minor-version goal semantics", async () => {
    const { database, calls } = referenceDatabase();
    const sink = { async put() {}, async removeObjects() {} };

    const analytics = await snapshotFor(["analytics-reports"]);
    const built = await buildSelectedOwnerExportPackage({ exportId: fixtureIds.snapshot as never, snapshot: analytics });
    const additive = await rewriteManifest(await collect(built.content), (manifest) => {
      manifest["extensions"] = { ...(manifest["extensions"] as Record<string, unknown>), producerNote: "opaque minor-version metadata" };
    });
    const additiveVersion = validateOwnerExportZip(additive).manifest["schemaVersion"];
    expect(additiveVersion).toMatch(/^1\.[0-9]+$/u);
    const importedAdditive = await importOwnerExportReference({ archive: additive, database, objectSink: sink, namespace: "ref_4141414141414141" });
    expect(importedAdditive).toMatchObject({ includedScopes: ["analytics-reports"], recordCounts: { "analytics-reports": 1 } });
    const retainedManifests = calls.filter((call) => call.sql.includes("insert into") && call.sql.includes("package_manifest"))
      .map((call) => JSON.parse(String(call.parameters?.[0])) as Record<string, unknown>);
    expect(retainedManifests[0]?.["schemaVersion"]).toBe(additiveVersion);
    expect(retainedManifests[0]?.["extensions"]).toMatchObject({ producerNote: "opaque minor-version metadata",
      analyticsReportPolicy: { withheldCounts: "omitted" } });
    const additiveProjection = calls.filter((call) => call.sql.includes("insert into \"") && call.sql.includes(".reference_model"))
      .map((call) => ({ kind: call.parameters?.[0], value: JSON.parse(String(call.parameters?.[2])) as Record<string, unknown> }))
      .filter((row) => row.kind === "analytics-goal").at(-1);
    expect(additiveProjection?.value).toMatchObject({
      activeVersionId: fixtureIds.goalV2, versions: [{ versionId: fixtureIds.goalV1 }, { versionId: fixtureIds.goalV2 }],
      activationHistory: [{ activationSequence: 1 }, { activationSequence: 2 }], activationSequenceAvailable: true,
    });
  });
});
