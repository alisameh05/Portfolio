import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createServer } from "node:net";
import { Client } from "pg";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";
import { safeAssertionDiagnostic } from "./validation-errors.mjs";
import { observeRuntime, verifyEnvironment } from "./validation-environment.mjs";

const root = process.cwd();
const runId = randomUUID();
const startedAt = new Date().toISOString();
const initialSourceTree = workingTreeSourceSha256();
const reportPath = resolve("artifacts/phase8-owner-export-reference-import-250-tests.json");
const evidencePath = resolve("evidence/phase8-owner-export-reference-import-250.json");
const temp = join(tmpdir(), `portfolio-phase8-reference-import-${runId}`);
const data = join(temp, "data");
const runOutputPath = join(temp, "vitest.json");
const serverLog = join(temp, "server.log");
const storageUrl = process.env.PHASE8_OWNER_EXPORT_STORAGE_URL;
const storageKey = process.env.PHASE8_OWNER_EXPORT_STORAGE_KEY;
const acceptanceFiles = [
  "tests/phase8/owner-export-reference-import.test.ts",
  "tests/phase8/owner-export-reference-import-postgres.test.ts",
  "tests/phase8/owner-export-package.test.ts",
  "tests/phase8/owner-export-content-postgres.test.ts",
  "tests/phase8/owner-export-taxonomy-postgres.test.ts",
  "tests/phase8/owner-export-cv-postgres.test.ts",
  "tests/phase8/owner-export-moderation-postgres.test.ts",
  "tests/phase8/owner-export-analytics-postgres.test.ts",
];

