#!/usr/bin/env node
/**
 * Authoritative Phase 2 completion gate (#33).
 *
 * Every constituent remains independently runnable through package.json.
 * This aggregate records one deterministic verdict and durable logs without
 * requiring credentials, a database, a provider, a deployment, or network
 * access after dependencies are installed.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const REPORT_PATH = join(ROOT, "evidence", "phase-2-gate-report.json");

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

const checks = [
  {
    name: "phase1-toolchain",
    entry: "scripts/check-toolchain.mjs",
    args: [],
    evidence: "evidence/phase-2-toolchain.log",
  },
  {
    name: "phase1-contract-drift",
    entry: "scripts/check-contract-drift.mjs",
    args: [],
    evidence: "evidence/phase-2-contract-drift.log",
  },
  {
    name: "phase1-contract-compatibility",
    entry: "scripts/check-contract-compatibility.mjs",
    args: [],
    evidence: "evidence/phase-2-contract-compatibility.log",
  },
  {
    name: "phase1-contract-and-strict-validator-tests",
    entry: "node_modules/vitest/vitest.mjs",
    args: ["run", "tests/contracts"],
    evidence: "evidence/phase-2-contract-tests.log",
  },
  {
    name: "production-build",
    entry: "node_modules/next/dist/bin/next",
    args: ["build"],
    evidence: "evidence/phase-2-build.log",
  },
  {
    name: "strict-typecheck",
    entry: "node_modules/typescript/bin/tsc",
    args: ["--noEmit"],
    evidence: "evidence/phase-2-typecheck.log",
  },
  {
    name: "deterministic-lint",
    entry: "node_modules/eslint/bin/eslint.js",
    args: ["."],
    evidence: "evidence/phase-2-lint.log",
  },
  {
    name: "architecture",
    entry: "scripts/architecture-check.mjs",
    args: [],
    evidence: "evidence/phase-2-architecture.log",
  },
  {
    name: "route-inventory",
    entry: "scripts/check-route-inventory.mjs",
    args: [],
    evidence: "evidence/phase-2-route-inventory.log",
  },
  {
    name: "contract-to-adapter-matrix",
    entry: "scripts/check-runtime-boundary.mjs",
    args: [],
    evidence: "evidence/phase-2-runtime-boundary.log",
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
    args: ["run", "tests/runtime"],
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

function runCheck(check) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [check.entry, ...check.args], {
      cwd: ROOT,
      env: { ...process.env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
      process.stdout.write(sanitizeOutput(chunk.toString("utf8")));
    });
    child.stderr.on("data", (chunk) => {
      chunks.push(chunk);
      process.stderr.write(sanitizeOutput(chunk.toString("utf8")));
    });
    let spawnError;
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (exitCode) => {
      const output = sanitizeOutput(Buffer.concat(chunks).toString("utf8"));
      const evidencePath = join(ROOT, check.evidence);
      mkdirSync(dirname(evidencePath), { recursive: true });
      writeFileSync(
        evidencePath,
        output.endsWith("\n") ? output : `${output}\n`,
        "utf8",
      );
      resolve({
        name: check.name,
        passed: exitCode === 0 && spawnError === undefined,
        exitCode: exitCode ?? 1,
        durationMs: Date.now() - startedAt,
        evidence: check.evidence,
        detail:
          spawnError instanceof Error
            ? spawnError.message
            : exitCode === 0
              ? "passed"
              : output.trim().split(/\r?\n/).slice(-1)[0] || "failed",
      });
    });
  });
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

const failed = results.filter((result) => !result.passed);
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
