import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { sql } from "kysely";
import { createPostgresRuntimeDatabase, PostgresInfrastructureError, postgresFailureCategory } from "../../src/shared/adapters/postgres/runtime.js";
import { resolvePostgresTransaction } from "../../src/shared/adapters/postgres/runtime.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPostgresOwnerExportStore } from "../../src/modules/portability-operations/adapters/postgres-owner-export-store.js";
import { OWNER_EXPORT_ASSEMBLY_JOB_TYPE, type OwnerExportPackageManifest } from "../../src/modules/portability-operations/application/service.js";
import { parseSafeErrorCode } from "../../src/modules/portability-operations/application/persistence.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createOperationsSummaryService, OPERATIONS_SUMMARY_PURPOSE,
  type OperationsSummary, type OperationsSummaryQuery, type OwnerExportIntegrityLogWindowQuery }
  from "../../src/modules/portability-operations/application/operations-observability.js";
import { buildOperationsSummaryQuery, createPostgresOperationsSummaryReader, explainOperationsSummaryQuery } from "../../src/modules/portability-operations/adapters/postgres-operations-summary.js";
import { evaluateOperationsLogQuery, OPERATIONS_LOG_QUERIES } from "../../src/modules/portability-operations/application/operations-log-queries.js";
import { supportsLeaseAcquiredAtColumn } from "../../src/modules/portability-operations/adapters/postgres-schema-capabilities.js";
import { createPostgresIncidentLifecycleStore } from "../../src/modules/portability-operations/adapters/postgres-incident-lifecycle.js";
import { createIncidentLifecycleService, type DurableIncidentInput } from "../../src/modules/portability-operations/application/incident-lifecycle.js";
import { CORE_INCIDENT_RULES } from "../../src/modules/portability-operations/application/incident-policy.js";
import { createOperationalIncidentPass } from "../../src/modules/portability-operations/application/incident-pass.js";
import { createOperationsReadiness } from "../../src/modules/portability-operations/application/operations-readiness.js";
import type { StableId } from "../../src/shared/domain/index.js";

const adminUrl = process.env["OPERATIONS_SUMMARY_ADMIN_DATABASE_URL"];
const workerUrl = process.env["OPERATIONS_SUMMARY_WORKER_DATABASE_URL"];
const predecessorAdminUrl = process.env["OPERATIONS_SUMMARY_PREDECESSOR_ADMIN_DATABASE_URL"];
const predecessorWorkerUrl = process.env["OPERATIONS_SUMMARY_PREDECESSOR_WORKER_DATABASE_URL"];
const freshAdminUrl = process.env["OPERATIONS_SUMMARY_FRESH_ADMIN_DATABASE_URL"];
const freshWorkerUrl = process.env["OPERATIONS_SUMMARY_FRESH_WORKER_DATABASE_URL"];
const observedAt = "2026-10-27T12:00:00.000Z";
const portfolioId = "0196a1b2-7c3d-7e11-9f22-000000000001" as StableId<"Portfolio">;
const otherPortfolioId = "0196a1b2-7c3d-7e11-9f22-000000000002";
const ownerId = "0196a1b2-7c3d-7e11-9f22-000000000003";
const marker = "PRIVATE-OUTBOX-PAYLOAD-EXPORT-MANIFEST-7F2A";
const uuid = (tail: number) => `0196a1b2-7c3d-7e11-9f22-${tail.toString(16).padStart(12, "0")}`;

function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

function planFacts(value: unknown, indexes: string[] = [], sequentialScans: string[] = [], indexRows: number[] = [],
  sorts: number[] = [], indexReadFacts: Array<{ readonly indexName: string; readonly relation: string | null; readonly nodeType: string | null;
    readonly actualRows: number; readonly actualLoops: number | null; readonly rowsRemovedByFilter: number | null;
    readonly availableAtIndexCondition: boolean; readonly indexCondition: string | null;
    readonly leaseExpiryRangeCondition: boolean; readonly exportTransitionIndexCondition: boolean }> = []):
  { indexes: string[]; sequentialScans: string[]; indexRows: number[]; sorts: number[]; indexReadFacts: Array<{ indexName: string;
    relation: string | null; nodeType: string | null; actualRows: number; actualLoops: number | null; rowsRemovedByFilter: number | null;
    availableAtIndexCondition: boolean; indexCondition: string | null;
    leaseExpiryRangeCondition: boolean; exportTransitionIndexCondition: boolean }> } {
  if (Array.isArray(value)) for (const item of value) planFacts(item, indexes, sequentialScans, indexRows, sorts, indexReadFacts);
  else if (value !== null && typeof value === "object") {
    const row = value as Record<string, unknown>;
    if (typeof row["Index Name"] === "string") indexes.push(row["Index Name"]);
    if (row["Node Type"] === "Seq Scan" && typeof row["Relation Name"] === "string") sequentialScans.push(row["Relation Name"]);
    if (typeof row["Index Name"] === "string" && typeof row["Actual Rows"] === "number") {
      indexRows.push(row["Actual Rows"]);
      indexReadFacts.push({ indexName: row["Index Name"], relation: typeof row["Relation Name"] === "string" ? row["Relation Name"] : null,
        nodeType: typeof row["Node Type"] === "string" ? row["Node Type"] : null, actualRows: row["Actual Rows"],
        actualLoops: typeof row["Actual Loops"] === "number" ? row["Actual Loops"] : null,
        rowsRemovedByFilter: typeof row["Rows Removed by Filter"] === "number" ? row["Rows Removed by Filter"] : null,
        availableAtIndexCondition: typeof row["Index Cond"] === "string" && /available_at/u.test(row["Index Cond"]),
        indexCondition: typeof row["Index Cond"] === "string" ? row["Index Cond"] : null,
        leaseExpiryRangeCondition: typeof row["Index Cond"] === "string" && /lease_expires_at\s*>/u.test(row["Index Cond"]),
        exportTransitionIndexCondition: typeof row["Index Cond"] === "string" && /(?:completed_at|failed_at|expired_at)/u.test(row["Index Cond"]) });
    }
    if (row["Node Type"] === "Sort" && typeof row["Actual Rows"] === "number") sorts.push(row["Actual Rows"]);
    for (const child of Object.values(row)) planFacts(child, indexes, sequentialScans, indexRows, sorts, indexReadFacts);
  }
  return { indexes, sequentialScans, indexRows, sorts, indexReadFacts };
}

let admin: Client;
let predecessorAdmin: Client;
let freshAdmin: Client;
let worker: ReturnType<typeof createPostgresRuntimeDatabase>;

async function exerciseQueueAndOwnerExportCompatibility(
  adminConnection: Client,
  workerConnectionString: string,
  predecessor: boolean,
  firstIdentity: number,
  failCapabilityProbeOnce = false,
): Promise<void> {
  const runtime = createPostgresRuntimeDatabase(workerConnectionString, { max: 2 });
  if (failCapabilityProbeOnce) {
    const probe = vi.spyOn(runtime.database.getExecutor(), "executeQuery");
    try {
      probe.mockImplementationOnce(async () => { throw new Error("INJECTED_ONE_SHOT_QUERY_FAILURE"); });
      await expect(supportsLeaseAcquiredAtColumn(runtime.database)).rejects.toBeInstanceOf(PostgresInfrastructureError);
      expect(await supportsLeaseAcquiredAtColumn(runtime.database)).toBe(true);
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      probe.mockRestore();
    }
  }
  const operations = createPostgresOperationsPersistence(runtime.database);
  const eventIds = [firstIdentity + 1, firstIdentity + 2, firstIdentity + 3].map(uuid);
  const jobIds = [firstIdentity + 4, firstIdentity + 5, firstIdentity + 6].map(uuid);
  const exportId = uuid(firstIdentity + 10) as StableId<"OwnerExport">;
  const exportJobId = uuid(firstIdentity + 11) as StableId<"Job">;
  const exportArtifactId = uuid(firstIdentity + 12) as StableId<"OwnerExportArtifact">;
  const portfolio = uuid(firstIdentity + 13);
  const owner = uuid(firstIdentity + 14);
  const leaseToken = `compat-export-lease-${firstIdentity}`;
  const manifest = {
    packageFormat: "shipwithali-owner-export", schemaVersion: "1.2", exportId,
    snapshot: { snapshotId: uuid(firstIdentity + 15), capturedAt: new Date().toISOString(), consistency: "transactional" },
    createdAt: new Date().toISOString(), algorithm: "sha-256", digest: "a".repeat(64), includedScopes: ["taxonomy"],
    publicEventDataCoverage: { mode: "excluded" }, requiredFeatures: ["asset-integrity-v1", "dependency-coverage-v1",
      "record-integrity-v1", "schema-integrity-v1", "snapshot-identity-v1"], dependencies: [],
    exclusions: ["raw-public-event-data", "functional-visitor-identities", "measurement-visitor-identities", "sessions", "credentials", "lab-entries"],
    entries: [{ path: "records/taxonomy.ndjson", scope: "taxonomy", mediaType: "application/x-ndjson",
      recordSchema: "urn:shipwithali:owner-export-schema:taxonomy:1.1", schemaPath: "schemas/taxonomy.schema.json",
      schemaVersion: "1.1", digest: "b".repeat(64), recordCount: 0 }],
    schemas: [{ kind: "manifest", path: "schemas/manifest.schema.json", schemaUri: "urn:shipwithali:owner-export-schema:manifest:1.1",
      schemaVersion: "1.1", digest: "c".repeat(64) }, { kind: "record", path: "schemas/taxonomy.schema.json", scope: "taxonomy",
      schemaUri: "urn:shipwithali:owner-export-schema:taxonomy:1.1", schemaVersion: "1.1", digest: "d".repeat(64) }], assets: [],
  } as unknown as OwnerExportPackageManifest;
  try {
    for (let index = 0; index < eventIds.length; index++) {
      const eventId = eventIds[index]!;
      const isReclaim = index === 2;
      const acquisitionColumn = predecessor ? "" : ",lease_acquired_at";
      const acquisitionValue = predecessor ? "" : ",case when $4 then clock_timestamp()-interval '20 minutes' else null end";
      await adminConnection.query(`insert into operations.outbox_events
        (event_id,event_type,schema_version,aggregate_id,aggregate_version,payload,correlation_id,occurred_at,available_at,
         attempt_count,lease_owner,lease_token,lease_expires_at${acquisitionColumn})
        values ($1::uuid,'gate.compat.v1',1,$2::uuid,1,'{"type":"gate.compat.v1","version":1,"value":{}}'::jsonb,
          'compat-fixture',clock_timestamp(),clock_timestamp()-interval '1 hour',$3,
          case when $4 then 'expired-worker' else null end,case when $4 then 'expired-token' else null end,
          case when $4 then clock_timestamp()-interval '1 minute' else null end${acquisitionValue})`,
        [eventId, uuid(firstIdentity + 40 + index), isReclaim ? 1 : 0, isReclaim]);
    }
    const claimedEvents = await operations.outbox.claimDue({ workerId: "compatibility-worker", now: new Date().toISOString(),
      leaseDurationSeconds: 60, limit: 10 });
    const eventLeases = new Map(claimedEvents.map((item) => [item.eventId, item.leaseToken]));
    expect(eventIds.every((id) => eventLeases.has(id))).toBe(true);
    expect(await operations.outbox.complete(eventIds[0]!, eventLeases.get(eventIds[0]!)!, new Date().toISOString())).toBe(true);
    expect(await operations.outbox.scheduleRetry(eventIds[1]!, eventLeases.get(eventIds[1]!)!, parseSafeErrorCode("HANDLER_TIMEOUT"), 0)).toBe(true);
    expect(await operations.outbox.release(eventIds[2]!, eventLeases.get(eventIds[2]!)!)).toBe(true);

    for (let index = 0; index < jobIds.length; index++) {
      const jobId = jobIds[index]!;
      const isReclaim = index === 2;
      const acquisitionColumn = predecessor ? "" : ",lease_acquired_at";
      const acquisitionValue = predecessor ? "" : ",case when $4 then clock_timestamp()-interval '20 minutes' else null end";
      await adminConnection.query(`insert into operations.jobs
        (job_id,job_type,payload_version,payload,available_at,status,attempt_count,lease_owner,lease_token,lease_expires_at${acquisitionColumn})
        values ($1::uuid,$2,1,$3::jsonb,clock_timestamp()-interval '1 hour',case when $4 then 'leased' else 'available' end,
          case when $4 then 1 else 0 end,case when $4 then 'expired-worker' else null end,case when $4 then 'expired-token' else null end,
          case when $4 then clock_timestamp()-interval '1 minute' else null end${acquisitionValue})`,
      [jobId, "gate.compat.v1", JSON.stringify({ type: "gate.compat.v1", version: 1, value: {} }), isReclaim]);
    }
    const claimedJobs = await operations.jobs.claimDue({ workerId: "compatibility-worker", now: new Date().toISOString(),
      leaseDurationSeconds: 60, limit: 10, jobTypes: ["gate.compat.v1"] });
    const jobLeases = new Map(claimedJobs.map((item) => [item.jobId, item.leaseToken]));
    expect(jobIds.every((id) => jobLeases.has(id))).toBe(true);
    expect(await operations.jobs.complete(jobIds[0]!, jobLeases.get(jobIds[0]!)!, new Date().toISOString())).toBe(true);
    expect(await operations.jobs.scheduleRetry(jobIds[1]!, jobLeases.get(jobIds[1]!)!, parseSafeErrorCode("HANDLER_TIMEOUT"), 0)).toBe(true);
    expect(await operations.jobs.release(jobIds[2]!, jobLeases.get(jobIds[2]!)!)).toBe(true);

    await adminConnection.query(`insert into portability.owner_exports
      (export_id,portfolio_id,owner_id,included_scopes,status,schema_version,requested_at,started_at,aggregate_version,
       candidate_artifact_id,candidate_sha256,candidate_content_length)
      values ($1::uuid,$2::uuid,$3::uuid,array['taxonomy']::text[],'building','1.2',clock_timestamp()-interval '2 minutes',
        clock_timestamp()-interval '1 minute',2,$4::uuid,$5,1)`, [exportId, portfolio, owner, exportArtifactId, "e".repeat(64)]);
    const exportPayload = JSON.stringify({ exportId, portfolioId: portfolio, ownerId: owner, includedScopes: ["taxonomy"] });
    if (predecessor) {
      await adminConnection.query(`insert into operations.jobs
        (job_id,job_type,payload_version,payload,available_at,status,attempt_count,lease_owner,lease_token,lease_expires_at)
        values ($1::uuid,$2,1,$3::jsonb,clock_timestamp(),'leased',1,'compatibility-worker',$4,clock_timestamp()+interval '5 minutes')`,
      [exportJobId, OWNER_EXPORT_ASSEMBLY_JOB_TYPE, exportPayload, leaseToken]);
    } else {
      await adminConnection.query(`insert into operations.jobs
        (job_id,job_type,payload_version,payload,available_at,status,attempt_count,lease_owner,lease_token,lease_expires_at,lease_acquired_at)
        values ($1::uuid,$2,1,$3::jsonb,clock_timestamp(),'leased',1,'compatibility-worker',$4,
          clock_timestamp()+interval '5 minutes',clock_timestamp())`, [exportJobId, OWNER_EXPORT_ASSEMBLY_JOB_TYPE, exportPayload, leaseToken]);
    }
    const ownerExports = createPostgresOwnerExportStore(runtime.database, {
      outbox: operations.outbox,
      transactions: runtime.transactions,
    });
    const transition = await ownerExports.applyOwnerExportTransition({ exportId, fromStatus: "building", toStatus: "ready",
      expectedAggregateVersion: 2, leaseToken, transitionedAt: new Date().toISOString(), actingJobId: exportJobId,
      integrityManifest: manifest, artifactId: exportArtifactId });
    expect(transition).toMatchObject({ ok: true, value: { kind: "applied" } });
    const durable = await adminConnection.query(`select owner_export.status,job.status as job_status,job.lease_token
      from portability.owner_exports owner_export join operations.jobs job on job.job_id=$2::uuid where owner_export.export_id=$1::uuid`,
    [exportId, exportJobId]);
    expect(durable.rows).toEqual([{ status: "ready", job_status: "completed", lease_token: null }]);
    const produced = await adminConnection.query(`select count(*)::int as count from operations.outbox_events
      where causation_id=$1::text and event_type='portability.export_produced.v1'`, [exportJobId]);
    expect(produced.rows[0]?.count).toBe(1);
  } finally {
    await adminConnection.query("delete from operations.outbox_events where aggregate_id=$1::uuid or event_id=any($2::uuid[])", [exportId, eventIds]);
    await adminConnection.query("delete from portability.owner_exports where export_id=$1::uuid", [exportId]);
    await adminConnection.query("delete from operations.jobs where job_id=any($1::uuid[])", [[...jobIds, exportJobId]]);
    await runtime.resource.close();
  }
}

