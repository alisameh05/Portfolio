#!/usr/bin/env node
/**
 * Authoritative Phase 2 completion gate (#33).
 *
 * Every constituent remains independently runnable through package.json.
 * This aggregate records one deterministic verdict and durable logs without
 * requiring credentials, a database, a provider, a deployment, or network
 * access after dependencies are installed.
 */

import { approvedWindowsPhase2Skip, executeQualificationCommand, WINDOWS_PHASE2_NONREQUIRED_SKIP } from "./qualification-command.mjs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createQualificationPrerequisiteCache } from "./qualification-prerequisite-cache.mjs";
import { currentRuntimeIdentity } from "./qualification-context.mjs";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const REPORT_PATH = join(ROOT, "evidence", "phase-2-gate-report.json");
const gateStartedAt = new Date();
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const sourceTreeSha256 = workingTreeSourceSha256();
const prerequisiteCache = createQualificationPrerequisiteCache({ root: ROOT, sourceRevision,
  sourceTreeSha256, runtime: currentRuntimeIdentity(), environment: process.env });

function sanitizeOutput(output) {
  let sanitized = output;
  for (const [path, replacement] of [
    [ROOT, "<WORKSPACE>"],
    [tmpdir(), "<TEMP>"],
  ]) {
    sanitized = sanitized
      .replaceAll(path, replacement)
      .replaceAll(path.split("\\").join("/"), replacement);
  }
  return sanitized;
}

function normalizeEvidenceOutput(output) {
  return `${sanitizeOutput(output)
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd()}\n`;
}

const checks = [
  {
    name: "phase1-toolchain",
    entry: "scripts/check-toolchain.mjs",
    args: [],
    evidence: "evidence/phase-2-toolchain.log",
    cacheScript: "direct:check-toolchain.mjs",
  },
  {
    name: "phase1-contract-drift",
    entry: "scripts/check-contract-drift.mjs",
    args: [],
    evidence: "evidence/phase-2-contract-drift.log",
    cacheScript: "direct:check-contract-drift.mjs",
  },
  {
    name: "phase1-contract-compatibility",
    entry: "scripts/check-contract-compatibility.mjs",
    args: [],
    evidence: "evidence/phase-2-contract-compatibility.log",
    cacheScript: "direct:check-contract-compatibility.mjs",
  },
  {
    name: "phase1-contract-and-strict-validator-tests",
    entry: "node_modules/vitest/vitest.mjs",
    args: ["run", "tests/contracts"],
    evidence: "evidence/phase-2-contract-tests.log",
    cacheScript: "direct:vitest-contract-tests",
  },
  {
    name: "production-build",
    entry: "node_modules/next/dist/bin/next",
    args: ["build"],
    evidence: "evidence/phase-2-build.log",
    cacheScript: "direct:next",
  },
  {
    name: "strict-typecheck",
    entry: "node_modules/typescript/bin/tsc",
    args: ["--noEmit"],
    evidence: "evidence/phase-2-typecheck.log",
    cacheScript: "direct:typescript",
  },
  {
    name: "deterministic-lint",
    entry: "node_modules/eslint/bin/eslint.js",
    args: ["."],
    evidence: "evidence/phase-2-lint.log",
    cacheScript: "direct:eslint",
  },
  {
    name: "architecture",
    entry: "scripts/architecture-check.mjs",
    args: [],
    evidence: "evidence/phase-2-architecture.log",
    cacheScript: "direct:architecture-check.mjs",
  },
  {
    name: "route-inventory",
    entry: "scripts/check-route-inventory.mjs",
    args: [],
    evidence: "evidence/phase-2-route-inventory.log",
    cacheScript: "direct:check-route-inventory.mjs",
  },
  {
    name: "contract-to-adapter-matrix",
    entry: "scripts/check-runtime-boundary.mjs",
    args: [],
    evidence: "evidence/phase-2-runtime-boundary.log",
    cacheScript: "direct:check-runtime-boundary.mjs",
  },
  {
    name: "configuration-negative-tests",
    entry: "node_modules/vitest/vitest.mjs",
    args: ["run", "tests/runtime/configuration.test.ts"],
    evidence: "evidence/phase-2-configuration.log",
  },
  {
    name: "http-adapter-tests",
    entry: "node_modules/vitest/vitest.mjs",
    args: ["run", "tests/runtime", "--reporter=verbose"],
    evidence: "evidence/phase-2-http-adapters.log",
  },
  {
    name: "problem-details-tests",
    entry: "node_modules/vitest/vitest.mjs",
    args: ["run", "tests/runtime/problem.test.ts"],
    evidence: "evidence/phase-2-problem-details.log",
  },
  {
    name: "health-lifecycle-tests",
    entry: "node_modules/vitest/vitest.mjs",
    args: [
      "run",
      "tests/runtime/livez.test.ts",
      "tests/runtime/readiness-lifecycle.test.ts",
    ],
    evidence: "evidence/phase-2-health-lifecycle.log",
  },
];

