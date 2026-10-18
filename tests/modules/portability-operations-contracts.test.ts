import { describe, expect, it } from "vitest";
import { unsafeStableId } from "../../src/shared/domain/index.js";
import {
  isExportScope,
  MAX_OWNER_EXPORT_ARTIFACT_BYTES,
  MAX_EXPORT_SNAPSHOT_CURSOR_LENGTH,
  parseSnapshotPageLimit,
  parseSnapshotCursor,
  parseScopedWorkerPurpose,
  readOwnerExportSnapshot,
  validateOwnerExportObjectRead,
  validateOwnerExportSnapshotPage,
  type CompleteJobCommand,
  type ExportStatus,
  type OwnerExportSnapshotContext,
  type OwnerExportSnapshotPage,
  type OwnerExportSnapshotReaders,
  type ExportScope,
  type ScopedWorkerPurpose,
  type SnapshotPageLimit,
} from "../../src/modules/portability-operations/index.js";

const validScopes = [
  "portfolio-content",
  "taxonomy",
  "media-metadata",
  "cv-metadata",
  "moderation-history",
  "analytics-reports",
  "portfolio-configuration",
] satisfies readonly (typeof import("../../src/modules/portability-operations/index.js").OWNER_EXPORT_SCOPES[number])[];

const allStates = ["requested", "building", "ready", "failed", "expired"] satisfies readonly ExportStatus[];
const workerPurpose: ScopedWorkerPurpose = "operations.outbox-dispatch";
void validScopes;
void allStates;
void workerPurpose;

const portfolioId = unsafeStableId<"Portfolio">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ee1");
const ownerId = unsafeStableId<"Owner">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ee2");

function context(pageSize: SnapshotPageLimit): OwnerExportSnapshotContext<"taxonomy"> {
  return {
    actor: {
      kind: "system",
      jobId: unsafeStableId<"Job">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ee3"),
      purpose: workerPurpose,
    },
    ownerId,
    portfolioId,
    scope: "taxonomy",
    snapshotAt: "2026-10-18T00:00:00.000Z",
    pageSize,
  };
}

function page(recordCount: number): OwnerExportSnapshotPage<"taxonomy"> {
  return {
    descriptor: {
      path: "taxonomy/values.ndjson",
      scope: "taxonomy",
      mediaType: "application/x-ndjson",
      recordSchema: "urn:shipwithali:owner-export-schema:taxonomy:1.0",
      schemaPath: "schemas/taxonomy.schema.json",
      schemaVersion: "1.0",
      digest: "a".repeat(64),
      recordCount,
    },
    records: Array.from({ length: recordCount }, () => ({
      scope: "taxonomy" as const,
      value: {
        taxonomyId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ee4",
        aggregateVersion: 1,
        kind: "technology",
        values: [],
        renameHistory: [],
        assignments: [],
      },
    })),
  };
}

