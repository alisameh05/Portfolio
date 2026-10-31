import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { Client } from "pg";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";
import { partitionMigrationsAt } from "./phase7-migration-boundary.mjs";
import { assertPhase3OperationsContractPreserved, assertPhase3OperationsRls, assertPhase4SnapshotsEquivalent,
  snapshotPhase4Database } from "./phase4-migration-integrity.mjs";
import { selectPhase7JobsMode } from "./phase7-jobs-config.mjs";

const root = process.cwd();
const selectedMode = selectPhase7JobsMode(process.argv.slice(2));
if (!selectedMode.ok) {
  console.error(selectedMode.code);
  process.exit(2);
}
const mode = selectedMode.mode;
const runId = randomUUID();
const startedAt = new Date().toISOString();
const refreshTypes = process.argv.includes("--refresh-types");
const ticket249 = mode.ticket === 249;
const initialSource = workingTreeSourceSha256();
const discoveredBin = process.platform === "win32" ? "C:/Program Files/PostgreSQL/18/bin" :
  spawnSync("pg_config", ["--bindir"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim();
const bin = process.env.PHASE7_POSTGRES_BIN ?? discoveredBin ?? "";
const exe = name => bin ? join(bin, name + (process.platform === "win32" ? ".exe" : "")) : name;

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", windowsHide: true,
    ...(command === exe("pg_ctl") ? { stdio: "ignore" } : {}), timeout: 240_000 });
  if (result.error || result.status !== 0) {
    if (args[0]?.includes("vitest")) { if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr); }
    const detail = [result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n")
      .replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]").replace(/\r?\n/g, " | ").slice(-1_000);
    throw new Error(`PHASE7_JOBS_COMMAND_FAILED:${args[0] ?? command}:${result.status ?? "unavailable"}:${detail || "unavailable"}`);
  }
  return result.stdout;
}

async function applyMigrationFiles(client, files) {
  for (const name of files) await client.query(readFileSync(join("supabase/migrations", name), "utf8"));
}

async function recordMigrationLedger(client, files) {
  await client.query("create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key, name text not null)");
  for (const name of files) await client.query("insert into supabase_migrations.schema_migrations(version,name) values ($1,$2)",
    [name.slice(0, 14), name.slice(15, -4)]);
}

async function withDatabase(databaseName, port, work) {
  const client = new Client({ connectionString: `postgres://postgres@127.0.0.1:${port}/${databaseName}?sslmode=disable` });
  await client.connect();
  try { return await work(client); } finally { await client.end(); }
}

const temp = join(tmpdir(), `portfolio-phase7-jobs-${runId}`);
const data = join(temp, "data");
const reportPath = resolve(mode.reportPath);
const roleReportPath = mode.roleReportPath === undefined ? undefined : resolve(mode.roleReportPath);
const evidencePath = resolve(mode.evidencePath);
mkdirSync(temp, { recursive: true });
mkdirSync("artifacts", { recursive: true });
rmSync(reportPath, { force: true });
if (roleReportPath !== undefined) rmSync(roleReportPath, { force: true });
rmSync(evidencePath, { force: true });
const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolvePort(value)); });
});
const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
const admin = new Client({ connectionString: adminUrl });
let started = false, connected = false, cleanup = false, stage = "runtime", result;