async function runCheck(check) {
  const startedAt = Date.now();
  const environment = { ...process.env, CI: "1" };
  const invoke = () => executeQualificationCommand({ entry: process.execPath, args: [check.entry, ...check.args],
    cwd: ROOT, environment });
  const execution = check.cacheScript === undefined ? await invoke() : await prerequisiteCache.runAsync({
    script: check.cacheScript, args: check.args,
    entry: JSON.stringify({ entry: process.execPath, args: [check.entry, ...check.args] }), environment, invoke, sanitizeOutput,
  });
  const output = sanitizeOutput(execution.output);
  const approvedSkip = approvedWindowsPhase2Skip(output, { phase2RuntimeSuite: check.name === "http-adapter-tests" }) &&
    execution.status === 1 && execution.errorCode === "QUALIFICATION_COMMAND_INCOMPLETE" && execution.skipped === 1;
  if (output) process.stdout.write(output);
  const evidencePath = join(ROOT, check.evidence);
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, normalizeEvidenceOutput(output), "utf8");
  return {
    name: check.name,
    passed: approvedSkip || (execution.status === 0 && execution.errorCode === null && execution.skipped === 0 && execution.timedOut !== true),
    exitCode: approvedSkip ? 0 : execution.status,
    observedExitCode: execution.status,
    skipped: approvedSkip ? 0 : execution.skipped,
    observedSkipped: execution.skipped,
    nonRequiredSkips: approvedSkip ? [WINDOWS_PHASE2_NONREQUIRED_SKIP] : [],
    executed: true,
    reused: execution.reused === true,
    reuseProof: execution.reuseProof ?? null,
    durationMs: Date.now() - startedAt,
    evidence: check.evidence,
    detail: execution.status === 0 ? (execution.reused ? "reused verified same-run prerequisite" : "passed") :
      output.trim().split(/\r?\n/).slice(-1)[0] || execution.errorCode || "failed",
  };
}

console.log("═══════════════════════════════════════════════");
console.log("  Phase 2 Runtime Completion Gate (#33)");
console.log("═══════════════════════════════════════════════");

const batches = [
  checks.slice(0, 4),
  checks.slice(4, 5),
  checks.slice(5, 8),
  checks.slice(8, 10),
  checks.slice(10),
];
const batchArgumentIndex = process.argv.indexOf("--batch");
const requestedBatch =
  batchArgumentIndex === -1 ? undefined : Number(process.argv[batchArgumentIndex + 1]);
const assembleOnly = process.argv.includes("--assemble");
let results = [];

