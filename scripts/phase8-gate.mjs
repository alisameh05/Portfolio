#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { observeRuntime, verifyEnvironment } from "./validation-environment.mjs";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";
import { evaluatePhase8Gate, PHASE8_GATE_COMPONENTS, PHASE8_GATE_CRITERION_MATRIX, PHASE8_GATE_REQUIRED_CHECKS, PHASE8_GATE_SCENARIOS, readBoundArtifact } from "./phase8-gate-support.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const EVIDENCE = join(ROOT, "evidence");
const REPORT = join(EVIDENCE, "phase8-gate-report.json");
const LOGS = join(EVIDENCE, "phase8-gate-checks");
const COMMANDS = [
  ["phase8-prerequisites", "phase8:qualify"], ["integrated", "phase8:focus:integrated"],
  ["contract-verification", "contract:verify"], ["architecture", "test:arch"], ["runtime-boundary", "runtime:boundary"],
  ["lint", "lint"], ["typecheck", "typecheck"], ["production-build", "build"],
  ["gate-negative-tests", "test:phase8:gate"],
];
function git(args) { return spawnSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true }).stdout.trim(); }
function run(name, script) {
  const startedAt = new Date().toISOString();
  const entry = process.env.npm_execpath ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm");
  const args = process.env.npm_execpath ? [process.env.npm_execpath, "run", script] : ["run", script];
  const result = spawnSync(entry, args, { cwd: ROOT, encoding: "utf8", windowsHide: true, shell: process.platform === "win32" && !process.env.npm_execpath, timeout: 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const safe = output.replace(/(?:postgres(?:ql)?:\/\/|https?:\/\/)[^\s]+/giu, "[redacted-url]").replace(/(?:password|secret|token|service_role_key)[=: ]+[^\s]+/giu, "[redacted]");
  writeFileSync(join(LOGS, `${name}.log`), safe, "utf8");
  const passed = result.status === 0 && !result.error;
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
  return { name, command: `npm run ${script}`, startedAt, executed: true, passed, exitCode: result.status ?? 1, skipped: 0, aggregateSuccess: passed,
    outputSha256: createHash("sha256").update(safe).digest("hex"), log: `evidence/phase8-gate-checks/${name}.log` };
}

async function main() {
  mkdirSync(LOGS, { recursive: true }); rmSync(REPORT, { force: true });
  const runId = randomUUID(), startedAt = new Date().toISOString(), sourceRevision = git(["rev-parse", "HEAD"]), sourceTreeSha256 = workingTreeSourceSha256();
  const runtime = observeRuntime();
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const readinessErrors = verifyEnvironment(ROOT, runtime);
  const checks = [{ name: "validation-ready", executed: true, passed: readinessErrors.length === 0, exitCode: readinessErrors.length ? 1 : 0, skipped: 0 }];
  if (readinessErrors.length === 0) for (const [name, script] of COMMANDS) checks.push(run(name, script));
  const stable = git(["rev-parse", "HEAD"]) === sourceRevision && workingTreeSourceSha256() === sourceTreeSha256;
  if (!stable) for (const check of checks) { check.passed = false; check.exitCode = 1; }
  const artifacts = [];
  for (const component of PHASE8_GATE_COMPONENTS) {
    try { artifacts.push(readBoundArtifact(ROOT, component, { sourceRevision, sourceTreeSha256, gateRunId: runId, scenarios: PHASE8_GATE_SCENARIOS.map(({ id }) => id) })); }
    catch { artifacts.push({ id: component.id, path: component.path, fresh: false, positiveExecution: false, aggregateSuccess: false, cleanup: false, sourceRevision: null, sourceTreeSha256: null, gateRunId: runId, sha256: "", scenarios: [] }); }
  }
  const readJson = (path) => { try { return JSON.parse(readFileSync(join(ROOT, path), "utf8")); } catch { return null; } };
  const integratedEvidence = readJson("evidence/phase8-integrated-verification-256.json");
  const prerequisiteEvidence = readJson("evidence/phase8-prerequisite-qualification.json");
  const result = evaluatePhase8Gate({ runId, startedAt, sourceRevision, sourceTreeSha256, runtime,
    expectedRuntime: { node: packageJson.engines.node, npm: packageJson.engines.npm }, checks, artifacts, integratedEvidence, prerequisiteEvidence });
  if (!stable) result.failures.push("source-changed-during-gate");
  const report = { schemaVersion: 1, ticket: 257, runId, startedAt, completedAt: new Date().toISOString(), source: { revision: sourceRevision,
    treeSha256: sourceTreeSha256, stableDuringRun: stable }, runtime, checks, artifacts, criterionMatrix: PHASE8_GATE_CRITERION_MATRIX, requiredCheckInventory: PHASE8_GATE_REQUIRED_CHECKS, scenarios: PHASE8_GATE_SCENARIOS,
    counts: result.counts, required: { success: result.verdict === "pass", failed: result.failures.length, skipped: checks.reduce((n, c) => n + (c.skipped ?? 0), 0),
      failedSuites: checks.filter((c) => c.passed !== true).length }, failures: result.failures, verdict: result.failures.length ? "fail" : "pass",
    statusLayers: { localAcceptance: result.failures.length ? "failed" : "passed", hostedCI: "separate", codexReview: "separate", humanApproval: "separate", merge: "separate", deployment: "separate",
      phase9Transport: "pending downstream qualification", phase10HostedInstallationAndProductionRecovery: "pending downstream qualification" },
    reproduction: "npm run setup:validation; npm run validation:ready; npm run phase8:gate", cleanup: integratedEvidence?.cleanup === true };
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ticket: 257, runId, verdict: report.verdict, failures: report.failures, evidence: "evidence/phase8-gate-report.json" }, null, 2));
  return report.verdict === "pass" ? 0 : 1;
}
if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/phase8-gate.mjs")) process.exitCode = await main();