async function insertOutboxFixture(): Promise<void> {
  const rows = [
    [101, observedAt, "2026-10-27T11:59:00.000Z", 0, null, null, null, null, JSON.stringify({ marker })],
    [102, observedAt, "2026-10-27T13:00:00.000Z", 0, null, null, null, null, "{}"],
    [103, "2026-10-27T10:00:00.000Z", "2026-10-27T13:00:00.000Z", 2, null, null, null, null, "{}"],
    [104, "2026-10-27T11:00:00.000Z", "2026-10-27T11:00:00.000Z", 0, null, null, null, "2026-10-27T11:59:00.000Z", "{}"],
    [105, "2026-10-27T11:00:00.000Z", "2026-10-27T11:00:00.000Z", 5, null, null, "2026-10-27T11:59:00.000Z", null, "{}"],
    [106, "2026-10-27T10:00:00.000Z", "2026-10-27T10:00:00.000Z", 0, "test-worker", "active-token", null, null, "{}"],
    [107, "2026-10-27T10:00:00.000Z", "2026-10-27T10:00:00.000Z", 0, "test-worker", "expired-token", null, null, "{}"],
  ] as const;
  for (const [id, occurredAt, availableAt, attempts, leaseOwner, leaseToken, deadAt, completedAt, payload] of rows) {
    await admin.query(`insert into operations.outbox_events
      (event_id,event_type,schema_version,aggregate_id,aggregate_version,payload,correlation_id,occurred_at,available_at,
       attempt_count,lease_owner,lease_token,lease_expires_at,lease_acquired_at,dead_at,completed_at)
      values ($1::uuid,'fixture.event.v1',1,$2::uuid,1,$3::jsonb,'fixture-correlation',$4::timestamptz,$5::timestamptz,
       $6,$7::text,$8::text,case when $7::text is null then null when $8::text='active-token' then '2026-10-27T12:01:00Z'::timestamptz else '2026-10-27T11:59:00Z'::timestamptz end,
       case when $7::text is null then null else '2026-10-27T10:00:00Z'::timestamptz end,$9::timestamptz,$10::timestamptz)`,
      [uuid(id), uuid(900 + id), payload, occurredAt, availableAt, attempts, leaseOwner, leaseToken, deadAt, completedAt]);
  }
  await admin.query(`insert into operations.outbox_events
    (event_id,event_type,schema_version,aggregate_id,aggregate_version,payload,correlation_id,occurred_at,available_at,completed_at)
    select ('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 10000),12,'0'))::uuid,
      'fixture.history.v1',1,'0196a1b2-7c3d-7e11-9f22-000000000900'::uuid,1,'{}'::jsonb,'history',
      '2026-10-01T00:00:00Z'::timestamptz + i * interval '1 second',
      '2026-10-01T00:00:00Z'::timestamptz, '2026-10-02T00:00:00Z'::timestamptz
    from generate_series(1,5000) i`);
}

async function insertJobFixture(): Promise<void> {
  await admin.query(`insert into operations.jobs
    (job_id,job_type,payload_version,payload,available_at,status,attempt_count)
    values ($1::uuid,'fixture.available.v1',1,'{}'::jsonb,'2026-10-27T11:00:00Z','available',0)`, [uuid(201)]);
  await admin.query(`insert into operations.jobs
    (job_id,job_type,payload_version,payload,available_at,status,attempt_count,lease_owner,lease_token,lease_expires_at,lease_acquired_at)
    values ($1::uuid,'fixture.leased.v1',1,'{}'::jsonb,'2026-10-27T11:00:00Z','leased',1,'fixture','active','2026-10-27T12:01:00Z','2026-10-27T11:00:00Z')`, [uuid(202)]);
  await admin.query(`insert into operations.jobs
    (job_id,job_type,payload_version,payload,available_at,status,attempt_count,last_error_code)
    values ($1::uuid,'fixture.dead.v1',1,'{}'::jsonb,'2026-10-27T11:00:00Z','dead',5,'FIXTURE_FAILED')`, [uuid(203)]);
  await admin.query(`insert into operations.jobs
    (job_id,job_type,payload_version,payload,available_at,status,attempt_count,completed_at)
    select ('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 20000),12,'0'))::uuid,
      'fixture.history.v1',1,'{}'::jsonb,'2026-10-01T00:00:00Z','completed',0,'2026-10-02T00:00:00Z'
    from generate_series(1,3000) i`);
}

async function insertExports(): Promise<void> {
  type ExportFixture = { readonly id: number; readonly status: "requested" | "building" | "ready" | "failed" | "expired";
    readonly requested: string; readonly started?: string; readonly completed?: string; readonly failed?: string;
    readonly expired?: string; readonly length?: number };
  const states: readonly ExportFixture[] = [
    { id: 301, status: "requested", requested: "2026-10-27T11:50:00Z" },
    { id: 302, status: "building", requested: "2026-10-27T11:40:00Z", started: "2026-10-27T11:41:00Z" },
    { id: 303, status: "ready", requested: "2026-10-27T11:30:00Z", started: "2026-10-27T11:31:00Z", completed: "2026-10-27T11:32:00Z", length: 64 },
    { id: 304, status: "failed", requested: "2026-10-27T11:20:00Z", failed: "2026-10-27T11:21:00Z" },
    { id: 305, status: "expired", requested: "2026-10-27T11:10:00Z", started: "2026-10-27T11:11:00Z", completed: "2026-10-27T11:12:00Z", expired: "2026-10-27T12:00:00Z", length: 96 },
    { id: 306, status: "requested", requested: "2026-10-20T11:00:00Z" },
    { id: 307, status: "building", requested: "2026-10-20T10:00:00Z", started: "2026-10-20T10:01:00Z" },
    { id: 308, status: "ready", requested: "2026-10-20T11:00:00Z", started: "2026-10-20T11:01:00Z", completed: "2026-10-27T11:55:00Z", length: 128 },
    { id: 309, status: "failed", requested: "2026-10-20T11:00:00Z", failed: "2026-10-27T11:50:00Z" },
    { id: 310, status: "expired", requested: "2026-10-20T11:00:00Z", started: "2026-10-20T11:01:00Z", completed: "2026-10-20T11:12:00Z", expired: "2026-10-27T11:40:00Z", length: 192 },
    { id: 311, status: "ready", requested: "2026-10-27T11:30:00Z", started: "2026-10-27T11:31:00Z", completed: "2026-10-26T11:59:59Z", length: 32 },
    { id: 312, status: "ready", requested: "2026-10-27T11:30:00Z", started: "2026-10-27T11:31:00Z", completed: "2026-10-27T12:01:00Z", length: 32 },
    { id: 313, status: "failed", requested: "2026-10-27T11:20:00Z", failed: "2026-10-26T11:59:59Z" },
    { id: 314, status: "failed", requested: "2026-10-27T11:20:00Z", failed: "2026-10-27T12:01:00Z" },
    { id: 315, status: "expired", requested: "2026-10-27T11:10:00Z", started: "2026-10-27T11:11:00Z", completed: "2026-10-27T11:12:00Z", expired: "2026-10-26T11:59:59Z", length: 32 },
    { id: 316, status: "expired", requested: "2026-10-27T11:10:00Z", started: "2026-10-27T11:11:00Z", completed: "2026-10-27T11:12:00Z", expired: "2026-10-27T12:01:00Z", length: 32 },
  ];
  for (const row of states) {
    const ready = row.status === "ready" || row.status === "expired";
    await admin.query(`insert into portability.owner_exports
      (export_id,portfolio_id,owner_id,included_scopes,status,schema_version,requested_at,started_at,completed_at,failed_at,expired_at,
       failure_code,manifest,artifact_id,artifact_sha256,artifact_content_length)
      values ($1::uuid,$2::uuid,$3::uuid,array['portfolio-configuration']::text[],$4,'1.2',$5::timestamptz,$6::timestamptz,
       $7::timestamptz,$8::timestamptz,$9::timestamptz,$10,$11::jsonb,$12::uuid,$13,$14)`,
      [uuid(row.id), portfolioId, ownerId, row.status, row.requested, row.started ?? null, row.completed ?? null,
        row.failed ?? null, row.expired ?? null, row.status === "failed" ? "FIXTURE_FAILED" : null,
        ready ? JSON.stringify({ marker }) : null, ready ? uuid(800 + row.id) : null, ready ? "a".repeat(64) : null, row.length ?? null]);
  }
  await admin.query(`insert into portability.owner_exports
    (export_id,portfolio_id,owner_id,included_scopes,status,schema_version,requested_at)
    select ('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 30000),12,'0'))::uuid,
      $1::uuid,$2::uuid,array['portfolio-configuration']::text[],'requested','1.2',
      '2026-10-27T11:00:00Z'::timestamptz - i * interval '1 second'
    from generate_series(1,3000) i`, [otherPortfolioId, ownerId]);
}