describe("Portability and Operations public contracts", () => {
  it("exposes only the seven declared export scopes", () => {
    for (const scope of validScopes) expect(isExportScope(scope)).toBe(true);
    expect(isExportScope("identity-access" )).toBe(false);
    expect(isExportScope("media" )).toBe(false);
  });

  it("bounds module snapshot page sizes", () => {
    expect(parseSnapshotPageLimit(1).ok).toBe(true);
    expect(parseSnapshotPageLimit(250).ok).toBe(true);
    expect(parseSnapshotPageLimit(0).ok).toBe(false);
    expect(parseSnapshotPageLimit(251).ok).toBe(false);
  });

  it("bounds opaque snapshot cursors", () => {
    expect(parseSnapshotCursor("opaque-cursor").ok).toBe(true);
    expect(parseSnapshotCursor("").ok).toBe(false);
    expect(parseSnapshotCursor("x".repeat(MAX_EXPORT_SNAPSHOT_CURSOR_LENGTH + 1)).ok).toBe(false);
    expect(parseSnapshotCursor("cursor\nprivate").ok).toBe(false);
  });

  it("requires a namespaced system purpose for worker execution", () => {
    expect(parseScopedWorkerPurpose("measurement.retention").ok).toBe(true);
    expect(parseScopedWorkerPurpose("feedback.retention").ok).toBe(true);
    expect(parseScopedWorkerPurpose("worker").ok).toBe(false);
    expect(parseScopedWorkerPurpose("operations.").ok).toBe(false);
  });

  it("accepts a correctly scoped page within the requested bound", () => {
    const limit = parseSnapshotPageLimit(2);
    expect(limit.ok).toBe(true);
    if (!limit.ok) return;
    expect(validateOwnerExportSnapshotPage(context(limit.value), page(2)).ok).toBe(true);
  });

  it("rejects oversized and wrong-scope module snapshots", () => {
    const limit = parseSnapshotPageLimit(1);
    expect(limit.ok).toBe(true);
    if (!limit.ok) return;
    const input = context(limit.value);
    expect(validateOwnerExportSnapshotPage(input, page(2)).ok).toBe(false);
    const wrongScope = {
      ...page(1),
      descriptor: { ...page(1).descriptor, scope: "media-metadata" },
    } as unknown as OwnerExportSnapshotPage<"taxonomy">;
    expect(validateOwnerExportSnapshotPage(input, wrongScope).ok).toBe(false);
    const unsafePath = {
      ...page(1),
      descriptor: { ...page(1).descriptor, path: "../private.ndjson" },
    } as OwnerExportSnapshotPage<"taxonomy">;
    expect(validateOwnerExportSnapshotPage(input, unsafePath).ok).toBe(false);
    const wrongMediaType = {
      ...page(1),
      descriptor: { ...page(1).descriptor, mediaType: "application/pdf" },
    } as unknown as OwnerExportSnapshotPage<"taxonomy">;
    expect(validateOwnerExportSnapshotPage(input, wrongMediaType).ok).toBe(false);
    const inconsistentCount = {
      ...page(1),
      descriptor: { ...page(1).descriptor, recordCount: 2 },
    };
    expect(validateOwnerExportSnapshotPage(input, inconsistentCount).ok).toBe(false);
  });

  it("rejects privacy-sensitive fields in analytics export snapshots", () => {
    const limit = parseSnapshotPageLimit(1);
    expect(limit.ok).toBe(true);
    if (!limit.ok) return;
    const analyticsContext = { ...context(limit.value), scope: "analytics-reports" as const };
    const goal = {
      goalId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ee5",
      aggregateVersion: 1,
      activeVersionId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ee6",
      versions: [{
        versionId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ee6",
        versionNumber: 1,
        definition: { name: "Conversion", steps: [{ action: "project-viewed" }] },
        createdAt: "2026-10-18T00:00:00.000Z",
      }],
      activationHistory: [],
    };
    const analyticsPage = {
      descriptor: {
        ...page(0).descriptor,
        path: "analytics/reports.json",
        scope: "analytics-reports" as const,
        mediaType: "application/json" as const,
        recordSchema: "urn:shipwithali:owner-export-schema:analytics-reports:1.0" as const,
        schemaPath: "schemas/analytics-reports.schema.json" as const,
        recordCount: 1,
      },
      records: [{ scope: "analytics-reports" as const, value: {
        goal: { ...goal, versions: [{ ...goal.versions[0], definition: { name: "Conversion", steps: [{ action: "project-viewed" }], visitor_email: "private@example.test" } }] },
        reports: [],
      } }],
    } as unknown as OwnerExportSnapshotPage<"analytics-reports">;
    expect(validateOwnerExportSnapshotPage(analyticsContext, analyticsPage).ok).toBe(false);
    const unsafeIdentifier = {
      ...analyticsPage,
      records: [{
        scope: "analytics-reports" as const,
        value: { goal: { ...goal, goalId: "visitor@example.test" }, reports: [] },
      }],
    } as unknown as OwnerExportSnapshotPage<"analytics-reports">;
    expect(validateOwnerExportSnapshotPage(analyticsContext, unsafeIdentifier).ok).toBe(false);
  });

  it("rejects an unrecognized scope before selecting a module reader", async () => {
    const limit = parseSnapshotPageLimit(1);
    expect(limit.ok).toBe(true);
    if (!limit.ok) return;
    const invalidContext = { ...context(limit.value), scope: "identity-access" as ExportScope };
    const noReaders = {} as OwnerExportSnapshotReaders;
    const result = await readOwnerExportSnapshot(noReaders, invalidContext);
    expect(result).toMatchObject({ ok: false, error: { code: "EXPORT_SCOPE_INVALID" } });
  });

  it("bounds object reads and requires a safe digest and async byte stream", () => {
    const content = (async function* () { yield new Uint8Array([1, 2, 3]); })();
    const base = { contentLength: 3, sha256: "b".repeat(64), content };
    expect(validateOwnerExportObjectRead(base).ok).toBe(true);
    expect(validateOwnerExportObjectRead({ ...base, contentLength: MAX_OWNER_EXPORT_ARTIFACT_BYTES + 1 }).ok).toBe(false);
    expect(validateOwnerExportObjectRead({ ...base, sha256: "private" }).ok).toBe(false);
  });

  it("does not permit lease completion with a job id and purpose alone", () => {
    const withoutLease = {
      actor: {
        kind: "system" as const,
        jobId: unsafeStableId<"Job">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ee3"),
        purpose: "operations.outbox-dispatch" as const,
      },
      completedAt: "2026-10-18T00:00:00.000Z",
    };
    // @ts-expect-error Completion must present the current fencing token.
    const invalidCommand: CompleteJobCommand = withoutLease;
    void invalidCommand;
  });
});
