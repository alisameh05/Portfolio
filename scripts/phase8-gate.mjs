#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { observeRuntime, verifyEnvironment } from "./validation-environment.mjs";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";
import { countReportedSkips, evaluatePhase8Gate, PHASE8_GATE_COMPONENTS, PHASE8_GATE_CRITERION_MATRIX, PHASE8_GATE_REQUIRED_CHECKS, PHASE8_GATE_SCENARIOS, readBoundArtifact } from "./phase8-gate-support.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const EVIDENCE = join(ROOT, "evidence");
const REPORT = join(EVIDENCE, "phase8-gate-report.json");
const LOGS = join(EVIDENCE, "phase8-gate-checks");
const COMMANDS = [
  ["phase8-prerequisites", "phase8:qualify"], ["integrated", "phase8:focus:integrated"],
  ["retry-recovery", "phase8:focus:retry-recovery"], ["retention-passes", "phase8:focus:retention-passes"],
  ["protected-trigger", "phase8:focus:protected-trigger"], ["owner-exports", "phase8:focus:exports"],
  ["taxonomy", "phase8:focus:taxonomy"], ["analytics-export", "phase8:focus:analytics-export"],
  ["reference-import", "phase8:focus:reference-import"], ["operations-observability", "phase8:focus:operations-observability"],
  ["incidents", "phase8:focus:incidents"], ["relational-backup", "phase8:focus:relational-backup"],
  ["object-backup", "phase8:focus:object-backup"], ["recovery", "phase8:focus:recovery"],
  ["contract-verification", "contract:verify"], ["architecture", "test:arch"], ["runtime-boundary", "runtime:boundary"],
  ["lint", "lint"], ["typecheck", "typecheck"], ["production-build", "build"],
  ["gate-negative-tests", "test:phase8:gate"],
];
const REPORTING_COMMANDS = new Set(["phase8-prerequisites", "integrated", "retry-recovery", "retention-passes", "protected-trigger", "owner-exports",
  "taxonomy", "analytics-export", "reference-import", "operations-observability", "incidents", "recovery", "gate-negative-tests"]);
function git(args) { return spawnSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true }).stdout.trim(); }
function run(name, script) {
  const startedAt = new Date().toISOString();
  const entry = process.env.npm_execpath ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm");
  const args = process.env.npm_execpath ? [process.env.npm_execpath, "run", script] : ["run", script];
  const result = spawnSync(entry, args, { cwd: ROOT, encoding: "utf8", windowsHide: true, shell: process.platform === "win32" && !process.env.npm_execpath, timeout: 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const safe = output.replace(/(?:postgres(?:ql)?:\/\/|https?:\/\/)[^\s]+/giu, "[redacted-url]").replace(/(?:password|secret|token|service_role_key)[=: ]+[^\s]+/giu, "[redacted]");
  writeFileSync(join(LOGS, `${name}.log`), safe, "utf8");
  const reportedSkipped = countReportedSkips(output);
  const skipped = reportedSkipped ?? (REPORTING_COMMANDS.has(name) ? null : 0);
  const aggregateReported = !REPORTING_COMMANDS.has(name) || reportedSkipped !== null;
  const passed = result.status === 0 && !result.error && aggregateReported && (skipped === 0 || skipped === null && !REPORTING_COMMANDS.has(name));
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
  return { name, command: `npm run ${script}`, startedAt, completedAt: new Date().toISOString(), executed: true, passed, exitCode: result.status ?? 1, skipped, aggregateReported, aggregateSuccess: passed,
    outputSha256: createHash("sha256").update(safe).digest("hex"), log: `evidence/phase8-gate-checks/${name}.log` };
}

async function main() {
  mkdirSync(LOGS, { recursive: true }); rmSync(REPORT, { force: true });
  const runId = randomUUID(), startedAt = new Date().toISOString(), sourceRevision = git(["rev-parse", "HEAD"]), sourceTreeSha256 = workingTreeSourceSha256();
  const initialArtifactDigests = new Map(PHASE8_GATE_COMPONENTS.map((component) => {
    try { return [component.id, createHash("sha256").update(readFileSync(join(ROOT, component.path))).digest("hex")]; }
    catch { return [component.id, null]; }
  }));
  const runtime = observeRuntime();
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const readinessErrors = verifyEnvironment(ROOT, runtime);
  const checks = [{ name: "validation-ready", executed: true, passed: readinessErrors.length === 0, exitCode: readinessErrors.length ? 1 : 0, skipped: 0 }];
  if (readinessErrors.length === 0) for (const [name, script] of COMMANDS) checks.push(run(name, script));
  const stable = git(["rev-parse", "HEAD"]) === sourceRevision && workingTreeSourceSha256() === sourceTreeSha256;
  if (!stable) for (const check of checks) { check.passed = false; check.exitCode = 1; }
  const artifacts = [];
  for (const component of PHASE8_GATE_COMPONENTS) {
    try {
      const bytes = readFileSync(join(ROOT, component.path));
      const digest = createHash("sha256").update(bytes).digest("hex");
      artifacts.push(readBoundArtifact(ROOT, component, { sourceRevision, sourceTreeSha256, gateRunId: runId,
        generatedThisRun: digest !== initialArtifactDigests.get(component.id), scenarios: PHASE8_GATE_SCENARIOS.map(({ id }) => id) }));
    }
    catch { artifacts.push({ id: component.id, path: component.path, fresh: false, positiveExecution: false, aggregateSuccess: false, cleanup: false, sourceRevision: null, sourceTreeSha256: null, gateRunId: runId, sha256: "", scenarios: [] }); }
  }
  const readJson = (path) => { try { return JSON.parse(readFileSync(join(ROOT, path), "utf8")); } catch { return null; } };
  const integratedEvidence = readJson("evidence/phase8-integrated-verification-256.json");
  const prerequisiteEvidence = readJson("evidence/phase8-prerequisite-qualification.json");
  const result = evaluatePhase8Gate({ runId, startedAt, sourceRevision, sourceTreeSha256, runtime,
    expectedRuntime: { node: packageJson.engines.node, npm: packageJson.engines.npm }, checks, artifacts, integratedEvidence, prerequisiteEvidence });
  if (!stable) result.failures.push("source-changed-during-gate");
  const report = { schemaVersion: 1, ticket: 257, runId, startedAt, completedAt: new Date().toISOString(), source: { revision: sourceRevision,
    treeSha256: sourceTreeSha256, stableDuringRun: stable }, runtime, checks, artifacts, criterionMatrix: PHASE8_GATE_CRITERION_MATRIX,
    criterionEvidence: result.criterionEvidence, requiredCheckInventory: PHASE8_GATE_REQUIRED_CHECKS, scenarios: PHASE8_GATE_SCENARIOS,
    serviceEvidence: { tools: integratedEvidence?.tools ?? null,
      migrations: [...new Map((integratedEvidence?.runs ?? []).flatMap((run) => (run.artifacts ?? []).flatMap((artifact) => artifact.migrations ?? []))
        .map((migration) => [migration.name, migration])).values()],
      fixtureAndCleanup: (integratedEvidence?.runs ?? []).map(({ id, cleanupVerified, cleanupEvidence, testNames }) => ({ id, cleanupVerified, cleanupEvidence, testNames })),
      integratedRuns: (integratedEvidence?.runs ?? []).map(({ id, success, testNames, artifacts: runArtifacts }) => ({ id, success,
        testNames, artifacts: (runArtifacts ?? []).map(({ path, sha256, passed, failed, skipped, migrations }) => ({ path, sha256, passed, failed, skipped, migrations })) })) },
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
