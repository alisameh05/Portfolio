import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPostgresDailyAggregateRepository } from "../../src/modules/measurement/adapters/postgres-daily-aggregates.js";
import { createDailyAggregateWorkService } from "../../src/modules/measurement/application/daily-aggregates.js";
import { createPostgresMeasurementRetentionRepository } from "../../src/modules/measurement/adapters/postgres-retention.js";
import { createMeasurementRetentionWorkService } from "../../src/modules/measurement/application/retention.js";
import { createPostgresFeedbackRetentionRepository } from "../../src/modules/interaction-moderation/adapters/postgres-retention.js";
import { createFeedbackRetentionWorkService } from "../../src/modules/interaction-moderation/application/retention.js";
import { createPhase7DueWorkService } from "../../src/runtime/phase7-due-work.js";
import { createProtectedDueWorkTrigger } from "../../src/runtime/protected-due-work-trigger.js";
import { DEFAULT_PROTECTED_DUE_WORK_BUDGET } from "../../src/runtime/phase8-due-work-control.js";
import { getPhase7DueWorkWorkerService, initializeDatabaseRuntime, resetRuntimeForTests } from "../../src/bootstrap/composition-root.js";
import { getLifecycleCoordinator } from "../../src/runtime/lifecycle.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";
import { parseStableId, type Rejection, type Result, type StableId } from "../../src/shared/domain/index.js";
import type { OwnerExportAssemblyRunResult } from "../../src/modules/portability-operations/index.js";

const WORKER_URL = process.env["PHASE7_JOBS_WORKER_URL"];
const ADMIN_URL = process.env["PHASE7_JOBS_ADMIN_URL"];
const retentionTypes = ["measurement.detail-retention.v1", "measurement.aggregate-retention.v1",
  "measurement.withdrawal-cleanup.v1", "interaction.feedback-retention.v1"] as const;
const secret = "phase8-synthetic-cron-credential-249";
let admin: Client | undefined;
let worker: ReturnType<typeof import("../../src/shared/adapters/postgres/runtime.js").createPostgresRuntimeDatabase> | undefined;

function portfolioId(): StableId<"Portfolio"> {
  const parsed = parseStableId("Portfolio", createSystemIdGenerator().generate("Portfolio"));
  if (!parsed.ok) throw new Error("PHASE8_TRIGGER_TEST_PORTFOLIO_ID_INVALID");
  return parsed.value;
}

function ownerId(): StableId<"Owner"> {
  const parsed = parseStableId("Owner", createSystemIdGenerator().generate("Owner"));
  if (!parsed.ok) throw new Error("PHASE8_TRIGGER_TEST_OWNER_ID_INVALID");
  return parsed.value;
}

type ClaimObserver = (jobs: readonly { readonly jobId: string }[]) => Promise<void>;
type OwnerExportPort = Parameters<typeof createPhase7DueWorkService>[0]["ownerExports"];

interface ServiceOptions {
  readonly maxClaims?: number;
  readonly observeClaim?: ClaimObserver;
  readonly ownerExports?: OwnerExportPort;
  readonly now?: string;
}

function createService(scope: StableId<"Portfolio">, options: ServiceOptions = {}) {
  if (worker === undefined) throw new Error("PHASE8_TRIGGER_TEST_WORKER_NOT_READY");
  const operations = createPostgresOperationsPersistence(worker.database);
  const jobs = {
    ...operations.jobs,
    async claimDue(input: Parameters<typeof operations.jobs.claimDue>[0]) {
      const claimed = await operations.jobs.claimDue(input);
      await options.observeClaim?.(claimed);
      return claimed;
    },
  };
  const retention = createMeasurementRetentionWorkService({ portfolioId: scope,
    transactions: worker.transactions, repository: createPostgresMeasurementRetentionRepository() });
  const daily = createDailyAggregateWorkService({ portfolioId: scope,
    transactions: worker.transactions, repository: createPostgresDailyAggregateRepository() });
  const interaction = createFeedbackRetentionWorkService({ portfolioId: scope,
    transactions: worker.transactions, repository: createPostgresFeedbackRetentionRepository() });
  return createPhase7DueWorkService({
    portfolioId: scope, operations: { transactions: operations.transactions, jobs },
    clock: { now: () => options.now ?? new Date().toISOString() }, ids: createSystemIdGenerator(),
    measurement: { ...daily, ...retention }, interaction,
    ownerExports: options.ownerExports ?? { async runOwnerExportAssembly() {
      return { ok: true as const, value: { claimed: 0, completed: 0, retried: 0, failed: 0, staleLeases: 0,
        cleanup: { scanned: 0, deleted: 0, pending: 0, incomplete: false } } };
    } },
  });
}

