import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  matchesFeedbackOwnerExportSnapshot,
  projectFeedbackOwnerExportSnapshot,
} from "../../src/modules/interaction-moderation/application/owner-export.js";
import { pendingFeedbackExpiryAt, suppressedFeedbackExpiryAt } from "../../src/modules/interaction-moderation/application/retention.js";
import { buildSelectedOwnerExportPackage, createStoredOwnerExportZip, type OwnerExportSelectedSnapshot, type StoredOwnerExportZipEntry } from "../../src/modules/portability-operations/application/owner-export-package.js";
import { validateOwnerExportZip } from "../../scripts/owner-export/validator.mjs";
import { createOwnerExportService } from "../../src/modules/portability-operations/application/owner-export-service.js";
import { createHash } from "node:crypto";

const id = (tail: string) => `0196a1b2-7c3d-7e11-9f22-${tail.padStart(12, "0")}`;
const projectId = id("201");
const submittedAt = "2026-01-31T12:00:00.000Z";
const pendingExpiry = pendingFeedbackExpiryAt(submittedAt);
const suppressedAt = "2024-01-31T12:00:00.000Z";
const suppressedExpiry = suppressedFeedbackExpiryAt(suppressedAt);

function feedback(overrides: Partial<Parameters<typeof projectFeedbackOwnerExportSnapshot>[0]["records"][number]> = {}) {
  return {
    feedbackId: id("1") as never,
    projectId: projectId as never,
    locale: "en" as const,
    aggregateVersion: 2,
    state: "pending" as const,
    authorName: "PRIVATE_NAME_SENTINEL",
    paragraph: "PRIVATE_TEXT_SENTINEL",
    submittedAt,
    textErasedAt: null,
    decisions: [],
    ...overrides,
  };
}

function moderationSnapshot(
  capturedAt: string,
  records: readonly { feedbackId: string; value: Readonly<Record<string, unknown>> }[],
  withConfiguration = false,
  withEmptyContent = false,
): OwnerExportSelectedSnapshot {
  const includedScopes: OwnerExportSelectedSnapshot["includedScopes"] = withEmptyContent
    ? ["portfolio-content", "moderation-history"]
    : withConfiguration ? ["moderation-history", "portfolio-configuration"] : ["moderation-history"];
  return {
    kind: "owner-export-snapshot-v1",
    snapshotId: id("202") as OwnerExportSelectedSnapshot["snapshotId"],
    capturedAt,
    includedScopes,
    ...(withEmptyContent ? { content: { records: [] } } : {}),
    moderation: { records },
    ...(withConfiguration ? { configuration: {
      snapshotId: id("203") as OwnerExportSelectedSnapshot["snapshotId"],
      capturedAt,
      configurationVersion: null,
      settings: null,
      capabilities: { currentCvAvailable: false, externalLinksAvailable: false, globalProjectCtaAvailable: false },
    } } : {}),
  };
}

async function bytes(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of content) { chunks.push(chunk); length += chunk.byteLength; }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function zipEntry(archive: Uint8Array, wanted: string): Uint8Array {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    const length = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = new TextDecoder().decode(archive.subarray(nameStart, nameStart + nameLength));
    const start = nameStart + nameLength + extraLength;
    if (name === wanted) return archive.subarray(start, start + length);
    offset = start + length;
  }
  throw new Error("OWNER_EXPORT_TEST_ZIP_ENTRY_MISSING");
}

