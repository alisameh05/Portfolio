import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Client } from "pg";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPostgresOwnerExportStore } from "../../src/modules/portability-operations/adapters/postgres-owner-export-store.js";
import { createOwnerExportArtifactCleanupService } from "../../src/modules/portability-operations/application/owner-export-cleanup.js";
import { createOwnerExportAssemblyService, createOwnerExportService } from "../../src/modules/portability-operations/index.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createPostgresContentAuthoringRepository } from "../../src/modules/content-publishing/adapters/postgres-authoring.js";
import { createOwnerExportSnapshotReader } from "../../src/runtime/adapters/owner-export-snapshot.js";
import { createSupabaseOwnerExportStorage } from "../../src/runtime/adapters/supabase-owner-export-storage.js";
import { createPhase7DueWorkWorker } from "../../src/bootstrap/phase7-due-work-worker.js";
import { createPostgresDailyAggregateRepository } from "../../src/modules/measurement/adapters/postgres-daily-aggregates.js";
import { createDailyAggregateWorkService } from "../../src/modules/measurement/application/daily-aggregates.js";
import { createPostgresMeasurementRetentionRepository } from "../../src/modules/measurement/adapters/postgres-retention.js";
import { createMeasurementRetentionWorkService } from "../../src/modules/measurement/application/retention.js";
import { createPostgresFeedbackRetentionRepository } from "../../src/modules/interaction-moderation/adapters/postgres-retention.js";
import { createFeedbackRetentionWorkService } from "../../src/modules/interaction-moderation/application/retention.js";
import { createPhase7DueWorkService } from "../../src/runtime/phase7-due-work.js";
import { parseIdempotencyKey, parseStableId, type Rejection, type Result, type StableId } from "../../src/shared/domain/index.js";
import type { BoundedWorkResult } from "../../src/shared/application/index.js";
import type { MeasurementWorkCommand } from "../../src/modules/measurement/index.js";
import type { PortfolioSettings } from "../../src/modules/portfolio-configuration/domain/index.js";

const WORKER_URL = process.env["PHASE7_JOBS_WORKER_URL"];
const SECOND_WORKER_URL = process.env["PHASE7_JOBS_SECOND_WORKER_URL"] ?? WORKER_URL;
const ADMIN_URL = process.env["PHASE7_JOBS_ADMIN_URL"];
const APPLICATION_URL = process.env["PHASE7_JOBS_APPLICATION_URL"];
const LEGACY_URL = process.env["PHASE7_JOBS_LEGACY_URL"];
const portfolioId = "0196a1b2-7c3d-7e11-9f22-000000000003" as StableId<"Portfolio">;
const otherPortfolioId = "0196a1b2-7c3d-7e11-9f22-000000000004" as StableId<"Portfolio">;
let duePeriod: string;
let admin: Client | undefined;
let application: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
let worker: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
let workerTwo: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
let legacyWorker: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
let sequence = 100;
const isolatedStorageServers: Server[] = [];
const ownerFixturePortfolios: StableId<"Portfolio">[] = [];
const ownerFixtureAssemblyExports: StableId<"OwnerExport">[] = [];

function id<T extends string>(kind: T): StableId<T> {
  const generated = createSystemIdGenerator().generate(kind);
  const parsed = parseStableId(kind, generated);
  if (!parsed.ok) throw new Error("PHASE8_SCHEDULE_TEST_ID_INVALID");
  return parsed.value;
}

function idempotencyKey(value: string) {
  const parsed = parseIdempotencyKey(value);
  if (!parsed.ok) throw new Error("PHASE8_OWNER_EXPORT_IDEMPOTENCY_KEY_INVALID");
  return parsed.value;
}

function testConfigurationSettings(portfolioId: StableId<"Portfolio">): PortfolioSettings {
  return {
    portfolioId,
    version: 1,
    profile: { displayName: "Retention barrier owner", headline: "Worker acceptance", bio: "Private configuration snapshot." },
    contactChannels: [{ channel: "email", label: "Email", destination: "mailto:owner@example.test", availableLocales: ["en"] }],
    globalCta: { label: "Contact", destination: "https://example.test/contact", unavailableFallback: "Email us" },
  };
}

async function startIsolatedOwnerStorage(): Promise<{ readonly server: Server; readonly baseUrl: string; readonly objects: Map<string, Uint8Array>; readonly requests: string[] }> {
  const objects = new Map<string, Uint8Array>();
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(`${request.method ?? "GET"} ${path}`);
    if (request.headers["apikey"] !== "phase8-isolated-storage-key" ||
        request.headers["authorization"] !== "Bearer phase8-isolated-storage-key") {
      response.writeHead(401).end(); return;
    }
    if (request.method === "DELETE" && path === "/storage/v1/object/owner-exports") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { prefixes: string[] };
      for (const prefix of body.prefixes) objects.delete(`${path}/${prefix}`);
      response.writeHead(200, { "content-type": "application/json" }).end("[]"); return;
    }
    if (request.method === "POST") {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) chunks.push(new Uint8Array(chunk));
      const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      objects.set(path, bytes);
      response.writeHead(200).end(); return;
    }
    if (request.method === "GET") {
      const bytes = objects.get(path);
      if (bytes === undefined) { response.writeHead(404, { "content-type": "application/json" }).end('{"code":"NoSuchKey"}'); return; }
      response.writeHead(200, { "content-type": "application/vnd.shipwithali.owner-export+zip", "content-length": String(bytes.byteLength) }).end(bytes);
      return;
    }
    response.writeHead(405).end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("PHASE8_ISOLATED_STORAGE_LISTEN_FAILED");
  isolatedStorageServers.push(server);
  return { server, baseUrl: `http://127.0.0.1:${address.port}`, objects, requests };
}

function makeActualOwnerAssembly(appDb: NonNullable<typeof application>, workerDb: NonNullable<typeof worker>,
  scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> }, now: () => string,
  storage: ReturnType<typeof createSupabaseOwnerExportStorage>) {
  const appOperations = createPostgresOperationsPersistence(appDb.database, { now });
  const appStore = createPostgresOwnerExportStore(appDb.database, { outbox: appOperations.outbox });
  const requestService = createOwnerExportService({ operations: appOperations, exports: appStore,
    clock: { now }, ids: createSystemIdGenerator() });
  const workerOperations = createPostgresOperationsPersistence(workerDb.database, { now });
  const workerStore = createPostgresOwnerExportStore(workerDb.database, { outbox: workerOperations.outbox });
  const settings = createPostgresPortfolioSettingsRepository();
  const snapshots = createOwnerExportSnapshotReader({ configuration: settings,
    content: createPostgresContentAuthoringRepository(), transactions: workerDb.transactions,
    capabilities: { async read() { return { currentCvAvailable: false, externalLinksAvailable: false }; } } });
  const cleanup = createOwnerExportArtifactCleanupService({ scope, artifacts: workerStore, snapshots, storage });
  const assembly = createOwnerExportAssemblyService({ operations: workerOperations, exports: workerStore,
    artifacts: workerStore, snapshots, cleanup, storage, clock: { now }, ids: createSystemIdGenerator() });
  return { requestService, workerOperations, workerStore, assembly, settings };
}

const retentionTypes = ["measurement.detail-retention.v1", "measurement.aggregate-retention.v1",
  "measurement.withdrawal-cleanup.v1", "interaction.feedback-retention.v1"] as const;

async function seedRetentionBarrier(scope: StableId<"Portfolio">) {
  const operations = createPostgresOperationsPersistence(worker!.database);
  const now = `${duePeriod}T00:00:00.000Z`;
  await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope, fromPeriod: duePeriod, throughPeriod: duePeriod });
  const jobs = new Map<string, StableId<"Job">>();
  for (const jobType of retentionTypes) {
    const jobId = id("Job");
    jobs.set(jobType, jobId);
    const inserted = await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, {
      jobId, payload: { type: jobType, version: 1, value: {} }, availableAt: `${duePeriod}T00:00:00.000Z`,
      semanticSchedule: { portfolioId: scope, period: duePeriod },
    }));
    if (!inserted) throw new Error("PHASE8_RETENTION_BARRIER_ENQUEUE_FAILED");
  }
  const advanced = await operations.jobs.advancePhase7RetentionSchedule({ portfolioId: scope,
    expectedNextPeriod: duePeriod, scheduledThroughPeriod: duePeriod });
  if (!advanced) throw new Error("PHASE8_RETENTION_BARRIER_CURSOR_FAILED");
  const completedJobIds = [...jobs.entries()].filter(([jobType]) => jobType !== "measurement.withdrawal-cleanup.v1")
    .map(([, jobId]) => jobId);
  await admin!.query(`update operations.jobs set status='completed',completed_at=clock_timestamp(),lease_owner=null,
    lease_token=null,lease_expires_at=null where job_id=any($1::uuid[])`, [completedJobIds]);
  return { operations, withdrawalJobId: jobs.get("measurement.withdrawal-cleanup.v1")!, now };
}

let rolloverTodayPeriod: string;
let rolloverPreviousPeriod: string;
let rolloverOlderPeriod: string;
let rolloverToday: string;

function testUtcOffset(day: string, offset: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

async function seedRolloverAggregateBacklog(scope: StableId<"Portfolio">) {
  const operations = createPostgresOperationsPersistence(worker!.database);
  await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope, fromPeriod: rolloverOlderPeriod,
    throughPeriod: rolloverPreviousPeriod });
  const periods = [rolloverOlderPeriod, rolloverPreviousPeriod];
  for (const period of periods) for (const jobType of retentionTypes) {
    await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, { jobId: id("Job"),
      payload: { type: jobType, version: 1, value: {} }, availableAt: `${period}T00:00:00.000Z`,
      semanticSchedule: { portfolioId: scope, period } }));
  }
  expect(await operations.jobs.advancePhase7RetentionSchedule({ portfolioId: scope,
    expectedNextPeriod: rolloverOlderPeriod, scheduledThroughPeriod: rolloverPreviousPeriod })).toBe(true);
  await admin!.query(`update operations.jobs set status='completed',completed_at=clock_timestamp(),
    lease_owner=null,lease_token=null,lease_expires_at=null where semantic_scope_id=$1 and job_type=any($2::text[])`,
  [scope, retentionTypes]);
  const afterRetention = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope,
    fromPeriod: rolloverOlderPeriod, throughPeriod: rolloverPreviousPeriod });
  expect(afterRetention).toMatchObject({ phase: "aggregate", retentionCompleteThrough: rolloverPreviousPeriod });

  let holeJobId: StableId<"Job"> | undefined;
  for (const period of periods) for (let offset = -14; offset <= 0; offset += 1) {
    const utcDay = testUtcOffset(period, offset);
    const jobId = id("Job");
    if (period === rolloverOlderPeriod && offset === -14) holeJobId = jobId;
    await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, { jobId,
      payload: { type: "measurement.daily-aggregate.v1", version: 1, value: { utcDay } },
      availableAt: `${period}T00:00:00.000Z`, semanticSchedule: { portfolioId: scope, period: `${period}:${utcDay}` } }));
  }
  if (!holeJobId) throw new Error("PHASE8_ROLLOVER_AGGREGATE_HOLE_MISSING");
  expect(await operations.jobs.advancePhase7AggregateSchedule({ portfolioId: scope,
    expectedNextPeriod: rolloverOlderPeriod, scheduledThroughPeriod: rolloverPreviousPeriod })).toBe(true);
  await admin!.query(`update operations.jobs set status='completed',completed_at=clock_timestamp(),
    lease_owner=null,lease_token=null,lease_expires_at=null where semantic_scope_id=$1
      and job_type='measurement.daily-aggregate.v1' and job_id<>$2`, [scope, holeJobId]);
  const beforeRollover = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope,
    fromPeriod: rolloverOlderPeriod, throughPeriod: rolloverPreviousPeriod });
  expect(beforeRollover).toMatchObject({ phase: "aggregate", requiredThroughPeriod: rolloverPreviousPeriod,
    retentionCompleteThrough: rolloverPreviousPeriod, oldestOverduePeriod: rolloverOlderPeriod });
  return { operations, holeJobId };
}

