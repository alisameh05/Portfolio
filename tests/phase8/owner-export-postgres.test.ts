/**
 * owner-export-postgres.test.ts — Phase 8 #238 disposable-cluster acceptance.
 *
 * Runs only under the #238 evidence runner, which provisions restricted
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

import { createPostgresOwnerExportStore } from "../../src/modules/portability-operations/adapters/postgres-owner-export-store.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import {
  applyGuardedOwnerExportTransition,
  createOwnerExportService,
  OWNER_EXPORT_SCHEMA_VERSION,
  parseSafeErrorCode,
  type OwnerExportPackageManifest,
  type OwnerExportStorePort,
  type OwnerExportTransitionInput,
} from "../../src/modules/portability-operations/index.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createSystemIdGenerator, type StableIdGenerator } from "../../src/runtime/ports.js";
import { createStableId, parseIdempotencyKey, type OwnerActor, type StableId } from "../../src/shared/domain/index.js";

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
  overrides: { store?: OwnerExportStorePort } = {},
) {
  const operations = createPostgresOperationsPersistence(database.database, { now: () => now });
  const store = createPostgresOwnerExportStore(database.database, { outbox: operations.outbox });
  const ids: StableIdGenerator = createSystemIdGenerator();
  const service = createOwnerExportService({
    operations,
    exports: overrides.store ?? store,
    clock: { now: () => now },
    ids,
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

function manifestFor(scope: "portfolio-content" | "taxonomy" | "cv-metadata"): OwnerExportPackageManifest {
  return {
    packageFormat: "shipwithali-owner-export",
    schemaVersion: OWNER_EXPORT_SCHEMA_VERSION,
    createdAt: now,
    algorithm: "sha-256",
    digest: "a".repeat(64),
    includedScopes: [scope] as never,
    publicEventDataCoverage: { mode: "excluded" } as never,
    entries: [{
      path: `${scope}/content.ndjson` as string,
      scope,
      mediaType: "application/x-ndjson" as const,
      recordSchema: `urn:shipwithali:owner-export-schema:${scope}:1.0` as never,
      schemaPath: `schemas/${scope}.schema.json` as never,
      schemaVersion: OWNER_EXPORT_SCHEMA_VERSION,
      digest: "b".repeat(64),
      recordCount: 2,
    }],
  } as never as OwnerExportPackageManifest;
}

function transitionInput(
  exportId: StableId<"OwnerExport">,
  fromStatus: OwnerExportTransitionInput["fromStatus"],
  toStatus: OwnerExportTransitionInput["toStatus"],
  expectedAggregateVersion: number,
  at: string,
  metadata: Pick<OwnerExportTransitionInput, "failureCode" | "integrityManifest" | "artifactId"> = {},
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
      await admin?.query("delete from operations.jobs where job_type = 'portability.owner-export-assembly.v1'");
      await admin?.query("delete from operations.idempotency_records where operation_scope = $1", [OPERATION_SCOPE]);
      await admin?.query("delete from operations.idempotency_records where operation_scope like 'portability.owner-export-request:%'");
      await admin?.query("delete from operations.outbox_events where payload->>'type' = 'portability.export_produced.v1'");
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
    advance();
    expect(await applyGuardedOwnerExportTransition(primary.store, transitionInput(
      originalExportId!, "requested", "building", 1, now,
    ))).toEqual({ ok: true, value: "applied" });
    expect(await primary.service.requestOwnerExport(command(["portfolio-content", "taxonomy"], replayKey))).toEqual(requested);
    expect(await primary.service.getOwnerExport({ actor, portfolioId, exportId: originalExportId! }))
      .toMatchObject({ ok: true, value: { state: "building", downloadAvailable: false } });
    // building → ready; the view turns truthful and the produced event lands once.
    advance();
    const artifactId = createStableId("OwnerExportArtifact");
    expect(await applyGuardedOwnerExportTransition(primary.store, transitionInput(
      originalExportId!, "building", "ready", 2, now,
      { integrityManifest: manifestFor("taxonomy"), artifactId },
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
      "select count(*)::int as count from operations.outbox_events where payload->>'type' = 'portability.export_produced.v1' and aggregate_id = $1",
      [originalExportId!],
    )).toBe(1);
    // ready → expired; the original request keeps replaying.
    advance();
    expect(await applyGuardedOwnerExportTransition(primary.store, transitionInput(
      originalExportId!, "ready", "expired", 3, now,
      { integrityManifest: manifestFor("taxonomy"), artifactId },
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
    advance();
    expect(await applyGuardedOwnerExportTransition(primary.store, transitionInput(
      failedExportId!, "requested", "failed", 1, now, { failureCode: parseSafeErrorCode("ASSEMBLY_FAILED") },
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
    advance();
    expect(await applyGuardedOwnerExportTransition(primary.store, transitionInput(
      exportId!, "requested", "failed", 1, now, { failureCode: parseSafeErrorCode("ASSEMBLY_FAILED") },
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
    advance();
    expect(await applyGuardedOwnerExportTransition(primary.store, transitionInput(
      secondId!, "requested", "building", 2, now,
    ))).toEqual({ ok: true, value: "stale" });
    expect(await primary.service.getOwnerExport({ actor, portfolioId, exportId: secondId! }))
      .toMatchObject({ ok: true, value: { state: "requested" } });
    expect(await applyGuardedOwnerExportTransition(primary.store, transitionInput(
      secondId!, "requested", "building", 1, now,
    ))).toEqual({ ok: true, value: "applied" });
    // building → ready requires exactly the readiness metadata.
    expect(await applyGuardedOwnerExportTransition(primary.store, transitionInput(
      secondId!, "building", "ready", 2, now,
    ))).toMatchObject({ ok: false });
    advance();
    const artifactId = createStableId("OwnerExportArtifact");
    expect(await applyGuardedOwnerExportTransition(primary.store, transitionInput(
      secondId!, "building", "ready", 2, now,
      { integrityManifest: manifestFor("taxonomy"), artifactId },
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
