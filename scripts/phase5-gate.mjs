#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { classifyCheckResult, sanitizeEvidenceOutput } from "./phase4-gate-support.mjs";
import { observeRuntime, verifyEnvironment } from "./validation-environment.mjs";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";
import { countSkippedTests, REQUIRED_PHASE5_GATE_CHECKS, evaluatePhase5Gate } from "./phase5-gate-support.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const EVIDENCE_DIR = join(ROOT, "evidence");
const CHECK_EVIDENCE_DIR = join(EVIDENCE_DIR, "phase-5-gate-checks");
const REPORT_PATH = join(EVIDENCE_DIR, "phase-5-gate-report.json");
const INTEGRATED_PATH = join(EVIDENCE_DIR, "phase-5-integrated-scenarios.json");
const DATABASE_PATH = join(EVIDENCE_DIR, "phase-5-security-migrations-postgres.json");
const OWNER_PATH = join(EVIDENCE_DIR, "phase-5-owner-composition-postgres.json");
const CONTEXT_PATH = join(EVIDENCE_DIR, "phase-5-context.json");
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const CHECK_TIMEOUT = 20 * 60 * 1000;

const COMMANDS = Object.freeze([
  { name: "exact-toolchain", script: null, entry: "scripts/check-toolchain.mjs" },
  { name: "phase5-context", script: null, entry: "scripts/check-phase5-context.mjs", env: { SHIPWITHALI_PHASE: "phase5" } },
  { name: "authoring-scenarios", script: "phase5:focus:authoring-review-publication-routes", requiresValidation: true, failOnSkipped: true },
  { name: "taxonomy-scenarios", script: "phase5:focus:taxonomy-status-relationships-discovery", requiresValidation: true, failOnSkipped: true },
  { name: "traceability-scenarios", script: "phase5:focus:scenario-traceability", requiresValidation: true, failOnSkipped: true },
  { name: "owner-postgres", script: "phase5:focus:owner-adapters-composition", timeout: CHECK_TIMEOUT, requiresValidation: true, failOnSkipped: true },
  { name: "database-rls-postgres", script: "phase5:focus:database-rls-migrations-concurrency", timeout: CHECK_TIMEOUT, requiresValidation: true, failOnSkipped: true },
  { name: "integrated-scenarios", script: "phase5:focus:integrated-scenarios", timeout: CHECK_TIMEOUT, requiresValidation: true, failOnSkipped: true },
  { name: "contract-verification", script: "contract:verify", requiresValidation: true },
  { name: "tooling-tests", script: "test:setup", requiresValidation: true, failOnSkipped: true },
  { name: "architecture", script: "test:arch", requiresValidation: true },
  { name: "route-inventory", script: "route:inventory", requiresValidation: true },
  { name: "runtime-boundary", script: "runtime:boundary", requiresValidation: true },
  { name: "runtime-architecture", script: "runtime:architecture", requiresValidation: true },
  { name: "lint", script: "lint", requiresValidation: true },
  { name: "typecheck", script: "typecheck", requiresValidation: true },
  { name: "production-build", script: "build", requiresValidation: true, timeout: CHECK_TIMEOUT },
]);

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function gitRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sanitize(value) {
  const secrets = Object.entries(process.env)
    .filter(([name, secret]) => /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SERVICE_ROLE_KEY)/i.test(name) && typeof secret === "string" && secret.length >= 6)
    .map(([, secret]) => secret);
  return sanitizeEvidenceOutput(String(value), { workspace: ROOT, temporary: process.env.TEMP ?? "", secrets });
}

function npmCommand(script) {
  if (process.env.npm_execpath) {
    return { entry: process.execPath, args: [process.env.npm_execpath, "run", script] };
  }
  return {
    entry: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", script],
    shell: process.platform === "win32",
  };
}

