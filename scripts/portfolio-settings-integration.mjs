#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { migrationSha256 } from "./migration-checksum.mjs";
import {
  assertPhase3OperationsContractPreserved,
  assertPhase3OperationsRls,
  assertPhase4SnapshotsEquivalent,
  snapshotPhase4Database,
  validatePhase3MigrationSnapshot,
} from "./phase4-migration-integrity.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI = join(ROOT, "node_modules/supabase/dist/supabase.js");
const CODEGEN = join(ROOT, "node_modules/kysely-codegen/dist/cli/bin.js");
const GENERATED = join(ROOT, "src/shared/adapters/postgres/database.generated.ts");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 600_000,
    env: options.env ?? localEnvironment(),
  });
  if (result.error || result.status !== 0) {
    const diagnostic = `${result.stderr ?? ""}\n${result.stdout ?? ""}`
      .replace(/postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/gi, "postgres://[redacted]@")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted jwt]")
      .replace(/(\b(?:ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET|SUPABASE_ACCESS_TOKEN)\b\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
      .replace(/((?:anon|service_role)\s+key|jwt\s+secret|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(-1_500);
    throw new Error(`${options.errorCode ?? "PORTFOLIO_SETTINGS_COMMAND_FAILED"}${diagnostic === "" ? "" : `:${diagnostic}`}`);
  }
  return result.stdout;
}

function workingTreeSourceSha256() {
  const digest = createHash("sha256").update(run("git", ["diff", "HEAD", "--binary"]));
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard"])
    .split(/\r?\n/u)
    .filter((path) => path !== "" && path.replaceAll("\\", "/") !== "evidence/phase-5-owner-composition-postgres.json")
    .sort();
  for (const path of untracked) digest.update(path).update(readFileSync(join(ROOT, path)));
  return digest.digest("hex");
}

export function localEnvironment(source = process.env) {
  const env = { ...source, CI: "1" };
  for (const key of Object.keys(env)) {
    if (/^(?:SUPABASE_|PHASE4_|DATABASE_|OWNER_GITHUB_)/.test(key)) delete env[key];
  }
  return env;
}

function requireDocker() {
  run("docker", ["info", "--format", "{{.ServerVersion}}"], {
    timeout: 20_000,
    errorCode: "PORTFOLIO_SETTINGS_DOCKER_UNAVAILABLE",
  });
}

export function isolatedConfig(source, projectId, basePort = 57320) {
  let config = source.replace(/^project_id = .*$/m, `project_id = "${projectId}"`);
  const replacements = new Map([
    ["port = 54320", `port = ${basePort}`],
    ["port = 54321", `port = ${basePort + 1}`],
    ["port = 54322", `port = ${basePort + 2}`],
    ["port = 54323", `port = ${basePort + 3}`],
    ["port = 54324", `port = ${basePort + 4}`],
    ["port = 54327", `port = ${basePort + 7}`],
    ["port = 54329", `port = ${basePort + 9}`],
  ]);
  for (const [from, to] of replacements) {
    if (!config.includes(from)) throw new Error("PORTFOLIO_SETTINGS_PORT_LAYOUT_CHANGED");
    config = config.replace(from, to);
  }
  return config;
}

function readDatabaseUrl(workdir, expectedPort) {
  const output = run(process.execPath, [CLI, "--workdir", workdir, "status", "--output", "json"], {
    timeout: 30_000,
    errorCode: "PORTFOLIO_SETTINGS_STATUS_FAILED",
  });
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("PORTFOLIO_SETTINGS_DB_URL_MISSING");
  const status = JSON.parse(output.slice(start, end + 1));
  const connectionString = status.DB_URL ?? status.db_url;
  if (typeof connectionString !== "string") throw new Error("PORTFOLIO_SETTINGS_DB_URL_MISSING");
  const url = new URL(connectionString);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname) || url.port !== String(expectedPort)) {
    throw new Error("PORTFOLIO_SETTINGS_DB_NOT_ISOLATED");
  }
  return connectionString;
}

export function requireExecutedTests(report, expectedSuiteCount = 1) {
  if (
    report.success !== true || report.numPassedTests < 1 || report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 || report.numTodoTests !== 0 ||
    report.testResults?.length !== expectedSuiteCount || report.testResults.some((suite) => suite.status !== "passed")
  ) throw new Error("PORTFOLIO_SETTINGS_TEST_FAILED: no missing or skipped database evidence is accepted.");
}

export function requirePredecessorTests(report, expectedFiles) {
  if (
    report.success !== true || report.numPassedTests < 1 || report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 || report.numTodoTests !== 0 ||
    report.testResults?.length !== expectedFiles.length ||
    report.testResults.some((suite) => suite.status !== "passed")
  ) throw new Error("PORTFOLIO_SETTINGS_PHASE3_PREDECESSOR_TESTS_FAILED");
  return report.numPassedTests;
}