function validUtcInstant(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
try {
  run(process.execPath, ["scripts/validation-environment.mjs"]);
  const postgresVersion = run(exe("postgres"), ["--version"]).trim();
  stage = "cluster";
  run(exe("initdb"), ["-D", data, "--no-locale", "-A", "trust", "-U", "postgres"]);
  // Unix-domain socket paths must stay under a 107-byte limit; connection URLs
  // below are TCP loopback, so the extended configuration removes the socket.
  appendFileSync(join(data, "postgresql.conf"), "unix_socket_directories = ''\n");
  run(exe("pg_ctl"), ["-D", data, "-l", join(temp, "server.log"), "-o", `-h 127.0.0.1 -p ${port} -F`, "-w", "start"]);
  started = true;
  await admin.connect(); connected = true;
  stage = "migrations";
  await admin.query("create role anon nologin; create role authenticated nologin; create role shipwithali_migration nologin nosuperuser nobypassrls; grant create on database postgres to shipwithali_migration");
  const migrations = readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort();
  for (const name of migrations) { stage = `migration:${name}`; await admin.query(readFileSync(join("supabase/migrations", name), "utf8")); }
  let migrationProof;
  if (mode.migrationProof) {
    stage = "migration-clean-upgrade-proof";
    await admin.query("create database phase8_upgrade");
    await admin.query("create database phase3_baseline");
    await admin.query("create database phase8_legacy");
    const baselineFiles = Object.keys(JSON.parse(readFileSync("supabase/baselines/phase3.json", "utf8")).migrations).sort();
    const migrationBoundary = partitionMigrationsAt(migrations, "20261026164603_phase7_durable_policy_schedule_keys.sql");
    const { forwardMigration, predecessorMigrations, laterMigrations } = migrationBoundary;
    await withDatabase("phase3_baseline", port, async client => {
      await applyMigrationFiles(client, baselineFiles);
      await recordMigrationLedger(client, baselineFiles);
    });
    await withDatabase("phase8_upgrade", port, async client => {
      await applyMigrationFiles(client, predecessorMigrations);
      await recordMigrationLedger(client, predecessorMigrations);
      await client.query("begin");
      await client.query(`insert into operations.jobs
        (job_id,job_type,payload_version,payload,available_at,attempt_count,status,lease_owner,lease_token,lease_expires_at)
        values ('0196a1b2-7c3d-7e11-9f22-000000000101','migration.preservation-probe.v1',1,
          '{"preserved":"queue-payload"}'::jsonb,'2026-10-26T08:00:00Z',2,'leased','migration-probe','migration-lease-token','2030-01-01T00:00:00Z')`);
      await client.query(`insert into operations.outbox_events
        (event_id,event_type,schema_version,aggregate_id,aggregate_version,payload,correlation_id,causation_id,
         occurred_at,available_at,attempt_count,lease_owner,lease_token,lease_expires_at)
        values ('0196a1b2-7c3d-7e11-9f22-000000000102','migration.preservation-event.v1',1,
          '0196a1b2-7c3d-7e11-9f22-000000000103',4,'{"preserved":"outbox-payload"}'::jsonb,
          'migration-preservation-correlation','migration-preservation-causation','2026-10-26T08:01:00Z',
          '2026-10-26T08:02:00Z',3,'outbox-probe','outbox-lease-token','2030-01-01T00:00:00Z')`);
      await client.query(`insert into operations.idempotency_records
        (operation_scope,actor_scope,key_hash,request_hash,status,result_envelope,created_at,completed_at,expires_at)
        values ('migration-preservation-scope','migration-preservation-actor',repeat('a',64),repeat('b',64),
          'completed','{"preserved":"receipt-envelope"}'::jsonb,'2026-10-26T08:03:00Z',
          '2026-10-26T08:04:00Z','2030-01-01T00:00:00Z')`);
      await client.query("commit");
      await applyMigrationFiles(client, [forwardMigration]);
      await recordMigrationLedger(client, [forwardMigration]);
      await applyMigrationFiles(client, laterMigrations);
      await recordMigrationLedger(client, laterMigrations);
      const preserved = await client.query(`select j.job_id::text,j.status,j.payload,j.attempt_count,j.lease_owner,j.lease_token,
          j.lease_expires_at::text,j.semantic_scope_id::text,j.semantic_period,j.work_incomplete,
          o.event_id::text,o.event_type,o.aggregate_id::text,o.aggregate_version,o.payload as outbox_payload,
          o.correlation_id,o.causation_id,o.attempt_count as outbox_attempt_count,
          o.lease_owner as outbox_lease_owner,o.lease_token as outbox_lease_token,o.lease_expires_at::text as outbox_lease_expires_at,
          o.completed_at,o.dead_at,
          i.operation_scope,i.actor_scope,i.key_hash::text,i.request_hash::text,i.status as receipt_status,
          i.result_envelope,i.created_at::text as receipt_created_at,i.completed_at::text as receipt_completed_at,i.expires_at::text as receipt_expires_at
        from operations.jobs j cross join operations.outbox_events o cross join operations.idempotency_records i
        where j.job_id='0196a1b2-7c3d-7e11-9f22-000000000101'
          and o.event_id='0196a1b2-7c3d-7e11-9f22-000000000102'
          and i.operation_scope='migration-preservation-scope'`);
      if (preserved.rowCount !== 1 || preserved.rows[0].job_id !== "0196a1b2-7c3d-7e11-9f22-000000000101" ||
          preserved.rows[0].status !== "leased" || preserved.rows[0].payload.preserved !== "queue-payload" ||
          preserved.rows[0].attempt_count !== 2 || preserved.rows[0].lease_owner !== "migration-probe" ||
          preserved.rows[0].lease_token !== "migration-lease-token" || preserved.rows[0].semantic_scope_id !== null ||
          preserved.rows[0].semantic_period !== null || preserved.rows[0].work_incomplete !== false ||
          Date.parse(preserved.rows[0].lease_expires_at) !== Date.parse("2030-01-01T00:00:00Z") ||
          preserved.rows[0].event_id !== "0196a1b2-7c3d-7e11-9f22-000000000102" ||
          preserved.rows[0].event_type !== "migration.preservation-event.v1" ||
          preserved.rows[0].aggregate_id !== "0196a1b2-7c3d-7e11-9f22-000000000103" ||
          preserved.rows[0].aggregate_version !== 4 || preserved.rows[0].outbox_payload.preserved !== "outbox-payload" ||
          preserved.rows[0].correlation_id !== "migration-preservation-correlation" ||
          preserved.rows[0].causation_id !== "migration-preservation-causation" ||
          preserved.rows[0].outbox_attempt_count !== 3 || preserved.rows[0].outbox_lease_owner !== "outbox-probe" ||
          preserved.rows[0].outbox_lease_token !== "outbox-lease-token" ||
          Date.parse(preserved.rows[0].outbox_lease_expires_at) !== Date.parse("2030-01-01T00:00:00Z") ||
          preserved.rows[0].completed_at !== null || preserved.rows[0].dead_at !== null ||
          preserved.rows[0].operation_scope !== "migration-preservation-scope" ||
          preserved.rows[0].actor_scope !== "migration-preservation-actor" || preserved.rows[0].receipt_status !== "completed" ||
          preserved.rows[0].result_envelope.preserved !== "receipt-envelope" || preserved.rows[0].key_hash.trim() !== "a".repeat(64) ||
          preserved.rows[0].request_hash.trim() !== "b".repeat(64) ||
          Date.parse(preserved.rows[0].receipt_created_at) !== Date.parse("2026-10-26T08:03:00Z") ||
          Date.parse(preserved.rows[0].receipt_completed_at) !== Date.parse("2026-10-26T08:04:00Z") ||
          Date.parse(preserved.rows[0].receipt_expires_at) !== Date.parse("2030-01-01T00:00:00Z")) {
        throw new Error("PHASE8_UPGRADE_PREEXISTING_OPERATIONS_DATA_NOT_PRESERVED");
      }
    });
    const legacyBoundaryMigrations = predecessorMigrations;
    await withDatabase("phase8_legacy", port, async client => {
      await applyMigrationFiles(client, legacyBoundaryMigrations);
      await recordMigrationLedger(client, legacyBoundaryMigrations);
    });
    await recordMigrationLedger(admin, migrations);
    const baselineUrl = `postgres://postgres@127.0.0.1:${port}/phase3_baseline?sslmode=disable`;
    const upgradeUrl = `postgres://postgres@127.0.0.1:${port}/phase8_upgrade?sslmode=disable`;
    const cleanSnapshot = await snapshotPhase4Database(`${adminUrl}?sslmode=disable`);
    const baselineSnapshot = await snapshotPhase4Database(baselineUrl);
    const upgradeSnapshot = await snapshotPhase4Database(upgradeUrl);
    const phase7ScheduleCatalog = {
      columns: upgradeSnapshot.columns.filter(row => row.schema === "operations" &&
        (row.tableName === "phase7_schedule_progress" || ["semantic_scope_id", "semantic_period", "work_incomplete"].includes(row.name))),
      constraints: upgradeSnapshot.constraints.filter(row => row.schema === "operations" &&
        (["jobs_semantic_schedule_pair_check", "phase7_schedule_progress_pkey", "phase7_schedule_progress_phase_check",
          "phase7_schedule_progress_bounds_check"].includes(row.name) || row.name.startsWith("phase7_schedule_progress_") && row.name.endsWith("_not_null"))),
      indexes: upgradeSnapshot.indexes.filter(row => row.schema === "operations" &&
        ["jobs_semantic_schedule_once", "jobs_policy_period_status_idx", "phase7_schedule_progress_pkey"].includes(row.name)),
    };
    assertPhase3OperationsRls(upgradeSnapshot);
    assertPhase3OperationsContractPreserved(baselineSnapshot, upgradeSnapshot);
    assertPhase4SnapshotsEquivalent(cleanSnapshot, upgradeSnapshot);
    migrationProof = { cleanReplay: "passed", predecessorMigrations: predecessorMigrations.length,
      forwardMigration, operationsContractPreserved: true, cleanUpgradeEquivalent: true,
      predecessorSchemaCommittedRowsPreserved: { jobs: 1, outboxEvents: 1, idempotencyReceipts: 1,
        nullableScheduleMetadata: true, workIncompleteDefault: false },
      phase7ScheduleCatalog,
      laterMigrationsAppliedAfterTarget: laterMigrations,
      rollbackCompatibilityMigrations: legacyBoundaryMigrations.length };
  }
  await admin.query("create role due_work_worker_runtime login nosuperuser nobypassrls; grant shipwithali_worker to due_work_worker_runtime");
  const workerUrl = `postgres://due_work_worker_runtime@127.0.0.1:${port}/postgres?sslmode=disable`;
  // Application-runner probes reserve idempotency receipts and append outbox
  // events through the owning module service; #206 keeps its originally
  // recorded worker/anon/authenticated provisioning unchanged.
  if (mode.usesApplicationRuntime) {
    await admin.query("create role due_work_application_runtime login nosuperuser nobypassrls; grant shipwithali_application to due_work_application_runtime");
  }
  const applicationUrl = `postgres://due_work_application_runtime@127.0.0.1:${port}/postgres?sslmode=disable`;
  const legacyWorkerUrl = `postgres://due_work_worker_runtime@127.0.0.1:${port}/phase8_legacy?sslmode=disable`;
  const env = { ...process.env, PHASE7_JOBS_WORKER_URL: workerUrl,
    PHASE7_JOBS_SECOND_WORKER_URL: workerUrl, PHASE7_JOBS_ADMIN_URL: `${adminUrl}?sslmode=disable`,
    ...(ticket249 ? { PHASE7_JOBS_TICKET: "249" } : {}),
    ...(mode.usesLegacyDatabase ? { PHASE7_JOBS_LEGACY_URL: legacyWorkerUrl } : {}),
    ...(mode.usesApplicationRuntime ? { PHASE7_JOBS_APPLICATION_URL: applicationUrl } : {}),
    ...(mode.phase3Database ? { PHASE3_DATABASE_URL: `${adminUrl}?sslmode=disable`, PHASE3_REQUIRE_DATABASE: "1" } : {}) };
  let routeInventory;
  if (mode.routeInventory) {
    stage = "route-inventory";
    const output = run(process.execPath, ["scripts/check-route-inventory.mjs", "--no-write"], env);
    const summary = output.match(/route inventory: all \d+ checks passed \(5 public, 48 owner, 2 operational, (\d+) registered, (\d+) pending product routes\)/u);
    if (summary === null || Number(summary[1]) + Number(summary[2]) !== 53) {
      throw new Error("PHASE8_PROTECTED_TRIGGER_ROUTE_INVENTORY_FAILED");
    }
    routeInventory = { success: true, summary: summary[0] };
  }
  stage = "type-generation";
  for (const [schema, typeFile] of [
    ["measurement", "src/modules/measurement/adapters/database.generated.ts"],
    ["interaction", "src/modules/interaction-moderation/adapters/database.generated.ts"],
  ]) {
    const codegen = ["node_modules/kysely-codegen/dist/cli/bin.js", "--dialect", "postgres", "--url", "env(PHASE7_JOBS_ADMIN_URL)",
      "--default-schema", schema, "--include-pattern", `${schema}.*`, "--date-parser", "timestamp", "--out-file", typeFile, "--log-level", "error"];
    if (!refreshTypes) codegen.push("--verify");
    run(process.execPath, codegen, env);
  }
  const sharedCodegen = ["node_modules/kysely-codegen/dist/cli/bin.js", "--dialect", "postgres", "--url", "env(PHASE7_JOBS_ADMIN_URL)",
    "--default-schema", "content,cv_portfolio,identity_access,media,operations,portfolio_config,taxonomy",
    "--include-pattern", "{content,cv_portfolio,identity_access,media,operations,portfolio_config,taxonomy}.*",
    "--date-parser", "timestamp", "--out-file", "src/shared/adapters/postgres/database.generated.ts", "--log-level", "error"];
  if (!refreshTypes) sharedCodegen.push("--verify");
  run(process.execPath, sharedCodegen, env);
  const testedSource = workingTreeSourceSha256();
  if (!refreshTypes && testedSource !== initialSource) throw new Error("PHASE7_JOBS_SOURCE_CHANGED_BEFORE_ACCEPTANCE");
  stage = "acceptance";
  // #249 composes the current #248 durable-retention regression inventory with
  // its own isolated protected-trigger and real-service acceptance files.
  const acceptanceFiles = mode.acceptanceFiles;
  const expectedAssertionTitles = mode.assertionTitles;
  const expectedTests = expectedAssertionTitles.length;
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...acceptanceFiles,
    "--no-file-parallelism", "--reporter=json", `--outputFile=${reportPath}`], env);
  const tests = JSON.parse(readFileSync(reportPath, "utf8"));
  const assertions = tests.testResults.flatMap(suite => suite.assertionResults ?? []);
  const assertionTitles = assertions.map(assertion => assertion.title);
  const normalizeSuitePath = value => {
    const normalized = resolve(value).replaceAll("\\", "/");
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const expectedSuitePaths = acceptanceFiles.map(normalizeSuitePath).sort();
  const actualSuitePaths = tests.testResults.map(suite => normalizeSuitePath(suite.name)).sort();
  const acceptanceInventoryMismatch = new Set(expectedAssertionTitles).size !== expectedAssertionTitles.length ||
    new Set(acceptanceFiles).size !== acceptanceFiles.length ||
    JSON.stringify([...assertionTitles].sort()) !== JSON.stringify([...expectedAssertionTitles].sort()) ||
    JSON.stringify(actualSuitePaths) !== JSON.stringify(expectedSuitePaths);
  if (!tests.success || tests.numFailedTestSuites !== 0 || tests.numFailedTests !== 0 || tests.numPendingTests !== 0 || tests.numTodoTests !== 0 ||
      tests.numPassedTests !== expectedTests || assertions.length !== expectedTests || tests.testResults.length !== acceptanceFiles.length ||
      tests.testResults.some(suite => suite.status !== "passed") || assertions.some(assertion => assertion.status !== "passed") ||
      acceptanceInventoryMismatch) {
    throw new Error("PHASE7_JOBS_ACCEPTANCE_INCOMPLETE");
  }
  let roleMatrix;
  if (mode.roleMatrix) {
    stage = "role-rls-acceptance";
    run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/database/role-rls-matrix.test.ts",
      "--no-file-parallelism", "--reporter=json", `--outputFile=${roleReportPath}`], env);
    roleMatrix = JSON.parse(readFileSync(roleReportPath, "utf8"));
    if (!roleMatrix.success || roleMatrix.numFailedTestSuites !== 0 || roleMatrix.numFailedTests !== 0 ||
        roleMatrix.numPendingTests !== 0 || roleMatrix.numTodoTests !== 0 || roleMatrix.numPassedTests === 0 ||
        roleMatrix.testResults.length !== 1 || roleMatrix.testResults.some(suite => suite.status !== "passed")) {
      throw new Error("PHASE8_RETRY_RECOVERY_RLS_ACCEPTANCE_INCOMPLETE");
    }
  }
  if (workingTreeSourceSha256() !== testedSource) throw new Error("PHASE7_JOBS_SOURCE_CHANGED_DURING_ACCEPTANCE");
  result = {
    ticket: mode.ticket, runId, startedAt,
    sourceRevision: run("git", ["rev-parse", "HEAD"]).trim(), sourceTreeSha256: testedSource, postgresVersion,
    migrations: migrations.map(name => ({ name, sha256: createHash("sha256").update(readFileSync(join("supabase/migrations", name))).digest("hex") })),
    tools: { node: process.versions.node, npm: (process.env.npm_config_user_agent ?? "").match(/npm\/([^\s]+)/)?.[1] ?? "unavailable" },
    platform: { os: process.platform, architecture: process.arch },
    acceptanceInventory: { suiteFiles: acceptanceFiles, assertionTitles: expectedAssertionTitles },
    required: { success: tests.success, passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests,
      todo: tests.numTodoTests, failedSuites: tests.numFailedTestSuites },
    ...(mode.routeInventory ? { routeInventory } : {}),
    ...(mode.roleMatrix ? { roleMatrix: { success: roleMatrix.success, passed: roleMatrix.numPassedTests,
      failed: roleMatrix.numFailedTests, skipped: roleMatrix.numPendingTests, todo: roleMatrix.numTodoTests } } : {}),
    ...(mode.migrationProof ? { migrationProof } : {}),
    assertions: assertions.map(assertion => ({ title: assertion.title, status: assertion.status })),
    databaseRoles: mode.databaseRoles,
    criteria: mode.criteria,
    reproduction: mode.reproduction,
    scope: mode.scope,
  };
  console.log(JSON.stringify({ required: result.required, runId, sourceTreeSha256: testedSource }));
} catch (error) {
  console.error(error instanceof Error && /^PHASE7_JOBS_/.test(error.message) ? error.message : "PHASE7_JOBS_VALIDATION_FAILED");
  if (mode.migrationProof && stage === "migration-clean-upgrade-proof" && error instanceof Error) {
    console.error(error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]").replace(/\r?\n/g, " | ").slice(-1_000));
  }
  console.error(JSON.stringify({ stage, code: typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : "unavailable" }));
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    for (const suite of report.testResults ?? []) {
      const assertions = (suite.assertionResults ?? []).map(assertion => {
        if (assertion.status === "passed") return { title: assertion.title, status: assertion.status };
        const failureMessages = (assertion.failureMessages ?? []).map(message =>
          message.replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]").replaceAll(root, "[workspace]").slice(-2_000));
        return { title: assertion.title, status: assertion.status, failureMessages };
      });
      console.error(JSON.stringify({ suite: suite.name.replace(root, ""), status: suite.status, assertions }));
    }
  } catch { /* no test report exists */ }
  process.exitCode = 1;
} finally {
  let cleanupOk = true;
  if (connected) {
    try { await admin.end(); connected = false; }
    catch { cleanupOk = false; console.error("PHASE7_JOBS_ADMIN_CONNECTION_CLOSE_FAILED"); }
  }
  let postgresStopped = !started;
  if (started) {
    try { run(exe("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]); postgresStopped = true; }
    catch { cleanupOk = false; console.error("PHASE7_JOBS_POSTGRES_STOP_FAILED"); }
  }
  let runDirectoryRemoved = false;
  if (postgresStopped) {
    try { rmSync(temp, { recursive: true, force: true }); runDirectoryRemoved = true; }
    catch { cleanupOk = false; console.error("PHASE7_JOBS_RUN_DIRECTORY_CLEANUP_FAILED"); }
  } else {
    console.error("PHASE7_JOBS_RUN_DIRECTORY_RETAINED_FOR_LIVE_CLUSTER");
  }
  let runnerReportsRemoved = true;
  for (const path of [reportPath, ...(roleReportPath === undefined ? [] : [roleReportPath])]) {
    try { rmSync(path, { force: true }); }
    catch { runnerReportsRemoved = false; }
    if (existsSync(path)) runnerReportsRemoved = false;
  }
  cleanup = cleanupOk && postgresStopped && runDirectoryRemoved && runnerReportsRemoved;
  if (!cleanup) process.exitCode = 1;
  if (result && cleanup) {
    const endedAt = new Date().toISOString();
    const evidence = { ...result, endedAt, cleanup };
    if (!validUtcInstant(evidence.startedAt) || !validUtcInstant(evidence.endedAt) || evidence.startedAt > evidence.endedAt) {
      console.error("PHASE7_JOBS_EVIDENCE_RUN_TIME_INVALID");
      process.exitCode = 1;
    } else {
      mkdirSync("evidence", { recursive: true });
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      const storedEvidence = JSON.parse(readFileSync(evidencePath, "utf8"));
      if (!validUtcInstant(storedEvidence.startedAt) || !validUtcInstant(storedEvidence.endedAt) ||
          storedEvidence.startedAt > storedEvidence.endedAt || storedEvidence.cleanup !== true) {
        rmSync(evidencePath, { force: true });
        console.error("PHASE7_JOBS_EVIDENCE_VERIFICATION_FAILED");
        process.exitCode = 1;
      } else {
        console.log(JSON.stringify({ evidence: evidencePath, startedAt: storedEvidence.startedAt, endedAt: storedEvidence.endedAt,
          cleanup, runId }));
      }
    }
  } else {
    console.log(JSON.stringify({ cleanup, runId, postgresStopped, runDirectoryRemoved }));
  }
}