function canonicalJson(value: unknown, omitRootDigest = false): string {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    const encoded = JSON.stringify(value);
    if (encoded !== undefined) return encoded;
    throw new TypeError("OWNER_EXPORT_TEST_JSON_INVALID");
  }
  if (typeof value !== "object") throw new TypeError("OWNER_EXPORT_TEST_JSON_INVALID");
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter(key => !(omitRootDigest && key === "digest")).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zipMember(name: string, content: Uint8Array): StoredOwnerExportZipEntry {
  return {
    name,
    contentLength: content.byteLength,
    crc32: crc32(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    async *content() { yield content; },
  };
}

describe("Phase 8 #245 retention-aware Moderation export", () => {
  it("AC04 compares portable facts independently of object key order but preserves history order", () => {
    const source = { capturedAt: "2026-02-01T12:00:00.000Z", records: [feedback({ state: "suppressed", decisions: [
      { sequence: 1, decision: "approved", reason: "Approval", decidedAt: submittedAt },
      { sequence: 2, decision: "suppressed", reason: "Suppression", decidedAt: "2026-02-01T00:00:00.000Z" },
    ] })] };
    const expected = projectFeedbackOwnerExportSnapshot(source).records;
    const reordered = JSON.parse(JSON.stringify(expected), (_key, value: unknown) => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
      return Object.fromEntries(Object.entries(value).reverse());
    }) as typeof expected;
    expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(expected));
    expect(matchesFeedbackOwnerExportSnapshot(reordered, source)).toBe(true);
    expect(matchesFeedbackOwnerExportSnapshot([{ ...reordered[0]!, value: { ...reordered[0]!.value, paragraph: "Changed" } }], source)).toBe(false);
    expect(matchesFeedbackOwnerExportSnapshot([{ ...reordered[0]!, value: { ...reordered[0]!.value,
      decisionHistory: [...reordered[0]!.value.decisionHistory].reverse() } }], source)).toBe(false);
    expect(matchesFeedbackOwnerExportSnapshot([], source)).toBe(false);
  });

  it("AC02 applies the exact 90-day pending and rejected boundaries, including stale rows", () => {
    const pending = feedback();
    const rejected = feedback({ feedbackId: id("2") as never, state: "rejected", decisions: [
      { sequence: 1, decision: "rejected", reason: "Actual rejection", decidedAt: "2026-03-31T12:00:00.000Z" },
    ] });
    for (const [state, row] of [["pending", pending], ["rejected", rejected]] as const) {
      expect(projectFeedbackOwnerExportSnapshot({ capturedAt: new Date(Date.parse(pendingExpiry) - 1).toISOString(), records: [row] }).records)
        .toHaveLength(1);
      expect(projectFeedbackOwnerExportSnapshot({ capturedAt: pendingExpiry, records: [row] }).records)
        .toHaveLength(0);
      expect(projectFeedbackOwnerExportSnapshot({ capturedAt: new Date(Date.parse(pendingExpiry) + 1).toISOString(), records: [row] }).records)
        .toHaveLength(0);
      expect(state).toBe(row.state);
    }
  });

  it("AC02 clamps 12 calendar months at month end and strips text and reasons at the exact deadline", () => {
    expect(suppressedFeedbackExpiryAt("2024-01-31T12:00:00.000Z")).toBe("2025-01-31T12:00:00.000Z");
    expect(suppressedFeedbackExpiryAt("2024-02-29T12:00:00.000Z")).toBe("2025-02-28T12:00:00.000Z");
    const row = feedback({
      state: "suppressed", submittedAt: "2024-01-30T12:00:00.000Z",
      decisions: [{ sequence: 1, decision: "suppressed", reason: "Actual suppression reason", decidedAt: suppressedAt }],
    });
    const before = projectFeedbackOwnerExportSnapshot({
      capturedAt: new Date(Date.parse(suppressedExpiry) - 1).toISOString(), records: [row],
    }).records[0]?.value;
    expect(before).toMatchObject({ textDisposition: "retained", authorName: "PRIVATE_NAME_SENTINEL", paragraph: "PRIVATE_TEXT_SENTINEL" });
    expect(before?.decisionHistory[0]).toMatchObject({ sequence: 1, decision: "suppressed", reason: "Actual suppression reason" });
    const at = projectFeedbackOwnerExportSnapshot({ capturedAt: suppressedExpiry, records: [row] }).records[0]?.value;
    expect(at).toMatchObject({ textDisposition: "erased", feedbackId: id("1"), projectId });
    expect(at).not.toHaveProperty("authorName");
    expect(at).not.toHaveProperty("paragraph");
    expect(at?.decisionHistory[0]).not.toHaveProperty("reason");
    const after = projectFeedbackOwnerExportSnapshot({
      capturedAt: new Date(Date.parse(suppressedExpiry) + 1).toISOString(), records: [row],
    }).records[0]?.value;
    expect(after).toMatchObject({ textDisposition: "erased", state: "suppressed" });
    expect(after).not.toHaveProperty("authorName");
    expect(after?.decisionHistory[0]).not.toHaveProperty("reason");
  });

  it("AC02 preserves a truthful minimal audit after an earlier text erasure", () => {
    const row = feedback({
      state: "suppressed", submittedAt: "2024-01-01T00:00:00.000Z", authorName: null, paragraph: null, textErasedAt: "2024-12-31T00:00:00.000Z",
      decisions: [
        { sequence: 1, decision: "approved", reason: "Historical reason", decidedAt: "2024-01-01T00:00:00.000Z" },
        { sequence: 2, decision: "suppressed", reason: null, decidedAt: suppressedAt },
      ],
    });
    const value = projectFeedbackOwnerExportSnapshot({ capturedAt: "2024-12-31T00:00:01.000Z", records: [row] }).records[0]?.value;
    expect(value).toMatchObject({ textDisposition: "erased", state: "suppressed", projectId, locale: "en" });
    expect(value?.decisionHistory).toEqual([
      { sequence: 1, decision: "approved", decidedAt: "2024-01-01T00:00:00.000Z" },
      { sequence: 2, decision: "suppressed", decidedAt: suppressedAt },
    ]);
    expect(value).not.toHaveProperty("authorName");
    expect(value).not.toHaveProperty("paragraph");
  });

  it("AC01/AC05/AC08 independently validates moderation-only, combined, and empty-history packages", async () => {
    const projection = projectFeedbackOwnerExportSnapshot({
      capturedAt: "2026-10-25T12:00:00.000Z",
      records: [
        feedback({ state: "approved", decisions: [{ sequence: 1, decision: "approved", reason: "Actual decision", decidedAt: "2026-01-31T12:00:00.000Z" }] }),
        feedback({ feedbackId: id("2") as never, state: "suppressed", authorName: null, paragraph: null,
          textErasedAt: "2025-01-31T12:00:00.000Z", decisions: [{ sequence: 1, decision: "suppressed", reason: null, decidedAt: suppressedAt }] }),
      ],
    });
    const onlyModeration = await buildSelectedOwnerExportPackage({
      exportId: id("204") as never,
      snapshot: moderationSnapshot(projection.capturedAt, projection.records),
    });
    const onlyBytes = await bytes(onlyModeration.content);
    const checkedOnly = validateOwnerExportZip(onlyBytes);
    expect(checkedOnly.manifest.schemaVersion).toBe("1.7");
    expect(checkedOnly.manifest.includedScopes).toEqual(["moderation-history"]);
    expect(checkedOnly.manifest.entries[0]).toMatchObject({ scope: "moderation-history", schemaVersion: "1.2", recordCount: 2 });
    expect(checkedOnly.manifest.dependencies).toEqual(projection.records.map(record => ({ sourceId: record.feedbackId,
      sourceScope: "moderation-history", targetId: projectId, targetScope: "portfolio-content", disposition: "omitted", reason: "scope-not-selected" })));
    const portableRecords = new TextDecoder().decode(zipEntry(onlyBytes, "records/moderation-history.ndjson"))
      .trim().split("\n").map(line => JSON.parse(line) as { value: Record<string, unknown> });
    expect(portableRecords[0]?.value).toHaveProperty("authorName", "PRIVATE_NAME_SENTINEL");
    expect(portableRecords[1]?.value).not.toHaveProperty("authorName");
    expect((portableRecords[1]?.value["decisionHistory"] as Record<string, unknown>[])[0]).not.toHaveProperty("reason");

    const combined = await buildSelectedOwnerExportPackage({
      exportId: id("205") as never,
      snapshot: moderationSnapshot(projection.capturedAt, projection.records, true),
    });
    expect(validateOwnerExportZip(await bytes(combined.content)).manifest.includedScopes)
      .toEqual(["moderation-history", "portfolio-configuration"]);

    const partialProject = await buildSelectedOwnerExportPackage({
      exportId: id("213") as never,
      snapshot: moderationSnapshot(projection.capturedAt, projection.records, false, true),
    });
    const checkedPartialProject = validateOwnerExportZip(await bytes(partialProject.content));
    expect(checkedPartialProject.manifest.includedScopes).toEqual(["portfolio-content", "moderation-history"]);
    expect(checkedPartialProject.manifest.dependencies).toEqual(projection.records.map(record => ({ sourceId: record.feedbackId,
      sourceScope: "moderation-history", targetId: projectId, targetScope: "portfolio-content", disposition: "omitted", reason: "not-retained" })));

    const empty = await buildSelectedOwnerExportPackage({
      exportId: id("206") as never,
      snapshot: moderationSnapshot(projection.capturedAt, []),
    });
    const checkedEmpty = validateOwnerExportZip(await bytes(empty.content));
    expect(checkedEmpty.manifest.entries.find((entry) => entry.scope === "moderation-history"))
      .toMatchObject({ recordCount: 0, digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" });

    const stalePending = await buildSelectedOwnerExportPackage({
      exportId: id("214") as never,
      snapshot: moderationSnapshot(pendingExpiry, [{ feedbackId: id("1"), value: {
        feedbackId: id("1"), projectId, locale: "en", aggregateVersion: 2, state: "pending", textDisposition: "retained",
        authorName: "PRIVATE_NAME_SENTINEL", paragraph: "PRIVATE_TEXT_SENTINEL", submittedAt, decisionHistory: [],
      } }]),
    });
    await expect(async () => validateOwnerExportZip(await bytes(stalePending.content)))
      .rejects.toThrow("PACKAGE_MODERATION_RETENTION_INVALID");
    const staleSuppression = await buildSelectedOwnerExportPackage({
      exportId: id("215") as never,
      snapshot: moderationSnapshot(suppressedExpiry, [{ feedbackId: id("1"), value: {
        feedbackId: id("1"), projectId, locale: "en", aggregateVersion: 2, state: "suppressed", textDisposition: "retained",
        authorName: "PRIVATE_NAME_SENTINEL", paragraph: "PRIVATE_TEXT_SENTINEL", submittedAt: "2024-01-30T12:00:00.000Z",
        decisionHistory: [{ sequence: 1, decision: "suppressed", reason: "Actual suppression", decidedAt: suppressedAt }],
      } }]),
    });
    await expect(async () => validateOwnerExportZip(await bytes(staleSuppression.content)))
      .rejects.toThrow("PACKAGE_MODERATION_RETENTION_INVALID");
  });

  it("AC05 independently rejects erased audit rows that still retain decision reasons", async () => {
    const moderationSchema = new Uint8Array(readFileSync("schemas/owner-export/v1.2/moderation-history.schema.json"));
    const manifestSchema = new Uint8Array(readFileSync("schemas/owner-export/v1.6/manifest.schema.json"));
    const feedbackId = id("216");
    const erasedAudit = {
      scope: "moderation-history",
      value: {
        feedbackId,
        projectId,
        locale: "en",
        aggregateVersion: 3,
        state: "suppressed",
        textDisposition: "erased",
        submittedAt: "2024-01-31T11:00:00.000Z",
        decisionHistory: [{ sequence: 1, decision: "suppressed", reason: "PRIVATE_REASON_SENTINEL", decidedAt: "2024-01-31T12:00:00.000Z" }],
      },
    };
    const recordBytes = new TextEncoder().encode(`${JSON.stringify(erasedAudit)}\n`);
    const recordDigest = createHash("sha256").update(recordBytes).digest("hex");
    const manifest: Record<string, unknown> = {
      packageFormat: "shipwithali-owner-export",
      schemaVersion: "1.7",
      exportId: id("217"),
      snapshot: { snapshotId: id("218"), capturedAt: "2026-10-25T12:00:00.000Z", consistency: "transactional" },
      createdAt: "2026-10-25T12:00:00.000Z",
      algorithm: "sha-256",
      digest: "0".repeat(64),
      requiredFeatures: ["asset-integrity-v1", "dependency-coverage-v1", "record-integrity-v1", "schema-integrity-v1", "snapshot-identity-v1"],
      includedScopes: ["moderation-history"],
      publicEventDataCoverage: { mode: "excluded" },
      dependencies: [{ sourceScope: "moderation-history", sourceId: feedbackId, targetScope: "portfolio-content", targetId: projectId, disposition: "omitted", reason: "scope-not-selected" }],
      exclusions: ["raw-public-event-data", "functional-visitor-identities", "measurement-visitor-identities", "sessions", "credentials", "lab-entries"],
      entries: [{
        path: "records/moderation-history.ndjson", scope: "moderation-history", mediaType: "application/x-ndjson",
        recordSchema: "urn:shipwithali:owner-export-schema:moderation-history:1.2", schemaPath: "schemas/moderation-history.schema.json",
        schemaVersion: "1.2", digest: recordDigest, recordCount: 1,
      }],
      schemas: [
        { kind: "manifest", path: "schemas/manifest.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:manifest:1.6", schemaVersion: "1.6", digest: createHash("sha256").update(manifestSchema).digest("hex") },
        { kind: "record", scope: "moderation-history", path: "schemas/moderation-history.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:moderation-history:1.2", schemaVersion: "1.2", digest: createHash("sha256").update(moderationSchema).digest("hex") },
      ],
      assets: [],
    };
    manifest["digest"] = createHash("sha256").update(canonicalJson(manifest, true)).digest("hex");
    const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
    const archive = createStoredOwnerExportZip([
      zipMember("manifest.json", manifestBytes),
      zipMember("schemas/manifest.schema.json", manifestSchema),
      zipMember("schemas/moderation-history.schema.json", moderationSchema),
      zipMember("records/moderation-history.ndjson", recordBytes),
    ]);

    const archiveBytes = await bytes(archive.content);
    expect(() => validateOwnerExportZip(archiveBytes)).toThrow("PACKAGE_RECORD_INVALID");
  });

  it("AC04 denies a ready private ZIP when the current retained Feedback no longer matches its snapshot", async () => {
    const now = "2026-10-25T12:00:00.000Z";
    const exportId = id("207");
    const portfolioId = id("208");
    const ownerId = id("209");
    const snapshot = moderationSnapshot(now, [{ feedbackId: id("210"), value: {
      feedbackId: id("210"), projectId, locale: "en", aggregateVersion: 2, state: "pending", textDisposition: "retained",
      authorName: "PRIVATE_NAME_SENTINEL", paragraph: "PRIVATE_TEXT_SENTINEL", submittedAt: now, decisionHistory: [],
    } }]);
    const record = {
      exportId, portfolioId, ownerId, includedScopes: ["moderation-history"], status: "ready", schemaVersion: "1.7",
      aggregateVersion: 3, requestedAt: now, completedAt: now, expiresAt: "2026-11-01T00:00:00.000Z",
      artifactId: id("211"), artifactSha256: createHash("sha256").update(new Uint8Array([1])).digest("hex"), artifactContentLength: 1, snapshot,
    };
    let objectReads = 0;
    const service = createOwnerExportService({
      operations: {} as never,
      exports: { async findOwnerExport() { return record as never; } } as never,
      clock: { now: () => now },
      ids: { generate: () => id("212") },
      objectRead: { async readOwnerExport() { objectReads += 1; return { ok: false, error: { kind: "temporarily_unavailable", code: "OWNER_EXPORT_ARTIFACT_UNAVAILABLE" } }; } },
      revalidateModerationForDownload: async () => false,
    });
    const result = await service.downloadOwnerExport({
      actor: { kind: "owner", ownerId: ownerId as never, sessionId: "phase8-owner-export-moderation" },
      portfolioId: portfolioId as never,
      exportId: exportId as never,
    });
    expect(result).toMatchObject({ ok: false, error: { kind: "conflict", code: "OWNER_EXPORT_DOWNLOAD_EXPIRED" } });
    expect(objectReads).toBe(0);
  });
});