export function evidenceOutputPath(candidate = process.env.PORTFOLIO_SETTINGS_EVIDENCE_PATH) {
  if (candidate === undefined || candidate === "") return join(ROOT, "evidence/phase-4-database-integrity.json");
  const resolved = resolve(candidate);
  const relativePath = relative(resolve(tmpdir()), resolved);
  const name = basename(resolved);
  if (
    relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath) ||
    !name.startsWith("shipwithali-phase5-smoke-") || !name.endsWith(".json")
  ) throw new Error("PORTFOLIO_SETTINGS_EVIDENCE_PATH_INVALID");
  return resolved;
}

function migrationSources() {
  const directory = join(ROOT, "supabase/migrations");
  const sqlFiles = readdirSync(directory).filter((name) => name.endsWith(".sql")).sort();
  const files = sqlFiles.filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name));
  if (files.length !== sqlFiles.length) throw new Error("PORTFOLIO_SETTINGS_MIGRATION_NAME_INVALID");
  const contents = new Map(files.map((name) => [name, readFileSync(join(directory, name), "utf8")]));
  const snapshot = JSON.parse(readFileSync(join(ROOT, "supabase/baselines/phase3.json"), "utf8"));
  const phase3Files = validatePhase3MigrationSnapshot(snapshot, Object.keys(snapshot.migrations), contents);
  for (const file of files.filter((name) => !phase3Files.includes(name))) {
    const source = contents.get(file).toLowerCase();
    if (
      file.localeCompare(phase3Files.at(-1)) <= 0 ||
      !source.includes("set lock_timeout = '5s'") ||
      !source.includes("-- rollback:")
    ) throw new Error("PORTFOLIO_SETTINGS_EXPANSION_MIGRATION_POLICY_INVALID");
  }
  return {
    files,
    contents,
    phase3Files,
    checksums: files.map((file) => ({ file, sha256: migrationSha256(contents.get(file)) })),
  };
}

function createProject(name, basePort, migrations) {
  const projectId = `shipwithali-${name}-${process.pid}-${randomBytes(4).toString("hex")}`;
  const workdir = mkdtempSync(join(tmpdir(), `${projectId}-`));
  const project = { projectId, workdir, network: `${projectId}-loopback`, basePort, networkCreated: false, attemptedStart: false };
  try {
    const supabase = join(workdir, "supabase");
    mkdirSync(join(supabase, "migrations"), { recursive: true });
    writeFileSync(join(supabase, "config.toml"), isolatedConfig(readFileSync(join(ROOT, "supabase/config.toml"), "utf8"), projectId, basePort));
    copyFileSync(join(ROOT, "supabase/seed.sql"), join(supabase, "seed.sql"));
    for (const file of migrations) copyFileSync(join(ROOT, "supabase/migrations", file), join(supabase, "migrations", file));
    return project;
  } catch (error) {
    rmSync(workdir, { recursive: true, force: true });
    throw error;
  }
}

function invokeProject(project, args, env) {
  return run(process.execPath, [CLI, "--workdir", project.workdir, ...args], {
    env,
    errorCode: args[0] === "start"
      ? "PORTFOLIO_SETTINGS_SUPABASE_START_FAILED"
      : args[0] === "db"
        ? "PORTFOLIO_SETTINGS_SUPABASE_RESET_FAILED"
        : args[0] === "migration"
          ? "PORTFOLIO_SETTINGS_SUPABASE_MIGRATION_FAILED"
          : "PORTFOLIO_SETTINGS_SUPABASE_COMMAND_FAILED",
  });
}

function startProject(project, env) {
  run("docker", ["network", "create", "-o", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1", project.network], {
    timeout: 20_000, env, errorCode: "PORTFOLIO_SETTINGS_NETWORK_CREATE_FAILED",
  });
  project.networkCreated = true;
  project.attemptedStart = true;
  invokeProject(project, ["start", "--network-id", project.network], env);
  invokeProject(project, ["db", "reset", "--local"], env);
  return readDatabaseUrl(project.workdir, project.basePort + 2);
}

