import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "pg";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPostgresOwnerExportStore } from "../../src/modules/portability-operations/adapters/postgres-owner-export-store.js";
import { createOwnerExportAssemblyService } from "../../src/modules/portability-operations/application/owner-export-assembly.js";
import { buildConfigurationOwnerExportPackage, buildSelectedOwnerExportPackage, type OwnerExportAssemblySnapshot } from "../../src/modules/portability-operations/application/owner-export-package.js";
import { createOwnerExportService } from "../../src/modules/portability-operations/application/owner-export-service.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createPostgresContentAuthoringRepository } from "../../src/modules/content-publishing/adapters/postgres-authoring.js";
import { createPostgresContentTaxonomyAssignmentsPort } from "../../src/modules/content-publishing/adapters/postgres-taxonomy-assignments.js";
import { createPostgresContentTaxonomyExportAssignmentReader } from "../../src/modules/content-publishing/adapters/postgres-taxonomy-export-reader.js";
import { createContentAuthoringService } from "../../src/modules/content-publishing/application/authoring.js";
import { createPostgresProjectDiscoveryProjectionWriter } from "../../src/modules/taxonomy-discovery/adapters/postgres-project-discovery.js";
import { createPostgresTaxonomyOwnerRepository } from "../../src/modules/taxonomy-discovery/adapters/postgres-owner-taxonomies.js";
import { createTaxonomyOwnerService } from "../../src/modules/taxonomy-discovery/application/owner-taxonomies.js";
import { createTaxonomyOwnerExportSnapshotReader } from "../../src/modules/taxonomy-discovery/application/taxonomy-export.js";
import { createPublicDiscoveryService } from "../../src/modules/taxonomy-discovery/application/public-discovery.js";
import { createPostgresPublicDiscoveryReader } from "../../src/modules/taxonomy-discovery/adapters/postgres-public-discovery.js";
import { createPostgresOwnerMediaExportSnapshotReader } from "../../src/modules/media/adapters/postgres-owner-export-snapshot.js";
import { createPostgresOwnerCvExportSnapshotReader } from "../../src/modules/cv-portfolio/adapters/postgres-owner-export-snapshot.js";
import { createPostgresFeedbackOwnerExportSnapshotReader } from "../../src/modules/interaction-moderation/adapters/postgres-owner-export.js";
import { createPostgresOwnerAnalyticsExportSnapshotReader } from "../../src/modules/measurement/adapters/postgres-owner-analytics-export.js";
import { createOwnerExportSnapshotReader } from "../../src/runtime/adapters/owner-export-snapshot.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";
import { createSupabaseOwnerExportStorage } from "../../src/runtime/adapters/supabase-owner-export-storage.js";
import { createSupabaseMediaExportStorage } from "../../src/runtime/adapters/supabase-media-export-storage.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createStableId, ok, parseIdempotencyKey, type OwnerActor, type StableId } from "../../src/shared/domain/index.js";
import { cleanupOwnerExportReference, importOwnerExportReference, independentlyReadOwnerExportZip } from "../../scripts/owner-export/reference-importer.mjs";
import { validateOwnerExportZip } from "../../scripts/owner-export/validator.mjs";
import { capturedAt, expectedFacts, fixtureIds, mediaBytesByObjectId, scopeOrder, snapshotFor } from "./owner-export-reference-fixture.js";

const APPLICATION_URL = process.env["PHASE8_OWNER_EXPORT_APPLICATION_URL"];
const WORKER_URL = process.env["PHASE8_OWNER_EXPORT_WORKER_URL"];
const ADMIN_URL = process.env["PHASE8_OWNER_EXPORT_ADMIN_URL"];
const STORAGE_URL = process.env["PHASE8_OWNER_EXPORT_STORAGE_URL"];
const STORAGE_KEY = process.env["PHASE8_OWNER_EXPORT_STORAGE_KEY"];
const enabled = Boolean(APPLICATION_URL && WORKER_URL && ADMIN_URL && STORAGE_URL && STORAGE_KEY);

type QueryClient = { query(sql: string, parameters?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }> };
const metrics = { fullArchiveBytes: 0, partialArchiveBytes: 0, importedAssets: 0, importedAssetBytes: 0,
  importedRecords: 0, partialScenarioCount: 0, absentCvScenarioCount: 0, stagesMs: {} as Record<string, number>, cleanup: false,
  sourceBackedArchiveBytes: 0, sourceBackedSourceObjectReads: 0, sourceBackedRecords: 0, sourceBackedAssets: 0,
  sourceBackedAssetBytes: 0, sourceBackedPartialScenarioCount: 0, sourceBackedPartialArchiveBytes: 0,
  sourceBackedPartialSourceObjectReads: 0, sourceBackedEmptyContentCount: 0, sourceBackedEmptyCvCount: 0, sourceBackedCleanup: false,
  sourceBackedRichFacts: [] as string[],
  sourceBackedDiscoveryTieOrder: [] as string[], sourceBackedDraftPublicLocales: [] as string[],
  barrier: undefined as Record<string, string | number | boolean | null> | undefined, cleanupFailures: [] as string[] };
let admin: Client | undefined;
let application: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
let worker: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
let storage: ReturnType<typeof createSupabaseOwnerExportStorage> | undefined;
let ownerBucket = "";
let importBucket = "";
let candidateBucket = "";
let processedBucket = "";
let bucketOwned = false;
const namespaces = new Set<string>();
const namespaceOwners = new Map<string, string>();
const importedObjectPaths = new Set<string>();
const sourceObjectPaths = new Map<string, Set<string>>();
let sourceBackedFixture: {
  content: ReturnType<typeof createContentAuthoringService>;
  projectId: StableId<"Project">;
  contentIds: StableId<string>[];
  hiddenProjectId: StableId<"Project">;
  tiePublishedProjectId: StableId<"Project">;
  draftProjectId: StableId<"Project">;
  tiedFirstPublishedAt: string;
  archivedAchievementId: StableId<"Achievement">;
  projectVersion: number;
  contentDraftData: Readonly<Record<string, unknown>>;
  currentRevisionId: StableId<"Revision">;
  taxonomy: ReturnType<typeof createTaxonomyOwnerService>;
  taxonomyId: StableId<"Taxonomy">;
  taxonomyValueId: StableId<"TaxonomyValue">;
  taxonomyAssignedValueId: StableId<"TaxonomyValue">;
  taxonomyMergedValueId: StableId<"TaxonomyValue">;
  taxonomyRetiredValueId: StableId<"TaxonomyValue">;
  taxonomyVersion: number;
  media: Array<{ mediaId: StableId<"MediaAsset">; sourceObjectId: StableId<"MediaObject">; outputObjectId: StableId<"MediaObject">;
    uploadIntentId: StableId<"MediaUploadIntent">; inputBytes: Uint8Array; outputBytes: Uint8Array; inputDigest: string; outputDigest: string;
    inputType: "image/png" | "application/pdf"; outputType: "image/webp" | "application/pdf"; decisionId: StableId<"MediaDecision">; }>;
  currentCvId: StableId<"CvVersion">;
  currentCvNumber: number;
  previousCvId: StableId<"CvVersion">;
  rejectedMediaId: StableId<"MediaAsset">;
  goalId: StableId<"AnalyticsGoal">;
  previousGoalVersionId: StableId<"AnalyticsGoalVersion">;
  activeGoalVersionId: StableId<"AnalyticsGoalVersion">;
  feedbackId: StableId<"Feedback">;
  approvedFeedbackId: StableId<"Feedback">;
  rejectedFeedbackId: StableId<"Feedback">;
  suppressedFeedbackId: StableId<"Feedback">;
} | undefined;
const ownerExportArtifacts: Array<{ portfolioId: StableId<"Portfolio">; exportId: StableId<"OwnerExport">; artifactId: StableId<"OwnerExportArtifact"> }> = [];
const portfolios = [fixtureIds.portfolio];
const owners = [fixtureIds.owner];

function uuid(namespace: string) { return `ref_${namespace.replaceAll("-", "").slice(0, 16)}`; }
function authHeaders() {
  if (!STORAGE_KEY) throw new Error("PHASE8_OWNER_EXPORT_STORAGE_REQUIRED");
  return { apikey: STORAGE_KEY, authorization: `Bearer ${STORAGE_KEY}` };
}
function storageObjectUrl(bucket: string, path: string) {
  if (!STORAGE_URL) throw new Error("PHASE8_OWNER_EXPORT_STORAGE_REQUIRED");
  const encoded = [bucket, ...path.split("/")].map((part) => encodeURIComponent(part)).join("/");
  return new URL(`/storage/v1/object/${encoded}`, STORAGE_URL);
}
function storageDownloadUrl(bucket: string, path: string) {
  if (!STORAGE_URL) throw new Error("PHASE8_OWNER_EXPORT_STORAGE_REQUIRED");
  const encoded = [bucket, ...path.split("/")].map((part) => encodeURIComponent(part)).join("/");
  return new URL(`/storage/v1/object/authenticated/${encoded}`, STORAGE_URL);
}
async function createPrivateBucket(name: string) {
  const response = await fetch(new URL("/storage/v1/bucket", STORAGE_URL), {
    method: "POST", headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ name, public: false }),
  });
  if (!response.ok) throw new Error(`REFERENCE_IMPORT_BUCKET_CREATE_FAILED:${response.status}`);
  const check = await fetch(new URL(`/storage/v1/bucket/${encodeURIComponent(name)}`, STORAGE_URL), { headers: authHeaders() });
  if (!check.ok) throw new Error("REFERENCE_IMPORT_PRIVATE_BUCKET_READBACK_FAILED");
  const value = await check.json() as { public?: boolean };
  if (value.public !== false) throw new Error("REFERENCE_IMPORT_BUCKET_MUST_BE_PRIVATE");
}
async function removeBucket(name: string) {
  if (!name) return;
  const paths = name === importBucket ? importedObjectPaths : sourceObjectPaths.get(name) ?? new Set<string>();
  if (paths.size > 0) {
    const removed = await fetch(new URL(`/storage/v1/object/${encodeURIComponent(name)}`, STORAGE_URL), {
      method: "DELETE", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ prefixes: [...paths] }),
    });
    if (!removed.ok) throw new Error(`REFERENCE_IMPORT_OBJECT_CLEANUP_FAILED_${removed.status}`);
  }
  const response = await fetch(new URL(`/storage/v1/bucket/${encodeURIComponent(name)}`, STORAGE_URL), {
    method: "DELETE", headers: authHeaders(),
  });
  if (!response.ok && response.status !== 404) throw new Error(`REFERENCE_IMPORT_BUCKET_CLEANUP_FAILED_${response.status}`);
}
async function uploadSourceObject(bucket: string, path: string, bytes: Uint8Array, mediaType: string) {
  const response = await fetch(storageObjectUrl(bucket, path), {
    method: "POST", headers: { ...authHeaders(), "content-type": mediaType, "content-length": String(bytes.byteLength), "x-upsert": "false" },
    body: Buffer.from(bytes) as unknown as BodyInit,
  });
  if (!response.ok) throw new Error("REFERENCE_IMPORT_SOURCE_OBJECT_SEED_FAILED");
  const paths = sourceObjectPaths.get(bucket) ?? new Set<string>();
  paths.add(path);
  sourceObjectPaths.set(bucket, paths);
}
async function readAll(content: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of content) { chunks.push(chunk); length += chunk.byteLength; }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
function asStableId<T extends string>(value: string) { return value as StableId<T>; }

function freshIdempotencyKey(prefix: string) {
  const parsed = parseIdempotencyKey(`${prefix}-${randomUUID()}`);
  if (!parsed.ok) throw new Error("REFERENCE_IMPORT_IDEMPOTENCY_KEY_INVALID");
  return parsed.value;
}

async function seedAcceptedSourceMedia(input: {
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
  readonly kind: "image" | "document";
}) {
  const mediaId = createStableId("MediaAsset");
  const sourceObjectId = createStableId("MediaObject");
  const outputObjectId = createStableId("MediaObject");
  const uploadIntentId = createStableId("MediaUploadIntent");
  const attemptId = createStableId("MediaProcessingAttempt");
  const decisionId = createStableId("MediaDecision");
  const inputBytes = new TextEncoder().encode(`reference importer synthetic ${input.kind} source bytes`);
  const outputBytes = new TextEncoder().encode(`reference importer synthetic accepted ${input.kind} bytes`);
  const inputType = input.kind === "image" ? "image/png" as const : "application/pdf" as const;
  const outputType = input.kind === "image" ? "image/webp" as const : "application/pdf" as const;
  const inputDigest = createHash("sha256").update(inputBytes).digest("hex");
  const outputDigest = createHash("sha256").update(outputBytes).digest("hex");
  const decidedAt = new Date(Date.now() - 2_000).toISOString();
  await admin!.query(`insert into media.assets
      (media_id, portfolio_id, owner_id, kind, original_file_name, declared_media_type, declared_byte_length, declared_sha256)
    values ($1, $2, $3, $4, 'private-synthetic-source.bin', $5, $6, $7)`,
  [mediaId, input.portfolioId, input.ownerId, input.kind, inputType, inputBytes.byteLength, inputDigest]);
  await admin!.query(`insert into media.upload_intents
      (upload_intent_id, media_id, media_object_id, portfolio_id, owner_id, expires_at)
    values ($1, $2, $3, $4, $5, $6::timestamptz)`,
  [uploadIntentId, mediaId, sourceObjectId, input.portfolioId, input.ownerId, new Date(Date.now() + 86_400_000).toISOString()]);
  await admin!.query(`insert into media.processed_objects
      (object_id, portfolio_id, owner_id, media_id, source_object_id, sha256, byte_length, mime_type, object_version)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $6)`,
  [outputObjectId, input.portfolioId, input.ownerId, mediaId, sourceObjectId, outputDigest, outputBytes.byteLength, outputType]);
  await admin!.query(`insert into media.processing_attempts
      (attempt_id, portfolio_id, owner_id, media_id, input_object_id, input_sha256, detected_mime_type,
       detected_byte_length, result, output_object_id, output_sha256, scanner_version, processor_version,
       policy_version, finding_codes, started_at, finished_at)
    values ($1, $2, $3, $4, $5, $6, $7, $8, 'passed', $9, $10,
      'synthetic-scanner-v1', 'synthetic-processor-v1', 'synthetic-policy-v1', '[]'::jsonb, $11, $11)`,
  [attemptId, input.portfolioId, input.ownerId, mediaId, sourceObjectId, inputDigest, inputType, inputBytes.byteLength,
    outputObjectId, outputDigest, decidedAt]);
  await admin!.query(`insert into media.processing_states
      (media_id, portfolio_id, owner_id, aggregate_version, latest_attempt_id) values ($1, $2, $3, 3, $4)`,
  [mediaId, input.portfolioId, input.ownerId, attemptId]);
  const accessibility = input.kind === "image"
    ? { kind: "described-image", altText: "Synthetic source-backed image." }
    : { kind: "document", summary: "Synthetic source-backed PDF." };
  await admin!.query(`insert into media.decision_history
      (decision_id, portfolio_id, owner_id, media_id, aggregate_version, decision, processing_attempt_id,
       input_object_id, input_sha256, detected_mime_type, detected_byte_length, scanner_version,
       processor_version, processing_policy_version, sealed_outputs, accessibility, ownership_attested_by,
       ownership_attested_at, public_suitability_attested_by, public_suitability_attested_at, decided_by, decided_at)
    values ($1, $2, $3, $4, 3, 'accepted', $5, $6, $7, $8, $9, 'synthetic-scanner-v1',
       'synthetic-processor-v1', 'synthetic-policy-v1', $10::jsonb, $11::jsonb,
       $3, $12::timestamptz, $3, $12::timestamptz, $3, $12::timestamptz)`,
  [decisionId, input.portfolioId, input.ownerId, mediaId, attemptId, sourceObjectId, inputDigest, inputType, inputBytes.byteLength,
    JSON.stringify([{ objectId: outputObjectId, sha256: outputDigest, byteLength: outputBytes.byteLength,
      mimeType: outputType, objectVersion: outputDigest, variantName: input.kind === "image" ? "display" : "document" }]),
    JSON.stringify(accessibility), decidedAt]);
  const candidatePath = `candidate/${input.portfolioId}/${mediaId}/${uploadIntentId}/${sourceObjectId}`;
  const extension = outputType === "image/webp" ? "webp" : "pdf";
  const processedPath = `processed/${input.portfolioId}/${mediaId}/${outputObjectId}/${outputDigest}.${extension}`;
  await uploadSourceObject(candidateBucket, candidatePath, inputBytes, inputType);
  await uploadSourceObject(processedBucket, processedPath, outputBytes, outputType);
  return { mediaId, sourceObjectId, outputObjectId, uploadIntentId, inputBytes, outputBytes, inputDigest, outputDigest,
    inputType, outputType, decisionId };
}

const objectReader = {
  async readMediaExportObject(input: { objectId: string }) {
    const value = mediaBytesByObjectId().get(input.objectId);
    if (value === undefined) throw new Error("REFERENCE_IMPORT_SOURCE_OBJECT_MISSING");
    return { async *[Symbol.asyncIterator]() { yield value; } };
  },
};

async function exportSnapshot(scopes: readonly (typeof scopeOrder)[number][], snapshotId: string) {
  return snapshotFor(scopes, snapshotId);
}

async function packageFor(scopes: readonly (typeof scopeOrder)[number][], snapshotId = fixtureIds.snapshot) {
  const snapshot = await snapshotFor(scopes, snapshotId);
  const built = await buildSelectedOwnerExportPackage({ exportId: createStableId("OwnerExport"), portfolioId: asStableId<"Portfolio">(fixtureIds.portfolio), snapshot,
    objects: objectReader });
  return readAll(built.content);
}

