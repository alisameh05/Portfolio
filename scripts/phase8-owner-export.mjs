import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { Client } from "pg";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

const root = process.cwd();
const runId = randomUUID();
const startedAt = new Date().toISOString();
const initialSource = workingTreeSourceSha256();
const scope = "Issue #241 Owner export PostgreSQL/Content acceptance plus Issue #243 standalone Media acceptance history, accepted original and variant byte integrity, and purpose-bound Worker RLS; restricted application and worker roles; disposable native PostgreSQL; independent offline package validation; PR CI exercises the production export adapter against real private Storage.";
const discoveredBin = process.platform === "win32" ? "C:/Program Files/PostgreSQL/18/bin" :
  spawnSync("pg_config", ["--bindir"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim();
const bin = process.env.PHASE8_OWNER_EXPORT_POSTGRES_BIN ?? discoveredBin ?? "";
const exe = name => bin ? join(bin, name + (process.platform === "win32" ? ".exe" : "")) : name;

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", windowsHide: true,
    ...(command === exe("pg_ctl") ? { stdio: "ignore" } : {}), timeout: 240_000 });
  if (result.error || result.status !== 0) {
    if (args[0]?.includes("vitest")) { if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr); }
    const detail = [result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n")
      .replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]").replace(/\r?\n/g, " | ").slice(-1_000);
    throw new Error(`PHASE8_OWNER_EXPORT_COMMAND_FAILED:${args[0] ?? command}:${result.status ?? "unavailable"}:${detail || "unavailable"}`);
  }
  return result.stdout;
}