async function seedAndCapturePhase3Operations(connectionString) {
  const admin = new Client({ connectionString });
  const logins = [];
  const clients = [];
  await admin.connect();
  let rows;
  let primaryError;
  let cleanupFailed = false;
  try {
    const urls = new Map();
    for (const role of ["shipwithali_application", "shipwithali_worker"]) {
      const login = `phase4_seed_${process.pid}_${randomBytes(4).toString("hex")}`;
      const password = randomBytes(32).toString("hex");
      await admin.query(`create role "${login}" login password '${password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
      logins.push({ login, role });
      await admin.query(`grant ${role} to "${login}"`);
      const url = new URL(connectionString);
      url.username = login;
      url.password = password;
      urls.set(role, url.toString());
    }
    const application = new Client({ connectionString: urls.get("shipwithali_application") });
    const worker = new Client({ connectionString: urls.get("shipwithali_worker") });
    clients.push(application, worker);
    await Promise.all(clients.map((client) => client.connect()));
    await application.query(`
      insert into operations.idempotency_records (
        operation_scope, actor_scope, key_hash, request_hash, status, expires_at
      ) values (
        'phase4.migration.preservation', 'phase3-seed', repeat('a', 64), repeat('b', 64),
        'reserved', transaction_timestamp() + interval '1 day'
      )
    `);
    await application.query(`
      insert into operations.outbox_events (
        event_id, event_type, schema_version, aggregate_id, aggregate_version,
        payload, correlation_id, occurred_at, available_at
      ) values (
        '018f4f7d-5000-7000-8000-000000000004', 'phase4.migration.preservation', 1,
        '018f4f7d-5000-7000-8000-000000000005', 1, '{}'::jsonb,
        'phase3-seed', transaction_timestamp(), transaction_timestamp()
      )
    `);
    await worker.query(`
      insert into operations.jobs (job_id, job_type, payload_version, payload, available_at)
      values ('018f4f7d-5000-7000-8000-000000000006', 'phase4.migration.preservation', 1,
              '{}'::jsonb, transaction_timestamp())
    `);
    rows = await phase3OperationsRows(admin);
  } catch (error) {
    primaryError = error;
  } finally {
    for (const client of clients) {
      try { await client.end(); } catch { cleanupFailed = true; }
    }
    for (const { login, role } of [...logins].reverse()) {
      for (const statement of [
        `revoke ${role} from "${login}"`,
        `alter role "${login}" nologin`,
        `drop role if exists "${login}"`,
      ]) {
        try { await admin.query(statement); } catch { cleanupFailed = true; }
      }
    }
    try { await admin.end(); } catch { cleanupFailed = true; }
  }
  if (cleanupFailed) throw new Error("PORTFOLIO_SETTINGS_PHASE3_PROBE_CLEANUP_FAILED");
  if (primaryError) throw primaryError;
  return rows;
}

async function phase3OperationsRows(client) {
  const idempotency = await client.query("select to_jsonb(record) as row from operations.idempotency_records record where operation_scope = 'phase4.migration.preservation'");
  const outbox = await client.query("select to_jsonb(record) as row from operations.outbox_events record where event_type = 'phase4.migration.preservation'");
  const jobs = await client.query("select to_jsonb(record) as row from operations.jobs record where job_type = 'phase4.migration.preservation'");
  return { idempotency: idempotency.rows, outbox: outbox.rows, jobs: jobs.rows };
}

async function assertPhase3OperationsPreserved(connectionString, expected) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const actual = await phase3OperationsRows(client);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("PORTFOLIO_SETTINGS_PHASE3_OPERATIONS_NOT_PRESERVED");
    return actual;
  } finally {
    await client.end();
  }
}

export async function main() {
  const ticket109 = process.argv.includes("--ticket-109");
  const ticket110 = process.argv.includes("--ticket-110");
  const ticket111 = process.argv.includes("--ticket-111");
  const ticket113 = process.argv.includes("--ticket-113");
  const ticket112 = process.argv.includes("--ticket-112");
  const ticket115 = process.argv.includes("--ticket-115");
  const ticket114 = process.argv.includes("--ticket-114");
  const ticket117 = process.argv.includes("--ticket-117");
  const ticket116 = process.argv.includes("--ticket-116");
  const ticket118 = process.argv.includes("--ticket-118");
  const ticket119 = process.argv.includes("--ticket-119");
  const ticket120 = process.argv.includes("--ticket-120");
  const ticket122 = process.argv.includes("--ticket-122");
  const ticket121 = process.argv.includes("--ticket-121");
  if ([ticket109, ticket110, ticket111, ticket112, ticket113, ticket114, ticket115, ticket116, ticket117, ticket118, ticket119, ticket120, ticket121, ticket122].filter(Boolean).length > 1) throw new Error("PORTFOLIO_SETTINGS_TICKET_SELECTION_INVALID");
  const contentAuthoringTicket = ticket109 || ticket110 || ticket111 || ticket112 || ticket113 || ticket114 || ticket115 || ticket116 || ticket117 || ticket118 || ticket119 || ticket120 || ticket121 || ticket122;
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const supabasePackage = JSON.parse(readFileSync(join(ROOT, "node_modules/supabase/package.json"), "utf8"));
  if (supabasePackage.version !== packageJson.devDependencies.supabase) {
    throw new Error("PORTFOLIO_SETTINGS_CLI_PIN_MISMATCH");
  }

  const migrations = migrationSources();
  const phase4Files = migrations.files.filter((file) => !migrations.phase3Files.includes(file));
  if (phase4Files.length === 0) throw new Error("PORTFOLIO_SETTINGS_PHASE4_MIGRATIONS_MISSING");
  requireDocker();
  const env = localEnvironment();
  const projects = [];
  let cleanProject;
  let upgradeProject;
  let failure;

  try {
    cleanProject = createProject("settings-clean", 57320, migrations.files);
    projects.push(cleanProject);
    upgradeProject = createProject("settings-upgrade", 57340, migrations.phase3Files);
    projects.push(upgradeProject);
    console.log("Starting isolated loopback PostgreSQL clean and Phase 3 upgrade projects.");
    const cleanUrl = startProject(cleanProject, env);
    const upgradeUrl = startProject(upgradeProject, env);
    console.log("Isolated PostgreSQL projects are healthy; clean and Phase 3 upgrade migrations are applied.");

    const phase3Snapshot = await snapshotPhase4Database(upgradeUrl);
    assertPhase3OperationsRls(phase3Snapshot);
    const predecessorTestFiles = [
      "tests/database/postgres-transaction-runner.test.ts",
      "tests/database/postgres-integration.test.ts",
      "tests/database/optimistic-concurrency.test.ts",
      "tests/database/idempotency.test.ts",
      "tests/database/outbox.test.ts",
      "tests/database/leased-jobs.test.ts",
      "tests/database/role-rls-matrix.test.ts",
    ];
    const predecessorReportPath = join(upgradeProject.workdir, "phase3-test-report.json");
    const predecessorResult = spawnSync(process.execPath, [
      join(ROOT, "node_modules/vitest/vitest.mjs"),
      "run",
      ...predecessorTestFiles,
      "--reporter=json",
      `--outputFile=${predecessorReportPath}`,
    ], {
      cwd: ROOT,
      env: { ...env, PHASE3_DATABASE_URL: upgradeUrl, PHASE3_REQUIRE_DATABASE: "1" },
      encoding: "utf8",
      timeout: 180_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let predecessorReport;
    try {
      predecessorReport = JSON.parse(readFileSync(predecessorReportPath, "utf8"));
    } catch {
      throw new Error("PORTFOLIO_SETTINGS_PHASE3_PREDECESSOR_REPORT_MISSING");
    }
    if (predecessorResult.error || predecessorResult.status !== 0) {
      const failedAssertions = predecessorReport.testResults?.flatMap((suite) => suite.assertionResults
        ?.filter((test) => test.status === "failed")
        .map((test) => [...(test.ancestorTitles ?? []), test.title].join(" > ")) ?? []) ?? [];
      throw new Error("PORTFOLIO_SETTINGS_PHASE3_PREDECESSOR_TESTS_FAILED:" + failedAssertions.join(" | "));
    }
    const predecessorTestCount = requirePredecessorTests(predecessorReport, predecessorTestFiles);
    console.log(`Phase 3 historical database invariants: ${predecessorTestCount} passed, 0 skipped before Phase 4 migrations.`);
    const phase3Rows = await seedAndCapturePhase3Operations(upgradeUrl);
    console.log("Captured the Phase 3 operations contract and seeded rows through restricted capability roles.");
    for (const file of phase4Files) {
      copyFileSync(join(ROOT, "supabase/migrations", file), join(upgradeProject.workdir, "supabase/migrations", file));
    }
    invokeProject(upgradeProject, ["migration", "up", "--local"], env);
    console.log("Applied Phase 4 migrations to the Phase 3 upgrade database.");
    const cleanSnapshot = await snapshotPhase4Database(cleanUrl);
    console.log("Captured the clean-install normalized database state.");
    const upgradeSnapshot = await snapshotPhase4Database(upgradeUrl);
    console.log("Captured the upgraded normalized database state.");
    assertPhase3OperationsRls(upgradeSnapshot);
    assertPhase3OperationsContractPreserved(phase3Snapshot, upgradeSnapshot);
    console.log("Verified Phase 3 operations grants, policies, and schema objects were preserved.");
    assertPhase4SnapshotsEquivalent(cleanSnapshot, upgradeSnapshot);
    console.log("Clean and upgraded normalized schemas, grants, constraints, and policies match.");
    if (JSON.stringify(cleanSnapshot.migrationLedger) !== JSON.stringify(
      migrations.files.map((file) => ({ version: file.slice(0, 14), name: file.slice(15, -4) })),
    )) throw new Error("PORTFOLIO_SETTINGS_MIGRATION_LEDGER_MISMATCH");
    invokeProject(cleanProject, ["migration", "up", "--local"], env);
    invokeProject(upgradeProject, ["migration", "up", "--local"], env);
    assertPhase4SnapshotsEquivalent(cleanSnapshot, await snapshotPhase4Database(cleanUrl));
    assertPhase4SnapshotsEquivalent(upgradeSnapshot, await snapshotPhase4Database(upgradeUrl));
    const preservedRows = await assertPhase3OperationsPreserved(upgradeUrl, phase3Rows);

    const databaseEnv = { ...env, PHASE4_SETTINGS_DATABASE_URL: cleanUrl };
    const generationArgs = [
      CODEGEN,
      "--dialect", "postgres",
      "--url", "env(PHASE4_SETTINGS_DATABASE_URL)",
      "--default-schema", "content,identity_access,operations,portfolio_config,taxonomy",
      "--include-pattern", "{content,identity_access,operations,portfolio_config,taxonomy}.*",
      "--date-parser", "timestamp",
      "--out-file", GENERATED,
      "--log-level", "error",
    ];
    if (!process.argv.includes("--refresh-types")) generationArgs.push("--verify");
    run(process.execPath, generationArgs, {
      env: databaseEnv,
      errorCode: process.argv.includes("--refresh-types")
        ? "PORTFOLIO_SETTINGS_TYPE_GENERATION_FAILED"
        : "PORTFOLIO_SETTINGS_TYPE_DRIFT",
    });
    console.log(process.argv.includes("--refresh-types")
      ? "Generated database types from the clean PostgreSQL schema."
      : "Generated database types match the clean PostgreSQL schema.");
    const testFiles = ticket122
      ? [
        "tests/database/owner-composition.integration.test.ts",
        "tests/runtime/owner-content-authoring.test.ts",
        "tests/runtime/owner-content-http.test.ts",
        "tests/runtime/owner-publication.test.ts",
        "tests/runtime/owner-project.test.ts",
        "tests/runtime/owner-project-status.test.ts",
        "tests/runtime/owner-taxonomy.test.ts",
        "tests/phase4/owner-request-security.test.ts",
        "tests/phase4/owner-operation-policy.test.ts",
        "tests/contracts/owner-contract.test.ts",
      ]
      : [contentAuthoringTicket
        ? "tests/database/content-authoring.integration.test.ts"
        : "tests/database/portfolio-settings.integration.test.ts"];
    const reportPath = join(cleanProject.workdir, contentAuthoringTicket ? "content-authoring-test-report.json" : "test-report.json");
    const result = spawnSync(process.execPath, [
      join(ROOT, "node_modules/vitest/vitest.mjs"),
      "run",
      ...testFiles,
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ], {
      cwd: ROOT,
      env: contentAuthoringTicket
        ? { ...databaseEnv, PHASE5_CONTENT_AUTHORING_DATABASE_URL: cleanUrl, PHASE5_REQUIRE_CONTENT_AUTHORING: "1", PHASE5_REQUIRE_OWNER_COMPOSITION: ticket122 ? "1" : "0" }
        : { ...databaseEnv, PHASE4_REQUIRE_SETTINGS: "1" },
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let report;
    try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch { throw new Error("PORTFOLIO_SETTINGS_TEST_REPORT_MISSING"); }
    if (result.error || result.status !== 0) {
      const failedAssertions = report.testResults?.flatMap((suite) => suite.assertionResults
        ?.filter((test) => test.status === "failed")
        .map((test) => `${[...(test.ancestorTitles ?? []), test.title].join(" > ")}: ${(test.failureMessages ?? []).join(" ")}`) ?? []) ?? [];
      const messages = failedAssertions.join("\n");
      const code = messages.match(/PORTFOLIO_SETTINGS_[A-Z_]+/)?.[0] ?? "assertion";
      const failedTests = report.testResults?.flatMap((suite) => suite.assertionResults
        ?.filter((test) => test.status === "failed")
        .map((test) => [...(test.ancestorTitles ?? []), test.title].join(" > ")) ?? []) ?? [];
      const safeDetail = messages
        .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[database connection redacted]")
        .replace(/password\s*[=:]\s*[^\s,;]+/gi, "password=[redacted]")
        .replace(/\s+/g, " ")
        .slice(0, 2_000);
      throw new Error(`PORTFOLIO_SETTINGS_TEST_FAILED:${code}:${failedTests.join(" | ")}:${safeDetail}`);
    }
    requireExecutedTests(report, testFiles.length);
    if (ticket122) {
      const databaseSuite = report.testResults.find((suite) =>
        relative(ROOT, suite.name).replaceAll("\\", "/") === "tests/database/owner-composition.integration.test.ts");
      if (databaseSuite === undefined) throw new Error("PORTFOLIO_SETTINGS_OWNER_COMPOSITION_DATABASE_SUITE_MISSING");
      const injectedSuites = report.testResults.filter((suite) => suite !== databaseSuite);
      const databasePassed = databaseSuite.assertionResults?.filter((test) => test.status === "passed").length ?? 0;
      const injectedPassed = injectedSuites.reduce((total, suite) =>
        total + (suite.assertionResults?.filter((test) => test.status === "passed").length ?? 0), 0);
      console.log(`Owner production PostgreSQL workflow: ${databasePassed} passed, 0 skipped.`);
      console.log(`Injected adapter and contract suites: ${injectedPassed} passed, 0 skipped.`);
      report.ownerCompositionDatabaseSuite = databaseSuite;
      report.ownerCompositionInjectedSuites = injectedSuites;
    } else {
      console.log((contentAuthoringTicket ? "Content authoring" : "Portfolio settings") +
        " real PostgreSQL integration: " + report.numPassedTests + " passed, 0 skipped.");
    }

    const evidence = contentAuthoringTicket ? {
      sourceRevision: run("git", ["rev-parse", "HEAD"]).trim(),
      ...(ticket122 ? {
        sourceTreeSha256: workingTreeSourceSha256(),
        runId: randomUUID(),
        toolVersions: {
          node: process.versions.node,
          npm: process.env.npm_config_user_agent?.split(" ").find((part) => part.startsWith("npm/"))?.slice(4) ?? "unknown",
          supabaseCli: supabasePackage.version,
          postgresServer: run("docker", ["version", "--format", "{{.Server.Version}}"]).trim(),
        },
      } : {}),
      ticket: ticket122 ? 122 : ticket121 ? 121 : ticket120 ? 120 : ticket119 ? 119 : ticket118 ? 118 : ticket117 ? 117 : ticket116 ? 116 : ticket115 ? 115 : ticket114 ? 114 : ticket113 ? 113 : ticket112 ? 112 : ticket111 ? 111 : ticket110 ? 110 : 109,
      parent: 106,
      scope: ticket122
        ? "runtime-assembled-phase5-owner-authoring-review-publication-route-status-relationships-taxonomy-and-security-adapters"
        : ticket121
          ? "bounded-locale-aware-public-discovery-stable-keyset-cursors-controlled-facets-publication-timestamp-order-and-authoritative-visibility"
        : ticket120
        ? "atomic-taxonomy-value-merge-with-content-owned-multi-project-assignment-history-deduplication-discovery-projection-idempotency-concurrency-and-rollback"
        : ticket119
        ? "taxonomy-value-rename-retirement-history-active-choice-locking-discovery-label-preservation-and-idempotent-rollback"
        : ticket118
        ? "four-stable-portfolio-taxonomy-roots-owner-value-creation-and-atomic-content-owned-project-assignments-with-synchronous-discovery-facts"
        : ticket117
        ? "symmetric-owner-curated-relationships-atomic-root-versions-locale-safe-public-reads-history-replay-and-rollback"
        : ticket116
        ? "owner-defined-project-status-registry-featured-commands-and-atomic-discovery-projection"
        : ticket115
        ? "candidate-slug-correction-durable-route-reservations-history-locale-safe-direct-redirects-and-atomic-replay"
        : ticket114
        ? "withdraw-archive-and-all-locale-restore-validation-with-atomic-projections-history-and-replay"
        : ticket113
        ? "testimonial-review-publication-history-safe-profile-project-projections-and-atomic-replay"
        : ticket112
        ? "achievement-publication-private-verification-and-chronological-timeline"
        : ticket111
        ? "reviewed-project-publication-routes-safe-projections-and-atomic-replay"
        : ticket110
        ? "exact-revision-review-private-preview-history-and-atomic-idempotent-audit"
        : "content-authoring-clean-upgrade-rls-immutability-concurrency-and-atomic-rollback",
      predecessorSnapshot: "supabase/baselines/phase3.json",
      migrationChecksums: migrations.checksums,
      migrationLedger: cleanSnapshot.migrationLedger,
      ...(ticket121 ? {
        ticketMigrationSafety: {
          introduced: ["supabase/migrations/20261009100000_index_project_discovery_reads.sql"],
          boundedLockTimeout: true,
          rollbackNote: true,
          rollbackForwardFix: "Both indexes are additive. Roll back application code; remove them in a later reviewed migration if database rollback is required.",
        },
        discoveryReadPlan: {
          explainAnalyzeCaptured: true,
          orderIndex: "taxonomy.project_discovery_locale_public_order",
          filterIndex: "taxonomy.project_discovery_value_public_filter",
          pageOutputBound: "limit plus one, at most 101 cards",
          queryShape: "Portfolio and exact locale predicates; publication and Published lifecycle joins; stable first_published_at and Project ID keyset",
          costAssertions: false,
        },
      } : {}),
      cleanUpgradeEquivalent: true,
      migrationReplayNoop: true,
      generatedTypeDrift: false,
      phase3OperationsRowsPreserved: {
        idempotencyRecords: preservedRows.idempotency.length === 1,
        outboxEvents: preservedRows.outbox.length === 1,
        jobs: preservedRows.jobs.length === 1,
      },
      authoringTablesWithForcedRls: ["content.items", "content.revisions", ...(ticket110 || ticket111 || ticket112 || ticket114 || ticket115 || ticket116 ? ["content.revision_reviews"] : []),
        ...(ticket111 || ticket112 || ticket114 || ticket115 || ticket121 ? ["content.language_publications", "content.publication_history"] : []),
        ...(ticket114 || ticket115 ? ["content.testimonial_language_publications", "content.testimonial_publication_history", "content.lifecycle_history"] : []),
        ...(ticket111 || ticket121 ? ["content.public_routes", "content.public_route_reservations", "content.public_project_locales", "taxonomy.project_discovery_locales"] : []),
        ...(ticket112 || ticket114 || ticket115 ? ["content.public_achievement_locales"] : []),
        ...(ticket114 || ticket115 ? ["content.public_routes", "content.public_route_reservations", "content.public_project_locales", "content.public_testimonial_locales", "taxonomy.project_discovery_locales"] : []),
        ...(ticket115 ? ["content.public_route_history"] : []),
        ...(ticket116 ? ["content.project_status_values", "content.project_status_value_history", "content.project_status_history", "taxonomy.project_discovery_locales"] : []),
        ...(ticket118 || ticket119 || ticket120 || ticket121 || ticket122 ? ["taxonomy.roots", "taxonomy.taxonomy_values", "taxonomy.value_history", "content.project_taxonomy_assignments", "content.project_taxonomy_assignment_history", "taxonomy.project_discovery_taxonomy_values"] : []),
        ...(ticket117 ? ["content.project_relationships", "content.project_relationship_views", "content.project_relationship_history"] : [])],
      databaseTestResults: ((ticket122 ? report.ownerCompositionDatabaseSuite : report.testResults[0]).assertionResults ?? []).map((test) => ({
        name: [...(test.ancestorTitles ?? []), test.title].join(" > "),
        status: test.status,
      })),
      databaseIntegrationTestsPassed: (ticket122 ? report.ownerCompositionDatabaseSuite : report.testResults[0]).assertionResults?.filter((test) => test.status === "passed").length ?? 0,
      ...(ticket122 ? {
        injectedAdapterAndContractTestSuites: report.ownerCompositionInjectedSuites.map((suite) => ({
          file: relative(ROOT, suite.name).replaceAll("\\", "/"),
          passed: suite.assertionResults?.filter((test) => test.status === "passed").length ?? 0,
          failed: suite.assertionResults?.filter((test) => test.status === "failed").length ?? 0,
          skipped: suite.assertionResults?.filter((test) => test.status === "pending" || test.status === "todo").length ?? 0,
        })),
        injectedAdapterAndContractTestsPassed: report.ownerCompositionInjectedSuites.reduce((total, suite) =>
          total + (suite.assertionResults?.filter((test) => test.status === "passed").length ?? 0), 0),
      } : {}),
      skippedCases: 0,
      isolatedLoopbackProjects: true,
      credentialsRecorded: false,
      secretValuesRecorded: false,
    } : {
      ticket: 88,
      parent: 77,
      scope: "phase4-migration-equivalence-restricted-principal-and-pooled-isolation",
      phase3Snapshot: "supabase/baselines/phase3.json",
      predecessorDatabaseTests: {
        context: "Phase 3 schema snapshot before Phase 4 migrations",
        testFiles: predecessorTestFiles,
        passed: predecessorTestCount,
        skipped: 0,
      },
      phase3MigrationFiles: migrations.phase3Files,
      migrationChecksums: migrations.checksums,
      migrationLedger: cleanSnapshot.migrationLedger,
      migrationSafety: {
        ticketIntroducedMigrations: [],
        phase4ExpansionSourceChecks: {
          boundedLockTimeout: "set lock_timeout = '5s'",
          rollbackNotes: true,
        },
        rollbackForwardFix: "No migration DDL is introduced by this ticket. Roll back the application release; correct migration defects with a later reviewed timestamped expansion migration.",
        remoteWrites: false,
      },
      cleanUpgradeEquivalent: true,
      migrationReplayNoop: true,
      normalizedCleanUpgradeDiff: [],
      normalizedStateSha256: createHash("sha256").update(JSON.stringify(cleanSnapshot)).digest("hex"),
      normalizedDatabaseState: {
        schemas: cleanSnapshot.schemas,
        roles: cleanSnapshot.roles,
        roleMemberships: cleanSnapshot.roleMemberships,
        objects: cleanSnapshot.objects,
        columns: cleanSnapshot.columns,
        constraints: cleanSnapshot.constraints,
        grants: cleanSnapshot.grants,
        defaultPrivileges: cleanSnapshot.defaultPrivileges,
        policies: cleanSnapshot.policies,
        indexes: cleanSnapshot.indexes,
        functions: cleanSnapshot.functions,
        triggers: cleanSnapshot.triggers,
        types: cleanSnapshot.types,
      },
      schemaCount: cleanSnapshot.schemas.length,
      constraintCount: cleanSnapshot.constraints.length,
      grantCount: cleanSnapshot.grants.length,
      policyCount: cleanSnapshot.policies.length,
      applicationTablesWithForcedRls: [
        "identity_access.owner_links", "portfolio_config.contact_channels", "portfolio_config.settings",
      ],
      phase3OperationsRowsPreserved: {
        idempotencyRecords: preservedRows.idempotency.length === 1,
        outboxEvents: preservedRows.outbox.length === 1,
        jobs: preservedRows.jobs.length === 1,
      },
      generatedTypeDrift: false,
      sanitizedAuditExamples: [
        {
          verifiedBy: "tests/database/portfolio-settings.integration.test.ts",
          eventType: "portfolio_configuration.channels_updated.v1",
          schemaVersion: 1,
          aggregateVersion: 2,
          payload: {
            channelCount: 6,
            channelTypes: ["email", "instagram", "linkedin", "other", "phone", "whatsapp"],
            ownerScope: "[redacted stable Owner digest]",
          },
          privateContactDestinationsIncluded: false,
        },
      ],
      databaseTestResults: report.testResults[0].assertionResults.map((test) => ({
        name: [...(test.ancestorTitles ?? []), test.title].join(" > "),
        status: test.status,
      })),
      restrictedPrincipalMatrix: [
        { principal: "shipwithali_application login", settings: "allow", ownerIdentityMap: "allow", bypassRls: false },
        { principal: "anon Visitor login", settings: "deny", ownerIdentityMap: "deny", bypassRls: false },
        { principal: "authenticated non-Owner login", settings: "deny", ownerIdentityMap: "deny", bypassRls: false },
        { principal: "shipwithali_worker login", settings: "deny", ownerIdentityMap: "deny", bypassRls: false },
        { principal: "PUBLIC", settings: "deny by grants and forced RLS", ownerIdentityMap: "deny by grants and forced RLS" },
        { principal: "application login scoped to a different Portfolio", settings: "existing second Portfolio hidden by forced RLS", ownerIdentityMap: "not probed" },
        { principal: "signed non-allowlisted Owner JWT with forged editable Owner and Portfolio claims", settings: "denied by verified identity boundary before command dispatch", ownerIdentityMap: "no database writes" },
      ],
      databaseIntegrationTestsPassed: report.numPassedTests,
      skippedCases: 0,
      isolatedLoopbackProjects: true,
      credentialsRecorded: false,
      secretValuesRecorded: false,
    };
    if (!Object.values(evidence.phase3OperationsRowsPreserved).every(Boolean)) {
      throw new Error("PORTFOLIO_SETTINGS_PHASE3_OPERATIONS_NOT_PRESERVED");
    }
    const serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`;
    if (
      /postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@|SUPABASE_(?:ACCESS_TOKEN|DB_PASSWORD|SERVICE_ROLE_KEY)\s*=\s*\S+|password\s*[=:]\s*[^\s,;]+/i.test(serializedEvidence)
    ) throw new Error("PORTFOLIO_SETTINGS_EVIDENCE_SANITIZATION_FAILED");
    const evidencePath = ticket122
      ? join(ROOT, "evidence/phase-5-owner-composition-postgres.json")
      : ticket121
        ? join(ROOT, "evidence/phase-5-project-discovery-postgres.json")
      : ticket120
      ? join(ROOT, "evidence/phase-5-taxonomy-merge-postgres.json")
      : ticket119
      ? join(ROOT, "evidence/phase-5-taxonomy-evolution-postgres.json")
      : ticket118
      ? join(ROOT, "evidence/phase-5-controlled-taxonomy-postgres.json")
      : ticket117
      ? join(ROOT, "evidence/phase-5-project-relationships-postgres.json")
      : ticket116
      ? join(ROOT, "evidence/phase-5-project-status-featured-postgres.json")
      : ticket115
      ? join(ROOT, "evidence/phase-5-project-routes.json")
      : ticket114
      ? join(ROOT, "evidence/phase-5-content-lifecycle.json")
      : ticket112
      ? join(ROOT, "evidence/phase-5-achievement-timeline-postgres.json")
      : ticket111
      ? join(ROOT, "evidence/phase-5-project-publication.json")
      : ticket110
      ? join(ROOT, "evidence/phase-5-content-revision-review.json")
      : ticket109
        ? join(ROOT, "evidence/phase-5-content-authoring.json")
      : evidenceOutputPath();
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, serializedEvidence, "utf8");
  } catch (error) {
    failure = error;
  } finally {
    let cleanupFailed = false;
    for (const project of [...projects].reverse()) {
      let projectCleanupFailed = false;
      if (project.attemptedStart) {
        try { invokeProject(project, ["stop", "--no-backup"], env); } catch { projectCleanupFailed = true; }
      }
      if (project.networkCreated) {
        const result = spawnSync("docker", ["network", "rm", project.network], {
          env, encoding: "utf8", timeout: 20_000, stdio: "ignore",
        });
        if (result.error || result.status !== 0) projectCleanupFailed = true;
      }
      const absoluteWorkdir = resolve(project.workdir);
      const tempRoot = resolve(tmpdir());
      if (!projectCleanupFailed && (absoluteWorkdir.startsWith(`${tempRoot}\\`) || absoluteWorkdir.startsWith(`${tempRoot}/`))) {
        rmSync(absoluteWorkdir, { recursive: true, force: true });
      }
      cleanupFailed ||= projectCleanupFailed;
    }
    if (cleanupFailed) failure = new Error("PORTFOLIO_SETTINGS_CLEANUP_FAILED: isolated database resources need recovery.");
  }

  if (failure) throw failure;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error && error.message.startsWith("PORTFOLIO_SETTINGS_")
      ? error.message
      : "PORTFOLIO_SETTINGS_RUNNER_FAILED: private diagnostics suppressed.");
    process.exitCode = 1;
  }
}
