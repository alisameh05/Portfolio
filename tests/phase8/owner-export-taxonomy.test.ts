import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildSelectedOwnerExportPackage, createStoredOwnerExportZip, type OwnerExportSelectedSnapshot } from "../../src/modules/portability-operations/application/owner-export-package.js";
import { isManifestShape } from "../../src/modules/portability-operations/application/owner-export-service.js";
import { validateOwnerExportZip } from "../../scripts/owner-export/validator.mjs";

interface TaxonomyManifest {
  readonly schemaVersion: string;
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
  readonly recordCounts: Readonly<Record<string, number>>;
  readonly manifest: TaxonomyManifest;
}

function validateTaxonomyZip(bytes: Uint8Array): TaxonomyValidation {
  return validateOwnerExportZip(bytes) as unknown as TaxonomyValidation;
}

const at = "2030-10-24T10:00:00.000Z";
const id = (suffix: string) => `018f4f7d-5000-7000-8000-000000000${suffix}`;
const taxonomyId = "01890f3e-7b2f-7cc0-98cf-5a2890378ef8";
const valueA = id("101");
const valueB = id("102");
const valueC = id("103");
const projectId = id("201");

function taxonomyRecord() {
  return {
    taxonomyId,
    aggregateVersion: 7,
    kind: "technology",
    values: [
      { valueId: valueA, name: "Service Layer", state: "merged", valueVersion: 3, mergedIntoValueId: valueB },
      { valueId: valueB, name: "Services", state: "active", valueVersion: 1 },
      { valueId: valueC, name: "Legacy", state: "retired", valueVersion: 2 },
    ],
    evolutionHistory: [
      { valueId: valueA, transitionSequence: 1, action: "created", previousName: null, name: "Service", state: "active", changedAt: at },
      { valueId: valueA, transitionSequence: 2, action: "renamed", previousName: "Service", name: "Service Layer", state: "active", changedAt: at },
      { valueId: valueA, transitionSequence: 3, action: "merged", previousName: "Service Layer", name: "Service Layer", state: "merged", changedAt: at, mergedIntoValueId: valueB },
      { valueId: valueB, transitionSequence: 1, action: "created", previousName: null, name: "Services", state: "active", changedAt: at },
      { valueId: valueC, transitionSequence: 1, action: "created", previousName: null, name: "Legacy", state: "active", changedAt: at },
      { valueId: valueC, transitionSequence: 2, action: "retired", previousName: "Legacy", name: "Legacy", state: "retired", changedAt: at },
    ],
    assignments: [{ targetId: projectId, taxonomyValueId: valueB, assignedAt: at }],
    assignmentHistory: [
      { targetId: projectId, taxonomyValueId: valueA, sequence: 1, projectVersion: 2, changedAt: at },
      { targetId: projectId, taxonomyValueId: valueB, sequence: 2, projectVersion: 3, changedAt: at },
    ],
  };
}

function projectRecord() {
  const revisionId = id("301");
  return {
    contentId: projectId,
    contentType: "project",
    lifecycle: "draft",
    aggregateVersion: 1,
    candidateSlug: "taxonomy-project",
    firstPublishedAt: null,
    projectStatus: null,
    featured: false,
    revisions: [{
      revisionId, locale: "en", sequence: 1, aggregateVersion: 1, savedAt: at,
      title: "Taxonomy project", summary: "Fixture summary", body: "Fixture body",
      reviewed: false, currentlyPublished: false, payload: {
        contentType: "project", locale: "en", title: "Taxonomy project", summary: "Fixture summary", body: "Fixture body",
      }, reviews: [],
    }],
    publications: [], publicationHistory: [], lifecycleHistory: [], publicRouteIdentity: null, publicRoute: null,
    routeHistory: [], relatedProjectIds: [], relationshipHistory: [], taxonomyValueIds: [valueB],
    taxonomyAssignments: [{ taxonomyId, kind: "technology", valueId: valueB }],
    mediaAssetIds: [], evidenceItems: [], publicDiscoveryOrder: null,
  };
}

