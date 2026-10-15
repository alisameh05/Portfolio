#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { sanitizeEvidenceOutput } from "./phase4-gate-support.mjs";
import { invalidateSuiteEvidence } from "./phase5-scenario-coverage.mjs";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const VITEST = join(ROOT, "node_modules", "vitest", "vitest.mjs");
const EVIDENCE_DIR = join(ROOT, "evidence");

export const FOCUS_SUITES = Object.freeze({
  authoring: "authoring",
  taxonomy: "taxonomy",
  database: "database",
  owner: "owner",
  traceability: "traceability",
});
export const FOCUS_ENTRYPOINTS = Object.freeze({
  authoring: "authoring-review-publication-routes",
  taxonomy: "taxonomy-status-relationships-discovery",
  database: "database-rls-migrations-concurrency",
  owner: "owner-adapters-composition",
  traceability: "scenario-traceability",
});

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory).sort()) {
    const full = join(directory, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...filesUnder(full));
    else if (/\.test\.(?:ts|tsx|js|mjs|mts)$/.test(entry)) files.push(full);
  }
  return files.sort();
}

export function sanitizeVerificationText(value, source = process.env) {
  const secrets = Object.entries(source)
    .filter(([name, secret]) => /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SERVICE_ROLE_KEY)/i.test(name) && typeof secret === "string" && secret.length >= 6)
    .map(([, secret]) => secret);
  return sanitizeEvidenceOutput(String(value), { workspace: ROOT, temporary: tmpdir(), secrets })
    .replace(/\btoken\s*[=:]\s*[^\s,;]+/gi, "token=[redacted]");
}

export function parseVitestReport(report) {
  const shape = report && typeof report === "object" ? report : {};
  const testResults = Array.isArray(shape.testResults) ? shape.testResults : [];
  const assertions = testResults.flatMap((file) => Array.isArray(file?.assertionResults) ? file.assertionResults : []);
  const passed = Number.isSafeInteger(shape.numPassedTests) ? shape.numPassedTests : 0;
  const failed = Number.isSafeInteger(shape.numFailedTests) ? shape.numFailedTests : 0;
  const declaredSkipped = (Number.isSafeInteger(shape.numPendingTests) ? shape.numPendingTests : 0) +
    (Number.isSafeInteger(shape.numTodoTests) ? shape.numTodoTests : 0);
  const observedSkipped = assertions.filter((test) => ["pending", "skipped", "todo"].includes(test?.status)).length;
  const skipped = Math.max(declaredSkipped, observedSkipped);
  const total = Number.isSafeInteger(shape.numTotalTests) ? shape.numTotalTests : passed + failed + skipped;
  const executed = passed + failed;
  const partial = total <= 0 || testResults.length === 0 || executed + skipped !== total;
  const valid = shape.success === true && passed > 0 && failed === 0 && skipped === 0 && !partial &&
    testResults.every((file) => file?.status === "passed") && assertions.every((test) => test?.status === "passed");
  return {
    executed,
    failed,
    skipped,
    total,
    partial,
    verdict: valid ? "pass" : "fail",
    scenarioAcceptance: valid,
  };
}

export function verifyRequiredDependency(result) {
  return {
    passed: result?.available === true,
    code: typeof result?.code === "string" ? result.code : "REQUIRED_DEPENDENCY_UNAVAILABLE",
  };
}

export function verifyRestrictedPrincipalMatrix(roles) {
  if (!Array.isArray(roles)) return false;
  const principals = roles.map((role) => role?.principal);
  if (principals.some((principal) => typeof principal !== "string" || principal.trim() === "") ||
    new Set(principals).size !== principals.length) return false;
  const byPrincipal = new Map(roles.map((role) => [role?.principal, role]));
  const isDenied = (value) => typeof value === "string" && /^deny(?: by grants and forced RLS)?$/i.test(value);
  const checks = [
    { principal: "anon Visitor login", requireNoBypass: true },
    { principal: "shipwithali_worker login", requireNoBypass: true },
    { principal: "PUBLIC", requireNoBypass: false },
  ];
  return checks.every(({ principal, requireNoBypass }) => {
    const role = byPrincipal.get(principal);
    return role !== undefined && isDenied(role.settings) && isDenied(role.ownerIdentityMap) &&
      (!requireNoBypass || role.bypassRls === false);
  });
}