function makeTrigger(scope: StableId<"Portfolio">, options: ServiceOptions = {}) {
  const service = createService(scope, options);
  const budget = { ...DEFAULT_PROTECTED_DUE_WORK_BUDGET,
    maxClaimsPerPhase: options.maxClaims ?? 2,
    maxRunDurationMs: 299_600,
  };
  return createProtectedDueWorkTrigger({ cronTriggerSecret: secret, workerId: "phase8-real-postgres-cron",
    runDueWork: service.runDueWork,
    observations: { monotonicNowMs: () => performance.now(), memoryUsageBytes: () => 1 }, budget });
}

async function countScheduledJobs(scope: StableId<"Portfolio">) {
  const response = await admin!.query<{ count: number; unique_count: number }>(`select count(*)::integer as count,
    count(distinct job_type || ':' || semantic_period)::integer as unique_count from operations.jobs
    where semantic_scope_id=$1 and job_type=any($2::text[])`, [scope, retentionTypes]);
  return response.rows[0]!;
}

async function countStatuses(scope: StableId<"Portfolio">) {
  const response = await admin!.query<{ status: string; count: number }>(`select status,count(*)::integer as count
    from operations.jobs where semantic_scope_id=$1 and job_type=any($2::text[]) group by status`, [scope, retentionTypes]);
  return Object.fromEntries(response.rows.map((row) => [row.status, row.count]));
}

async function countAggregateJobs(scope: StableId<"Portfolio">) {
  const response = await admin!.query<{ count: number; leased: number }>(`select count(*)::integer as count,
    count(*) filter (where status='leased')::integer as leased from operations.jobs
    where semantic_scope_id=$1 and job_type='measurement.daily-aggregate.v1'`, [scope]);
  return response.rows[0]!;
}

function addUtcDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + count * 86_400_000).toISOString().slice(0, 10);
}

async function seedCompletedRetention(scope: StableId<"Portfolio">) {
  const periodResult = await admin!.query<{ period: string }>(`select
    to_char((clock_timestamp() at time zone 'UTC')::date,'YYYY-MM-DD') as period`);
  const throughPeriod = periodResult.rows[0]!.period;
  const firstPeriod = addUtcDays(throughPeriod, -14);
  const operations = createPostgresOperationsPersistence(worker!.database);
  await operations.jobs.getPhase7ScheduleStatus({ portfolioId: scope, fromPeriod: firstPeriod, throughPeriod });
  const ids = createSystemIdGenerator();
  for (let period = firstPeriod; period <= throughPeriod; period = addUtcDays(period, 1)) {
    for (const jobType of retentionTypes) {
      const inserted = await operations.transactions.run(transaction => operations.jobs.enqueue(transaction, {
        jobId: ids.generate("Job"), payload: { type: jobType, version: 1, value: {} },
        availableAt: `${period}T00:00:00.000Z`, semanticSchedule: { portfolioId: scope, period },
      }));
      if (!inserted) throw new Error("PHASE8_TRIGGER_RETENTION_SEED_ENQUEUE_FAILED");
    }
  }
  const advanced = await operations.jobs.advancePhase7RetentionSchedule({ portfolioId: scope,
    expectedNextPeriod: firstPeriod, scheduledThroughPeriod: throughPeriod });
  if (!advanced) throw new Error("PHASE8_TRIGGER_RETENTION_SEED_CURSOR_FAILED");
  await admin!.query(`update operations.jobs set status='completed',completed_at=clock_timestamp(),lease_owner=null,
    lease_token=null,lease_expires_at=null where semantic_scope_id=$1 and job_type=any($2::text[])`, [scope, retentionTypes]);
  const status = await operations.jobs.getPhase7ScheduleStatusAtDatabaseCurrentPeriod({ portfolioId: scope,
    fromPeriod: firstPeriod, throughPeriod });
  return { firstPeriod, throughPeriod, status };
}