const detectedBin = process.platform === "win32" ? "C:/Program Files/PostgreSQL/18/bin" :
  spawnSync("pg_config", ["--bindir"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim();
const bin = process.env.PHASE8_OWNER_EXPORT_POSTGRES_BIN ?? detectedBin ?? "";
const exe = (name) => bin ? join(bin, `${name}${process.platform === "win32" ? ".exe" : ""}`) : name;
let admin;
let started = false;
let connected = false;
let cleanup = false;
let stage = "runtime";

function run(command, args, environment = process.env, allowFailure = false) {
  const result = spawnSync(command, args, { cwd: root, env: environment, encoding: "utf8", windowsHide: true,
    ...(command === exe("pg_ctl") ? { stdio: "ignore" } : {}), timeout: args.some((argument) => argument.includes("vitest")) ? 480_000 : 240_000 });
  if ((result.error || result.status !== 0) && !allowFailure) {
    const detail = [result.stderr, result.stdout, result.error?.message].filter(Boolean).join(" ")
      .replace(/postgres(?:ql)?:\/\/\S+/giu, "[database-url]").replace(/\s+/gu, " ").slice(-700);
    throw new Error(`REFERENCE_IMPORT_COMMAND_FAILED:${args[0] ?? command}:${result.status ?? "unavailable"}:${detail || "unavailable"}`);
  }
  return allowFailure ? { stdout: result.stdout, stderr: result.stderr, status: result.status, error: result.error?.message } : result.stdout;
}

async function freeLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") { server.close(); reject(new Error("REFERENCE_IMPORT_PORT_INVALID")); return; }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}

function collectTests(report) {
  const suites = (report.testResults ?? []).map((suite) => {
    const assertions = suite.assertionResults ?? [];
    const tests = assertions.map((assertion) => {
      const diagnostic = safeAssertionDiagnostic(assertion);
      const failureCode = assertion.status === "failed" ? assertion.failureMessages?.join(" ").match(/\bREFERENCE_IMPORT_[A-Z0-9_]+\b/u)?.[0] : undefined;
      return { title: assertion.fullName || assertion.title, status: assertion.status,
        ...(assertion.status === "failed" ? { diagnostic: { ...diagnostic, ...(failureCode ? { failureCode } : {}) } } : {}) };
    });
    return {
      file: suite.name.replace(`${root}${sep}`, "").replace(/\\/gu, "/"),
      status: suite.status,
      passed: assertions.filter((assertion) => assertion.status === "passed").length,
      failed: assertions.filter((assertion) => assertion.status === "failed").length,
      skipped: assertions.filter((assertion) => assertion.status === "pending" || assertion.status === "skipped" || assertion.status === "todo").length,
      tests,
    };
  });
  const totals = suites.reduce((sum, suite) => ({ passed: sum.passed + suite.passed, failed: sum.failed + suite.failed,
    skipped: sum.skipped + suite.skipped }), { passed: 0, failed: 0, skipped: 0 });
  return { suites, totals };
}

function assertNoSkippedTests(report, collected) {
  if (report.success !== true || report.numFailedTestSuites !== 0 || report.numFailedTests !== 0 ||
      report.numPendingTests !== 0 || report.numTodoTests !== 0 || report.numPassedTests === 0 ||
      report.testResults?.length !== acceptanceFiles.length || collected.suites.length !== acceptanceFiles.length ||
      collected.suites.some((suite) => suite.status !== "passed" || suite.passed === 0 || suite.skipped !== 0) ||
      collected.totals.failed !== 0 || collected.totals.skipped !== 0) {
    throw new Error("REFERENCE_IMPORT_ACCEPTANCE_INCOMPLETE");
  }
}

const migrationIdentity = () => readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort().map((name) => ({
  name,
  sha256: createHash("sha256").update(readFileSync(join("supabase/migrations", name))).digest("hex"),
}));

let result;
try {
  if (!storageUrl || !storageKey) throw new Error("REFERENCE_IMPORT_PRIVATE_STORAGE_REQUIRED");
  const envIssues = verifyEnvironment(root, observeRuntime());
  if (envIssues.length > 0) throw new Error(`REFERENCE_IMPORT_ENVIRONMENT_INVALID:${envIssues.join(",")}`);
  run(process.execPath, ["scripts/validation-environment.mjs"]);
  mkdirSync(temp, { recursive: true });
  mkdirSync(dirname(reportPath), { recursive: true });
  mkdirSync(dirname(evidencePath), { recursive: true });
  rmSync(reportPath, { force: true });

  const port = await freeLoopbackPort();
  const databaseUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
  admin = new Client({ connectionString: databaseUrl });
  stage = "cluster";
  run(exe("initdb"), ["-D", data, "--no-locale", "-A", "trust", "-U", "postgres"]);
  started = true;
  appendFileSync(join(data, "postgresql.conf"), "unix_socket_directories = ''\n");
  run(exe("pg_ctl"), ["-D", data, "-l", serverLog, "-o", `-h 127.0.0.1 -p ${port} -F`, "-w", "start"]);
  await admin.connect();
  connected = true;
  stage = "migrations";
  await admin.query("create role anon nologin; create role authenticated nologin; create role shipwithali_migration nologin nosuperuser nobypassrls; grant create on database postgres to shipwithali_migration");
  const migrationNames = readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql")).sort();
  for (const name of migrationNames) { stage = `migration:${name}`; await admin.query(readFileSync(join("supabase/migrations", name), "utf8")); }
  await admin.query("create role owner_export_application_runtime login nosuperuser nobypassrls; grant shipwithali_application to owner_export_application_runtime");
  await admin.query("create role owner_export_worker_runtime login nosuperuser nobypassrls; grant shipwithali_worker to owner_export_worker_runtime");
  const base = `postgres://owner_export_application_runtime@127.0.0.1:${port}/postgres?sslmode=disable`;
  const worker = `postgres://owner_export_worker_runtime@127.0.0.1:${port}/postgres?sslmode=disable`;
  const env = { ...process.env,
    PHASE8_OWNER_EXPORT_APPLICATION_URL: base,
    PHASE8_OWNER_EXPORT_WORKER_URL: worker,
    PHASE8_OWNER_EXPORT_ADMIN_URL: `${databaseUrl}?sslmode=disable`,
    PHASE3_DATABASE_URL: `${databaseUrl}?sslmode=disable`, PHASE3_REQUIRE_DATABASE: "1",
    PHASE8_OWNER_EXPORT_STORAGE_URL: storageUrl, PHASE8_OWNER_EXPORT_STORAGE_KEY: storageKey,
    PHASE8_OWNER_EXPORT_STORAGE_PORT: new URL(storageUrl).port,
  };
  const testedTree = workingTreeSourceSha256();
  if (testedTree !== initialSourceTree) throw new Error("REFERENCE_IMPORT_SOURCE_CHANGED_BEFORE_ACCEPTANCE");
  stage = "acceptance";
  const vitestRun = run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...acceptanceFiles,
    "--no-file-parallelism", "--reporter=default", "--reporter=json", `--outputFile=${runOutputPath}`], env, true);
  const vitest = JSON.parse(readFileSync(runOutputPath, "utf8"));
  const testEvidence = collectTests(vitest);
  if (vitestRun.status !== 0 || vitest.success !== true || vitest.numFailedTests !== 0 || vitest.numPendingTests !== 0 || vitest.numTodoTests !== 0) {
    console.error(JSON.stringify({ stage: "acceptance-summary", status: vitestRun.status, totals: testEvidence.totals,
      failedSuites: testEvidence.suites.filter((suite) => suite.failed > 0 || suite.status !== "passed")
        .map((suite) => {
          const detail = vitest.testResults.find((candidate) => candidate.name.endsWith(suite.file));
          return { file: suite.file, status: suite.status, tests: suite.tests.filter((test) => test.status === "failed"),
            diagnostic: safeAssertionDiagnostic({ failureMessages: [detail?.message ?? detail?.failureMessage ?? ""] }) };
        }),
      skippedSuites: testEvidence.suites.filter((suite) => suite.skipped > 0)
        .map((suite) => ({ file: suite.file, tests: suite.tests.filter((test) => test.status === "pending" || test.status === "skipped" || test.status === "todo") })) }));
  }
  assertNoSkippedTests(vitest, testEvidence);
  if (workingTreeSourceSha256() !== testedTree) throw new Error("REFERENCE_IMPORT_SOURCE_CHANGED_DURING_ACCEPTANCE");

  const fixture = JSON.parse(readFileSync("artifacts/phase8-owner-export-reference-import-250-run.json", "utf8"));
  result = {
    schemaVersion: 1,
    ticket: 250,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    source: { revision: run("git", ["rev-parse", "HEAD"]).trim(), branch: run("git", ["branch", "--show-current"]).trim(), workingTreeSha256: testedTree },
    tools: { node: process.version, npm: process.env.npm_config_user_agent?.match(/^npm\/([^ ]+)/u)?.[1] ?? "validated by validation:ready",
      postgres: run(exe("postgres"), ["--version"]).trim(),
      supabaseCli: run(process.execPath, ["node_modules/supabase/dist/supabase.js", "--version"]).trim() },
    services: { postgres: "fresh disposable local cluster with restricted application and worker roles",
      objectStorage: "fresh private local Supabase Storage project; loopback only", accessMode: "test-only isolated fixture" },
    migrations: migrationIdentity(),
    acceptance: { command: "npm run phase8:focus:reference-import", suiteCount: testEvidence.suites.length,
      passed: testEvidence.totals.passed, failed: testEvidence.totals.failed, skipped: testEvidence.totals.skipped,
      suites: testEvidence.suites },
    fixture: fixture.fixture,
    expectedFacts: fixture.expectedFacts,
    measurements: fixture.metrics,
    cleanup: { postgresClusterStopped: false, postgresTempDirectoryRemoved: false, localStorageProjectStopped: "owned by outer runner",
      importedSchemasAndObjects: fixture.cleanup },
    criteria: [
      { criterion: "AC01", evidence: ["actual request -> ready assembly -> private Storage download -> offline validation -> reference import in tests/phase8/owner-export-reference-import-postgres.test.ts"] },
      { criterion: "AC02", evidence: ["localized publication pointers, lifecycle/status/Featured, route identity and taxonomy history assertions in the full import test"] },
      { criterion: "AC03", evidence: ["accepted/rejected Media identities, Current and previous CV pointers, and exact private object-byte digest/length assertions in the full import test"] },
      { criterion: "AC04", evidence: ["retained/minimal Feedback decisions, suppressed Analytics reports and private marker/raw Visitor exclusions in the full import test"] },
      { criterion: "AC05", evidence: ["all seven single scopes, empty Content, and four partial combinations imported and compared with declared records/dependencies"] },
      { criterion: "AC06", evidence: ["supported v1.0 and additive v1.2 fixtures plus corrupt, hostile and major-version rejection before writes in tests/phase8/owner-export-reference-import.test.ts"] },
      { criterion: "AC07", evidence: ["blocked object reads/writes plus five real PostgreSQL capture-race suites: Content, Taxonomy, CV, Moderation, Analytics"] },
      { criterion: "AC08", evidence: ["reference importer has no notifications or Visitor writer; import schema/object counts and outbox counts are asserted; only local disposable services are used"] },
      { criterion: "AC09", evidence: ["fixture counts, ZIP/imported asset lengths, per-stage elapsed time and cleanup are in measurements and fixture"] },
    ],
    cleanupComplete: false,
  };
} catch (error) {
  console.error(error instanceof Error && /^REFERENCE_IMPORT_/.test(error.message) ? error.message : "REFERENCE_IMPORT_ACCEPTANCE_FAILED");
  console.error(JSON.stringify({ stage }));
  process.exitCode = 1;
} finally {
  if (connected) await admin.end();
  try {
    if (started) run(exe("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
    const tempRoot = resolve(tmpdir());
    const absoluteTemp = resolve(temp);
    if (!absoluteTemp.startsWith(`${tempRoot}${sep}`)) {
      console.error("REFERENCE_IMPORT_TEMP_PATH_INVALID");
      process.exitCode = 1;
    } else {
      rmSync(temp, { recursive: true, force: true });
      cleanup = true;
    }
  } catch {
    console.error("REFERENCE_IMPORT_POSTGRES_CLEANUP_FAILED");
    process.exitCode = 1;
  }
  if (result !== undefined) {
    result.completedAt = new Date().toISOString();
    result.cleanup.postgresClusterStopped = cleanup;
    result.cleanup.postgresTempDirectoryRemoved = cleanup;
    result.cleanupComplete = cleanup && result.cleanup.importedSchemasAndObjects === true;
    writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
    if (!result.cleanupComplete) process.exitCode = 1;
    console.log(JSON.stringify({ evidence: evidencePath, passed: result.acceptance.passed, skipped: result.acceptance.skipped,
      cleanupComplete: result.cleanupComplete }));
  }
}