export function localVerificationEnvironment(source = process.env) {
  const env = { ...source, CI: "1" };
  for (const key of Object.keys(env)) {
    if (/^(?:SUPABASE_|PHASE4_|DATABASE_|OWNER_GITHUB_)/.test(key)) delete env[key];
  }
  return env;
}

export function makeVerificationReport({
  runId = randomUUID(),
  sourceRevision,
  sourceTreeSha256,
  suite,
  result,
  dependency = { required: false, available: true, code: "NOT_REQUIRED" },
  cleanup = { attempted: false, passed: true },
  suiteAvailable = true,
  reproduction = [],
  details = {},
}) {
  const dependencyResult = verifyRequiredDependency(dependency);
  const passed = result?.verdict === "pass" && dependencyResult.passed &&
    (cleanup?.attempted !== true || cleanup?.passed === true);
  const complete = passed && suiteAvailable === true && result?.scenarioAcceptance === true;
  let safeDetails = details;
  try { safeDetails = JSON.parse(sanitizeVerificationText(JSON.stringify(details))); } catch { safeDetails = "[redacted-details]"; }
  return {
    schemaVersion: 1,
    runId,
    sourceRevision,
    sourceTreeSha256,
    suite,
    startedAt: new Date().toISOString(),
    verdict: passed ? "pass" : "fail",
    scenarioAcceptance: complete,
    suiteAvailable,
    counts: {
      executed: result?.executed ?? 0,
      failed: result?.failed ?? 0,
      skipped: result?.skipped ?? 0,
      total: result?.total ?? result?.executed ?? 0,
    },
    partial: result?.partial === true,
    dependency: { required: dependency?.required === true, available: dependencyResult.passed, code: dependencyResult.code },
    cleanup: { attempted: cleanup?.attempted === true, passed: cleanup?.passed === true },
    reproduction: reproduction.map((line) => sanitizeVerificationText(line)),
    details: safeDetails,
  };
}

export function dockerDependencyResult(probe = spawnSync) {
  const result = probe("docker", ["info", "--format", "{{.ServerVersion}}"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
  });
  if (result.error || result.status !== 0 || !String(result.stdout ?? "").trim()) {
    return { available: false, code: "PHASE5_REQUIRED_DATABASE_UNAVAILABLE" };
  }
  return { available: true, code: "PHASE5_REQUIRED_DATABASE_AVAILABLE" };
}

function sourceRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