async function waitForLockedRetentionQuery(input: {
  readonly isChildRunning: () => boolean;
  readonly hasCompletedOutput: () => boolean;
}, timeoutMs = 120_000): Promise<void> {
  const started = performance.now();
  let lastUngrantedLocks: readonly { pid: number; user: string; relation: string | null; lockType: string;
    mode: string; query: string }[] = [];
  while (performance.now() - started < timeoutMs) {
    await admin!.query("select pg_stat_clear_snapshot()");
    const waiting = await admin!.query<{ pid: number; user: string; relation: string | null; lockType: string;
      mode: string; query: string }>(`select a.pid, a.usename as user, c.relname as relation, l.locktype as "lockType",
      l.mode, left(a.query,240) as query from pg_locks l join pg_stat_activity a using (pid)
      join pg_class c on c.oid=l.relation join pg_namespace n on n.oid=c.relnamespace
      where a.pid <> pg_backend_pid() and a.usename='due_work_worker_runtime' and a.wait_event_type='Lock'
        and not l.granted and n.nspname in ('measurement','interaction')`);
    lastUngrantedLocks = waiting.rows;
    if (waiting.rows.length > 0) return;
    if (input.hasCompletedOutput()) throw new Error(`PHASE8_TRIGGER_CLI_COMPLETED_BEFORE_LOCK:${JSON.stringify(lastUngrantedLocks)}`);
    if (!input.isChildRunning()) throw new Error(`PHASE8_TRIGGER_CLI_EXITED_BEFORE_LOCK:${JSON.stringify(lastUngrantedLocks)}`);
    await new Promise((resolveYield) => setTimeout(resolveYield, 20));
  }
  throw new Error(`PHASE8_TRIGGER_POSTGRES_READINESS_BARRIER_TIMEOUT:${JSON.stringify(lastUngrantedLocks)}`);
}

async function childExit(child: ReturnType<typeof spawn>, timeoutMs = 20_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await new Promise((resolveExit, rejectExit) => {
    const timeout = setTimeout(() => rejectExit(new Error("PHASE8_TRIGGER_CLI_CHILD_TIMEOUT")), timeoutMs);
    child.once("exit", (code, signal) => { clearTimeout(timeout); resolveExit({ code, signal }); });
    child.once("error", (error) => { clearTimeout(timeout); rejectExit(error); });
  });
}