function createTargetSink(bucket: string) {
  let transactionOpen = false;
  const written: Array<{ namespace: string; path: string; digest: string; byteLength: number }> = [];
  const database: QueryClient = {
    async query(sql: string, parameters?: readonly unknown[]) {
      if (sql === "begin") transactionOpen = true;
      if (sql === "commit" || sql === "rollback") transactionOpen = false;
      return admin!.query(sql, parameters ? [...parameters] : []);
    },
  };
  const sink = {
    async put(input: { namespace: string; path: string; sourcePath: string; bytes: Uint8Array; mediaType: string; digest: string; ownerToken: string }) {
      expect(transactionOpen).toBe(false);
      const activeTransactions = await admin!.query<{ count: number }>(`select count(*)::int as count from pg_stat_activity
        where datname=current_database() and state='idle in transaction' and pid <> pg_backend_pid()`);
      expect(Number(activeTransactions.rows[0]?.count ?? 0)).toBe(0);
      const path = `${input.namespace}/${input.path}`;
      const response = await fetch(storageObjectUrl(bucket, path), {
        method: "POST", headers: { ...authHeaders(), "content-type": input.mediaType, "content-length": String(input.bytes.byteLength), "x-upsert": "false",
          "x-metadata": Buffer.from(JSON.stringify({ referenceImportOwnerToken: input.ownerToken })).toString("base64") },
        body: Buffer.from(input.bytes) as unknown as BodyInit,
      });
      if (!response.ok) throw new Error(`REFERENCE_IMPORT_OBJECT_WRITE_FAILED:${response.status}`);
      written.push({ namespace: input.namespace, path: input.sourcePath, digest: input.digest, byteLength: input.bytes.byteLength });
      importedObjectPaths.add(path);
    },
    async removeObjects(namespace: string, paths: string[], ownerToken: string) {
      if (new Set(paths).size !== paths.length || paths.some((path) => !path.startsWith("imports/"))) {
        throw new Error("REFERENCE_IMPORT_OBJECT_CLEANUP_PATH_INVALID");
      }
      const owned: string[] = [];
      for (const path of paths) {
        const fullPath = `${namespace}/${path}`;
        const encoded = [bucket, ...fullPath.split("/")].map((part) => encodeURIComponent(part)).join("/");
        const info = await fetch(new URL(`/storage/v1/object/info/${encoded}`, STORAGE_URL), { headers: authHeaders() });
        if (info.status === 404) continue;
        if (!info.ok) throw new Error("REFERENCE_IMPORT_OBJECT_OWNERSHIP_READ_FAILED");
        const metadata = await info.json() as { metadata?: Record<string, unknown> };
        if (metadata.metadata?.["referenceImportOwnerToken"] !== ownerToken) {
          throw new Error("REFERENCE_IMPORT_OBJECT_OWNERSHIP_MISMATCH");
        }
        owned.push(fullPath);
      }
      if (owned.length === 0) return;
      const response = await fetch(new URL(`/storage/v1/object/${encodeURIComponent(bucket)}`, STORAGE_URL), {
        method: "DELETE", headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ prefixes: owned }),
      });
      if (!response.ok) throw new Error("REFERENCE_IMPORT_OBJECT_CLEANUP_FAILED");
    },
  };
  return { database, sink, written };
}

