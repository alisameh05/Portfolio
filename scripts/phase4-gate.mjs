#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

import {
  classifyCheckResult,
  databaseEvidenceShapeErrors,
  evaluateGate,
  REQUIRED_PHASE4_CHECK_NAMES,
  sanitizeEvidenceOutput,
} from "./phase4-gate-support.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const REPORT = join(ROOT, "evidence", "phase-4-gate-report.json");
const startedAt = Date.now();
const runId = randomUUID();
const revision = gitRevision();
const sourceTreeSha256 = workingTreeSourceSha256();

const checks = [
  { name: "validation-ready", npmScript: "validation:ready", args: [] },
  {
    name: "predecessor-phase1",
    entry: "scripts/phase1-gate.mjs",
    args: [],
    env: { SHIPWITHALI_PHASE: "phase1" },
    failOnSkipped: true,
  },
  {
    name: "predecessor-phase2",
    entry: "scripts/phase2-gate.mjs",
    args: [],
    env: { SHIPWITHALI_PHASE: "phase2" },
    // Phase 2 has one explicit Windows-only skip for helper-process cleanup.
    // Its own gate verdict remains required; every other skip still fails.
    failOnSkipped: true,
    allowWindowsPhase2HelperProcessSkip: process.platform === "win32",
  },
  {
    name: "predecessor-phase3-source",
    entry: "scripts/check-phase3-database.mjs",
    args: ["--source-only"],
    env: { SHIPWITHALI_PHASE: "phase4" },
    failOnSkipped: true,
  },
  { name: "exact-toolchain", entry: "scripts/check-toolchain.mjs", args: [] },
  { name: "contract-verification", npmScript: "contract:verify", args: [] },
  { name: "tooling-tests", npmScript: "test:setup", args: [] },
  { name: "typecheck", entry: "node_modules/typescript/bin/tsc", args: ["--noEmit"] },
  { name: "lint", entry: "node_modules/eslint/bin/eslint.js", args: ["."] },
  { name: "production-build", entry: "node_modules/next/dist/bin/next", args: ["build"] },
  { name: "architecture", entry: "scripts/architecture-check.mjs", args: [] },
  { name: "route-inventory", entry: "scripts/check-route-inventory.mjs", args: [] },
  { name: "runtime-boundary", entry: "scripts/check-runtime-boundary.mjs", args: [] },
  { name: "runtime-architecture", entry: "scripts/check-runtime-architecture.mjs", args: [] },
  { name: "phase4-context", entry: "scripts/check-phase4-context.mjs", args: [], failOnSkipped: true },
  {
    name: "phase4-focused-tests",
    entry: "node_modules/vitest/vitest.mjs",
    args: ["run", "tests/phase4", "--exclude", "tests/phase4/local-auth-token.integration.test.ts"],
    failOnSkipped: true,
  },
  {
    name: "phase4-migration-integrity-tests",
    entry: "node_modules/vitest/vitest.mjs",
    args: ["run", "tests/database/phase4-migration-integrity.test.ts"],
    failOnSkipped: true,
  },
  {
    name: "phase4-local-auth-real-token",
    entry: "scripts/local-auth-integration.mjs",
    args: [],
    failOnSkipped: true,
    requiresService: "disposable loopback Supabase Auth and Docker",
  },
  {
    name: "phase4-database-integrity",
    entry: "scripts/portfolio-settings-integration.mjs",
    args: [],
    failOnSkipped: true,
    requiresService: "disposable loopback PostgreSQL and Docker",
  },
];

function gitRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function sanitize(value) {
  const secrets = Object.entries(process.env)
    .filter(([name, secret]) => /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SERVICE_ROLE_KEY)/i.test(name) && secret.length >= 6)
    .map(([, secret]) => secret);
  return sanitizeEvidenceOutput(value, { workspace: ROOT, temporary: tmpdir(), secrets });
}