function writeReport(report) {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const path = join(EVIDENCE_DIR, `phase-5-verification-${report.suite}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

function readReport(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function runFocus(suite) {
  invalidateSuiteEvidence(suite);
  if (suite === "database") {
    const child = spawnSync(process.execPath, [join(ROOT, "scripts", "portfolio-settings-integration.mjs"), "--ticket-123"], {
      cwd: ROOT,
      env: localVerificationEnvironment(),
      encoding: "utf8",
      timeout: 1_200_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const evidence = readReport(join(EVIDENCE_DIR, "phase-5-security-migrations-postgres.json"));
    const executed = evidence?.databaseIntegrationTestsPassed ?? 0;
    const skipped = evidence?.skippedCases ?? 0;
    const accepted = child.error === undefined && child.status === 0 && evidence?.ticket === 123 &&
      evidence?.cleanUpgradeEquivalent === true && evidence?.phase4ReleaseUpgrade !== undefined && executed > 0 && skipped === 0;
    const report = makeVerificationReport({
      sourceRevision: sourceRevision(),
      sourceTreeSha256: workingTreeSourceSha256(),
      suite,
      result: {
        executed,
        failed: accepted ? 0 : 1,
        skipped,
        total: executed + skipped,
        partial: !accepted,
        verdict: accepted ? "pass" : "fail",
        scenarioAcceptance: accepted,
      },
      dependency: { required: true, available: accepted, code: accepted ? "PHASE5_REQUIRED_DATABASE_AVAILABLE" : "PHASE5_REQUIRED_DATABASE_UNAVAILABLE" },
      cleanup: { attempted: true, passed: accepted },
      suiteAvailable: evidence?.ticket === 123,
      reproduction: [`npm run phase5:focus:${FOCUS_ENTRYPOINTS[suite]}`],
      details: accepted ? {
        migrationCount: evidence.migrationLedger?.length ?? 0,
        phase5MigrationCount: evidence.phase4ReleaseUpgrade.phase5MigrationChecksums?.length ?? 0,
        retainedReleaseRecords: evidence.phase4ReleaseUpgrade.retainedRecordsBeforeAndAfterPhase5,
        zeroSkips: true,
      } : { outcome: "focused Phase 5 migration and restricted-principal gate failed or produced incomplete evidence" },
    });
    const path = writeReport(report);
    const output = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
    if (output.trim() !== "") process.stdout.write(sanitizeVerificationText(output));
    console.log(JSON.stringify({ ...report, evidence: relative(ROOT, path) }, null, 2));
    return report.verdict === "pass" ? 0 : 1;
  }

  const directory = join(ROOT, "tests", "phase5", suite);
  const files = suite === "traceability"
    ? [
      join(ROOT, "tests", "phase4", "phase5-scenario-coverage.test.ts"),
      join(ROOT, "tests", "phase4", "phase5-verification.test.ts"),
      join(ROOT, "tests", "architecture", "architecture.test.ts"),
    ]
    : filesUnder(directory);
  if (suite === "authoring") {
    files.push(
      join(ROOT, "tests", "runtime", "owner-content-authoring.test.ts"),
      join(ROOT, "tests", "runtime", "owner-content-http.test.ts"),
    );
    files.sort();
  }
  const dependency = { required: false, available: true, code: "NOT_REQUIRED" };
  let result = files.length === 0
    ? { executed: 0, failed: 0, skipped: 0, total: 0, partial: false, verdict: "pass", scenarioAcceptance: false }
    : { executed: 0, failed: 0, skipped: 0, total: 0, partial: true, verdict: "fail", scenarioAcceptance: false };
  let suiteAvailable = files.length > 0;
  let output = "";
  let cleanup = { attempted: false, passed: true };

  if (suiteAvailable) {
    const reportPath = join(tmpdir(), `shipwithali-phase5-${suite}-${process.pid}-${randomUUID()}.json`);
    cleanup = { attempted: true, passed: true };
    const run = spawnSync(process.execPath, [VITEST, "run", ...files.map((path) => relative(ROOT, path)), "--reporter=json", `--outputFile=${reportPath}`], {
      cwd: ROOT,
      env: { ...localVerificationEnvironment(), PHASE5_REQUIRE_DATABASE: "0" },
      encoding: "utf8",
      timeout: 600_000,
    });
    output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    result = parseVitestReport(readReport(reportPath));
    if (run.error || run.status !== 0) {
      result.verdict = "fail";
      result.scenarioAcceptance = false;
      result.failed = Math.max(1, result.failed);
    }
    try { unlinkSync(reportPath); } catch { if (existsSync(reportPath)) cleanup.passed = false; }
  }

  const report = makeVerificationReport({
    sourceRevision: sourceRevision(),
    sourceTreeSha256: workingTreeSourceSha256(),
    suite,
    result,
    dependency,
    suiteAvailable,
    cleanup,
    reproduction: [`npm run phase5:focus:${FOCUS_ENTRYPOINTS[suite]}`],
    details: {
      message: suiteAvailable ? "focused suite executed" : "no Phase 5 business scenarios are implemented in this suite yet",
      files: files.map((path) => relative(ROOT, path).replaceAll("\\", "/")),
    },
  });
  const path = writeReport(report);
  if (output) process.stdout.write(sanitizeVerificationText(output));
  console.log(JSON.stringify({ ...report, evidence: relative(ROOT, path) }, null, 2));
  return report.verdict === "pass" ? 0 : 1;
}

function runSmoke({ suite = "smoke", reproduction = ["npm run phase5:smoke"] } = {}) {
  const dependency = { required: true, ...dockerDependencyResult() };
  let result = { executed: 0, failed: 0, skipped: 0, total: 0, partial: true, verdict: "fail", scenarioAcceptance: false };
  let cleanup = { attempted: false, passed: true };
  let output = "";
  let smokeDetails = { workflow: "existing real PostgreSQL Owner Configuration fixture used only to prove disposable DB harness behavior", phase5ScenariosAccepted: false };
  if (dependency.available) {
    const integrationEvidencePath = join(tmpdir(), `shipwithali-phase5-smoke-${process.pid}-${randomUUID()}.json`);
    const child = spawnSync(process.execPath, [join(ROOT, "scripts", "portfolio-settings-integration.mjs")], {
      cwd: ROOT,
      env: { ...localVerificationEnvironment(), PORTFOLIO_SETTINGS_EVIDENCE_PATH: integrationEvidencePath },
      encoding: "utf8",
      timeout: 900_000,
    });
    output = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
    const databaseReport = readReport(integrationEvidencePath);
    const passedTests = databaseReport?.databaseIntegrationTestsPassed ?? 0;
    const skipped = databaseReport?.skippedCases ?? 0;
    const roles = Array.isArray(databaseReport?.restrictedPrincipalMatrix) ? databaseReport.restrictedPrincipalMatrix : [];
    const restrictedRolesVerified = verifyRestrictedPrincipalMatrix(roles);
    const evidenceComplete = databaseReport?.isolatedLoopbackProjects === true && databaseReport?.credentialsRecorded === false &&
      databaseReport?.secretValuesRecorded === false && passedTests > 0 && skipped === 0 && restrictedRolesVerified;
    result = {
      executed: passedTests,
      failed: child.status === 0 && evidenceComplete ? 0 : 1,
      skipped,
      total: passedTests + skipped,
      partial: !evidenceComplete,
      verdict: child.status === 0 && evidenceComplete ? "pass" : "fail",
      scenarioAcceptance: false,
    };
    cleanup = { attempted: true, passed: child.status === 0 && !/CLEANUP_FAILED/.test(output) };
    smokeDetails = {
      workflow: "existing real PostgreSQL Owner Configuration fixture used only to prove disposable DB harness behavior",
      phase5ScenariosAccepted: false,
      isolatedLoopback: databaseReport?.isolatedLoopbackProjects === true,
      restrictedPrincipalCount: roles.length,
      restrictedRolesVerified,
      credentialsRecorded: databaseReport?.credentialsRecorded === true,
      secretValuesRecorded: databaseReport?.secretValuesRecorded === true,
    };
    try { unlinkSync(integrationEvidencePath); } catch { if (existsSync(integrationEvidencePath)) cleanup.passed = false; }
    if (child.error || child.status !== 0) result.verdict = "fail";
  }
  const report = makeVerificationReport({
    sourceRevision: sourceRevision(),
    sourceTreeSha256: workingTreeSourceSha256(),
    suite,
    result,
    dependency,
    cleanup,
    suiteAvailable: suite === "smoke" ? true : filesUnder(join(ROOT, "tests", "phase5", suite)).length > 0,
    reproduction,
    details: smokeDetails,
  });
  const path = writeReport(report);
  if (output) process.stdout.write(sanitizeVerificationText(output));
  console.log(JSON.stringify({ ...report, evidence: relative(ROOT, path) }, null, 2));
  return report.verdict === "pass" ? 0 : 1;
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/phase5-verification.mjs");
if (invokedDirectly) {
  const [action, suite] = process.argv.slice(2);
  if (action === "--suite" && Object.hasOwn(FOCUS_SUITES, suite)) process.exitCode = runFocus(suite);
  else if (action === "--smoke") process.exitCode = runSmoke();
  else {
    console.error("PHASE5_VERIFICATION_USAGE: use --suite authoring|taxonomy|database|owner or --smoke");
    process.exitCode = 2;
  }
}