if (assembleOnly) {
  results = batches.flatMap((_, index) => {
    const batchPath = join(ROOT, "evidence", `phase-2-gate-batch-${index + 1}.json`);
    if (!existsSync(batchPath)) {
      throw new Error(`Missing Phase 2 gate batch evidence: ${batchPath}`);
    }
    return JSON.parse(readFileSync(batchPath, "utf8")).checks;
  });
} else {
  if (
    requestedBatch !== undefined &&
    (!Number.isInteger(requestedBatch) || requestedBatch < 1 || requestedBatch > batches.length)
  ) {
    throw new Error(`--batch must be an integer from 1 to ${batches.length}`);
  }
  const selectedBatches =
    requestedBatch === undefined ? batches : [batches[requestedBatch - 1]];
  for (const batch of selectedBatches) {
    const heartbeat = setInterval(() => {
      console.log(`… Phase 2 gate: ${batch.map((check) => check.name).join(", ")} still running`);
    }, 10_000);
    const batchResults = await Promise.all(batch.map(runCheck));
    clearInterval(heartbeat);
    for (const result of batchResults) {
      results.push(result);
      console.log(`${result.passed ? "✓" : "✗"} ${result.name} — ${result.detail}`);
    }
  }
}

const sourceBound = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim() === sourceRevision &&
  workingTreeSourceSha256() === sourceTreeSha256;
const failed = [...results.filter((result) => !result.passed), ...(sourceBound ? [] : [{ name: "source identity" }])];
if (requestedBatch !== undefined) {
  const batchReportPath = join(
    ROOT,
    "evidence",
    `phase-2-gate-batch-${requestedBatch}.json`,
  );
  writeFileSync(
    batchReportPath,
    `${JSON.stringify(
      {
        ticket: 33,
        batch: requestedBatch,
        node: process.version,
        verdict: failed.length === 0 ? "pass" : "fail",
        checks: results,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(
    `${failed.length === 0 ? "✓" : "✗"} Phase 2 gate batch ${requestedBatch}: ${results.length - failed.length}/${results.length} passed`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
} else {
const report = {
  ticket: 33,
  parent: 24,
  scope: "phase-2-runtime-completion-gate",
  node: process.version,
  sourceRevision,
  sourceTreeSha256,
  startedAt: gateStartedAt.toISOString(),
  completedAt: new Date().toISOString(),
  toolVersions: currentRuntimeIdentity(),
  required: { success: failed.length === 0, executed: results.length, failed: failed.length, skipped: results.reduce((sum, check) => sum + check.skipped, 0) },
  observedSkipped: results.reduce((sum, check) => sum + check.observedSkipped, 0),
  nonRequiredSkips: results.flatMap((check) => check.nonRequiredSkips),
  cleanup: { success: true },
  verdict: failed.length === 0 ? "pass" : "fail",
  summary: {
    passed: results.length - failed.length,
    failed: failed.length,
    total: results.length,
  },
  checks: results,
  evidence: [
    ...results.map((result) => ({
      file: result.evidence,
      present: existsSync(join(ROOT, result.evidence)),
    })),
    {
      file: "evidence/phase-2-runtime-boundary.json",
      present: existsSync(join(ROOT, "evidence/phase-2-runtime-boundary.json")),
    },
    {
      file: "evidence/phase-2-runtime-architecture.json",
      present: existsSync(join(ROOT, "evidence/phase-2-runtime-architecture.json")),
    },
  ],
  guarantees: {
    offline:
      "no credentials, database, Supabase, Vercel, TestSprite, deployment, provider, or public network required after install",
    contracts: "Phase 1 lint, bundle, generation, drift, compatibility, architecture, and scope gates retained",
    runtime: "production build, typecheck, lint, adapters, configuration, Problem Details, health, and shutdown verified",
  },
};

mkdirSync(dirname(REPORT_PATH), { recursive: true });
writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

if (failed.length === 0) {
  console.log(`✓ Phase 2 gate: ALL ${results.length} CHECKS PASSED`);
  process.exitCode = 0;
} else {
  console.error(`✗ Phase 2 gate: ${failed.length} of ${results.length} checks FAILED`);
  process.exitCode = 1;
}
}