function npmCommand(script, args) {
  if (process.env.npm_execpath) {
    return { entry: process.execPath, args: [process.env.npm_execpath, "run", script, ...args] };
  }
  return {
    entry: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["run", script, ...args],
    shell: process.platform === "win32",
  };
}

function run(check) {
  return new Promise((resolve) => {
    const command = check.npmScript
      ? npmCommand(check.npmScript, check.args)
      : { entry: process.execPath, args: [check.entry, ...check.args] };
    const child = spawn(command.entry, command.args, {
      cwd: ROOT,
      env: { ...process.env, CI: "1", SHIPWITHALI_PHASE: "phase4", ...check.env },
      shell: command.shell ?? false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    let spawnError;
    child.on("error", (error) => { spawnError = error; });
    const heartbeat = setInterval(() => console.log(`… ${check.name} still running`), 10_000);
    child.on("close", (code) => {
      clearInterval(heartbeat);
      const output = sanitize(Buffer.concat(chunks).toString("utf8"))
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .join("\n")
        .trimEnd();
      const evidence = `evidence/phase-4-${check.name}.log`;
      const evidencePath = join(ROOT, evidence);
      mkdirSync(dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, `${output}\n`, "utf8");
      if (output) process.stdout.write(`${output}\n`);

      const classified = classifyCheckResult({
        code: code ?? 1,
        spawnError,
        output,
        failOnSkipped: check.failOnSkipped ?? false,
        allowWindowsPhase2HelperProcessSkip: check.allowWindowsPhase2HelperProcessSkip ?? false,
        requiresService: check.requiresService ?? null,
      });
      if (classified.failure) {
        console.error(`✗ ${check.name}: ${classified.failure}`);
      }
      resolve({ name: check.name, ...classified, evidence });
    });
  });
}

function evidenceRecord(file) {
  const path = join(ROOT, file);
  const present = existsSync(path);
  const fresh = present && statSync(path).mtimeMs >= startedAt;
  return {
    file,
    runId,
    revision,
    sourceTreeSha256,
    fresh,
    sha256: present ? createHash("sha256").update(readFileSync(path)).digest("hex") : null,
  };
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(join(ROOT, path), "utf8"));
  } catch {
    return null;
  }
}

function packageVersions() {
  const packageJson = readJson("package.json") ?? {};
  const userAgent = process.env.npm_config_user_agent ?? "";
  const npm = userAgent.match(/(?:^|\s)npm\/([^\s]+)/)?.[1] ?? "unknown";
  return {
    node: process.version,
    npm,
    requiredNode: packageJson.engines?.node ?? null,
    requiredNpm: packageJson.engines?.npm ?? null,
    packageManager: packageJson.packageManager ?? null,
  };
}

