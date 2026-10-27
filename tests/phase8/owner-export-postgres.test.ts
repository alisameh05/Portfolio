/**
 * owner-export-postgres.test.ts — Phase 8 #240 disposable-cluster acceptance.
 *
 * Runs only under the #240 evidence runner, which provisions restricted
 * runtime roles against a fresh disposable PostgreSQL cluster and bound the
 * exact current schema: `PHASE8_OWNER_EXPORT_APPLICATION_URL` (application
 * runtime role), `PHASE8_OWNER_EXPORT_WORKER_URL` (worker runtime role), and
 * `PHASE8_OWNER_EXPORT_ADMIN_URL` (administration probe role).
 *
 * Acceptance:
 * - AC03: exact concurrent requests through two independent connections commit
 *   exactly one receipt, one export row, and one assembly job; both callers
 *   replay the original receipt.
 * - AC04: exact retries replay the ORIGINAL requested receipt after building,
 *   ready, failed, and expired settlements; changed meaning under the same
 *   key conflicts without durable effects.
 * - AC05: a forced reservation failure rolls back with no idempotency record,
 *   export row, or job residue, and the idempotency key is reusable.
 * - AC06: cross-owner and cross-portfolio reads answer uniform not_found
 *   against a synthesized unknown export, never revealing protected existence.
 * - AC07: truthful five-state metadata with guarded transitions — stale and
 *   impossible attempts never win; later workers slice their own completion.
 * - AC08: uppercase persistence failure codes map explicitly to lowercase
 *   transport codes at the read boundary.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { sql } from "kysely";

import { createPostgresOwnerExportStore } from "../../src/modules/portability-operations/adapters/postgres-owner-export-store.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import {
  applyGuardedOwnerExportTransition,
  createOwnerExportAssemblyService,
  createOwnerExportService,
  parseSafeErrorCode,
  type OwnerExportPackageManifest,
  type OwnerExportObjectReadPort,
  type OwnerExportStorePort,
  type OwnerExportTransitionInput,
} from "../../src/modules/portability-operations/index.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createPostgresContentAuthoringRepository } from "../../src/modules/content-publishing/adapters/postgres-authoring.js";
import { createOwnerExportArtifactCleanupService } from "../../src/modules/portability-operations/application/owner-export-cleanup.js";
import { createPortfolioConfigurationExportSnapshotReader } from "../../src/modules/portfolio-configuration/index.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createSystemIdGenerator, type StableIdGenerator } from "../../src/runtime/ports.js";
import { createStableId, parseIdempotencyKey, parseStableId, type OwnerActor, type StableId } from "../../src/shared/domain/index.js";
import { createOwnerExportConfigurationSnapshotReader } from "../../src/runtime/adapters/owner-export-configuration-snapshot.js";
import { createOwnerExportSnapshotReader } from "../../src/runtime/adapters/owner-export-snapshot.js";
import { createSupabaseOwnerExportStorage } from "../../src/runtime/adapters/supabase-owner-export-storage.js";
import { createPostgresOwnerMediaExportSnapshotReader } from "../../src/modules/media/adapters/postgres-owner-export-snapshot.js";
import { createPostgresFeedbackOwnerExportSnapshotReader } from "../../src/modules/interaction-moderation/adapters/postgres-owner-export.js";
import type { PortfolioSettings } from "../../src/modules/portfolio-configuration/domain/index.js";
import type { OwnerExportConfigurationSnapshot, OwnerExportMediaObjectReaderPort } from "../../src/modules/portability-operations/application/owner-export-package.js";
import { validateOwnerExportZip } from "../../scripts/owner-export/validator.mjs";

const APPLICATION_URL = process.env["PHASE8_OWNER_EXPORT_APPLICATION_URL"];
const WORKER_URL = process.env["PHASE8_OWNER_EXPORT_WORKER_URL"];
const ADMIN_URL = process.env["PHASE8_OWNER_EXPORT_ADMIN_URL"];
const APPLICATION_RUNTIME_ROLE = "owner_export_application_runtime";

const portfolioId = createStableId("Portfolio");
const ownerId = createStableId("Owner");
const actor: OwnerActor = { kind: "owner", ownerId, sessionId: "phase8-owner-export-test-session" };
const FOREIGN_OWNER_ID = createStableId("Owner");
const FOREIGN_PORTFOLIO_ID = createStableId("Portfolio");
const mediaHistoryScope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
const mediaReadyScope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
const TEST_OWNER_IDS = [ownerId, FOREIGN_OWNER_ID, mediaHistoryScope.ownerId, mediaReadyScope.ownerId];
const OPERATION_SCOPE = `portability.owner-export-request:${portfolioId}`;
let now = "2030-10-23T09:00:00.000Z";
const advance = () => {
  const next = new Date(Date.parse(now) + 1_000);
  now = next.toISOString();
  return now;
};

function key(value: string) {
  const parsed = parseIdempotencyKey(value);
  if (!parsed.ok) throw new Error("PHASE8_OWNER_EXPORT_KEY_INVALID");
  return parsed.value;
}

let admin: Client | undefined;
let application: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
let otherApplication: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
let worker: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;

function composeService(
  database: ReturnType<typeof createPostgresRuntimeDatabase>,
  overrides: { store?: OwnerExportStorePort; objectRead?: OwnerExportObjectReadPort } = {},
) {
  const operations = createPostgresOperationsPersistence(database.database, { now: () => now });
  const store = createPostgresOwnerExportStore(database.database, { outbox: operations.outbox });
  const ids: StableIdGenerator = createSystemIdGenerator();
  const service = createOwnerExportService({
    operations,
    exports: overrides.store ?? store,
    clock: { now: () => now },
    ids,
    ...(overrides.objectRead === undefined ? {} : { objectRead: overrides.objectRead }),
  });
  return { service, operations, store, ids };
}

function command(includedScopes: readonly string[], idempotencyKey: string) {
  return {
    actor,
    portfolioId,
    idempotencyKey: key(idempotencyKey),
    includedScopes: [...includedScopes] as never,
  };
}

async function countRows(statement: string, parameters: readonly unknown[] = []): Promise<number> {
  const result = (await admin!.query(statement, [...parameters])) as { rows: Array<Record<string, unknown>> };
  return Number(result.rows[0]?.["count"]);
}

async function ownerExportCount(): Promise<number> {
  return countRows("select count(*)::int as count from portability.owner_exports where owner_id = $1", [ownerId]);
}

async function assemblyJobCount(): Promise<number> {
  return countRows("select count(*)::int as count from operations.jobs where job_type = 'portability.owner-export-assembly.v1'");
}

async function receiptCount(): Promise<number> {
  return countRows("select count(*)::int as count from operations.idempotency_records where operation_scope = $1", [OPERATION_SCOPE]);
}

async function receiptCountForKey(idempotencyKey: string): Promise<number> {
  const keyHash = createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
  return countRows(
    "select count(*)::int as count from operations.idempotency_records where operation_scope = $1 and key_hash = $2",
    [OPERATION_SCOPE, keyHash],
  );
}

function manifestFor(
  scope: "portfolio-content" | "taxonomy" | "cv-metadata",
  exportId: StableId<"OwnerExport">,
  snapshotId: StableId<"OwnerExportArtifact">,
): OwnerExportPackageManifest {
  const requiredFeatures = ["asset-integrity-v1", "dependency-coverage-v1", "record-integrity-v1", "schema-integrity-v1", "snapshot-identity-v1"] as const;
  const exclusions = ["raw-public-event-data", "functional-visitor-identities", "measurement-visitor-identities", "sessions", "credentials", "lab-entries"] as const;
  const recordSchema = `urn:shipwithali:owner-export-schema:${scope}:1.1`;
  const entry = {
    path: `records/${scope}.ndjson`,
    scope,
    mediaType: "application/x-ndjson" as const,
    recordSchema,
    schemaPath: `schemas/${scope}.schema.json`,
    schemaVersion: "1.1" as const,
    digest: "b".repeat(64),
    recordCount: 0,
  };
  return {
    packageFormat: "shipwithali-owner-export",
    schemaVersion: "1.2",
    exportId,
    snapshot: { snapshotId, capturedAt: now, consistency: "transactional" },
    createdAt: now,
    algorithm: "sha-256",
    digest: "a".repeat(64),
    includedScopes: [scope] as never,
    publicEventDataCoverage: { mode: "excluded" } as never,
    requiredFeatures,
    dependencies: [],
    exclusions,
    entries: [entry],
    schemas: [
      { kind: "manifest", path: "schemas/manifest.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:manifest:1.1", schemaVersion: "1.1", digest: "c".repeat(64) },
      { kind: "record", path: `schemas/${scope}.schema.json`, scope, schemaUri: recordSchema, schemaVersion: "1.1", digest: "d".repeat(64) },
    ],
    assets: [],
  } as never as OwnerExportPackageManifest;
}

function transitionInput(
  exportId: StableId<"OwnerExport">,
  fromStatus: OwnerExportTransitionInput["fromStatus"],
  toStatus: OwnerExportTransitionInput["toStatus"],
  expectedAggregateVersion: number,
  at: string,
  metadata: Partial<Pick<OwnerExportTransitionInput, "failureCode" | "integrityManifest" | "artifactId" | "leaseToken" | "actingJobId">> = {},
): OwnerExportTransitionInput {
  return {
    exportId,
    fromStatus,
    toStatus,
    expectedAggregateVersion,
    transitionedAt: at,
    actingJobId: createStableId("Job"),
    ...metadata,
  };
}

async function leaseExportJob(exportId: StableId<"OwnerExport">): Promise<{ readonly jobId: StableId<"Job">; readonly leaseToken: string }> {
  const leaseToken = randomUUID();
  const leased = await admin!.query(
    `update operations.jobs
        set status = 'leased', lease_owner = 'phase8-test-worker', lease_token = $1,
            lease_expires_at = clock_timestamp() + interval '5 minutes'
      where job_id = (select job_id from operations.jobs
                       where job_type = 'portability.owner-export-assembly.v1'
                         and payload->>'exportId' = $2
                       order by job_id limit 1)
        and status = 'available'
      returning job_id::text as job_id`,
    [leaseToken, exportId],
  );
  if (leased.rowCount !== 1) throw new Error("PHASE8_OWNER_EXPORT_TEST_JOB_LEASE_FAILED");
  const parsedJobId = parseStableId("Job", String(leased.rows[0]?.job_id));
  if (!parsedJobId.ok) throw new Error("PHASE8_OWNER_EXPORT_TEST_JOB_ID_INVALID");
  return { jobId: parsedJobId.value, leaseToken };
}

async function leaseUnboundAssemblyJob(): Promise<{ readonly jobId: StableId<"Job">; readonly leaseToken: string }> {
  const jobId = createStableId("Job");
  const leaseToken = randomUUID();
  const payload = JSON.stringify({
    exportId: createStableId("OwnerExport"),
    portfolioId,
    ownerId,
    includedScopes: ["taxonomy"],
  });
  await admin!.query(
    `insert into operations.jobs (
       job_id, job_type, payload_version, payload, available_at, status,
       lease_owner, lease_token, lease_expires_at
     ) values (
       $1, 'portability.owner-export-assembly.v1', 1, $2::jsonb, clock_timestamp(), 'leased',
       'phase8-unrelated-worker', $3, clock_timestamp() + interval '5 minutes'
     )`,
    [jobId, payload, leaseToken],
  );
  return { jobId, leaseToken };
}

async function checkpointTestArtifact(
  store: OwnerExportStorePort,
  exportId: StableId<"OwnerExport">,
  lease: { readonly jobId: StableId<"Job">; readonly leaseToken: string },
): Promise<{ readonly artifactId: StableId<"OwnerExportArtifact">; readonly snapshotId: StableId<"OwnerExportArtifact"> }> {
  const snapshotId = createStableId("OwnerExportArtifact");
  const snapshot: OwnerExportConfigurationSnapshot = {
    snapshotId,
    capturedAt: now,
    configurationVersion: null,
    settings: null,
    capabilities: { currentCvAvailable: false, externalLinksAvailable: false, globalProjectCtaAvailable: false },
  };
  const savedSnapshot = await store.saveOwnerExportSnapshot({
    exportId,
    actingJobId: lease.jobId,
    leaseToken: lease.leaseToken,
    snapshot,
  });
  if (!savedSnapshot.ok || savedSnapshot.value !== "saved") throw new Error("PHASE8_OWNER_EXPORT_TEST_SNAPSHOT_CHECKPOINT_FAILED");
  const artifactId = createStableId("OwnerExportArtifact");
  const savedCandidate = await store.saveOwnerExportCandidate({
    exportId,
    actingJobId: lease.jobId,
    leaseToken: lease.leaseToken,
    artifactId,
    sha256: "e".repeat(64),
    contentLength: 1,
  });
  if (!savedCandidate.ok || savedCandidate.value !== "saved") throw new Error("PHASE8_OWNER_EXPORT_TEST_CANDIDATE_CHECKPOINT_FAILED");
  return { artifactId, snapshotId };
}

async function makeAssemblyJobDue(exportId: StableId<"OwnerExport">): Promise<void> {
  // Policy fixtures use a fixed future clock; cross the database not-before boundary explicitly before work is due.
  await admin!.query(
    `update operations.jobs
        set available_at = clock_timestamp() - interval '1 second'
      where job_type = 'portability.owner-export-assembly.v1'
        and payload->>'exportId' = $1
        and status = 'available'`,
    [exportId],
  );
}

async function readAll(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let length = 0;
  for await (const part of content) {
    parts.push(part);
    length += part.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

async function startIsolatedObjectStorage(): Promise<{
  readonly server: Server;
  readonly baseUrl: string;
  readonly objects: Map<string, Uint8Array>;
  readonly requests: string[];
}> {
  const objects = new Map<string, Uint8Array>();
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(`${request.method ?? "GET"} ${path}`);
    if (request.headers["apikey"] !== "phase8-isolated-storage-key" ||
        request.headers["authorization"] !== "Bearer phase8-isolated-storage-key") {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "DELETE" && path === "/storage/v1/object/owner-exports") {
      const parts: Buffer[] = [];
      for await (const part of request) parts.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(parts).toString("utf8")) as { prefixes: string[] };
      for (const prefix of body.prefixes) objects.delete(`${path}/${prefix}`);
      response.writeHead(200, { "content-type": "application/json" }).end("[]");
      return;
    }
    if (request.method === "POST") {
      if (request.headers["x-upsert"] !== "false" ||
          request.headers["content-type"] !== "application/vnd.shipwithali.owner-export+zip") {
        response.writeHead(400).end();
        return;
      }
      if (objects.has(path)) {
        response.writeHead(409).end();
        return;
      }
      const parts: Uint8Array[] = [];
      for await (const part of request) parts.push(new Uint8Array(part));
      const length = parts.reduce((total, part) => total + part.byteLength, 0);
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      objects.set(path, bytes);
      response.writeHead(200).end();
      return;
    }
    if (request.method === "GET") {
      const objectPath = path.replace("/storage/v1/object/authenticated/", "/storage/v1/object/");
      const bytes = objects.get(objectPath);
      if (bytes === undefined) { response.writeHead(404).end(); return; }
      response.writeHead(200, {
        "content-type": "application/vnd.shipwithali.owner-export+zip",
        "content-length": String(bytes.byteLength),
      }).end(bytes);
      return;
    }
    response.writeHead(405).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("PHASE8_ISOLATED_STORAGE_LISTEN_FAILED");
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, objects, requests };
}

function configurationSettings(contactLabel: string, mediaAssetId?: StableId<"MediaAsset">): PortfolioSettings {
  return {
    portfolioId,
    version: 1,
    profile: {
      displayName: "Snapshot Ada",
      headline: "Systems builder",
      bio: "The retained configuration.",
      ...(mediaAssetId === undefined ? {} : { mediaAssetId }),
    },
    contactChannels: [{
      channel: "email",
      label: contactLabel,
      destination: "mailto:ada@example.test",
      availableLocales: ["en", "ar"],
    }],
    globalCta: {
      label: "Work together",
      destination: "https://example.test/work",
      unavailableFallback: "Contact me",
    },
  };
}

async function seedAcceptedMediaExportFixture(scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> }) {
  const settingsRepository = createPostgresPortfolioSettingsRepository();
  const settings = await application!.transactions.run((context) => settingsRepository.getSettings(scope, context));
  if (!settings.ok) {
    const provisioned = await application!.transactions.run((context) => settingsRepository.provisionSettings(scope, {
      ...configurationSettings("Media export"), portfolioId: scope.portfolioId,
    }, context));
    if (!provisioned.ok) throw new Error("PHASE8_MEDIA_EXPORT_SETTINGS_REQUIRED");
  }

  const mediaId = createStableId("MediaAsset");
  const sourceObjectId = createStableId("MediaObject");
  const outputObjectId = createStableId("MediaObject");
  const uploadIntentId = createStableId("MediaUploadIntent");
  const attemptId = createStableId("MediaProcessingAttempt");
  const decisionId = createStableId("MediaDecision");
  const originalBytes = new TextEncoder().encode("phase8-original-pdf");
  const mediaBytes = new TextEncoder().encode("phase8-accepted-pdf");
  const inputDigest = createHash("sha256").update(originalBytes).digest("hex");
  const outputDigest = createHash("sha256").update(mediaBytes).digest("hex");
  await admin!.query(
    "insert into media.assets (media_id, portfolio_id, owner_id, kind, original_file_name, declared_media_type, declared_byte_length, declared_sha256) values ($1, $2, $3, 'image', 'private-owner-filename.png', 'image/png', $4, $5)",
    [mediaId, scope.portfolioId, scope.ownerId, originalBytes.byteLength, inputDigest],
  );
  await admin!.query(
    "insert into media.upload_intents (upload_intent_id, media_id, media_object_id, portfolio_id, owner_id, expires_at) values ($1, $2, $3, $4, $5, $6)",
    [uploadIntentId, mediaId, sourceObjectId, scope.portfolioId, scope.ownerId, now],
  );
  await admin!.query(
    "insert into media.processed_objects (object_id, portfolio_id, owner_id, media_id, source_object_id, sha256, byte_length, mime_type, object_version) values ($1, $2, $3, $4, $5, $6, $7, 'image/webp', $6)",
    [outputObjectId, scope.portfolioId, scope.ownerId, mediaId, sourceObjectId, outputDigest, mediaBytes.byteLength],
  );
  await admin!.query(
    "insert into media.processing_attempts (attempt_id, portfolio_id, owner_id, media_id, input_object_id, input_sha256, detected_mime_type, detected_byte_length, result, output_object_id, output_sha256, scanner_version, processor_version, policy_version, finding_codes, started_at, finished_at) values ($1, $2, $3, $4, $5, $6, 'image/png', $7, 'passed', $8, $9, 'fixture-scanner-v1', 'fixture-processor-v1', 'image-webp-variants-v1', '[]'::jsonb, $10, $10)",
    [attemptId, scope.portfolioId, scope.ownerId, mediaId, sourceObjectId, inputDigest, originalBytes.byteLength, outputObjectId, outputDigest, now],
  );
  await admin!.query(
    "insert into media.processing_states (media_id, portfolio_id, owner_id, aggregate_version, latest_attempt_id) values ($1, $2, $3, 3, $4)",
    [mediaId, scope.portfolioId, scope.ownerId, attemptId],
  );
  await admin!.query(
    "insert into media.decision_history (decision_id, portfolio_id, owner_id, media_id, aggregate_version, decision, processing_attempt_id, input_object_id, input_sha256, detected_mime_type, detected_byte_length, scanner_version, processor_version, processing_policy_version, sealed_outputs, accessibility, ownership_attested_by, ownership_attested_at, public_suitability_attested_by, public_suitability_attested_at, decided_by, decided_at) values ($1, $2, $3, $4, 3, 'accepted', $5, $6, $7, 'image/png', $8, 'fixture-scanner-v1', 'fixture-processor-v1', 'image-webp-variants-v1', $9::jsonb, $10::jsonb, $3, $11, $3, $11, $3, $11)",
    [decisionId, scope.portfolioId, scope.ownerId, mediaId, attemptId, sourceObjectId, inputDigest, originalBytes.byteLength,
      JSON.stringify([{ objectId: outputObjectId, sha256: outputDigest, byteLength: mediaBytes.byteLength, mimeType: "image/webp", objectVersion: outputDigest, variantName: "display" }]),
      JSON.stringify({ kind: "decorative-image" }), now],
  );
  return { mediaId, sourceObjectId, outputObjectId, uploadIntentId, originalBytes, mediaBytes, inputDigest, outputDigest };
}

function storedConfigurationSnapshotReader(input: {
  readonly mutateConfigurationAfterCapture?: () => Promise<void>;
}) {
  const repository = createPostgresPortfolioSettingsRepository();
  const configuration = createPortfolioConfigurationExportSnapshotReader({
    repository,
    transactions: worker!.transactions,
  });
  return createOwnerExportConfigurationSnapshotReader({
    configuration,
    capabilities: {
      async read() {
        await input.mutateConfigurationAfterCapture?.();
        return { currentCvAvailable: false, externalLinksAvailable: false };
      },
    },
  });
}

describe.runIf(Boolean(APPLICATION_URL && WORKER_URL && ADMIN_URL))("Phase 8 owner export PostgreSQL acceptance (#238)", () => {
  beforeAll(async () => {
    if (!APPLICATION_URL || !WORKER_URL || !ADMIN_URL) throw new Error("PHASE8_OWNER_EXPORT_DATABASE_REQUIRED");
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    application = createPostgresRuntimeDatabase(APPLICATION_URL);
    otherApplication = createPostgresRuntimeDatabase(APPLICATION_URL);
    worker = createPostgresRuntimeDatabase(WORKER_URL);
  });

  afterAll(async () => {
    // The runner shares one disposable cluster across suites; the suite leaves
    // its exact rows removed before yielding the database.
    try {
      await admin?.query("delete from portability.owner_exports where owner_id = any($1::uuid[])", [TEST_OWNER_IDS]);
      await admin?.query("delete from portfolio_config.contact_channels where portfolio_id in (select portfolio_id from portfolio_config.settings where owner_id = any($1::uuid[]))", [TEST_OWNER_IDS]);
      await admin?.query("delete from taxonomy.roots where portfolio_id in (select portfolio_id from portfolio_config.settings where owner_id = any($1::uuid[]))", [TEST_OWNER_IDS]);
      await admin?.query("update portfolio_config.settings set profile_media_asset_id = null where owner_id = any($1::uuid[])", [TEST_OWNER_IDS]);
      await admin?.query("delete from media.rejection_history where owner_id = any($1::uuid[])", [TEST_OWNER_IDS]);
      await admin?.query("delete from media.decision_history where owner_id = any($1::uuid[])", [TEST_OWNER_IDS]);
      await admin?.query("delete from media.processing_states where owner_id = any($1::uuid[])", [TEST_OWNER_IDS]);
      await admin?.query("delete from media.processing_attempts where owner_id = any($1::uuid[])", [TEST_OWNER_IDS]);
      await admin?.query("delete from media.processed_objects where owner_id = any($1::uuid[])", [TEST_OWNER_IDS]);
      await admin?.query("delete from media.upload_intents where owner_id = any($1::uuid[])", [TEST_OWNER_IDS]);
      await admin?.query("delete from media.assets where owner_id = any($1::uuid[])", [TEST_OWNER_IDS]);
      await admin?.query("delete from portfolio_config.settings where owner_id = any($1::uuid[])", [TEST_OWNER_IDS]);
      await admin?.query("delete from operations.jobs where job_type = 'portability.owner-export-assembly.v1'");
      await admin?.query("delete from operations.idempotency_records where operation_scope = $1", [OPERATION_SCOPE]);
      await admin?.query("delete from operations.idempotency_records where operation_scope like 'portability.owner-export-request:%'");
      await admin?.query("delete from operations.outbox_events where event_type = 'portability.export_produced.v1'");
      await application?.resource.close();
      await otherApplication?.resource.close();
      await worker?.resource.close();
      await admin?.end();
    } finally {
      admin = undefined;
      application = undefined;
      otherApplication = undefined;
      worker = undefined;
    }
  });

  it("AC01/02/06/07: exports one captured Configuration version through isolated private Storage", async () => {
    const scope = { portfolioId, ownerId };
    const settingsRepository = createPostgresPortfolioSettingsRepository();
    const configured = await application!.transactions.run((context) =>
      settingsRepository.provisionSettings(scope, configurationSettings("Email v1"), context));
    expect(configured.ok).toBe(true);
    const profileMediaAssetId = createStableId("MediaAsset");
    await admin!.query(
      "insert into media.assets (media_id, portfolio_id, owner_id, kind, original_file_name, declared_media_type, declared_byte_length, declared_sha256) values ($1::uuid, $2::uuid, $3::uuid, 'image', 'profile.png', 'image/png', 1, $4)",
      [profileMediaAssetId, portfolioId, ownerId, "a".repeat(64)],
    );
    const mediaConfigured = await application!.transactions.run((context) =>
      settingsRepository.updateProfile(
        scope,
        configurationSettings("Email v1", profileMediaAssetId).profile,
        1,
        context,
      ));
    expect(mediaConfigured).toMatchObject({ ok: true, value: { aggregateVersion: 2 } });

    let racedUpdate: unknown;
    const snapshots = storedConfigurationSnapshotReader({
      mutateConfigurationAfterCapture: async () => {
        racedUpdate = await application!.transactions.run((context) =>
          settingsRepository.updateContactChannels(scope, [{
            channel: "email",
            label: "Email v2",
            destination: "mailto:ada@example.test",
            availableLocales: ["en", "ar"],
          }], 2, context));
      },
    });
    const objectServer = await startIsolatedObjectStorage();
    try {
      const storage = createSupabaseOwnerExportStorage({
        storageUrl: objectServer.baseUrl,
        serviceRoleKey: "phase8-isolated-storage-key",
      });
      const primary = composeService(application!, { objectRead: storage });
      const workerOperations = createPostgresOperationsPersistence(worker!.database, { now: () => now });
      const workerStore = createPostgresOwnerExportStore(worker!.database, { outbox: workerOperations.outbox });
      const assembly = createOwnerExportAssemblyService({
        operations: workerOperations,
        exports: workerStore,
        artifacts: workerStore,
        snapshots,
        storage,
        clock: { now: () => now },
        ids: createSystemIdGenerator(),
      });
      const request = await primary.service.requestOwnerExport(command(["portfolio-configuration"], "phase8-config-export-e2e-001"));
      expect(request.ok).toBe(true);
      if (!request.ok) return;
      await makeAssemblyJobDue(request.value.exportId);

      expect(await assembly.runOwnerExportAssembly({ workerId: "phase8-config-export-worker" }))
        .toMatchObject({ ok: true, value: { claimed: 1, completed: 1, retried: 0, failed: 0 } });
      expect(racedUpdate).toMatchObject({ ok: true, value: { aggregateVersion: 3 } });
      const persisted = await workerStore.findOwnerExport({ exportId: request.value.exportId, ...scope });
      expect(persisted).toMatchObject({
        status: "ready",
        completedAt: expect.any(String),
        expiresAt: expect.any(String),
        schemaVersion: "1.2",
        snapshot: {
          configurationVersion: 2,
          settings: { profile: { mediaAssetId: profileMediaAssetId }, contactChannels: [{ label: "Email v1" }] },
        },
        integrityManifest: {
          schemaVersion: "1.2",
          extensions: { configurationSnapshot: { aggregateVersion: 2 } },
        },
      });
      expect(Date.parse(persisted!.expiresAt!) - Date.parse(persisted!.completedAt!)).toBe(7 * 24 * 60 * 60 * 1000);

      const firstDownload = await primary.service.downloadOwnerExport({ actor, portfolioId, exportId: request.value.exportId });
      expect(firstDownload.ok).toBe(true);
      if (!firstDownload.ok) return;
      const firstBytes = await readAll(firstDownload.value.content);
      const validated = validateOwnerExportZip(firstBytes);
      expect(validated.manifest.schemaVersion).toBe("1.2");
      expect(validated.manifest.extensions).toMatchObject({
        configurationSnapshot: { aggregateVersion: 2, availableLocales: ["ar", "en"] },
      });
      expect(validated.manifest.dependencies).toContainEqual(expect.objectContaining({
        sourceScope: "portfolio-configuration",
        disposition: "omitted",
        reason: "scope-not-selected",
      }));
      expect(firstDownload.value.filename).toBe("shipwithali-owner-export-1.2.zip");
      expect(firstDownload.value.contentLength).toBe(firstBytes.byteLength);
      const replay = await primary.service.requestOwnerExport(command(["portfolio-configuration"], "phase8-config-export-e2e-001"));
      const secondDownload = await primary.service.downloadOwnerExport({ actor, portfolioId, exportId: request.value.exportId });
      expect(replay).toEqual(request);
      expect(secondDownload.ok).toBe(true);
      if (secondDownload.ok) expect(await readAll(secondDownload.value.content)).toEqual(firstBytes);
      expect(objectServer.objects.size).toBe(1);
      expect(objectServer.requests.filter((entry) => entry.startsWith("POST "))).toHaveLength(1);
    } finally {
      await new Promise<void>((resolve) => objectServer.server.close(() => resolve()));
    }
  });

  it("#243 AC01/04/08: reads accepted Media history under its purpose-bound worker role and excludes private fields", async () => {
    const scope = mediaHistoryScope;
    const { mediaId, sourceObjectId, outputObjectId, mediaBytes, inputDigest, outputDigest } = await seedAcceptedMediaExportFixture(scope);

    const snapshotReader = createPostgresOwnerMediaExportSnapshotReader({ database: worker!.database, transactions: worker!.transactions });
    const captured = await worker!.transactions.run((context) => snapshotReader.readOwnerMediaExportSnapshot(scope, context), { isolationLevel: "repeatable read" });
    expect(captured).toMatchObject({ ok: true });
    if (!captured.ok) return;
    expect(captured.value.records).toHaveLength(1);
    const outsideScope = await worker!.transactions.run((context) => snapshotReader.readOwnerMediaExportSnapshot({
      portfolioId: createStableId("Portfolio"), ownerId: scope.ownerId,
    }, context));
    expect(outsideScope).toMatchObject({ ok: true, value: { records: [], assets: [] } });
    expect(captured.value.records[0]).toMatchObject({
      mediaId,
      value: expect.objectContaining({
        aggregateVersion: 3,
        state: "accepted",
        publicationEligibility: "eligible",
        byteCoverage: "included",
        acceptanceHistory: [expect.objectContaining({ aggregateVersion: 3, byteCoverage: "included" })],
        portableAssets: expect.arrayContaining([
          expect.objectContaining({ variantName: "original", digest: inputDigest, mediaType: "image/png" }),
          expect.objectContaining({ variantName: "display", digest: outputDigest, mediaType: "image/webp", byteLength: mediaBytes.byteLength }),
        ]),
      }),
    });
    expect(JSON.stringify(captured.value.records)).not.toContain("private-owner-filename.png");
    expect(JSON.stringify(captured.value.records)).not.toContain(outputObjectId);
    expect(captured.value.assets).toHaveLength(2);
    expect(captured.value.assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ mediaId, objectId: outputObjectId, source: "variant", sha256: outputDigest }),
      expect.objectContaining({ mediaId, objectId: sourceObjectId, source: "original", uploadIntentId: expect.any(String), sha256: inputDigest }),
    ]));
    expect(JSON.stringify(captured.value.records[0]?.value)).not.toContain(sourceObjectId);
    expect(JSON.stringify(captured.value.records[0]?.value)).not.toContain("uploadIntentId");
    const acceptedVersions = new Map<StableId<"MediaAsset">, number>([[mediaId, 3]]);
    const acceptedStillCurrent = await worker!.transactions.run((context) =>
      snapshotReader.revalidateOwnerMediaExportSnapshot(scope, acceptedVersions, context));
    expect(acceptedStillCurrent).toEqual({ ok: true, value: true });

    const restricted = new Client({ connectionString: WORKER_URL });
    await restricted.connect();
    try {
      await restricted.query("select set_config('shipwithali.portfolio_id', $1, false), set_config('shipwithali.owner_id', $2, false), set_config('shipwithali.worker_purpose', 'media.owner-export', false)", [scope.portfolioId, scope.ownerId]);
      await expect(restricted.query("select original_file_name from media.assets where media_id = $1", [mediaId]))
        .rejects.toMatchObject({ code: "42501" });
      await expect(restricted.query("update media.assets set kind = 'video' where media_id = $1", [mediaId]))
        .rejects.toMatchObject({ code: "42501" });
    } finally {
      await restricted.end();
    }
    await admin!.query("update media.processing_states set aggregate_version = 4 where media_id = $1", [mediaId]);
    await admin!.query(
      "insert into media.rejection_history (rejection_id, portfolio_id, owner_id, media_id, aggregate_version, private_reason, rejected_by, rejected_at) values ($1, $2, $3, $4, 4, 'private owner-only rejection rationale', $3, $5)",
      [createStableId("MediaRejection"), scope.portfolioId, scope.ownerId, mediaId, now],
    );
    const afterRejection = await worker!.transactions.run((context) =>
      snapshotReader.revalidateOwnerMediaExportSnapshot(scope, acceptedVersions, context));
    expect(afterRejection).toEqual({ ok: true, value: false });
    const rejected = await worker!.transactions.run((context) => snapshotReader.readOwnerMediaExportSnapshot(scope, context));
    expect(rejected).toMatchObject({ ok: true, value: { assets: [] } });
    if (!rejected.ok) return;
    const rejectedRecord = rejected.value.records.find((record) => record.mediaId === mediaId);
    expect(rejectedRecord?.value).toMatchObject({
      state: "rejected", publicationState: "withdrawn", publicationEligibility: "ineligible",
      byteCoverage: "excluded", byteExclusionReason: "rejected-or-withdrawn", portableAssets: [],
      decisionHistory: expect.arrayContaining([expect.objectContaining({ decision: "rejected", reason: "OWNER_REJECTED" })]),
    });
    expect(JSON.stringify(rejected.value.records)).not.toContain("private owner-only rejection rationale");
    const rejectionPrivateField = new Client({ connectionString: WORKER_URL });
    await rejectionPrivateField.connect();
    try {
      await rejectionPrivateField.query("select set_config('shipwithali.portfolio_id', $1, false), set_config('shipwithali.owner_id', $2, false), set_config('shipwithali.worker_purpose', 'media.owner-export', false)", [scope.portfolioId, scope.ownerId]);
      await expect(rejectionPrivateField.query("select private_reason from media.rejection_history where media_id = $1", [mediaId]))
        .rejects.toMatchObject({ code: "42501" });
    } finally {
      await rejectionPrivateField.end();
    }
  });

  it("#243: readies Media export after reloading its persisted snapshot and candidate through PostgreSQL", async () => {
    const scope = mediaReadyScope;
    const { mediaId, sourceObjectId, outputObjectId, originalBytes, mediaBytes } = await seedAcceptedMediaExportFixture(scope);
    const mediaSnapshotReader = createPostgresOwnerMediaExportSnapshotReader({ database: worker!.database, transactions: worker!.transactions });
    const snapshots = createOwnerExportSnapshotReader({
      configuration: createPostgresPortfolioSettingsRepository(),
      content: createPostgresContentAuthoringRepository(),
      media: mediaSnapshotReader,
      transactions: worker!.transactions,
      capabilities: { async read() { return { currentCvAvailable: false, externalLinksAvailable: false }; } },
    });
    const bytesByObjectId = new Map<string, Uint8Array>([[sourceObjectId, originalBytes], [outputObjectId, mediaBytes]]);
    const mediaObjects: OwnerExportMediaObjectReaderPort = {
      async readMediaExportObject(input) {
        const bytes = bytesByObjectId.get(input.objectId);
        if (bytes === undefined) throw new Error("PHASE8_MEDIA_EXPORT_FIXTURE_OBJECT_MISSING");
        return { async *[Symbol.asyncIterator]() { yield bytes; } };
      },
    };
    const objectServer = await startIsolatedObjectStorage();
    try {
      const storage = createSupabaseOwnerExportStorage({
        storageUrl: objectServer.baseUrl,
        serviceRoleKey: "phase8-isolated-storage-key",
      });
      const mediaActor: OwnerActor = { kind: "owner", ownerId: scope.ownerId, sessionId: "phase8-media-export-ready" };
      const primary = composeService(application!, { objectRead: storage });
      const workerOperations = createPostgresOperationsPersistence(worker!.database, { now: () => now });
      const workerStore = createPostgresOwnerExportStore(worker!.database, { outbox: workerOperations.outbox });
      const assembly = createOwnerExportAssemblyService({
        operations: workerOperations,
        exports: workerStore,
        artifacts: workerStore,
        snapshots,
        mediaObjects,
        storage,
        clock: { now: () => now },
        ids: createSystemIdGenerator(),
      });
      const request = await primary.service.requestOwnerExport({
        actor: mediaActor,
        portfolioId: scope.portfolioId,
        idempotencyKey: key("phase8-media-export-persisted-reload-001"),
        includedScopes: ["media-metadata"],
      });
      expect(request.ok).toBe(true);
      if (!request.ok) return;
      await makeAssemblyJobDue(request.value.exportId);

      const assembled = await assembly.runOwnerExportAssembly({ workerId: "phase8-media-export-ready-worker" });
      expect(assembled).toMatchObject({ ok: true, value: { claimed: 1, completed: 1, retried: 0, failed: 0 } });
      const persisted = await workerStore.findOwnerExport({ exportId: request.value.exportId, ...scope });
      expect(persisted).toMatchObject({
        status: "ready",
        includedScopes: ["media-metadata"],
        schemaVersion: "1.5",
        snapshot: {
          kind: "owner-export-snapshot-v1",
          includedScopes: ["media-metadata"],
          media: { records: [expect.objectContaining({ mediaId })], assets: expect.arrayContaining([
            expect.objectContaining({ mediaId, objectId: sourceObjectId, source: "original" }),
            expect.objectContaining({ mediaId, objectId: outputObjectId, source: "variant" }),
          ]) },
        },
        candidateArtifactId: expect.any(String),
        candidateSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        candidateContentLength: expect.any(Number),
      });
      await admin!.query("update media.processing_states set aggregate_version = 4 where media_id = $1", [mediaId]);
      await admin!.query(
        "insert into media.rejection_history (rejection_id, portfolio_id, owner_id, media_id, aggregate_version, private_reason, rejected_by, rejected_at) values ($1, $2, $3, $4, 4, 'private owner-only rejection rationale', $3, $5)",
        [createStableId("MediaRejection"), scope.portfolioId, scope.ownerId, mediaId, now],
      );
      const cleanup = createOwnerExportArtifactCleanupService({ scope, artifacts: workerStore, snapshots, storage });
      expect(await cleanup.runOwnerExportCleanup()).toMatchObject({ ok: true, value: { deleted: 1, pending: 0 } });
      const invalidated = await workerStore.findOwnerExport({ exportId: request.value.exportId, ...scope });
      expect(invalidated).toMatchObject({ status: "expired", artifactRevocationCode: "privacy_invalid",
        artifactRevokedAt: expect.any(String), artifactDeletedAt: expect.any(String) });
      expect(await storage.readOwnerExport({ portfolioId: scope.portfolioId, exportId: request.value.exportId,
        artifactId: invalidated!.candidateArtifactId!, expectedContentLength: invalidated!.candidateContentLength!,
        expectedSha256: invalidated!.candidateSha256! })).toMatchObject({ ok: false });
    } finally {
      await new Promise<void>((resolve) => objectServer.server.close(() => resolve()));
    }
  });

  it.each([false, true])("#247: mixed Media/Moderation readiness with Media rejected during upload: %s", async (rejectMedia) => {
    const scope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    TEST_OWNER_IDS.push(scope.ownerId);
    await application!.transactions.run(context => createPostgresPortfolioSettingsRepository().provisionSettings(
      scope, { ...configurationSettings("Mixed export"), portfolioId: scope.portfolioId }, context));
    const { mediaId, sourceObjectId, outputObjectId, originalBytes, mediaBytes } = await seedAcceptedMediaExportFixture(scope);
    const snapshots = createOwnerExportSnapshotReader({
      configuration: createPostgresPortfolioSettingsRepository(), content: createPostgresContentAuthoringRepository(),
      media: createPostgresOwnerMediaExportSnapshotReader({ database: worker!.database, transactions: worker!.transactions }),
      moderation: createPostgresFeedbackOwnerExportSnapshotReader(), transactions: worker!.transactions,
      capabilities: { async read() { return { currentCvAvailable: false, externalLinksAvailable: false }; } },
    });
    let bytes = new Uint8Array();
    let moderationUnchanged = false;
    const storage = {
      async writeOwnerExport(input: Parameters<ReturnType<typeof createSupabaseOwnerExportStorage>["writeOwnerExport"]>[0]) {
        const chunks: Uint8Array[] = [];
        for await (const chunk of input.content) chunks.push(chunk);
        bytes = new Uint8Array(Buffer.concat(chunks));
        if (rejectMedia) {
          await admin!.query("update media.processing_states set aggregate_version = 4 where media_id = $1", [mediaId]);
          await admin!.query(`insert into media.rejection_history
            (rejection_id,portfolio_id,owner_id,media_id,aggregate_version,private_reason,rejected_by,rejected_at)
            values ($1,$2,$3,$4,4,'Synthetic rejection during upload',$3,$5)`,
          [createStableId("MediaRejection"), scope.portfolioId, scope.ownerId, mediaId, now]);
        }
        return { ok: true as const, value: undefined };
      },
      async readOwnerExport() {
        return { ok: true as const, value: { contentLength: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          content: { async *[Symbol.asyncIterator]() { yield bytes; } } } };
      },
    };
    const operations = createPostgresOperationsPersistence(worker!.database, { now: () => now });
    const store = createPostgresOwnerExportStore(worker!.database, { outbox: operations.outbox });
    const assembly = createOwnerExportAssemblyService({ operations, exports: store, artifacts: store, storage,
      snapshots: { ...snapshots, async revalidateModerationForReady(input) {
        moderationUnchanged = await snapshots.revalidateModerationForReady!(input);
        return moderationUnchanged;
      } },
      mediaObjects: { async readMediaExportObject(input) {
        const object = input.objectId === sourceObjectId ? originalBytes : input.objectId === outputObjectId ? mediaBytes : undefined;
        if (object === undefined) throw new Error("MIXED_EXPORT_OBJECT_MISSING");
        return { async *[Symbol.asyncIterator]() { yield object; } };
      } }, clock: { now: () => now }, ids: createSystemIdGenerator(),
    });
    const requested = await composeService(application!).service.requestOwnerExport({
      actor: { kind: "owner", ownerId: scope.ownerId, sessionId: "mixed-export-race" }, portfolioId: scope.portfolioId,
      idempotencyKey: key(`mixed-export-race-${rejectMedia}`), includedScopes: ["media-metadata", "moderation-history"],
    });
    expect(requested.ok).toBe(true);
    if (!requested.ok) throw new Error("MIXED_EXPORT_REQUEST_FAILED");
    await makeAssemblyJobDue(requested.value.exportId);
    expect(await assembly.runOwnerExportAssembly({ workerId: "mixed-export-race" }))
      .toMatchObject({ ok: true, value: { claimed: 1, completed: rejectMedia ? 0 : 1, retried: rejectMedia ? 1 : 0, failed: 0, staleLeases: 0 } });
    const persisted = await store.findOwnerExport({ ...scope, exportId: requested.value.exportId });
    expect(persisted?.status).toBe(rejectMedia ? "building" : "ready");
    expect(await worker!.transactions.run(context => snapshots.revalidateModerationForReady!({
      ...scope, snapshot: persisted!.snapshot!, context,
    }))).toBe(true);
    if (!rejectMedia) expect(moderationUnchanged).toBe(true);
    expect(await countRows(`select count(*)::int as count from operations.outbox_events
      where aggregate_id=$1 and event_type='portability.export_produced.v1'`, [requested.value.exportId])).toBe(rejectMedia ? 0 : 1);
    const job = await admin!.query("select status from operations.jobs where payload->>'exportId'=$1", [requested.value.exportId]);
    expect(job.rows[0]?.status).toBe(rejectMedia ? "available" : "completed");
    // Leave no due/leased job for the following worker acceptance scenario.
    await admin!.query("delete from operations.jobs where payload->>'exportId'=$1", [requested.value.exportId]);
  });

  it("AC03/04/05: retries capture, lost upload, and verification faults without publishing partial readiness", async () => {
    const scope = { portfolioId, ownerId };
    const settingsRepository = createPostgresPortfolioSettingsRepository();
    const configured = await application!.transactions.run((context) =>
      settingsRepository.getSettings(scope, context));
    expect(configured.ok).toBe(true);

    const baseSnapshots = storedConfigurationSnapshotReader({});
    let captures = 0;
    const snapshots = {
      async capture(input: Parameters<typeof baseSnapshots.capture>[0]) {
        captures += 1;
        if (captures === 1) throw new Error("injected capture interruption");
        const captured = await baseSnapshots.capture(input);
        if (!captured.ok) return captured;
        return {
          ok: true as const,
          value: {
            ...captured.value,
            policyExpiresAt: new Date(Date.parse(captured.value.capturedAt) + 86400_000).toISOString(),
          },
        };
      },
    };
    const objectServer = await startIsolatedObjectStorage();
    try {
      const storage = createSupabaseOwnerExportStorage({
        storageUrl: objectServer.baseUrl,
        serviceRoleKey: "phase8-isolated-storage-key",
      });
      let uploadReplies = 0;
      let verificationReads = 0;
      const faultStorage = {
        ...storage,
        async writeOwnerExport(input: Parameters<typeof storage.writeOwnerExport>[0]) {
          const result = await storage.writeOwnerExport(input);
          if (uploadReplies++ === 0) {
            return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "OWNER_EXPORT_ARTIFACT_UNAVAILABLE" } };
          }
          return result;
        },
        async readOwnerExport(input: Parameters<typeof storage.readOwnerExport>[0]) {
          if (verificationReads++ === 0) {
            return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "OWNER_EXPORT_ARTIFACT_UNAVAILABLE" } };
          }
          return storage.readOwnerExport(input);
        },
      };
      const primary = composeService(application!, { objectRead: storage });
      const workerOperations = createPostgresOperationsPersistence(worker!.database, { now: () => now });
      const baseStore = createPostgresOwnerExportStore(worker!.database, { outbox: workerOperations.outbox });
      const lostReadyReplyStore: OwnerExportStorePort = {
        ...baseStore,
        async applyOwnerExportTransition(input) {
          const result = await baseStore.applyOwnerExportTransition(input);
          if (input.toStatus === "ready" && result.ok && result.value.kind === "applied") {
            throw new Error("injected worker interruption after atomic ready commit");
          }
          return result;
        },
      };
      const assembly = createOwnerExportAssemblyService({
        operations: workerOperations,
        exports: lostReadyReplyStore,
        artifacts: baseStore,
        snapshots,
        storage: faultStorage,
        clock: { now: () => now },
        ids: createSystemIdGenerator(),
        random: () => 0,
      });
      const request = await primary.service.requestOwnerExport(command(["portfolio-configuration"], "phase8-config-export-retry-001"));
      expect(request.ok).toBe(true);
      if (!request.ok) return;
      const exportId = request.value.exportId;
      await makeAssemblyJobDue(exportId);

      expect(await assembly.runOwnerExportAssembly({ workerId: "phase8-config-retry-worker" }))
        .toMatchObject({ ok: true, value: { claimed: 1, retried: 1, completed: 0 } });
      const afterFirstRetry = await baseStore.findOwnerExport({ exportId, ...scope });
      expect(afterFirstRetry).toMatchObject({ status: "building" });
      await makeAssemblyJobDue(exportId);

      expect(await assembly.runOwnerExportAssembly({ workerId: "phase8-config-retry-worker" }))
        .toMatchObject({ ok: true, value: { claimed: 1, retried: 1, completed: 0 } });
      const checkpointed = await baseStore.findOwnerExport({ exportId, ...scope });
      expect(checkpointed).toMatchObject({ status: "building", snapshot: { configurationVersion: 3 } });
      expect(checkpointed?.candidateArtifactId).toBeDefined();
      expect(await ownerExportCount()).toBeGreaterThan(0);
      await makeAssemblyJobDue(exportId);

      expect(await assembly.runOwnerExportAssembly({ workerId: "phase8-config-retry-worker" }))
        .toMatchObject({ ok: true, value: { claimed: 1, retried: 1, completed: 0 } });
      expect(await baseStore.findOwnerExport({ exportId, ...scope })).toMatchObject({ status: "building" });
      await makeAssemblyJobDue(exportId);

      expect(await assembly.runOwnerExportAssembly({ workerId: "phase8-config-retry-worker" }))
        .toMatchObject({ ok: true, value: { claimed: 1, staleLeases: 1, completed: 0 } });
      const completed = await baseStore.findOwnerExport({ exportId, ...scope });
      expect(completed).toMatchObject({ status: "ready", completedAt: expect.any(String), expiresAt: expect.any(String) });
      expect(completed!.expiresAt).toBe((completed!.snapshot as OwnerExportConfigurationSnapshot).policyExpiresAt);
      expect(Date.parse(completed!.expiresAt!) - Date.parse(completed!.completedAt!)).toBeLessThanOrEqual(86400_000);
      expect(captures).toBe(2);
      expect(objectServer.objects.size).toBe(1);

      const first = await primary.service.downloadOwnerExport({ actor, portfolioId, exportId });
      const second = await primary.service.downloadOwnerExport({ actor, portfolioId, exportId });
      expect(first.ok && second.ok).toBe(true);
      if (first.ok && second.ok) expect(await readAll(second.value.content)).toEqual(await readAll(first.value.content));
      expect(objectServer.requests.filter((entry) => entry.startsWith("POST ")).length).toBeGreaterThan(1);
      expect(verificationReads).toBe(2);
    } finally {
      await new Promise<void>((resolve) => objectServer.server.close(() => resolve()));
    }
  });

  it("AC09: rejects an unsupported requested scope without manufacturing a ready package", async () => {
    const primary = composeService(application!);
    const exportsBefore = await ownerExportCount();
    const jobsBefore = await assemblyJobCount();
    const request = await primary.service.requestOwnerExport(command(["unknown-scope"], "phase8-config-export-unsupported-001"));
    expect(request).toMatchObject({ ok: false, error: { kind: "validation", code: "OWNER_EXPORT_SCOPE_UNKNOWN" } });
    expect(await ownerExportCount()).toBe(exportsBefore);
    expect(await assemblyJobCount()).toBe(jobsBefore);
  });

  it("keeps upload and revocation fenced on a single reserved PostgreSQL connection", async () => {
    const singlePool = createPostgresRuntimeDatabase(WORKER_URL!, { max: 1, connectionTimeoutMs: 1_000 });
    const poolOperations = createPostgresOperationsPersistence(singlePool.database, { now: () => now });
    const store = createPostgresOwnerExportStore(singlePool.database, { outbox: poolOperations.outbox });
    try {
      const primary = composeService(application!);
      const requested = await primary.service.requestOwnerExport(command(["portfolio-content"], "phase8-fence-pool-one-001"));
      expect(requested.ok).toBe(true);
      if (!requested.ok) return;
      const lease = await leaseExportJob(requested.value.exportId);
      expect(await applyGuardedOwnerExportTransition(store, transitionInput(requested.value.exportId, "requested", "building", 1,
        advance(), { actingJobId: lease.jobId, leaseToken: lease.leaseToken }))).toEqual({ ok: true, value: "applied" });
      const { artifactId } = await checkpointTestArtifact(store, requested.value.exportId, lease);
      const identity = { portfolioId, exportId: requested.value.exportId, artifactId,
        actingJobId: lease.jobId, leaseToken: lease.leaseToken };
      await expect(store.uploadCandidate(identity, async () => { throw new Error("synthetic upload callback failure"); }))
        .rejects.toThrow("synthetic upload callback failure");
      let uploaded = 0;
      expect(await store.uploadCandidate(identity, async () => { uploaded += 1; return true; })).toBe(true);
      expect(uploaded).toBe(1);

      const revoked = await store.revokeOwnerExportArtifact({ exportId: requested.value.exportId, portfolioId, ownerId,
        stillEligible: async () => false });
      expect(revoked).toMatchObject({ status: "failed", artifactRevocationCode: "privacy_invalid" });
      let lateUpload = 0;
      expect(await store.uploadCandidate(identity, async () => { lateUpload += 1; return true; })).toBe(false);
      expect(lateUpload).toBe(0);
    } finally {
      await singlePool.resource.close();
    }
  }, 30_000);

  it("saturates the default five-connection pool with concurrent uploads and revocations without nested checkouts", async () => {
    const saturatedPool = createPostgresRuntimeDatabase(WORKER_URL!, { connectionTimeoutMs: 1_500 });
    const poolOperations = createPostgresOperationsPersistence(saturatedPool.database, { now: () => now });
    const store = createPostgresOwnerExportStore(saturatedPool.database, { outbox: poolOperations.outbox });
    let release!: () => void;
    let allEntered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    let resolveAllEntered!: () => void;
    const allEnteredPromise = new Promise<void>((resolve) => { resolveAllEntered = resolve; });
    const arriveAndWait = async () => {
      entered += 1;
      if (entered === 5) resolveAllEntered();
      await gate;
    };
    const primary = composeService(application!);
    const jobs: Array<{ identity: { portfolioId: StableId<"Portfolio">; exportId: StableId<"OwnerExport">;
      artifactId: StableId<"OwnerExportArtifact">; actingJobId: StableId<"Job">; leaseToken: string } }> = [];
    try {
      for (let index = 0; index < 5; index += 1) {
        const requested = await primary.service.requestOwnerExport(command(["portfolio-content"], `phase8-fence-pool-five-00${index + 1}`));
        expect(requested.ok).toBe(true);
        if (!requested.ok) throw new Error("PHASE8_FENCE_POOL_REQUEST_FAILED");
        const lease = await leaseExportJob(requested.value.exportId);
        expect(await applyGuardedOwnerExportTransition(store, transitionInput(requested.value.exportId, "requested", "building", 1,
          advance(), { actingJobId: lease.jobId, leaseToken: lease.leaseToken }))).toEqual({ ok: true, value: "applied" });
        const { artifactId } = await checkpointTestArtifact(store, requested.value.exportId, lease);
        jobs.push({ identity: { portfolioId, exportId: requested.value.exportId, artifactId,
          actingJobId: lease.jobId, leaseToken: lease.leaseToken } });
      }

      const actions = [
        store.uploadCandidate(jobs[0]!.identity, async () => { await arriveAndWait(); return true; }),
        store.uploadCandidate(jobs[1]!.identity, async () => { await arriveAndWait(); throw new Error("synthetic saturated upload failure"); }),
        store.uploadCandidate(jobs[2]!.identity, async () => { await arriveAndWait(); return true; }),
        store.revokeOwnerExportArtifact({ exportId: jobs[3]!.identity.exportId, portfolioId, ownerId,
          stillEligible: async () => { await arriveAndWait(); return false; } }),
        store.revokeOwnerExportArtifact({ exportId: jobs[4]!.identity.exportId, portfolioId, ownerId,
          stillEligible: async () => { await arriveAndWait(); throw new Error("synthetic saturated revocation failure"); } }),
      ];
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let barrierFailure: unknown;
      try {
        await Promise.race([allEnteredPromise, new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("PHASE8_FENCE_POOL_BARRIER_TIMEOUT")), 10_000);
        })]);
      } catch (error) { barrierFailure = error; }
      finally {
        if (timeout !== undefined) clearTimeout(timeout);
        release();
      }
      const settled = await Promise.allSettled(actions);
      if (barrierFailure !== undefined) throw barrierFailure;
      expect(settled.map((item) => item.status)).toEqual(["fulfilled", "rejected", "fulfilled", "fulfilled", "rejected"]);
      expect(settled[0]).toMatchObject({ status: "fulfilled", value: true });
      expect(settled[2]).toMatchObject({ status: "fulfilled", value: true });
      expect(settled[3]).toMatchObject({ status: "fulfilled", value: { status: "failed", artifactRevocationCode: "privacy_invalid" } });
      // The failed callbacks both rolled back/released their fences and can be retried.
      expect(await store.uploadCandidate(jobs[1]!.identity, async () => true)).toBe(true);
      expect(await store.revokeOwnerExportArtifact({ exportId: jobs[4]!.identity.exportId, portfolioId, ownerId,
        stillEligible: async () => false })).toMatchObject({ status: "failed", artifactRevocationCode: "privacy_invalid" });
      expect(entered).toBe(5);
    } finally {
      release();
      await saturatedPool.resource.close();
    }
  }, 40_000);

  it("AC03: commits exact concurrent requests once and replays the original receipt to both", async () => {
    const primary = composeService(application!);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reserved = new Promise<void>(resolve => { entered = resolve; });
    let held = false;
    const blockingStore: OwnerExportStorePort = {
      ...primary.store,
      async reserveOwnerExport(input, context) {
        if (!held) {
          held = true;
          entered();
          await gate;
        }
        await primary.store.reserveOwnerExport(input, context);
      },
    };
    const blocked = composeService(application!, { store: blockingStore });
    const direct = composeService(otherApplication!);
    const raceKey = "phase8-concurrent-export-key-001";
    const beforeExports = await ownerExportCount();
    const beforeJobs = await assemblyJobCount();

    const first = blocked.service.requestOwnerExport(command(["portfolio-content"], raceKey));
    await reserved;
    const second = direct.service.requestOwnerExport(command(["portfolio-content"], raceKey));
    let waiting = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !waiting) {
      waiting = ((await admin!.query(
        `select 1 from pg_stat_activity where usename = $1 and wait_event_type = 'Lock'`,
        [APPLICATION_RUNTIME_ROLE],
      )).rowCount ?? 0) > 0;
    }
    expect(waiting).toBe(true);
    release();
    const [settledFirst, settledSecond] = await Promise.all([first, second]);
    expect(settledFirst.ok).toBe(true);
    expect(settledSecond).toEqual(settledFirst);
    expect(await ownerExportCount()).toBe(beforeExports + 1);
    expect(await assemblyJobCount()).toBe(beforeJobs + 1);
    expect(await receiptCountForKey(raceKey)).toBe(1);
    const rows = await admin!.query(
      `select export_id::text as export_id from portability.owner_exports where owner_id = $1 and status = 'requested'`,
      [ownerId],
    );
    if (settledFirst.ok) {
      expect(rows.rows.map(row => row.export_id)).toContain(settledFirst.value.exportId);
      const jobs = await admin!.query(
        `select payload from operations.jobs where job_type = 'portability.owner-export-assembly.v1' and payload->>'exportId' = $1`,
        [settledFirst.value.exportId],
      );
      expect(jobs.rows).toHaveLength(1);
      const payload = jobs.rows[0]?.payload as Record<string, unknown>;
      expect(payload["includedScopes"]).toEqual(["portfolio-content"]);
      expect(payload["ownerId"]).toBe(ownerId);
    }
  });

  it("AC04: retries replay the original receipt across truthful settlements; meaning changes conflict", async () => {
    const primary = composeService(application!);
    const workerOperations = createPostgresOperationsPersistence(worker!.database, { now: () => now });
    const workerStore = createPostgresOwnerExportStore(worker!.database, { outbox: workerOperations.outbox });
    const replayKey = "phase8-replay-export-key-001";
    const requested = await primary.service.requestOwnerExport(command(["portfolio-content", "taxonomy"], replayKey));
    expect(requested.ok).toBe(true);
    const original = requested.ok ? requested.value : undefined;
    const originalExportId = original?.exportId;
    expect(originalExportId).toBeDefined();
    // Replay while still requested — identical regardless of scope order.
    const whileRequested = await primary.service.requestOwnerExport(command(["taxonomy", "portfolio-content"], replayKey));
    expect(whileRequested).toEqual(requested);
    expect(await primary.service.getOwnerExport({ actor, portfolioId, exportId: originalExportId! }))
      .toMatchObject({ ok: true });
    // requested → building.
    const lease = await leaseExportJob(originalExportId!);
    advance();
    expect(await applyGuardedOwnerExportTransition(workerStore, transitionInput(
      originalExportId!, "requested", "building", 1, now,
      { leaseToken: lease.leaseToken, actingJobId: lease.jobId },
    ))).toEqual({ ok: true, value: "applied" });
    expect(await primary.service.requestOwnerExport(command(["portfolio-content", "taxonomy"], replayKey))).toEqual(requested);
    expect(await primary.service.getOwnerExport({ actor, portfolioId, exportId: originalExportId! }))
      .toMatchObject({ ok: true, value: { state: "building", downloadAvailable: false } });
    // building → ready; the view turns truthful and the produced event lands once.
    advance();
    const { artifactId, snapshotId } = await checkpointTestArtifact(workerStore, originalExportId!, lease);
    const manifest = manifestFor("taxonomy", originalExportId!, snapshotId);
    expect(await applyGuardedOwnerExportTransition(workerStore, transitionInput(
      originalExportId!, "building", "ready", 2, now,
      { integrityManifest: manifest, artifactId, leaseToken: lease.leaseToken, actingJobId: lease.jobId },
    ))).toEqual({ ok: true, value: "applied" });
    expect(await primary.service.requestOwnerExport(command(["portfolio-content", "taxonomy"], replayKey)))
      .toMatchObject({ ok: true, value: { exportId: originalExportId, outcome: "owner-export-requested", state: "requested" } });
    const readyView = await primary.service.getOwnerExport({ actor, portfolioId, exportId: originalExportId! });
    expect(readyView.ok ? readyView.value.state : undefined).toBe("ready");
    if (readyView.ok && readyView.value.state === "ready") {
      expect(readyView.value.downloadAvailable).toBe(true);
      const completed = await workerStore.findOwnerExport({ exportId: originalExportId!, portfolioId, ownerId });
      expect(readyView.value.completedAt).toBe(completed?.completedAt);
      expect(readyView.value.completedAt).not.toBe(now);
    }
    expect(await countRows(
      "select count(*)::int as count from operations.outbox_events where event_type = 'portability.export_produced.v1' and aggregate_id = $1",
      [originalExportId!],
    )).toBe(1);
    const producedEvent = await admin!.query(
      "select event_type, schema_version, aggregate_id::text as aggregate_id, aggregate_version, " +
      "payload, correlation_id, causation_id, occurred_at, available_at " +
      "from operations.outbox_events " +
      "where event_type = 'portability.export_produced.v1' and aggregate_id = $1",
      [originalExportId!],
    );
    expect(producedEvent.rowCount).toBe(1);
    const event = producedEvent.rows[0];
    expect(event).toBeDefined();
    const workerProbe = new Client({ connectionString: WORKER_URL! });
    await workerProbe.connect();
    const insertProducedEvent = (payload: string, eventId: string) => workerProbe.query(
      "insert into operations.outbox_events (" +
      "event_id, event_type, schema_version, aggregate_id, aggregate_version, " +
      "payload, correlation_id, causation_id, occurred_at, available_at" +
      ") values ($1::uuid, $2, $3, $4::uuid, $5, $6::jsonb, $7, $8, $9::timestamptz, $10::timestamptz)",
      [
        eventId,
        event!["event_type"],
        event!["schema_version"],
        event!["aggregate_id"],
        event!["aggregate_version"],
        payload,
        event!["correlation_id"],
        event!["causation_id"],
        event!["occurred_at"],
        event!["available_at"],
      ],
    );
    try {
      const eventPayload = event!["payload"] as Record<string, unknown>;
      await expect(insertProducedEvent(JSON.stringify(eventPayload), randomUUID()))
        .rejects.toMatchObject({ code: "42501" });
      const reopenedJob = await admin!.query(
        "update operations.jobs " +
        "set status = 'leased', completed_at = null, lease_owner = 'phase8-duplicate-probe', " +
        "lease_token = $2, lease_expires_at = clock_timestamp() + interval '5 minutes' " +
        "where job_id = $1::uuid",
        [event!["causation_id"], randomUUID()],
      );
      expect(reopenedJob.rowCount).toBe(1);
      const eventManifest = eventPayload["manifest"] as Record<string, unknown>;
      const malformedPayload = {
        ...eventPayload,
        manifest: { ...eventManifest, checksumSha256: "f".repeat(64) },
      };
      await expect(insertProducedEvent(JSON.stringify(malformedPayload), randomUUID()))
        .rejects.toMatchObject({ code: "42501" });
      await expect(insertProducedEvent(JSON.stringify(eventPayload), randomUUID()))
        .rejects.toMatchObject({ code: "23505" });
    } finally {
      await workerProbe.end();
    }
    // ready → expired; the original request keeps replaying.
    advance();
    expect(await applyGuardedOwnerExportTransition(workerStore, transitionInput(
      originalExportId!, "ready", "expired", 3, now,
      { integrityManifest: manifest, artifactId },
    ))).toEqual({ ok: true, value: "applied" });
    expect(await primary.service.requestOwnerExport(command(["portfolio-content", "taxonomy"], replayKey)))
      .toMatchObject({ ok: true, value: { exportId: originalExportId } });
    const expiredView = await primary.service.getOwnerExport({ actor, portfolioId, exportId: originalExportId! });
    expect(expiredView.ok ? expiredView.value.state : undefined).toBe("expired");
    if (expiredView.ok && expiredView.value.state === "expired") {
      expect(expiredView.value.downloadAvailable).toBe(false);
    }
    // Changed meaning under the same key conflicts even after settlement.
    const conflicted = await primary.service.requestOwnerExport(command(["cv-metadata"], replayKey));
    expect(conflicted.ok).toBe(false);
    if (!conflicted.ok) expect(conflicted.error.code).toBe("IDEMPOTENCY_PAYLOAD_CONFLICT");

    // A failure settlement also replays the original requested receipt.
    const failedKey = "phase8-failed-export-key-001";
    const failedRequest = await primary.service.requestOwnerExport(command(["cv-metadata"], failedKey));
    expect(failedRequest.ok).toBe(true);
    const failedExportId = failedRequest.ok ? failedRequest.value.exportId : undefined;
    const failedLease = await leaseExportJob(failedExportId!);
    advance();
    expect(await applyGuardedOwnerExportTransition(workerStore, transitionInput(
      failedExportId!, "requested", "failed", 1, now,
      { failureCode: parseSafeErrorCode("ASSEMBLY_FAILED"), leaseToken: failedLease.leaseToken, actingJobId: failedLease.jobId },
    ))).toEqual({ ok: true, value: "applied" });
    expect(await primary.service.requestOwnerExport(command(["cv-metadata"], failedKey)))
      .toMatchObject({ ok: true, value: { exportId: failedExportId } });
    const failedView = await primary.service.getOwnerExport({
      actor, portfolioId, exportId: failedExportId!,
    });
    expect(failedView.ok ? [failedView.value.state, failedView.value.downloadAvailable] : undefined)
      .toEqual(["failed", false]);
    if (failedView.ok && failedView.value.state === "failed") {
      // AC08: uppercase persistence code maps explicitly to lowercase transport.
      expect(failedView.value.failureCode).toBe("assembly_failed");
      expect(failedView.value.failedAt).toBe(now);
    }
  });

  it("AC05: a forced reservation failure leaves no receipt, export, or job and frees the key", async () => {
    const primary = composeService(application!);
    const beforeExports = await ownerExportCount();
    const beforeJobs = await assemblyJobCount();
    const beforeReceipts = await receiptCount();
    const rollbackKey = "phase8-export-rollback-key-001";
    let attempts = 0;
    const failingStore: OwnerExportStorePort = {
      ...primary.store,
      async reserveOwnerExport(input, context) {
        attempts += 1;
        await primary.store.reserveOwnerExport(input, context);
        throw new Error("injected reservation failure");
      },
    };
    const failing = composeService(application!, { store: failingStore });
    const rejected = await failing.service.requestOwnerExport(command(["cv-metadata"], rollbackKey));
    expect(rejected.ok).toBe(false);
    expect(attempts).toBe(1);
    expect(await ownerExportCount()).toBe(beforeExports);
    expect(await assemblyJobCount()).toBe(beforeJobs);
    expect(await receiptCount()).toBe(beforeReceipts);
    // The freed key reserves a fresh request afterwards.
    const recovery = await primary.service.requestOwnerExport(command(["cv-metadata"], rollbackKey));
    expect(recovery.ok).toBe(true);
    expect(await ownerExportCount()).toBe(beforeExports + 1);
    expect(await assemblyJobCount()).toBe(beforeJobs + 1);
  });

  it("AC07: guarded transitions keep the metadata truthful and stale attempts never win", async () => {
    const primary = composeService(application!);
    const workerOperations = createPostgresOperationsPersistence(worker!.database, { now: () => now });
    const workerStore = createPostgresOwnerExportStore(worker!.database, { outbox: workerOperations.outbox });
    const keyed = await primary.service.requestOwnerExport(command(["cv-metadata"], "phase8-transition-export-key-001"));
    expect(keyed.ok).toBe(true);
    const exportId = keyed.ok ? keyed.value.exportId : undefined;
    const failedLease = await leaseExportJob(exportId!);
    advance();
    expect(await applyGuardedOwnerExportTransition(workerStore, transitionInput(
      exportId!, "requested", "failed", 1, now,
      { failureCode: parseSafeErrorCode("ASSEMBLY_FAILED"), leaseToken: failedLease.leaseToken, actingJobId: failedLease.jobId },
    ))).toEqual({ ok: true, value: "applied" });
    const failedView = await primary.service.getOwnerExport({ actor, portfolioId, exportId: exportId! });
    expect(failedView.ok ? failedView.value.state : undefined).toBe("failed");
    // Impossible edges lose locally without touching the store.
    expect(await applyGuardedOwnerExportTransition(workerStore, transitionInput(
      exportId!, "failed", "building", 2, now,
    ))).toMatchObject({ ok: false });
    expect(await primary.service.getOwnerExport({ actor, portfolioId, exportId: exportId! }))
      .toMatchObject({ ok: true, value: { state: "failed" } });

    // A fresh request: the stale same-edge attempt keeps the row unchanged.
    const second = await primary.service.requestOwnerExport(command(["taxonomy"], "phase8-transition-safe-export-key-001"));
    expect(second.ok).toBe(true);
    const secondId = second.ok ? second.value.exportId : undefined;
    const lease = await leaseExportJob(secondId!);
    advance();
    expect(await applyGuardedOwnerExportTransition(workerStore, transitionInput(
      secondId!, "requested", "building", 2, now,
      { leaseToken: lease.leaseToken, actingJobId: lease.jobId },
    ))).toEqual({ ok: true, value: "stale" });
    expect(await primary.service.getOwnerExport({ actor, portfolioId, exportId: secondId! }))
      .toMatchObject({ ok: true, value: { state: "requested" } });
    expect(await applyGuardedOwnerExportTransition(workerStore, transitionInput(
      secondId!, "requested", "building", 1, now,
      { leaseToken: lease.leaseToken, actingJobId: lease.jobId },
    ))).toEqual({ ok: true, value: "applied" });
    // building → ready requires exactly the readiness metadata.
    expect(await applyGuardedOwnerExportTransition(workerStore, transitionInput(
      secondId!, "building", "ready", 2, now,
      { leaseToken: lease.leaseToken, actingJobId: lease.jobId },
    ))).toMatchObject({ ok: false });
    advance();
    const unrelatedLease = await leaseUnboundAssemblyJob();
    const unrelatedSnapshot: OwnerExportConfigurationSnapshot = {
      snapshotId: createStableId("OwnerExportArtifact"),
      capturedAt: now,
      configurationVersion: null,
      settings: null,
      capabilities: { currentCvAvailable: false, externalLinksAvailable: false, globalProjectCtaAvailable: false },
    };
    expect(await workerStore.saveOwnerExportSnapshot({
      exportId: secondId!,
      actingJobId: unrelatedLease.jobId,
      leaseToken: unrelatedLease.leaseToken,
      snapshot: unrelatedSnapshot,
    })).toEqual({ ok: true, value: "stale" });
    const { artifactId, snapshotId } = await checkpointTestArtifact(workerStore, secondId!, lease);
    const manifest = manifestFor("taxonomy", secondId!, snapshotId);
    expect(await applyGuardedOwnerExportTransition(workerStore, transitionInput(
      secondId!, "building", "ready", 2, now,
      {
        integrityManifest: manifest,
        artifactId,
        leaseToken: unrelatedLease.leaseToken,
        actingJobId: unrelatedLease.jobId,
      },
    ))).toEqual({ ok: true, value: "stale" });
    expect(await primary.service.getOwnerExport({ actor, portfolioId, exportId: secondId! }))
      .toMatchObject({ ok: true, value: { state: "building" } });
    expect(await applyGuardedOwnerExportTransition(workerStore, transitionInput(
      secondId!, "building", "ready", 2, now,
      { integrityManifest: manifest, artifactId, leaseToken: lease.leaseToken, actingJobId: lease.jobId },
    ))).toEqual({ ok: true, value: "applied" });
    const readyView = await primary.service.getOwnerExport({ actor, portfolioId, exportId: secondId! });
    expect(readyView.ok ? readyView.value.state : undefined).toBe("ready");
    // The worker runtime sees the settled row truthfully on its own
    // restricted connection (worker select slice).
    const workerView = await composeService(worker!).service.getOwnerExport({ actor, portfolioId, exportId: secondId! });
    expect(workerView.ok ? workerView.value.state : undefined).toBe("ready");
    expect(await countRows(
      "select count(*)::int as count from portability.owner_exports where export_id = $1",
      [secondId!],
    )).toBe(1);
  });

  it("AC06: protected existence is uniform for cross-owner and cross-portfolio reads", async () => {
    const primary = composeService(application!);
    const scoped = await primary.service.requestOwnerExport(command(["portfolio-content"], "phase8-scope-export-key-001"));
    expect(scoped.ok).toBe(true);
    const exportId = scoped.ok ? scoped.value.exportId : undefined;
    const unknownId = createStableId("OwnerExport");
    for (const query of [
      { actor: { kind: "owner" as const, ownerId: FOREIGN_OWNER_ID }, portfolioId, exportId: exportId! },
      { actor, portfolioId: FOREIGN_PORTFOLIO_ID, exportId: exportId! },
      { actor, portfolioId, exportId: unknownId },
    ] as const) {
      const response = await primary.service.getOwnerExport(query as never);
      expect(response.ok).toBe(false);
      if (!response.ok) {
        expect(response.error).toEqual({ kind: "not_found", code: "OWNER_EXPORT_NOT_FOUND" });
      }
    }
    // The downside: any job scope aggregation mistake would expose rows; the
    // projection check confirms the DB never drifts away from the exact triple.
    const drifted = await admin!.query(
      `select count(*)::int as count from portability.owner_exports where export_id = $1 and portfolio_id <> $2`,
      [exportId!, portfolioId],
    );
    expect(drifted.rows[0]?.count).toBe(0);
  });

  it("AC08: jobs follow the assembly payload contract and carry resolved Owner identity", async () => {
    const jobs = await admin!.query(
      `select payload from operations.jobs where job_type = 'portability.owner-export-assembly.v1' and payload->>'portfolioId' = $1
       order by job_id`,
      [portfolioId],
    );
    expect(jobs.rows.length).toBeGreaterThanOrEqual(1);
    for (const row of jobs.rows) {
      const payload = row.payload as Record<string, never>;
      expect(Object.keys(payload).sort()).toEqual(["exportId", "includedScopes", "ownerId", "portfolioId"]);
      const included: string[] = payload["includedScopes"] as never;
      expect(included.length).toBeGreaterThanOrEqual(1);
      expect(new Set(included).size).toBe(included.length);
      expect(payload["ownerId"]).toBe(ownerId);
    }
  });
});
