import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { Client } from "pg";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";
import { safeAssertionDiagnostic } from "./validation-errors.mjs";

if (process.argv.includes("--with-storage")) {
  await import("./phase8-owner-export-storage.mjs");
  process.exit(process.exitCode ?? 0);
}

const root = process.cwd();
const runId = randomUUID();
const startedAt = new Date().toISOString();
const initialSource = workingTreeSourceSha256();
const scope = "Issue #241 Owner export PostgreSQL/Content acceptance plus Issue #243 standalone Media acceptance history, Issue #244 retained CV versions and exact accepted PDF bytes, Issue #245 privacy-safe Feedback snapshots, and Issue #247 expiry/revocation, resumable artifact deletion and all-scope package reconciliation; restricted application and worker roles; disposable native PostgreSQL; independent offline package validation; PR CI exercises production Storage against an isolated private service.";
const discoveredBin = process.platform === "win32" ? "C:/Program Files/PostgreSQL/18/bin" :
  spawnSync("pg_config", ["--bindir"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim();
const bin = process.env.PHASE8_OWNER_EXPORT_POSTGRES_BIN ?? discoveredBin ?? "";
const exe = name => bin ? join(bin, name + (process.platform === "win32" ? ".exe" : "")) : name;

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", windowsHide: true,
    ...(command === exe("pg_ctl") ? { stdio: "ignore" } : {}), timeout: 240_000 });
  if (result.error || result.status !== 0) {
    const isVitestRun = args[0]?.includes("vitest.mjs") ?? false;
    if (isVitestRun) {
      const failureMessages = [result.stderr, result.stdout]
        .filter(value => typeof value === "string" && value.trim().length > 0);
      const failureText = failureMessages.slice(0, 3).map(message => message.slice(0, 16_384)).join("\n");
      const lifecycleFailure = failureText.match(/PHASE8_CV_EXPORT_POSTGRES_([A-Z0-9_]+)_FAILED:([A-Z0-9]{5}|unknown)/);
      console.error(JSON.stringify({
        category: lifecycleFailure ? "postgres-lifecycle" : "vitest-process",
        ...(lifecycleFailure ? { stage: lifecycleFailure[1], sqlState: lifecycleFailure[2] } : {}),
        diagnostic: safeAssertionDiagnostic({ failureMessages }),
      }));
    }
    const detail = isVitestRun ? "vitest-failed" :
      [result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n")
        .replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]").replace(/\r?\n/g, " | ").slice(-1_000);
    throw new Error(`PHASE8_OWNER_EXPORT_COMMAND_FAILED:${args[0] ?? command}:${result.status ?? "unavailable"}:${detail || "unavailable"}`);
  }
  return result.stdout;
}

function safeVitestSuiteFailure(suite, failedAssertions) {
  const failureMessages = [suite.message, suite.failureMessages, suite.errorMessage]
    .flatMap(value => Array.isArray(value) ? value : [value])
    .filter(value => typeof value === "string" && value.trim().length > 0);
  const failureText = failureMessages.slice(0, 3).map(message => message.slice(0, 16_384)).join("\n");
  const lifecycleFailure = failureText.match(/PHASE8_CV_EXPORT_POSTGRES_([A-Z0-9_]+)_FAILED:([A-Z0-9]{5}|unknown)/);
  return {
    suite: suite.name.replace(root, ""),
    status: suite.status,
    category: lifecycleFailure ? "postgres-lifecycle" : failedAssertions.length > 0 ? "assertion" : "suite",
    ...(lifecycleFailure ? { stage: lifecycleFailure[1], sqlState: lifecycleFailure[2] } : {}),
    assertions: failedAssertions.map(safeAssertionDiagnostic),
  };
}