function runProcess(command, env = {}, timeout = CHECK_TIMEOUT) {
  const result = spawnSync(command.entry, command.args, {
    cwd: ROOT,
    env: { ...process.env, CI: "1", SHIPWITHALI_PHASE: "phase5", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: command.shell ?? false,
  });
  return {
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    code: result.status ?? 1,
    error: result.error,
  };
}

function writeCheck(name, runId, sourceRevision, sourceTreeSha256, startedAt, {
  code,
  error,
  output,
  skipped = countSkippedTests(output),
  executed = true,
  failOnSkipped = true,
}) {
  const sanitized = sanitize(output).trimEnd();
  const file = `phase-5-gate-checks/${name}.log`;
  const path = join(EVIDENCE_DIR, file);
  mkdirSync(CHECK_EVIDENCE_DIR, { recursive: true });
  writeFileSync(path, `${sanitized}${sanitized === "" ? "" : "\n"}`, "utf8");
  const classification = classifyCheckResult({
    code,
    spawnError: error,
    output: sanitized,
    // Focused test logs include literal "partial" text from negative fixtures;
    // actual skip summaries are parsed separately below.
    failOnSkipped: false,
  });
  const passed = classification.passed && (!failOnSkipped || skipped === 0) && skipped === 0;
  return {
    name,
    runId,
    sourceRevision,
    sourceTreeSha256,
    startedAt,
    completedAt: new Date().toISOString(),
    executed,
    passed,
    exitCode: passed ? 0 : (code || 1),
    skipped,
    failure: passed ? null : classification.failure ?? (skipped > 0 ? "skipped-or-partial" : "check-failed"),
    evidence: { path: `evidence/${file}`, sha256: sha256(path) },
  };
}

function blockedCheck(name, runId, sourceRevision, sourceTreeSha256, startedAt, reason) {
  return writeCheck(name, runId, sourceRevision, sourceTreeSha256, startedAt, {
    code: 1,
    output: `Not run because ${reason}.`,
    executed: false,
  });
}

function requireCompleteEvidenceFile(path, runStartedAt) {
  if (!existsSync(path) || readJson(path) === null || statSync(path).mtimeMs < Date.parse(runStartedAt)) return false;
  return true;
}

function evidenceArtifacts(runId, sourceRevision, sourceTreeSha256, startedAt) {
  const files = [
    ["phase5-context", CONTEXT_PATH],
    ["integrated-scenarios", INTEGRATED_PATH],
    ["database-security", DATABASE_PATH],
    ["owner-composition", OWNER_PATH],
  ];
  return files.map(([name, path]) => {
    const report = readJson(path);
    return {
      name,
      path: `evidence/${path.slice(EVIDENCE_DIR.length + 1)}`,
      runId: report?.runId ?? null,
      sourceRevision: report?.sourceRevision ?? null,
      sourceTreeSha256: report?.sourceTreeSha256 ?? null,
      startedAt: report?.startedAt ?? null,
      fresh: requireCompleteEvidenceFile(path, startedAt),
      sha256: existsSync(path) ? sha256(path) : null,
      gateRunId: runId,
      gateSourceRevision: sourceRevision,
      gateSourceTreeSha256: sourceTreeSha256,
      requiredRunId: runId,
    };
  });
}

function safeEvidenceSummary({ contextEvidence, integratedEvidence, databaseEvidence, ownerEvidence }) {
  return {
    context: contextEvidence === null ? null : {
      runId: contextEvidence.runId,
      sourceRevision: contextEvidence.sourceRevision,
      phase: contextEvidence.phase,
      verdict: contextEvidence.verdict,
      operations: contextEvidence.operations,
      failures: contextEvidence.failures,
    },
    integrated: integratedEvidence === null ? null : {
      runId: integratedEvidence.runId,
      sourceRevision: integratedEvidence.sourceRevision,
      sourceTreeSha256: integratedEvidence.sourceTreeSha256,
      verdict: integratedEvidence.verdict,
      counts: integratedEvidence.counts,
      constituents: integratedEvidence.constituents,
      coverage: integratedEvidence.coverage,
      deferred: integratedEvidence.deferred,
      reproduction: integratedEvidence.reproduction,
      cleanup: integratedEvidence.cleanup,
    },
    database: databaseEvidence === null ? null : {
      runId: databaseEvidence.runId,
      sourceRevision: databaseEvidence.sourceRevision,
      sourceTreeSha256: databaseEvidence.sourceTreeSha256,
      toolVersions: databaseEvidence.toolVersions,
      migrationChecksums: databaseEvidence.migrationChecksums,
      migrationLedger: databaseEvidence.migrationLedger,
      phase4ReleaseUpgrade: databaseEvidence.phase4ReleaseUpgrade,
      cleanUpgradeEquivalent: databaseEvidence.cleanUpgradeEquivalent,
      migrationReplayNoop: databaseEvidence.migrationReplayNoop,
      generatedTypeDrift: databaseEvidence.generatedTypeDrift,
      authoringTablesWithForcedRls: databaseEvidence.authoringTablesWithForcedRls,
      restrictedPrincipalMatrix: databaseEvidence.restrictedPrincipalMatrix,
      pooledConnectionScope: databaseEvidence.pooledConnectionScope,
      diagnosticsPrivacy: databaseEvidence.diagnosticsPrivacy,
      databaseIntegrationSuites: databaseEvidence.databaseIntegrationSuites,
      databaseIntegrationTestsPassed: databaseEvidence.databaseIntegrationTestsPassed,
      skippedCases: databaseEvidence.skippedCases,
      isolatedLoopbackProjects: databaseEvidence.isolatedLoopbackProjects,
      credentialsRecorded: databaseEvidence.credentialsRecorded,
      secretValuesRecorded: databaseEvidence.secretValuesRecorded,
      safeEventExamples: ownerEvidence?.databaseTestResults?.some((test) => test?.status === "passed" &&
        String(test?.name).includes("keeps the committed route and projection readable after optional delivery port failures")) === true
        ? [{
          kind: "redacted contract shape",
          eventType: "content.language_version_published.v1",
          schemaVersion: 1,
          payload: { contentId: "[redacted]", locale: "en", revisionId: "[redacted]", slug: "[redacted]" },
          verifiedBy: "Phase 5 Owner composition reads the committed event and survives injected optional-delivery failures",
          privateBodyEvidenceAndCredentialsIncluded: false,
        }]
        : [],
      discoveryReadPlan: {
        assertion: "queries only current published locale projections with stable tied-time cursors and controlled facets",
        index: "taxonomy.project_discovery_locale_public_order",
        order: ["first_published_at DESC", "content_id DESC"],
        pageLimit: "limit plus one",
        requiredPlanAssertions: ["21 rows", "Index Scan or Index Only Scan", "no Sort node"],
      },
    },
    owner: ownerEvidence === null ? null : {
      runId: ownerEvidence.runId,
      sourceRevision: ownerEvidence.sourceRevision,
      sourceTreeSha256: ownerEvidence.sourceTreeSha256,
      injectedAdapterAndContractTestsPassed: ownerEvidence.injectedAdapterAndContractTestsPassed,
      databaseIntegrationTestsPassed: ownerEvidence.databaseIntegrationTestsPassed,
      skippedCases: ownerEvidence.skippedCases,
      isolatedLoopbackProjects: ownerEvidence.isolatedLoopbackProjects,
      credentialsRecorded: ownerEvidence.credentialsRecorded,
      secretValuesRecorded: ownerEvidence.secretValuesRecorded,
    },
  };
}

async function main() {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  rmSync(REPORT_PATH, { force: true });
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const sourceRevision = gitRevision();
  let initialTree;
  try { initialTree = workingTreeSourceSha256(); } catch { initialTree = "unknown"; }
  const runtime = observeRuntime();
  const packageJson = readJson(join(ROOT, "package.json")) ?? {};
  const toolVersions = { node: runtime.node, npm: runtime.npm };
  const expectedVersions = { node: packageJson.engines?.node, npm: packageJson.engines?.npm };
  const readinessErrors = verifyEnvironment(ROOT, runtime);
  const checks = [];
  checks.push(writeCheck("validation-ready", runId, sourceRevision, initialTree, new Date().toISOString(), {
    code: readinessErrors.length === 0 ? 0 : 1,
    output: readinessErrors.length === 0
      ? "Validation environment ready: exact Node/npm and locked dependencies verified."
      : readinessErrors.join("\n"),
  }));
  const validationReady = readinessErrors.length === 0;

  for (const definition of COMMANDS) {
    if (definition.requiresValidation && !validationReady) {
      checks.push(blockedCheck(definition.name, runId, sourceRevision, initialTree, new Date().toISOString(), "validation:ready failed"));
      continue;
    }
    const checkStartedAt = new Date().toISOString();
    const command = definition.script
      ? npmCommand(definition.script)
      : { entry: process.execPath, args: [join(ROOT, definition.entry)] };
    const result = runProcess(command, {
      PHASE5_GATE_RUN_ID: runId,
      ...definition.env,
    }, definition.timeout ?? 120_000);
    const check = writeCheck(definition.name, runId, sourceRevision, initialTree, checkStartedAt, {
      ...result,
      failOnSkipped: definition.failOnSkipped ?? true,
    });
    checks.push(check);
    if (definition.name === "phase5-context" && check.passed) {
      const report = readJson(CONTEXT_PATH);
      if (report?.verdict !== "pass" || report?.sourceRevision !== sourceRevision || report?.phase !== "phase5") {
        check.passed = false;
        check.exitCode = 1;
        check.failure = "context-evidence-invalid";
      }
    }
  }

  const finalRevision = gitRevision();
  let finalTree;
  try { finalTree = workingTreeSourceSha256(); } catch { finalTree = "unknown"; }
  if (finalRevision !== sourceRevision || finalTree !== initialTree) {
    for (const check of checks) {
      check.passed = false;
      check.exitCode = 1;
      check.failure = "source-changed-during-gate";
    }
  }
  const contextEvidence = readJson(CONTEXT_PATH);
  const integratedEvidence = readJson(INTEGRATED_PATH);
  const databaseEvidence = readJson(DATABASE_PATH);
  const ownerEvidence = readJson(OWNER_PATH);
  const evaluated = evaluatePhase5Gate({
    runId,
    sourceRevision,
    sourceTreeSha256: finalTree,
    startedAt,
    toolVersions,
    checks,
    contextEvidence,
    integratedEvidence,
    databaseEvidence,
    ownerEvidence,
  });
  const artifacts = evidenceArtifacts(runId, sourceRevision, finalTree, startedAt);
  const artifactFailures = artifacts.flatMap((item) => {
    const valid = item.fresh && item.sha256 !== null && item.runId !== null &&
      item.gateRunId === runId && item.gateSourceRevision === sourceRevision &&
      item.gateSourceTreeSha256 === finalTree &&
      (item.name === "phase5-context" ? item.sourceRevision === sourceRevision :
        item.sourceRevision === sourceRevision && item.sourceTreeSha256 === finalTree);
    return valid ? [] : [`structured evidence is stale, malformed, or unbound: ${item.name}`];
  });
  const report = {
    ...evaluated,
    realServiceScope: {
      runId: databaseEvidence?.runId ?? runId,
      sourceRevision,
      sourceTreeSha256: finalTree,
      startedAt: databaseEvidence?.startedAt ?? startedAt,
      completedAt: new Date().toISOString(),
      postgresVersion: databaseEvidence?.postgresVersion ?? null,
      isolation: databaseEvidence?.isolatedLoopbackProjects === true ? "isolated-loopback" : null,
      required: { success: reportPassesDatabaseChecks(checks, databaseEvidence) },
      cleanUpgrade: { equivalent: databaseEvidence?.cleanUpgradeEquivalent === true },
      services: { postgres: { available: databaseEvidence?.isolatedLoopbackProjects === true,
        executionCount: databaseEvidence?.databaseIntegrationTestsPassed ?? 0 } },
      checks: checks.filter((check) => ["owner-postgres", "database-rls-postgres"].includes(check.name))
        .map((check) => ({ name: check.name, executed: check.executed === true, passed: check.passed === true })),
      cleanup: databaseEvidence?.isolatedLoopbackProjects === true && ownerEvidence?.isolatedLoopbackProjects === true,
    },
    cleanup: { success: databaseEvidence?.isolatedLoopbackProjects === true && ownerEvidence?.isolatedLoopbackProjects === true },
    expectedToolVersions: expectedVersions,
    evidenceArtifacts: artifacts,
    evidenceSummary: safeEvidenceSummary({ contextEvidence, integratedEvidence, databaseEvidence, ownerEvidence }),
    failures: [
      ...evaluated.failures,
      ...artifactFailures,
      ...(finalRevision === sourceRevision ? [] : ["HEAD changed while the gate was running"]),
      ...(finalTree === initialTree ? [] : ["source tree changed while the gate was running"]),
    ],
  };
  report.failureCount = report.failures.length;
  report.verdict = report.failureCount === 0 ? "pass" : "fail";
  report.scenarioAcceptance = report.verdict === "pass";
  report.guarantees.evidenceBoundToSourceTreeAndRun = artifactFailures.length === 0;
  report.guarantees.allRequiredEvidenceFresh = report.guarantees.evidenceBoundToSourceTreeAndRun;
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ticket: report.ticket,
    runId: report.runId,
    sourceRevision: report.sourceRevision,
    sourceTreeSha256: report.sourceTreeSha256,
    verdict: report.verdict,
    counts: report.counts,
    passedChecks: checks.filter((check) => check.passed).map((check) => check.name),
    failedChecks: checks.filter((check) => !check.passed).map((check) => ({ name: check.name, failure: check.failure })),
    failures: report.failures,
    evidence: "evidence/phase-5-gate-report.json",
  }, null, 2));
  return report.verdict === "pass" ? 0 : 1;
}

function reportPassesDatabaseChecks(checks, databaseEvidence) {
  return databaseEvidence?.isolatedLoopbackProjects === true && databaseEvidence?.cleanUpgradeEquivalent === true &&
    checks.some((check) => check.name === "owner-postgres" && check.executed === true && check.passed === true) &&
    checks.some((check) => check.name === "database-rls-postgres" && check.executed === true && check.passed === true);
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/phase5-gate.mjs")) {
  process.exitCode = await main();
}