async function makeOwnerExportFixture(scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> },
  now: string, seedExpiredArtifact: boolean) {
  ownerFixturePortfolios.push(scope.portfolioId);
  const objectServer = await startIsolatedOwnerStorage();
  const storage = createSupabaseOwnerExportStorage({ storageUrl: objectServer.baseUrl, serviceRoleKey: "phase8-isolated-storage-key" });
  const settings = createPostgresPortfolioSettingsRepository();
  const provisioned = await application!.transactions.run(context => settings.provisionSettings(scope,
    testConfigurationSettings(scope.portfolioId), context));
  expect(provisioned.ok).toBe(true);
  const services = makeActualOwnerAssembly(application!, workerTwo!, scope, () => now, storage);
  const actor = { kind: "owner" as const, ownerId: scope.ownerId, sessionId: `phase8-owner-fixture-${sequence++}` };
  let expiredObjectPath: string | undefined;
  let expiredExportId: StableId<"OwnerExport"> | undefined;
  let queuedExportId: StableId<"OwnerExport"> | undefined;
  if (seedExpiredArtifact) {
    const original = await services.requestService.requestOwnerExport({ actor, portfolioId: scope.portfolioId,
      idempotencyKey: idempotencyKey(`phase8-rollover-expired-${sequence++}`), includedScopes: ["portfolio-configuration"] });
    expect(original.ok).toBe(true);
    if (!original.ok) throw new Error("PHASE8_OWNER_FIXTURE_INITIAL_REQUEST_FAILED");
    expiredExportId = original.value.exportId;
    ownerFixtureAssemblyExports.push(original.value.exportId);
    // This fixture exercises retention ordering, so its Owner job must already
    // be due by PostgreSQL time even when the synthetic policy clock is ahead.
    await admin!.query(`update operations.jobs set available_at=clock_timestamp()-interval '1 millisecond'
      where job_type='portability.owner-export-assembly.v1' and status='available' and payload->>'exportId'=$1`,
    [original.value.exportId]);
    const initialAssembly = await services.assembly.runOwnerExportAssembly({ workerId: "phase8-owner-fixture-initial" });
    expect(initialAssembly).toMatchObject({ ok: true, value: { claimed: 1, completed: 1, retried: 0, failed: 0 } });
    const artifact = await services.workerStore.findOwnerExport({ exportId: original.value.exportId, ...scope });
    expect(artifact).toMatchObject({ status: "ready", candidateArtifactId: expect.any(String) });
    expiredObjectPath = `/storage/v1/object/owner-exports/${scope.portfolioId}/${original.value.exportId}/${artifact!.candidateArtifactId}.zip`;
    expect(objectServer.objects.has(expiredObjectPath)).toBe(true);
    await admin!.query("update portability.owner_exports set expires_at='2000-01-01T00:00:00Z' where export_id=$1", [original.value.exportId]);
    const queued = await services.requestService.requestOwnerExport({ actor, portfolioId: scope.portfolioId,
      idempotencyKey: idempotencyKey(`phase8-rollover-queued-${sequence++}`), includedScopes: ["portfolio-configuration"] });
    expect(queued.ok).toBe(true);
    if (!queued.ok) throw new Error("PHASE8_OWNER_FIXTURE_QUEUED_REQUEST_FAILED");
    queuedExportId = queued.value.exportId;
    ownerFixtureAssemblyExports.push(queued.value.exportId);
    await admin!.query(`update operations.jobs set available_at=clock_timestamp()-interval '1 millisecond'
      where job_type='portability.owner-export-assembly.v1' and status='available' and payload->>'exportId'=$1`,
    [queued.value.exportId]);
  }
  return { objectServer, storage, services, actor, expiredObjectPath, expiredExportId, queuedExportId };
}

function makeDueWorkService(db: NonNullable<typeof worker>, scope: StableId<"Portfolio">, now: () => string, hooks: {
  readonly onAggregate?: () => void;
  readonly cleanWithdrawnConsent?: (command: MeasurementWorkCommand,
    execute: (command: MeasurementWorkCommand) => Promise<Result<BoundedWorkResult, Rejection>>) => Promise<Result<BoundedWorkResult, Rejection>>;
  readonly afterRetentionEffect?: () => void;
  readonly onDetailRetention?: () => void;
  readonly ownerExports?: { runOwnerExportAssembly(input: { readonly workerId: string }): Promise<{
    readonly ok: true; readonly value: { readonly claimed: number; readonly completed: number; readonly retried: number;
      readonly failed: number; readonly staleLeases: number; readonly cleanup?: { readonly scanned: number; readonly deleted: number;
        readonly pending: number; readonly incomplete: boolean } };
  }> };
} = {}) {
  const operations = createPostgresOperationsPersistence(db.database, { now });
  const daily = createDailyAggregateWorkService({ portfolioId: scope, transactions: db.transactions,
    repository: createPostgresDailyAggregateRepository() });
  const retention = createMeasurementRetentionWorkService({ portfolioId: scope, transactions: db.transactions,
    repository: createPostgresMeasurementRetentionRepository() });
  const feedback = createFeedbackRetentionWorkService({ portfolioId: scope, transactions: db.transactions,
    repository: createPostgresFeedbackRetentionRepository() });
  const measurement = { ...daily, ...retention,
    expireDetail: async (command: MeasurementWorkCommand) => {
      const result = await retention.expireDetail(command);
      if (result.ok) hooks.onDetailRetention?.();
      hooks.afterRetentionEffect?.(); return result;
    },
    expireAggregates: async (command: MeasurementWorkCommand) => {
      const result = await retention.expireAggregates(command); hooks.afterRetentionEffect?.(); return result;
    },
    aggregateDay: async (command: Parameters<typeof daily.aggregateDay>[0]) => {
      hooks.onAggregate?.(); return daily.aggregateDay(command);
    },
    cleanWithdrawnConsent: async (command: MeasurementWorkCommand) => {
      const result = hooks.cleanWithdrawnConsent
        ? await hooks.cleanWithdrawnConsent(command, retention.cleanWithdrawnConsent)
        : await retention.cleanWithdrawnConsent(command);
      hooks.afterRetentionEffect?.(); return result;
    },
  };
  const service = createPhase7DueWorkService({ portfolioId: scope, clock: { now }, ids: createSystemIdGenerator(), operations,
    measurement, interaction: { ...feedback, expireFeedback: async (command: Parameters<typeof feedback.expireFeedback>[0]) => {
      const result = await feedback.expireFeedback(command); hooks.afterRetentionEffect?.(); return result;
    } },
    ownerExports: hooks.ownerExports ?? { runOwnerExportAssembly: async () => ({ ok: true as const, value: {
      claimed: 0, completed: 0, retried: 0, failed: 0, staleLeases: 0,
      cleanup: { scanned: 0, deleted: 0, pending: 0, incomplete: false },
    } }) },
  });
  return service;
}

function makeComposedDueWorkService(db: NonNullable<typeof worker>, scope: StableId<"Portfolio">, now: () => string,
  ownerAssembly: ReturnType<typeof createOwnerExportAssemblyService>) {
  const operations = createPostgresOperationsPersistence(db.database, { now });
  return createPhase7DueWorkWorker({ portfolioId: scope, operations, ownerExports: ownerAssembly,
    clock: { now }, ids: createSystemIdGenerator() });
}