const temp = join(tmpdir(), `portfolio-phase8-owner-export-${runId}`);
const data = join(temp, "data");
const reportPath = resolve("artifacts/phase8-owner-exports-vitest.json");
const roleReportPath = resolve("artifacts/phase8-owner-exports-rls-vitest.json");
const regressionReportPath = resolve("artifacts/phase8-owner-export-cv-regressions-vitest.json");
const evidencePath = resolve("evidence/phase8-owner-exports-241.json");
const mediaEvidencePath = resolve("evidence/phase8-owner-export-media-243.json");
const cvEvidencePath = resolve("evidence/phase8-owner-export-cv-244.json");
const moderationEvidencePath = resolve("evidence/phase8-owner-export-moderation-245.json");
const reconciliationEvidencePath = resolve("evidence/phase8-owner-export-reconciliation-247.json");
mkdirSync(temp, { recursive: true });
mkdirSync("artifacts", { recursive: true });
rmSync(reportPath, { force: true });
rmSync(roleReportPath, { force: true });
rmSync(regressionReportPath, { force: true });
rmSync(evidencePath, { force: true });
rmSync(mediaEvidencePath, { force: true });
rmSync(cvEvidencePath, { force: true });
rmSync(moderationEvidencePath, { force: true });
rmSync(reconciliationEvidencePath, { force: true });
const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolvePort(value)); });
});
const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
const admin = new Client({ connectionString: adminUrl });
let started = false, connected = false, cleanup = false, stage = "runtime", result, criterionTests, cvCriterionTests, moderationCriterionTests, reconciliationCriterionTests, assertionByTitle, regressionAssertions;
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
    "tests/phase8/owner-export-media-package.test.ts", "tests/runtime/supabase-media-export-storage.test.ts",
    "tests/phase8/owner-export-cv-package.test.ts", "tests/phase8/owner-export-cv-postgres.test.ts",
    "tests/phase8/owner-export-moderation.test.ts", "tests/phase8/owner-export-moderation-postgres.test.ts",
    "tests/phase8/owner-export-reconciliation.test.ts", "tests/phase8/owner-export-migration-postgres.test.ts"];
  const expectedTests = 113;
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...acceptanceFiles,
    "--no-file-parallelism", "--reporter=default", "--reporter=json", `--outputFile=${reportPath}`], env);
  const tests = JSON.parse(readFileSync(reportPath, "utf8"));
  const assertions = tests.testResults.flatMap(suite => suite.assertionResults ?? []);
  if (!tests.success || tests.numFailedTestSuites !== 0 || tests.numFailedTests !== 0 || tests.numPendingTests !== 0 || tests.numTodoTests !== 0 ||
      tests.numPassedTests !== expectedTests || assertions.length !== expectedTests || tests.testResults.length !== acceptanceFiles.length ||
      tests.testResults.some(suite => suite.status !== "passed") || assertions.some(assertion => assertion.status !== "passed")) {
    console.error(JSON.stringify({
      stage: "acceptance-summary",
      expectedSuiteCount: acceptanceFiles.length,
      actualSuiteCount: tests.testResults.length,
      expectedTestCount: expectedTests,
      passedTestCount: tests.numPassedTests,
      failedTestCount: tests.numFailedTests,
      pendingTestCount: tests.numPendingTests,
      todoTestCount: tests.numTodoTests,
      assertionCount: assertions.length,
      failedSuites: tests.testResults.filter(suite => suite.status !== "passed" ||
        (suite.assertionResults ?? []).some(assertion => assertion.status !== "passed"))
        .map(suite => safeVitestSuiteFailure(suite,
          (suite.assertionResults ?? []).filter(assertion => assertion.status !== "passed"))),
    }));
    throw new Error("PHASE8_OWNER_EXPORT_ACCEPTANCE_INCOMPLETE");
  }
  stage = "role-rls-acceptance";
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/database/role-rls-matrix.test.ts",
    "--no-file-parallelism", "--reporter=default", "--reporter=json", `--outputFile=${roleReportPath}`], env);
  const roleMatrix = JSON.parse(readFileSync(roleReportPath, "utf8"));
  if (!roleMatrix.success || roleMatrix.numFailedTestSuites !== 0 || roleMatrix.numFailedTests !== 0 ||
      roleMatrix.numPendingTests !== 0 || roleMatrix.numTodoTests !== 0 || roleMatrix.numPassedTests === 0 ||
      roleMatrix.testResults.length !== 1 || roleMatrix.testResults.some(suite => suite.status !== "passed")) {
    throw new Error("PHASE8_OWNER_EXPORT_RLS_ACCEPTANCE_INCOMPLETE");
  }
  stage = "cv-public-regression-acceptance";
  // Current CV application, delivery, and private Storage regressions are
  // already executed by the Phase 6 gate; this adds its missing public contract
  // regression without re-running those suites in the Phase 8 acceptance job.
  const regressionFiles = ["tests/contracts/public-contract.test.ts"];
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...regressionFiles,
    "--no-file-parallelism", "--reporter=default", "--reporter=json", `--outputFile=${regressionReportPath}`], env);
  const regressions = JSON.parse(readFileSync(regressionReportPath, "utf8"));
  regressionAssertions = regressions.testResults.flatMap(suite => suite.assertionResults ?? []);
  if (!regressions.success || regressions.numFailedTestSuites !== 0 || regressions.numFailedTests !== 0 ||
      regressions.numPendingTests !== 0 || regressions.numTodoTests !== 0 || regressions.numPassedTests === 0 ||
      regressionAssertions.length !== regressions.numPassedTests || regressions.testResults.length !== regressionFiles.length ||
      regressions.testResults.some(suite => suite.status !== "passed") || regressionAssertions.some(assertion => assertion.status !== "passed")) {
    throw new Error("PHASE8_OWNER_EXPORT_CV_REGRESSION_ACCEPTANCE_INCOMPLETE");
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
      { criterion: "AC03", tests: ["#243: readies Media export after reloading its persisted snapshot and candidate through PostgreSQL", "accepts supported selections including CV-only and CV with Media in canonical order", "packages accepted bytes, deduplicates shared digests, and passes the independent validator"] },
      { criterion: "AC04", tests: ["#243 AC01/04/08: reads accepted Media history under its purpose-bound worker role and excludes private fields", "records rejected bytes as excluded without reading or declaring any object"] },
      { criterion: "AC05", tests: ["#243: readies Media export after reloading its persisted snapshot and candidate through PostgreSQL", "fails closed for missing required accepted bytes", "fails closed for same-length replacement required accepted bytes", "rejects missing, redirected, changed, and wrong-length objects", "AC03/04/05: retries capture, lost upload, and verification faults without publishing partial readiness"] },
      { criterion: "AC06", tests: ["#243 AC01/04/08: reads accepted Media history under its purpose-bound worker role and excludes private fields", "AC01–AC08 captures all retained facts, races consistently, and validates independent content-only and combined packages"] },
      { criterion: "AC07", tests: ["rejects an accepted object above the 50 MiB per-object bound before opening Storage", "rejects packages whose unique assets exceed the validator's 512-member limit", "AC03/04/05: retries capture, lost upload, and verification faults without publishing partial readiness", "streams the exact upload-intent-scoped original from the private candidate bucket"] },
      { criterion: "AC08", tests: ["#243 AC01/04/08: reads accepted Media history under its purpose-bound worker role and excludes private fields", "packages accepted bytes, deduplicates shared digests, and passes the independent validator"] },
    ];
    const allAssertions = tests.testResults.flatMap(suite => suite.assertionResults ?? []);
    assertionByTitle = new Map([...allAssertions, ...regressionAssertions].map(assertion => [assertion.title, assertion.status]));
    for (const criterion of criterionTests) {
      if (criterion.tests.some(title => assertionByTitle.get(title) !== "passed")) {
        throw new Error(`PHASE8_OWNER_EXPORT_MEDIA_CRITERION_EVIDENCE_MISSING:${criterion.criterion}`);
      }
    }
  const cvSourceFiles = ["tests/phase8/owner-export-cv-package.test.ts", "tests/phase8/owner-export-cv-postgres.test.ts"];
  const cvSuites = tests.testResults.filter(suite => cvSourceFiles.some(file => suite.name.replace(/\\/g, "/").endsWith(file)));
  const cvAssertions = cvSuites.flatMap(suite => suite.assertionResults ?? []);
  if (cvSuites.length !== cvSourceFiles.length || cvAssertions.length !== 15 || cvAssertions.some(assertion => assertion.status !== "passed")) {
    throw new Error("PHASE8_OWNER_EXPORT_CV_ASSERTIONS_INVALID");
  }
  cvCriterionTests = [
    { criterion: "AC01", tests: ["exports retained CV identities, real approval and activation history, and verified accepted PDF bytes", "reads only the scoped CV projection and denies unrelated purpose, private columns, writes, and anonymous access"] },
    { criterion: "AC02", tests: ["represents no Current CV with retained versions and no invented activation history", "preserves accepted versions without Current and rejects an activation/withdrawal race"] },
    { criterion: "AC03", tests: ["exports retained CV identities, real approval and activation history, and verified accepted PDF bytes", "deduplicates an accepted PDF referenced by both selected scopes"] },
    { criterion: "AC04", tests: ["preserves accepted versions without Current and rejects an activation/withdrawal race", "fails closed when a retained CV's exact accepted Media binding is stale"] },
    { criterion: "AC05", tests: ["does not build a byte-complete package when required CV bytes are missing", "does not build a byte-complete package when required CV bytes are corrupt", "preserves accepted versions without Current and rejects an activation/withdrawal race"] },
    { criterion: "AC06", tests: ["exports retained CV identities, real approval and activation history, and verified accepted PDF bytes", "rejects an omitted acceptance from a complete retained history after digest recomputation", "independently validates Current CV pointers and activation order", "validator rejects archives that claim any CV history was truncated", "refuses a source snapshot that marks versionsTruncated incomplete", "refuses a source snapshot that marks acceptanceHistoryTruncated incomplete", "refuses a source snapshot that marks activationHistoryTruncated incomplete", "represents no Current CV with retained versions and no invented activation history", "deduplicates an accepted PDF referenced by both selected scopes", "does not build a byte-complete package when required CV bytes are missing", "does not build a byte-complete package when required CV bytes are corrupt", "fails closed when a retained CV's exact accepted Media binding is stale", "reads only the scoped CV projection and denies unrelated purpose, private columns, writes, and anonymous access", "fails the snapshot explicitly when retained CV versions exceed the export history limit", "preserves accepted versions without Current and rejects an activation/withdrawal race", "exposes only the English Current CV and declares stream and redirect success", "contains no forbidden public surface"] },
  ];
  for (const criterion of cvCriterionTests) {
    if (criterion.tests.some(title => assertionByTitle.get(title) !== "passed")) {
      throw new Error(`PHASE8_OWNER_EXPORT_CV_CRITERION_EVIDENCE_MISSING:${criterion.criterion}`);
    }
  }
  moderationCriterionTests = [
    { criterion: "AC01", tests: ["AC01/AC02/AC05/AC06/AC07 captures hidden and archived projects with truthful retained or erased facts",
      "AC01/AC05/AC08 independently validates moderation-only, combined, and empty-history packages"] },
    { criterion: "AC02", tests: ["AC02 applies the exact 90-day pending and rejected boundaries, including stale rows",
      "AC02 clamps 12 calendar months at month end and strips text and reasons at the exact deadline"] },
    { criterion: "AC03", tests: ["AC03 rechecks stale cleanup candidates after real Owner approvals win on Hidden and Archived Projects"] },
    { criterion: "AC04", tests: ["AC04 rejects pre-ready and download snapshots after erasure, deletion, or a capture/finalization race",
      "AC04 compares portable facts independently of object key order but preserves history order",
      "AC01/AC04 retains privacy-safe checkpoints for 'Moderation only' through source retention",
      "AC01/AC04 retains privacy-safe checkpoints for 'Moderation with configuration' through source retention",
      "AC01/AC04 retains privacy-safe checkpoints for 'Failed Moderation build' through source retention",
      "AC01/AC04 retains privacy-safe checkpoints for 'Failed Moderation finalization' through source retention",
      "AC01/AC04 retains privacy-safe checkpoints for 'Earlier source erasure' through source retention",
      "AC01/AC04 retains privacy-safe checkpoints for 'Exact Feedback deadline' through source retention",
      "AC01/AC04 retains privacy-safe checkpoints for 'Exact seven-day export expiry' through source retention",
      "AC01/AC04 retains privacy-safe checkpoints for 'Upload racing cleanup' through source retention",
      "AC04 denies a ready private ZIP when the current retained Feedback no longer matches its snapshot",
      "AC01/AC05/AC08 independently validates moderation-only, combined, and empty-history packages"] },
    { criterion: "AC05", tests: ["AC01/AC05/AC08 independently validates moderation-only, combined, and empty-history packages",
      "AC01/AC02/AC05/AC06/AC07 captures hidden and archived projects with truthful retained or erased facts",
      "AC05 independently rejects erased audit rows that still retain decision reasons"] },
    { criterion: "AC06", tests: ["AC06 grants direct reads only to the matching Owner and exact worker purpose",
      "AC01/AC02/AC05/AC06/AC07 captures hidden and archived projects with truthful retained or erased facts"] },
    { criterion: "AC07", tests: ["AC01/AC02/AC05/AC06/AC07 captures hidden and archived projects with truthful retained or erased facts",
      "AC07 durable Moderation checkpoints contain only comparison and dependency facts",
      "AC01/AC04 retains privacy-safe checkpoints for 'Failed Moderation build' through source retention",
      "sends every success response with the private no-store headers"] },
    { criterion: "AC08", tests: ["AC01/AC05/AC08 independently validates moderation-only, combined, and empty-history packages"] },
  ];
  for (const criterion of moderationCriterionTests) {
    if (criterion.tests.some(title => assertionByTitle.get(title) !== "passed")) {
      throw new Error(`PHASE8_OWNER_EXPORT_MODERATION_CRITERION_EVIDENCE_MISSING:${criterion.criterion}`);
    }
  }
  reconciliationCriterionTests = [
    { criterion: "AC01", tests: ["AC01/AC04 retains privacy-safe checkpoints for 'Exact Feedback deadline' through source retention",
      "AC01/AC04 retains privacy-safe checkpoints for 'Exact seven-day export expiry' through source retention"] },
    { criterion: "AC02", tests: ["AC01/AC04 retains privacy-safe checkpoints for 'Exact Feedback deadline' through source retention",
      "AC01/AC04 retains privacy-safe checkpoints for 'Exact seven-day export expiry' through source retention"] },
    { criterion: "AC03", tests: ["AC03 rechecks stale cleanup candidates after real Owner approvals win on Hidden and Archived Projects",
      "AC04 rejects pre-ready and download snapshots after erasure, deletion, or a capture/finalization race",
      "#243: readies Media export after reloading its persisted snapshot and candidate through PostgreSQL",
      "#247: mixed Media/Moderation readiness with Media rejected during upload: false",
      "#247: mixed Media/Moderation readiness with Media rejected during upload: true"] },
    { criterion: "AC04", tests: ["AC01/02/06/07: exports one captured Configuration version through isolated private Storage",
      "AC04 rejects pre-ready and download snapshots after erasure, deletion, or a capture/finalization race"] },
    { criterion: "AC05", tests: ["deletes only the exact owned ZIP, reconciles missing objects, and reports retryable failures",
      "AC01/AC04 retains privacy-safe checkpoints for 'Exact seven-day export expiry' through source retention"] },
    { criterion: "AC06", tests: ["AC01/AC04 retains privacy-safe checkpoints for 'Upload racing cleanup' through source retention",
      "AC03 rechecks stale cleanup candidates after real Owner approvals win on Hidden and Archived Projects"] },
    { criterion: "AC07", tests: ["AC01/AC02/AC05/AC06/AC07 captures hidden and archived projects with truthful retained or erased facts",
      "AC01/AC04 retains privacy-safe checkpoints for 'Exact seven-day export expiry' through source retention",
      "replays with existing revoked exports: false and removes temporary access",
      "replays with existing revoked exports: true and removes temporary access"] },
    { criterion: "AC08", tests: ["AC08 preserves exact scope coverage and privacy exclusions for every single-scope package",
      "AC08 composes cross-group selections and marks exact retained versus omitted dependencies",
      "AC08 emits the complete seven-scope package in canonical order with no privacy expansion"] },
  ];
  for (const criterion of reconciliationCriterionTests) {
    if (criterion.tests.some(title => assertionByTitle.get(title) !== "passed")) {
      throw new Error(`PHASE8_OWNER_EXPORT_RECONCILIATION_CRITERION_EVIDENCE_MISSING:${criterion.criterion}`);
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
    cvAcceptance: {
      suites: cvSuites.map(suite => suite.name.replace(root, "").replace(/\\/g, "/").replace(/^\//, "")),
      passed: cvAssertions.length,
      assertions: cvAssertions.map(assertion => ({ title: assertion.title, status: assertion.status })),
    },
    moderationAcceptance: {
      suites: tests.testResults.filter(suite => suite.name.replace(/\\/g, "/").endsWith("owner-export-moderation.test.ts") ||
        suite.name.replace(/\\/g, "/").endsWith("owner-export-moderation-postgres.test.ts"))
        .map(suite => suite.name.replace(root, "").replace(/\\/g, "/").replace(/^\//, "")),
      passed: assertions.filter(assertion => moderationCriterionTests.some(criterion => criterion.tests.includes(assertion.title))).length,
      assertions: assertions.filter(assertion => moderationCriterionTests.some(criterion => criterion.tests.includes(assertion.title)))
        .map(assertion => ({ title: assertion.title, status: assertion.status })),
    },
    reconciliationAcceptance: {
      suites: tests.testResults.filter(suite => suite.name.replace(/\\/g, "/").endsWith("owner-export-reconciliation.test.ts") ||
        suite.name.replace(/\\/g, "/").endsWith("owner-export-moderation-postgres.test.ts") ||
        suite.name.replace(/\\/g, "/").endsWith("owner-export-assembly.test.ts") ||
        suite.name.replace(/\\/g, "/").endsWith("owner-export-postgres.test.ts") ||
        suite.name.replace(/\\/g, "/").endsWith("owner-export-migration-postgres.test.ts"))
        .map(suite => suite.name.replace(root, "").replace(/\\/g, "/").replace(/^\//, "")),
      passed: reconciliationCriterionTests.flatMap(criterion => criterion.tests).length,
      assertions: reconciliationCriterionTests.flatMap(criterion => criterion.tests)
        .map(title => ({ title, status: assertionByTitle.get(title) })),
    },
    cvRegressionAcceptance: {
      suites: regressions.testResults.map(suite => suite.name.replace(root, "").replace(/\\/g, "/").replace(/^\//, "")),
      passed: regressionAssertions.length,
      assertions: regressionAssertions.map(assertion => ({ title: assertion.title, status: assertion.status })),
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
  for (const path of [reportPath, roleReportPath, regressionReportPath]) {
    try {
      const report = JSON.parse(readFileSync(path, "utf8"));
      for (const suite of report.testResults ?? []) {
        const failed = (suite.assertionResults ?? []).filter(assertion => assertion.status !== "passed");
        if (suite.status !== "passed" || failed.length > 0) {
          console.error(JSON.stringify(safeVitestSuiteFailure(suite, failed)));
        }
      }
      if (report.failureMessage !== undefined) console.error(JSON.stringify({ reportFailure: "present" }));
    } catch { /* no report is available for this stage */ }
  }
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
    const cvEvidence = {
      schemaVersion: 1, ticket: 244, runId, startedAt, completedAt: result.completedAt,
      sourceRevision: result.sourceRevision, sourceTreeSha256: result.sourceTreeSha256, postgresVersion: result.postgresVersion,
      migrations: result.migrations, tools: result.tools,
      required: { success: true, passed: result.cvAcceptance.passed, failed: 0, skipped: 0, todo: 0, failedSuites: 0 },
      roleMatrix: result.roleMatrix,
      assertions: result.cvAcceptance.assertions,
      suites: result.cvAcceptance.suites,
      criteria: ["AC01", "AC02", "AC03", "AC04", "AC05", "AC06"],
      criterionEvidence: cvCriterionTests.map(criterion => ({ criterion: criterion.criterion,
        executedTests: criterion.tests.map(title => ({ title, status: assertionByTitle.get(title) })) })),
      cvRegressionAcceptance: result.cvRegressionAcceptance,
      hostedEvidence: [{ check: "Phase 6 gate: CV module, Current CV delivery, and private Storage adapter regression suites against its qualified services",
        artifact: "phase6-gate", suites: ["tests/modules/cv-portfolio.test.ts", "tests/modules/current-cv-delivery.test.ts", "tests/runtime/current-cv.test.ts", "tests/runtime/supabase-current-cv-delivery.test.ts"],
        status: "required-in-pr-ci" }, { check: "Public operation contract regression",
        artifact: "phase8-owner-export-cv-244", suites: ["tests/contracts/public-contract.test.ts"], status: "passed-in-phase8-pr-ci" }],
      reproduction: "npm run setup:validation; npm run validation:ready; npm run phase8:focus:exports",
      scope: "CV-only export of retained version identities, exact Current pointer, real approval and activation history, and verified accepted PDF bytes; no fabricated Current CV or history; combined CV and Media digest deduplication; missing, corrupt, withdrawn, or stale accepted bytes fail closed; purpose-bound Worker RLS and private-column, write, wrong-purpose, and anonymous denials. The Phase 6 gate runs existing CV module, Current CV delivery, and private Storage regressions; this Phase 8 runner executes the public contract regression and publishes criterion-bound evidence.",
      cleanup,
    };
    writeFileSync(cvEvidencePath, `${JSON.stringify(cvEvidence, null, 2)}\n`);
    console.log(JSON.stringify({ evidence: cvEvidencePath, assertions: cvEvidence.required.passed, cleanup }));
    const moderationAssertions = result.moderationAcceptance.assertions;
    const moderationEvidence = {
      schemaVersion: 1, ticket: 245, runId, startedAt, completedAt: result.completedAt,
      sourceRevision: result.sourceRevision, sourceTreeSha256: result.sourceTreeSha256, postgresVersion: result.postgresVersion,
      migrations: result.migrations, tools: result.tools,
      required: { success: true, passed: moderationAssertions.length, failed: 0, skipped: 0, todo: 0, failedSuites: 0 },
      roleMatrix: result.roleMatrix,
      assertions: moderationAssertions,
      suites: result.moderationAcceptance.suites,
      criteria: ["AC01", "AC02", "AC03", "AC04", "AC05", "AC06", "AC07", "AC08"],
      criterionEvidence: moderationCriterionTests.map(criterion => ({ criterion: criterion.criterion,
        executedTests: criterion.tests.map(title => ({ title, status: assertionByTitle.get(title) })) })),
      hostedEvidence: [{ check: "Phase 8 Owner export transport acceptance: authenticated private/no-store download and stable scoped routes",
        artifact: "phase8-owner-export-245", suites: ["tests/phase8/owner-export-adapter.test.ts"], status: "passed-in-phase8-pr-ci" }],
      artifactDeletion: { realStorage: Boolean(process.env.PHASE8_OWNER_EXPORT_STORAGE_URL),
        scenarios: ["ready", "failed upload response", "failed finalization", "earlier erasure", "exact deadline", "upload fence", "deletion outage and restart"],
        reproduction: "npm run phase8:focus:exports -- --with-storage" },
      reproduction: "npm run setup:validation; npm run validation:ready; npm run phase8:focus:exports",
      scope: "Interactions-owned Feedback and moderation decision export; exact 90-day and clamped 12-calendar-month retention; hidden/archived Project inclusion; pre-ready/download rechecks; truthful erased audit schema 1.2; Owner/purpose-bound RLS; private ZIP/no-store transport; marker-free telemetry/jobs and independently validated empty/partial-reference packages.",
      cleanup,
    };
    const moderationEvidenceJson = JSON.stringify(moderationEvidence, null, 2);
    if (/PRIVATE_(?:NAME|TEXT|REASON|APPROVAL_REASON)_SENTINEL/u.test(moderationEvidenceJson)) {
      console.error("PHASE8_OWNER_EXPORT_MODERATION_EVIDENCE_CONTAINS_PRIVATE_MARKER");
      process.exitCode = 1;
    } else {
      writeFileSync(moderationEvidencePath, `${moderationEvidenceJson}\n`);
      console.log(JSON.stringify({ evidence: moderationEvidencePath, assertions: moderationEvidence.required.passed, cleanup }));
    }
    const reconciliationEvidence = {
      schemaVersion: 1, ticket: 247, runId, startedAt, completedAt: result.completedAt,
      sourceRevision: result.sourceRevision, sourceTreeSha256: result.sourceTreeSha256, postgresVersion: result.postgresVersion,
      migrations: result.migrations, tools: result.tools,
      required: { success: true, passed: result.reconciliationAcceptance.passed, failed: 0, skipped: 0, todo: 0, failedSuites: 0 },
      roleMatrix: result.roleMatrix,
      assertions: result.reconciliationAcceptance.assertions,
      suites: result.reconciliationAcceptance.suites,
      criteria: reconciliationCriterionTests.map(criterion => criterion.criterion),
      criterionEvidence: reconciliationCriterionTests.map(criterion => ({ criterion: criterion.criterion,
        executedTests: criterion.tests.map(title => ({ title, status: assertionByTitle.get(title) })) })),
      artifactLedger: { fields: ["exportId", "portfolioId", "artifactId", "revokedAt", "revocationCode", "artifactDeletedAt"],
        causes: ["expired", "privacy_invalid", "build_failed", "prior_revocation"], signals: "counts-only" },
      artifactDeletion: { bounded: true, resumable: true, idempotent: true,
        scenarios: ["before and at seven-day expiry", "earlier Feedback retention deadline", "storage outage and restart", "upload versus cleanup barrier"] },
      hostedEvidence: [{ check: "Production owner-export Storage adapter against isolated private Storage with direct-path denial",
        status: "required-in-pr-ci" }],
      reproduction: "npm run setup:validation; npm run validation:ready; npm run phase8:focus:exports -- --with-storage",
      scope: "All seven registered scopes, bounded ownership-scoped ZIP revocation/deletion, DB-clock expiry, safe durable tombstones, current Moderation/Media policy revalidation, and independently validated canonical composite packages.",
      cleanup,
    };
    const reconciliationEvidenceJson = JSON.stringify(reconciliationEvidence, null, 2);
    if (/PRIVATE_(?:NAME|TEXT|REASON|APPROVAL_REASON)_SENTINEL/u.test(reconciliationEvidenceJson)) {
      console.error("PHASE8_OWNER_EXPORT_RECONCILIATION_EVIDENCE_CONTAINS_PRIVATE_MARKER");
      process.exitCode = 1;
    } else {
      writeFileSync(reconciliationEvidencePath, `${reconciliationEvidenceJson}\n`);
      console.log(JSON.stringify({ evidence: reconciliationEvidencePath, assertions: reconciliationEvidence.required.passed, cleanup }));
    }
    console.log(JSON.stringify({ evidence: evidencePath, cleanup }));
  }
}