const temp = join(tmpdir(), `portfolio-phase8-owner-export-${runId}`);
const data = join(temp, "data");
const reportPath = resolve("artifacts/phase8-owner-exports-vitest.json");
const roleReportPath = resolve("artifacts/phase8-owner-exports-rls-vitest.json");
const evidencePath = resolve("evidence/phase8-owner-exports-241.json");
const mediaEvidencePath = resolve("evidence/phase8-owner-export-media-243.json");
mkdirSync(temp, { recursive: true });
mkdirSync("artifacts", { recursive: true });
rmSync(reportPath, { force: true });
rmSync(roleReportPath, { force: true });
rmSync(evidencePath, { force: true });
rmSync(mediaEvidencePath, { force: true });
const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolvePort(value)); });
});
const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
const admin = new Client({ connectionString: adminUrl });
let started = false, connected = false, cleanup = false, stage = "runtime", result, criterionTests, assertionByTitle;
try {
  run(process.execPath, ["scripts/validation-environment.mjs"]);
  const postgresVersion = run(exe("postgres"), ["--version"]).trim();
  stage = "cluster";
  run(exe("initdb"), ["-D", data, "--no-locale", "-A", "trust", "-U", "postgres"]);
  started = true;
  // Unix-domain socket paths must stay under a 107-byte limit; connection URLs
  // below are TCP loopback, so the extended configuration removes the socket.
  appendFileSync(join(data, "postgresql.conf"), "unix_socket_directories = ''\n");
  run(exe("pg_ctl"), ["-D", data, "-l", join(temp, "server.log"), "-o", `-h 127.0.0.1 -p ${port} -F`, "-w", "start"]);
  await admin.connect(); connected = true;
  stage = "migrations";
  await admin.query("create role anon nologin; create role authenticated nologin; create role shipwithali_migration nologin nosuperuser nobypassrls; grant create on database postgres to shipwithali_migration");
  const migrations = readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort();
  for (const name of migrations) { stage = `migration:${name}`; await admin.query(readFileSync(join("supabase/migrations", name), "utf8")); }
  // The application path reserves requests and jobs. The worker path reads
  // Content only under the exact content.owner-export purpose and transitions
  // exports through separate restricted connections.
  await admin.query("create role owner_export_application_runtime login nosuperuser nobypassrls; grant shipwithali_application to owner_export_application_runtime");
  await admin.query("create role owner_export_worker_runtime login nosuperuser nobypassrls; grant shipwithali_worker to owner_export_worker_runtime");
  const applicationUrl = `postgres://owner_export_application_runtime@127.0.0.1:${port}/postgres?sslmode=disable`;
  const workerUrl = `postgres://owner_export_worker_runtime@127.0.0.1:${port}/postgres?sslmode=disable`;
  const env = { ...process.env,
    PHASE8_OWNER_EXPORT_APPLICATION_URL: applicationUrl,
    PHASE8_OWNER_EXPORT_WORKER_URL: workerUrl,
    PHASE8_OWNER_EXPORT_ADMIN_URL: `${adminUrl}?sslmode=disable`,
    PHASE3_DATABASE_URL: `${adminUrl}?sslmode=disable`, PHASE3_REQUIRE_DATABASE: "1" };
  const testedSource = workingTreeSourceSha256();
  if (testedSource !== initialSource) throw new Error("PHASE8_OWNER_EXPORT_SOURCE_CHANGED_BEFORE_ACCEPTANCE");
  stage = "acceptance";
  const acceptanceFiles = ["tests/phase8/owner-export-requests.test.ts", "tests/phase8/owner-export-adapter.test.ts",
    "tests/phase8/owner-export-postgres.test.ts", "tests/phase8/owner-export-assembly.test.ts", "tests/phase8/owner-export-content.test.ts", "tests/phase8/owner-export-content-postgres.test.ts",
    "tests/phase8/owner-export-media-package.test.ts", "tests/runtime/supabase-media-export-storage.test.ts"];
    const expectedTests = 67;
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...acceptanceFiles,
    "--no-file-parallelism", "--reporter=json", `--outputFile=${reportPath}`], env);
  const tests = JSON.parse(readFileSync(reportPath, "utf8"));
  const assertions = tests.testResults.flatMap(suite => suite.assertionResults ?? []);
  if (!tests.success || tests.numFailedTestSuites !== 0 || tests.numFailedTests !== 0 || tests.numPendingTests !== 0 || tests.numTodoTests !== 0 ||
      tests.numPassedTests !== expectedTests || assertions.length !== expectedTests || tests.testResults.length !== acceptanceFiles.length ||
      tests.testResults.some(suite => suite.status !== "passed") || assertions.some(assertion => assertion.status !== "passed")) {
    throw new Error("PHASE8_OWNER_EXPORT_ACCEPTANCE_INCOMPLETE");
  }
  stage = "role-rls-acceptance";
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/database/role-rls-matrix.test.ts",
    "--no-file-parallelism", "--reporter=json", `--outputFile=${roleReportPath}`], env);
  const roleMatrix = JSON.parse(readFileSync(roleReportPath, "utf8"));
  if (!roleMatrix.success || roleMatrix.numFailedTestSuites !== 0 || roleMatrix.numFailedTests !== 0 ||
      roleMatrix.numPendingTests !== 0 || roleMatrix.numTodoTests !== 0 || roleMatrix.numPassedTests === 0 ||
      roleMatrix.testResults.length !== 1 || roleMatrix.testResults.some(suite => suite.status !== "passed")) {
    throw new Error("PHASE8_OWNER_EXPORT_RLS_ACCEPTANCE_INCOMPLETE");
  }
  if (workingTreeSourceSha256() !== testedSource) throw new Error("PHASE8_OWNER_EXPORT_SOURCE_CHANGED_DURING_ACCEPTANCE");
    const mediaSourceFiles = ["tests/phase8/owner-export-postgres.test.ts", "tests/phase8/owner-export-content-postgres.test.ts",
      "tests/phase8/owner-export-requests.test.ts",
    "tests/phase8/owner-export-media-package.test.ts", "tests/runtime/supabase-media-export-storage.test.ts"];
  const mediaSuites = tests.testResults.filter(suite => mediaSourceFiles.some(file => suite.name.replace(/\\/g, "/").endsWith(file)));
  const mediaAssertions = mediaSuites.flatMap(suite => suite.assertionResults ?? []);
  if (mediaAssertions.length === 0 || mediaAssertions.some(assertion => assertion.status !== "passed")) {
    throw new Error("PHASE8_OWNER_EXPORT_MEDIA_ASSERTIONS_INVALID");
  }
    criterionTests = [
      { criterion: "AC01", tests: ["#243 AC01/04/08: reads accepted Media history under its purpose-bound worker role and excludes private fields", "AC01–AC08 captures all retained facts, races consistently, and validates independent content-only and combined packages"] },
      { criterion: "AC02", tests: ["#243 AC01/04/08: reads accepted Media history under its purpose-bound worker role and excludes private fields", "#243: readies Media export after reloading its persisted snapshot and candidate through PostgreSQL", "packages accepted bytes, deduplicates shared digests, and passes the independent validator", "streams the exact upload-intent-scoped original from the private candidate bucket"] },
      { criterion: "AC03", tests: ["#243: readies Media export after reloading its persisted snapshot and candidate through PostgreSQL", "accepts every nonempty non-Media subset and standalone Media in canonical order", "packages accepted bytes, deduplicates shared digests, and passes the independent validator"] },
      { criterion: "AC04", tests: ["#243 AC01/04/08: reads accepted Media history under its purpose-bound worker role and excludes private fields", "records rejected bytes as excluded without reading or declaring any object"] },
      { criterion: "AC05", tests: ["#243: readies Media export after reloading its persisted snapshot and candidate through PostgreSQL", "fails closed for missing required accepted bytes", "fails closed for same-length replacement required accepted bytes", "rejects missing, redirected, changed, and wrong-length objects", "AC03/04/05: retries capture, lost upload, and verification faults without publishing partial readiness"] },
      { criterion: "AC06", tests: ["#243 AC01/04/08: reads accepted Media history under its purpose-bound worker role and excludes private fields", "AC01–AC08 captures all retained facts, races consistently, and validates independent content-only and combined packages"] },
      { criterion: "AC07", tests: ["rejects an accepted object above the 50 MiB per-object bound before opening Storage", "rejects packages whose unique assets exceed the validator's 512-member limit", "AC03/04/05: retries capture, lost upload, and verification faults without publishing partial readiness", "streams the exact upload-intent-scoped original from the private candidate bucket"] },
      { criterion: "AC08", tests: ["#243 AC01/04/08: reads accepted Media history under its purpose-bound worker role and excludes private fields", "packages accepted bytes, deduplicates shared digests, and passes the independent validator"] },
    ];
    const allAssertions = tests.testResults.flatMap(suite => suite.assertionResults ?? []);
    assertionByTitle = new Map(allAssertions.map(assertion => [assertion.title, assertion.status]));
    for (const criterion of criterionTests) {
      if (criterion.tests.some(title => assertionByTitle.get(title) !== "passed")) {
        throw new Error(`PHASE8_OWNER_EXPORT_MEDIA_CRITERION_EVIDENCE_MISSING:${criterion.criterion}`);
      }
    }
  result = {
    ticket: 241, runId, startedAt, sourceRevision: run("git", ["rev-parse", "HEAD"]).trim(), sourceTreeSha256: testedSource, postgresVersion,
    migrations: migrations.map(name => ({ name, sha256: createHash("sha256").update(readFileSync(join("supabase/migrations", name))).digest("hex") })),
    tools: { node: process.versions.node, npm: (process.env.npm_config_user_agent ?? "").match(/npm\/([^\s]+)/)?.[1] ?? "unavailable" },
    required: { success: tests.success, passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests,
      todo: tests.numTodoTests, failedSuites: tests.numFailedTestSuites },
    roleMatrix: { success: roleMatrix.success, passed: roleMatrix.numPassedTests,
      failed: roleMatrix.numFailedTests, skipped: roleMatrix.numPendingTests, todo: roleMatrix.numTodoTests },
    assertions: assertions.map(assertion => ({ title: assertion.title, status: assertion.status })),
    mediaAcceptance: {
      suites: mediaSuites.map(suite => suite.name.replace(root, "").replace(/\\/g, "/").replace(/^\//, "")),
      passed: mediaAssertions.length,
      assertions: mediaAssertions.map(assertion => ({ title: assertion.title, status: assertion.status })),
    },
    databaseRoles: ["owner_export_application_runtime", "shipwithali_application", "owner_export_worker_runtime",
      "shipwithali_worker", "anon", "authenticated"],
    criteria: ["AC01", "AC02", "AC03", "AC04", "AC05", "AC06", "AC07", "AC08"],
    reproduction: "npm run setup:validation; npm run validation:ready; npm run phase8:focus:exports",
    scope,
  };
  console.log(JSON.stringify({ required: result.required, roleMatrix: result.roleMatrix, runId, sourceTreeSha256: testedSource }));
} catch (error) {
  console.error(error instanceof Error && /^PHASE8_OWNER_EXPORT_/.test(error.message) ? error.message : "PHASE8_OWNER_EXPORT_VALIDATION_FAILED");
  console.error(JSON.stringify({ stage, code: typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : "unavailable" }));
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    for (const suite of report.testResults ?? []) console.error(JSON.stringify({ suite: suite.name.replace(root, ""), status: suite.status,
      assertions: (suite.assertionResults ?? []).map(assertion => ({ title: assertion.title, status: assertion.status })) }));
  } catch { /* no test report exists */ }
  try {
    const report = JSON.parse(readFileSync(roleReportPath, "utf8"));
    for (const suite of report.testResults ?? []) {
      const failed = (suite.assertionResults ?? []).filter(assertion => assertion.status !== "passed");
      if (suite.status !== "passed" || failed.length > 0) {
        console.error(JSON.stringify({ suite: suite.name.replace(root, ""), status: suite.status,
          assertions: failed.map(assertion => ({ title: assertion.title, status: assertion.status,
            failureMessages: assertion.failureMessages?.map(message => String(message)
              .replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]").replace(/\r?\n/g, " | ").slice(-1_000)) })) }));
      }
    }
  } catch { /* no role matrix report is available */ }
  process.exitCode = 1;
} finally {
  if (connected) await admin.end();
  try { if (started) run(exe("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]); rmSync(temp, { recursive: true, force: true }); cleanup = true; }
  catch { console.error("PHASE8_OWNER_EXPORT_CLEANUP_FAILED"); process.exitCode = 1; }
  if (result && cleanup) {
    mkdirSync("evidence", { recursive: true });
    result.completedAt = new Date().toISOString();
    writeFileSync(evidencePath, `${JSON.stringify({ ...result, cleanup }, null, 2)}\n`);
    const mediaEvidence = {
      schemaVersion: 1, ticket: 243, runId, startedAt, completedAt: result.completedAt,
      sourceRevision: result.sourceRevision, sourceTreeSha256: result.sourceTreeSha256, postgresVersion: result.postgresVersion,
      migrations: result.migrations, tools: result.tools,
      required: { success: true, passed: result.mediaAcceptance.passed, failed: 0, skipped: 0, todo: 0, failedSuites: 0 },
      roleMatrix: result.roleMatrix,
      assertions: result.mediaAcceptance.assertions,
      suites: result.mediaAcceptance.suites,
      criteria: ["AC01", "AC02", "AC03", "AC04", "AC05", "AC06", "AC07", "AC08"],
      criterionEvidence: criterionTests.map(criterion => ({ criterion: criterion.criterion,
        executedTests: criterion.tests.map(title => ({ title, status: assertionByTitle.get(title) })) })),
      hostedEvidence: [{ check: "Phase 6 real Media PostgreSQL and private Storage integration, including #243 original/variant export reads and anonymous denials",
        status: "required-in-pr-ci" }],
      reproduction: "npm run setup:validation; npm run validation:ready; npm run phase8:focus:exports",
      scope: "Media-only acceptance history and current Content locale use; accepted original and variant bytes with digest verification; content-addressed deduplication; missing and same-length changed-byte failure; rejected-byte exclusion; independent offline validation; purpose-bound Worker RLS and private-column/write denials. Hosted Phase 6 CI verifies the production Storage adapter against real private Supabase Storage and anonymous denials.",
      cleanup,
    };
    writeFileSync(mediaEvidencePath, `${JSON.stringify(mediaEvidence, null, 2)}\n`);
    console.log(JSON.stringify({ evidence: mediaEvidencePath, assertions: mediaEvidence.required.passed, cleanup }));
    console.log(JSON.stringify({ evidence: evidencePath, cleanup }));
  }
}