describe.runIf(enabled)("Issue #250 full and partial reference import against isolated PostgreSQL and private object storage", () => {
  beforeAll(async () => {
    if (!APPLICATION_URL || !WORKER_URL || !ADMIN_URL || !STORAGE_URL || !STORAGE_KEY) throw new Error("PHASE8_OWNER_EXPORT_REFERENCE_IMPORT_SERVICES_REQUIRED");
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    application = createPostgresRuntimeDatabase(APPLICATION_URL);
    worker = createPostgresRuntimeDatabase(WORKER_URL);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    ownerBucket = `owner-export-${suffix}`;
    importBucket = `owner-import-${suffix}`;
    candidateBucket = `media-candidate-${suffix}`;
    processedBucket = `media-processed-${suffix}`;
    await createPrivateBucket(ownerBucket);
    bucketOwned = true;
    await createPrivateBucket(importBucket);
    await createPrivateBucket(candidateBucket);
    await createPrivateBucket(processedBucket);
    storage = createSupabaseOwnerExportStorage({ storageUrl: STORAGE_URL, serviceRoleKey: STORAGE_KEY, bucket: ownerBucket });
    const settingsRepository = createPostgresPortfolioSettingsRepository();
    const provisioned = await application!.transactions.run((context) => settingsRepository.provisionSettings({
      portfolioId: asStableId<"Portfolio">(fixtureIds.portfolio), ownerId: asStableId<"Owner">(fixtureIds.owner),
    }, {
      portfolioId: asStableId<"Portfolio">(fixtureIds.portfolio), version: 1,
      profile: { displayName: "Reference import synthetic owner", headline: "Fixture", bio: "Synthetic test data only." },
      contactChannels: [{ channel: "email", label: "Fixture", destination: "mailto:synthetic@example.test", availableLocales: ["en", "ar"] }],
      globalCta: { label: "Synthetic contact", destination: "https://example.test/contact", unavailableFallback: "Synthetic fallback" },
    }, context));
    if (!provisioned.ok) throw new Error("REFERENCE_IMPORT_OWNER_SETTINGS_SEED_FAILED");
  });

  afterAll(async () => {
    let cleanupFailure = false;
    for (const namespace of namespaces) {
      try { await cleanupOwnerExportReference({ database: admin!, objectSink: createTargetSink(importBucket).sink,
        namespace, ownerToken: namespaceOwners.get(namespace) }); }
      catch { cleanupFailure = true; metrics.cleanupFailures.push("imported-schema-or-object-cleanup"); }
    }
    try {
      // Discover candidate rows left behind by any interrupted assembly. This
      // also makes cleanup reliable when an assertion fails before download.
      if (admin) {
        const candidates = await admin.query<{ export_id: string; portfolio_id: string; candidate_artifact_id: string }>(
          `select export_id, portfolio_id, candidate_artifact_id from portability.owner_exports
           where owner_id = any($1::uuid[]) and candidate_artifact_id is not null`, [owners]);
        for (const candidate of candidates.rows) {
          if (!ownerExportArtifacts.some((artifact) => artifact.exportId === candidate.export_id && artifact.artifactId === candidate.candidate_artifact_id)) {
            ownerExportArtifacts.push({ portfolioId: asStableId<"Portfolio">(candidate.portfolio_id),
              exportId: asStableId<"OwnerExport">(candidate.export_id), artifactId: asStableId<"OwnerExportArtifact">(candidate.candidate_artifact_id) });
          }
        }
      }
      for (const artifact of ownerExportArtifacts) {
        const deleted = await storage?.deleteOwnerExport(artifact);
        if (deleted === undefined || !deleted.ok) {
          const path = `${artifact.portfolioId}/${artifact.exportId}/${artifact.artifactId}.zip`;
          const fallback = await fetch(new URL(`/storage/v1/object/${encodeURIComponent(ownerBucket)}`, STORAGE_URL), {
            method: "DELETE", headers: { ...authHeaders(), "content-type": "application/json" }, body: JSON.stringify({ prefixes: [path] }),
          });
          if (!fallback.ok) {
            cleanupFailure = true;
            metrics.cleanupFailures.push(`owner-export-artifact-delete-${fallback.status}`);
          }
        }
      }
      if (admin) {
        const cleanDatabase = async (name: string, statement: string, parameters: readonly unknown[] = []) => {
          try { await admin!.query(statement, [...parameters]); }
          catch (error) {
            cleanupFailure = true;
            const sqlState = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^[0-9A-Z]{5}$/u.test(error.code)
              ? `-${error.code}` : "";
            metrics.cleanupFailures.push(`${name}${sqlState}`);
          }
        };
        await cleanDatabase("export-outbox-cleanup", `delete from operations.outbox_events
          where event_type='portability.export_produced.v1' and aggregate_id in
            (select export_id from portability.owner_exports where owner_id = any($1::uuid[]))`, [owners]);
        await cleanDatabase("assembly-job-cleanup", `delete from operations.jobs
          where job_type='portability.owner-export-assembly.v1' and payload->>'ownerId'=any($1::text[])`, [owners]);
        await cleanDatabase("owner-export-row-cleanup", "delete from portability.owner_exports where owner_id = any($1::uuid[])", [owners]);
        await cleanDatabase("request-idempotency-cleanup", "delete from operations.idempotency_records where operation_scope=$1",
          [`portability.owner-export-request:${fixtureIds.portfolio}`]);
        const sourceCleanup = async () => {
          await admin!.query("begin");
          try {
            await admin!.query("set local session_replication_role=replica");
            await admin!.query("delete from interaction.moderation_decisions where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from interaction.feedback where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from measurement.analytics_goal_activation_history where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from measurement.analytics_goal_versions where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from measurement.analytics_goals where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from measurement.daily_aggregates where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from measurement.daily_aggregate_checkpoints where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from cv_portfolio.activation_history where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from cv_portfolio.acceptance_history where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from cv_portfolio.versions where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from cv_portfolio.portfolios where portfolio_id=$1", [fixtureIds.portfolio]);
            for (const table of ["content.public_project_locales", "content.public_testimonial_locales", "content.public_achievement_locales",
              "taxonomy.project_discovery_taxonomy_values", "taxonomy.project_discovery_locales", "content.public_route_history",
              "content.public_route_reservations", "content.publication_history", "content.testimonial_publication_history",
              "content.language_publications", "content.testimonial_language_publications", "content.revision_reviews",
              "content.lifecycle_history", "content.project_status_history", "content.project_status_value_history",
              "content.project_relationship_history", "content.project_relationship_views", "content.project_relationships",
              "content.project_taxonomy_assignment_history", "content.project_taxonomy_assignments", "content.revisions",
              "content.public_routes", "content.items", "content.project_status_values"] as const) {
              await admin!.query(`delete from ${table} where portfolio_id=$1`, [fixtureIds.portfolio]);
            }
            await admin!.query("delete from taxonomy.value_history where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from taxonomy.taxonomy_values where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from taxonomy.roots where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from media.decision_history where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from media.rejection_history where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from media.processing_states where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from media.processing_attempts where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from media.processed_objects where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from media.upload_intents where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from media.assets where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("delete from portfolio_config.contact_channels where portfolio_id=$1", [fixtureIds.portfolio]);
            await admin!.query("commit");
          } catch (error) { await admin!.query("rollback"); throw error; }
        };
        try { await sourceCleanup(); } catch {
          cleanupFailure = true;
          metrics.cleanupFailures.push("source-backed-fixture-cleanup");
        }
        await cleanDatabase("provisioned-taxonomy-root-cleanup", "delete from taxonomy.roots where portfolio_id = any($1::uuid[])", [portfolios]);
        await cleanDatabase("settings-cleanup", "delete from portfolio_config.settings where owner_id = any($1::uuid[])", [owners]);
      }
    } catch { cleanupFailure = true; metrics.cleanupFailures.push("export-artifact-discovery-or-delete"); }
    try { await removeBucket(importBucket); } catch (error) {
      cleanupFailure = true;
      const status = error instanceof Error ? error.message.match(/_(\d{3})$/u)?.[1] : undefined;
      metrics.cleanupFailures.push(`private-import-bucket-delete${status ? `-${status}` : ""}`);
    }
    try { await removeBucket(candidateBucket); } catch (error) {
      cleanupFailure = true;
      metrics.cleanupFailures.push("private-candidate-bucket-delete");
    }
    try { await removeBucket(processedBucket); } catch (error) {
      cleanupFailure = true;
      metrics.cleanupFailures.push("private-processed-bucket-delete");
    }
    try { await removeBucket(ownerBucket); } catch (error) {
      cleanupFailure = true;
      const status = error instanceof Error ? error.message.match(/_(\d{3})$/u)?.[1] : undefined;
      metrics.cleanupFailures.push(`private-export-bucket-delete${status ? `-${status}` : ""}`);
    }
    await application?.resource.close();
    await worker?.resource.close();
    await admin?.end();
    metrics.cleanup = !cleanupFailure;
    mkdirSync("artifacts", { recursive: true });
    writeFileSync("artifacts/phase8-owner-export-reference-import-250-run.json", `${JSON.stringify({
      ticket: 250,
      fixture: { sourcePath: "owner request -> composite capture -> source private Storage -> assembly and eligibility -> download -> independent parser and reference model",
        contentRecords: sourceBackedFixture?.contentIds.length ?? 0, taxonomyRoots: 1, mediaRecords: (sourceBackedFixture?.media.length ?? 0) + 1,
        cvAggregateRecords: 1, cvVersions: 2, moderationRecords: 4, analyticsGoals: 1, analyticsGoalVersions: 2,
        configurationAggregates: 1, mediaAssetObjects: metrics.sourceBackedAssets, rawVisitorRecords: 0,
        supplementalSyntheticFixtureIsModelOnly: true },
      expectedFacts: { includedScopes: [...scopeOrder], stableIdentityAssertions: metrics.sourceBackedRecords,
        activationHistoryEntries: 2, bilingualPublicationPointers: 2, feedbackHistoryRecords: 4,
        relationship: { sourceProjectId: sourceBackedFixture?.projectId ?? null, relatedHiddenProjectId: sourceBackedFixture?.hiddenProjectId ?? null,
          historyAndReferenceProjectionAsserted: metrics.sourceBackedRichFacts.some((fact) => fact.includes("relationship edge")) },
        draftPrivacy: { contentId: sourceBackedFixture?.draftProjectId ?? null, publicLocales: metrics.sourceBackedDraftPublicLocales,
          excludedFromSourceDiscovery: true, excludedFromImportedDiscovery: true },
        discoveryTie: { firstPublishedAt: sourceBackedFixture?.tiedFirstPublishedAt ?? null,
          expectedAndObservedContentIds: metrics.sourceBackedDiscoveryTieOrder },
        assetCount: metrics.importedAssets, assetBytes: metrics.importedAssetBytes },
      metrics, cleanup: metrics.cleanup,
    }, null, 2)}\n`);
    if (cleanupFailure) throw new Error("REFERENCE_IMPORT_FIXTURE_CLEANUP_FAILED");
  });

  async function seedSourceBackedFixture() {
    if (sourceBackedFixture !== undefined) return sourceBackedFixture;
    const portfolioId = asStableId<"Portfolio">(fixtureIds.portfolio);
    const ownerId = asStableId<"Owner">(fixtureIds.owner);
    const scope = { portfolioId, ownerId };
    const actor: OwnerActor = { kind: "owner", ownerId, sessionId: "reference-import-source-fixture" };
    const operations = createPostgresOperationsPersistence(application!.database);
    const contentRepository = createPostgresContentAuthoringRepository();
    const discovery = createPostgresProjectDiscoveryProjectionWriter();
    const contentClockAt = "2026-10-26T10:00:00.000Z";
    const content = createContentAuthoringService({ repository: contentRepository, operations, scope,
      discoveryProjection: discovery, taxonomyAssignments: discovery, clock: { now: () => contentClockAt } });
    const artifactId = createStableId("SupportingArtifact");
    const claimId = createStableId("EvidenceClaim");
    const payload = {
      contentType: "project" as const, locale: "en" as const, title: "Source-backed synthetic project",
      summary: "A project seeded through the Content application boundary.", body: "Synthetic public body.", candidateSlug: "source-backed-project",
      caseStudy: { problem: "Synthetic problem.", ownerRole: "Owner", contributions: ["Built a fixture."], outcomes: ["Captured source facts."], lessons: "Keep history." },
      evidence: { claims: [{ claimId, text: "Synthetic evidence claim.", artifactIds: [artifactId] }],
        artifacts: [{ id: artifactId, title: "Synthetic evidence", destinationUrl: "https://example.test/source-evidence" }] },
      externalLinks: [],
    };
    const created = await content.createContent({ actor, idempotencyKey: freshIdempotencyKey("reference-source-project-create"),
      correlationId: `reference-source-project-create-${randomUUID()}`, payload });
    if (!created.ok) throw new Error("REFERENCE_IMPORT_SOURCE_CONTENT_CREATE_FAILED");
    const firstReviewPreview = await content.previewRevision({ actor, contentId: created.value.contentId, revisionId: created.value.revisionId });
    if (!firstReviewPreview.ok) throw new Error("REFERENCE_IMPORT_SOURCE_CONTENT_PREVIEW_FAILED");
    const firstReview = await content.reviewRevision({ actor, contentId: created.value.contentId, revisionId: created.value.revisionId,
      expectedVersion: created.value.aggregateVersion, idempotencyKey: freshIdempotencyKey("reference-source-project-review"),
      correlationId: `reference-source-project-review-${randomUUID()}`, locale: "en", snapshotHash: firstReviewPreview.value.snapshotHash,
      evidenceVersion: firstReviewPreview.value.evidenceVersion, decision: "accepted", findings: [] });
    if (!firstReview.ok) throw new Error("REFERENCE_IMPORT_SOURCE_CONTENT_REVIEW_FAILED");
    const published = await content.publishLanguageVersion({ actor, contentId: created.value.contentId, revisionId: created.value.revisionId,
      expectedVersion: firstReview.value.aggregateVersion, idempotencyKey: freshIdempotencyKey("reference-source-project-publish"),
      correlationId: `reference-source-project-publish-${randomUUID()}`, locale: "en" });
    if (!published.ok) throw new Error(`REFERENCE_IMPORT_SOURCE_CONTENT_PUBLISH_FAILED_${published.error.code}`);
    let projectVersion = published.value.aggregateVersion;

    const arabicRevision = await content.saveRevision({ actor, contentId: created.value.contentId, expectedVersion: projectVersion,
      idempotencyKey: freshIdempotencyKey("reference-source-project-arabic-save"),
      correlationId: `reference-source-project-arabic-save-${randomUUID()}`, locale: "ar", title: "مشروع مصدر متعدد اللغات",
      summary: "ملخص عربي للمشروع.", body: "هذا محتوى عربي محفوظ من خلال واجهة Content.",
      draftData: { contentType: "project", caseStudy: payload.caseStudy, evidence: payload.evidence,
        externalLinks: [{ id: createStableId("ExternalLink"), label: "عرض تجريبي", destination: "https://example.test/ar", isAvailableInArabic: true }] } });
    if (!arabicRevision.ok) throw new Error("REFERENCE_IMPORT_SOURCE_ARABIC_REVISION_SAVE_FAILED");
    const arabicPreview = await content.previewRevision({ actor, contentId: created.value.contentId, revisionId: arabicRevision.value.revisionId });
    if (!arabicPreview.ok) throw new Error("REFERENCE_IMPORT_SOURCE_ARABIC_REVISION_PREVIEW_FAILED");
    const arabicReview = await content.reviewRevision({ actor, contentId: created.value.contentId, revisionId: arabicRevision.value.revisionId,
      expectedVersion: arabicRevision.value.aggregateVersion, idempotencyKey: freshIdempotencyKey("reference-source-project-arabic-review"),
      correlationId: `reference-source-project-arabic-review-${randomUUID()}`, locale: "ar", snapshotHash: arabicPreview.value.snapshotHash,
      evidenceVersion: arabicPreview.value.evidenceVersion, decision: "accepted", findings: [] });
    if (!arabicReview.ok) throw new Error("REFERENCE_IMPORT_SOURCE_ARABIC_REVISION_REVIEW_FAILED");
    const arabicPublished = await content.publishLanguageVersion({ actor, contentId: created.value.contentId, revisionId: arabicRevision.value.revisionId,
      expectedVersion: arabicReview.value.aggregateVersion, idempotencyKey: freshIdempotencyKey("reference-source-project-arabic-publish"),
      correlationId: `reference-source-project-arabic-publish-${randomUUID()}`, locale: "ar" });
    if (!arabicPublished.ok) throw new Error("REFERENCE_IMPORT_SOURCE_ARABIC_PUBLICATION_FAILED");
    projectVersion = arabicPublished.value.aggregateVersion;
    for (const [index, newSlug] of ["source-backed-project-v2", "source-backed-project-current"].entries()) {
      const route = await content.changePublicSlug({ actor, projectId: created.value.contentId as StableId<"Project">,
        expectedVersion: projectVersion, newSlug, idempotencyKey: freshIdempotencyKey(`reference-source-project-route-${index}`),
        correlationId: `reference-source-project-route-${index}-${randomUUID()}` });
      if (!route.ok) throw new Error("REFERENCE_IMPORT_SOURCE_ROUTE_HISTORY_FAILED");
      projectVersion = route.value.aggregateVersion;
    }
    const status = await content.createProjectStatusValue({ actor, label: "Shipped",
      idempotencyKey: freshIdempotencyKey("reference-source-status-create"), correlationId: `reference-source-status-create-${randomUUID()}` });
    if (!status.ok) throw new Error("REFERENCE_IMPORT_SOURCE_STATUS_CREATE_FAILED");
    const changedStatus = await content.changeProjectStatus({ actor, projectId: created.value.contentId as StableId<"Project">,
      statusValueId: status.value.valueId, expectedVersion: projectVersion,
      idempotencyKey: freshIdempotencyKey("reference-source-status-assign"), correlationId: `reference-source-status-assign-${randomUUID()}` });
    if (!changedStatus.ok) throw new Error("REFERENCE_IMPORT_SOURCE_STATUS_ASSIGN_FAILED");
    projectVersion = changedStatus.value.aggregateVersion;
    const featured = await content.setProjectFeatured({ actor, projectId: created.value.contentId as StableId<"Project">, featured: true,
      expectedVersion: projectVersion, idempotencyKey: freshIdempotencyKey("reference-source-featured"),
      correlationId: `reference-source-featured-${randomUUID()}` });
    if (!featured.ok) throw new Error("REFERENCE_IMPORT_SOURCE_FEATURED_FAILED");
    projectVersion = featured.value.aggregateVersion;

    const tiedArtifactId = createStableId("SupportingArtifact");
    const tiedClaimId = createStableId("EvidenceClaim");
    const tiedPayload = { ...payload, title: "Equal-time source project", summary: "A second published project for discovery ordering.",
      body: "Its first publication time is tied to the first source project.", candidateSlug: "source-backed-equal-time-project",
      evidence: { claims: [{ claimId: tiedClaimId, text: "A deterministic discovery fixture.", artifactIds: [tiedArtifactId] }],
        artifacts: [{ id: tiedArtifactId, title: "Equal-time evidence", destinationUrl: "https://example.test/equal-time" }] } };
    const tiedProject = await content.createContent({ actor, idempotencyKey: freshIdempotencyKey("reference-source-tied-project-create"),
      correlationId: `reference-source-tied-project-create-${randomUUID()}`, payload: tiedPayload });
    if (!tiedProject.ok) throw new Error("REFERENCE_IMPORT_SOURCE_TIED_PROJECT_CREATE_FAILED");
    const tiedPreview = await content.previewRevision({ actor, contentId: tiedProject.value.contentId, revisionId: tiedProject.value.revisionId });
    if (!tiedPreview.ok) throw new Error("REFERENCE_IMPORT_SOURCE_TIED_PROJECT_PREVIEW_FAILED");
    const tiedReview = await content.reviewRevision({ actor, contentId: tiedProject.value.contentId, revisionId: tiedProject.value.revisionId,
      expectedVersion: tiedProject.value.aggregateVersion, idempotencyKey: freshIdempotencyKey("reference-source-tied-project-review"),
      correlationId: `reference-source-tied-project-review-${randomUUID()}`, locale: "en", snapshotHash: tiedPreview.value.snapshotHash,
      evidenceVersion: tiedPreview.value.evidenceVersion, decision: "accepted", findings: [] });
    if (!tiedReview.ok) throw new Error("REFERENCE_IMPORT_SOURCE_TIED_PROJECT_REVIEW_FAILED");
    const tiedPublished = await content.publishLanguageVersion({ actor, contentId: tiedProject.value.contentId, revisionId: tiedProject.value.revisionId,
      expectedVersion: tiedReview.value.aggregateVersion, idempotencyKey: freshIdempotencyKey("reference-source-tied-project-publish"),
      correlationId: `reference-source-tied-project-publish-${randomUUID()}`, locale: "en" });
    if (!tiedPublished.ok) throw new Error("REFERENCE_IMPORT_SOURCE_TIED_PROJECT_PUBLISH_FAILED");

    const draftArtifactId = createStableId("SupportingArtifact");
    const draftClaimId = createStableId("EvidenceClaim");
    const draft = await content.createContent({ actor, idempotencyKey: freshIdempotencyKey("reference-source-draft-create"),
      correlationId: `reference-source-draft-create-${randomUUID()}`, payload: { ...payload, title: "Private source draft",
        summary: "A draft that must never enter public discovery.", body: "The source-backed Draft stays private.", candidateSlug: "source-private-draft",
        evidence: { claims: [{ claimId: draftClaimId, text: "Private draft evidence.", artifactIds: [draftArtifactId] }],
          artifacts: [{ id: draftArtifactId, title: "Private draft evidence", destinationUrl: "https://example.test/private-draft" }] } } });
    if (!draft.ok) throw new Error("REFERENCE_IMPORT_SOURCE_DRAFT_CREATE_FAILED");

    const hiddenArtifact = createStableId("SupportingArtifact");
    const hidden = await content.createContent({ actor, idempotencyKey: freshIdempotencyKey("reference-source-hidden-create"),
      correlationId: `reference-source-hidden-create-${randomUUID()}`, payload: { ...payload, title: "Hidden source project",
        summary: "A source-backed hidden project.", body: "The project was published then hidden through Content.", candidateSlug: "source-hidden-project",
        evidence: { claims: [{ claimId: createStableId("EvidenceClaim"), text: "Retained hidden evidence.", artifactIds: [hiddenArtifact] }],
          artifacts: [{ id: hiddenArtifact, title: "Hidden project evidence", destinationUrl: "https://example.test/hidden" }] } } });
    if (!hidden.ok) throw new Error("REFERENCE_IMPORT_SOURCE_HIDDEN_CREATE_FAILED");
    const hiddenPreview = await content.previewRevision({ actor, contentId: hidden.value.contentId, revisionId: hidden.value.revisionId });
    if (!hiddenPreview.ok) throw new Error("REFERENCE_IMPORT_SOURCE_HIDDEN_PREVIEW_FAILED");
    const hiddenReview = await content.reviewRevision({ actor, contentId: hidden.value.contentId, revisionId: hidden.value.revisionId,
      expectedVersion: hidden.value.aggregateVersion, idempotencyKey: freshIdempotencyKey("reference-source-hidden-review"),
      correlationId: `reference-source-hidden-review-${randomUUID()}`, locale: "en", snapshotHash: hiddenPreview.value.snapshotHash,
      evidenceVersion: hiddenPreview.value.evidenceVersion, decision: "accepted", findings: [] });
    if (!hiddenReview.ok) throw new Error("REFERENCE_IMPORT_SOURCE_HIDDEN_REVIEW_FAILED");
    const hiddenPublished = await content.publishLanguageVersion({ actor, contentId: hidden.value.contentId, revisionId: hidden.value.revisionId,
      expectedVersion: hiddenReview.value.aggregateVersion, idempotencyKey: freshIdempotencyKey("reference-source-hidden-publish"),
      correlationId: `reference-source-hidden-publish-${randomUUID()}`, locale: "en" });
    if (!hiddenPublished.ok) throw new Error("REFERENCE_IMPORT_SOURCE_HIDDEN_PUBLISH_FAILED");
    const hiddenTransition = await content.hideContent({ actor, contentId: hidden.value.contentId,
      expectedVersion: hiddenPublished.value.aggregateVersion, idempotencyKey: freshIdempotencyKey("reference-source-hidden-transition"),
      correlationId: `reference-source-hidden-transition-${randomUUID()}`, reason: "Synthetic source fixture hidden lifecycle." });
    if (!hiddenTransition.ok) throw new Error("REFERENCE_IMPORT_SOURCE_HIDDEN_TRANSITION_FAILED");

    const achievement = await content.createContent({ actor, idempotencyKey: freshIdempotencyKey("reference-source-achievement-create"),
      correlationId: `reference-source-achievement-create-${randomUUID()}`, payload: { contentType: "achievement", locale: "en",
        title: "Archived source milestone", summary: "A retained milestone.", body: "Published before archival.", achievedOn: "2026-10-20" } });
    if (!achievement.ok) throw new Error("REFERENCE_IMPORT_SOURCE_ACHIEVEMENT_CREATE_FAILED");
    const achievementPreview = await content.previewRevision({ actor, contentId: achievement.value.contentId, revisionId: achievement.value.revisionId });
    if (!achievementPreview.ok) throw new Error("REFERENCE_IMPORT_SOURCE_ACHIEVEMENT_PREVIEW_FAILED");
    const achievementReview = await content.reviewRevision({ actor, contentId: achievement.value.contentId, revisionId: achievement.value.revisionId,
      expectedVersion: achievement.value.aggregateVersion, idempotencyKey: freshIdempotencyKey("reference-source-achievement-review"),
      correlationId: `reference-source-achievement-review-${randomUUID()}`, locale: "en", snapshotHash: achievementPreview.value.snapshotHash,
      evidenceVersion: achievementPreview.value.evidenceVersion, decision: "accepted", findings: ["Synthetic retained audit detail."] });
    if (!achievementReview.ok) throw new Error("REFERENCE_IMPORT_SOURCE_ACHIEVEMENT_REVIEW_FAILED");
    const achievementPublished = await content.publishLanguageVersion({ actor, contentId: achievement.value.contentId,
      revisionId: achievement.value.revisionId, expectedVersion: achievementReview.value.aggregateVersion,
      idempotencyKey: freshIdempotencyKey("reference-source-achievement-publish"),
      correlationId: `reference-source-achievement-publish-${randomUUID()}`, locale: "en" });
    if (!achievementPublished.ok) throw new Error("REFERENCE_IMPORT_SOURCE_ACHIEVEMENT_PUBLISH_FAILED");
    const archived = await content.archiveContent({ actor, contentId: achievement.value.contentId,
      expectedVersion: achievementPublished.value.aggregateVersion, idempotencyKey: freshIdempotencyKey("reference-source-achievement-archive"),
      correlationId: `reference-source-achievement-archive-${randomUUID()}` });
    if (!archived.ok) throw new Error("REFERENCE_IMPORT_SOURCE_ACHIEVEMENT_ARCHIVE_FAILED");

    const tiedContentIds = [created.value.contentId, tiedProject.value.contentId];
    // Publication runs through Content with the fixed clock above. Align the
    // persisted DB timestamp in this disposable fixture because firstPublishedAt
    // is sourced from PostgreSQL transaction time, not the application clock.
    await admin!.query("begin");
    try {
      const roots = await admin!.query<{ first_published_at: Date | string }>(`update content.items set first_published_at=$2::timestamptz
        where portfolio_id=$1 and content_id=any($3::uuid[]) returning first_published_at`, [portfolioId, contentClockAt, tiedContentIds]);
      const routes = await admin!.query<{ first_published_at: Date | string }>(`update content.public_routes set first_published_at=$2::timestamptz
        where portfolio_id=$1 and content_id=any($3::uuid[]) returning first_published_at`, [portfolioId, contentClockAt, tiedContentIds]);
      const discoveryRows = await admin!.query<{ first_published_at: Date | string }>(`update taxonomy.project_discovery_locales set first_published_at=$2::timestamptz
        where portfolio_id=$1 and content_id=any($3::uuid[]) returning first_published_at`, [portfolioId, contentClockAt, tiedContentIds]);
      if (roots.rows.length !== 2 || routes.rows.length !== 2 || discoveryRows.rows.length !== 3 ||
          [...roots.rows, ...routes.rows, ...discoveryRows.rows].some((row) =>
            (row.first_published_at instanceof Date ? row.first_published_at.toISOString() : new Date(row.first_published_at).toISOString()) !== contentClockAt)) {
        throw new Error("REFERENCE_IMPORT_SOURCE_DISCOVERY_TIE_FIXTURE_INVALID");
      }
      await admin!.query("commit");
    } catch (error) { await admin!.query("rollback"); throw error; }

    const taxonomyId = asStableId<"Taxonomy">("01890f3e-7b2f-7cc0-98cf-5a2890378ef8");
    const taxonomyRepository = createPostgresTaxonomyOwnerRepository();
    const taxonomy = createTaxonomyOwnerService({ repository: taxonomyRepository, operations, scope,
      contentAssignments: createPostgresContentTaxonomyAssignmentsPort({ scope, discovery }), ids: createSystemIdGenerator() });
    const taxonomyRoot = await taxonomy.getOwnerTaxonomy({ actor, taxonomyId });
    if (!taxonomyRoot.ok) throw new Error("REFERENCE_IMPORT_SOURCE_TAXONOMY_ROOT_FAILED");
    const taxonomyValue = await taxonomy.createOwnerTaxonomyValue({ actor, idempotencyKey: freshIdempotencyKey("reference-source-taxonomy-value"),
      taxonomyId, expectedVersion: taxonomyRoot.value.aggregateVersion, name: "Source-backed services" });
    if (!taxonomyValue.ok) throw new Error("REFERENCE_IMPORT_SOURCE_TAXONOMY_VALUE_FAILED");
    const valueRead = await taxonomy.getOwnerTaxonomy({ actor, taxonomyId });
    if (!valueRead.ok) throw new Error("REFERENCE_IMPORT_SOURCE_TAXONOMY_READ_FAILED");
    const taxonomyAssignedValueId = valueRead.value.values.find((value) => value.name === "Source-backed services")?.valueId;
    if (taxonomyAssignedValueId === undefined) throw new Error("REFERENCE_IMPORT_SOURCE_TAXONOMY_VALUE_MISSING");
    const targetCreated = await taxonomy.createOwnerTaxonomyValue({ actor, idempotencyKey: freshIdempotencyKey("reference-source-taxonomy-target"),
      taxonomyId, expectedVersion: valueRead.value.aggregateVersion, name: "Services" });
    if (!targetCreated.ok) throw new Error("REFERENCE_IMPORT_SOURCE_TAXONOMY_TARGET_CREATE_FAILED");
    const retiredCreated = await taxonomy.createOwnerTaxonomyValue({ actor, idempotencyKey: freshIdempotencyKey("reference-source-taxonomy-retired"),
      taxonomyId, expectedVersion: targetCreated.value.aggregateVersion, name: "Legacy service" });
    if (!retiredCreated.ok) throw new Error("REFERENCE_IMPORT_SOURCE_TAXONOMY_RETIRED_CREATE_FAILED");
    const createdTaxonomyValues = await taxonomy.getOwnerTaxonomy({ actor, taxonomyId });
    if (!createdTaxonomyValues.ok) throw new Error("REFERENCE_IMPORT_SOURCE_TAXONOMY_VALUES_READ_FAILED");
    const taxonomyValueId = createdTaxonomyValues.value.values.find((value) => value.name === "Services")?.valueId;
    const taxonomyRetiredValueId = createdTaxonomyValues.value.values.find((value) => value.name === "Legacy service")?.valueId;
    if (taxonomyValueId === undefined || taxonomyRetiredValueId === undefined) throw new Error("REFERENCE_IMPORT_SOURCE_TAXONOMY_EVOLUTION_IDS_MISSING");

    const assigned = await content.assignProjectTaxonomyValue({ actor, projectId: created.value.contentId as StableId<"Project">, valueId: taxonomyAssignedValueId,
      expectedVersion: projectVersion, idempotencyKey: freshIdempotencyKey("reference-source-taxonomy-assign"),
      correlationId: `reference-source-taxonomy-assign-${randomUUID()}` });
    if (!assigned.ok) throw new Error("REFERENCE_IMPORT_SOURCE_TAXONOMY_ASSIGN_FAILED");
    projectVersion = assigned.value.aggregateVersion;

    const renamedValue = await taxonomy.renameOwnerTaxonomyValue({ actor, idempotencyKey: freshIdempotencyKey("reference-source-taxonomy-rename"),
      expectedVersion: retiredCreated.value.aggregateVersion, valueId: taxonomyAssignedValueId, name: "Service Layer" });
    if (!renamedValue.ok) throw new Error("REFERENCE_IMPORT_SOURCE_TAXONOMY_RENAME_FAILED");
    const retiredValue = await taxonomy.retireOwnerTaxonomyValue({ actor, idempotencyKey: freshIdempotencyKey("reference-source-taxonomy-retire"),
      expectedVersion: renamedValue.value.aggregateVersion, valueId: taxonomyRetiredValueId });
    if (!retiredValue.ok) throw new Error("REFERENCE_IMPORT_SOURCE_TAXONOMY_RETIRE_FAILED");
    const mergedValue = await taxonomy.mergeOwnerTaxonomyValue({ actor, idempotencyKey: freshIdempotencyKey("reference-source-taxonomy-merge"),
      expectedVersion: retiredValue.value.aggregateVersion, sourceValueId: taxonomyAssignedValueId, targetValueId: taxonomyValueId });
    if (!mergedValue.ok) throw new Error("REFERENCE_IMPORT_SOURCE_TAXONOMY_MERGE_FAILED");
    const mergedTaxonomy = await taxonomy.getOwnerTaxonomy({ actor, taxonomyId });
    if (!mergedTaxonomy.ok) throw new Error("REFERENCE_IMPORT_SOURCE_TAXONOMY_MERGED_READ_FAILED");
    // Merging an assigned value rewrites the owning Content assignment and
    // advances that project aggregate. Refresh through Content before issuing
    // the next version-guarded project command.
    const refreshedProject = await content.getOwnerContentAggregate({ actor, contentId: created.value.contentId });
    if (!refreshedProject.ok) throw new Error("REFERENCE_IMPORT_SOURCE_PROJECT_REFRESH_FAILED");
    projectVersion = refreshedProject.value.aggregateVersion;

    const related = await content.relateProjects({ actor, projectId: created.value.contentId as StableId<"Project">,
      relatedProjectId: hidden.value.contentId as StableId<"Project">, expectedVersion: projectVersion,
      idempotencyKey: freshIdempotencyKey("reference-source-project-related"), correlationId: `reference-source-project-related-${randomUUID()}` });
    if (!related.ok) throw new Error(`REFERENCE_IMPORT_SOURCE_PROJECT_RELATIONSHIP_FAILED_${related.error.code}`);
    projectVersion = related.value.aggregateVersion;

    const imageMedia = await seedAcceptedSourceMedia({ ...scope, kind: "image" });
    const cvMedia = await seedAcceptedSourceMedia({ ...scope, kind: "document" });
    const previousCvMedia = await seedAcceptedSourceMedia({ ...scope, kind: "document" });
    const rejectedMedia = await seedAcceptedSourceMedia({ ...scope, kind: "image" });
    const rejectionAt = new Date().toISOString();
    await admin!.query("update media.processing_states set aggregate_version=4 where media_id=$1", [rejectedMedia.mediaId]);
    await admin!.query(`insert into media.rejection_history
      (rejection_id,portfolio_id,owner_id,media_id,aggregate_version,private_reason,rejected_by,rejected_at)
      values ($1,$2,$3,$4,4,'Synthetic private rejection rationale.',$3,$5::timestamptz)`,
    [createStableId("MediaRejection"), portfolioId, ownerId, rejectedMedia.mediaId, rejectionAt]);
    const cvVersionId = createStableId("CvVersion");
    const previousCvVersionId = createStableId("CvVersion");
    const cvApprovalId = createStableId("CvAcceptance");
    const previousCvApprovalId = createStableId("CvAcceptance");
    const cvActivationId = createStableId("CvActivation");
    const previousCvActivationId = createStableId("CvActivation");
    const cvRegisteredAt = new Date(Date.now() - 2_000).toISOString();
    const currentCvRegisteredAt = new Date(Date.now() - 1_000).toISOString();
    await admin!.query("begin");
    try {
      await admin!.query(`insert into cv_portfolio.portfolios (portfolio_id, owner_id, aggregate_version, current_version_id, ever_activated)
        values ($1, $2, 5, $3, true)`, [portfolioId, ownerId, cvVersionId]);
      await admin!.query(`insert into cv_portfolio.versions
        (version_id, portfolio_id, owner_id, media_id, media_asset_version, media_decision_id, media_object_id,
         media_sha256, media_object_version, version_number, locale, label, state, registered_at, is_current)
        values ($1, $2, $3, $4, 3, $5, $6, $7, $7, 1, 'en', 'Synthetic previous CV', 'accepted', $8::timestamptz, false)`,
      [previousCvVersionId, portfolioId, ownerId, previousCvMedia.mediaId, previousCvMedia.decisionId, previousCvMedia.outputObjectId,
        previousCvMedia.outputDigest, cvRegisteredAt]);
      await admin!.query(`insert into cv_portfolio.versions
        (version_id, portfolio_id, owner_id, media_id, media_asset_version, media_decision_id, media_object_id,
         media_sha256, media_object_version, version_number, locale, label, state, registered_at, is_current)
        values ($1, $2, $3, $4, 3, $5, $6, $7, $7, 2, 'en', 'Synthetic current CV', 'accepted', $8::timestamptz, true)`,
      [cvVersionId, portfolioId, ownerId, cvMedia.mediaId, cvMedia.decisionId, cvMedia.outputObjectId, cvMedia.outputDigest, currentCvRegisteredAt]);
      await admin!.query(`insert into cv_portfolio.acceptance_history
        (approval_id, portfolio_id, owner_id, version_id, media_decision_id, media_object_id, media_sha256,
         media_object_version, accepted_by, accepted_at)
        values ($1,$2,$3,$4,$5,$6,$7,$7,$3,$8::timestamptz)`,
      [previousCvApprovalId, portfolioId, ownerId, previousCvVersionId, previousCvMedia.decisionId,
        previousCvMedia.outputObjectId, previousCvMedia.outputDigest, cvRegisteredAt]);
      await admin!.query(`insert into cv_portfolio.acceptance_history
        (approval_id, portfolio_id, owner_id, version_id, media_decision_id, media_object_id, media_sha256,
         media_object_version, accepted_by, accepted_at)
        values ($1,$2,$3,$4,$5,$6,$7,$7,$3,$8::timestamptz)`,
      [cvApprovalId, portfolioId, ownerId, cvVersionId, cvMedia.decisionId, cvMedia.outputObjectId, cvMedia.outputDigest, currentCvRegisteredAt]);
      await admin!.query(`insert into cv_portfolio.activation_history (activation_id, portfolio_id, owner_id, version_id, activated_at)
        values ($1,$2,$3,$4,$5::timestamptz)`, [previousCvActivationId, portfolioId, ownerId, previousCvVersionId, cvRegisteredAt]);
      await admin!.query(`insert into cv_portfolio.activation_history (activation_id, portfolio_id, owner_id, version_id, activated_at)
        values ($1,$2,$3,$4,$5::timestamptz)`, [cvActivationId, portfolioId, ownerId, cvVersionId, currentCvRegisteredAt]);
      await admin!.query("commit");
    } catch (error) { await admin!.query("rollback"); throw error; }

    const feedbackId = createStableId("Feedback");
    const feedbackSubmittedAt = new Date(Date.now() - 3_000).toISOString();
    await admin!.query(`insert into interaction.feedback
      (feedback_id,portfolio_id,project_id,locale,author_name,paragraph,moderation_state,aggregate_version,submitted_at)
      values ($1,$2,$3,'en','Synthetic pending author','Synthetic pending Feedback text.','pending',1,$4::timestamptz)`,
    [feedbackId, portfolioId, created.value.contentId, feedbackSubmittedAt]);

    const feedbackTime = new Date(Date.now() - 1_500).toISOString();
    const approvedFeedbackId = createStableId("Feedback");
    const rejectedFeedbackId = createStableId("Feedback");
    const suppressedFeedbackId = createStableId("Feedback");
    await admin!.query(`insert into interaction.feedback
      (feedback_id,portfolio_id,project_id,locale,author_name,paragraph,moderation_state,aggregate_version,submitted_at,approved_at)
      values ($1,$2,$3,'en','Synthetic approved author','Approved source-backed feedback.','approved',2,$4::timestamptz,$5::timestamptz)`,
    [approvedFeedbackId, portfolioId, created.value.contentId, feedbackTime, feedbackTime]);
    await admin!.query(`insert into interaction.moderation_decisions
      (decision_id,portfolio_id,feedback_id,sequence,decision,reason,owner_id,decided_at)
      values ($1,$2,$3,1,'approved','Owner approved the retained feedback.',$4,$5::timestamptz)`,
    [createStableId("ModerationDecision"), portfolioId, approvedFeedbackId, ownerId, feedbackTime]);
    await admin!.query(`insert into interaction.feedback
      (feedback_id,portfolio_id,project_id,locale,author_name,paragraph,moderation_state,aggregate_version,submitted_at)
      values ($1,$2,$3,'en','Synthetic rejected author','Rejected source-backed feedback.','rejected',2,$4::timestamptz)`,
    [rejectedFeedbackId, portfolioId, created.value.contentId, feedbackTime]);
    await admin!.query(`insert into interaction.moderation_decisions
      (decision_id,portfolio_id,feedback_id,sequence,decision,reason,owner_id,decided_at)
      values ($1,$2,$3,1,'rejected','Does not meet publication policy.',$4,$5::timestamptz)`,
    [createStableId("ModerationDecision"), portfolioId, rejectedFeedbackId, ownerId, feedbackTime]);
    await admin!.query(`insert into interaction.feedback
      (feedback_id,portfolio_id,project_id,locale,author_name,paragraph,moderation_state,aggregate_version,submitted_at,approved_at,text_erased_at)
      values ($1,$2,$3,'ar',null,null,'suppressed',3,$4::timestamptz,$5::timestamptz,$5::timestamptz)`,
    [suppressedFeedbackId, portfolioId, created.value.contentId, feedbackTime, feedbackTime]);
    await admin!.query(`insert into interaction.moderation_decisions
      (decision_id,portfolio_id,feedback_id,sequence,decision,reason,owner_id,decided_at)
      values ($1,$2,$3,1,'approved',null,null,$4::timestamptz),
             ($5,$2,$3,2,'suppressed',null,null,$4::timestamptz)`,
    [createStableId("ModerationDecision"), portfolioId, suppressedFeedbackId, feedbackTime, createStableId("ModerationDecision")]);

    const goalId = createStableId("AnalyticsGoal");
    const previousGoalVersionId = createStableId("AnalyticsGoalVersion");
    const activeGoalVersionId = createStableId("AnalyticsGoalVersion");
    const previousGoalActivationId = createStableId("Event");
    const goalActivationId = createStableId("Event");
    const analyticsCaptured = await admin!.query<{ captured_at: Date | string }>("select transaction_timestamp() as captured_at");
    const capturedValue = analyticsCaptured.rows[0]?.captured_at;
    if (capturedValue === undefined) throw new Error("REFERENCE_IMPORT_SOURCE_ANALYTICS_CLOCK_MISSING");
    const analyticsAt = capturedValue instanceof Date ? capturedValue.toISOString() : new Date(capturedValue).toISOString();
    const captureDay = analyticsAt.slice(0, 10);
    const firstCheckpointDay = new Date(Date.parse(`${captureDay}T00:00:00.000Z`) - 400 * 86_400_000).toISOString().slice(0, 10);
    await admin!.query(`insert into measurement.daily_aggregate_checkpoints
      (portfolio_id,utc_day,source_event_count,source_conversion_count,policy_version,checkpoint_at,incomplete)
      select $1,day::date,0,0,'phase7.daily.v2',$2::timestamptz,false
        from generate_series($3::date,$4::date,interval '1 day') as day`, [portfolioId, analyticsAt, firstCheckpointDay, captureDay]);
    await admin!.query("begin");
    try {
      await admin!.query(`insert into measurement.analytics_goals (portfolio_id,goal_id,aggregate_version,active_version_id)
        values ($1,$2,5,null)`, [portfolioId, goalId]);
      await admin!.query(`insert into measurement.analytics_goal_versions
        (portfolio_id,goal_id,version_id,version_number,definition,created_at)
        values ($1,$2,$3,1,$4::jsonb,$5::timestamptz)`,
      [portfolioId, goalId, previousGoalVersionId, JSON.stringify({ name: "Synthetic first journey", steps: [{ action: "project-viewed",
        projectIds: [created.value.contentId] }] }), analyticsAt]);
      await admin!.query(`insert into measurement.analytics_goal_activation_history
        (portfolio_id,goal_id,activation_id,version_id,aggregate_version,activated_at,activation_sequence)
        values ($1,$2,$3,$4,3,$5::timestamptz,1)`, [portfolioId, goalId, previousGoalActivationId, previousGoalVersionId, analyticsAt]);
      await admin!.query(`insert into measurement.analytics_goal_versions
        (portfolio_id,goal_id,version_id,version_number,definition,created_at)
        values ($1,$2,$3,2,$4::jsonb,$5::timestamptz)`,
      [portfolioId, goalId, activeGoalVersionId, JSON.stringify({ name: "Synthetic current journey", steps: [{ action: "project-viewed",
        projectIds: [created.value.contentId, hidden.value.contentId], publicRouteIds: [published.value.routeIdentity] }] }), analyticsAt]);
      await admin!.query(`insert into measurement.analytics_goal_activation_history
        (portfolio_id,goal_id,activation_id,version_id,aggregate_version,activated_at,activation_sequence)
        values ($1,$2,$3,$4,5,$5::timestamptz,2)`, [portfolioId, goalId, goalActivationId, activeGoalVersionId, analyticsAt]);
      await admin!.query(`update measurement.analytics_goals set aggregate_version=5,active_version_id=$3 where portfolio_id=$1 and goal_id=$2`,
      [portfolioId, goalId, activeGoalVersionId]);
      await admin!.query(`insert into measurement.daily_aggregates
        (portfolio_id,utc_day,metric_kind,metric_key,goal_id,goal_version_id,dimensions,event_count,sum_value,observed_subjects,
         returning_subjects,policy_version,checkpoint_at,incomplete)
        values ($1,$2::date,'goal',$3,$4,$5,'{"locale":"ar"}'::jsonb,1,0,1,0,'phase7.daily.v2',$6::timestamptz,false),
               ($1,$2::date,'goal',$7,$4,$8,'{"locale":"ar"}'::jsonb,1,0,1,0,'phase7.daily.v2',$6::timestamptz,false)`,
      [portfolioId, captureDay, `${goalId}:${previousGoalVersionId}`, goalId, previousGoalVersionId, analyticsAt,
        `${goalId}:${activeGoalVersionId}`, activeGoalVersionId]);
      await admin!.query("commit");
    } catch (error) { await admin!.query("rollback"); throw error; }

    sourceBackedFixture = { content, projectId: created.value.contentId as StableId<"Project">,
      contentIds: [created.value.contentId, hidden.value.contentId, achievement.value.contentId, tiedProject.value.contentId, draft.value.contentId] as StableId<string>[],
      hiddenProjectId: hidden.value.contentId as StableId<"Project">,
      tiePublishedProjectId: tiedProject.value.contentId as StableId<"Project">,
      draftProjectId: draft.value.contentId as StableId<"Project">, tiedFirstPublishedAt: contentClockAt,
      archivedAchievementId: achievement.value.contentId as StableId<"Achievement">, projectVersion,
      contentDraftData: { caseStudy: payload.caseStudy, evidence: payload.evidence, externalLinks: payload.externalLinks },
      currentRevisionId: created.value.revisionId,
      taxonomy, taxonomyId, taxonomyValueId, taxonomyAssignedValueId, taxonomyMergedValueId: taxonomyAssignedValueId,
      taxonomyRetiredValueId, taxonomyVersion: mergedTaxonomy.value.aggregateVersion,
      media: [imageMedia, cvMedia, previousCvMedia], currentCvId: cvVersionId, currentCvNumber: 2, previousCvId: previousCvVersionId,
      rejectedMediaId: rejectedMedia.mediaId, goalId, previousGoalVersionId, activeGoalVersionId, feedbackId,
      approvedFeedbackId, rejectedFeedbackId, suppressedFeedbackId };
    if (sourceBackedFixture === undefined) throw new Error("REFERENCE_IMPORT_SOURCE_FIXTURE_MISSING");
    return sourceBackedFixture;
  }

  function sourceSnapshotReader(content = createPostgresContentAuthoringRepository()) {
    const settingsRepository = createPostgresPortfolioSettingsRepository();
    return createOwnerExportSnapshotReader({
      configuration: settingsRepository,
      content,
      taxonomy: createTaxonomyOwnerExportSnapshotReader({ repository: createPostgresTaxonomyOwnerRepository(),
        assignments: createPostgresContentTaxonomyExportAssignmentReader() }),
      media: createPostgresOwnerMediaExportSnapshotReader({ database: worker!.database, transactions: worker!.transactions }),
      cv: createPostgresOwnerCvExportSnapshotReader(),
      moderation: createPostgresFeedbackOwnerExportSnapshotReader(),
      analytics: createPostgresOwnerAnalyticsExportSnapshotReader(),
      transactions: worker!.transactions,
      capabilities: { async read() { return { currentCvAvailable: true, externalLinksAvailable: true }; } },
    });
  }

  it("AC01 uses seeded owning-module sources, real source Storage reads and actual ready/download revalidation before import", async () => {
    const fixture = await seedSourceBackedFixture();
    const scope = { portfolioId: asStableId<"Portfolio">(fixtureIds.portfolio), ownerId: asStableId<"Owner">(fixtureIds.owner) };
    const expectedDiscoveryTieOrder = [fixture.projectId, fixture.tiePublishedProjectId].sort().reverse();
    const publicDiscovery = createPublicDiscoveryService({ reader: createPostgresPublicDiscoveryReader(scope), transactions: application!.transactions });
    const sourcePublicPage = await publicDiscovery.getPublicDiscovery({ locale: "en", limit: 20 });
    expect(sourcePublicPage.ok).toBe(true);
    if (!sourcePublicPage.ok) throw new Error("REFERENCE_IMPORT_SOURCE_PUBLIC_DISCOVERY_FAILED");
    expect(sourcePublicPage.value.entries.map((entry) => entry.projectId)).toEqual(expectedDiscoveryTieOrder);
    expect(sourcePublicPage.value.entries.map((entry) => entry.firstPublishedAt)).toEqual([fixture.tiedFirstPublishedAt, fixture.tiedFirstPublishedAt]);
    expect(sourcePublicPage.value.entries.map((entry) => entry.projectId)).not.toContain(fixture.draftProjectId);
    metrics.sourceBackedDiscoveryTieOrder = sourcePublicPage.value.entries.map((entry) => entry.projectId);
    const snapshots = sourceSnapshotReader();
    const sourceStorage = createSupabaseMediaExportStorage({ storageUrl: STORAGE_URL!, serviceRoleKey: STORAGE_KEY!,
      candidateBucket, processedBucket });
    const now = () => new Date().toISOString();
    const operations = createPostgresOperationsPersistence(application!.database, { now });
    const store = createPostgresOwnerExportStore(application!.database, { outbox: operations.outbox });
    const actor: OwnerActor = { kind: "owner", ownerId: scope.ownerId, sessionId: "reference-import-source-backed-owner" };
    const revalidate = async (method: "revalidateMediaForReady" | "revalidateModerationForReady", input: {
      snapshot: OwnerExportAssemblySnapshot;
      portfolioId: StableId<"Portfolio">; ownerId: StableId<"Owner">;
    }) => worker!.transactions.run((context) => snapshots[method]!({ ...input, context }), { isolationLevel: "repeatable read" });
    const service = createOwnerExportService({ operations, exports: store, clock: { now }, ids: createSystemIdGenerator(), objectRead: storage!,
      revalidateMediaForDownload: (input) => revalidate("revalidateMediaForReady", input),
      revalidateModerationForDownload: (input) => revalidate("revalidateModerationForReady", input) });
    const workerOperations = createPostgresOperationsPersistence(worker!.database, { now });
    const workerStore = createPostgresOwnerExportStore(worker!.database, { outbox: workerOperations.outbox });
    let sourceObjectReadCount = 0;
    const mediaObjects = { async readMediaExportObject(input: Parameters<typeof sourceStorage.readMediaExportObject>[0]) {
      const transactions = await admin!.query<{ count: number }>(`select count(*)::int as count from pg_stat_activity
        where datname=current_database() and state='idle in transaction' and pid <> pg_backend_pid()`);
      expect(Number(transactions.rows[0]?.count ?? 0)).toBe(0);
      sourceObjectReadCount += 1;
      const content = await sourceStorage.readMediaExportObject(input);
      return { async *[Symbol.asyncIterator]() { for await (const chunk of content) yield chunk; } };
    } };
    const assembly = createOwnerExportAssemblyService({ operations: workerOperations, exports: workerStore, artifacts: workerStore,
      snapshots, storage: storage!, mediaObjects, clock: { now }, ids: createSystemIdGenerator() });
    const requestKey = freshIdempotencyKey("reference-import-source-backed-request");
    const request = await service.requestOwnerExport({ actor, portfolioId: scope.portfolioId, idempotencyKey: requestKey,
      includedScopes: [...scopeOrder] });
    expect(request.ok).toBe(true);
    if (!request.ok) throw new Error("REFERENCE_IMPORT_SOURCE_BACKED_REQUEST_FAILED");
    const assembled = await assembly.runOwnerExportAssembly({ workerId: `reference-source-${randomUUID()}` });
    expect(assembled).toMatchObject({ ok: true, value: { claimed: 1, completed: 1, retried: 0, failed: 0, staleLeases: 0 } });
    const persisted = await workerStore.findOwnerExport({ ...scope, exportId: request.value.exportId });
    expect(persisted).toMatchObject({ status: "ready", snapshot: { kind: "owner-export-snapshot-v1", includedScopes: scopeOrder } });
    const downloaded = await service.downloadOwnerExport({ actor, portfolioId: scope.portfolioId, exportId: request.value.exportId });
    expect(downloaded.ok).toBe(true);
    if (!downloaded.ok) throw new Error("REFERENCE_IMPORT_SOURCE_BACKED_DOWNLOAD_FAILED");
    const archive = await readAll(downloaded.value.content);
    const checked = validateOwnerExportZip(archive);
    expect(checked.includedScopes).toEqual(scopeOrder);
    expect(sourceObjectReadCount).toBeGreaterThanOrEqual(4);
    metrics.sourceBackedArchiveBytes = archive.byteLength;
    metrics.sourceBackedSourceObjectReads = sourceObjectReadCount;

    const namespace = uuid(randomUUID());
    const target = createTargetSink(importBucket);
    const imported = await importOwnerExportReference({ archive, database: target.database, objectSink: target.sink, namespace });
    namespaces.add(namespace);
    namespaceOwners.set(namespace, imported.ownerToken);
    const projected = await admin!.query<{ kind: string; identity: string; value: Record<string, unknown> }>(
      `select kind,identity,value from "${namespace}".reference_model order by kind,identity`);
    const byProjection = new Map(projected.rows.map((row) => [`${row.kind}:${row.identity}`, row.value]));
    const mainContent = byProjection.get(`content-item:${fixture.projectId}`);
    expect(mainContent?.["lifecycle"]).toBe("published");
    expect(mainContent?.["publicLocales"]).toEqual(["ar", "en"]);
    expect(mainContent?.["publiclyDiscoverable"]).toBe(true);
    expect(mainContent?.["featured"]).toBe(true);
    expect(mainContent?.["projectStatus"]).toMatchObject({ label: "Shipped", state: "active" });
    expect(mainContent?.["routeHistory"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ fromSlug: "source-backed-project", toSlug: "source-backed-project-current" }),
      expect.objectContaining({ fromSlug: "source-backed-project-v2", toSlug: "source-backed-project-current" }),
    ]));
    expect((mainContent?.["publications"] as Array<Record<string, unknown>>).map((publication) => publication["locale"]).sort()).toEqual(["ar", "en"]);
    expect((mainContent?.["publicationHistory"] as Array<Record<string, unknown>>).length).toBeGreaterThanOrEqual(2);
    expect((mainContent?.["revisions"] as Array<Record<string, unknown>>)).toEqual(expect.arrayContaining([
      expect.objectContaining({ locale: "en", currentlyPublished: true }), expect.objectContaining({ locale: "ar", currentlyPublished: true }),
    ]));
    expect(mainContent?.["relatedProjectIds"]).toEqual([fixture.hiddenProjectId]);
    expect(mainContent?.["relationshipHistory"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ initiatingProjectId: fixture.projectId, relatedProjectId: fixture.hiddenProjectId }),
    ]));
    expect(byProjection.get(`content-relationship:${fixture.projectId}:${fixture.hiddenProjectId}`)).toMatchObject({
      contentId: fixture.projectId, relatedContentId: fixture.hiddenProjectId, selected: true,
      history: [expect.objectContaining({ initiatingProjectId: fixture.projectId, relatedProjectId: fixture.hiddenProjectId })],
    });
    expect(byProjection.get(`content-item:${fixture.hiddenProjectId}`)).toMatchObject({ lifecycle: "hidden", publicLocales: [],
      publicRouteIdentity: expect.any(String), publiclyDiscoverable: false, publicationHistory: expect.any(Array) });
    expect(byProjection.get(`content-item:${fixture.archivedAchievementId}`)).toMatchObject({ lifecycle: "archived", publicLocales: [],
      publiclyDiscoverable: false, lifecycleHistory: expect.any(Array) });
    const draftProjection = byProjection.get(`content-item:${fixture.draftProjectId}`);
    expect(draftProjection).toMatchObject({ lifecycle: "draft", publicLocales: [], publiclyDiscoverable: false,
      firstPublishedAt: null, publicRouteIdentity: null });
    expect(projected.rows.some((row) => row.kind === "public-route" && row.value["contentId"] === fixture.draftProjectId)).toBe(false);
    expect(projected.rows.some((row) => row.kind === "public-discovery-entry" && row.identity === fixture.draftProjectId)).toBe(false);
    const importedDiscovery = projected.rows.filter((row) => row.kind === "public-discovery-entry").map((row) => row.value)
      .sort((left, right) => Number(left["position"]) - Number(right["position"]));
    expect(importedDiscovery.map((entry) => ({ contentId: entry["contentId"], firstPublishedAt: entry["firstPublishedAt"], position: entry["position"] })))
      .toEqual(expectedDiscoveryTieOrder.map((contentId, index) => ({ contentId, firstPublishedAt: fixture.tiedFirstPublishedAt, position: index + 1 })));
    expect(importedDiscovery.some((entry) => entry["contentId"] === fixture.draftProjectId)).toBe(false);
    expect(byProjection.get(`content-item:${fixture.tiePublishedProjectId}`)).toMatchObject({ lifecycle: "published", publicLocales: ["en"],
      publiclyDiscoverable: true, firstPublishedAt: fixture.tiedFirstPublishedAt });
    metrics.sourceBackedDraftPublicLocales = draftProjection?.["publicLocales"] as string[];
    expect(byProjection.get(`taxonomy-assignment:${fixture.taxonomyId}:${fixture.projectId}:${fixture.taxonomyValueId}`))
      .toMatchObject({ valueState: "active", currentMeaningId: fixture.taxonomyValueId });
    expect((byProjection.get(`taxonomy:${fixture.taxonomyId}`)?.["assignmentHistory"] as Array<Record<string, unknown>>))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ targetId: fixture.projectId, taxonomyValueId: fixture.taxonomyAssignedValueId, sequence: 1 }),
        expect.objectContaining({ targetId: fixture.projectId, taxonomyValueId: fixture.taxonomyValueId, sequence: 2 }),
      ]));
    expect(byProjection.get(`taxonomy-value:${fixture.taxonomyMergedValueId}`)).toMatchObject({ name: "Service Layer", state: "merged",
      mergedIntoValueId: fixture.taxonomyValueId, currentMeaningId: fixture.taxonomyValueId });
    expect(byProjection.get(`taxonomy-value:${fixture.taxonomyValueId}`)).toMatchObject({ name: "Services", state: "active" });
    expect(byProjection.get(`taxonomy-value:${fixture.taxonomyRetiredValueId}`)).toMatchObject({ name: "Legacy service", state: "retired" });
    expect(byProjection.get(`taxonomy:${fixture.taxonomyId}`)?.["evolutionHistory"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "renamed", valueId: fixture.taxonomyMergedValueId }),
      expect.objectContaining({ action: "retired", valueId: fixture.taxonomyRetiredValueId }),
      expect.objectContaining({ action: "merged", valueId: fixture.taxonomyMergedValueId, mergedIntoValueId: fixture.taxonomyValueId }),
    ]));
    const cvProjection = byProjection.get("cv-portfolio:aggregate");
    expect(cvProjection?.["currentVersionId"]).toBe(fixture.currentCvId);
    expect(cvProjection?.["currentVersion"]).toMatchObject({ versionId: fixture.currentCvId, state: "accepted", versionNumber: 2 });
    expect(cvProjection?.["versions"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ versionId: fixture.currentCvId, versionNumber: 2, isCurrent: true }),
      expect.objectContaining({ versionId: fixture.previousCvId, versionNumber: 1, isCurrent: false }),
    ]));
    expect(byProjection.get(`moderation-feedback:${fixture.feedbackId}`)).toMatchObject({ state: "pending", retainedText: null, decisionHistory: [] });
    expect(byProjection.get(`moderation-feedback:${fixture.approvedFeedbackId}`)).toMatchObject({ state: "approved",
      retainedText: { authorName: "Synthetic approved author", paragraph: "Approved source-backed feedback." },
      decisionHistory: [{ decision: "approved" }] });
    expect(byProjection.get(`moderation-feedback:${fixture.rejectedFeedbackId}`)).toMatchObject({ state: "rejected",
      retainedText: { authorName: "Synthetic rejected author", paragraph: "Rejected source-backed feedback." },
      decisionHistory: [{ decision: "rejected" }] });
    const erasedModeration = byProjection.get(`moderation-feedback:${fixture.suppressedFeedbackId}`);
    expect(erasedModeration).toMatchObject({ state: "suppressed", locale: "ar", textDisposition: "erased", retainedText: null,
      decisionHistory: [{ decision: "approved" }, { decision: "suppressed" }] });
    expect((erasedModeration?.["decisionHistory"] as Array<Record<string, unknown>>).every((decision) => !Object.hasOwn(decision, "reason"))).toBe(true);
    const goal = byProjection.get(`analytics-goal:${fixture.goalId}`);
    expect(goal?.["activeVersionId"]).toBe(fixture.activeGoalVersionId);
    expect(goal?.["versions"]).toEqual(expect.arrayContaining([
      expect.objectContaining({ versionId: fixture.previousGoalVersionId, versionNumber: 1 }),
      expect.objectContaining({ versionId: fixture.activeGoalVersionId, versionNumber: 2 }),
    ]));
    expect(goal?.["activationHistory"]).toEqual([
      expect.objectContaining({ versionId: fixture.previousGoalVersionId, activationSequence: 1 }),
      expect.objectContaining({ versionId: fixture.activeGoalVersionId, activationSequence: 2 }),
    ]);
    const reports = goal?.["reports"] as Array<Record<string, unknown>>;
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.every((report) => report["countDisposition"] === "withheld"
      ? !Object.hasOwn(report, "cells") && !Object.hasOwn(report, "aggregateCount")
      : report["countDisposition"] === "not-applicable"
        ? !Object.hasOwn(report, "cells") && !Object.hasOwn(report, "aggregateCount")
      : report["countDisposition"] === "included")).toBe(true);
    const withheldVersions = new Set(reports.filter((report) => report["countDisposition"] === "withheld")
      .map((report) => report["goalVersionId"]));
    expect(withheldVersions).toEqual(new Set([fixture.previousGoalVersionId, fixture.activeGoalVersionId]));
    expect(byProjection.get("portfolio-configuration:aggregate")).toMatchObject({ profile: { displayName: "Reference import synthetic owner" } });
    for (const media of fixture.media) {
      const projectedMedia = byProjection.get(`media:${media.mediaId}`);
      expect(projectedMedia).toMatchObject({ state: "accepted", accepted: true,
        includedBytes: expect.arrayContaining([expect.objectContaining({ digest: media.inputDigest }), expect.objectContaining({ digest: media.outputDigest })]) });
      expect(projectedMedia?.["accessibilityMetadata"]).toEqual(media.inputType === "image/png"
        ? { kind: "described-image", altText: "Synthetic source-backed image." }
        : { kind: "document", summary: "Synthetic source-backed PDF." });
    }
    expect(byProjection.get(`media:${fixture.rejectedMediaId}`)).toMatchObject({ state: "rejected", publicationState: "withdrawn",
      accepted: false, includedBytes: [] });
    const storedAssets = await admin!.query<{ path: string; source_path: string; sha256: string; byte_length: number }>(
      `select path,source_path,sha256,byte_length from "${namespace}".assets order by source_path`);
    expect(storedAssets.rows.length).toBeGreaterThanOrEqual(4);
    for (const asset of storedAssets.rows) {
      const body = await fetch(storageDownloadUrl(importBucket, `${namespace}/${asset.path}`), { headers: authHeaders() });
      expect(body.ok).toBe(true);
      const bytes = new Uint8Array(await body.arrayBuffer());
      expect(bytes.byteLength).toBe(asset.byte_length);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
    }
    const capturedPackageText = new TextDecoder().decode(archive);
    expect(capturedPackageText).not.toContain("Synthetic private rejection rationale");
    expect(capturedPackageText).not.toContain("Synthetic suppressed personal text");
    expect(capturedPackageText).not.toMatch(/raw visitor|raw-event|session-id/iu);
    metrics.sourceBackedRichFacts = ["English and Arabic publication history", "hidden project and archived achievement",
      "route redirects", "source-backed relationship edge and relationship history projection", "Draft remains private with no public locale, route, or discovery entry",
      "equal first-published-time discovery tie ordered by content ID descending in source query and imported projections",
      "taxonomy rename, retirement and merge", "accepted, previous-CV and withdrawn Media",
      "two CV versions with exact source bytes", "approved, rejected, pending and erased minimal Moderation audit",
      "two activated goal versions with independently withheld reports"];
    metrics.sourceBackedRecords = imported.totalRecords;
    metrics.sourceBackedAssets = imported.assetCount;
    metrics.sourceBackedAssetBytes = imported.assetBytes;
    await cleanupOwnerExportReference({ database: admin!, objectSink: target.sink, namespace, ownerToken: imported.ownerToken });
    namespaces.delete(namespace);
    namespaceOwners.delete(namespace);
    metrics.sourceBackedCleanup = true;
  }, 90_000);

  it("AC07 barriers one composed PostgreSQL capture against publication, CV, taxonomy, Moderation and goal changes", async () => {
    const fixture = await seedSourceBackedFixture();
    const scope = { portfolioId: asStableId<"Portfolio">(fixtureIds.portfolio), ownerId: asStableId<"Owner">(fixtureIds.owner) };
    const delegate = createPostgresContentAuthoringRepository();
    let releaseCapture!: () => void;
    let signalCapture!: () => void;
    const continueCapture = new Promise<void>((resolve) => { releaseCapture = resolve; });
    const contentReadReached = new Promise<void>((resolve) => { signalCapture = resolve; });
    let firstContentRead = true;
    const pausedContent = { ...delegate, async readOwnerExportSnapshot(target: Parameters<typeof delegate.readOwnerExportSnapshot>[0], context: Parameters<typeof delegate.readOwnerExportSnapshot>[1]) {
      const result = await delegate.readOwnerExportSnapshot(target, context);
      if (firstContentRead) { firstContentRead = false; signalCapture(); await continueCapture; }
      return result;
    } };
    const snapshots = sourceSnapshotReader(pausedContent);
    const capturePending = snapshots.capture({ portfolioId: scope.portfolioId, ownerId: scope.ownerId,
      snapshotId: createStableId("OwnerExportArtifact"), includedScopes: [...scopeOrder] });
    await contentReadReached;

    const contentNext = await fixture.content.saveRevision({ actor: { kind: "owner", ownerId: scope.ownerId, sessionId: "reference-race-content" },
      contentId: fixture.projectId, expectedVersion: fixture.projectVersion, idempotencyKey: freshIdempotencyKey("reference-race-content-save"),
      correlationId: `reference-race-content-save-${randomUUID()}`, locale: "en", title: "Concurrent publication revision",
      summary: "Second synthetic publication.", body: "Second synthetic public body.",
      draftData: { contentType: "project", ...fixture.contentDraftData } as never });
    if (!contentNext.ok) throw new Error("REFERENCE_IMPORT_RACE_CONTENT_SAVE_FAILED");
    const nextPreview = await fixture.content.previewRevision({ actor: { kind: "owner", ownerId: scope.ownerId, sessionId: "reference-race-content" },
      contentId: fixture.projectId, revisionId: contentNext.value.revisionId });
    if (!nextPreview.ok) throw new Error("REFERENCE_IMPORT_RACE_CONTENT_PREVIEW_FAILED");
    const nextReview = await fixture.content.reviewRevision({ actor: { kind: "owner", ownerId: scope.ownerId, sessionId: "reference-race-content" },
      contentId: fixture.projectId, revisionId: contentNext.value.revisionId, expectedVersion: contentNext.value.aggregateVersion,
      idempotencyKey: freshIdempotencyKey("reference-race-content-review"), correlationId: `reference-race-content-review-${randomUUID()}`,
      locale: "en", snapshotHash: nextPreview.value.snapshotHash, evidenceVersion: nextPreview.value.evidenceVersion,
      decision: "accepted", findings: [] });
    if (!nextReview.ok) throw new Error("REFERENCE_IMPORT_RACE_CONTENT_REVIEW_FAILED");
    const nextPublication = await fixture.content.publishLanguageVersion({
      actor: { kind: "owner", ownerId: scope.ownerId, sessionId: "reference-race-content" }, contentId: fixture.projectId,
      revisionId: contentNext.value.revisionId, expectedVersion: nextReview.value.aggregateVersion,
      idempotencyKey: freshIdempotencyKey("reference-race-content-publish"), correlationId: `reference-race-content-publish-${randomUUID()}`, locale: "en",
    });
    if (!nextPublication.ok) throw new Error("REFERENCE_IMPORT_RACE_CONTENT_PUBLISH_FAILED");
    fixture.projectVersion = nextPublication.value.aggregateVersion;

    const taxonomyRename = await fixture.taxonomy.renameOwnerTaxonomyValue({ actor: { kind: "owner", ownerId: scope.ownerId, sessionId: "reference-race-taxonomy" },
      idempotencyKey: freshIdempotencyKey("reference-race-taxonomy-rename"),
      expectedVersion: fixture.taxonomyVersion, valueId: fixture.taxonomyValueId, name: "Concurrent renamed services" });
    if (!taxonomyRename.ok) throw new Error("REFERENCE_IMPORT_RACE_TAXONOMY_RENAME_FAILED");
    fixture.taxonomyVersion = taxonomyRename.value.aggregateVersion;

    await admin!.query(`update interaction.feedback set moderation_state='approved',aggregate_version=2,approved_at=transaction_timestamp()
      where portfolio_id=$1 and feedback_id=$2`, [scope.portfolioId, fixture.feedbackId]);
    await admin!.query(`insert into interaction.moderation_decisions
      (decision_id,portfolio_id,feedback_id,sequence,decision,reason,owner_id,decided_at)
      values ($1,$2,$3,1,'approved','Synthetic concurrent approval.',$4,transaction_timestamp())`,
    [createStableId("ModerationDecision"), scope.portfolioId, fixture.feedbackId, scope.ownerId]);

    const cvMedia = fixture.media.find((item) => item.outputType === "application/pdf");
    if (cvMedia === undefined) throw new Error("REFERENCE_IMPORT_RACE_CV_MEDIA_MISSING");
    const nextCvId = createStableId("CvVersion");
    const nextCvApprovalId = createStableId("CvAcceptance");
    const nextCvActivationId = createStableId("CvActivation");
    const cvAt = new Date().toISOString();
    await admin!.query("begin");
    try {
      await admin!.query("update cv_portfolio.versions set is_current=false where version_id=$1", [fixture.currentCvId]);
      await admin!.query(`insert into cv_portfolio.versions
        (version_id, portfolio_id, owner_id, media_id, media_asset_version, media_decision_id, media_object_id,
         media_sha256, media_object_version, version_number, locale, label, state, registered_at, is_current)
        values ($1,$2,$3,$4,3,$5,$6,$7,$7,3,'en','Synthetic next CV','accepted',$8::timestamptz,true)`,
      [nextCvId, scope.portfolioId, scope.ownerId, cvMedia.mediaId, cvMedia.decisionId, cvMedia.outputObjectId, cvMedia.outputDigest, cvAt]);
      await admin!.query(`insert into cv_portfolio.acceptance_history
        (approval_id,portfolio_id,owner_id,version_id,media_decision_id,media_object_id,media_sha256,media_object_version,accepted_by,accepted_at)
        values ($1,$2,$3,$4,$5,$6,$7,$7,$3,$8::timestamptz)`,
      [nextCvApprovalId, scope.portfolioId, scope.ownerId, nextCvId, cvMedia.decisionId, cvMedia.outputObjectId, cvMedia.outputDigest, cvAt]);
      await admin!.query(`insert into cv_portfolio.activation_history (activation_id,portfolio_id,owner_id,version_id,activated_at)
        values ($1,$2,$3,$4,$5::timestamptz)`, [nextCvActivationId, scope.portfolioId, scope.ownerId, nextCvId, cvAt]);
      await admin!.query(`update cv_portfolio.portfolios set aggregate_version=7,current_version_id=$3,ever_activated=true
        where portfolio_id=$1 and owner_id=$2`, [scope.portfolioId, scope.ownerId, nextCvId]);
      await admin!.query("commit");
    } catch (error) {
      await admin!.query("rollback");
      const code = error && typeof error === "object" && "code" in error ? String(error.code).replace(/[^A-Z0-9_]/giu, "_") : "UNKNOWN";
      throw new Error(`REFERENCE_IMPORT_RACE_CV_SEED_DIAGNOSTIC_${code}`);
    }

    const nextGoalVersionId = createStableId("AnalyticsGoalVersion");
    await admin!.query("begin");
    try {
      await admin!.query(`insert into measurement.analytics_goal_versions
        (portfolio_id,goal_id,version_id,version_number,definition,created_at)
        values ($1,$2,$3,3,$4::jsonb,transaction_timestamp())`,
      [scope.portfolioId, fixture.goalId, nextGoalVersionId, JSON.stringify({ name: "Concurrent goal revision", steps: [{ action: "project-viewed",
        projectIds: [fixture.projectId] }] })]);
      await admin!.query(`insert into measurement.analytics_goal_activation_history
        (portfolio_id,goal_id,activation_id,version_id,aggregate_version,activated_at,activation_sequence)
        values ($1,$2,$3,$4,7,transaction_timestamp(),3)`,
      [scope.portfolioId, fixture.goalId, createStableId("Event"), nextGoalVersionId]);
      await admin!.query(`update measurement.analytics_goals set aggregate_version=7,active_version_id=$3
        where portfolio_id=$1 and goal_id=$2`, [scope.portfolioId, fixture.goalId, nextGoalVersionId]);
      await admin!.query("commit");
    } catch (error) { await admin!.query("rollback"); throw error; }

    releaseCapture();
    const capture = await capturePending;
    expect(capture.ok).toBe(true);
    if (!capture.ok || !("kind" in capture.value)) throw new Error("REFERENCE_IMPORT_RACE_CAPTURE_FAILED");
    const selected = capture.value;
    const capturedContent = selected.content?.records.find((record) => record.contentId === fixture.projectId)?.value;
    expect(capturedContent?.["publications"]).toContainEqual(expect.objectContaining({ revisionId: fixture.currentRevisionId }));
    expect(capturedContent?.["publications"]).not.toContainEqual(expect.objectContaining({ revisionId: contentNext.value.revisionId }));
    expect(selected.cv?.currentVersionId).toBe(fixture.currentCvId);
    expect(selected.cv?.currentVersionId).not.toBe(nextCvId);
    expect(selected.taxonomy?.records.find((record) => record.taxonomyId === fixture.taxonomyId)?.value["values"])
      .toContainEqual(expect.objectContaining({ valueId: fixture.taxonomyValueId, name: "Services" }));
    expect(selected.moderation?.records.find((record) => record.feedbackId === fixture.feedbackId)?.value).toMatchObject({ state: "pending" });
    expect(selected.analytics?.records.find((record) => record.goalId === fixture.goalId)?.value["goal"])
      .toMatchObject({ activeVersionId: fixture.activeGoalVersionId });
    expect(selected.analytics?.records.find((record) => record.goalId === fixture.goalId)?.value["goal"])
      .not.toMatchObject({ activeVersionId: nextGoalVersionId });
    const sourceStorage = createSupabaseMediaExportStorage({ storageUrl: STORAGE_URL!, serviceRoleKey: STORAGE_KEY!,
      candidateBucket, processedBucket });
    let raceSourceObjectReads = 0;
    const raceObjects = { async readMediaExportObject(input: Parameters<typeof sourceStorage.readMediaExportObject>[0]) {
      const openTransactions = await admin!.query<{ count: number }>(`select count(*)::int as count from pg_stat_activity
        where datname=current_database() and state='idle in transaction' and pid <> pg_backend_pid()`);
      expect(Number(openTransactions.rows[0]?.count ?? 0)).toBe(0);
      raceSourceObjectReads += 1;
      return sourceStorage.readMediaExportObject(input);
    } };
    const racePackage = await buildSelectedOwnerExportPackage({ exportId: createStableId("OwnerExport"),
      portfolioId: scope.portfolioId, snapshot: selected, objects: raceObjects });
    const raceArchive = await readAll(racePackage.content);
    const raceNamespace = uuid(randomUUID());
    const raceTarget = createTargetSink(importBucket);
    const raceImport = await importOwnerExportReference({ archive: raceArchive, database: raceTarget.database,
      objectSink: raceTarget.sink, namespace: raceNamespace });
    namespaces.add(raceNamespace);
    namespaceOwners.set(raceNamespace, raceImport.ownerToken);
    const raceProjection = await admin!.query<{ kind: string; identity: string; value: Record<string, unknown> }>(
      `select kind,identity,value from "${raceNamespace}".reference_model`);
    const raceFacts = new Map(raceProjection.rows.map((row) => [`${row.kind}:${row.identity}`, row.value]));
    expect(raceFacts.get(`content-item:${fixture.projectId}`)?.["publications"])
      .toContainEqual(expect.objectContaining({ revisionId: fixture.currentRevisionId }));
    expect(raceFacts.get(`content-item:${fixture.projectId}`)?.["publications"])
      .not.toContainEqual(expect.objectContaining({ revisionId: contentNext.value.revisionId }));
    expect(raceFacts.get("cv-portfolio:aggregate")).toMatchObject({ currentVersionId: fixture.currentCvId });
    expect(raceFacts.get(`taxonomy-value:${fixture.taxonomyValueId}`)).toMatchObject({ name: "Services", state: "active" });
    expect(raceFacts.get(`moderation-feedback:${fixture.feedbackId}`)).toMatchObject({ state: "pending", retainedText: null });
    expect(raceFacts.get(`analytics-goal:${fixture.goalId}`)).toMatchObject({ activeVersionId: fixture.activeGoalVersionId });
    expect(raceSourceObjectReads).toBeGreaterThanOrEqual(4);
    await cleanupOwnerExportReference({ database: admin!, objectSink: raceTarget.sink,
      namespace: raceNamespace, ownerToken: raceImport.ownerToken });
    namespaces.delete(raceNamespace);
    namespaceOwners.delete(raceNamespace);
    metrics.barrier = { ...(metrics.barrier ?? {}), reached: true, coherentCompositeCapture: true, contentPublicationChanged: true, cvPointerChanged: true,
      taxonomyHistoryChanged: true, moderationStateChanged: true, analyticsPointerChanged: true,
      capturedOldPublication: true, capturedOldCv: true, capturedOldTaxonomy: true, capturedOldModeration: true, capturedOldGoal: true,
      importedCoherentProjection: true, raceArchiveBytes: raceArchive.byteLength, raceImportedRecords: raceImport.totalRecords,
      raceImportedAssets: raceImport.assetCount, raceSourceObjectReads };
  }, 90_000);

  it("supplemental synthetic full-scope fixture covers extended projections and partial selections", async () => {
    const startedAt = performance.now();
    // Keep the fake worker lease ahead of the real database clock while
    // retaining the fixture's current policy window.
    const acceptanceClock = () => new Date().toISOString();
    const fullSnapshot = await exportSnapshot(scopeOrder, fixtureIds.snapshot);
    const serviceOperations = createPostgresOperationsPersistence(application!.database, { now: acceptanceClock });
    const store = createPostgresOwnerExportStore(application!.database, { outbox: serviceOperations.outbox });
    const actor: OwnerActor = { kind: "owner", ownerId: asStableId<"Owner">(fixtureIds.owner), sessionId: "reference-import-owner" };
    const service = createOwnerExportService({
      operations: serviceOperations, exports: store, clock: { now: acceptanceClock }, ids: createSystemIdGenerator(),
      objectRead: storage!, revalidateMediaForDownload: async () => true, revalidateModerationForDownload: async () => true,
    });
    const workerOperations = createPostgresOperationsPersistence(worker!.database, { now: acceptanceClock });
    const workerStore = createPostgresOwnerExportStore(worker!.database, { outbox: workerOperations.outbox });
    const snapshots = {
      async capture(input: { readonly includedScopes: readonly (typeof scopeOrder)[number][]; readonly snapshotId: StableId<"OwnerExportArtifact"> }) {
        return ok(await exportSnapshot(input.includedScopes, input.snapshotId));
      },
      async restoreModerationSnapshot(input: { readonly snapshot: { readonly kind: string } }) {
        return ok({ ...input.snapshot, moderation: fullSnapshot.moderation } as never);
      },
      async revalidateMediaForReady() { return true; },
      async revalidateModerationForReady() { return true; },
    } as never;
    let releaseSourceRead: (() => void) | undefined;
    let sourceReadEntered: (() => void) | undefined;
    let sourceReadBlocked = false;
    const sourceReadBarrier = new Promise<void>((resolve) => { releaseSourceRead = resolve; });
    const sourceReadObserved = new Promise<void>((resolve) => { sourceReadEntered = resolve; });
    const barrierObjectReader = { async readMediaExportObject(input: Parameters<typeof objectReader.readMediaExportObject>[0]) {
      if (!sourceReadBlocked) { sourceReadBlocked = true; sourceReadEntered?.(); await sourceReadBarrier; }
      return objectReader.readMediaExportObject(input);
    } };
    const assembly = createOwnerExportAssemblyService({ operations: workerOperations, exports: workerStore, artifacts: workerStore,
      snapshots, storage: storage!, mediaObjects: barrierObjectReader, clock: { now: acceptanceClock }, ids: createSystemIdGenerator() });
    const idempotency = parseIdempotencyKey(`reference-import-full-${randomUUID()}`);
    if (!idempotency.ok) throw new Error("REFERENCE_IMPORT_IDEMPOTENCY_KEY_INVALID");
    const request = await service.requestOwnerExport({ actor, portfolioId: asStableId<"Portfolio">(fixtureIds.portfolio),
      idempotencyKey: idempotency.value, includedScopes: [...scopeOrder] });
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    const assemblyStarted = performance.now();
    const assemblyPending = assembly.runOwnerExportAssembly({ workerId: "reference-import-full-worker" });
    let readTimeout: ReturnType<typeof setTimeout> | undefined;
    const readOutcome = await Promise.race([
      sourceReadObserved.then(() => ({ kind: "source-read" as const })),
      assemblyPending.then((result) => ({ kind: "assembly-returned" as const, result })),
      new Promise<{ kind: "timeout" }>((resolve) => { readTimeout = setTimeout(() => resolve({ kind: "timeout" }), 15_000); }),
    ]);
    if (readTimeout !== undefined) clearTimeout(readTimeout);
    if (readOutcome.kind !== "source-read") {
      releaseSourceRead?.();
      const persistedBeforeRelease = await workerStore.findOwnerExport({ exportId: request.value.exportId,
        portfolioId: asStableId<"Portfolio">(fixtureIds.portfolio), ownerId: asStableId<"Owner">(fixtureIds.owner) });
      const job = await admin!.query<{ status: string; attempt_count: number; last_error_code: string | null }>(
        `select status, attempt_count, last_error_code from operations.jobs
         where payload->>'exportId'=$1 order by available_at desc limit 1`, [request.value.exportId]);
      let returned: Awaited<typeof assemblyPending> | undefined;
      if (readOutcome.kind === "assembly-returned") returned = readOutcome.result;
      else {
        let returnTimeout: ReturnType<typeof setTimeout> | undefined;
        const finishOutcome = await Promise.race([
          assemblyPending.then((result) => ({ completed: true as const, result })),
          new Promise<{ completed: false }>((resolve) => { returnTimeout = setTimeout(() => resolve({ completed: false }), 15_000); }),
        ]);
        if (returnTimeout !== undefined) clearTimeout(returnTimeout);
        if (finishOutcome.completed) returned = finishOutcome.result;
      }
      metrics.barrier = { reached: false, outcome: readOutcome.kind, exportStatus: persistedBeforeRelease?.status ?? "missing",
        jobStatus: String(job.rows[0]?.status ?? "missing"), attemptCount: Number(job.rows[0]?.attempt_count ?? 0),
        ...(job.rows[0]?.last_error_code === null || job.rows[0]?.last_error_code === undefined ? {} : { jobError: job.rows[0].last_error_code }),
        assemblyCompleted: returned !== undefined,
        ...(returned === undefined ? {} : { claimed: returned.ok ? returned.value.claimed : -1,
          completed: returned.ok ? returned.value.completed : -1, retried: returned.ok ? returned.value.retried : -1,
          failed: returned.ok ? returned.value.failed : -1 }) };
      throw new Error("REFERENCE_IMPORT_SOURCE_READ_BARRIER_NOT_REACHED");
    }
    const activeTransactions = await admin!.query<{ count: number }>(`select count(*)::int as count from pg_stat_activity
      where datname=current_database() and state='idle in transaction' and pid <> pg_backend_pid()`);
    if (Number(activeTransactions.rows[0]?.count ?? 0) !== 0) {
      releaseSourceRead?.();
      throw new Error(`REFERENCE_IMPORT_SOURCE_READ_TRANSACTION_COUNT_${Number(activeTransactions.rows[0]?.count ?? 0)}`);
    }
    expect(Number(activeTransactions.rows[0]?.count ?? 0)).toBe(0);
    metrics.barrier = { ...(metrics.barrier ?? {}), fullPathSourceReadBarrierReached: true,
      noIdleTransactionAtSourceRead: Number(activeTransactions.rows[0]?.count ?? 0) === 0 };
    releaseSourceRead?.();
    const assembled = await assemblyPending;
    metrics.stagesMs["fullAssembly"] = Math.round(performance.now() - assemblyStarted);
    expect(assembled).toMatchObject({ ok: true, value: { claimed: 1, completed: 1, retried: 0, failed: 0 } });
    const download = await service.downloadOwnerExport({ actor, portfolioId: asStableId<"Portfolio">(fixtureIds.portfolio), exportId: request.value.exportId });
    expect(download.ok).toBe(true);
    if (!download.ok) return;
    const archive = await readAll(download.value.content);
    metrics.fullArchiveBytes = archive.byteLength;
    expect(download.value.contentLength).toBe(archive.byteLength);
    const persisted = await workerStore.findOwnerExport({ exportId: request.value.exportId,
      portfolioId: asStableId<"Portfolio">(fixtureIds.portfolio), ownerId: asStableId<"Owner">(fixtureIds.owner) });
    expect(persisted?.status).toBe("ready");
    if (!persisted?.candidateArtifactId) throw new Error("REFERENCE_IMPORT_ARTIFACT_ID_MISSING");
    ownerExportArtifacts.push({ portfolioId: asStableId<"Portfolio">(fixtureIds.portfolio), exportId: request.value.exportId,
      artifactId: persisted.candidateArtifactId });
    const validated = validateOwnerExportZip(archive);
    expect(validated.includedScopes).toEqual(scopeOrder);
    expect(validated.recordCounts).toEqual({ "portfolio-content": 5, taxonomy: 1, "media-metadata": 4,
      "cv-metadata": 1, "moderation-history": 4, "analytics-reports": 1, "portfolio-configuration": 1 });
    const independentFiles = independentlyReadOwnerExportZip(archive);
    const independentManifest = JSON.parse(new TextDecoder().decode(independentFiles.get("manifest.json"))) as {
      entries: Array<{ path: string }>;
    };
    const archivedRecords = independentManifest.entries.map((entry) => {
      const bytes = independentFiles.get(entry.path);
      if (bytes === undefined) throw new Error("REFERENCE_IMPORT_RECORD_ENTRY_MISSING");
      return new TextDecoder().decode(bytes);
    }).join("\n");
    expect(archivedRecords).not.toMatch(/"(?:visitorId|visitorIdentity|sessionId|rawEvent|eventId|subjectId)"\s*:/iu);
    expect(archivedRecords).not.toMatch(/Synthetic expired text must be absent|Expired suppression rationale must be absent/iu);
    metrics.stagesMs["exportDownloadValidate"] = Math.round(performance.now() - startedAt);

    const namespace = uuid(randomUUID());
    const target = createTargetSink(importBucket);
    const fullImportStartedAt = performance.now();
    const imported = await importOwnerExportReference({ archive, database: target.database, objectSink: target.sink, namespace });
    namespaces.add(namespace);
    namespaceOwners.set(namespace, imported.ownerToken);
    metrics.stagesMs["fullImport"] = Math.round(performance.now() - fullImportStartedAt);
    metrics.importedRecords += imported.totalRecords;
    metrics.importedAssets += imported.assetCount;
    metrics.importedAssetBytes += imported.assetBytes;
    const rows = await admin!.query<{ scope: string; identity: string; value: Record<string, unknown> }>(
      `select scope, identity, value from "${namespace}".records order by scope, identity`);
    const byScope = new Map<string, Array<{ identity: string; value: Record<string, unknown> }>>();
    for (const row of rows.rows) byScope.set(row.scope, [...(byScope.get(row.scope) ?? []), { identity: row.identity, value: row.value }]);
    const facts = expectedFacts();
    expect(byScope.get("portfolio-content")?.map((row) => row.identity)).toEqual(facts.contentIds);
    const hidden = byScope.get("portfolio-content")?.find((row) => row.identity === fixtureIds.hiddenProject)?.value;
    const hiddenStatus = hidden?.["projectStatus"] as Record<string, unknown> | null | undefined;
    const hiddenPublications = hidden?.["publications"] as Array<Record<string, unknown>> | undefined;
    const hiddenRoute = hidden?.["publicRoute"] as Record<string, unknown> | null | undefined;
    const hiddenReservations = hiddenRoute?.["reservations"] as Array<Record<string, unknown>> | undefined;
    const hiddenRouteHistory = hidden?.["routeHistory"] as Array<Record<string, unknown>> | undefined;
    const hiddenRouteEvents = hiddenRoute?.["history"] as Array<Record<string, unknown>> | undefined;
    expect((hidden?.["revisions"] as Array<Record<string, unknown>>).map((revision) => ({ revisionId: revision["revisionId"],
      locale: revision["locale"], sequence: revision["sequence"], currentlyPublished: revision["currentlyPublished"] })))
      .toEqual(facts.hiddenProject.revisions);
    expect(hidden).toMatchObject({ lifecycle: "hidden", featured: true, publicRouteIdentity: fixtureIds.route,
      routeHistory: [{ fromSlug: "previous-hidden-project", toSlug: "current-hidden-project" }],
      relatedProjectIds: [fixtureIds.draftProject], publicDiscoveryOrder: { firstPublishedAt: capturedAt, tieBreaker: "content-id-desc" } });
    expect(hiddenStatus).toMatchObject({ label: "Shipped", state: "active" });
    expect(hiddenPublications).toHaveLength(2);
    expect(hiddenPublications).toContainEqual(expect.objectContaining({ locale: "en", revisionId: facts.hiddenProject.publications[0]!.revisionId,
      publicationSequence: 2 }));
    expect(hiddenPublications).toContainEqual(expect.objectContaining({ locale: "ar", revisionId: facts.hiddenProject.publications[1]!.revisionId,
      publicationSequence: 1 }));
    expect(hiddenRoute).toMatchObject({ identity: fixtureIds.route, canonicalSlug: "current-hidden-project" });
    expect(hiddenReservations).toHaveLength(2);
    expect(hiddenReservations).toContainEqual(expect.objectContaining({ slug: "previous-hidden-project", isCurrent: false }));
    expect(hiddenReservations).toContainEqual(expect.objectContaining({ slug: "current-hidden-project", isCurrent: true }));
    expect(hiddenRouteEvents).toContainEqual(expect.objectContaining({ sequence: 1, fromSlug: "previous-hidden-project", toSlug: "current-hidden-project" }));
    expect(byScope.get("portfolio-content")?.find((row) => row.identity === fixtureIds.publishedProject)?.value)
      .toMatchObject({ lifecycle: "published", publicRouteIdentity: fixtureIds.publishedRoute,
        publicDiscoveryOrder: { firstPublishedAt: capturedAt, tieBreaker: "content-id-desc" } });
    expect(byScope.get("portfolio-content")?.find((row) => row.identity === fixtureIds.archivedAchievement)?.value)
      .toMatchObject({ contentType: "achievement", lifecycle: "archived" });
    expect(byScope.get("portfolio-content")?.find((row) => row.identity === fixtureIds.testimonial)?.value)
      .toMatchObject({ contentType: "testimonial", lifecycle: "draft" });
    expect(byScope.get("portfolio-content")?.find((row) => row.identity === fixtureIds.draftProject)?.value)
      .toMatchObject({ contentType: "project", lifecycle: "draft" });
    expect(byScope.get("taxonomy")?.[0]?.value).toMatchObject({ taxonomyId: fixtureIds.taxonomy,
      values: [{ valueId: fixtureIds.mergedValue, state: "merged" }, { valueId: fixtureIds.activeValue, state: "active" }, { valueId: fixtureIds.retiredValue, state: "retired" }],
      evolutionHistory: [{ transitionSequence: 1, action: "created" }, { transitionSequence: 2, action: "renamed" },
        { transitionSequence: 3, action: "merged", mergedIntoValueId: fixtureIds.activeValue }, { transitionSequence: 1, action: "created" },
        { transitionSequence: 1, action: "created" }, { transitionSequence: 2, action: "retired" }],
      assignmentHistory: [{ taxonomyValueId: fixtureIds.mergedValue, sequence: 1, projectVersion: 2 },
        { taxonomyValueId: fixtureIds.activeValue, sequence: 2, projectVersion: 3 }] });
    expect(byScope.get("media-metadata")?.map((row) => row.identity)).toEqual(facts.mediaIds);
    expect(byScope.get("media-metadata")?.find((row) => row.identity === fixtureIds.imageMedia)?.value)
      .toMatchObject({ state: "accepted", publicationState: "published", byteCoverage: "included",
        accessibilityMetadata: { kind: "described-image", altText: "Synthetic accessible image." },
        acceptanceHistory: [{ byteCoverage: "included", variants: [{ byteCoverage: "included" }, { byteCoverage: "included" }] }] });
    expect(byScope.get("media-metadata")?.find((row) => row.identity === fixtureIds.rejectedMedia)?.value)
      .toMatchObject({ state: "rejected", publicationState: "withdrawn", byteCoverage: "excluded", portableAssets: [] });
    const cv = byScope.get("cv-metadata")?.[0]?.value;
    expect(cv).toMatchObject({ currentVersionId: facts.currentCv,
      versions: [{ versionId: facts.currentCv, isCurrent: true }, { versionId: facts.previousCv, isCurrent: false }],
      activationHistory: [{ versionId: facts.currentCv }, { versionId: facts.previousCv }] });
    expect(byScope.get("moderation-history")?.map((row) => row.identity)).toEqual(facts.feedbackIds);
    expect(byScope.get("analytics-reports")?.[0]?.identity).toBe(facts.goalId);
    const moderationValues = byScope.get("moderation-history") ?? [];
    expect(moderationValues.find((row) => row.identity === fixtureIds.approvedFeedback)?.value)
      .toMatchObject({ state: "approved", textDisposition: "retained", authorName: "Synthetic retained name",
        paragraph: "Synthetic retained Feedback text.", decisionHistory: [{ sequence: 1, decision: "approved", reason: "Synthetic lawful approval audit." }] });
    expect(moderationValues.find((row) => row.identity === fixtureIds.rejectedFeedback)?.value)
      .toMatchObject({ state: "rejected", textDisposition: "retained", authorName: "Synthetic rejected name",
        paragraph: "Synthetic rejected Feedback text.", decisionHistory: [{ sequence: 1, decision: "rejected", reason: "Synthetic rejection audit." }] });
    expect(moderationValues.find((row) => row.identity === fixtureIds.pendingFeedback)?.value)
      .toMatchObject({ state: "pending", decisionHistory: [] });
    const erasedFeedback = moderationValues.find((row) => row.identity === fixtureIds.suppressedFeedback)?.value;
    expect(erasedFeedback).toMatchObject({ state: "suppressed", textDisposition: "erased", decisionHistory: [
      { sequence: 1, decision: "approved" }, { sequence: 2, decision: "suppressed" },
    ] });
    expect(erasedFeedback).not.toHaveProperty("authorName");
    expect(erasedFeedback).not.toHaveProperty("paragraph");
    expect((erasedFeedback?.["decisionHistory"] as Array<Record<string, unknown>>).every((item) => !Object.hasOwn(item, "reason"))).toBe(true);
    const analytics = byScope.get("analytics-reports")?.[0]?.value;
    expect(analytics?.["goal"]).toMatchObject({ activeVersionId: fixtureIds.goalV2,
      activationHistory: [{ activationSequence: 1 }, { activationSequence: 2 }] });
    const reports = analytics?.["reports"] as Array<Record<string, unknown>>;
    expect(reports.length).toBeGreaterThan(0);
    expect(reports.every((report) => report["sampleState"] === "low-sample" && report["countDisposition"] === "withheld" && !Object.hasOwn(report, "cells"))).toBe(true);
    expect(byScope.get("portfolio-configuration")?.[0]?.value).toMatchObject({
      profile: { displayName: "Synthetic owner", headline: "Portable fixture" },
      contactChannels: { channels: [{ channel: "email", destination: "mailto:synthetic@example.test" }] },
      projectCta: { label: "Synthetic contact", destination: "https://example.test/contact" },
    });
    const dependencyRows = await admin!.query<{ value: Record<string, unknown> }>(`select value from "${namespace}".dependencies order by ordinal`);
    expect(dependencyRows.rows.length).toBe(validated.dependencyCount);
    expect(JSON.stringify(rows.rows)).not.toMatch(/Synthetic expired name|Synthetic expired text must be absent|Expired suppression rationale must be absent|visitor|session/iu);
    expect((await admin!.query<{ count: number }>(`select count(*)::int as count from "${namespace}".assets`)).rows[0]?.count).toBe(4);
    const declaredAssets = (validated.manifest as unknown as { assets: Array<{ path: string; byteLength: number; digest: string }> }).assets;
    expect(target.written.map((item) => item.path).sort()).toEqual(declaredAssets.map((item) => item.path).sort());
    const storedAssets = await admin!.query<{ path: string; source_path: string; sha256: string; byte_length: number }>(
      `select path, source_path, sha256, byte_length from "${namespace}".assets order by source_path`);
    expect(storedAssets.rows.map((asset) => ({ path: asset.source_path, sha256: asset.sha256, byte_length: asset.byte_length })))
      .toEqual(declaredAssets.map((asset) => ({ path: asset.path, sha256: asset.digest, byte_length: asset.byteLength })));
    const importOutboxBefore = await admin!.query<{ count: number }>("select count(*)::int as count from operations.outbox_events");
    expect(Number(importOutboxBefore.rows[0]?.count ?? 0)).toBeGreaterThan(0);
    for (const asset of declaredAssets) {
      const objectPath = storedAssets.rows.find((stored) => stored.source_path === asset.path)?.path;
      if (objectPath === undefined) throw new Error("REFERENCE_IMPORT_STORED_OBJECT_PATH_MISSING");
      const response = await fetch(storageDownloadUrl(importBucket, `${namespace}/${objectPath}`), { headers: authHeaders() });
      expect(response.ok).toBe(true);
      const restoredBytes = new Uint8Array(await response.arrayBuffer());
      expect(restoredBytes.byteLength).toBe(asset.byteLength);
      expect(createHash("sha256").update(restoredBytes).digest("hex")).toBe(asset.digest);
    }
    const importOutboxAfter = await admin!.query<{ count: number }>("select count(*)::int as count from operations.outbox_events");
    expect(importOutboxAfter.rows[0]?.count).toBe(importOutboxBefore.rows[0]?.count);

    const cleanupStarted = performance.now();
    await cleanupOwnerExportReference({ database: admin!, objectSink: target.sink, namespace, ownerToken: imported.ownerToken });
    namespaces.delete(namespace);
    namespaceOwners.delete(namespace);
    expect(await admin!.query("select 1 from information_schema.schemata where schema_name=$1", [namespace]).then((result) => result.rowCount)).toBe(0);
    metrics.stagesMs["fullImportCleanup"] = Math.round(performance.now() - cleanupStarted);
  }, 120_000);

  it("AC05 reconstructs every single scope, empty selections and representative partial dependency sets", async () => {
    const selections: Array<{ scopes: readonly (typeof scopeOrder)[number][]; emptyContent?: boolean; emptyCv?: boolean }> = [
      ...scopeOrder.map((scope) => ({ scopes: [scope] as const })),
      { scopes: ["portfolio-content"], emptyContent: true },
      { scopes: ["cv-metadata"], emptyCv: true },
      { scopes: ["portfolio-content", "taxonomy"] },
      { scopes: ["media-metadata", "cv-metadata"] },
      { scopes: ["portfolio-content", "moderation-history"] },
      { scopes: ["analytics-reports", "portfolio-configuration"] },
    ];
    const partialStartedAt = performance.now();
    let emptyCount = 0;
    let emptyCvCount = 0;
    const sourceFixture = await seedSourceBackedFixture();
    const sourceSnapshots = sourceSnapshotReader();
    const sourceStorage = createSupabaseMediaExportStorage({ storageUrl: STORAGE_URL!, serviceRoleKey: STORAGE_KEY!,
      candidateBucket, processedBucket });
    const populatedSourceScope = { portfolioId: asStableId<"Portfolio">(fixtureIds.portfolio), ownerId: asStableId<"Owner">(fixtureIds.owner) };
    const emptySourceScope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    const sourceExpectedIds: Record<(typeof scopeOrder)[number], string[]> = {
      "portfolio-content": sourceFixture.contentIds.map(String).sort(), taxonomy: [sourceFixture.taxonomyId],
      "media-metadata": [...sourceFixture.media.map((item) => item.mediaId), sourceFixture.rejectedMediaId].map(String).sort(),
      "cv-metadata": ["aggregate"],
      "moderation-history": [sourceFixture.feedbackId, sourceFixture.approvedFeedbackId, sourceFixture.rejectedFeedbackId,
        sourceFixture.suppressedFeedbackId].map(String).sort(), "analytics-reports": [sourceFixture.goalId],
      "portfolio-configuration": ["aggregate"],
    };
    let partialSourceObjectReads = 0;
    for (const selection of selections) {
      const scopes = scopeOrder.filter((scope) => selection.scopes.includes(scope));
      const sourceScope = selection.emptyContent || selection.emptyCv ? emptySourceScope : populatedSourceScope;
      const captured = await sourceSnapshots.capture({ ...sourceScope, snapshotId: createStableId("OwnerExportArtifact"),
        includedScopes: scopes });
      expect(captured.ok).toBe(true);
      if (!captured.ok) throw new Error("REFERENCE_IMPORT_SOURCE_PARTIAL_CAPTURE_FAILED");
      if (selection.emptyContent) {
        expect(captured.value).toMatchObject({ kind: "owner-export-snapshot-v1", content: { records: [] } });
        metrics.sourceBackedEmptyContentCount += 1;
      }
      if (selection.emptyCv) {
        expect(captured.value).toMatchObject({ kind: "owner-export-snapshot-v1", cv: { currentVersionId: null, versions: [], activationHistory: [] } });
        metrics.sourceBackedEmptyCvCount += 1;
      }
      const exportId = createStableId("OwnerExport");
      const sourceObjects = { async readMediaExportObject(input: Parameters<typeof sourceStorage.readMediaExportObject>[0]) {
        const activeTransactions = await admin!.query<{ count: number }>(`select count(*)::int as count from pg_stat_activity
          where datname=current_database() and state='idle in transaction' and pid <> pg_backend_pid()`);
        expect(Number(activeTransactions.rows[0]?.count ?? 0)).toBe(0);
        partialSourceObjectReads += 1;
        return sourceStorage.readMediaExportObject(input);
      } };
      const built = "kind" in captured.value
        ? await buildSelectedOwnerExportPackage({ exportId, portfolioId: sourceScope.portfolioId,
          snapshot: captured.value, objects: sourceObjects })
        : await buildConfigurationOwnerExportPackage({ exportId, snapshot: captured.value });
      const archive = await readAll(built.content);
      const checked = validateOwnerExportZip(archive);
      expect(checked.includedScopes).toEqual(scopes);
      const namespace = uuid(randomUUID());
      namespaces.add(namespace);
      const target = createTargetSink(importBucket);
      const imported = await importOwnerExportReference({ archive, database: target.database, objectSink: target.sink, namespace });
      namespaceOwners.set(namespace, imported.ownerToken);
      metrics.sourceBackedPartialScenarioCount += 1;
      metrics.sourceBackedPartialArchiveBytes += archive.byteLength;
      expect(imported.includedScopes).toEqual(scopes);
      expect(Object.keys(imported.recordCounts)).toEqual(scopes);
      const rows = await admin!.query<{ scope: string; identity: string; value: Record<string, unknown> }>(
        `select scope,identity,value from "${namespace}".records order by scope,identity`);
      for (const selectedScope of scopes) {
        const expected = selection.emptyContent && selectedScope === "portfolio-content" ? [] :
          sourceExpectedIds[selectedScope];
        const actual = rows.rows.filter((row) => row.scope === selectedScope).map((row) => row.identity);
        if (selectedScope === "taxonomy") {
          expect(actual).toContain(sourceFixture.taxonomyId);
          expect(new Set(actual).size).toBe(actual.length);
          continue;
        }
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(`REFERENCE_IMPORT_PARTIAL_IDENTITY_MISMATCH_${selectedScope}_${actual.length}_${expected.length}`);
        }
        expect(actual).toEqual(expected);
      }
      expect(rows.rows.every((row) => scopes.includes(row.scope as (typeof scopeOrder)[number]))).toBe(true);
      const external = await admin!.query<{ count: number }>(`select count(*)::int as count from "${namespace}".external_dependencies`);
      if (scopes.includes("taxonomy") && !scopes.includes("portfolio-content")) {
        expect(Number(external.rows[0]?.count ?? 0)).toBeGreaterThan(0);
      }
      if (selection.emptyCv) {
        const projection = await admin!.query<{ value: Record<string, unknown> }>(
          `select value from "${namespace}".reference_model where kind='cv-portfolio' and identity='aggregate'`);
        expect(projection.rows[0]?.value).toMatchObject({ currentVersionId: null, versions: [], activationHistory: [] });
      }
      const declaredAssets = (checked.manifest as unknown as { assets: Array<{ path: string; digest: string; byteLength: number }> }).assets;
      for (const asset of declaredAssets) {
        const stored = await admin!.query<{ path: string; sha256: string; byte_length: number }>(
          `select path,sha256,byte_length from "${namespace}".assets where source_path=$1`, [asset.path]);
        expect(stored.rows).toHaveLength(1);
        expect(stored.rows[0]).toMatchObject({ sha256: asset.digest, byte_length: asset.byteLength });
        const body = await fetch(storageDownloadUrl(importBucket, `${namespace}/${stored.rows[0]!.path}`), { headers: authHeaders() });
        expect(body.ok).toBe(true);
        const bytes = new Uint8Array(await body.arrayBuffer());
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.digest);
      }
      await cleanupOwnerExportReference({ database: admin!, objectSink: target.sink, namespace, ownerToken: imported.ownerToken });
      namespaces.delete(namespace);
      namespaceOwners.delete(namespace);
    }
    metrics.sourceBackedPartialSourceObjectReads = partialSourceObjectReads;
    for (const selection of selections) {
      const scopes = scopeOrder.filter((scope) => selection.scopes.includes(scope));
      let snapshot = await snapshotFor(scopes, createStableId("OwnerExportArtifact"));
      if (selection.emptyContent) {
        snapshot = { ...snapshot, content: { records: [] } };
        emptyCount += 1;
      }
      if (selection.emptyCv) {
        if (snapshot.cv === undefined) throw new Error("REFERENCE_IMPORT_CV_FIXTURE_MISSING");
        snapshot = { ...snapshot, cv: { ...snapshot.cv, currentVersionId: null, versions: [], acceptanceHistory: [], activationHistory: [] }, cvAssets: [] };
        emptyCvCount += 1;
      }
      const built = await buildSelectedOwnerExportPackage({ exportId: createStableId("OwnerExport"),
        portfolioId: asStableId<"Portfolio">(fixtureIds.portfolio), snapshot, objects: objectReader });
      const archive = await readAll(built.content);
      const checked = validateOwnerExportZip(archive);
      expect(checked.includedScopes).toEqual(scopes);
      const namespace = uuid(randomUUID());
      namespaces.add(namespace);
      const target = createTargetSink(importBucket);
      let imported: Awaited<ReturnType<typeof importOwnerExportReference>>;
      try { imported = await importOwnerExportReference({ archive, database: target.database, objectSink: target.sink, namespace }); }
      catch (error) {
        const safe = error && typeof error === "object" ? error as { code?: unknown; stage?: unknown; causeCode?: unknown } : {};
        const code = String(safe.code ?? "UNKNOWN").replace(/[^A-Z0-9_]/giu, "_");
        const stage = String(safe.stage ?? "UNKNOWN").replace(/[^A-Z0-9_]/giu, "_");
        const cause = String(safe.causeCode ?? "UNKNOWN").replace(/[^A-Z0-9_]/giu, "_");
        throw new Error(`REFERENCE_IMPORT_PARTIAL_DIAGNOSTIC_${code}_${stage}_${cause}`);
      }
      namespaceOwners.set(namespace, imported.ownerToken);
      metrics.partialScenarioCount += 1;
      metrics.partialArchiveBytes += archive.byteLength;
      metrics.importedRecords += imported.totalRecords;
      metrics.importedAssets += imported.assetCount;
      metrics.importedAssetBytes += imported.assetBytes;
      expect(imported.includedScopes).toEqual(scopes);
      expect(imported.recordCounts).toEqual(checked.recordCounts);
      expect(Object.keys(imported.recordCounts)).toEqual(scopes);
      const entries = await admin!.query<{ scope: string; identity: string; value: Record<string, unknown> }>(
        `select scope, identity, value from "${namespace}".records order by scope, identity`);
      const facts = expectedFacts();
      const expectedIdentities: Record<(typeof scopeOrder)[number], string[]> = {
        "portfolio-content": selection.emptyContent ? [] : [...facts.contentIds],
        taxonomy: [fixtureIds.taxonomy], "media-metadata": [...facts.mediaIds], "cv-metadata": ["aggregate"],
        "moderation-history": [...facts.feedbackIds], "analytics-reports": [facts.goalId], "portfolio-configuration": ["aggregate"],
      };
      for (const scope of scopes) {
        expect(entries.rows.filter((row) => row.scope === scope).map((row) => row.identity)).toEqual(expectedIdentities[scope]);
      }
      expect(entries.rows.every((row) => scopes.includes(row.scope as (typeof scopeOrder)[number]))).toBe(true);
      expect(Object.keys(imported.recordCounts).some((scope) => !scopes.includes(scope as (typeof scopeOrder)[number]))).toBe(false);
      const partialByScope = new Map<string, Array<{ identity: string; value: Record<string, unknown> }>>();
      for (const row of entries.rows) partialByScope.set(row.scope, [...(partialByScope.get(row.scope) ?? []), { identity: row.identity, value: row.value }]);
      if (scopes.includes("portfolio-content") && !selection.emptyContent) {
        expect(partialByScope.get("portfolio-content")?.find((row) => row.identity === fixtureIds.hiddenProject)?.value)
          .toMatchObject({ lifecycle: "hidden", featured: true, publicRouteIdentity: fixtureIds.route });
      }
      if (scopes.includes("taxonomy")) expect(partialByScope.get("taxonomy")?.[0]?.value)
        .toMatchObject({ taxonomyId: fixtureIds.taxonomy,
          values: [{ valueId: fixtureIds.mergedValue, state: "merged" }, { valueId: fixtureIds.activeValue, state: "active" },
            { valueId: fixtureIds.retiredValue, state: "retired" }] });
      if (scopes.includes("media-metadata")) expect(partialByScope.get("media-metadata")?.find((row) => row.identity === fixtureIds.rejectedMedia)?.value)
        .toMatchObject({ state: "rejected", publicationState: "withdrawn", byteCoverage: "excluded" });
      if (scopes.includes("cv-metadata")) {
        if (selection.emptyCv) expect(partialByScope.get("cv-metadata")?.[0]?.value)
          .toMatchObject({ currentVersionId: null, versions: [], activationHistory: [] });
        else expect(partialByScope.get("cv-metadata")?.[0]?.value)
          .toMatchObject({ currentVersionId: facts.currentCv, versions: [{ versionId: facts.currentCv, isCurrent: true }, { versionId: facts.previousCv, isCurrent: false }] });
      }
      if (scopes.includes("moderation-history")) expect(partialByScope.get("moderation-history")?.find((row) => row.identity === fixtureIds.suppressedFeedback)?.value)
        .toMatchObject({ state: "suppressed", textDisposition: "erased" });
      if (scopes.includes("analytics-reports")) expect(partialByScope.get("analytics-reports")?.[0]?.value)
        .toMatchObject({ goal: { activeVersionId: fixtureIds.goalV2, activationHistory: [{ activationSequence: 1 }, { activationSequence: 2 }] } });
      if (scopes.includes("portfolio-configuration")) expect(partialByScope.get("portfolio-configuration")?.[0]?.value)
        .toMatchObject({ profile: { displayName: "Synthetic owner" } });
      const dependencyRows = await admin!.query<{ value: Record<string, unknown> }>(`select value from "${namespace}".dependencies order by ordinal`);
      expect(dependencyRows.rows.map((row) => row.value)).toEqual((checked.manifest as unknown as { dependencies: unknown[] }).dependencies);
      expect(dependencyRows.rows).toHaveLength(checked.dependencyCount);
      await cleanupOwnerExportReference({ database: admin!, objectSink: target.sink, namespace, ownerToken: imported.ownerToken });
      namespaces.delete(namespace);
      namespaceOwners.delete(namespace);
    }
    expect(emptyCount).toBe(1);
    expect(emptyCvCount).toBe(1);
    metrics.absentCvScenarioCount = emptyCvCount;
    metrics.stagesMs["partialReconstruction"] = Math.round(performance.now() - partialStartedAt);
  }, 120_000);

  it("AC07 pauses at object reads and target writes to verify PostgreSQL has no open import transaction", async () => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const observed = new Promise<void>((resolve) => { entered = resolve; });
    const blockedSink = createTargetSink(importBucket);
    const delegate = blockedSink.sink;
    let blocked = false;
    const sink = { ...delegate, async put(input: Parameters<typeof delegate.put>[0]) {
      if (!blocked) { blocked = true; entered?.(); await barrier; }
      await delegate.put(input);
    } };
    const snapshot = await snapshotFor(["media-metadata"], createStableId("OwnerExportArtifact"));
    const built = await buildSelectedOwnerExportPackage({ exportId: createStableId("OwnerExport"),
      portfolioId: asStableId<"Portfolio">(fixtureIds.portfolio), snapshot, objects: objectReader });
    const archive = await readAll(built.content);
    const namespace = uuid(randomUUID());
    namespaces.add(namespace);
    const pending = importOwnerExportReference({ archive, database: blockedSink.database, objectSink: sink, namespace });
    await observed;
    const activity = await admin!.query<{ count: number }>(`select count(*)::int as count from pg_stat_activity
      where datname=current_database() and state='idle in transaction' and pid <> pg_backend_pid()`);
    if (Number(activity.rows[0]?.count ?? 0) !== 0) {
      release?.();
      throw new Error(`REFERENCE_IMPORT_TARGET_WRITE_TRANSACTION_COUNT_${Number(activity.rows[0]?.count ?? 0)}`);
    }
    expect(Number(activity.rows[0]?.count ?? 0)).toBe(0);
    release?.();
    const imported = await pending;
    metrics.barrier = { ...(metrics.barrier ?? {}), targetWriteBarrierReached: true,
      noIdleTransactionAtTargetWrite: Number(activity.rows[0]?.count ?? 0) === 0 };
    namespaceOwners.set(namespace, imported.ownerToken);
    expect(imported.assetCount).toBeGreaterThan(0);
    await cleanupOwnerExportReference({ database: admin!, objectSink: delegate, namespace, ownerToken: imported.ownerToken });
    namespaces.delete(namespace);
    namespaceOwners.delete(namespace);
  }, 30_000);

  it("reports real PostgreSQL failure after private Storage upload and removes only invocation-owned objects", async () => {
    const snapshot = await snapshotFor(["media-metadata"], createStableId("OwnerExportArtifact"));
    const built = await buildSelectedOwnerExportPackage({ exportId: createStableId("OwnerExport"),
      portfolioId: asStableId<"Portfolio">(fixtureIds.portfolio), snapshot, objects: objectReader });
    const archive = await readAll(built.content);
    const namespace = uuid(randomUUID());
    const sentinelPath = `${namespace}/imports/preexisting-sentinel-${randomUUID()}.bin`;
    const sentinelBytes = new TextEncoder().encode("synthetic foreign object survives importer failure");
    const sentinelUpload = await fetch(storageObjectUrl(importBucket, sentinelPath), {
      method: "POST", headers: { ...authHeaders(), "content-type": "application/octet-stream",
        "content-length": String(sentinelBytes.byteLength), "x-upsert": "false" },
      body: Buffer.from(sentinelBytes) as unknown as BodyInit,
    });
    if (!sentinelUpload.ok) throw new Error("REFERENCE_IMPORT_FAILURE_SENTINEL_SEED_FAILED");

    const target = createTargetSink(importBucket);
    let injected = false;
    const failingDatabase: QueryClient = {
      async query(sql: string, parameters?: readonly unknown[]) {
        if (!injected && sql === `insert into "${namespace}".records(scope, identity, value) values ($1,$2,$3::jsonb)`) {
          injected = true;
          throw Object.assign(new Error("synthetic reference database constraint failure"), { code: "23514" });
        }
        return target.database.query(sql, parameters);
      },
    };

    let failure: unknown;
    let sentinelPreserved = false;
    let primaryFailure: unknown;
    let primaryFailed = false;
    try {
      try { await importOwnerExportReference({ archive, database: failingDatabase, objectSink: target.sink, namespace }); }
      catch (error) { failure = error; }
      expect(injected).toBe(true);
      expect(target.written.length).toBeGreaterThan(0);
      expect(failure).toMatchObject({ code: "REFERENCE_IMPORT_FAILED", stage: "reference-write",
        cause: { message: "REFERENCE_IMPORT_CAUSE_REDACTED" } });
      expect(JSON.stringify(failure)).not.toMatch(/synthetic reference database constraint failure|23514/iu);
      const schema = await admin!.query<{ namespace: string | null }>("select to_regnamespace($1)::text as namespace", [namespace]);
      expect(schema.rows[0]?.namespace).toBeNull();
      for (const object of target.written) {
        const response = await fetch(storageDownloadUrl(importBucket, object.path), { headers: authHeaders() });
        expect(response.ok).toBe(false);
      }
      const sentinelRead = await fetch(storageDownloadUrl(importBucket, sentinelPath), { headers: authHeaders() });
      sentinelPreserved = sentinelRead.ok && Buffer.compare(Buffer.from(await sentinelRead.arrayBuffer()), Buffer.from(sentinelBytes)) === 0;
      expect(sentinelPreserved).toBe(true);
    } catch (error) {
      primaryFailed = true;
      primaryFailure = error;
    }
    let cleanupFailure: Error | undefined;
    try {
      const sentinelDelete = await fetch(new URL(`/storage/v1/object/${encodeURIComponent(importBucket)}`, STORAGE_URL), {
        method: "DELETE", headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ prefixes: [sentinelPath] }),
      });
      if (!sentinelDelete.ok) cleanupFailure = new Error("REFERENCE_IMPORT_FAILURE_SENTINEL_CLEANUP_FAILED");
    } catch {
      cleanupFailure = new Error("REFERENCE_IMPORT_FAILURE_SENTINEL_CLEANUP_FAILED");
    }
    if (primaryFailed && cleanupFailure !== undefined) throw new AggregateError([primaryFailure, cleanupFailure], "REFERENCE_IMPORT_TEST_AND_CLEANUP_FAILED");
    if (cleanupFailure !== undefined) throw cleanupFailure;
    if (primaryFailed) throw primaryFailure;
  }, 30_000);

  it("recovers an ambiguous private Storage upload through its pre-upload ledger after a cleanup outage", async () => {
    const archive = await packageFor(["media-metadata"]);
    const namespace = uuid(randomUUID());
    namespaces.add(namespace);
    const sentinelPath = `${namespace}/foreign-sentinel`;
    const sentinelBytes = new TextEncoder().encode("foreign survives ownership retry");
    const sentinelUpload = await fetch(storageObjectUrl(importBucket, sentinelPath), {
      method: "POST", headers: { ...authHeaders(), "content-type": "application/octet-stream",
        "content-length": String(sentinelBytes.byteLength), "x-upsert": "false" },
      body: Buffer.from(sentinelBytes) as unknown as BodyInit,
    });
    if (!sentinelUpload.ok) throw new Error("REFERENCE_IMPORT_RESPONSE_LOSS_SENTINEL_SEED_FAILED");
    const target = createTargetSink(importBucket);
    let lostResponse = false;
    let cleanupOutage = true;
    const objectSink = {
      ...target.sink,
      async put(input: Parameters<typeof target.sink.put>[0]) {
        await target.sink.put(input);
        if (!lostResponse) { lostResponse = true; throw new Error("synthetic remote upload response loss"); }
      },
      async removeObjects(ownerNamespace: string, paths: string[], ownerToken: string) {
        if (cleanupOutage) { cleanupOutage = false; throw new Error("synthetic Storage cleanup outage"); }
        await target.sink.removeObjects(ownerNamespace, paths, ownerToken);
      },
    };
    let failure: (Error & { code?: string; namespace?: string; ownerToken?: string }) | undefined;
    let primaryFailure: unknown;
    let primaryFailed = false;
    try {
      try { await importOwnerExportReference({ archive, database: target.database, objectSink, namespace }); }
      catch (error) { failure = error as typeof failure; }
      expect(failure).toMatchObject({ code: "REFERENCE_IMPORT_CLEANUP_FAILED", namespace });
      expect(failure?.ownerToken).toMatch(/^[0-9a-f-]{36}$/iu);
      expect(lostResponse).toBe(true);
      const intent = await admin!.query<{ path: string; source_path: string; sha256: string }>(
        `select path,source_path,sha256 from "${namespace}".owned_objects order by path`);
      expect(intent.rows).toHaveLength(1);
      const ownedPath = intent.rows[0]!.path;
      const fullPath = `${namespace}/${ownedPath}`;
      const encoded = [importBucket, ...fullPath.split("/")].map((part) => encodeURIComponent(part)).join("/");
      const metadataResponse = await fetch(new URL(`/storage/v1/object/info/${encoded}`, STORAGE_URL), { headers: authHeaders() });
      expect(metadataResponse.ok).toBe(true);
      const metadata = await metadataResponse.json() as { metadata?: Record<string, unknown> };
      expect(metadata.metadata?.["referenceImportOwnerToken"]).toBe(failure!.ownerToken);
      const objectBody = await fetch(storageDownloadUrl(importBucket, fullPath), { headers: authHeaders() });
      expect(objectBody.ok).toBe(true);
      expect(createHash("sha256").update(Buffer.from(await objectBody.arrayBuffer())).digest("hex")).toBe(intent.rows[0]!.sha256);

      await cleanupOwnerExportReference({ database: admin!, objectSink, namespace, ownerToken: failure!.ownerToken! });
      const removedBody = await fetch(storageDownloadUrl(importBucket, fullPath), { headers: authHeaders() });
      expect(removedBody.ok).toBe(false);
      const sentinelRead = await fetch(storageDownloadUrl(importBucket, sentinelPath), { headers: authHeaders() });
      expect(sentinelRead.ok).toBe(true);
      expect(Buffer.compare(Buffer.from(await sentinelRead.arrayBuffer()), Buffer.from(sentinelBytes))).toBe(0);
      await expect(cleanupOwnerExportReference({ database: admin!, objectSink, namespace, ownerToken: failure!.ownerToken! }))
        .resolves.toMatchObject({ alreadyClean: true });
      namespaces.delete(namespace);
    } catch (error) {
      primaryFailed = true;
      primaryFailure = error;
    }
    let cleanupFailure: Error | undefined;
    try {
      const sentinelDelete = await fetch(new URL(`/storage/v1/object/${encodeURIComponent(importBucket)}`, STORAGE_URL), {
        method: "DELETE", headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ prefixes: [sentinelPath] }),
      });
      if (!sentinelDelete.ok) cleanupFailure = new Error("REFERENCE_IMPORT_RESPONSE_LOSS_SENTINEL_CLEANUP_FAILED");
    } catch {
      cleanupFailure = new Error("REFERENCE_IMPORT_RESPONSE_LOSS_SENTINEL_CLEANUP_FAILED");
    }
    if (primaryFailed && cleanupFailure !== undefined) throw new AggregateError([primaryFailure, cleanupFailure], "REFERENCE_IMPORT_TEST_AND_CLEANUP_FAILED");
    if (cleanupFailure !== undefined) throw cleanupFailure;
    if (primaryFailed) throw primaryFailure;
  }, 30_000);
});

export { metrics as ownerExportReferenceImportMetrics };