function snapshot(scopes: OwnerExportSelectedSnapshot["includedScopes"], taxonomy = taxonomyRecord()): OwnerExportSelectedSnapshot {
  const configuration = scopes.includes("portfolio-configuration") ? {
    snapshotId: id("401") as OwnerExportSelectedSnapshot["snapshotId"], capturedAt: at, configurationVersion: null,
    settings: null, capabilities: { currentCvAvailable: false, externalLinksAvailable: false, globalProjectCtaAvailable: false },
  } : undefined;
  const content = scopes.includes("portfolio-content")
    ? { records: [{ contentId: projectId, value: projectRecord() as unknown as Readonly<Record<string, unknown>> }] }
    : undefined;
  const taxonomySnapshot = scopes.includes("taxonomy")
    ? { records: [{ taxonomyId, value: taxonomy as unknown as Readonly<Record<string, unknown>> }] }
    : undefined;
  return {
    kind: "owner-export-snapshot-v1", snapshotId: id("402") as OwnerExportSelectedSnapshot["snapshotId"], capturedAt: at,
    includedScopes: scopes,
    ...(configuration === undefined ? {} : { configuration }),
    ...(content === undefined ? {} : { content }),
    ...(taxonomySnapshot === undefined ? {} : { taxonomy: taxonomySnapshot }),
  };
}

async function bytesOf(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of content) { chunks.push(chunk); size += chunk.byteLength; }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function unzipStored(bytes: Uint8Array): Map<string, Uint8Array> {
  const entries = new Map<string, Uint8Array>();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 4 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const length = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength));
    const start = nameStart + nameLength + extraLength;
    entries.set(name, bytes.slice(start, start + length));
    offset = start + length;
  }
  return entries;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function canonical(value: unknown, root = true): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, false)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => !(root && key === "digest")).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key], false)}`).join(",")}}`;
}

async function rebuild(entries: Map<string, Uint8Array>): Promise<Uint8Array> {
  const zip = createStoredOwnerExportZip([...entries].map(([name, bytes]) => ({
    name, contentLength: bytes.byteLength, crc32: crc32(bytes), content: () => ({ async *[Symbol.asyncIterator]() { yield bytes; } }),
  })));
  return bytesOf(zip.content);
}

interface MutableTaxonomyManifest extends Record<string, unknown> {
  digest: string;
  entries: { scope: string; recordCount: number; digest: string }[];
  dependencies: TaxonomyManifest["dependencies"][number][];
}

interface MutableTaxonomyRecord {
  taxonomyId: string;
  aggregateVersion: number;
  kind: string;
  values: { valueId: string; name: string; state: string; valueVersion: number; mergedIntoValueId?: string }[];
  evolutionHistory: {
    valueId: string; transitionSequence: number; action: string; previousName: string | null;
    name: string; state: string; changedAt: string; mergedIntoValueId?: string;
  }[];
  assignments: { targetId: string; taxonomyValueId: string; assignedAt: string }[];
}

function rewriteManifest(entries: Map<string, Uint8Array>, edit: (manifest: MutableTaxonomyManifest) => void): void {
  const manifest = JSON.parse(new TextDecoder().decode(entries.get("manifest.json")!)) as MutableTaxonomyManifest;
  edit(manifest);
  manifest.digest = createHash("sha256").update(canonical(manifest)).digest("hex");
  entries.set("manifest.json", new TextEncoder().encode(`${JSON.stringify(manifest)}\n`));
}

