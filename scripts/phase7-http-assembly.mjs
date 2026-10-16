#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sanitizePhase7Output } from "./phase7-gate-support.mjs";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const REPORT = join(ROOT, "evidence/phase7-http-assembly-207.json");
const VITEST_REPORT = join(ROOT, "artifacts/phase7-http-assembly-vitest.json");
const ROUTE_REPORT = join(ROOT, "evidence/phase-1-route-inventory.json");
const ROUTE_TESTS = Object.freeze([
  "tests/runtime/feedback-limits.test.ts", "tests/runtime/feedback.test.ts", "tests/runtime/owner-analytics.test.ts",
  "tests/runtime/owner-moderation.test.ts", "tests/runtime/phase7-contracts.test.ts", "tests/runtime/phase7-runtime-fail-closed.test.ts",
  "tests/runtime/public-event.test.ts", "tests/runtime/rating.test.ts", "tests/runtime/reaction.test.ts",
]);

function git(args) {
  return spawnSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).stdout.trim();
}

function main() {
  const startedAt = new Date().toISOString();
  const runId = randomUUID();
  const sourceRevision = git(["rev-parse", "HEAD"]);
  const sourceTreeSha256 = workingTreeSourceSha256();
  const routeInventory = JSON.parse(readFileSync(ROUTE_REPORT, "utf8"));
  if (routeInventory.publicOperations?.length !== 5 || routeInventory.ownerOperations?.length !== 48 ||
      routeInventory.operationalRoutes?.length !== 2 || routeInventory.runtimeRoutes?.length !== 0 ||
      !Array.isArray(routeInventory.checks) || routeInventory.checks.some((check) => check.passed !== true)) {
    throw new Error("PHASE7_HTTP_ROUTE_BOUNDARY_INVALID");
  }
  const phase7PublicOperations = routeInventory.publicOperations.filter((operation) =>
    operation.includes("/api/v1/events") || operation.includes("/api/v1/projects/"));
  const phase7OwnerOperations = routeInventory.ownerOperations.filter((operation) =>
    operation.includes("/api/owner/v1/feedback/") || operation.includes("/api/owner/v1/analytics-goals/"));
  if (phase7PublicOperations.length !== 4 || phase7OwnerOperations.length !== 7) throw new Error("PHASE7_HTTP_OPERATION_MATRIX_INVALID");

  const args = ["node_modules/vitest/vitest.mjs", "run", ...ROUTE_TESTS, "--reporter=json", `--outputFile=${VITEST_REPORT}`];
  const result = spawnSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: "1" }, encoding: "utf8",
    windowsHide: true, timeout: 20 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
  const output = sanitizePhase7Output(`${result.stdout ?? ""}${result.stderr ?? ""}`, { workspace: ROOT });
  if (output) process.stdout.write(output);
  let tests;
  try { tests = JSON.parse(readFileSync(VITEST_REPORT, "utf8")); } catch { throw new Error("PHASE7_HTTP_TEST_REPORT_MISSING"); }
  const passed = Number(tests.numPassedTests ?? 0);
  const failed = Number(tests.numFailedTests ?? 0);
  const skipped = Number(tests.numPendingTests ?? 0) + Number(tests.numTodoTests ?? 0);
  const failedSuites = Number(tests.numFailedTestSuites ?? 0);
  if (result.error || result.status !== 0 || tests.success !== true || passed === 0 || failed !== 0 || skipped !== 0 || failedSuites !== 0) {
    throw new Error("PHASE7_HTTP_REQUIRED_TESTS_INCOMPLETE");
  }
  if (workingTreeSourceSha256() !== sourceTreeSha256) throw new Error("PHASE7_HTTP_SOURCE_CHANGED_DURING_ACCEPTANCE");

  let previousReport = {};
  try { previousReport = JSON.parse(readFileSync(REPORT, "utf8")); } catch { /* first report for this checkout */ }
  const report = {
    ...previousReport,
    ticket: 207, runId, sourceRevision, sourceTreeSha256, startedAt, completedAt: new Date().toISOString(),
    tools: { node: process.versions.node, npm: (process.env.npm_config_user_agent ?? "").match(/npm\/([^\s]+)/u)?.[1] ?? "unavailable" },
    routes: { publicOperations: routeInventory.publicOperations.length, ownerOperations: routeInventory.ownerOperations.length,
      operationalRoutes: routeInventory.operationalRoutes.length, runtimeRoutes: routeInventory.runtimeRoutes.length,
      phase7PublicMutations: phase7PublicOperations.length, phase7OwnerOperations: phase7OwnerOperations.length },
    required: { success: true, passed, failed, skipped, failedSuites },
    refreshedAcceptance: { suites: ROUTE_TESTS, routes: { publicOperations: routeInventory.publicOperations,
      ownerOperations: routeInventory.ownerOperations, operationalRoutes: routeInventory.operationalRoutes,
      runtimeRoutes: routeInventory.runtimeRoutes }, vitestCounts: { passed, failed, skipped, failedSuites },
      outputSha256: createHash("sha256").update(readFileSync(VITEST_REPORT)).digest("hex") },
    suites: ROUTE_TESTS.map((path) => ({ path, executed: true })),
    reproduction: "npm run setup:validation; npm run validation:ready; npm run route:inventory; npm run phase7:http:assembly",
    cleanup: true,
  };
  mkdirSync(dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ticket: 207, runId, required: report.required, routes: report.routes, evidence: "evidence/phase7-http-assembly-207.json" }));
}

try { main(); }
catch (error) { console.error(error instanceof Error && /^PHASE7_HTTP_/.test(error.message) ? error.message : "PHASE7_HTTP_ASSEMBLY_FAILED"); process.exitCode = 1; }