describe("operations summary PostgreSQL qualification", () => {
  beforeAll(async () => {
    if (!adminUrl || !workerUrl || !predecessorAdminUrl || !predecessorWorkerUrl || !freshAdminUrl || !freshWorkerUrl) {
      throw new Error("OPERATIONS_SUMMARY_DATABASE_ENV_MISSING");
    }
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    predecessorAdmin = new Client({ connectionString: predecessorAdminUrl });
    await predecessorAdmin.connect();
    freshAdmin = new Client({ connectionString: freshAdminUrl });
    await freshAdmin.connect();
    worker = createPostgresRuntimeDatabase(workerUrl, { max: 2 });
    await insertOutboxFixture();
    await insertJobFixture();
    await insertExports();
    await admin.query(`insert into operations.phase7_schedule_progress
      (portfolio_id,first_policy_period,required_through_period,retention_scheduled_through,retention_complete_through,
       aggregate_scheduled_through,aggregate_finished_through,last_complete_period,phase)
      values ($1::uuid,'2026-10-01','2026-10-27','2026-10-27','2026-10-26','2026-10-26','2026-10-25','2026-10-24','retention'),
       ($2::uuid,'2026-09-01','2026-10-27','2026-10-27','2026-10-20','2026-10-20','2026-10-20','2026-10-20','retention')`,
      [portfolioId, otherPortfolioId]);
    await admin.query("analyze operations.outbox_events; analyze operations.jobs; analyze portability.owner_exports");
  }, 30_000);

  afterAll(async () => {
    await worker?.resource.close();
    await freshAdmin?.end();
    await predecessorAdmin?.end();
    await admin?.end();
  });

  it("#252 AC03-05 replays a persisted crash claim, retries an isolated failing sink, and resolves one deduplicated incident under worker RLS", async () => {
    const at = new Date().toISOString();
    const incidentId = uuid(290_001) as StableId<"OperationsIncident">;
    const scopeKey = `integration-${incidentId}`;
    const rule = CORE_INCIDENT_RULES.find((candidate) => candidate.code === "OUTBOX_ELIGIBLE_AGE")!;
    const input: DurableIncidentInput = { incidentId, scopeKey, rule, value: 901,
      firstObservedAt: at, lastObservedAt: at };
    const store = createPostgresIncidentLifecycleStore(worker.database);
    const service = createIncidentLifecycleService({ store, sink: { async deliver(payload) {
      expect(payload).toEqual({ environment: "unknown", code: rule.code, severity: rule.severity, owner: rule.owner, remediation: rule.remediation,
        firstObservedAt: at, lastObservedAt: at, occurrences: 2 });
      throw new Error("ISOLATED_SINK_FAILURE_PRIVATE_MARKER");
    } } });
    try {
      await store.upsert(input);
      const repeated = await store.upsert(input);
      expect(repeated.occurrences).toBe(2);
      expect(repeated.owner).toBe("operations");
      expect(repeated.remediation).toMatch(/^runbook:/u);
      expect((await service.inspect({ kind: "owner", jobId: uuid(290_002), purpose: "operations.observability.read" })).ok).toBe(false);
      const inspection = await service.inspect({ kind: "system", jobId: uuid(290_002), purpose: "operations.observability.read" });
      expect(inspection).toMatchObject({ ok: true, value: [{ code: rule.code, owner: "operations", remediation: rule.remediation }] });
      expect(JSON.stringify(inspection)).not.toMatch(/incidentId|scopeKey|sourceId|PRIVATE|provider|payload/i);
      const denied = createPostgresRuntimeDatabase(process.env["OPERATIONS_SUMMARY_APPLICATION_DATABASE_URL"]!);
      try { await expect(createPostgresIncidentLifecycleStore(denied.database).listOpen(1)).rejects.toBeInstanceOf(PostgresInfrastructureError); }
      finally { await denied.resource.close(); }
      await admin.query("set role anon");
      try { await expect(admin.query("select incident_key from operations.incidents limit 1")).rejects.toMatchObject({ code: "42501" }); }
      finally { await admin.query("reset role"); }
      const crashed = (await store.claimDue(1, at))[0];
      expect(crashed?.deliveryClaim).toBeDefined(); // process interruption after durable claim
      await admin.query("update operations.incidents set delivery_lease_expires_at=clock_timestamp()-interval '1 second' where incident_id=$1::uuid", [incidentId]);
      expect(await service.deliverDue(at)).toEqual({ attempted: 1, delivered: 0, failed: 1 });
      await admin.query("update operations.incidents set next_delivery_at=clock_timestamp()-interval '1 second' where incident_id=$1::uuid", [incidentId]);
      expect(await service.deliverDue(at)).toEqual({ attempted: 1, delivered: 0, failed: 1 });
      expect(await service.resolve(rule.key, scopeKey, new Date(Date.now() + 1_000).toISOString())).toBe(true);
      expect(await service.resolve(rule.key, scopeKey, new Date(Date.now() + 2_000).toISOString())).toBe(false);
      const stored = await admin.query(`select occurrences, owner_role, remediation_pointer, delivery_attempts, delivery_error_code,
          delivery_state, resolved_at is not null as resolved, recovery_recorded_at is not null as recovery_recorded
        from operations.incidents where incident_id=$1::uuid`, [incidentId]);
      expect(stored.rows).toEqual([{ occurrences: 2, owner_role: "operations", remediation_pointer: rule.remediation,
        delivery_attempts: 3, delivery_error_code: "INCIDENT_DELIVERY_FAILED", delivery_state: "not-required",
        resolved: true, recovery_recorded: true }]);
      expect(JSON.stringify(stored.rows)).not.toContain("ISOLATED_SINK_FAILURE_PRIVATE_MARKER");
    } finally {
      await admin.query("delete from operations.incidents where incident_id=$1::uuid", [incidentId]);
    }
  }, 30_000);

  it("#252 AC01-03 composes real PostgreSQL dead work into one delivered incident and recovers it after completion", async () => {
    const runtime = createPostgresRuntimeDatabase(freshWorkerUrl!, { max: 2 });
    const scope = uuid(291_001) as StableId<"Portfolio">;
    const deadJob = uuid(291_002);
    const completedJob = uuid(291_003);
    const futureJob = uuid(291_004);
    const delivered: Array<Readonly<Record<string, unknown>>> = [];
    const incidentStore = createPostgresIncidentLifecycleStore(runtime.database);
    const summaryService = createOperationsSummaryService({
      reader: createPostgresOperationsSummaryReader(runtime.database), clock: { now: () => new Date().toISOString() },
    });
    const pass = createOperationalIncidentPass({
      readSummary: async () => {
        const result = await summaryService.readOperationsSummary({ actor: { kind: "system",
          jobId: uuid(291_005) as StableId<"Job">, purpose: OPERATIONS_SUMMARY_PURPOSE }, portfolioId: scope });
        if (!result.ok) throw new Error("REAL_OPERATIONS_SUMMARY_UNAVAILABLE");
        return result.value;
      },
      store: incidentStore,
      sink: { async deliver(payload) { delivered.push(payload); } },
      newIncidentId: (() => { let serial = 10; return () => uuid(291_100 + serial++) as StableId<"OperationsIncident">; })(),
      now: () => new Date().toISOString(), deliveryTimeoutMs: 500, deliveryBudgetMs: 2_000,
    });
    try {
      await freshAdmin.query(`insert into operations.jobs
        (job_id,job_type,payload_version,payload,available_at,status,attempt_count,last_error_code,completed_at)
        values ($1::uuid,'fixture.dead.v1',1,'{}'::jsonb,clock_timestamp(),'dead',8,'FIXTURE_DEAD',null),
          ($2::uuid,'fixture.completed.v1',1,'{}'::jsonb,clock_timestamp(),'completed',1,null,clock_timestamp()),
          ($3::uuid,'fixture.future.v1',1,'{}'::jsonb,clock_timestamp()+interval '1 day','available',0,null,null)`,
      [deadJob, completedJob, futureJob]);
      const first = await pass.run(scope);
      expect(first.openOrUpdated).toBe(1);
      expect(first.delivery).toMatchObject({ attempted: 1, delivered: 1, failed: 0 });
      expect(delivered).toEqual([expect.objectContaining({ code: "JOB_DEAD_WORK", owner: "operations",
        remediation: "runbook:operations/jobs", occurrences: 1 })]);
      await freshAdmin.query("update operations.jobs set status='completed', completed_at=clock_timestamp(), last_error_code=null where job_id=$1::uuid", [deadJob]);
      const recovered = await pass.run(scope);
      expect(recovered.openOrUpdated).toBe(0);
      expect(delivered).toHaveLength(1);
      const state = await freshAdmin.query(`select count(*)::int as total, count(*) filter (where resolved_at is not null)::int as resolved,
        count(*) filter (where delivery_state='delivered')::int as delivered
        from operations.incidents where incident_key like 'jobs.dead_depth:%'`);
      expect(state.rows[0]).toEqual({ total: 1, resolved: 1, delivered: 0 });
    } finally {
      await freshAdmin.query("delete from operations.jobs where job_id=any($1::uuid[])", [[deadJob, completedJob, futureJob]]);
      await freshAdmin.query("delete from operations.incidents where incident_key like 'jobs.dead_depth:%'");
      await runtime.resource.close();
    }
  }, 30_000);

  it("#252 review P1 preserves a pending claim deadline during observation and fences stale delivery outcomes across reclaim", async () => {
    const firstRuntime = createPostgresRuntimeDatabase(freshWorkerUrl!, { max: 1 });
    const secondRuntime = createPostgresRuntimeDatabase(freshWorkerUrl!, { max: 1 });
    const incidentId = uuid(292_001) as StableId<"OperationsIncident">;
    const at = new Date().toISOString();
    const rule = CORE_INCIDENT_RULES.find((candidate) => candidate.code === "OUTBOX_ELIGIBLE_AGE")!;
    const input: DurableIncidentInput = { incidentId, scopeKey: `claim-fence-${incidentId}`, rule,
      value: 901, firstObservedAt: at, lastObservedAt: at };
    const firstStore = createPostgresIncidentLifecycleStore(firstRuntime.database);
    const secondStore = createPostgresIncidentLifecycleStore(secondRuntime.database);
    let signalSinkStarted!: () => void;
    let releaseSink!: () => void;
    const sinkStarted = new Promise<void>((resolve) => { signalSinkStarted = resolve; });
    const sinkReleased = new Promise<void>((resolve) => { releaseSink = resolve; });
    const service = createIncidentLifecycleService({ store: firstStore, deliveryTimeoutMs: 2_000, deliveryBudgetMs: 3_000,
      sink: { async deliver() { signalSinkStarted(); await sinkReleased; } } });
    try {
      await firstStore.upsert(input);
      const inFlight = service.deliverDue(at);
      await sinkStarted;
      const before = await freshAdmin.query(`select next_delivery_at, delivery_lease_token, delivery_lease_generation
        from operations.incidents where incident_id=$1::uuid`, [incidentId]);
      await secondStore.upsert({ ...input, lastObservedAt: new Date(Date.now() + 1).toISOString() });
      const after = await freshAdmin.query(`select next_delivery_at, delivery_lease_token, delivery_lease_generation
        from operations.incidents where incident_id=$1::uuid`, [incidentId]);
      expect(after.rows).toEqual(before.rows);
      expect(await secondStore.claimDue(1, at)).toHaveLength(0);
      releaseSink();
      await expect(inFlight).resolves.toMatchObject({ attempted: 1, delivered: 1, failed: 0 });

      const reclaimId = uuid(292_002) as StableId<"OperationsIncident">;
      const reclaimInput = { ...input, incidentId: reclaimId, scopeKey: `claim-fence-${reclaimId}` };
      await firstStore.upsert(reclaimInput);
      const oldAttempt = (await firstStore.claimDue(1, at))[0];
      expect(oldAttempt?.deliveryClaim).toBeDefined();
      await freshAdmin.query("update operations.incidents set delivery_lease_expires_at=clock_timestamp()-interval '1 second' where incident_id=$1::uuid", [reclaimId]);
      const newAttempt = (await secondStore.claimDue(1, at))[0];
      expect(newAttempt?.deliveryClaim?.generation).toBeGreaterThan(oldAttempt?.deliveryClaim?.generation ?? 0);
      if (!oldAttempt?.deliveryClaim || !newAttempt?.deliveryClaim) throw new Error("INCIDENT_RECLAIM_CLAIM_MISSING");
      expect(await firstStore.markDelivered(oldAttempt.deliveryClaim, at)).toBe(false);
      expect(await firstStore.markDeliveryFailed(oldAttempt.deliveryClaim, at, "INCIDENT_DELIVERY_FAILED", null)).toBe(false);
      expect(await secondStore.markDelivered(newAttempt.deliveryClaim, at)).toBe(true);
    } finally {
      releaseSink();
      await freshAdmin.query("delete from operations.incidents where incident_id=any($1::uuid[])", [[incidentId, uuid(292_002)]]);
      await firstRuntime.resource.close();
      await secondRuntime.resource.close();
    }
  }, 30_000);

  it("#252 AC06 keeps actual PostgreSQL summary and core readiness through optional outages; required identity/config failures are unready", async () => {
    const runtime = createPostgresRuntimeDatabase(freshWorkerUrl!, { max: 1 });
    try {
      const readiness = createOperationsReadiness({ required: [
        { name: "configuration", async check() { return true; } },
        { name: "identity", async check() { return true; } },
        { name: "database", check: () => runtime.readiness.check() },
      ], optional: ["export", "storage", "alert", "measurement", "backup"].map((name) => ({
        name: name as "export" | "storage" | "alert" | "measurement" | "backup", async check() { return false; },
      })) });
      await expect(readiness.read()).resolves.toEqual({ ready: true,
        degradedCapabilities: ["export", "storage", "alert", "measurement", "backup"] });
      const summaryService = createOperationsSummaryService({
        reader: createPostgresOperationsSummaryReader(runtime.database),
        integrityLogReader: { async readOwnerExportIntegrityWindow() { throw new Error("optional-export-log-down"); } },
        retentionFailureLogReader: { async readRetentionFailureWindow() { throw new Error("optional-measurement-log-down"); } },
        clock: { now: () => new Date().toISOString() },
      });
      const summary = await summaryService.readOperationsSummary({ actor: { kind: "system",
        jobId: uuid(293_001) as StableId<"Job">, purpose: OPERATIONS_SUMMARY_PURPOSE }, portfolioId });
      expect(summary.ok).toBe(true);
      if (summary.ok) {
        expect(summary.value.outbox.eligibleDepth).toEqual(expect.objectContaining({ value: expect.any(Number) }));
        expect(summary.value.exports.integrityFailures).toMatchObject({ state: "unknown", reason: "incomplete-sample" });
        expect(summary.value.retention.failures).toMatchObject({ state: "unknown", reason: "incomplete-sample" });
        expect(JSON.stringify(summary.value)).not.toMatch(/optional-export-log-down|optional-measurement-log-down/iu);
      }
      const mandatoryFailure = createOperationsReadiness({ required: [
        { name: "configuration", async check() { return true; } },
        { name: "identity", async check() { return false; } },
        { name: "database", check: () => runtime.readiness.check() },
      ] });
      await expect(mandatoryFailure.check()).resolves.toBe(false);
      const missingMandatory = createOperationsReadiness({ required: [{ name: "database", check: () => runtime.readiness.check() }] });
      await expect(missingMandatory.check()).resolves.toBe(false);
    } finally { await runtime.resource.close(); }
  }, 30_000);

  it("supports queue claim, reclaim, complete, retry, and Owner Export completion before and after migration64", async () => {
    const currentColumns = await admin.query(`select count(*)::int as count from information_schema.columns
      where table_schema='operations' and table_name in ('outbox_events','jobs') and column_name='lease_acquired_at'`);
    const predecessorColumns = await predecessorAdmin.query(`select count(*)::int as count from information_schema.columns
      where table_schema='operations' and table_name in ('outbox_events','jobs') and column_name='lease_acquired_at'`);
    expect(currentColumns.rows[0]?.count).toBe(2);
    expect(predecessorColumns.rows[0]?.count).toBe(0);
    const fixtureIds = [101, 102, 103, 104, 105, 106, 107].map((id) => uuid(id));
    const jobFixtureIds = [201, 202, 203].map((id) => uuid(id));
    const before = await admin.query(`select 'outbox' as source,event_id::text as id,attempt_count,lease_owner,lease_token,
        lease_expires_at::text as lease_expires_at,completed_at::text as completed_at,dead_at::text as dead_at
      from operations.outbox_events where event_id=any($1::uuid[])
      union all
      select 'job' as source,job_id::text as id,attempt_count,lease_owner,lease_token,lease_expires_at::text,completed_at::text,null::text
      from operations.jobs where job_id=any($2::uuid[]) order by source,id`, [fixtureIds, jobFixtureIds]);
    const freshBefore = await freshAdmin.query(`select
      (select count(*)::int from operations.outbox_events) as events,
      (select count(*)::int from operations.jobs) as jobs,
      (select count(*)::int from portability.owner_exports) as exports,
      (select count(*)::int from operations.phase7_schedule_progress) as progress`);
    await exerciseQueueAndOwnerExportCompatibility(predecessorAdmin, predecessorWorkerUrl!, true, 700);
    await exerciseQueueAndOwnerExportCompatibility(freshAdmin, freshWorkerUrl!, false, 800);
    const after = await admin.query(`select 'outbox' as source,event_id::text as id,attempt_count,lease_owner,lease_token,
        lease_expires_at::text as lease_expires_at,completed_at::text as completed_at,dead_at::text as dead_at
      from operations.outbox_events where event_id=any($1::uuid[])
      union all
      select 'job' as source,job_id::text as id,attempt_count,lease_owner,lease_token,lease_expires_at::text,completed_at::text,null::text
      from operations.jobs where job_id=any($2::uuid[]) order by source,id`, [fixtureIds, jobFixtureIds]);
    expect(after.rows).toEqual(before.rows);
    const freshAfter = await freshAdmin.query(`select
      (select count(*)::int from operations.outbox_events) as events,
      (select count(*)::int from operations.jobs) as jobs,
      (select count(*)::int from portability.owner_exports) as exports,
      (select count(*)::int from operations.phase7_schedule_progress) as progress`);
    expect(freshAfter.rows).toEqual(freshBefore.rows);
  }, 60_000);

  it("retries a transient capability probe failure on the same database handle before queue and Owner Export completion", async () => {
    await exerciseQueueAndOwnerExportCompatibility(freshAdmin, freshWorkerUrl!, false, 900, true);
  }, 60_000);

  it("preserves measured null oldest age for empty and future-only queues and zero for newly eligible work", async () => {
    const runtime = createPostgresRuntimeDatabase(freshWorkerUrl!, { max: 1 });
    const service = createOperationsSummaryService({ reader: createPostgresOperationsSummaryReader(runtime.database),
      clock: { now: () => observedAt } });
    const read = () => service.readOperationsSummary({
      actor: { kind: "system", jobId: uuid(510) as StableId<"Job">, purpose: OPERATIONS_SUMMARY_PURPOSE }, portfolioId,
    });
    const eventId = uuid(511);
    try {
      const empty = await read();
      expect(empty.ok).toBe(true);
      if (!empty.ok) throw new Error("EMPTY_QUEUE_SUMMARY_FAILED");
      expect(empty.value.outbox.eligibleDepth).toMatchObject({ value: 0, capped: false });
      expect(empty.value.outbox.oldestEligibleAgeSeconds).toMatchObject({ state: "measured", value: null });

      await freshAdmin.query(`insert into operations.outbox_events
        (event_id,event_type,schema_version,aggregate_id,aggregate_version,payload,correlation_id,occurred_at,available_at)
        values ($1::uuid,'fixture.event.v1',1,$2::uuid,1,'{}'::jsonb,'future-only-fixture',
          $3::timestamptz,$3::timestamptz + interval '1 hour')`, [eventId, uuid(512), observedAt]);
      const future = await read();
      expect(future.ok).toBe(true);
      if (!future.ok) throw new Error("FUTURE_QUEUE_SUMMARY_FAILED");
      expect(future.value.outbox.eligibleDepth).toMatchObject({ value: 0, capped: false });
      expect(future.value.outbox.futureDelayedDepth.value).toBe(1);
      expect(future.value.outbox.oldestEligibleAgeSeconds).toMatchObject({ state: "measured", value: null });

      await freshAdmin.query("update operations.outbox_events set available_at=$2::timestamptz where event_id=$1::uuid",
        [eventId, observedAt]);
      const eligible = await read();
      expect(eligible.ok).toBe(true);
      if (!eligible.ok) throw new Error("ELIGIBLE_QUEUE_SUMMARY_FAILED");
      expect(eligible.value.outbox.eligibleDepth).toMatchObject({ value: 1, capped: false });
      expect(eligible.value.outbox.oldestEligibleAgeSeconds).toMatchObject({ state: "measured", value: 0 });
    } finally {
      await freshAdmin.query("delete from operations.outbox_events where event_id=$1::uuid", [eventId]);
      await runtime.resource.close();
    }
  });

  it("reads a bounded one-Portfolio summary under worker RLS, preserves unknown values, and performs no writes", async () => {
    const query: OperationsSummaryQuery = { portfolioId, observedAt, windowSeconds: 900, maxRows: 1_000 };
    const raw = await buildOperationsSummaryQuery(query).execute(worker.database);
    expect(raw.rows).toHaveLength(1);
    const before = await admin.query(`select
      (select count(*) from operations.outbox_events) as events,
      (select count(*) from operations.jobs) as jobs,
      (select count(*) from portability.owner_exports) as exports,
      (select count(*) from operations.phase7_schedule_progress) as progress`);
    const service = createOperationsSummaryService({ reader: createPostgresOperationsSummaryReader(worker.database), clock: { now: () => observedAt } });
    const result = await service.readOperationsSummary({
      actor: { kind: "system", jobId: uuid(500) as StableId<"Job">, purpose: OPERATIONS_SUMMARY_PURPOSE },
      portfolioId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.outbox.eligibleDepth).toMatchObject({ value: 3, capped: false, sampleLimit: 1_000 });
    expect(result.value.scope).toEqual({ portfolio: "one-authorized-portfolio", queues: "system-wide-operations",
      runtimeObservations: "system-wide-restricted-operator-log-source" });
    expect(result.value.outbox.oldestEligibleAgeSeconds).toMatchObject({ state: "measured", value: 7_200 });
    expect(result.value.outbox.futureDelayedDepth.value).toBe(2);
    expect(result.value.outbox.retryDepth.value).toBe(1);
    expect(result.value.outbox.deadDepth.value).toBe(1);
    expect(result.value.outbox.activeLeaseDepth.value).toBe(1);
    expect(result.value.outbox.expiredLeaseDepth.value).toBe(1);
    expect(result.value.leases.activeJobs.value).toBe(1);
    expect(result.value.leases.deadJobs.value).toBe(1);
    expect(result.value.exports.states).toMatchObject({ requested: { value: 2 }, building: { value: 2 }, ready: { value: 2 }, failed: { value: 2 }, expired: { value: 2 } });
    expect(result.value.exports.completedBuilds).toBe(2);
    expect(result.value.exports.maxBuildDurationMs).toBe(608_040_000);
    expect(result.value.exports.artifactBytes).toMatchObject({ state: "measured", value: 192 });
    expect(result.value.exports.capped).toBe(false);
    expect(result.value.retention.backlogPeriods).toMatchObject({ state: "measured", value: 1 });
    expect(result.value.aggregates.completeness).toMatchObject({ state: "measured", value: { backlogPeriods: 2 } });
    expect(result.value.leases.ageSeconds).toMatchObject({ state: "measured", value: 7_200 });
    expect(result.value.backup.state).toEqual({ state: "unknown", reason: "producer-not-installed" });
    expect(result.value.recovery.durationMs).toEqual({ state: "unknown", reason: "producer-not-installed" });
    expect(JSON.stringify(result.value)).not.toContain(marker);
    const after = await admin.query(`select
      (select count(*) from operations.outbox_events) as events,
      (select count(*) from operations.jobs) as jobs,
      (select count(*) from portability.owner_exports) as exports,
      (select count(*) from operations.phase7_schedule_progress) as progress`);
    expect(after.rows).toEqual(before.rows);

    const otherScope = await service.readOperationsSummary({ actor: { kind: "system", jobId: uuid(502) as StableId<"Job">,
      purpose: OPERATIONS_SUMMARY_PURPOSE }, portfolioId: otherPortfolioId as StableId<"Portfolio"> });
    expect(otherScope.ok).toBe(true);
    if (otherScope.ok) {
      expect(otherScope.value.scope.queues).toBe("system-wide-operations");
      expect(otherScope.value.outbox).toEqual(result.value.outbox);
      expect(otherScope.value.jobs).toEqual(result.value.jobs);
      expect(otherScope.value.exports.states.requested.value).toBe(1_000);
      expect(otherScope.value.exports.artifactBytes).toMatchObject({ state: "measured", value: 0 });
      expect(otherScope.value.retention.backlogPeriods).toMatchObject({ state: "measured", value: 7 });
      expect(otherScope.value.exports.states.requested).not.toEqual(result.value.exports.states.requested);
    }
  }, 20_000);

  it("keeps bootstrap completion dates unknown until the first policy period finishes", async () => {
    const bootstrapPortfolioId = uuid(7_000) as StableId<"Portfolio">;
    const databaseDate = await admin.query<{ current_period: string }>(
      "select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD') as current_period");
    const firstPolicyPeriod = databaseDate.rows[0]!.current_period;
    const priorPeriod = new Date(Date.parse(`${firstPolicyPeriod}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
    const operations = createPostgresOperationsPersistence(worker.database);
    const service = createOperationsSummaryService({ reader: createPostgresOperationsSummaryReader(worker.database),
      clock: { now: () => observedAt } });
    const readSummary = async (jobId: number) => {
      const result = await service.readOperationsSummary({ actor: { kind: "system", jobId: uuid(jobId) as StableId<"Job">,
        purpose: OPERATIONS_SUMMARY_PURPOSE }, portfolioId: bootstrapPortfolioId });
      if (!result.ok) throw new Error(`R12_BOOTSTRAP_SUMMARY_UNAVAILABLE:${result.error.code}`);
      return result.value;
    };

    try {
      const initialStatus = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: bootstrapPortfolioId,
        fromPeriod: firstPolicyPeriod, throughPeriod: firstPolicyPeriod });
      expect(initialStatus).toMatchObject({ firstPolicyPeriod, requiredThroughPeriod: firstPolicyPeriod,
        retentionCompleteThrough: priorPeriod, lastCompletePolicyPeriod: null, phase: "retention" });
      const initialCursors = await admin.query(`select to_char(first_policy_period,'YYYY-MM-DD') as first_period,
          to_char(required_through_period,'YYYY-MM-DD') as required_through,
          to_char(retention_complete_through,'YYYY-MM-DD') as retention_complete,
          to_char(aggregate_finished_through,'YYYY-MM-DD') as aggregate_finished,
          to_char(last_complete_period,'YYYY-MM-DD') as last_complete, phase
        from operations.phase7_schedule_progress where portfolio_id=$1::uuid`, [bootstrapPortfolioId]);
      expect(initialCursors.rows).toEqual([{ first_period: firstPolicyPeriod, required_through: firstPolicyPeriod,
        retention_complete: priorPeriod, aggregate_finished: priorPeriod, last_complete: priorPeriod, phase: "retention" }]);

      const initial = await readSummary(7_501);
      expect(initial.retention.lastCompletePolicyPeriod).toEqual({ state: "unknown", reason: "no-completed-policy-period" });
      expect(initial.retention.backlogPeriods).toMatchObject({ state: "measured", value: 1 });
      expect(initial.retention.phase).toMatchObject({ state: "measured", value: "retention" });
      expect(initial.aggregates.completeness).toMatchObject({ state: "measured", value: { lastFinishedPeriod: null, backlogPeriods: 1 } });

      const npmExecPath = process.env["npm_execpath"];
      if (!npmExecPath || !workerUrl) throw new Error("R12_BOOTSTRAP_CLI_CONTEXT_MISSING");
      const cli = spawnSync(process.execPath, [npmExecPath, "run", "operations:summary", "--", "--portfolio-id", bootstrapPortfolioId], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: workerUrl, OPERATIONS_SUMMARY_PORTFOLIO_ID: bootstrapPortfolioId },
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
      });
      expect(cli.error).toBeUndefined();
      expect(cli.status).toBe(0);
      const cliLines = cli.stdout.trim().split(/\r?\n/u);
      const cliSummary = JSON.parse(cliLines.at(-1) ?? "null") as typeof initial;
      expect(cliSummary.retention.lastCompletePolicyPeriod).toEqual({ state: "unknown", reason: "no-completed-policy-period" });
      expect(cliSummary.retention.backlogPeriods).toMatchObject({ state: "measured", value: 1 });
      expect(cliSummary.aggregates.completeness).toMatchObject({ state: "measured", value: { lastFinishedPeriod: null, backlogPeriods: 1 } });

      const retentionTypes = ["measurement.detail-retention.v1", "measurement.aggregate-retention.v1",
        "measurement.withdrawal-cleanup.v1", "interaction.feedback-retention.v1"];
      let nextJobId = 7_100;
      const enqueue = async (jobType: string, semanticPeriod: string, value: Readonly<Record<string, string>> = {}) => {
        const inserted = await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, {
          jobId: uuid(nextJobId++), payload: { type: jobType, version: 1, value },
          availableAt: `${firstPolicyPeriod}T00:00:00.000Z`,
          semanticSchedule: { portfolioId: bootstrapPortfolioId, period: semanticPeriod },
        }));
        expect(inserted).toBe(true);
      };
      for (const jobType of retentionTypes) await enqueue(jobType, firstPolicyPeriod);
      expect(await operations.jobs.advancePhase7RetentionSchedule({ portfolioId: bootstrapPortfolioId,
        expectedNextPeriod: firstPolicyPeriod, scheduledThroughPeriod: firstPolicyPeriod })).toBe(true);
      const retentionLeases = await operations.jobs.claimDue({ workerId: "r12-bootstrap-retention", now: observedAt,
        leaseDurationSeconds: 300, limit: retentionTypes.length, jobTypes: retentionTypes, semanticScopeId: bootstrapPortfolioId });
      expect(retentionLeases).toHaveLength(retentionTypes.length);
      for (const lease of retentionLeases) {
        expect(await operations.jobs.complete(lease.jobId, lease.leaseToken, observedAt, false)).toBe(true);
      }
      const retentionCompleted = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: bootstrapPortfolioId,
        fromPeriod: firstPolicyPeriod, throughPeriod: firstPolicyPeriod });
      expect(retentionCompleted).toMatchObject({ retentionCompleteThrough: firstPolicyPeriod,
        lastCompletePolicyPeriod: null, phase: "aggregate" });

      const mixed = await readSummary(7_502);
      expect(mixed.retention.lastCompletePolicyPeriod).toEqual({ state: "unknown", reason: "no-completed-policy-period" });
      expect(mixed.retention.backlogPeriods).toMatchObject({ state: "measured", value: 0 });
      expect(mixed.retention.phase).toMatchObject({ state: "measured", value: "aggregate" });
      expect(mixed.aggregates.completeness).toMatchObject({ state: "measured", value: { lastFinishedPeriod: null, backlogPeriods: 1 } });
      const mixedCursors = await admin.query(`select to_char(retention_complete_through,'YYYY-MM-DD') as retention_complete,
          to_char(aggregate_finished_through,'YYYY-MM-DD') as aggregate_finished,
          to_char(last_complete_period,'YYYY-MM-DD') as last_complete, phase
        from operations.phase7_schedule_progress where portfolio_id=$1::uuid`, [bootstrapPortfolioId]);
      expect(mixedCursors.rows).toEqual([{ retention_complete: firstPolicyPeriod, aggregate_finished: priorPeriod,
        last_complete: priorPeriod, phase: "aggregate" }]);

      for (let offset = -14; offset <= 0; offset += 1) {
        const utcDay = new Date(Date.parse(`${firstPolicyPeriod}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10);
        await enqueue("measurement.daily-aggregate.v1", `${firstPolicyPeriod}:${utcDay}`, { utcDay });
      }
      expect(await operations.jobs.advancePhase7AggregateSchedule({ portfolioId: bootstrapPortfolioId,
        expectedNextPeriod: firstPolicyPeriod, scheduledThroughPeriod: firstPolicyPeriod })).toBe(true);
      const aggregateLeases = await operations.jobs.claimDue({ workerId: "r12-bootstrap-aggregate", now: observedAt,
        leaseDurationSeconds: 300, limit: 15, jobTypes: ["measurement.daily-aggregate.v1"], semanticScopeId: bootstrapPortfolioId });
      expect(aggregateLeases).toHaveLength(15);
      for (const lease of aggregateLeases) {
        expect(await operations.jobs.complete(lease.jobId, lease.leaseToken, observedAt, false)).toBe(true);
      }
      const firstPeriodCompleted = await operations.jobs.getPhase7ScheduleStatus({ portfolioId: bootstrapPortfolioId,
        fromPeriod: firstPolicyPeriod, throughPeriod: firstPolicyPeriod });
      expect(firstPeriodCompleted).toMatchObject({ retentionCompleteThrough: firstPolicyPeriod,
        lastCompletePolicyPeriod: firstPolicyPeriod });
      const completed = await readSummary(7_503);
      expect(completed.retention.lastCompletePolicyPeriod).toMatchObject({ state: "measured", value: firstPolicyPeriod });
      expect(completed.retention.backlogPeriods).toMatchObject({ state: "measured", value: 0 });
      expect(completed.aggregates.completeness).toMatchObject({ state: "measured",
        value: { lastFinishedPeriod: firstPolicyPeriod, backlogPeriods: 0 } });
    } finally {
      await admin.query("delete from operations.jobs where semantic_scope_id=$1::uuid", [bootstrapPortfolioId]);
      await admin.query("delete from operations.phase7_schedule_progress where portfolio_id=$1::uuid", [bootstrapPortfolioId]);
    }
  }, 60_000);

  it("separates active and expired PostgreSQL job lease counts at the observed time", async () => {
    const activeJob = uuid(1_611);
    const expiredJob = uuid(1_612);
    const service = createOperationsSummaryService({ reader: createPostgresOperationsSummaryReader(worker.database), clock: { now: () => observedAt } });
    const read = (jobId: string) => service.readOperationsSummary({ actor: { kind: "system", jobId: jobId as StableId<"Job">,
      purpose: OPERATIONS_SUMMARY_PURPOSE }, portfolioId });
    try {
      const before = await read(uuid(503));
      await admin.query(`insert into operations.jobs
        (job_id,job_type,payload_version,payload,available_at,status,attempt_count,lease_owner,lease_token,lease_expires_at,lease_acquired_at)
        values ($1::uuid,'fixture.active-count.v1',1,'{}'::jsonb,'2026-10-27T11:00:00Z','leased',1,'fixture','active-count',
          '2026-10-27T13:00:00Z','2026-10-27T11:45:00Z'),
          ($2::uuid,'fixture.expired-count.v1',1,'{}'::jsonb,'2026-10-27T11:00:00Z','leased',1,'fixture','expired-count',
          '2026-10-27T11:59:00Z',null)`, [activeJob, expiredJob]);
      const after = await read(uuid(504));
      expect(before.ok).toBe(true);
      expect(after.ok).toBe(true);
      if (!before.ok || !after.ok) return;
      expect(after.value.jobs.leasedDepth.value - before.value.jobs.leasedDepth.value).toBe(2);
      expect(after.value.jobs.activeLeaseDepth.value - before.value.jobs.activeLeaseDepth.value).toBe(1);
      expect(after.value.jobs.expiredLeaseDepth.value - before.value.jobs.expiredLeaseDepth.value).toBe(1);
      expect(after.value.leases.activeJobs).toEqual(after.value.jobs.activeLeaseDepth);
      expect(after.value.leases.expiredJobs).toEqual(after.value.jobs.expiredLeaseDepth);
    } finally {
      await admin.query("delete from operations.jobs where job_id=any($1::uuid[])", [[activeJob, expiredJob]]);
    }
  }, 20_000);

  it("reports 24-hour export measurement windows separately from 15-minute integrity failures", async () => {
    const exportId = uuid(318);
    const artifactId = uuid(818);
    const observedAt = new Date().toISOString();
    const completedAt = new Date(Date.parse(observedAt) - 30 * 60_000).toISOString();
    const startedAt = new Date(Date.parse(completedAt) - 15 * 24 * 60 * 60_000).toISOString();
    const requestedAt = new Date(Date.parse(startedAt) - 60_000).toISOString();
    const expectedDurationMs = Date.parse(completedAt) - Date.parse(startedAt);
    const integrityQueries: OwnerExportIntegrityLogWindowQuery[] = [];
    const service = createOperationsSummaryService({
      reader: createPostgresOperationsSummaryReader(worker.database),
      integrityLogReader: {
        async readOwnerExportIntegrityWindow(query) {
          integrityQueries.push(query);
          return { sourceInstalled: true, sourceComplete: true, serializedRecords: [] };
        },
      },
      clock: { now: () => observedAt },
    });
    const readSummary = () => service.readOperationsSummary({ actor: { kind: "system", jobId: uuid(508) as StableId<"Job">,
      purpose: OPERATIONS_SUMMARY_PURPOSE }, portfolioId });
    const readCli = (): OperationsSummary => {
      const npmExecPath = process.env["npm_execpath"];
      if (!npmExecPath || !workerUrl) throw new Error("R13_EXPORT_CLI_CONTEXT_MISSING");
      const cli = spawnSync(process.execPath, [npmExecPath, "run", "operations:summary", "--", "--portfolio-id", portfolioId], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: workerUrl, OPERATIONS_SUMMARY_PORTFOLIO_ID: portfolioId },
        encoding: "utf8",
        timeout: 120_000,
        windowsHide: true,
      });
      expect(cli.error).toBeUndefined();
      expect(cli.status).toBe(0);
      const lines = cli.stdout.trim().split(/\r?\n/u);
      return JSON.parse(lines.at(-1) ?? "null") as OperationsSummary;
    };

    const before = await readSummary();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const beforeBytes = before.value.exports.artifactBytes;
    expect(beforeBytes.state).toBe("measured");
    if (beforeBytes.state !== "measured") return;
    const beforeBuildSamples = before.value.exports.buildDurationMs.state === "measured"
      ? before.value.exports.buildDurationMs.value.sampleCount : 0;
    const cliBefore = readCli();
    const cliBeforeBytes = cliBefore.exports.artifactBytes;
    expect(cliBeforeBytes.state).toBe("measured");
    if (cliBeforeBytes.state !== "measured") return;
    const cliBeforeBuildSamples = cliBefore.exports.buildDurationMs.state === "measured"
      ? cliBefore.exports.buildDurationMs.value.sampleCount : 0;

    try {
      await admin.query(`insert into portability.owner_exports
        (export_id,portfolio_id,owner_id,included_scopes,status,schema_version,requested_at,started_at,completed_at,
         manifest,artifact_id,artifact_sha256,artifact_content_length)
        values ($1::uuid,$2::uuid,$3::uuid,array['portfolio-configuration']::text[],'ready','1.2',
          $4::timestamptz,$5::timestamptz,$6::timestamptz,'{}'::jsonb,$7::uuid,$8,$9)`,
      [exportId, portfolioId, ownerId, requestedAt, startedAt, completedAt, artifactId, "d".repeat(64), 12_345]);
      await admin.query("analyze portability.owner_exports");

      expect(Date.parse(observedAt) - Date.parse(completedAt)).toBeGreaterThan(15 * 60_000);
      expect(Date.parse(observedAt) - Date.parse(completedAt)).toBeLessThan(24 * 60 * 60_000);
      const after = await readSummary();
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.value.exports.artifactBytes).toMatchObject({ state: "measured", value: beforeBytes.value + 12_345,
        windowSeconds: 86_400, source: "operations-database" });
      expect(after.value.exports.buildDurationMs).toMatchObject({ state: "measured",
        value: { maximum: expectedDurationMs, sampleCount: beforeBuildSamples + 1 },
        windowSeconds: 86_400, source: "operations-database" });
      expect(after.value.exports.integrityFailures).toMatchObject({ state: "measured",
        value: { value: 0, capped: false, sampleLimit: 1_000 }, windowSeconds: 900, source: "restricted-worker-log" });
      expect(integrityQueries.at(-1)).toMatchObject({ metricId: "export.integrity_failures", observedAt,
        windowSeconds: 900, maxCandidates: 1_000, scope: "system-wide" });

      const cliAfter = readCli();
      expect(cliAfter.exports.artifactBytes).toMatchObject({ state: "measured", value: cliBeforeBytes.value + 12_345,
        windowSeconds: 86_400, source: "operations-database" });
      expect(cliAfter.exports.buildDurationMs).toMatchObject({ state: "measured",
        value: { maximum: expectedDurationMs, sampleCount: cliBeforeBuildSamples + 1 },
        windowSeconds: 86_400, source: "operations-database" });
    } finally {
      await admin.query("delete from portability.owner_exports where export_id=$1::uuid", [exportId]);
      await admin.query("analyze portability.owner_exports");
    }
  }, 45_000);

  it("returns unknown bytes when any bounded ready export is missing its content length", async () => {
    const missingLengthExportId = uuid(317);
    try {
      await admin.query(`insert into portability.owner_exports
        (export_id,portfolio_id,owner_id,included_scopes,status,schema_version,requested_at,started_at,completed_at,
          manifest,artifact_id,artifact_sha256,artifact_content_length)
        values ($1::uuid,$2::uuid,$3::uuid,array['portfolio-configuration']::text[],'ready','1.2',
          '2026-10-27T11:30:00Z','2026-10-27T11:31:00Z','2026-10-27T11:32:00Z','{}'::jsonb,$4::uuid,null,null)`,
        [missingLengthExportId, portfolioId, ownerId, uuid(817)]);
      const service = createOperationsSummaryService({ reader: createPostgresOperationsSummaryReader(worker.database), clock: { now: () => observedAt } });
      const result = await service.readOperationsSummary({ actor: { kind: "system", jobId: uuid(504) as StableId<"Job">,
        purpose: OPERATIONS_SUMMARY_PURPOSE }, portfolioId });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.exports.states.ready.value).toBe(3);
        expect(result.value.exports.artifactBytes).toEqual({ state: "unknown", reason: "incomplete-sample" });
        expect(result.value.exports.sampleCount).toBeGreaterThan(0);
        expect(result.value.exports.capped).toBe(false);
      }
    } finally {
      await admin.query("delete from portability.owner_exports where export_id=$1::uuid", [missingLengthExportId]);
    }
  }, 20_000);

  it("sums all five bounded export-state samples and preserves per-state cap reporting", async () => {
    const service = createOperationsSummaryService({ reader: createPostgresOperationsSummaryReader(worker.database), clock: { now: () => observedAt } });
    const read = (jobId: number) => service.readOperationsSummary({ actor: { kind: "system", jobId: uuid(jobId) as StableId<"Job">,
      purpose: OPERATIONS_SUMMARY_PURPOSE }, portfolioId });
    const before = await read(505);
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const baseline = before.value.exports.states;
    const baselineCount = Object.values(baseline).reduce((sum, state) => sum + state.value, 0);
    expect(Object.values(baseline).every((state) => state.value < 750)).toBe(true);
    expect(before.value.exports.sampleCount).toBe(baselineCount);

    try {
      await admin.query(`insert into portability.owner_exports
        (export_id,portfolio_id,owner_id,included_scopes,status,schema_version,requested_at)
        select ('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 250000),12,'0'))::uuid,$1::uuid,$2::uuid,
          array['portfolio-configuration']::text[],'requested','1.2','2026-10-27T11:00:00Z'::timestamptz
        from generate_series(1,250) i`, [portfolioId, ownerId]);
      await admin.query(`insert into portability.owner_exports
        (export_id,portfolio_id,owner_id,included_scopes,status,schema_version,requested_at,started_at)
        select ('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 251000),12,'0'))::uuid,$1::uuid,$2::uuid,
          array['portfolio-configuration']::text[],'building','1.2','2026-10-27T10:58:00Z'::timestamptz,
          '2026-10-27T10:59:00Z'::timestamptz from generate_series(1,250) i`, [portfolioId, ownerId]);
      await admin.query(`insert into portability.owner_exports
        (export_id,portfolio_id,owner_id,included_scopes,status,schema_version,requested_at,started_at,completed_at,
         manifest,artifact_id,artifact_sha256,artifact_content_length)
        select ('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 252000),12,'0'))::uuid,$1::uuid,$2::uuid,
          array['portfolio-configuration']::text[],'ready','1.2','2026-10-27T10:58:00Z'::timestamptz,
          '2026-10-27T10:59:00Z'::timestamptz,'2026-10-27T11:00:00Z'::timestamptz,'{}'::jsonb,
          ('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 253000),12,'0'))::uuid,repeat('b',64),1
        from generate_series(1,250) i`, [portfolioId, ownerId]);
      await admin.query(`insert into portability.owner_exports
        (export_id,portfolio_id,owner_id,included_scopes,status,schema_version,requested_at,failed_at,failure_code)
        select ('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 254000),12,'0'))::uuid,$1::uuid,$2::uuid,
          array['portfolio-configuration']::text[],'failed','1.2','2026-10-27T10:58:00Z'::timestamptz,
          '2026-10-27T11:00:00Z'::timestamptz,'FIXTURE_FAILED' from generate_series(1,250) i`, [portfolioId, ownerId]);
      await admin.query(`insert into portability.owner_exports
        (export_id,portfolio_id,owner_id,included_scopes,status,schema_version,requested_at,started_at,completed_at,expired_at,
         manifest,artifact_id,artifact_sha256,artifact_content_length)
        select ('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 255000),12,'0'))::uuid,$1::uuid,$2::uuid,
          array['portfolio-configuration']::text[],'expired','1.2','2026-10-27T10:58:00Z'::timestamptz,
          '2026-10-27T10:59:00Z'::timestamptz,'2026-10-27T11:00:00Z'::timestamptz,'2026-10-27T11:01:00Z'::timestamptz,
          '{}'::jsonb,('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 256000),12,'0'))::uuid,repeat('c',64),1
        from generate_series(1,250) i`, [portfolioId, ownerId]);

      const mixed = await read(506);
      expect(mixed.ok).toBe(true);
      if (!mixed.ok) return;
      expect(mixed.value.exports.states).toMatchObject({
        requested: { value: baseline.requested.value + 250, capped: false },
        building: { value: baseline.building.value + 250, capped: false },
        ready: { value: baseline.ready.value + 250, capped: false },
        failed: { value: baseline.failed.value + 250, capped: false },
        expired: { value: baseline.expired.value + 250, capped: false },
      });
      const mixedSampleCount = baselineCount + 1_250;
      expect(mixed.value.exports.sampleCount).toBe(mixedSampleCount);
      expect(mixed.value.exports.sampleCount).toBeGreaterThan(1_000);
      expect(mixed.value.exports.capped).toBe(false);

      const requestedToCap = 1_000 - mixed.value.exports.states.requested.value;
      expect(requestedToCap).toBeGreaterThan(0);
      await admin.query(`insert into portability.owner_exports
        (export_id,portfolio_id,owner_id,included_scopes,status,schema_version,requested_at)
        select ('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 257000),12,'0'))::uuid,$1::uuid,$2::uuid,
          array['portfolio-configuration']::text[],'requested','1.2','2026-10-27T11:00:00Z'::timestamptz
        from generate_series(1,$3::int) i`, [portfolioId, ownerId, requestedToCap]);
      const capped = await read(507);
      expect(capped.ok).toBe(true);
      if (!capped.ok) return;
      expect(capped.value.exports.states.requested).toMatchObject({ value: 1_000, capped: true, sampleLimit: 1_000 });
      expect(capped.value.exports.sampleCount).toBe(mixedSampleCount + requestedToCap);
      expect(capped.value.exports.capped).toBe(true);
    } finally {
      await admin.query(`delete from portability.owner_exports where
        (export_id between $1::uuid and $2::uuid) or (export_id between $3::uuid and $4::uuid) or
        (export_id between $5::uuid and $6::uuid) or (export_id between $7::uuid and $8::uuid) or
        (export_id between $9::uuid and $10::uuid) or (export_id between $11::uuid and $12::uuid)`,
      [uuid(250001), uuid(250250), uuid(251001), uuid(251250), uuid(252001), uuid(252250), uuid(254001), uuid(254250),
        uuid(255001), uuid(255250), uuid(257001), uuid(258000)]);
      await admin.query("analyze portability.owner_exports");
    }
  }, 45_000);

  it("returns a usable nonnegative lease age when application time predates PostgreSQL acquisition", async () => {
    const eventId = uuid(1_500);
    const applicationObservedAt = new Date(Date.now() - 60_000).toISOString();
    try {
      await admin.query(`insert into operations.outbox_events
        (event_id,event_type,schema_version,aggregate_id,aggregate_version,payload,correlation_id,occurred_at,available_at,
         lease_owner,lease_token,lease_expires_at,lease_acquired_at)
        values ($1::uuid,'fixture.clock-skew.v1',1,$2::uuid,1,'{}'::jsonb,'clock-skew-fixture',clock_timestamp(),clock_timestamp(),
          'clock-skew-worker','clock-skew-token',clock_timestamp()+interval '1 hour',clock_timestamp())`, [eventId, uuid(1_501)]);
      const service = createOperationsSummaryService({ reader: createPostgresOperationsSummaryReader(worker.database),
        clock: { now: () => applicationObservedAt } });
      const result = await service.readOperationsSummary({ actor: { kind: "system", jobId: uuid(1_502) as StableId<"Job">,
        purpose: OPERATIONS_SUMMARY_PURPOSE }, portfolioId });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const age = result.value.leases.ageSeconds;
      expect(age.state).toBe("measured");
      if (age.state !== "measured") throw new Error("OPERATIONS_SUMMARY_LEASE_AGE_UNKNOWN");
      expect(age.value).toEqual(expect.any(Number));
      expect(age.value!).toBeGreaterThanOrEqual(0);
    } finally {
      await admin.query("delete from operations.outbox_events where event_id=$1::uuid", [eventId]);
    }
  }, 20_000);

  it("excludes expired leases and their missing acquisition timestamps from active lease age", async () => {
    const outboxExpired = [uuid(1_601), uuid(1_602)];
    const jobExpired = [uuid(1_603), uuid(1_604)];
    const activeOutbox = uuid(1_605);
    const olderActiveJob = uuid(1_606);
    try {
      await admin.query(`insert into operations.outbox_events
        (event_id,event_type,schema_version,aggregate_id,aggregate_version,payload,correlation_id,occurred_at,available_at,
         lease_owner,lease_token,lease_expires_at,lease_acquired_at)
        values ($1::uuid,'fixture.expired-age.v1',1,$3::uuid,1,'{}'::jsonb,'expired-age-fixture',clock_timestamp(),clock_timestamp(),
          'expired-worker','expired-old', '2026-10-27T11:59:00Z', '2026-10-01T00:00:00Z'),
          ($2::uuid,'fixture.expired-age.v1',1,$3::uuid,1,'{}'::jsonb,'expired-age-fixture',clock_timestamp(),clock_timestamp(),
          'expired-worker','expired-missing','2026-10-27T11:59:00Z',null),
          ($4::uuid,'fixture.active-age.v1',1,$3::uuid,1,'{}'::jsonb,'active-age-fixture',clock_timestamp(),clock_timestamp(),
          'active-worker','active-new','2026-10-27T13:00:00Z','2026-10-27T11:30:00Z')`, [...outboxExpired, uuid(1_607), activeOutbox]);
      await admin.query(`insert into operations.jobs
        (job_id,job_type,payload_version,payload,available_at,status,attempt_count,lease_owner,lease_token,lease_expires_at,lease_acquired_at)
        values ($1::uuid,'fixture.expired-age.v1',1,'{}'::jsonb,clock_timestamp(),'leased',1,'expired-worker','expired-old',
          '2026-10-27T11:59:00Z','2026-10-01T00:00:00Z'),
          ($2::uuid,'fixture.expired-age.v1',1,'{}'::jsonb,clock_timestamp(),'leased',1,'expired-worker','expired-missing',
          '2026-10-27T11:59:00Z',null),
          ($3::uuid,'fixture.active-age.v1',1,'{}'::jsonb,clock_timestamp(),'leased',1,'active-worker','active-old',
          '2026-10-27T13:00:00Z','2026-10-27T09:00:00Z')`, [...jobExpired, olderActiveJob]);
      const result = await createOperationsSummaryService({ reader: createPostgresOperationsSummaryReader(worker.database),
        clock: { now: () => observedAt } }).readOperationsSummary({ actor: { kind: "system", jobId: uuid(1_608) as StableId<"Job">,
        purpose: OPERATIONS_SUMMARY_PURPOSE }, portfolioId });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.leases.ageSeconds).toMatchObject({ state: "measured", value: 10_800 });
      expect(result.value.leases.expiredOutbox.value).toBe(3);
      expect(result.value.leases.expiredJobs.value).toBe(2);
    } finally {
      await admin.query("delete from operations.outbox_events where event_id=any($1::uuid[])", [[...outboxExpired, activeOutbox]]);
      await admin.query("delete from operations.jobs where job_id=any($1::uuid[])", [[...jobExpired, olderActiveJob]]);
    }
  }, 20_000);

  it("enforces purpose and role denial and uses bounded indexes over completed history", async () => {
    const reader = createPostgresOperationsSummaryReader(worker.database);
    const query: OperationsSummaryQuery = { portfolioId, observedAt, windowSeconds: 900, maxRows: 1_000 };
    const wrongPurpose = createOperationsSummaryService({ reader, clock: { now: () => observedAt } });
    expect(await wrongPurpose.readOperationsSummary({ actor: { kind: "system", jobId: uuid(501) as StableId<"Job">,
      purpose: "operations.jobs.read" }, portfolioId })).toMatchObject({ ok: false, error: { code: "OPERATIONS_SUMMARY_ACCESS_DENIED" } });

    for (const role of ["anon", "authenticated", "shipwithali_application"] as const) {
      await admin.query(`set role ${role}`);
      let denied = false;
      try { await admin.query("select count(*) from operations.outbox_events"); } catch { denied = true; }
      await admin.query("reset role");
      expect(denied, `${role} must not read worker queue state`).toBe(true);
    }

    const plan = await explainOperationsSummaryQuery(worker.database, query);
    const planText = JSON.stringify(plan);
    const facts = planFacts(plan);
    expect(facts.indexes, JSON.stringify(facts)).toContain("outbox_events_due_idx");
    expect(facts.indexes, JSON.stringify(facts)).toContain("jobs_operational_summary_lease_idx");
    expect(facts.indexes, JSON.stringify(facts)).toContain("owner_exports_operational_summary_recent_idx");
    expect(planText).not.toMatch(/payload|manifest|artifact_sha256|PRIVATE-OUTBOX-PAYLOAD/i);
  }, 20_000);

  it("EXPLAIN ANALYZE bounds oldest-eligible traversal over a large pending and future queue", async () => {
    const query: OperationsSummaryQuery = { portfolioId, observedAt, windowSeconds: 900, maxRows: 1_000 };
    const first = 40_000;
    try {
      await admin.query(`insert into operations.outbox_events
        (event_id,event_type,schema_version,aggregate_id,aggregate_version,payload,correlation_id,occurred_at,available_at,attempt_count)
        select ('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + $1),12,'0'))::uuid,
          'fixture.pending.v1',1,'0196a1b2-7c3d-7e11-9f22-000000000900'::uuid,1,'{}'::jsonb,'plan-fixture',
          '2026-10-10T00:00:00Z'::timestamptz + i * interval '1 second',
          case when i % 5 = 0 then '2026-10-28T00:00:00Z'::timestamptz else '2026-10-27T11:00:00Z'::timestamptz end,
          case when i % 7 = 0 then 1 else 0 end
        from generate_series(1,25000) i`, [first]);
      await admin.query("analyze operations.outbox_events");
      const plan = await explainOperationsSummaryQuery(worker.database, query);
      const facts = planFacts(plan);
      const output = process.env["OPERATIONS_SUMMARY_PLAN_PATH"];
      const eligibleIndexRows = facts.indexReadFacts.filter((item) => item.indexName === "outbox_events_operational_summary_eligible_idx")
        .map((item) => item.actualRows);
      const delayedIndexReads = facts.indexReadFacts.filter((item) => item.indexName === "outbox_events_due_idx");
      if (output) writeFileSync(output, JSON.stringify({ indexNames: [...new Set(facts.indexes)].sort(),
        maximumIndexActualRows: Math.max(0, ...facts.indexRows), eligibleIndexMaximumActualRows: Math.max(0, ...eligibleIndexRows),
        delayedIndexMaximumActualRows: Math.max(0, ...delayedIndexReads.map((item) => item.actualRows)),
        delayedIndexUsesAvailableAtCondition: delayedIndexReads.length > 0 && delayedIndexReads.every((item) => item.availableAtIndexCondition),
        indexActualRows: facts.indexRows.sort((a, b) => a - b),
        indexReadFacts: facts.indexReadFacts.sort((a, b) => b.actualRows - a.actualRows),
        sortActualRows: facts.sorts.sort((a, b) => a - b) }));
      expect(facts.indexes).toContain("outbox_events_operational_summary_eligible_idx");
      expect(eligibleIndexRows).toContain(1_001);
      expect(Math.max(0, ...eligibleIndexRows)).toBeLessThanOrEqual(1_001);
      expect(delayedIndexReads.length).toBeGreaterThan(0);
      expect(Math.max(0, ...delayedIndexReads.map((item) => item.actualRows))).toBeLessThanOrEqual(1_001);
      expect(delayedIndexReads.every((item) => item.availableAtIndexCondition)).toBe(true);
      expect(facts.sequentialScans).not.toContain("outbox_events");
      expect(facts.sorts.every((rows) => rows <= 1_001)).toBe(true);
      expect(JSON.stringify(plan)).not.toMatch(/plan-fixture|payload|PRIVATE-OUTBOX/i);
    } finally {
      await admin.query("delete from operations.outbox_events where correlation_id='plan-fixture'");
      await admin.query("analyze operations.outbox_events");
    }
  }, 30_000);

  it("EXPLAIN ANALYZE bounds current export states and recent transition windows across old requests", async () => {
    const query: OperationsSummaryQuery = { portfolioId, observedAt, windowSeconds: 900, maxRows: 1_000 };
    try {
      await admin.query(`insert into portability.owner_exports
        (export_id,portfolio_id,owner_id,included_scopes,status,schema_version,requested_at)
        select ('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 170000),12,'0'))::uuid,$1::uuid,$2::uuid,
          array['portfolio-configuration']::text[],'requested','1.2','2026-10-01T00:00:00Z'::timestamptz
        from generate_series(1,3000) i`, [portfolioId, ownerId]);
      await admin.query(`insert into portability.owner_exports
        (export_id,portfolio_id,owner_id,included_scopes,status,schema_version,requested_at,started_at)
        select ('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 175000),12,'0'))::uuid,$1::uuid,$2::uuid,
          array['portfolio-configuration']::text[],'building','1.2','2026-10-01T00:00:00Z'::timestamptz,
          '2026-10-01T00:01:00Z'::timestamptz
        from generate_series(1,3000) i`, [portfolioId, ownerId]);
      await admin.query(`insert into portability.owner_exports
        (export_id,portfolio_id,owner_id,included_scopes,status,schema_version,requested_at,started_at,completed_at,
         manifest,artifact_id,artifact_sha256,artifact_content_length)
        select ('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 180000),12,'0'))::uuid,$1::uuid,$2::uuid,
          array['portfolio-configuration']::text[],'ready','1.2','2026-10-01T00:00:00Z'::timestamptz,
          '2026-10-01T00:01:00Z'::timestamptz,'2026-10-02T00:00:00Z'::timestamptz,'{}'::jsonb,
          ('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 230000),12,'0'))::uuid,repeat('b',64),1
        from generate_series(1,3000) i`, [portfolioId, ownerId]);
      await admin.query(`insert into portability.owner_exports
        (export_id,portfolio_id,owner_id,included_scopes,status,schema_version,requested_at,failed_at,failure_code)
        select ('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 190000),12,'0'))::uuid,$1::uuid,$2::uuid,
          array['portfolio-configuration']::text[],'failed','1.2','2026-10-01T00:00:00Z'::timestamptz,
          '2026-10-02T00:00:00Z'::timestamptz,'FIXTURE_FAILED'
        from generate_series(1,3000) i`, [portfolioId, ownerId]);
      await admin.query(`insert into portability.owner_exports
        (export_id,portfolio_id,owner_id,included_scopes,status,schema_version,requested_at,started_at,completed_at,expired_at,
         manifest,artifact_id,artifact_sha256,artifact_content_length)
        select ('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 200000),12,'0'))::uuid,$1::uuid,$2::uuid,
          array['portfolio-configuration']::text[],'expired','1.2','2026-10-01T00:00:00Z'::timestamptz,
          '2026-10-01T00:01:00Z'::timestamptz,'2026-10-01T00:02:00Z'::timestamptz,'2026-10-02T00:00:00Z'::timestamptz,
          '{}'::jsonb,('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 240000),12,'0'))::uuid,repeat('c',64),1
        from generate_series(1,3000) i`, [portfolioId, ownerId]);
      await admin.query("analyze portability.owner_exports");
      const plan = await explainOperationsSummaryQuery(worker.database, query);
      const facts = planFacts(plan);
      const stateReads = facts.indexReadFacts.filter((item) => item.indexName === "owner_exports_operational_summary_recent_idx");
      const transitionReads = facts.indexReadFacts.filter((item) => ["owner_exports_operational_summary_ready_idx",
        "owner_exports_operational_summary_failed_idx", "owner_exports_operational_summary_expired_idx"].includes(item.indexName) &&
        item.exportTransitionIndexCondition);
      const stateRowsRead = stateReads.map((item) => item.actualRows * (item.actualLoops ?? 1));
      const transitionRowsRead = transitionReads.map((item) => item.actualRows * (item.actualLoops ?? 1));
      const diagnosticPath = process.env["OPERATIONS_SUMMARY_PLAN_PATH"];
      if (diagnosticPath) {
        const prior = existsSync(diagnosticPath) ? JSON.parse(readFileSync(diagnosticPath, "utf8")) as Record<string, unknown> : {};
        writeFileSync(diagnosticPath, JSON.stringify({ ...prior, exportWindowsDiagnostic: {
          stateReads, transitionReads,
        } }));
      }
      expect(stateReads.length).toBeGreaterThan(0);
      expect(stateReads.every((item) => item.nodeType === "Index Only Scan" || item.nodeType === "Index Scan")).toBe(true);
      expect(Math.max(...stateRowsRead)).toBeLessThanOrEqual(1_000);
      expect([...new Set(transitionReads.map((item) => item.indexName))].sort()).toEqual([
        "owner_exports_operational_summary_expired_idx", "owner_exports_operational_summary_failed_idx",
        "owner_exports_operational_summary_ready_idx",
      ]);
      expect(transitionReads.every((item) => item.actualRows * (item.actualLoops ?? 1) <= 1_000 &&
        (item.rowsRemovedByFilter ?? 0) * (item.actualLoops ?? 1) <= 1_000)).toBe(true);
      const summary = await buildOperationsSummaryQuery(query).execute(worker.database);
      expect(summary.rows[0]).toMatchObject({ export_requested_count: "1000", export_ready_count: "2",
        export_failed_count: "2", export_expired_count: "2", export_capped: true });
      const output = process.env["OPERATIONS_SUMMARY_PLAN_PATH"];
      if (output) {
        const prior = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) as Record<string, unknown> : {};
        writeFileSync(output, JSON.stringify({ ...prior, exportWindows: { currentStateMaximumRows: Math.max(...stateRowsRead),
          transitionMaximumRows: Math.max(0, ...transitionRowsRead), stateReads, transitionReads,
          indexes: [...new Set(transitionReads.map((item) => item.indexName))].sort() } }));
      }
    } finally {
      await admin.query(`delete from portability.owner_exports where export_id between $1::uuid and $2::uuid
        or export_id between $3::uuid and $4::uuid or export_id between $5::uuid and $6::uuid or export_id between $7::uuid and $8::uuid
        or export_id between $9::uuid and $10::uuid`,
      [uuid(170_001), uuid(173_000), uuid(175_001), uuid(178_000), uuid(180_001), uuid(183_000), uuid(190_001), uuid(193_000),
        uuid(200_001), uuid(203_000)]);
      await admin.query("analyze portability.owner_exports");
    }
  }, 45_000);

  it("EXPLAIN ANALYZE bounds active lease-age reads after a large expired-lease prefix", async () => {
    const query: OperationsSummaryQuery = { portfolioId, observedAt, windowSeconds: 900, maxRows: 1_000 };
    try {
      await admin.query(`insert into operations.outbox_events
        (event_id,event_type,schema_version,aggregate_id,aggregate_version,payload,correlation_id,occurred_at,available_at,
         lease_owner,lease_token,lease_expires_at,lease_acquired_at)
        select ('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 150000),12,'0'))::uuid,
          'fixture.expired-age-plan.v1',1,'0196a1b2-7c3d-7e11-9f22-000000000900'::uuid,1,'{}'::jsonb,'expired-age-plan',
          '2026-10-01T00:00:00Z'::timestamptz,'2026-10-01T00:00:00Z'::timestamptz,'expired-plan-worker',
          'expired-plan-token','2026-10-27T11:00:00Z'::timestamptz,'2026-10-01T00:00:00Z'::timestamptz
        from generate_series(1,5000) i`);
      await admin.query(`insert into operations.jobs
        (job_id,job_type,payload_version,payload,available_at,status,attempt_count,lease_owner,lease_token,lease_expires_at,lease_acquired_at)
        select ('0196a1b2-7c3d-7e11-9f22-' || lpad(to_hex(i + 160000),12,'0'))::uuid,
          'fixture.expired-age-plan.v1',1,'{}'::jsonb,'2026-10-01T00:00:00Z'::timestamptz,'leased',1,'expired-plan-worker',
          'expired-plan-token','2026-10-27T11:00:00Z'::timestamptz,'2026-10-01T00:00:00Z'::timestamptz
        from generate_series(1,5000) i`);
      await admin.query("analyze operations.outbox_events; analyze operations.jobs");
      const plan = await explainOperationsSummaryQuery(worker.database, query);
      const facts = planFacts(plan);
      const activeRangeReads = facts.indexReadFacts.filter((item) =>
        ["outbox_events_operational_summary_lease_idx", "jobs_operational_summary_lease_idx"].includes(item.indexName) &&
        item.leaseExpiryRangeCondition);
      expect(activeRangeReads.map((item) => item.indexName)).toContain("outbox_events_operational_summary_lease_idx");
      expect(activeRangeReads.map((item) => item.indexName)).toContain("jobs_operational_summary_lease_idx");
      expect(activeRangeReads.length).toBeGreaterThanOrEqual(2);
      expect(activeRangeReads.every((item) => item.actualRows <= 1_001 && (item.rowsRemovedByFilter ?? 0) === 0)).toBe(true);
      expect(facts.sequentialScans).not.toContain("outbox_events");
      expect(facts.sequentialScans).not.toContain("jobs");
      expect(JSON.stringify(plan)).not.toMatch(/expired-age-plan|payload|lease.token|PRIVATE/i);
      const output = process.env["OPERATIONS_SUMMARY_PLAN_PATH"];
      if (output) {
        const prior = existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) as Record<string, unknown> : {};
        writeFileSync(output, JSON.stringify({ ...prior, activeLeaseAge: { maximumIndexRows:
          Math.max(0, ...activeRangeReads.map((item) => item.actualRows)), reads: activeRangeReads } }));
      }
    } finally {
      await admin.query("delete from operations.outbox_events where event_type='fixture.expired-age-plan.v1'");
      await admin.query("delete from operations.jobs where job_type='fixture.expired-age-plan.v1'");
      await admin.query("analyze operations.outbox_events; analyze operations.jobs");
    }
  }, 30_000);

  it("emits database pool, transaction, authorization, lease-reclaim, and stale-write observations from real PostgreSQL boundaries", async () => {
    const appUrl = process.env["OPERATIONS_SUMMARY_APPLICATION_DATABASE_URL"];
    if (!appUrl) throw new Error("OPERATIONS_SUMMARY_APPLICATION_DATABASE_URL_MISSING");
    const runtime = createPostgresRuntimeDatabase(workerUrl!, { max: 1 });
    const application = createPostgresRuntimeDatabase(appUrl, { max: 1 });
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const observations: Array<Record<string, unknown>> = [];
    try {
      await sql`select 1`.execute(runtime.database);
      await expect(runtime.transactions.run(async (context) => {
        await sql`select 1 / 0`.execute(resolvePostgresTransaction(context));
      })).rejects.toBeDefined();
      await expect(application.transactions.run(async (context) => {
        await sql`select count(*) from operations.outbox_events`.execute(resolvePostgresTransaction(context));
      })).rejects.toBeDefined();

      const record = createPostgresOperationsPersistence(runtime.database, {
        observations: { async recordSignal(observation) { observations.push(observation as unknown as Record<string, unknown>); } },
      });
      const reclaimedId = uuid(610);
      await admin.query(`insert into operations.jobs
        (job_id,job_type,payload_version,payload,available_at,status,attempt_count,lease_owner,lease_token,lease_expires_at,lease_acquired_at)
        values ($1::uuid,'fixture.lease.lifecycle.v1',1,'{"type":"fixture.lease.lifecycle.v1","version":1,"value":{}}'::jsonb,
          clock_timestamp()-interval '1 hour','leased',1,'old-worker','old-token',clock_timestamp()-interval '1 second',
          clock_timestamp()-interval '2 hours')`, [reclaimedId]);
      const claimed = await record.jobs.claimDue({ workerId: "safe-fixture-worker", now: new Date().toISOString(), leaseDurationSeconds: 30, limit: 1,
        jobTypes: ["fixture.lease.lifecycle.v1"] });
      expect(claimed.map((job) => job.jobId)).toContain(reclaimedId);
      const stale = await record.jobs.complete(reclaimedId, "incorrect-lease-token", new Date().toISOString());
      expect(stale).toBe(false);
      expect(observations).toContainEqual({ kind: "lease-lifecycle", outcome: "reclaimed", count: 1, ageSeconds: expect.any(Number) });
      expect(observations).toContainEqual({ kind: "lease-lifecycle", outcome: "stale-write", count: 1 });

      const emitted = log.mock.calls.map(([value]) => typeof value === "string" ? value : JSON.stringify(value) ?? "");
      expect(emitted.some((line) => line.includes('"signal":"database-pool"') && line.includes('"configuredLimit":1'))).toBe(true);
      expect(emitted.some((line) => line.includes('"signal":"database-failure"') && line.includes('"category":"transaction"'))).toBe(true);
      expect(emitted.some((line) => line.includes('"signal":"database-failure"') && line.includes('"category":"authorization"'))).toBe(true);
      expect(JSON.stringify({ emitted, observations })).not.toMatch(/select 1 \/ 0|fixture\.lease\.lifecycle|incorrect-lease-token|old-token|PRIVATE/i);
    } finally {
      log.mockRestore();
      await application.resource.close();
      await runtime.resource.close();
      await admin.query("delete from operations.jobs where job_id=$1::uuid", [uuid(610)]);
    }
  }, 30_000);

  it("records one safe authorization failure when PostgreSQL outbox RLS is wrapped inside a transaction", async () => {
    const runtimeObservations: Array<Readonly<Record<string, string | number>>> = [];
    const runtime = createPostgresRuntimeDatabase(workerUrl!, { max: 1, runtimeObservationSink(observation) {
      runtimeObservations.push(observation);
    } });
    const persistence = createPostgresOperationsPersistence(runtime.database);
    const jobId = uuid(271_000);
    const eventId = uuid(271_001);
    const privateMarker = "PRIVATE_SQL_PROVIDER_RLS_MARKER";
    try {
      await admin.query("create policy operations_r5_test_deny_outbox on operations.outbox_events as restrictive to shipwithali_worker using (true) with check (false)");
      await expect(runtime.transactions.run(async (context) => {
        const executor = resolvePostgresTransaction(context);
        await sql`insert into operations.jobs(job_id,job_type,payload_version,payload,available_at)
          values (${jobId}::uuid,'fixture.r5-rollback.v1',1,'{"type":"fixture.r5-rollback.v1","version":1,"value":{}}'::jsonb,clock_timestamp())`
          .execute(executor);
        await persistence.outbox.append(context, {
          eventId,
          payload: { type: "fixture.r5-outbox-failure.v1", version: 1, value: {} },
          aggregateId: uuid(271_002), aggregateVersion: 1, correlationId: "safe-r5-correlation",
          occurredAt: new Date().toISOString(), availableAt: new Date().toISOString(),
        });
        throw new Error(privateMarker);
      })).rejects.toBeInstanceOf(PostgresInfrastructureError);

      const rollback = await admin.query("select count(*)::int as jobs from operations.jobs where job_id=$1::uuid", [jobId]);
      expect(rollback.rows[0]?.jobs).toBe(0);
      const failures = runtimeObservations.filter((observation) => observation["signal"] === "database-failure");
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ category: "authorization" });
      expect(failures.some((observation) => observation["category"] === "transaction")).toBe(false);
      expect(JSON.stringify(runtimeObservations)).not.toMatch(/PRIVATE_SQL_PROVIDER_RLS_MARKER|fixture\.r5-outbox-failure|safe-r5-correlation|27100[0-2]/i);
    } finally {
      await admin.query("drop policy if exists operations_r5_test_deny_outbox on operations.outbox_events");
      await admin.query("delete from operations.jobs where job_id=$1::uuid", [jobId]);
      await runtime.resource.close();
    }
  }, 30_000);

  it("records one safe authorization failure when Owner Export transition RLS is wrapped inside a transaction", async () => {
    const runtimeObservations: Array<Readonly<Record<string, string | number>>> = [];
    const runtime = createPostgresRuntimeDatabase(workerUrl!, { max: 1, runtimeObservationSink(observation) {
      runtimeObservations.push(observation);
    } });
    const operations = createPostgresOperationsPersistence(runtime.database);
    const exportId = uuid(272_000);
    const artifactId = uuid(272_001);
    const ownerExports = createPostgresOwnerExportStore(runtime.database, {
      outbox: operations.outbox,
      transactions: runtime.transactions,
    });
    try {
      const nestedAuthorization = Object.assign(new Error("safe wrapper"), {
        cause: new PostgresInfrastructureError("authorization"),
      });
      expect(postgresFailureCategory(nestedAuthorization)).toBe("authorization");

      await admin.query(`insert into portability.owner_exports
        (export_id,portfolio_id,owner_id,included_scopes,status,schema_version,requested_at,started_at,completed_at,
         manifest,artifact_id,artifact_sha256,artifact_content_length)
        values ($1::uuid,$2::uuid,$3::uuid,array['analytics-reports']::text[],'ready','1.2',
          clock_timestamp()-interval '1 hour',clock_timestamp()-interval '59 minutes',clock_timestamp()-interval '58 minutes',
          '{}'::jsonb,$4::uuid,repeat('a',64),1)`, [exportId, portfolioId, ownerId, artifactId]);
      await admin.query("create policy operations_r6_test_deny_owner_export_transition on portability.owner_exports as restrictive to shipwithali_worker using (true) with check (false)");

      let transitionError: unknown;
      try {
        await ownerExports.applyOwnerExportTransition({
          exportId: exportId as StableId<"OwnerExport">,
          fromStatus: "ready",
          toStatus: "expired",
          expectedAggregateVersion: 1,
          transitionedAt: new Date().toISOString(),
          actingJobId: uuid(272_002) as StableId<"Job">,
        });
      } catch (error) {
        transitionError = error;
      }
      expect(transitionError).toBeInstanceOf(PostgresInfrastructureError);
      expect(transitionError).toMatchObject({
        category: "authorization",
        message: "PostgreSQL operation failed.",
      });
      if (!(transitionError instanceof Error)) throw new Error("expected safe Owner Export authorization failure");
      expect([transitionError.name, transitionError.message, transitionError.stack].join("\n")).not.toMatch(
        /42501|SQLSTATE|update portability|owner_exports.*policy|PRIVATE|operations_r6_test_deny_owner_export_transition/i,
      );

      const durable = await admin.query(`select status,aggregate_version,expired_at
        from portability.owner_exports where export_id=$1::uuid`, [exportId]);
      expect(durable.rows).toEqual([{ status: "ready", aggregate_version: 1, expired_at: null }]);
      const failures = runtimeObservations.filter((observation) => observation["signal"] === "database-failure");
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ category: "authorization" });
      expect(failures.some((observation) => observation["category"] === "transaction")).toBe(false);
      expect(JSON.stringify(runtimeObservations)).not.toMatch(
        /42501|SQLSTATE|update portability|owner_exports.*policy|PRIVATE|operations_r6_test_deny_owner_export_transition/i,
      );
    } finally {
      await admin.query("drop policy if exists operations_r6_test_deny_owner_export_transition on portability.owner_exports");
      await admin.query("delete from portability.owner_exports where export_id=$1::uuid", [exportId]);
      await runtime.resource.close();
    }
  }, 30_000);

  it("records zero current pool occupancy after releasing a real PostgreSQL connection", async () => {
    const runtime = createPostgresRuntimeDatabase(workerUrl!, { max: 1 });
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      await sql`select 1`.execute(runtime.database);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const samples = log.mock.calls.flatMap(([value]) => {
        const line = typeof value === "string" ? value : JSON.stringify(value);
        if (!line) return [];
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          return parsed["signal"] === "database-pool" ? [parsed] : [];
        } catch { return []; }
      });
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.at(-1)).toMatchObject({ usedConnections: 0, configuredLimit: 1 });
    } finally {
      log.mockRestore();
      await runtime.resource.close();
    }
  }, 20_000);

  it("classifies an actual idle PostgreSQL backend failure as a pool error, not a transaction failure", async () => {
    const observations: Array<Readonly<Record<string, string | number>>> = [];
    let resolveIdle: (() => void) | undefined;
    let resolvePoolError: (() => void) | undefined;
    const idle = new Promise<void>((resolve) => { resolveIdle = resolve; });
    const poolError = new Promise<void>((resolve) => { resolvePoolError = resolve; });
    const runtime = createPostgresRuntimeDatabase(workerUrl!, { max: 1, runtimeObservationSink(observation) {
      observations.push(observation);
      if (observation["signal"] === "database-pool" && observation["usedConnections"] === 0) resolveIdle?.();
      if (observation["signal"] === "database-failure" && observation["category"] === "pool") resolvePoolError?.();
    } });
    try {
      const result = await sql<{ backend_pid: number }>`select pg_backend_pid()::int as backend_pid`.execute(runtime.database);
      const backendPid = result.rows[0]?.backend_pid;
      expect(Number.isSafeInteger(backendPid)).toBe(true);
      await waitWithTimeout(idle, 5_000, "POOL_IDLE_BARRIER_TIMEOUT");
      const terminated = await admin.query("select pg_terminate_backend($1::integer) as terminated", [backendPid]);
      expect(terminated.rows[0]?.terminated).toBe(true);
      await waitWithTimeout(poolError, 10_000, "POOL_ERROR_BARRIER_TIMEOUT");

      const serializedRecords = observations.map((observation) => JSON.stringify(observation));
      const evaluate = (metricId: "database.transaction_failures" | "database.pool_failures") => evaluateOperationsLogQuery({
        metricId, definition: OPERATIONS_LOG_QUERIES[metricId], serializedRecords, observedAt: new Date().toISOString(),
        sourceInstalled: true, sourceComplete: true,
      });
      expect(evaluate("database.pool_failures")).toMatchObject({ state: "measured", value: 1 });
      expect(evaluate("database.transaction_failures")).toMatchObject({ state: "measured", value: 0 });
      expect(JSON.stringify(observations)).not.toMatch(/SQLSTATE|connectionString|password|backend_pid/i);
    } finally {
      await runtime.resource.close();
    }
  }, 25_000);
});