function rewriteTaxonomyRecord(
  entries: Map<string, Uint8Array>,
  edit: (record: MutableTaxonomyRecord) => void,
  additionalDependencies: TaxonomyManifest["dependencies"][number][] = [],
): void {
  const recordPath = "records/taxonomy.ndjson";
  const record = JSON.parse(new TextDecoder().decode(entries.get(recordPath)!)) as { value: MutableTaxonomyRecord };
  edit(record.value);
  const recordBytes = new TextEncoder().encode(`${JSON.stringify(record)}\n`);
  entries.set(recordPath, recordBytes);
  rewriteManifest(entries, (manifest) => {
    const descriptor = manifest.entries.find((entry) => entry.scope === "taxonomy")!;
    descriptor.digest = createHash("sha256").update(recordBytes).digest("hex");
    manifest.dependencies.push(...additionalDependencies);
    const scopeOrder = ["portfolio-content", "taxonomy", "media-metadata", "cv-metadata", "moderation-history", "analytics-reports", "portfolio-configuration"];
    const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
    manifest.dependencies.sort((left, right) =>
      scopeOrder.indexOf(left.sourceScope) - scopeOrder.indexOf(right.sourceScope) ||
      compareText(left.sourceId, right.sourceId) ||
      scopeOrder.indexOf(left.targetScope) - scopeOrder.indexOf(right.targetScope) ||
      compareText(left.targetId, right.targetId),
    );
  });
}

