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
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { createPostgresOwnerExportStore } from "../../src/modules/portability-operations/adapters/postgres-owner-export-store.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import {
  applyGuardedOwnerExportTransition,
  createOwnerExportAssemblyService,
  createOwnerExportService,
  OWNER_EXPORT_SCHEMA_VERSION,
  parseSafeErrorCode,
  type OwnerExportPackageManifest,
  type OwnerExportObjectReadPort,
  type OwnerExportStorePort,
  type OwnerExportTransitionInput,
} from "../../src/modules/portability-operations/index.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createPortfolioConfigurationExportSnapshotReader } from "../../src/modules/portfolio-configuration/index.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createSystemIdGenerator, type StableIdGenerator } from "../../src/runtime/ports.js";
import { createStableId, parseIdempotencyKey, parseStableId, type OwnerActor, type StableId } from "../../src/shared/domain/index.js";
import { createOwnerExportConfigurationSnapshotReader } from "../../src/runtime/adapters/owner-export-configuration-snapshot.js";
import { createSupabaseOwnerExportStorage } from "../../src/runtime/adapters/supabase-owner-export-storage.js";
import type { PortfolioSettings } from "../../src/modules/portfolio-configuration/domain/index.js";
import type { OwnerExportConfigurationSnapshot } from "../../src/modules/portability-operations/application/owner-export-package.js";
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
const OPERATION_SCOPE = `portability.owner-export-request:${portfolioId}`;
let now = "2026-10-23T09:00:00.000Z";
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
    if (request.headers.apikey !== "phase8-isolated-storage-key" ||
        request.headers.authorization !== "Bearer phase8-isolated-storage-key") {
      response.writeHead(401).end();
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
      const bytes = objects.get(path);
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

function configurationSettings(contactLabel: string): PortfolioSettings {
  return {
    portfolioId,
    version: 1,
    profile: {
      displayName: "Snapshot Ada",
      headline: "Systems builder",
      bio: "The retained configuration.",
      mediaAssetId: createStableId("MediaAsset"),
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
      await admin?.query("delete from portability.owner_exports where owner_id = any($1::uuid[])", [[ownerId, FOREIGN_OWNER_ID]]);
      await admin?.query("delete from portfolio_config.contact_channels where portfolio_id in (select portfolio_id from portfolio_config.settings where owner_id = any($1::uuid[]))", [[ownerId, FOREIGN_OWNER_ID]]);
      await admin?.query("delete from portfolio_config.settings where owner_id = any($1::uuid[])", [[ownerId, FOREIGN_OWNER_ID]]);
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

    let racedUpdate: unknown;
    const snapshots = storedConfigurationSnapshotReader({
      mutateConfigurationAfterCapture: async () => {
        racedUpdate = await application!.transactions.run((context) =>
          settingsRepository.updateContactChannels(scope, [{
            channel: "email",
            label: "Email v2",
            destination: "mailto:ada@example.test",
            availableLocales: ["en", "ar"],
          }], 1, context));
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
        snapshots,
        storage,
        clock: { now: () => now },
        ids: createSystemIdGenerator(),
      });
      const request = await primary.service.requestOwnerExport(command(["portfolio-configuration"], "phase8-config-export-e2e-001"));
      expect(request.ok).toBe(true);
      if (!request.ok) return;

      expect(await assembly.runOwnerExportAssembly({ workerId: "phase8-config-export-worker" }))
        .toMatchObject({ ok: true, value: { claimed: 1, completed: 1, retried: 0, failed: 0 } });
      expect(racedUpdate).toMatchObject({ ok: true, value: { aggregateVersion: 2 } });
      const persisted = await workerStore.findOwnerExport({ exportId: request.value.exportId, ...scope });
      expect(persisted).toMatchObject({
        status: "ready",
        schemaVersion: OWNER_EXPORT_SCHEMA_VERSION,
        snapshot: {
          configurationVersion: 1,
          settings: { contactChannels: [{ label: "Email v1" }] },
        },
        integrityManifest: {
          schemaVersion: "1.2",
          extensions: { configurationSnapshot: { aggregateVersion: 1 } },
        },
      });

      const firstDownload = await primary.service.downloadOwnerExport({ actor, portfolioId, exportId: request.value.exportId });
      expect(firstDownload.ok).toBe(true);
      if (!firstDownload.ok) return;
      const firstBytes = await readAll(firstDownload.value.content);
      const validated = validateOwnerExportZip(firstBytes);
      expect(validated.manifest.schemaVersion).toBe("1.2");
      expect(validated.manifest.extensions).toMatchObject({
        configurationSnapshot: { aggregateVersion: 1, availableLocales: ["ar", "en"] },
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
            policyExpiresAt: new Date(Date.parse(now) + 86400_000).toISOString(),
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

      expect(await assembly.runOwnerExportAssembly({ workerId: "phase8-config-retry-worker" }))
        .toMatchObject({ ok: true, value: { claimed: 1, retried: 1, completed: 0 } });
      expect(await baseStore.findOwnerExport({ exportId, ...scope })).toMatchObject({ status: "building" });
      await makeAssemblyJobDue(exportId);

      expect(await assembly.runOwnerExportAssembly({ workerId: "phase8-config-retry-worker" }))
        .toMatchObject({ ok: true, value: { claimed: 1, retried: 1, completed: 0 } });
      const checkpointed = await baseStore.findOwnerExport({ exportId, ...scope });
      expect(checkpointed).toMatchObject({ status: "building", snapshot: { configurationVersion: 2 } });
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
      expect(Date.parse(completed!.expiresAt!) - Date.parse(completed!.completedAt!)).toBe(86400_000);
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

  it("AC09: fails an unsupported requested scope without manufacturing a ready package", async () => {
    const primary = composeService(application!);
    const workerOperations = createPostgresOperationsPersistence(worker!.database, { now: () => now });
    const workerStore = createPostgresOwnerExportStore(worker!.database, { outbox: workerOperations.outbox });
    let storageCalls = 0;
    const assembly = createOwnerExportAssemblyService({
      operations: workerOperations,
      exports: workerStore,
      snapshots: { async capture() { throw new Error("unsupported selection must not capture"); } },
      storage: {
        async writeOwnerExport() { storageCalls += 1; return { ok: true as const, value: undefined }; },
        async readOwnerExport() { storageCalls += 1; return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "OWNER_EXPORT_ARTIFACT_UNAVAILABLE" } }; },
      },
      clock: { now: () => now },
      ids: createSystemIdGenerator(),
    });
    const request = await primary.service.requestOwnerExport(command(["taxonomy"], "phase8-config-export-unsupported-001"));
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    expect(await assembly.runOwnerExportAssembly({ workerId: "phase8-config-unsupported-worker" }))
      .toMatchObject({ ok: true, value: { claimed: 1, failed: 1, completed: 0 } });
    expect(await workerStore.findOwnerExport({ exportId: request.value.exportId, portfolioId, ownerId }))
      .toMatchObject({ status: "failed", failureCode: "OWNER_EXPORT_SCOPE_UNSUPPORTED" });
    expect(storageCalls).toBe(0);
  });

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
    expect(await receiptCount()).toBe(1);
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
    expect(await applyGuardedOwnerExportTransition(primary.store, transitionInput(
      originalExportId!, "requested", "building", 1, now,
      { leaseToken: lease.leaseToken, actingJobId: lease.jobId },
    ))).toEqual({ ok: true, value: "applied" });
    expect(await primary.service.requestOwnerExport(command(["portfolio-content", "taxonomy"], replayKey))).toEqual(requested);
    expect(await primary.service.getOwnerExport({ actor, portfolioId, exportId: originalExportId! }))
      .toMatchObject({ ok: true, value: { state: "building", downloadAvailable: false } });
    // building → ready; the view turns truthful and the produced event lands once.
    advance();
    const { artifactId, snapshotId } = await checkpointTestArtifact(primary.store, originalExportId!, lease);
    const manifest = manifestFor("taxonomy", originalExportId!, snapshotId);
    expect(await applyGuardedOwnerExportTransition(primary.store, transitionInput(
      originalExportId!, "building", "ready", 2, now,
      { integrityManifest: manifest, artifactId, leaseToken: lease.leaseToken, actingJobId: lease.jobId },
    ))).toEqual({ ok: true, value: "applied" });
    expect(await primary.service.requestOwnerExport(command(["portfolio-content", "taxonomy"], replayKey)))
      .toMatchObject({ ok: true, value: { exportId: originalExportId, outcome: "owner-export-requested", state: "requested" } });
    const readyView = await primary.service.getOwnerExport({ actor, portfolioId, exportId: originalExportId! });
    expect(readyView.ok ? readyView.value.state : undefined).toBe("ready");
    if (readyView.ok && readyView.value.state === "ready") {
      expect(readyView.value.downloadAvailable).toBe(true);
      expect(readyView.value.completedAt).toBe(now);
    }
    expect(await countRows(
      "select count(*)::int as count from operations.outbox_events where event_type = 'portability.export_produced.v1' and aggregate_id = $1",
      [originalExportId!],
    )).toBe(1);
    // ready → expired; the original request keeps replaying.
    advance();
    expect(await applyGuardedOwnerExportTransition(primary.store, transitionInput(
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
    expect(await applyGuardedOwnerExportTransition(primary.store, transitionInput(
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
    const keyed = await primary.service.requestOwnerExport(command(["cv-metadata"], "phase8-transition-export-key-001"));
    expect(keyed.ok).toBe(true);
    const exportId = keyed.ok ? keyed.value.exportId : undefined;
    const failedLease = await leaseExportJob(exportId!);
    advance();
    expect(await applyGuardedOwnerExportTransition(primary.store, transitionInput(
      exportId!, "requested", "failed", 1, now,
      { failureCode: parseSafeErrorCode("ASSEMBLY_FAILED"), leaseToken: failedLease.leaseToken, actingJobId: failedLease.jobId },
    ))).toEqual({ ok: true, value: "applied" });
    const failedView = await primary.service.getOwnerExport({ actor, portfolioId, exportId: exportId! });
    expect(failedView.ok ? failedView.value.state : undefined).toBe("failed");
    // Impossible edges lose locally without touching the store.
    expect(await applyGuardedOwnerExportTransition(primary.store, transitionInput(
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
    expect(await applyGuardedOwnerExportTransition(primary.store, transitionInput(
      secondId!, "requested", "building", 2, now,
      { leaseToken: lease.leaseToken, actingJobId: lease.jobId },
    ))).toEqual({ ok: true, value: "stale" });
    expect(await primary.service.getOwnerExport({ actor, portfolioId, exportId: secondId! }))
      .toMatchObject({ ok: true, value: { state: "requested" } });
    expect(await applyGuardedOwnerExportTransition(primary.store, transitionInput(
      secondId!, "requested", "building", 1, now,
      { leaseToken: lease.leaseToken, actingJobId: lease.jobId },
    ))).toEqual({ ok: true, value: "applied" });
    // building → ready requires exactly the readiness metadata.
    expect(await applyGuardedOwnerExportTransition(primary.store, transitionInput(
      secondId!, "building", "ready", 2, now,
      { leaseToken: lease.leaseToken, actingJobId: lease.jobId },
    ))).toMatchObject({ ok: false });
    advance();
    const { artifactId, snapshotId } = await checkpointTestArtifact(primary.store, secondId!, lease);
    const manifest = manifestFor("taxonomy", secondId!, snapshotId);
    expect(await applyGuardedOwnerExportTransition(primary.store, transitionInput(
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