function phase4Coverage(database) {
  const databaseState = database?.normalizedDatabaseState;
  const validDatabaseState = databaseEvidenceShapeErrors(database).length === 0;
  const phase4Schema = new Set(["identity_access", "portfolio_config"]);
  return {
    authentication: {
      deterministicTests: "tests/phase4/owner-session-auth.test.ts",
      realAdapter: "tests/phase4/local-auth-token.integration.test.ts",
      realTokenRunner: "scripts/local-auth-integration.mjs",
      localFixtureOnly: true,
      liveGitHubExchange: false,
      productionOrStagingCredentials: false,
      scenarios: ["valid Owner", "missing or malformed token", "signature and key", "issuer and audience", "expiry", "revocation", "non-GitHub", "non-Owner", "allowlist removal", "provider unavailable"],
    },
    authorizationCsrfCookiesAndPrivacy: {
      testFiles: ["tests/phase4/owner-operation-policy.test.ts", "tests/phase4/owner-request-security.test.ts"],
      scenarios: ["Owner and unsupported-operation policy", "cookie flags", "same-origin", "CSRF proof", "forged forwarded host", "rate limits", "denied-request no-effects", "safe Problem Details and redaction"],
    },
    independentIdentitiesAndConsent: {
      testFiles: ["tests/phase4/pseudonymous-identity.test.ts", "tests/phase4/functional-identity-orchestration.test.ts"],
      scenarios: ["separate keys and subjects", "affirmative consent", "denied and unknown consent", "withdrawal", "purpose substitution", "expiry", "key rotation", "no cross-purpose persistence or private log fields"],
    },
    settingsContracts: {
      testFiles: ["tests/phase4/portfolio-profile-command.test.ts", "tests/phase4/portfolio-contact-channels-command.test.ts", "tests/phase4/portfolio-cta-command.test.ts", "tests/phase4/portfolio-settings-service.test.ts", "tests/phase4/identity-configuration-contracts.test.ts"],
      realPostgresIntegration: "tests/database/portfolio-settings.integration.test.ts",
      generatedTypeDrift: database?.generatedTypeDrift === false,
    },
    database: database === null ? null : {
      migrationSnapshot: database.phase3Snapshot,
      predecessorDatabaseTests: database.predecessorDatabaseTests,
      migrationIdsAndChecksums: database.migrationChecksums,
      migrationLedger: database.migrationLedger,
      cleanUpgradeEquivalent: database.cleanUpgradeEquivalent,
      migrationReplayNoop: database.migrationReplayNoop,
      normalizedCleanUpgradeDiff: database.normalizedCleanUpgradeDiff,
      schemaStateSha256: database.normalizedStateSha256,
      forcedRlsTables: database.applicationTablesWithForcedRls,
      grants: validDatabaseState ? databaseState.grants.filter((grant) => phase4Schema.has(grant.schema)) : null,
      policies: validDatabaseState ? databaseState.policies.filter((policy) => phase4Schema.has(policy.schema)) : null,
      restrictedPrincipalMatrix: database.restrictedPrincipalMatrix,
      phase3OperationsRowsPreserved: database.phase3OperationsRowsPreserved,
      generatedTypeDrift: database.generatedTypeDrift,
      databaseIntegrationTestsPassed: database.databaseIntegrationTestsPassed,
      databaseTestResults: database.databaseTestResults,
      skippedCases: database.skippedCases,
      sanitizedAuditExamples: database.sanitizedAuditExamples,
      evidenceFile: "evidence/phase-4-database-integrity.json",
    },
    architectureContractsAndBuild: {
      publicOperations: 5,
      backendOnly: true,
      providerSeamsChecked: true,
      contractGenerationDriftAndCompatibility: true,
      checkNames: ["architecture", "route-inventory", "runtime-boundary", "runtime-architecture", "contract-verification", "production-build"],
    },
  };
}