describe.runIf(Boolean(WORKER_URL && ADMIN_URL))("protected due-work real PostgreSQL acceptance", () => {
  beforeAll(async () => {
    if (!WORKER_URL || !ADMIN_URL) throw new Error("PHASE8_TRIGGER_DATABASE_REQUIRED");
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    worker = (await import("../../src/shared/adapters/postgres/runtime.js")).createPostgresRuntimeDatabase(WORKER_URL);
  });

  afterAll(async () => {
    await worker?.resource.close();
    await admin?.end();
  });

  it("overlapping protected requests deduplicate schedule keys in PostgreSQL and claim disjoint fenced work", async () => {
    const scope = portfolioId();
    const claimedIds: string[] = [];
    let releaseClaims!: () => void;
    const bothClaimsReady = new Promise<void>((resolveClaims) => { releaseClaims = resolveClaims; });
    const trigger = makeTrigger(scope, { maxClaims: 1, observeClaim: async (jobs) => {
      if (jobs.length === 0) return;
      claimedIds.push(jobs[0]!.jobId);
      if (claimedIds.length === 2) releaseClaims();
      await bothClaimsReady;
    } });
    const makeRequest = () => new Request("https://portfolio.example.test/internal/operations/phase7-due-work", {
      method: "GET", headers: { authorization: `Bearer ${secret}`, "user-agent": "vercel-cron/1.0" },
    });
    const [first, second] = await Promise.all([trigger.handle(makeRequest()), trigger.handle(makeRequest())]);
    const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]) as [Record<string, unknown>, Record<string, unknown>];
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(firstBody["incomplete"]).toBe(true);
    expect(secondBody["incomplete"]).toBe(true);
    expect(await countScheduledJobs(scope)).toEqual({ count: 60, unique_count: 60 });
    const statuses = await countStatuses(scope);
    expect(new Set(claimedIds).size).toBe(2);
    expect(statuses["leased"] ?? 0).toBe(0);
    expect(Object.values(statuses).reduce((sum, count) => sum + count, 0)).toBe(60);
  }, 60_000);

  it("returns HTTP 200 with incomplete totals and retains durable backlog across a restart", async () => {
    const scope = portfolioId();
    const claimedIds: string[] = [];
    const observeClaim: ClaimObserver = async (jobs) => { claimedIds.push(...jobs.map((job) => job.jobId)); };
    const first = await makeTrigger(scope, { maxClaims: 1, observeClaim }).handle(new Request(
      "https://portfolio.example.test/internal/operations/phase7-due-work", {
        method: "GET", headers: { authorization: `Bearer ${secret}` },
      }));
    const firstBody = await first.json() as { incomplete: boolean; totals: { claimed: number; incompleteBacklog: boolean } };
    expect(first.status).toBe(200);
    expect(firstBody).toMatchObject({ incomplete: true, totals: { claimed: 1, incompleteBacklog: true } });
    expect(await countScheduledJobs(scope)).toEqual({ count: 60, unique_count: 60 });
    const beforeRestart = await countStatuses(scope);
    expect(beforeRestart["leased"] ?? 0).toBe(0);
    expect(Object.values(beforeRestart).reduce((sum, count) => sum + count, 0)).toBe(60);
    expect(claimedIds).toHaveLength(1);

    const restarted = await makeTrigger(scope, { maxClaims: 2, observeClaim }).handle(new Request(
      "https://portfolio.example.test/internal/operations/phase7-due-work", {
        method: "GET", headers: { authorization: `Bearer ${secret}` },
      }));
    expect(restarted.status).toBe(200);
    expect((await restarted.json() as { incomplete: boolean }).incomplete).toBe(true);
    expect(await countScheduledJobs(scope)).toEqual({ count: 60, unique_count: 60 });
    const afterRestart = await countStatuses(scope);
    expect(afterRestart["leased"] ?? 0).toBe(0);
    expect(Object.values(afterRestart).reduce((sum, count) => sum + count, 0)).toBe(60);
    expect(claimedIds.length, JSON.stringify({ claimedIds, beforeRestart, afterRestart })).toBeGreaterThan(1);
  }, 60_000);

  it("preserves completed retention and skips aggregates after Owner assembly fails", async () => {
    const scope = portfolioId();
    const seeded = await seedCompletedRetention(scope);
    expect(seeded.status).toMatchObject({ retentionCompleteThrough: seeded.throughPeriod,
      requiredThroughPeriod: seeded.throughPeriod });

    const privateMarker = "OWNER_EXPORT_POSTGRES_PRIVATE_DEPENDENCY_MARKER";
    const ownerResponses: Result<OwnerExportAssemblyRunResult, Rejection>[] = [
      { ok: false, error: { kind: "temporarily_unavailable", code: privateMarker } },
    ];
    let ownerCalls = 0;
    const ownerExports: OwnerExportPort = { async runOwnerExportAssembly() {
      ownerCalls += 1;
      return ownerResponses.shift() ?? { ok: true, value: { claimed: 0, completed: 0, retried: 0, failed: 0,
        staleLeases: 0, cleanup: { scanned: 0, deleted: 0, pending: 0, incomplete: false } } };
    } };
    const claimedIds: string[] = [];
    const trigger = makeTrigger(scope, { maxClaims: 1, ownerExports, now: `${seeded.throughPeriod}T12:00:00.000Z`,
      observeClaim: async jobs => { claimedIds.push(...jobs.map(job => job.jobId)); } });
    const makeRequest = () => new Request("https://portfolio.example.test/internal/operations/phase7-due-work", {
      method: "GET", headers: { authorization: `Bearer ${secret}` },
    });

    const failed = await trigger.handle(makeRequest());
    const failedBody = await failed.text();
    expect(failed.status).toBe(503);
    expect(failedBody).toBe('{"ok":false,"code":"due_work_unavailable"}');
    expect(failedBody).not.toContain(privateMarker);
    expect(ownerCalls).toBe(1);
    expect(claimedIds).toEqual([]);
    expect(await countStatuses(scope)).toEqual({ completed: 60 });
    expect(await countAggregateJobs(scope)).toEqual({ count: 0, leased: 0 });

    const retried = await trigger.handle(makeRequest());
    const retryBody = await retried.json() as { incomplete: boolean };
    expect(retried.status).toBe(200);
    expect(retryBody.incomplete).toBe(true);
    expect(ownerCalls).toBe(2);
    expect(claimedIds).toHaveLength(1);
    expect(await countStatuses(scope)).toEqual({ completed: 60 });
    expect(await countAggregateJobs(scope)).toEqual({ count: 225, leased: 0 });
  }, 60_000);

  it("composes the actual bounded worker through the restricted PostgreSQL runtime", async () => {
    const scope = portfolioId();
    let initialized = false;
    try {
      await initializeDatabaseRuntime({ NODE_ENV: "test", APP_BASE_URL: "https://portfolio.example.test",
        DATABASE_URL: WORKER_URL!, PORTFOLIO_ID: scope, OWNER_ID: ownerId() }, "worker");
      initialized = true;
      const result = await getPhase7DueWorkWorkerService().runDueWork({ workerId: "phase8-composed-postgres-worker",
        maxClaimsPerPhase: 1, maxOwnerExportClaims: 0 });
      expect(result.ok).toBe(true);
      const failures = await admin!.query(`select job_type,last_error_code from operations.jobs
        where semantic_scope_id=$1 and last_error_code='PHASE7_WORK_FAILED'`, [scope]);
      expect(failures.rows).toEqual([]);
      expect(await countScheduledJobs(scope)).toEqual({ count: 60, unique_count: 60 });
    } finally {
      if (initialized) await getLifecycleCoordinator().shutdown();
      resetRuntimeForTests();
    }
  }, 60_000);

  it("stops the real CLI after its active PostgreSQL batch commits at a lock barrier", async () => {
    if (!WORKER_URL || !ADMIN_URL) throw new Error("PHASE8_TRIGGER_DATABASE_REQUIRED");
    const scope = portfolioId();
    const owner = ownerId();
    const tempBase = resolve(process.env["TEMP"] ?? tmpdir());
    const expectedTempBase = process.platform === "win32" ? resolve("C:/t") : resolve(tmpdir());
    if (tempBase.toLowerCase() !== expectedTempBase.toLowerCase()) throw new Error("PHASE8_TRIGGER_TEMP_ROOT_INVALID");
    const ownedTemp = mkdtempSync(join(tempBase, `phase8-cli-owned-${randomUUID()}-`));
    const runWindowMs = 120_000;
    const invocationStartedAt = performance.now();
    let transactionOpen = false;
    let child: ReturnType<typeof spawn> | undefined;
    let stdout = "";
    let stderr = "";
    let cliStartResolve!: (at: number) => void;
    const cliStarted = new Promise<number>((resolveStarted) => { cliStartResolve = resolveStarted; });
    let cliStartedAt = 0;
    let cliStartTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await admin!.query("begin");
      transactionOpen = true;
      await admin!.query(`lock table measurement.public_events, measurement.daily_aggregate_checkpoints,
        measurement.daily_aggregates, measurement.goal_conversion_contributions, measurement.goal_conversion_rebuilds,
        measurement.consents, measurement.consent_history, measurement.retention_checkpoints,
        interaction.feedback, interaction.feedback_retention_checkpoints, interaction.moderation_decisions
        in access exclusive mode`);
      const heldLocks = await admin!.query<{ count: number }>(`select count(*)::integer as count from pg_locks
        where pid=pg_backend_pid() and locktype='relation' and mode='AccessExclusiveLock' and granted`);
      expect(heldLocks.rows[0]?.count).toBe(11);
      child = spawn(process.execPath, [resolve("scripts/phase8-due-work.mjs")], {
        cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TEMP: ownedTemp, TMP: ownedTemp, DATABASE_URL: WORKER_URL,
          PORTFOLIO_ID: scope, OWNER_ID: owner, NODE_ENV: "test", APP_BASE_URL: "https://portfolio.example.test",
          NODE_DISABLE_COMPILE_CACHE: "1",
          PHASE8_DUE_WORK_MAX_MEMORY_BYTES: "1073741824",
          PHASE8_DUE_WORK_MAX_CLAIMS_PER_PHASE: "1",
          PHASE8_DUE_WORK_MAX_CATCH_UP_PERIODS: "1",
          PHASE8_DUE_WORK_MAX_RUN_MS: String(runWindowMs), PHASE8_DUE_WORK_SHUTDOWN_GRACE_MS: "400" },
      });
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr += text;
        if (cliStartedAt === 0 && text.includes("DUE_WORK_RUN_STARTED")) {
          cliStartedAt = performance.now();
          cliStartResolve(cliStartedAt);
        }
      });
      const cliExited = new Promise<never>((_, reject) => {
        child!.once("exit", (code, signal) => reject(new Error(
          `PHASE8_TRIGGER_CLI_EXITED_BEFORE_RUN_START:${code}:${signal}:${stdout.trim()}:${stderr.trim()}`)));
        child!.once("error", (error) => reject(new Error(`PHASE8_TRIGGER_CLI_START_FAILED:${String(error)}`)));
      });
      await Promise.race([cliStarted, cliExited, new Promise<never>((_, reject) => {
        cliStartTimeout = setTimeout(() => reject(new Error(
          `PHASE8_TRIGGER_CLI_START_TIMEOUT:${stdout.trim()}:${stderr.trim()}`)), 150_000);
      })]);
      if (cliStartTimeout !== undefined) clearTimeout(cliStartTimeout);
      await waitForLockedRetentionQuery({ isChildRunning: () => child!.exitCode === null && child!.signalCode === null,
        hasCompletedOutput: () => stdout.includes("{\"ok\"") }).catch(async (error: unknown) => {
        const jobs = await admin!.query(`select job_type,status,attempt_count,last_error_code,semantic_period
          from operations.jobs where semantic_scope_id=$1 and job_type=any($2::text[]) and attempt_count>0
          order by job_type,semantic_period`, [scope, retentionTypes]);
        throw new Error(`PHASE8_TRIGGER_POSTGRES_READINESS_BARRIER_FAILED:${String(error)}:${JSON.stringify(jobs.rows)}:${stdout.trim()}:${stderr.trim()}`);
      });
      if (process.platform === "win32") {
        const stopAt = invocationStartedAt + runWindowMs - 400;
        const remaining = stopAt - performance.now() + 100;
        if (remaining > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, remaining));
      } else {
        expect(child.kill("SIGTERM")).toBe(true);
      }
      await admin!.query("commit");
      transactionOpen = false;
      const ended = await childExit(child);
      expect(ended.code).toBe(2);
      expect(stderr).toBe("DUE_WORK_BUILD_STARTED\nDUE_WORK_WORKER_STARTED\nDUE_WORK_TEST_WORKER_READY\n" +
        "DUE_WORK_TEST_WORKER_ADMITTED\nDUE_WORK_TEST_MODULE_GRAPH_READY\nDUE_WORK_RUN_STARTED\n");
      const output = JSON.parse(stdout.trim()) as { ok: boolean; incomplete: boolean;
        totals: { claimed: number; completed: number; released: number; incompleteBacklog: boolean } };
      expect(output).toMatchObject({ ok: true, incomplete: true,
        totals: { claimed: 1, incompleteBacklog: true } });
      expect(output.totals.completed + output.totals.released).toBe(1);
      const statuses = await countStatuses(scope);
      expect(statuses["leased"] ?? 0).toBe(0);
      expect(await countScheduledJobs(scope)).toEqual({ count: 4, unique_count: 4 });
      expect(Object.values(statuses).reduce((sum, count) => sum + count, 0)).toBe(4);
      expect(readdirSync(ownedTemp)).toEqual([]);
    } finally {
      if (cliStartTimeout !== undefined) clearTimeout(cliStartTimeout);
      if (transactionOpen) await admin!.query("rollback");
      if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      const ownedPrefix = `${tempBase.toLowerCase()}${process.platform === "win32" ? "\\" : "/"}phase8-cli-owned-`;
      if (resolve(ownedTemp).toLowerCase().startsWith(ownedPrefix)) {
        rmSync(ownedTemp, { recursive: true, force: true });
      }
    }
  }, 180_000);

  if (process.platform === "linux") {
    it("forwards an actual Linux OS SIGTERM during compilation before database work", async () => {
      const scope = portfolioId();
      const tempBase = resolve(tmpdir());
      const ownedTemp = mkdtempSync(join(tempBase, `phase8-cli-startup-${randomUUID()}-`));
      let child: ReturnType<typeof spawn> | undefined;
      let stdout = "";
      let stderr = "";
      let buildStartedResolve!: () => void;
      const buildStarted = new Promise<void>((resolveStarted) => { buildStartedResolve = resolveStarted; });
      const startedAt = performance.now();
      let readinessTimeout: ReturnType<typeof setTimeout> | undefined;
      try {
        child = spawn(process.execPath, [resolve("scripts/phase8-due-work.mjs")], {
          cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, TEMP: ownedTemp, TMP: ownedTemp, TMPDIR: ownedTemp, DATABASE_URL: WORKER_URL,
            PORTFOLIO_ID: scope, OWNER_ID: ownerId(), NODE_ENV: "test", APP_BASE_URL: "https://portfolio.example.test",
            NODE_DISABLE_COMPILE_CACHE: "1", PHASE8_DUE_WORK_MAX_RUN_MS: "30000" },
        });
        child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
        child.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          stderr += text;
          if (text.includes("DUE_WORK_BUILD_STARTED")) buildStartedResolve();
        });
        await Promise.race([buildStarted, new Promise<never>((_, reject) => {
          readinessTimeout = setTimeout(() => reject(new Error(`PHASE8_TRIGGER_BUILD_READINESS_TIMEOUT:${stderr.trim()}`)), 30_000);
        })]);
        if (readinessTimeout !== undefined) clearTimeout(readinessTimeout);
        expect(child.kill("SIGTERM")).toBe(true);
        const ended = await childExit(child, 10_000);
        expect(ended.code).toBe(2);
        expect(stderr).toBe("DUE_WORK_BUILD_STARTED\n");
        expect(stdout).toBe('{"ok":true,"incomplete":true,"totals":{"scheduled":0,"deduplicated":0,"claimed":0,"completed":0,"released":0,"failed":0,"staleLeases":0,"processedCount":0,"incompleteBacklog":true,"incompleteCoverage":false,"incompleteOwnerExports":false,"incomplete":true,"ownerExportAssembly":null}}\n');
        expect(performance.now() - startedAt).toBeLessThan(10_000);
        expect((await admin!.query("select count(*)::integer as count from operations.jobs where semantic_scope_id=$1", [scope])).rows)
          .toEqual([{ count: 0 }]);
        expect(readdirSync(ownedTemp)).toEqual([]);
      } finally {
        if (readinessTimeout !== undefined) clearTimeout(readinessTimeout);
        if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        const ownedPrefix = `${tempBase}${process.platform === "win32" ? "\\" : "/"}phase8-cli-startup-`;
        if (resolve(ownedTemp).startsWith(ownedPrefix)) rmSync(ownedTemp, { recursive: true, force: true });
      }
    }, 45_000);

    it("keeps the spawned worker behind admission until its signal handler is ready", async () => {
      if (!WORKER_URL || !ADMIN_URL) throw new Error("PHASE8_TRIGGER_DATABASE_REQUIRED");
      const scope = portfolioId();
      const tempBase = resolve(tmpdir());
      const ownedTemp = mkdtempSync(join(tempBase, `phase8-cli-worker-startup-${randomUUID()}-`));
      const supportRoot = mkdtempSync(join(tempBase, `phase8-cli-worker-barrier-${randomUUID()}-`));
      const preloadPath = join(supportRoot, "worker-pre-ready.cjs");
      const releasePath = join(supportRoot, "release-worker");
      const preload = `const { existsSync, writeSync } = require("node:fs");\n` +
        `if (process.argv[1]?.endsWith("phase8-due-work-cli.js")) {\n` +
        `  writeSync(2, "DUE_WORK_TEST_WORKER_PRE_READY\\n");\n` +
        `  const release = ${JSON.stringify(releasePath)};\n` +
        `  const wait = new Int32Array(new SharedArrayBuffer(4));\n` +
        `  while (!existsSync(release)) Atomics.wait(wait, 0, 0, 25);\n` +
        `}\n`;
      writeFileSync(preloadPath, preload, { flag: "wx" });
      let child: ReturnType<typeof spawn> | undefined;
      let childExited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
      let stdout = "";
      let stderr = "";
      const markerWaiters = new Map<string, () => void>();
      let readinessTimeout: ReturnType<typeof setTimeout> | undefined;
      const waitForMarker = (marker: string) => {
        if (stderr.includes(marker)) return Promise.resolve();
        return new Promise<void>((resolveMarker) => markerWaiters.set(marker, resolveMarker));
      };
      try {
        child = spawn(process.execPath, [resolve("scripts/phase8-due-work.mjs")], {
          cwd: process.cwd(), windowsHide: true, detached: true, stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, TEMP: ownedTemp, TMP: ownedTemp, TMPDIR: ownedTemp, DATABASE_URL: WORKER_URL,
            PORTFOLIO_ID: scope, OWNER_ID: ownerId(), NODE_ENV: "test", APP_BASE_URL: "https://portfolio.example.test",
            NODE_DISABLE_COMPILE_CACHE: "1", NODE_OPTIONS: [process.env["NODE_OPTIONS"], `--require=${preloadPath}`].filter(Boolean).join(" "),
            PHASE8_DUE_WORK_MAX_RUN_MS: "30000" },
        });
        childExited = childExit(child, 15_000);
        child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
          for (const [marker, resolveMarker] of markerWaiters) {
            if (stderr.includes(marker)) { markerWaiters.delete(marker); resolveMarker(); }
          }
        });
        const preReady = waitForMarker("DUE_WORK_TEST_WORKER_PRE_READY");
        await Promise.race([preReady, new Promise<never>((_, reject) => {
          readinessTimeout = setTimeout(() => reject(new Error(`PHASE8_TRIGGER_WORKER_PRE_READY_TIMEOUT:${stderr.trim()}`)), 45_000);
        })]);
        if (readinessTimeout !== undefined) clearTimeout(readinessTimeout);
        expect(stderr).toContain("DUE_WORK_BUILD_STARTED\n");
        expect(stderr).toContain("DUE_WORK_WORKER_STARTED\n");
        expect(child.kill("SIGTERM")).toBe(true);
        const stopPending = waitForMarker("DUE_WORK_STOP_PENDING_WORKER_READY");
        const outcome = await Promise.race([
          stopPending.then(() => ({ kind: "pending" as const })),
          childExited.then((ended) => ({ kind: "exit" as const, ended })),
        ]);
        if (outcome.kind === "exit") {
          writeFileSync(releasePath, "release\n", { flag: "wx" });
          throw new Error(`PHASE8_TRIGGER_WORKER_DIED_BEFORE_READINESS_HANDLING:${outcome.ended.code}:${outcome.ended.signal}:${JSON.stringify(stdout)}:${stderr.trim()}`);
        }
        expect(child.exitCode).toBeNull();
        expect(stderr).not.toContain("DUE_WORK_RUN_STARTED");
        writeFileSync(releasePath, "release\n", { flag: "wx" });
        const ended = await childExited;
        expect(ended.code).toBe(2);
        expect(ended.signal).toBeNull();
        expect(stderr).toBe("DUE_WORK_BUILD_STARTED\nDUE_WORK_WORKER_STARTED\nDUE_WORK_TEST_WORKER_PRE_READY\n" +
          "DUE_WORK_STOP_PENDING_WORKER_READY\nDUE_WORK_TEST_WORKER_READY\nDUE_WORK_TEST_WORKER_STOP_RECEIVED\n");
        expect(stdout).toBe('{"ok":true,"incomplete":true,"totals":{"scheduled":0,"deduplicated":0,"claimed":0,"completed":0,"released":0,"failed":0,"staleLeases":0,"processedCount":0,"incompleteBacklog":true,"incompleteCoverage":false,"incompleteOwnerExports":false,"incomplete":true,"ownerExportAssembly":null}}\n');
        expect(await countScheduledJobs(scope)).toEqual({ count: 0, unique_count: 0 });
        expect(await countStatuses(scope)).toEqual({});
        expect(readdirSync(ownedTemp)).toEqual([]);
      } finally {
        if (readinessTimeout !== undefined) clearTimeout(readinessTimeout);
        if (child !== undefined && child.exitCode === null && child.signalCode === null) {
          try { writeFileSync(releasePath, "release\n", { flag: "wx" }); } catch { /* already released */ }
          child.kill("SIGTERM");
          const stopped = childExited === undefined ? undefined : await Promise.race([
            childExited.then(() => true, () => false), new Promise<false>((resolveStopped) => setTimeout(() => resolveStopped(false), 5_000)),
          ]);
          if (stopped === false && child.pid !== undefined) {
            try { process.kill(-child.pid, "SIGKILL"); } catch { /* the owned process group may already be gone */ }
          }
        }
        const ownedPrefix = `${tempBase}${process.platform === "win32" ? "\\" : "/"}phase8-cli-worker-startup-`;
        const supportPrefix = `${tempBase}${process.platform === "win32" ? "\\" : "/"}phase8-cli-worker-barrier-`;
        if (resolve(ownedTemp).startsWith(ownedPrefix)) rmSync(ownedTemp, { recursive: true, force: true });
        if (resolve(supportRoot).startsWith(supportPrefix)) rmSync(supportRoot, { recursive: true, force: true });
      }
    }, 60_000);
  }
});