describe("Phase 8 #242 taxonomy export package", () => {
  it("AC01-02 emits stable identities, current assignments, and ordered create/rename/retire/merge history", async () => {
    const built = await buildSelectedOwnerExportPackage({ exportId: id("501") as never, snapshot: snapshot(["taxonomy"]) });
    const archive = await bytesOf(built.content);
    expect(isManifestShape(built.manifest)).toBe(true);
    const checked = validateTaxonomyZip(archive);
    expect(checked.manifest.schemaVersion).toBe("1.4");
    expect(checked.recordCounts).toEqual({ taxonomy: 1 });
    const recordBytes = unzipStored(archive).get("records/taxonomy.ndjson")!;
    const record = JSON.parse(new TextDecoder().decode(recordBytes)).value;
    expect(record.values.map((value: { valueId: string }) => value.valueId)).toEqual([valueA, valueB, valueC]);
    expect(record.evolutionHistory.map((event: { action: string }) => event.action)).toEqual([
      "created", "renamed", "merged", "created", "created", "retired",
    ]);
    expect(record.evolutionHistory.at(2)).toMatchObject({ valueId: valueA, mergedIntoValueId: valueB });
    expect(record.assignments).toEqual([{ targetId: projectId, taxonomyValueId: valueB, assignedAt: at }]);
    expect(record.assignmentHistory.map((event: { taxonomyValueId: string }) => event.taxonomyValueId)).toEqual([valueA, valueB]);
  });

  it("AC04 declares Project dependencies without widening taxonomy-only selection and resolves them in full packages", async () => {
    const taxonomyOnly = await buildSelectedOwnerExportPackage({ exportId: id("502") as never, snapshot: snapshot(["taxonomy"]) });
    const onlyBytes = await bytesOf(taxonomyOnly.content);
    const only = validateTaxonomyZip(onlyBytes);
    expect(only.includedScopes).toEqual(["taxonomy"]);
    expect(only.manifest.entries.map((entry: { scope: string }) => entry.scope)).toEqual(["taxonomy"]);
    expect(only.manifest.dependencies.filter((edge: { targetScope: string }) => edge.targetScope === "portfolio-content")
      .every((edge: { disposition: string; reason?: string }) => edge.disposition === "omitted" && edge.reason === "scope-not-selected")).toBe(true);

    const full = await buildSelectedOwnerExportPackage({
      exportId: id("503") as never, snapshot: snapshot(["portfolio-content", "taxonomy"]),
    });
    const fullResult = validateTaxonomyZip(await bytesOf(full.content));
    expect(fullResult.includedScopes).toEqual(["portfolio-content", "taxonomy"]);
    expect(fullResult.manifest.dependencies.filter((edge: { targetScope: string }) => edge.targetScope === "portfolio-content")
      .every((edge: { disposition: string }) => edge.disposition === "included")).toBe(true);
  });

  it("AC04 rejects missing or extra current taxonomy assignments in combined Content packages", async () => {
    const built = await buildSelectedOwnerExportPackage({
      exportId: id("507") as never, snapshot: snapshot(["portfolio-content", "taxonomy"]),
    });
    const original = await bytesOf(built.content);
    expect(() => validateTaxonomyZip(original)).not.toThrow();

    const missing = unzipStored(original);
    rewriteTaxonomyRecord(missing, (record) => { record.assignments = []; });
    const missingBytes = await rebuild(missing);
    expect(() => validateTaxonomyZip(missingBytes)).toThrow(/TAXONOMY_SNAPSHOT_FACTS_INVALID/);

    const extra = unzipStored(original);
    const extraValueId = id("104");
    rewriteTaxonomyRecord(extra, (record) => {
      record.aggregateVersion += 1;
      record.values.push({ valueId: extraValueId, name: "Unassigned", state: "active", valueVersion: 1 });
      record.evolutionHistory.push({
        valueId: extraValueId, transitionSequence: 1, action: "created", previousName: null,
        name: "Unassigned", state: "active", changedAt: at,
      });
      record.assignments.push({ targetId: projectId, taxonomyValueId: extraValueId, assignedAt: at });
    }, [{
      sourceScope: "taxonomy", sourceId: taxonomyId, targetScope: "taxonomy", targetId: extraValueId, disposition: "included",
    }]);
    const extraBytes = await rebuild(extra);
    expect(() => validateTaxonomyZip(extraBytes)).toThrow(/TAXONOMY_SNAPSHOT_FACTS_INVALID/);
  });

  it("AC05 declares a selected empty taxonomy as a zero-byte entry and rejects dangling merge mappings", async () => {
    const empty = await buildSelectedOwnerExportPackage({
      exportId: id("504") as never,
      snapshot: { ...snapshot(["taxonomy"]), taxonomy: { records: [] } },
    });
    const emptyBytes = await bytesOf(empty.content);
    expect(validateTaxonomyZip(emptyBytes).recordCounts).toEqual({ taxonomy: 0 });
    expect(unzipStored(emptyBytes).get("records/taxonomy.ndjson")).toHaveLength(0);

    const dangling = taxonomyRecord();
    dangling.values[0] = { ...dangling.values[0]!, mergedIntoValueId: id("999") };
    const invalid = await buildSelectedOwnerExportPackage({ exportId: id("505") as never, snapshot: snapshot(["taxonomy"], dangling) });
    const entries = unzipStored(await bytesOf(invalid.content));
    const record = JSON.parse(new TextDecoder().decode(entries.get("records/taxonomy.ndjson")!));
    record.value.values[0].mergedIntoValueId = id("999");
    entries.set("records/taxonomy.ndjson", new TextEncoder().encode(`${JSON.stringify(record)}\n`));
    rewriteManifest(entries, (manifest) => {
      const descriptor = manifest.entries.find((entry) => entry.scope === "taxonomy")!;
      descriptor.digest = createHash("sha256").update(entries.get("records/taxonomy.ndjson")!).digest("hex");
    });
    const danglingBytes = await rebuild(entries);
    expect(() => validateTaxonomyZip(danglingBytes)).toThrow(/TAXONOMY_SNAPSHOT_FACTS_INVALID/);
  });

  it("AC05 rejects record-count, schema-byte, and archive-integrity corruption", async () => {
    const built = await buildSelectedOwnerExportPackage({ exportId: id("506") as never, snapshot: snapshot(["taxonomy"]) });
    const source = unzipStored(await bytesOf(built.content));

    const countCorruption = new Map(source);
    rewriteManifest(countCorruption, (manifest) => { manifest.entries[0]!.recordCount += 1; });
    const countBytes = await rebuild(countCorruption);
    expect(() => validateTaxonomyZip(countBytes)).toThrow(/ENTRY_COUNT_MISMATCH/);

    const schemaCorruption = new Map(source);
    schemaCorruption.set("schemas/taxonomy.schema.json", new TextEncoder().encode("{}\n"));
    const schemaBytes = await rebuild(schemaCorruption);
    expect(() => validateTaxonomyZip(schemaBytes)).toThrow();

    const hashCorruption = await bytesOf(built.content);
    const corruptionOffset = hashCorruption.length - 12;
    hashCorruption[corruptionOffset] = hashCorruption[corruptionOffset]! ^ 0xff;
    expect(() => validateTaxonomyZip(hashCorruption)).toThrow();
  });
});