async function main() {
  console.log("═══════════════════════════════════════════════");
  console.log("  Phase 4 Completion Gate (#90)");
  console.log(`  Run ${runId} · ${revision}`);
  console.log("═══════════════════════════════════════════════");

  const results = [];
  let validationReady = true;
  for (const check of checks) {
    if (!validationReady && check.name !== "validation-ready") {
      const evidence = `evidence/phase-4-${check.name}.log`;
      writeFileSync(join(ROOT, evidence), "Not run because validation:ready failed.\n", "utf8");
      results.push({ name: check.name, passed: false, exitCode: 1, failure: "validation-not-ready", evidence });
      continue;
    }
    const result = await run(check);
    results.push(result);
    if (check.name === "validation-ready" && !result.passed) validationReady = false;
  }

  const requiredEvidence = [
    ...results.map((result) => result.evidence),
    "evidence/phase-1-gate-report.json",
    "evidence/phase-2-gate-report.json",
    "evidence/phase-4-context.json",
    "evidence/phase-4-database-integrity.json",
  ];
  const evidence = requiredEvidence.map(evidenceRecord);
  const gate = evaluateGate({
    checks: results,
    requiredCheckNames: REQUIRED_PHASE4_CHECK_NAMES,
    evidence,
    runId,
    revision,
  });
  const database = readJson("evidence/phase-4-database-integrity.json");
  const finalRevision = gitRevision();
  const finalSourceTreeSha256 = workingTreeSourceSha256();
  const sourceIdentityStable = finalRevision === revision && finalSourceTreeSha256 === sourceTreeSha256;
  const evidenceValidationErrors = databaseEvidenceShapeErrors(database);
  const allPassed =
    gate.verdict === "pass" &&
    revision !== "unknown" &&
    database !== null &&
    evidenceValidationErrors.length === 0 &&
    database.skippedCases === 0 &&
    database.generatedTypeDrift === false && sourceIdentityStable;
  const report = {
    ticket: 90,
    parent: 77,
    scope: "phase-4-completion-gate-and-reproducible-evidence",
    runId,
    generatedAt: new Date().toISOString(),
    revision,
    sourceTreeSha256,
    toolVersions: packageVersions(),
    verdict: allPassed ? "pass" : "fail",
    checks: results,
    missingChecks: gate.missingChecks,
    duplicateChecks: gate.duplicateChecks,
    failedChecks: gate.failedChecks,
    staleOrMissingEvidence: gate.staleEvidence,
    evidenceValidationErrors,
    cleanup: { success: results.filter((result) => ["phase4-local-auth-real-token", "phase4-database-integrity"].includes(result.name))
      .every((result) => result.passed) && database?.isolatedLoopbackProjects === true },
    evidence,
    coverage: phase4Coverage(database),
    realServiceScope: {
      runId,
      gateRunId: runId,
      sourceRevision: revision,
      sourceTreeSha256,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      postgresVersion: database?.postgresVersion ?? null,
      isolation: "isolated-loopback",
      required: { success: results.find((result) => result.name === "phase4-database-integrity")?.passed === true },
      cleanUpgrade: { equivalent: database?.cleanUpgradeEquivalent === true },
      services: {
        postgres: { available: database?.isolatedLoopbackProjects === true, executionCount: database?.databaseIntegrationTestsPassed ?? 0 },
        auth: { available: results.find((result) => result.name === "phase4-local-auth-real-token")?.passed === true,
          executionCount: results.find((result) => result.name === "phase4-local-auth-real-token")?.passed === true ? 1 : 0 },
      },
      checks: results.filter((result) => ["phase4-database-integrity", "phase4-local-auth-real-token"].includes(result.name))
        .map((result) => ({ name: result.name, executed: true, passed: result.passed })),
      cleanup: results.filter((result) => ["phase4-database-integrity", "phase4-local-auth-real-token"].includes(result.name))
        .every((result) => result.passed) && database?.isolatedLoopbackProjects === true,
    },
    guarantees: {
      predecessorInvariantCoverage: "Phase 1 and Phase 2 historical gates, Phase 3 source and database invariants on the Phase 3 migration snapshot, and Phase 3 migration preservation through current Phase 4 upgrade/RLS checks",
      currentPhase: "Phase 4 context check and focused checks",
      localServices: "only isolated disposable loopback Auth/PostgreSQL projects",
      remoteCredentialsRequired: false,
      liveGitHubExchangeRequired: false,
      remoteMigrationsOrAuthConfiguration: false,
      deployedServicesRequired: false,
      secretsAndRawPrivatePayloadsRecorded: false,
      missingSkippedPartialConstituentOrStaleEvidenceFails: true,
      sourceBound: sourceIdentityStable,
      successfulCleanup: results.filter((result) => ["phase4-local-auth-real-token", "phase4-database-integrity"].includes(result.name))
        .every((result) => result.passed) && database?.isolatedLoopbackProjects === true,
    },
  };
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (report.verdict === "pass") {
    console.log(`✓ Phase 4 gate: ALL ${results.length} CHECKS PASSED`);
    process.exitCode = 0;
  } else {
    console.error(`✗ Phase 4 gate: ${gate.failedChecks.length} constituent failures, ${gate.missingChecks.length} missing checks, ${gate.staleEvidence.length} stale/missing evidence items, ${evidenceValidationErrors.length} invalid evidence fields`);
    process.exitCode = 1;
  }
}

await main();