describe.runIf(Boolean(WORKER_URL && SECOND_WORKER_URL && ADMIN_URL && APPLICATION_URL && LEGACY_URL))("Phase 8 durable scheduled job keys (#248)", () => {
  beforeAll(async () => {
    if (!WORKER_URL || !SECOND_WORKER_URL || !ADMIN_URL || !APPLICATION_URL || !LEGACY_URL) throw new Error("PHASE8_SCHEDULE_DATABASE_REQUIRED");
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const databaseClock = await admin.query<{ database_now: string; database_day: string }>(`with current_clock as (
      select clock_timestamp() as instant
    ) select to_char(instant at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as database_now,
             to_char(instant at time zone 'UTC','YYYY-MM-DD') as database_day from current_clock`);
    rolloverToday = databaseClock.rows[0]?.database_now ?? "";
    duePeriod = databaseClock.rows[0]?.database_day ?? "";
    if (!rolloverToday || !duePeriod || rolloverToday.slice(0, 10) !== duePeriod) {
      throw new Error("PHASE8_DATABASE_UTC_CLOCK_UNAVAILABLE");
    }
    rolloverTodayPeriod = duePeriod;
    rolloverPreviousPeriod = testUtcOffset(rolloverTodayPeriod, -1);
    rolloverOlderPeriod = testUtcOffset(rolloverTodayPeriod, -2);
    application = createPostgresRuntimeDatabase(APPLICATION_URL);
    worker = createPostgresRuntimeDatabase(WORKER_URL);
    workerTwo = createPostgresRuntimeDatabase(SECOND_WORKER_URL);
    legacyWorker = createPostgresRuntimeDatabase(LEGACY_URL);
  });

  afterEach(async () => {
    const exportIds = ownerFixtureAssemblyExports.splice(0);
    if (admin && exportIds.length > 0) {
      await admin.query(`delete from operations.jobs
        where job_type='portability.owner-export-assembly.v1' and payload->>'exportId'=any($1::text[])`, [exportIds]);
    }
  });

  afterAll(async () => {
    if (admin && ownerFixturePortfolios.length > 0) {
      await admin.query(`delete from operations.outbox_events where event_type='portability.export_produced.v1' and aggregate_id in
        (select export_id from portability.owner_exports where portfolio_id=any($1::uuid[]))`, [ownerFixturePortfolios]);
    }
    await application?.resource.close();
    await worker?.resource.close();
    await workerTwo?.resource.close();
    await legacyWorker?.resource.close();
    await admin?.end();
    for (const server of isolatedStorageServers) {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("deduplicates concurrent triggers by Portfolio/type/due-period and retains truthful scoped status", async () => {
    const first = createPostgresOperationsPersistence(worker!.database);
    const second = createPostgresOperationsPersistence(workerTwo!.database);
    const firstJobId = id("Job");
    const duplicateJobId = id("Job");
    const otherPortfolioJobId = id("Job");
    const now = new Date().toISOString();
    const payload = { type: "interaction.feedback-retention.v1", version: 1, value: {} } as const;
    const enqueue = (operations: ReturnType<typeof createPostgresOperationsPersistence>, jobId: StableId<"Job">,
      scope: StableId<"Portfolio">) => operations.transactions.run(transaction => operations.jobs.enqueue(transaction, {
        jobId, payload, availableAt: now, semanticSchedule: { portfolioId: scope, period: duePeriod },
      }));

    const duplicateResults = await Promise.all([
      enqueue(first, firstJobId, portfolioId),
      enqueue(second, duplicateJobId, portfolioId),
    ]);
    expect(duplicateResults.sort()).toEqual([false, true]);
    expect(await enqueue(second, otherPortfolioJobId, otherPortfolioId)).toBe(true);
    expect((await admin!.query(`select count(*)::integer as count from operations.jobs
      where job_type='interaction.feedback-retention.v1' and semantic_period=$1 and semantic_scope_id=any($2::uuid[])`,
    [duePeriod, [portfolioId, otherPortfolioId]])).rows)
      .toEqual([{ count: 2 }]);

    const claim = { now, leaseDurationSeconds: 300, limit: 1, jobTypes: ["interaction.feedback-retention.v1"],
      semanticScopeId: portfolioId };
    const concurrentClaims = await Promise.all([
      first.jobs.claimDue({ ...claim, workerId: "retention-worker-a" }),
      second.jobs.claimDue({ ...claim, workerId: "retention-worker-b" }),
    ]);
    const leases = concurrentClaims.flat();
    expect(leases).toHaveLength(1);
    expect(leases[0]?.semanticSchedule).toEqual({ portfolioId, period: duePeriod });
    expect(await first.jobs.complete(leases[0]!.jobId, leases[0]!.leaseToken, now, true)).toBe(true);

    const status = await first.jobs.getPhase7ScheduleStatus({ portfolioId, fromPeriod: duePeriod, throughPeriod: duePeriod });
    expect(status).toEqual({
      jobs: [{ jobType: "interaction.feedback-retention.v1", period: duePeriod, status: "completed", coverageIncomplete: true }],
      firstPolicyPeriod: duePeriod,
      requiredThroughPeriod: duePeriod,
      retentionScheduledThrough: testUtcOffset(duePeriod, -1),
      retentionCompleteThrough: testUtcOffset(duePeriod, -1),
      aggregateScheduledThrough: testUtcOffset(duePeriod, -1),
      lastCompletePolicyPeriod: null,
      phase: "retention",
      oldestOverduePeriod: duePeriod,
      oldestUnfinishedPeriod: duePeriod,
      oldestCoverageIncompletePeriod: duePeriod,
      failedCount: 0,
    });
    const otherStatus = await first.jobs.getPhase7ScheduleStatus({ portfolioId: otherPortfolioId,
      fromPeriod: duePeriod, throughPeriod: duePeriod });
    expect(otherStatus.jobs).toEqual([{ jobType: "interaction.feedback-retention.v1", period: duePeriod,
      status: "available", coverageIncomplete: false }]);
  });

  it("keeps unscheduled legacy producers and consumers valid for application rollback", async () => {
    const operations = createPostgresOperationsPersistence(worker!.database);
    const jobId = id("Job");
    const now = new Date().toISOString();
    await expect(operations.transactions.run(transaction => operations.jobs.enqueue(transaction, {
      jobId, payload: { type: "legacy.schedule.compatibility.v1", version: 1, value: {} }, availableAt: now,
    }))).resolves.toBe(true);
    const claimed = await operations.jobs.claimDue({ workerId: "legacy-consumer", now, leaseDurationSeconds: 60,
      limit: 1, jobTypes: ["legacy.schedule.compatibility.v1"] });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.semanticSchedule).toBeUndefined();
    expect(await operations.jobs.complete(jobId, claimed[0]!.leaseToken, now)).toBe(true);
    expect((await admin!.query("select status,semantic_scope_id,semantic_period,work_incomplete from operations.jobs where job_id=$1", [jobId])).rows)
      .toEqual([{ status: "completed", semantic_scope_id: null, semantic_period: null, work_incomplete: false }]);
  });

  it("does not dispatch Owner assembly or schedule aggregates when shutdown arrives after retention is complete", async () => {
    const scope = id("Portfolio");
    const now = `${duePeriod}T12:00:00.000Z`;
    const { withdrawalJobId } = await seedRetentionBarrier(scope);
    await admin!.query("update operations.jobs set status='completed',completed_at=clock_timestamp() where job_id=$1", [withdrawalJobId]);
    const operations = createPostgresOperationsPersistence(worker!.database);
    const ready = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope, fromPeriod: duePeriod, throughPeriod: duePeriod });
    expect(ready.phase).toBe("aggregate");
    let ownerDispatches = 0;
    const ownerExports = { runOwnerExportAssembly: async () => {
      ownerDispatches += 1;
      return { ok: true as const, value: { claimed: 0, completed: 0, retried: 0, failed: 0, staleLeases: 0 } };
    } };
    const service = makeDueWorkService(worker!, scope, () => now, { ownerExports });
    const stopped = await service.runDueWork({ workerId: "shutdown-after-retention", shouldStop: () => true });
    expect(stopped).toMatchObject({ ok: true, value: { incomplete: true, incompleteBacklog: true,
      scheduled: 0, claimed: 0, ownerExportAssembly: null, incompleteOwnerExports: true } });
    expect(ownerDispatches).toBe(0);
    expect((await admin!.query(`select count(*)::integer as count from operations.jobs where semantic_scope_id=$1
      and job_type='measurement.daily-aggregate.v1'`, [scope])).rows).toEqual([{ count: 0 }]);
  });

  it("observes shutdown raised by the final retention effect before dependent Owner or aggregate work", async () => {
    const scope = id("Portfolio");
    const now = `${duePeriod}T12:00:00.000Z`;
    const { withdrawalJobId } = await seedRetentionBarrier(scope);
    const ready = await createPostgresOperationsPersistence(worker!.database).jobs.getPhase7ScheduleStatus({
      portfolioId: scope, fromPeriod: duePeriod, throughPeriod: duePeriod,
    });
    expect(ready.phase).toBe("retention");
    let stopped = false, ownerDispatches = 0;
    const service = makeDueWorkService(worker!, scope, () => now, {
      cleanWithdrawnConsent: async (command, execute) => {
        const result = await execute(command);
        if (result.ok && result.value.nextCursor === null) stopped = true;
        return result;
      },
      ownerExports: { runOwnerExportAssembly: async () => {
        ownerDispatches += 1;
        return { ok: true as const, value: { claimed: 0, completed: 0, retried: 0, failed: 0, staleLeases: 0 } };
      } },
    });
    const result = await service.runDueWork({ workerId: "shutdown-final-retention-effect", maxClaimsPerPhase: 61, shouldStop: () => stopped });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`PHASE8_FINAL_RETENTION_STOP_RESULT:${JSON.stringify(result)}`);
    expect(result.value.claimed).toBeGreaterThan(0);
    expect(result.value.completed).toBe(1);
    expect(result.value.incompleteBacklog).toBe(true);
    expect(result.value.ownerExportAssembly).toBeNull();
    expect(result.value.incompleteOwnerExports).toBe(true);
    expect(stopped).toBe(true);
    expect(ownerDispatches).toBe(0);
    expect((await admin!.query("select status from operations.jobs where job_id=$1", [withdrawalJobId])).rows)
      .toEqual([{ status: "completed" }]);
    expect((await admin!.query(`select count(*)::integer as count from operations.jobs where semantic_scope_id=$1
      and job_type='measurement.daily-aggregate.v1'`, [scope])).rows).toEqual([{ count: 0 }]);
  });

  it("holds aggregation and Owner export dispatch behind a withdrawal transaction leased by another worker", async () => {
    const scope = id("Portfolio"), subject = id("MeasurementVisitor"), consentId = id("Consent");
    const eventId = id("PublicEvent"), routeId = id("PublicRoute");
    const { withdrawalJobId, now } = await seedRetentionBarrier(scope);
    const runNow = new Date().toISOString();
    await admin!.query(`insert into measurement.consents
      (portfolio_id,consent_id,subject,state,notice_version,revision,recorded_at,evidence_expires_at)
      values ($1,$2,$3,'denied','2026-10',2,$4::timestamptz,$4::timestamptz+interval '30 days')`,
    [scope, consentId, subject, now]);
    await admin!.query(`insert into measurement.consent_history
      (portfolio_id,consent_id,revision,state,notice_version,recorded_at)
      values ($1,$2,2,'denied','2026-10',$3::timestamptz)`, [scope, consentId, now]);
    await admin!.query(`insert into measurement.public_events
      (event_id,portfolio_id,measurement_subject,action,occurred_at,accepted_at,effective_at,page_route_identity,
       project_id,locale,consent_version)
      values ($1,$2,$3,'page-viewed',$4::timestamptz,$4::timestamptz,$4::timestamptz,$5,null,'en','2026-10')`,
    [eventId, scope, subject, now, routeId]);

    const lockKey = sequence++;
    const functionName = `phase8_hold_withdrawal_${lockKey}`;
    const triggerName = `phase8_hold_withdrawal_${lockKey}`;
    await admin!.query(`create function public.${functionName}() returns trigger language plpgsql as $$
      begin if old.event_id = '${eventId}'::uuid then perform pg_advisory_xact_lock(248, ${lockKey}); end if; return old; end $$`);
    await admin!.query(`create trigger ${triggerName} before delete on measurement.public_events
      for each row execute function public.${functionName}()`);
    const blocker = new Client({ connectionString: ADMIN_URL });
    await blocker.connect();
    await blocker.query("select pg_advisory_lock(248,$1)", [lockKey]);

    let reportWithdrawalStarted!: () => void;
    let reportWithdrawalCommitted!: () => void;
    const withdrawalStarted = new Promise<void>(resolve => { reportWithdrawalStarted = resolve; });
    const withdrawalCommitted = new Promise<void>(resolve => { reportWithdrawalCommitted = resolve; });
    let committed = false;
    const aggregateSawCommit: boolean[] = [];
    const ownerDispatchFromSecond = vi.fn(async () => ({ ok: true as const,
      value: { claimed: 0, completed: 0, retried: 0, failed: 0, staleLeases: 0 } }));
    const serviceA = makeDueWorkService(worker!, scope, () => runNow, {
      cleanWithdrawnConsent: async (command, execute) => {
        reportWithdrawalStarted();
        const result = await execute(command);
        if (result.ok && result.value.nextCursor === null) { committed = true; reportWithdrawalCommitted(); }
        return result;
      },
      onAggregate: () => aggregateSawCommit.push(committed),
    });
    const runA = serviceA.runDueWork({ workerId: "withdrawal-worker-a" });
    let runB: Awaited<ReturnType<typeof serviceA.runDueWork>> | undefined;
    try {
      await withdrawalStarted;
      let waitingOnDelete = false;
      for (let attempt = 0; attempt < 100 && !waitingOnDelete; attempt += 1) {
        const activity = await admin!.query(`select 1 from pg_stat_activity
          where datname=current_database() and usename='due_work_worker_runtime'
            and wait_event_type='Lock' and wait_event='advisory'
            and query ilike '%delete from measurement.public_events%' limit 1`);
        waitingOnDelete = activity.rowCount === 1;
        if (!waitingOnDelete) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waitingOnDelete).toBe(true);

      const serviceB = makeDueWorkService(workerTwo!, scope, () => runNow, { ownerExports: { runOwnerExportAssembly: ownerDispatchFromSecond,
        }, onAggregate: () => aggregateSawCommit.push(committed) });
      runB = await serviceB.runDueWork({ workerId: "withdrawal-worker-b" });
      expect(runB).toMatchObject({ ok: true, value: { incomplete: true, incompleteBacklog: true } });
      expect(aggregateSawCommit).toEqual([]);
      expect(ownerDispatchFromSecond).not.toHaveBeenCalled();
      expect((await admin!.query("select status from operations.jobs where job_id=$1", [withdrawalJobId])).rows)
        .toEqual([{ status: "leased" }]);
    } finally {
      await blocker.query("select pg_advisory_unlock(248,$1)", [lockKey]);
      await blocker.end();
    }
    await withdrawalCommitted;
    const resultA = await runA;
    expect(resultA).toMatchObject({ ok: true, value: { ownerExportAssembly: { completed: 0 }, incompleteOwnerExports: false } });
    expect(committed).toBe(true);
    expect(aggregateSawCommit.length).toBe(15);
    expect(aggregateSawCommit.every(Boolean)).toBe(true);
    expect((await admin!.query("select 1 from measurement.public_events where event_id=$1", [eventId])).rows).toHaveLength(0);
    expect((await admin!.query(`select count(*)::integer as count from operations.jobs where semantic_scope_id=$1
      and job_type='measurement.daily-aggregate.v1' and semantic_period like $2`, [scope, `${duePeriod}:%`])).rows)
      .toEqual([{ count: 15 }]);
    await admin!.query(`drop trigger ${triggerName} on measurement.public_events; drop function public.${functionName}()`);
  }, 60_000);

  it("runs the composed Portability cleanup and assembly only after the real retention barrier commits", async () => {
    if (!APPLICATION_URL) throw new Error("PHASE8_OWNER_EXPORT_APPLICATION_DATABASE_REQUIRED");
    const scope = { portfolioId: id("Portfolio"), ownerId: id("Owner") };
    ownerFixturePortfolios.push(scope.portfolioId);
    const subject = id("MeasurementVisitor"), consentId = id("Consent"), eventId = id("PublicEvent"), routeId = id("PublicRoute");
    const { withdrawalJobId, now } = await seedRetentionBarrier(scope.portfolioId);
    const runNow = new Date().toISOString();
    await admin!.query(`insert into measurement.consents
      (portfolio_id,consent_id,subject,state,notice_version,revision,recorded_at,evidence_expires_at)
      values ($1,$2,$3,'denied','2026-10',2,$4::timestamptz,$4::timestamptz+interval '30 days')`,
    [scope.portfolioId, consentId, subject, now]);
    await admin!.query(`insert into measurement.consent_history
      (portfolio_id,consent_id,revision,state,notice_version,recorded_at)
      values ($1,$2,2,'denied','2026-10',$3::timestamptz)`, [scope.portfolioId, consentId, now]);
    await admin!.query(`insert into measurement.public_events
      (event_id,portfolio_id,measurement_subject,action,occurred_at,accepted_at,effective_at,page_route_identity,
       project_id,locale,consent_version)
      values ($1,$2,$3,'page-viewed',$4::timestamptz,$4::timestamptz,$4::timestamptz,$5,null,'en','2026-10')`,
    [eventId, scope.portfolioId, subject, now, routeId]);

    const objectServer = await startIsolatedOwnerStorage();
    const storage = createSupabaseOwnerExportStorage({ storageUrl: objectServer.baseUrl, serviceRoleKey: "phase8-isolated-storage-key" });
    const moduleSettings = createPostgresPortfolioSettingsRepository();
    const provisioned = await application!.transactions.run(context => moduleSettings.provisionSettings(scope,
      testConfigurationSettings(scope.portfolioId), context));
    expect(provisioned.ok).toBe(true);
    const ownerServices = makeActualOwnerAssembly(application!, workerTwo!, scope, () => runNow, storage);
    const actor = { kind: "owner" as const, ownerId: scope.ownerId, sessionId: "phase8-retention-barrier" };
    const originalRequest = await ownerServices.requestService.requestOwnerExport({ actor, portfolioId: scope.portfolioId,
      idempotencyKey: idempotencyKey("phase8-retention-barrier-expired-001"), includedScopes: ["portfolio-configuration"] });
    expect(originalRequest.ok).toBe(true);
    if (!originalRequest.ok) throw new Error("PHASE8_BARRIER_OWNER_EXPORT_INITIAL_REQUEST_FAILED");
    expect(await ownerServices.assembly.runOwnerExportAssembly({ workerId: "phase8-barrier-initial-owner" }))
      .toMatchObject({ ok: true, value: { claimed: 1, completed: 1, retried: 0, failed: 0 } });
    const originalRow = await ownerServices.workerStore.findOwnerExport({ exportId: originalRequest.value.exportId, ...scope });
    expect(originalRow).toMatchObject({ status: "ready", candidateArtifactId: expect.any(String) });
    const originalObjectPath = `/storage/v1/object/owner-exports/${scope.portfolioId}/${originalRequest.value.exportId}/${originalRow!.candidateArtifactId}.zip`;
    expect(objectServer.objects.has(originalObjectPath)).toBe(true);
    await admin!.query("update portability.owner_exports set expires_at='2000-01-01T00:00:00Z' where export_id=$1", [originalRequest.value.exportId]);

    const queuedRequest = await ownerServices.requestService.requestOwnerExport({ actor, portfolioId: scope.portfolioId,
      idempotencyKey: idempotencyKey("phase8-retention-barrier-queued-002"), includedScopes: ["portfolio-configuration"] });
    expect(queuedRequest.ok).toBe(true);
    if (!queuedRequest.ok) throw new Error("PHASE8_BARRIER_OWNER_EXPORT_QUEUED_REQUEST_FAILED");

    const lockKey = sequence++;
    const functionName = `phase8_hold_owner_withdrawal_${lockKey}`;
    const triggerName = `phase8_hold_owner_withdrawal_${lockKey}`;
    await admin!.query(`create function public.${functionName}() returns trigger language plpgsql as $$
      begin if old.event_id = '${eventId}'::uuid then perform pg_advisory_xact_lock(248, ${lockKey}); end if; return old; end $$`);
    await admin!.query(`create trigger ${triggerName} before delete on measurement.public_events
      for each row execute function public.${functionName}()`);
    const blocker = new Client({ connectionString: ADMIN_URL });
    await blocker.connect();
    await blocker.query("select pg_advisory_lock(248,$1)", [lockKey]);
    const workerAssemblyA = makeActualOwnerAssembly(application!, worker!, scope, () => runNow, storage).assembly;
    const workerAssemblyB = makeActualOwnerAssembly(application!, workerTwo!, scope, () => runNow, storage).assembly;
    const serviceA = makeComposedDueWorkService(worker!, scope.portfolioId, () => runNow, workerAssemblyA);
    let runA: ReturnType<typeof serviceA.runDueWork> | undefined;
    try {
      runA = serviceA.runDueWork({ workerId: "phase8-owner-barrier-a" });
      let waitingOnDelete = false;
      for (let attempt = 0; attempt < 100 && !waitingOnDelete; attempt += 1) {
        const activity = await admin!.query(`select 1 from pg_stat_activity
          where datname=current_database() and usename='due_work_worker_runtime'
            and wait_event_type='Lock' and wait_event='advisory'
            and query ilike '%delete from measurement.public_events%' limit 1`);
        waitingOnDelete = activity.rowCount === 1;
        if (!waitingOnDelete) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waitingOnDelete).toBe(true);

      const workerB = makeComposedDueWorkService(workerTwo!, scope.portfolioId, () => runNow, workerAssemblyB);
      const held = await workerB.runDueWork({ workerId: "phase8-owner-barrier-b" });
      expect(held).toMatchObject({ ok: true, value: { incomplete: true, incompleteBacklog: true,
        ownerExportAssembly: null, incompleteOwnerExports: false } });
      expect((await admin!.query("select status from operations.jobs where job_type='portability.owner-export-assembly.v1' and payload->>'exportId'=$1",
        [queuedRequest.value.exportId])).rows).toEqual([{ status: "available" }]);
      expect((await admin!.query("select status,artifact_revoked_at,artifact_deleted_at from portability.owner_exports where export_id=$1",
        [originalRequest.value.exportId])).rows).toEqual([{ status: "ready", artifact_revoked_at: null, artifact_deleted_at: null }]);
      expect(objectServer.objects.has(originalObjectPath)).toBe(true);
      expect(objectServer.requests.filter(request => request.startsWith("DELETE "))).toHaveLength(0);
      expect((await admin!.query("select count(*)::integer as count from operations.jobs where semantic_scope_id=$1 and job_type='measurement.daily-aggregate.v1'",
        [scope.portfolioId])).rows).toEqual([{ count: 0 }]);
    } finally {
      await blocker.query("select pg_advisory_unlock(248,$1)", [lockKey]);
      await blocker.end();
    }

    const completed = await runA!;
    if (!completed.ok || completed.value.ownerExportAssembly?.claimed !== 1 || completed.value.ownerExportAssembly.completed !== 1 ||
        completed.value.ownerExportAssembly.cleanup?.deleted !== 1) {
      throw new Error(`PHASE8_COMPOSED_OWNER_BARRIER_RESULT_UNEXPECTED:${JSON.stringify(completed)}`);
    }
    expect(completed).toMatchObject({ ok: true, value: { ownerExportAssembly: {
      claimed: 1, completed: 1, retried: 0, failed: 0, cleanup: { scanned: 1, deleted: 1, pending: 0, incomplete: false },
    } } });
    expect((await admin!.query("select status,artifact_revocation_code,artifact_deleted_at from portability.owner_exports where export_id=$1",
      [originalRequest.value.exportId])).rows[0]).toMatchObject({ status: "expired", artifact_revocation_code: "expired", artifact_deleted_at: expect.any(Date) });
    expect((await admin!.query("select status,artifact_id::text from portability.owner_exports where export_id=$1",
      [queuedRequest.value.exportId])).rows).toMatchObject([{ status: "ready", artifact_id: expect.any(String) }]);
    expect(objectServer.objects.has(originalObjectPath)).toBe(false);
    expect(objectServer.objects.size).toBe(1);
    expect(objectServer.requests.some(request => request.startsWith("DELETE "))).toBe(true);
    expect((await admin!.query("select count(*)::integer as count from operations.jobs where semantic_scope_id=$1 and job_type='measurement.daily-aggregate.v1'",
      [scope.portfolioId])).rows).toEqual([{ count: 15 }]);
    await admin!.query(`drop trigger ${triggerName} on measurement.public_events; drop function public.${functionName}()`);
    await new Promise<void>(resolve => objectServer.server.close(() => resolve()));
  }, 60_000);

  it("serializes Owner cleanup and assembly admission with a concurrently advanced retention horizon", async () => {
    const scope = { portfolioId: id("Portfolio"), ownerId: id("Owner") };
    const priorRunNow = `${rolloverPreviousPeriod}T12:00:00.000Z`;
    const currentRunNow = rolloverToday;
    const nextPolicyPeriod = testUtcOffset(rolloverTodayPeriod, 1);
    const { operations, holeJobId } = await seedRolloverAggregateBacklog(scope.portfolioId);
    await admin!.query(`update operations.jobs set status='leased',lease_owner='owner-admission-aggregate-holder',
      lease_token='owner-admission-aggregate-token',lease_expires_at=clock_timestamp()+interval '10 minutes'
      where job_id=$1`, [holeJobId]);
    const owner = await makeOwnerExportFixture(scope, currentRunNow, true);
    if (!owner.expiredObjectPath || !owner.expiredExportId || !owner.queuedExportId) {
      throw new Error("PHASE8_OWNER_ADMISSION_FIXTURE_INCOMPLETE");
    }
    const requestsBeforeRace = owner.objectServer.requests.length;
    const subject = id("MeasurementVisitor"), consentId = id("Consent"), eventId = id("PublicEvent"), eventRouteId = id("PublicRoute");
    const withdrawalJobId = id("Job");
    let reportStatusRead!: () => void;
    const statusReadAt = new Promise<void>(resolve => { reportStatusRead = resolve; });
    let resumeStatusRead!: () => void;
    const resumeA = new Promise<void>(resolve => { resumeStatusRead = resolve; });
    let statusReads = 0;
    let statusAtPause: Awaited<ReturnType<typeof operations.jobs.getPhase7ScheduleStatusAtDatabaseCurrentPeriod>> | undefined;
    const firstOperations = createPostgresOperationsPersistence(worker!.database);
    const pausedOperations = {
      ...firstOperations,
      jobs: {
        ...firstOperations.jobs,
        getPhase7ScheduleStatusAtDatabaseCurrentPeriod: async (input: { portfolioId: StableId<"Portfolio">; fromPeriod: string; throughPeriod: string }) => {
          const status = await firstOperations.jobs.getPhase7ScheduleStatusAtDatabaseCurrentPeriod(input);
          statusReads += 1;
          if (statusReads === 2) {
            statusAtPause = status;
            reportStatusRead();
            await resumeA;
          }
          return status;
        },
      },
    };
    const ownerDispatchA = vi.fn(async (input: { readonly workerId: string }) => owner.services.assembly.runOwnerExportAssembly(input));
    const serviceA = createPhase7DueWorkWorker({ portfolioId: scope.portfolioId, operations: pausedOperations,
      ownerExports: { runOwnerExportAssembly: ownerDispatchA }, clock: { now: () => priorRunNow }, ids: createSystemIdGenerator() });
    const runA = serviceA.runDueWork({ workerId: "owner-admission-stale-snapshot-a" });
    try {
      await statusReadAt;
      expect(statusAtPause).toMatchObject({ requiredThroughPeriod: rolloverTodayPeriod,
        retentionCompleteThrough: rolloverTodayPeriod });
      const eventAt = `${rolloverPreviousPeriod}T12:00:00.000Z`;
      const delayedUntil = `${nextPolicyPeriod}T00:10:00.000Z`;
      await admin!.query(`insert into measurement.consents
        (portfolio_id,consent_id,subject,state,notice_version,revision,recorded_at,evidence_expires_at)
        values ($1,$2,$3,'denied',$5,2,$4::timestamptz,$4::timestamptz+interval '30 days')`,
      [scope.portfolioId, consentId, subject, eventAt, rolloverTodayPeriod.slice(0, 7)]);
      await admin!.query(`insert into measurement.consent_history
        (portfolio_id,consent_id,revision,state,notice_version,recorded_at)
        values ($1,$2,2,'denied',$4,$3::timestamptz)`, [scope.portfolioId, consentId, eventAt, rolloverTodayPeriod.slice(0, 7)]);
      await admin!.query(`insert into measurement.public_events
        (event_id,portfolio_id,measurement_subject,action,occurred_at,accepted_at,effective_at,page_route_identity,
         project_id,locale,consent_version)
        values ($1,$2,$3,'page-viewed',$4::timestamptz,$4::timestamptz,$4::timestamptz,$5,null,'en',$6)`,
      [eventId, scope.portfolioId, subject, eventAt, eventRouteId, rolloverTodayPeriod.slice(0, 7)]);
      await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, { jobId: withdrawalJobId,
        payload: { type: "measurement.withdrawal-cleanup.v1", version: 1, value: {} }, availableAt: delayedUntil,
        semanticSchedule: { portfolioId: scope.portfolioId, period: nextPolicyPeriod } }));

      const nextRunClock = `${nextPolicyPeriod}T00:05:00.000Z`;
      const noDispatchByB = vi.fn(async () => ({ ok: true as const, value: {
        claimed: 0, completed: 0, retried: 0, failed: 0, staleLeases: 0,
        cleanup: { scanned: 0, deleted: 0, pending: 0, incomplete: false },
      } }));
      const serviceB = makeDueWorkService(workerTwo!, scope.portfolioId, () => nextRunClock,
        { ownerExports: { runOwnerExportAssembly: noDispatchByB } });
      const afterHorizonAdvance = await serviceB.runDueWork({ workerId: "owner-admission-horizon-advance-b" });
      expect(afterHorizonAdvance).toMatchObject({ ok: true, value: { incomplete: true, incompleteBacklog: true,
        ownerExportAssembly: null, incompleteOwnerExports: false } });
      expect(noDispatchByB).not.toHaveBeenCalled();
      const afterB = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope.portfolioId,
        fromPeriod: testUtcOffset(rolloverTodayPeriod, -14), throughPeriod: rolloverTodayPeriod });
      expect(afterB).toMatchObject({ requiredThroughPeriod: nextPolicyPeriod,
        retentionScheduledThrough: nextPolicyPeriod, retentionCompleteThrough: rolloverTodayPeriod, phase: "retention" });
      const futureRetention = await admin!.query(`select job_type,status,available_at>clock_timestamp() as database_not_before
        from operations.jobs where semantic_scope_id=$1 and semantic_period=$2 and job_type=any($3::text[]) order by job_type`,
      [scope.portfolioId, nextPolicyPeriod, retentionTypes]);
      expect(futureRetention.rows).toHaveLength(retentionTypes.length);
      expect(futureRetention.rows.every(row => row.status === "available" && row.database_not_before)).toBe(true);
      expect((await admin!.query("select status from operations.jobs where job_id=$1", [withdrawalJobId])).rows)
        .toEqual([{ status: "available" }]);
      expect((await admin!.query("select count(*)::integer as count from measurement.public_events where event_id=$1", [eventId])).rows)
        .toEqual([{ count: 1 }]);
      expect((await admin!.query("select status,artifact_revoked_at,artifact_deleted_at from portability.owner_exports where export_id=$1",
        [owner.expiredExportId])).rows).toEqual([{ status: "ready", artifact_revoked_at: null, artifact_deleted_at: null }]);
      expect((await admin!.query("select status from operations.jobs where job_type='portability.owner-export-assembly.v1' and payload->>'exportId'=$1",
        [owner.queuedExportId])).rows).toEqual([{ status: "available" }]);
    } finally {
      resumeStatusRead();
    }
    const staleA = await runA;
    expect(staleA).toMatchObject({ ok: true, value: { incomplete: true, incompleteBacklog: true,
      ownerExportAssembly: null, incompleteOwnerExports: false } });
    expect(ownerDispatchA).not.toHaveBeenCalled();
    expect(owner.objectServer.requests.slice(requestsBeforeRace)).toEqual([]);
    expect(owner.objectServer.objects.has(owner.expiredObjectPath)).toBe(true);
    expect((await admin!.query(`select count(*)::integer as count from operations.jobs where semantic_scope_id=$1
      and job_type='measurement.daily-aggregate.v1' and semantic_period like $2`,
    [scope.portfolioId, `${nextPolicyPeriod}:%`])).rows).toEqual([{ count: 0 }]);
    await admin!.query(`update operations.jobs set status='available',lease_owner=null,lease_token=null,lease_expires_at=null
      where job_id=$1`, [holeJobId]);
  }, 60_000);

  it("reopens the retention horizon when PostgreSQL advances beyond the worker clock and holds dependent work until current-day retention completes", async () => {
    const databaseDay = (await admin!.query<{ database_day: string }>(`select to_char((clock_timestamp() at time zone 'UTC')::date,
      'YYYY-MM-DD') as database_day`)).rows[0]?.database_day;
    if (!databaseDay) throw new Error("PHASE8_DATABASE_UTC_DAY_UNAVAILABLE");
    const priorPolicyDay = testUtcOffset(databaseDay, -1);
    const laggingWorkerClock = `${priorPolicyDay}T23:59:59.000Z`;
    const scope = id("Portfolio");
    const operations = createPostgresOperationsPersistence(worker!.database);
    const admissionScope = id("Portfolio");

    const seedStaleProgress = async (portfolioId: typeof scope) => {
      // The legacy read seeds a prior-day row without refreshing the database-current horizon.
      const stale = await operations.jobs.getPhase7ScheduleStatus({ portfolioId,
        fromPeriod: priorPolicyDay, throughPeriod: priorPolicyDay });
      expect(stale.requiredThroughPeriod).toBe(priorPolicyDay);
      await admin!.query(`update operations.phase7_schedule_progress set
        first_policy_period=$2::date,required_through_period=$2::date,
        retention_scheduled_through=$2::date,retention_complete_through=$2::date,
        aggregate_scheduled_through=$2::date,aggregate_finished_through=$2::date,
        last_complete_period=$2::date,phase='aggregate' where portfolio_id=$1`, [portfolioId, priorPolicyDay]);
    };

    await seedStaleProgress(scope);
    await seedStaleProgress(admissionScope);
    // Admission independently refreshes a different stale scope and denies dependent work.
    expect(await operations.jobs.admitPhase7DependentWork({ portfolioId: admissionScope })).toBe(false);
    expect((await admin!.query(`select to_char(required_through_period,'YYYY-MM-DD') as required_through,
      phase from operations.phase7_schedule_progress where portfolio_id=$1`, [admissionScope])).rows)
      .toEqual([{ required_through: databaseDay, phase: "retention" }]);

    const withdrawalJobId = id("Job");
    await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, { jobId: withdrawalJobId,
      payload: { type: "measurement.withdrawal-cleanup.v1", version: 1, value: {} },
      availableAt: `${databaseDay}T00:00:00.000Z`, semanticSchedule: { portfolioId: scope, period: databaseDay },
    }));
    const held = await operations.jobs.claimDue({ workerId: "lagging-clock-retention-holder", now: laggingWorkerClock,
      leaseDurationSeconds: 600, limit: 1, jobTypes: ["measurement.withdrawal-cleanup.v1"], semanticScopeId: scope });
    expect(held).toHaveLength(1);

    const ownerDispatch = vi.fn(async () => ({ ok: true as const, value: {
      claimed: 0, completed: 0, retried: 0, failed: 0, staleLeases: 0,
      cleanup: { scanned: 0, deleted: 0, pending: 0, incomplete: false },
    } }));
    const aggregateDispatch = vi.fn();
    const service = makeDueWorkService(worker!, scope, () => laggingWorkerClock, {
      onAggregate: aggregateDispatch, ownerExports: { runOwnerExportAssembly: ownerDispatch },
    });
    const blocked = await service.runDueWork({ workerId: "lagging-clock-retention-run" });
    expect(blocked).toMatchObject({ ok: true, value: { incomplete: true, incompleteBacklog: true,
      oldestOverduePeriod: databaseDay, ownerExportAssembly: null } });
    expect(ownerDispatch).not.toHaveBeenCalled();
    expect(aggregateDispatch).not.toHaveBeenCalled();

    expect((await admin!.query(`select to_char(required_through_period,'YYYY-MM-DD') as required_through,
      to_char(retention_scheduled_through,'YYYY-MM-DD') as retention_scheduled_through,
      to_char(retention_complete_through,'YYYY-MM-DD') as retention_complete_through,phase
      from operations.phase7_schedule_progress where portfolio_id=$1`, [scope])).rows)
      .toEqual([{ required_through: databaseDay, retention_scheduled_through: databaseDay,
        retention_complete_through: priorPolicyDay, phase: "retention" }]);
    const blockedRetentionRows = (await admin!.query(`select job_type,status from operations.jobs
      where semantic_scope_id=$1 and semantic_period=$2 and job_type=any($3::text[]) order by job_type`,
    [scope, databaseDay, retentionTypes])).rows;
    expect(blockedRetentionRows).toHaveLength(retentionTypes.length);
    expect(blockedRetentionRows.find(row => row.job_type === "measurement.withdrawal-cleanup.v1")).toMatchObject({ status: "leased" });
    expect(blockedRetentionRows.filter(row => row.job_type !== "measurement.withdrawal-cleanup.v1")
      .every(row => row.status === "completed")).toBe(true);
    expect((await admin!.query(`select count(*)::integer as count from operations.jobs
      where semantic_scope_id=$1 and job_type='measurement.daily-aggregate.v1' and semantic_period like $2`,
    [scope, `${databaseDay}:%`])).rows).toEqual([{ count: 0 }]);

    expect(await operations.jobs.release(held[0]!.jobId, held[0]!.leaseToken)).toBe(true);
    const resumed = await service.runDueWork({ workerId: "lagging-clock-retention-resume" });
    expect(resumed).toMatchObject({ ok: true, value: { incomplete: false, lastCompletePolicyPeriod: databaseDay,
      oldestOverduePeriod: null } });
    expect(ownerDispatch).toHaveBeenCalledTimes(1);
    expect(aggregateDispatch).toHaveBeenCalledTimes(15);
    expect((await admin!.query(`select to_char(required_through_period,'YYYY-MM-DD') as required_through,
      to_char(retention_complete_through,'YYYY-MM-DD') as retention_complete_through,
      to_char(aggregate_scheduled_through,'YYYY-MM-DD') as aggregate_scheduled_through,
      to_char(last_complete_period,'YYYY-MM-DD') as last_complete_policy_period
      from operations.phase7_schedule_progress where portfolio_id=$1`, [scope])).rows)
      .toEqual([{ required_through: databaseDay, retention_complete_through: databaseDay,
        aggregate_scheduled_through: databaseDay, last_complete_policy_period: databaseDay }]);
  }, 60_000);

  it.each(["held by another worker", "retry-delayed", "dead"] as const)(
    "reopens the retention barrier at day rollover with an older aggregate hole and a %s withdrawal",
    async blocker => {
      const scope = { portfolioId: id("Portfolio"), ownerId: id("Owner") };
      const { operations, holeJobId } = await seedRolloverAggregateBacklog(scope.portfolioId);
      const owner = await makeOwnerExportFixture(scope, rolloverToday, true);
      if (!owner.expiredObjectPath || !owner.expiredExportId || !owner.queuedExportId) throw new Error("PHASE8_ROLLOVER_OWNER_FIXTURE_INCOMPLETE");
      const withdrawalJobId = id("Job");
      const databaseDay = (await admin!.query<{ database_day: string }>(`select to_char((clock_timestamp() at time zone 'UTC')::date,
        'YYYY-MM-DD') as database_day`)).rows[0]?.database_day;
      if (!databaseDay) throw new Error("PHASE8_DATABASE_UTC_DAY_UNAVAILABLE");
      const retryAt = blocker === "retry-delayed" ? `${testUtcOffset(databaseDay, 1)}T00:10:00.000Z` : rolloverToday;
      await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, { jobId: withdrawalJobId,
        payload: { type: "measurement.withdrawal-cleanup.v1", version: 1, value: {} },
        availableAt: blocker === "retry-delayed" ? retryAt : rolloverToday,
        semanticSchedule: { portfolioId: scope.portfolioId, period: rolloverTodayPeriod } }));
      let heldLease: { readonly jobId: string; readonly leaseToken: string } | undefined;
      if (blocker === "held by another worker") {
        const claimed = await operations.jobs.claimDue({ workerId: "rollover-withdrawal-holder", now: rolloverToday,
          leaseDurationSeconds: 600, limit: 1, jobTypes: ["measurement.withdrawal-cleanup.v1"],
          semanticScopeId: scope.portfolioId });
        expect(claimed).toHaveLength(1);
        heldLease = claimed[0];
      } else if (blocker === "retry-delayed") {
        await admin!.query(`update operations.jobs set attempt_count=1,last_error_code='PHASE7_WORK_FAILED'
          where job_id=$1`, [withdrawalJobId]);
      } else {
        await admin!.query(`update operations.jobs set status='dead',attempt_count=5,last_error_code='PHASE7_WORK_FAILED'
          where job_id=$1`, [withdrawalJobId]);
      }
      if (blocker === "retry-delayed") {
        const retryBoundary = await admin!.query(`select available_at>clock_timestamp() as database_not_before,
          (available_at at time zone 'UTC')::date > (clock_timestamp() at time zone 'UTC')::date as next_utc_day
          from operations.jobs where job_id=$1`, [withdrawalJobId]);
        expect(retryBoundary.rows).toEqual([{ database_not_before: true, next_utc_day: true }]);
      }
      const before = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope.portfolioId,
        fromPeriod: rolloverPreviousPeriod, throughPeriod: rolloverPreviousPeriod });
      expect(before).toMatchObject({ requiredThroughPeriod: rolloverPreviousPeriod, phase: "aggregate" });

      const ownerDispatch = vi.fn(async () => ({ ok: true as const, value: {
        claimed: 0, completed: 0, retried: 0, failed: 0, staleLeases: 0,
        cleanup: { scanned: 0, deleted: 0, pending: 0, incomplete: false },
      } }));
      const aggregateDispatch = vi.fn();
      const blocked = await makeDueWorkService(worker!, scope.portfolioId, () => rolloverToday, {
        onAggregate: aggregateDispatch, ownerExports: { runOwnerExportAssembly: ownerDispatch },
      }).runDueWork({ workerId: `rollover-blocked-${blocker.replaceAll(" ", "-")}` });
      const afterBlocked = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope.portfolioId,
        fromPeriod: testUtcOffset(rolloverTodayPeriod, -14), throughPeriod: rolloverTodayPeriod });
      const blockedRetentionRows = (await admin!.query(`select job_type,status from operations.jobs where semantic_scope_id=$1
        and semantic_period=$2 and job_type=any($3::text[]) order by job_type`,
      [scope.portfolioId, rolloverTodayPeriod, retentionTypes])).rows;
      const blockedHoleRows = (await admin!.query("select status from operations.jobs where job_id=$1", [holeJobId])).rows;
      const blockedOwnerRows = (await admin!.query(`select status from operations.jobs where job_type='portability.owner-export-assembly.v1'
        and payload->>'exportId'=$1`, [owner.queuedExportId])).rows;
      const initialExpired = await admin!.query("select status,artifact_deleted_at from portability.owner_exports where export_id=$1",
        [owner.expiredExportId]);
      const blockedAggregateRows = (await admin!.query("select count(*)::integer as count from measurement.daily_aggregates where portfolio_id=$1",
        [scope.portfolioId])).rows;
      const blockedCurrentAggregateJobs = (await admin!.query(`select count(*)::integer as count from operations.jobs
        where semantic_scope_id=$1 and job_type='measurement.daily-aggregate.v1' and semantic_period like $2`,
      [scope.portfolioId, `${rolloverTodayPeriod}:%`])).rows;
      const blockedObjectStillPresent = owner.objectServer.objects.has(owner.expiredObjectPath);
      const blockedDeletes = owner.objectServer.requests.filter(request => request.startsWith("DELETE ")).length;

      if (heldLease) {
        expect(await operations.jobs.release(heldLease.jobId, heldLease.leaseToken)).toBe(true);
      } else if (blocker === "retry-delayed") {
        // Keep the worker on the original policy day; cross only PostgreSQL's
        // not-before boundary explicitly, without sleeping or changing horizons.
        await admin!.query("update operations.jobs set available_at=clock_timestamp()-interval '1 millisecond' where job_id=$1",
          [withdrawalJobId]);
        expect((await admin!.query("select available_at<=clock_timestamp() as database_due from operations.jobs where job_id=$1",
          [withdrawalJobId])).rows).toEqual([{ database_due: true }]);
      } else {
        const dead = await operations.jobs.getDeadForRedrive(withdrawalJobId);
        if (!dead) throw new Error("PHASE8_ROLLOVER_WITHDRAWAL_DEAD_JOB_MISSING");
        const payload = { type: dead.payload.type, version: dead.payload.version, value: dead.payload.value };
        const redriven = await operations.jobs.redriveDead({ originalJobId: withdrawalJobId,
          replacementJobId: id("Job"), operatorScopeHash: "b".repeat(64), policyVersion: "phase7-handlers-v1",
          payloadSha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex") });
        expect(redriven).not.toBeNull();
      }
      const resumed = await makeComposedDueWorkService(worker!, scope.portfolioId, () => rolloverToday, owner.services.assembly)
        .runDueWork({ workerId: `rollover-resume-${blocker.replaceAll(" ", "-")}` });
      expect(resumed).toMatchObject({ ok: true, value: { ownerExportAssembly: { claimed: 1, completed: 1,
        retried: 0, failed: 0, cleanup: { deleted: 1, pending: 0, incomplete: false } }, incompleteOwnerExports: false } });
      const afterResume = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope.portfolioId,
        fromPeriod: testUtcOffset(rolloverTodayPeriod, -14), throughPeriod: rolloverTodayPeriod });
      expect(blocked.ok).toBe(true);
      if (!blocked.ok) throw new Error("PHASE8_ROLLOVER_BLOCKED_RUN_FAILED");
      expect(blocked.value.incomplete).toBe(true);
      expect(blocked.value.incompleteBacklog).toBe(true);
      expect(blocked.value.ownerExportAssembly).toBeNull();
      expect(blocked.value.incompleteOwnerExports).toBe(false);
      expect(ownerDispatch).not.toHaveBeenCalled();
      expect(aggregateDispatch).not.toHaveBeenCalled();
      expect(afterBlocked).toMatchObject({ requiredThroughPeriod: rolloverTodayPeriod, phase: "retention",
        retentionScheduledThrough: rolloverTodayPeriod, retentionCompleteThrough: rolloverPreviousPeriod,
        oldestOverduePeriod: rolloverOlderPeriod, oldestUnfinishedPeriod: rolloverOlderPeriod });
      expect(blockedRetentionRows).toHaveLength(retentionTypes.length);
      expect(blockedHoleRows).toEqual([{ status: "available" }]);
      expect(blockedOwnerRows).toEqual([{ status: "available" }]);
      expect(initialExpired.rows).toEqual([{ status: "ready", artifact_deleted_at: null }]);
      expect(blockedObjectStillPresent).toBe(true);
      expect(blockedDeletes).toBe(0);
      expect(blockedAggregateRows).toEqual([{ count: 0 }]);
      expect(blockedCurrentAggregateJobs).toEqual([{ count: 0 }]);
      expect(afterResume).toMatchObject({ requiredThroughPeriod: rolloverTodayPeriod,
        retentionCompleteThrough: rolloverTodayPeriod, aggregateScheduledThrough: rolloverTodayPeriod,
        oldestUnfinishedPeriod: null });
      const retentionCounts = await admin!.query(`select job_type,count(*)::integer as count from operations.jobs
        where semantic_scope_id=$1 and semantic_period=$2 and job_type=any($3::text[]) group by job_type order by job_type`,
      [scope.portfolioId, rolloverTodayPeriod, retentionTypes]);
      expect(retentionCounts.rows).toEqual(retentionTypes.map(jobType => ({ job_type: jobType, count: 1 }))
        .sort((a, b) => a.job_type.localeCompare(b.job_type)));
      expect((await admin!.query(`select count(*)::integer as count from operations.jobs where semantic_scope_id=$1
        and job_type='measurement.daily-aggregate.v1' and semantic_period like $2`,
      [scope.portfolioId, `${rolloverTodayPeriod}:%`])).rows).toEqual([{ count: 15 }]);
      expect((await admin!.query("select status from operations.jobs where job_id=$1", [holeJobId])).rows)
        .toEqual([{ status: "completed" }]);
      expect((await admin!.query("select status,artifact_deleted_at from portability.owner_exports where export_id=$1",
        [owner.queuedExportId])).rows[0]).toMatchObject({ status: "ready" });
      expect((await admin!.query(`select count(*)::integer as count from operations.jobs
        where job_type='portability.owner-export-assembly.v1' and payload->>'exportId'=$1`, [owner.queuedExportId])).rows)
        .toEqual([{ count: 1 }]);
      expect(owner.objectServer.objects.has(owner.expiredObjectPath)).toBe(false);
      expect(owner.objectServer.requests.filter(request => request.startsWith("DELETE "))).toHaveLength(1);
    }, 60_000);

  it("resumes more than five successful retention checkpoint batches across a bounded restart", async () => {
    const scope = id("Portfolio");
    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const subject = id("MeasurementVisitor"), route = id("PublicRoute");
    const eventIds = Array.from({ length: 601 }, () => id("PublicEvent"));
    const operations = createPostgresOperationsPersistence(worker!.database, { now: () => now });
    const firstPeriod = testUtcOffset(today, -14);
    await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope, fromPeriod: firstPeriod, throughPeriod: today });
    const scheduledPeriods = Array.from({ length: 15 }, (_, index) => testUtcOffset(today, index - 14));
    const jobIds = new Map<string, StableId<"Job">>();
    for (const period of scheduledPeriods) for (const jobType of retentionTypes) {
      const jobId = id("Job");
      jobIds.set(`${period}:${jobType}`, jobId);
      await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, { jobId,
        payload: { type: jobType, version: 1, value: {} }, availableAt: `${period}T00:00:00.000Z`,
        semanticSchedule: { portfolioId: scope, period } }));
    }
    expect(await operations.jobs.advancePhase7RetentionSchedule({ portfolioId: scope,
      expectedNextPeriod: firstPeriod, scheduledThroughPeriod: today })).toBe(true);
    const targetJobId = jobIds.get(`${today}:${retentionTypes[0]}`)!;
    await admin!.query(`update operations.jobs set status=case when job_id=$3 then 'available' else 'completed' end,
      completed_at=case when job_id=$3 then null else clock_timestamp() end,
      lease_owner=null,lease_token=null,lease_expires_at=null,attempt_count=0
      where semantic_scope_id=$1 and job_type=any($2::text[])`, [scope, retentionTypes, targetJobId]);
    await admin!.query(`insert into measurement.public_events
      (event_id,portfolio_id,measurement_subject,action,occurred_at,accepted_at,effective_at,page_route_identity,
       locale,consent_version,journey_context)
      select event_id,$2,$3,'page-viewed',$4::timestamptz,$5::timestamptz,$4::timestamptz,$6,'en','2026-10',array[$6]::uuid[]
        from unnest($1::uuid[]) as event_id`, [eventIds, scope, subject, `${testUtcOffset(today, -30)}T00:00:00.000Z`,
      `${testUtcOffset(today, -30)}T00:00:00.000Z`, route]);
    let successfulDetailBatches = 0;
    const first = await makeDueWorkService(worker!, scope, () => now, { onDetailRetention: () => successfulDetailBatches += 1 })
      .runDueWork({ workerId: "phase8-retention-page-one", maxClaimsPerPhase: 3 });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("PHASE8_RETENTION_BATCH_FIRST_RUN_FAILED");
    expect(first.value.claimed).toBe(3);
    expect(first.value.released).toBe(3);
    expect(first.value.incompleteBacklog).toBe(true);
    expect(successfulDetailBatches).toBe(3);
    const target = (await admin!.query("select job_id::text,status,attempt_count from operations.jobs where job_id=$1", [targetJobId])).rows[0];
    expect(target).toMatchObject({ job_id: targetJobId, status: "available", attempt_count: 0 });
    expect((await admin!.query("select count(*)::integer as count from measurement.public_events where portfolio_id=$1", [scope])).rows)
      .toEqual([{ count: 401 }]);

    const second = await makeDueWorkService(worker!, scope, () => now, { onDetailRetention: () => successfulDetailBatches += 1 })
      .runDueWork({ workerId: "phase8-retention-page-restart", maxClaimsPerPhase: 10 });
    expect(second.ok).toBe(true);
    expect(successfulDetailBatches).toBe(11);
    expect((await admin!.query("select count(*)::integer as count from measurement.public_events where portfolio_id=$1", [scope])).rows)
      .toEqual([{ count: 0 }]);
    const completed = (await admin!.query("select job_id::text,status,attempt_count from operations.jobs where job_id=$1", [targetJobId])).rows[0];
    expect(completed).toMatchObject({ job_id: targetJobId, status: "completed", attempt_count: 1 });
    expect((await admin!.query(`select count(*)::integer as count from operations.jobs where semantic_scope_id=$1
      and job_type='measurement.detail-retention.v1' and semantic_period=$2`, [scope, today])).rows)
      .toEqual([{ count: 1 }]);
  }, 60_000);

  it("reports the saturated ten-job Owner assembly pass and drains the eleventh export on restart", async () => {
    const scope = { portfolioId: id("Portfolio"), ownerId: id("Owner") };
    const now = new Date().toISOString();
    const owner = await makeOwnerExportFixture(scope, now, false);
    const exportIds: StableId<"OwnerExport">[] = [];
    for (let index = 0; index < 11; index += 1) {
      const request = await owner.services.requestService.requestOwnerExport({ actor: owner.actor,
        portfolioId: scope.portfolioId, idempotencyKey: idempotencyKey(`phase8-owner-backlog-${sequence++}`),
        includedScopes: ["portfolio-configuration"] });
      expect(request.ok).toBe(true);
      if (!request.ok) throw new Error("PHASE8_OWNER_BACKLOG_REQUEST_FAILED");
      exportIds.push(request.value.exportId);
    }

    const first = await makeComposedDueWorkService(worker!, scope.portfolioId, () => now, owner.services.assembly)
      .runDueWork({ workerId: "phase8-owner-backlog-first" });
    expect(first).toMatchObject({ ok: true, value: { incomplete: true, incompleteOwnerExports: true,
      ownerExportAssembly: { claimed: 10, completed: 10, incompleteBacklog: true } } });
    expect((await admin!.query(`select status,count(*)::integer as count from operations.jobs
      where job_type='portability.owner-export-assembly.v1' and payload->>'portfolioId'=$1 group by status order by status`,
    [scope.portfolioId])).rows).toEqual([{ status: "available", count: 1 }, { status: "completed", count: 10 }]);
    expect(owner.objectServer.objects.size).toBe(10);

    const second = await makeComposedDueWorkService(worker!, scope.portfolioId, () => now, owner.services.assembly)
      .runDueWork({ workerId: "phase8-owner-backlog-restart" });
    expect(second).toMatchObject({ ok: true, value: { incompleteOwnerExports: false,
      ownerExportAssembly: { claimed: 1, completed: 1, incompleteBacklog: false } } });
    expect((await admin!.query(`select status,count(*)::integer as count from operations.jobs
      where job_type='portability.owner-export-assembly.v1' and payload->>'portfolioId'=$1 group by status order by status`,
    [scope.portfolioId])).rows).toEqual([{ status: "completed", count: 11 }]);
    expect((await admin!.query(`select count(*)::integer as count from portability.owner_exports where export_id=any($1::uuid[])
      and status='ready'`, [exportIds])).rows).toEqual([{ count: 11 }]);
    expect((await admin!.query(`select count(*)::integer as count from operations.jobs
      where job_type='portability.owner-export-assembly.v1' and payload->>'portfolioId'=$1`,
    [scope.portfolioId])).rows).toEqual([{ count: 11 }]);
    expect(owner.objectServer.objects.size).toBe(11);
  }, 90_000);

  it.each(["delayed retry", "dead retention job"] as const)("keeps aggregate admission closed for a %s barrier", async blocker => {
    const scope = id("Portfolio");
    const { withdrawalJobId, now } = await seedRetentionBarrier(scope);
    if (blocker === "dead retention job") {
      await admin!.query("update operations.jobs set status='dead',last_error_code='PHASE7_WORK_FAILED' where job_id=$1", [withdrawalJobId]);
    } else {
      await admin!.query("update operations.jobs set available_at='2030-01-01T00:00:00.000Z' where job_id=$1", [withdrawalJobId]);
    }
    const aggregateEffect = vi.fn();
    const ownerDispatch = vi.fn(async () => ({ ok: true as const,
      value: { claimed: 0, completed: 0, retried: 0, failed: 0, staleLeases: 0 } }));
    const result = await makeDueWorkService(workerTwo!, scope, () => now, { onAggregate: aggregateEffect, ownerExports: { runOwnerExportAssembly: ownerDispatch } })
      .runDueWork({ workerId: "retention-blocked" });
    expect(result).toMatchObject({ ok: true, value: { incomplete: true, incompleteBacklog: true, ownerExportAssembly: null } });
    expect(aggregateEffect).not.toHaveBeenCalled();
    expect(ownerDispatch).not.toHaveBeenCalled();
    expect((await admin!.query(`select count(*)::integer as count from operations.jobs where semantic_scope_id=$1
      and job_type='measurement.daily-aggregate.v1'`, [scope])).rows).toEqual([{ count: 0 }]);
  });

  it("catches up a twenty-day outage in ordered slices of at most fifteen policy periods", async () => {
    const scope = id("Portfolio");
    const historicalPeriod = testUtcOffset(duePeriod, -20);
    const operations = createPostgresOperationsPersistence(worker!.database);
    await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope, fromPeriod: historicalPeriod, throughPeriod: historicalPeriod });
    for (const jobType of retentionTypes) {
      const jobId = id("Job");
      await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, { jobId,
        payload: { type: jobType, version: 1, value: {} }, availableAt: `${historicalPeriod}T00:00:00.000Z`,
        semanticSchedule: { portfolioId: scope, period: historicalPeriod } }));
    }
    await operations.jobs.advancePhase7RetentionSchedule({ portfolioId: scope, expectedNextPeriod: historicalPeriod,
      scheduledThroughPeriod: historicalPeriod });
    await admin!.query("update operations.jobs set status='completed',completed_at=clock_timestamp() where semantic_scope_id=$1", [scope]);
    const retentionStatus = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope, fromPeriod: historicalPeriod, throughPeriod: historicalPeriod });
    expect(retentionStatus.phase).toBe("aggregate");
    for (let offset = -14; offset <= 0; offset += 1) {
      const utcDay = new Date(Date.parse(`${historicalPeriod}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10);
      await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, { jobId: id("Job"),
        payload: { type: "measurement.daily-aggregate.v1", version: 1, value: { utcDay } },
        availableAt: `${historicalPeriod}T00:00:00.000Z`, semanticSchedule: { portfolioId: scope, period: `${historicalPeriod}:${utcDay}` } }));
    }
    await operations.jobs.advancePhase7AggregateSchedule({ portfolioId: scope, expectedNextPeriod: historicalPeriod,
      scheduledThroughPeriod: historicalPeriod });
    await admin!.query("update operations.jobs set status='completed',completed_at=clock_timestamp() where semantic_scope_id=$1", [scope]);
    const baseline = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope, fromPeriod: historicalPeriod, throughPeriod: historicalPeriod });
    expect(baseline).toMatchObject({ phase: "retention", lastCompletePolicyPeriod: historicalPeriod,
      retentionCompleteThrough: historicalPeriod, aggregateScheduledThrough: historicalPeriod });

    let clock = `${duePeriod}T12:00:00.000Z`;
    const run = (workerId: string) => makeDueWorkService(worker!, scope, () => clock).runDueWork({ workerId });
    const first = await run("outage-slice-one");
    if (!first.ok) throw new Error(`PHASE8_CATCHUP_FIRST_RESULT:${JSON.stringify(first.error)}`);
    expect(first).toMatchObject({ ok: true, value: { scheduled: 60, incomplete: true, lastCompletePolicyPeriod: historicalPeriod } });
    const second = await run("outage-slice-two");
    if (!second.ok) throw new Error(`PHASE8_CATCHUP_SECOND_RESULT:${JSON.stringify(second.error)}`);
    const middlePeriod = testUtcOffset(historicalPeriod, 10);
    expect(second).toMatchObject({ ok: true, value: { scheduled: 170, lastCompletePolicyPeriod: middlePeriod } });
    const third = await run("outage-slice-three");
    if (!third.ok) throw new Error(`PHASE8_CATCHUP_THIRD_RESULT:${JSON.stringify(third.error)}`);
    if (third.value.incomplete || third.value.lastCompletePolicyPeriod !== duePeriod) {
      throw new Error(`PHASE8_CATCHUP_THIRD_RESULT_UNEXPECTED:${JSON.stringify(third.value)}`);
    }
    expect(third).toMatchObject({ ok: true, value: { scheduled: 150, incomplete: false, lastCompletePolicyPeriod: duePeriod } });
    const periods = (await admin!.query(`select semantic_period from operations.jobs where semantic_scope_id=$1
      and job_type='measurement.detail-retention.v1' order by semantic_period`, [scope])).rows.map((row: { semantic_period: string }) => row.semantic_period);
    expect(periods).toEqual(Array.from({ length: 21 }, (_, index) => {
      const day = new Date(Date.parse(`${historicalPeriod}T00:00:00.000Z`) + index * 86_400_000);
      return day.toISOString().slice(0, 10);
    }));
    const throughPeriod = duePeriod;
    const status = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope,
      fromPeriod: testUtcOffset(throughPeriod, -14), throughPeriod });
    expect(status.lastCompletePolicyPeriod).toBe(throughPeriod);
    const durable = (await admin!.query(`select phase, to_char(required_through_period,'YYYY-MM-DD') as required_through,
        to_char(aggregate_finished_through,'YYYY-MM-DD') as aggregate_finished
      from operations.phase7_schedule_progress where portfolio_id=$1`, [scope])).rows[0];
    if (status.phase !== "retention" || durable?.phase !== "retention") {
      throw new Error(`PHASE8_CATCHUP_FINAL_CURSOR:${JSON.stringify({ status, durable })}`);
    }
    expect(durable).toEqual({ phase: "retention", required_through: throughPeriod, aggregate_finished: throughPeriod });
  }, 60_000);

  it("holds contiguous completion before an older aggregate hole, then audited redrive closes it once", async () => {
    const scope = id("Portfolio");
    const throughPeriod = duePeriod;
    const firstPeriod = testUtcOffset(throughPeriod, -14), holePeriod = testUtcOffset(firstPeriod, 1);
    const holeUtcDay = firstPeriod;
    const operations = createPostgresOperationsPersistence(worker!.database);
    await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope, fromPeriod: firstPeriod, throughPeriod });
    const policyPeriods = Array.from({ length: 15 }, (_, index) => {
      const day = new Date(Date.parse(`${firstPeriod}T00:00:00.000Z`) + index * 86_400_000);
      return day.toISOString().slice(0, 10);
    });
    for (const policyPeriod of policyPeriods) {
      for (const jobType of retentionTypes) {
        await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, { jobId: id("Job"),
          payload: { type: jobType, version: 1, value: {} }, availableAt: `${policyPeriod}T00:00:00.000Z`,
          semanticSchedule: { portfolioId: scope, period: policyPeriod } }));
      }
    }
    expect(await operations.jobs.advancePhase7RetentionSchedule({ portfolioId: scope,
      expectedNextPeriod: firstPeriod, scheduledThroughPeriod: throughPeriod })).toBe(true);
    await admin!.query(`update operations.jobs set status='completed',completed_at=clock_timestamp()
      where semantic_scope_id=$1 and job_type=any($2::text[])`, [scope, retentionTypes]);
    expect((await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope, fromPeriod: firstPeriod, throughPeriod })).phase)
      .toBe("aggregate");

    const utcDays = new Set<string>();
    for (const policyPeriod of policyPeriods) {
      for (let offset = -14; offset <= 0; offset += 1) {
        const utcDay = new Date(Date.parse(`${policyPeriod}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10);
        utcDays.add(utcDay);
        await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, { jobId: id("Job"),
          payload: { type: "measurement.daily-aggregate.v1", version: 1, value: { utcDay } },
          availableAt: `${policyPeriod}T00:00:00.000Z`, semanticSchedule: { portfolioId: scope, period: `${policyPeriod}:${utcDay}` } }));
      }
    }
    expect(utcDays.size).toBe(29);
    expect(await operations.jobs.advancePhase7AggregateSchedule({ portfolioId: scope,
      expectedNextPeriod: firstPeriod, scheduledThroughPeriod: throughPeriod })).toBe(true);
    await admin!.query(`update operations.jobs set status='completed',completed_at=clock_timestamp()
      where semantic_scope_id=$1 and job_type='measurement.daily-aggregate.v1'`, [scope]);
    const hole = (await admin!.query(`select job_id::text from operations.jobs where semantic_scope_id=$1
      and job_type='measurement.daily-aggregate.v1' and semantic_period=$2`, [scope, `${holePeriod}:${holeUtcDay}`])).rows[0];
    if (typeof hole?.job_id !== "string") throw new Error("PHASE8_HOLE_AGGREGATE_JOB_MISSING");
    const originalJobId = hole.job_id as StableId<"Job">;
    await admin!.query("update operations.jobs set status='dead',completed_at=null,last_error_code='PHASE7_WORK_FAILED',attempt_count=5 where job_id=$1", [originalJobId]);

    const before = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope, fromPeriod: firstPeriod, throughPeriod });
    expect(before).toMatchObject({ phase: "aggregate", lastCompletePolicyPeriod: firstPeriod,
      oldestOverduePeriod: holePeriod, oldestUnfinishedPeriod: holePeriod });
    expect((await admin!.query(`select count(*)::integer as count from operations.jobs where semantic_scope_id=$1
      and job_type='measurement.daily-aggregate.v1' and semantic_period like $2 and status='completed'`,
    [scope, `${testUtcOffset(holePeriod, 1)}:%`])).rows)
      .toEqual([{ count: 15 }]);

    const dead = await operations.jobs.getDeadForRedrive(originalJobId);
    expect(dead).toMatchObject({ jobId: originalJobId, payload: { type: "measurement.daily-aggregate.v1",
      version: 1, value: { utcDay: holeUtcDay } }, semanticSchedule: { portfolioId: scope, period: `${holePeriod}:${holeUtcDay}` } });
    const replacementJobId = id("Job");
    const payload = { type: dead!.payload.type, version: dead!.payload.version, value: dead!.payload.value };
    const redriven = await operations.jobs.redriveDead({ originalJobId, replacementJobId,
      operatorScopeHash: "a".repeat(64), policyVersion: "phase7-handlers-v1",
      payloadSha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex") });
    expect(redriven).toMatchObject({ jobId: replacementJobId, payload: dead!.payload });
    expect((await admin!.query(`select count(*)::integer as count from operations.jobs where semantic_scope_id=$1
      and job_type='measurement.daily-aggregate.v1' and semantic_period=$2`, [scope, `${holePeriod}:${holeUtcDay}`])).rows)
      .toEqual([{ count: 1 }]);
    expect((await admin!.query("select status,semantic_scope_id,semantic_period from operations.jobs where job_id=$1", [originalJobId])).rows)
      .toEqual([{ status: "dead", semantic_scope_id: null, semantic_period: null }]);

    let repairedEffects = 0;
    const repaired = await makeDueWorkService(worker!, scope, () => `${throughPeriod}T12:00:00.000Z`, {
      onAggregate: () => { repairedEffects += 1; },
    }).runDueWork({ workerId: "phase8-hole-redrive" });
    expect(repaired).toMatchObject({ ok: true, value: { incomplete: false, lastCompletePolicyPeriod: throughPeriod,
      oldestOverduePeriod: null } });
    expect(repairedEffects).toBe(1);
    expect((await admin!.query("select status,attempt_count from operations.jobs where job_id=$1", [replacementJobId])).rows)
      .toEqual([{ status: "completed", attempt_count: 1 }]);
    expect((await admin!.query(`select phase,to_char(aggregate_finished_through,'YYYY-MM-DD') as aggregate_finished,
      to_char(last_complete_period,'YYYY-MM-DD') as last_complete from operations.phase7_schedule_progress where portfolio_id=$1`, [scope])).rows)
      .toEqual([{ phase: "retention", aggregate_finished: throughPeriod, last_complete: throughPeriod }]);
    expect((await admin!.query(`select count(*)::integer as count from operations.job_redrive_audit where original_job_id=$1
      and replacement_job_id=$2`, [originalJobId, replacementJobId])).rows).toEqual([{ count: 1 }]);
  }, 60_000);

  it("keeps legacy redrive reads and writes free of Phase 8 scheduling columns", async () => {
    if (!LEGACY_URL) throw new Error("PHASE8_LEGACY_DATABASE_REQUIRED");
    const legacyAdmin = new Client({ connectionString: LEGACY_URL.replace("due_work_worker_runtime", "postgres") });
    await legacyAdmin.connect();
    try {
      const originalJobId = id("Job"), replacementJobId = id("Job");
      const payload = { type: "legacy.redrive.compatibility.v1", version: 1, value: {} };
      const payloadSha256 = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      await legacyAdmin.query(`insert into operations.jobs(job_id,job_type,payload_version,payload,available_at,status,last_error_code,attempt_count)
        values ($1,$2,1,'{}'::jsonb,clock_timestamp(),'dead','PHASE7_WORK_FAILED',5)`, [originalJobId, payload.type]);
      const operations = createPostgresOperationsPersistence(legacyWorker!.database);
      const dead = await operations.jobs.getDeadForRedrive(originalJobId);
      expect(dead).toMatchObject({ jobId: originalJobId, payload: { type: payload.type, version: 1, value: {} }, attemptCount: 5 });
      expect(dead?.semanticSchedule).toBeUndefined();
      const redriven = await operations.jobs.redriveDead({ originalJobId, replacementJobId,
        operatorScopeHash: "0".repeat(64), policyVersion: "phase7-redrive-v1", payloadSha256 });
      expect(redriven).toMatchObject({ jobId: replacementJobId, payload: { type: payload.type, version: 1, value: {} } });
      expect((await legacyAdmin.query("select job_id,job_type,status from operations.jobs where job_id=$1", [replacementJobId])).rows)
        .toEqual([{ job_id: replacementJobId, job_type: payload.type, status: "available" }]);
      expect((await legacyAdmin.query(`select count(*)::integer as count from information_schema.columns
        where table_schema='operations' and table_name='jobs' and column_name in ('semantic_scope_id','semantic_period')`)).rows)
        .toEqual([{ count: 0 }]);
    } finally { await legacyAdmin.end(); }
  });

  it("uses the semantic-period covering index for recent status reads over old queue history", async () => {
    await admin!.query(`insert into operations.jobs(job_id,job_type,payload_version,payload,available_at,status,completed_at,
      semantic_scope_id,semantic_period,work_incomplete)
      select ('018f0000-0000-7000-8000-' || lpad(to_hex(n),12,'0'))::uuid,
        'measurement.detail-retention.v1',1,'{}'::jsonb,clock_timestamp(),'completed',clock_timestamp(),
        ('018e0000-0000-7000-8000-' || lpad(to_hex(n),12,'0'))::uuid,
        to_char(date '2000-01-01' + n, 'YYYY-MM-DD'),false
      from generate_series(1,20000) as n`);
    try {
      await admin!.query("analyze operations.jobs");
      const plan = await admin!.query(`explain (format json)
        select job_type, semantic_period, status, coalesce(work_incomplete,false) as work_incomplete
          from operations.jobs
         where semantic_scope_id=$1::uuid and job_type=any($2::text[])
           and ((job_type=$3::text and semantic_period >= $4 and semantic_period <= $5)
             or (job_type<>$3::text and semantic_period between $6 and $7))
         order by semantic_period,job_type`,
      [portfolioId, [...retentionTypes, "measurement.daily-aggregate.v1"], "measurement.daily-aggregate.v1",
        `${duePeriod}:`, `${duePeriod}:9999-99-99`, duePeriod, duePeriod]);
      expect(JSON.stringify(plan.rows[0]?.["QUERY PLAN"])).toContain("jobs_policy_period_status_idx");
    } finally {
      await admin!.query("delete from operations.jobs where job_id >= '018f0000-0000-7000-8000-000000000001'::uuid and job_id <= '018f0000-0000-7000-8000-000000004e20'::uuid");
    }
  });

  it("keeps a future UTC policy period incomplete until database not-before", async () => {
    const scope = id("Portfolio");
    const dayBounds = (await admin!.query(`select to_char((clock_timestamp() at time zone 'UTC')::date, 'YYYY-MM-DD') as database_day,
      to_char((clock_timestamp() at time zone 'UTC')::date + 1, 'YYYY-MM-DD') as future_period`)).rows[0];
    const databaseDay = dayBounds?.database_day as string | undefined;
    const futurePeriod = dayBounds?.future_period as string | undefined;
    if (!databaseDay || !futurePeriod) throw new Error("PHASE8_DATABASE_UTC_DAY_UNAVAILABLE");
    const fromPeriod = testUtcOffset(futurePeriod, -14);
    const priorPeriod = testUtcOffset(futurePeriod, -1);
    expect(fromPeriod).toBe(testUtcOffset(databaseDay, -13));
    const operations = createPostgresOperationsPersistence(worker!.database);
    await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope, fromPeriod, throughPeriod: priorPeriod });

    const priorPeriods = Array.from({ length: 14 }, (_, offset) => testUtcOffset(fromPeriod, offset));
    for (const period of priorPeriods) for (const jobType of retentionTypes) {
      const enqueued = await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, {
        jobId: id("Job"), payload: { type: jobType, version: 1, value: {} },
        availableAt: `${period}T00:00:00.000Z`, semanticSchedule: { portfolioId: scope, period },
      }));
      if (!enqueued) throw new Error("PHASE8_CLOCK_AHEAD_PRIOR_RETENTION_ENQUEUE_FAILED");
    }
    expect(await operations.jobs.advancePhase7RetentionSchedule({ portfolioId: scope,
      expectedNextPeriod: fromPeriod, scheduledThroughPeriod: priorPeriod })).toBe(true);
    await admin!.query(`update operations.jobs set status='completed',completed_at=clock_timestamp(),lease_owner=null,
      lease_token=null,lease_expires_at=null where semantic_scope_id=$1 and job_type=any($2::text[])`, [scope, retentionTypes]);
    const seededStatus = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope,
      fromPeriod, throughPeriod: priorPeriod });
    expect(seededStatus).toMatchObject({ retentionScheduledThrough: priorPeriod, retentionCompleteThrough: priorPeriod });

    const futureCallerTime = `${futurePeriod}T00:05:00.000Z`;
    const retentionEffects: string[] = [];
    let ownerDispatches = 0;
    let aggregateEffects = 0;
    const completeWork = async (): Promise<Result<BoundedWorkResult, Rejection>> => ({
      ok: true, value: { processedCount: 0, nextCursor: null, incomplete: false },
    });
    const measurement = {
      aggregateDay: async () => { aggregateEffects += 1; return completeWork(); },
      expireDetail: async () => { retentionEffects.push("detail"); return completeWork(); },
      expireAggregates: async () => { retentionEffects.push("aggregate-retention"); return completeWork(); },
      cleanWithdrawnConsent: async () => { retentionEffects.push("withdrawal"); return completeWork(); },
    };
    const interaction = { expireFeedback: async () => { retentionEffects.push("feedback"); return completeWork(); } };
    const ownerExports = { runOwnerExportAssembly: async () => {
      ownerDispatches += 1;
      return { ok: true as const, value: { claimed: 0, completed: 0, retried: 0, failed: 0, staleLeases: 0,
        cleanup: { scanned: 0, deleted: 0, pending: 0, incomplete: false } } };
    } };
    const service = createPhase7DueWorkService({ portfolioId: scope, clock: { now: () => futureCallerTime },
      ids: createSystemIdGenerator(), operations: createPostgresOperationsPersistence(workerTwo!.database, { now: () => futureCallerTime }),
      measurement, interaction, ownerExports });
    const beforeDatabaseNotBefore = await service.runDueWork({ workerId: "clock-ahead-utc-rollover" });
    expect(beforeDatabaseNotBefore).toMatchObject({ ok: true, value: { scheduled: retentionTypes.length,
      claimed: 0, completed: 0, incompleteBacklog: true, incomplete: true, ownerExportAssembly: null } });
    if (!beforeDatabaseNotBefore.ok) throw new Error("PHASE8_CLOCK_AHEAD_RUN_FAILED");
    expect(beforeDatabaseNotBefore.value.lastCompletePolicyPeriod).not.toBe(futurePeriod);
    const futureJobs = await admin!.query(`select job_type,status,attempt_count,lease_owner,lease_token,lease_expires_at,
      available_at>clock_timestamp() as database_not_before,available_at<$3::timestamptz as caller_time_is_later
      from operations.jobs where semantic_scope_id=$1 and semantic_period=$2 and job_type=any($4::text[]) order by job_type`,
    [scope, futurePeriod, futureCallerTime, retentionTypes]);
    expect(futureJobs.rows).toHaveLength(retentionTypes.length);
    expect(futureJobs.rows.map((job: { job_type: string }) => job.job_type)).toEqual([...retentionTypes].sort());
    for (const job of futureJobs.rows) expect(job).toMatchObject({ status: "available", attempt_count: 0,
      lease_owner: null, lease_token: null, lease_expires_at: null, database_not_before: true, caller_time_is_later: true });
    expect(retentionEffects).toEqual([]);
    expect((await admin!.query(`select count(*)::integer as count from operations.jobs where semantic_scope_id=$1
      and job_type='measurement.daily-aggregate.v1'`, [scope])).rows).toEqual([{ count: 0 }]);
    expect((await admin!.query("select count(*)::integer as count from measurement.daily_aggregates where portfolio_id=$1", [scope])).rows)
      .toEqual([{ count: 0 }]);
    expect(ownerDispatches).toBe(0);
    expect(aggregateEffects).toBe(0);

    await admin!.query(`update operations.jobs set available_at=clock_timestamp()-interval '1 millisecond'
      where semantic_scope_id=$1 and semantic_period=$2 and job_type='measurement.detail-retention.v1'`, [scope, futurePeriod]);
    const afterDatabaseNotBefore = await service.runDueWork({ workerId: "clock-ahead-utc-after-not-before", maxClaimsPerPhase: 5 });
    if (!afterDatabaseNotBefore.ok) throw new Error("PHASE8_CLOCK_AHEAD_AFTER_NOT_BEFORE_RUN_FAILED");
    if (afterDatabaseNotBefore.value.claimed === 0) {
      const progress = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope, fromPeriod, throughPeriod: futurePeriod });
      const jobs = (await admin!.query(`select job_type,status,attempt_count,available_at<=clock_timestamp() as database_due
        from operations.jobs where semantic_scope_id=$1 and semantic_period=$2 and job_type=any($3::text[]) order by job_type`,
      [scope, futurePeriod, retentionTypes])).rows;
      throw new Error(`PHASE8_CLOCK_AHEAD_NOT_BEFORE_STATE:${JSON.stringify({ result: afterDatabaseNotBefore.value, progress, jobs })}`);
    }
    expect(afterDatabaseNotBefore.value).toMatchObject({ claimed: 1, completed: 1, incompleteBacklog: true,
      incomplete: true, ownerExportAssembly: null, incompleteOwnerExports: false });
    expect(retentionEffects).toEqual(["detail"]);
    const afterBoundaryStatus = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope, fromPeriod, throughPeriod: futurePeriod });
    expect(afterBoundaryStatus).toMatchObject({ requiredThroughPeriod: futurePeriod,
      retentionCompleteThrough: priorPeriod, phase: "retention" });
    const afterBoundaryJobs = (await admin!.query(`select job_type,status,attempt_count from operations.jobs
      where semantic_scope_id=$1 and semantic_period=$2 and job_type=any($3::text[]) order by job_type`,
    [scope, futurePeriod, retentionTypes])).rows;
    expect(afterBoundaryJobs).toHaveLength(retentionTypes.length);
    expect(afterBoundaryJobs.find((job: { job_type: string }) => job.job_type === "measurement.detail-retention.v1"))
      .toMatchObject({ status: "completed", attempt_count: 1 });
    expect(afterBoundaryJobs.filter((job: { job_type: string }) => job.job_type !== "measurement.detail-retention.v1"))
      .toEqual([...retentionTypes].filter(jobType => jobType !== "measurement.detail-retention.v1").sort()
        .map(job_type => ({ job_type, status: "available", attempt_count: 0 })));
    expect(ownerDispatches).toBe(0);
    expect(aggregateEffects).toBe(0);
  }, 60_000);

  it("forces RLS and keeps the cursor table unavailable to application and public roles", async () => {
    const result = await admin!.query(`select c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced,
      has_table_privilege('shipwithali_worker','operations.phase7_schedule_progress','SELECT') as worker_select,
      has_table_privilege('shipwithali_worker','operations.phase7_schedule_progress','INSERT') as worker_insert,
      has_table_privilege('shipwithali_worker','operations.phase7_schedule_progress','UPDATE') as worker_update,
      has_table_privilege('shipwithali_worker','operations.phase7_schedule_progress','DELETE') as worker_delete,
      has_table_privilege('shipwithali_backup','operations.phase7_schedule_progress','SELECT') as backup_select,
      has_table_privilege('shipwithali_backup','operations.phase7_schedule_progress','UPDATE') as backup_update,
      has_table_privilege('shipwithali_application','operations.phase7_schedule_progress','SELECT') as application_select,
      has_table_privilege('anon','operations.phase7_schedule_progress','SELECT') as anonymous_select,
      has_table_privilege('authenticated','operations.phase7_schedule_progress','SELECT') as authenticated_select
      from pg_class c where c.oid='operations.phase7_schedule_progress'::regclass`);
    expect(result.rows).toEqual([{ rls_enabled: true, rls_forced: true, worker_select: true, worker_insert: true,
      worker_update: true, worker_delete: false, backup_select: true, backup_update: false,
      application_select: false, anonymous_select: false, authenticated_select: false }]);
  });
});
