#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { observeRuntime, verifyEnvironment } from "./validation-environment.mjs";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";
import { evaluatePhase7Gate, PHASE7_GATE_COMPONENTS, PHASE7_GATE_REQUIRED_CHECKS, readPhase7GateEvidence, sanitizePhase7Output } from "./phase7-gate-support.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const EVIDENCE = join(ROOT, "evidence");
const CHECKS = join(EVIDENCE, "phase7-gate-checks");
const REPORT = join(EVIDENCE, "phase7-gate-report.json");
const DEFAULT_TIMEOUT = 30 * 60 * 1000;
const LONG_TIMEOUT = 60 * 60 * 1000;
const COMMANDS = Object.freeze([
  { name: "toolchain", file: "scripts/check-toolchain.mjs", timeout: 120_000 },
  { name: "consent", script: "phase7:focus:consent", timeout: LONG_TIMEOUT },
  { name: "reactions", script: "phase7:focus:reactions", timeout: LONG_TIMEOUT },
  { name: "ratings", script: "phase7:focus:ratings", timeout: LONG_TIMEOUT },
  { name: "feedback", script: "phase7:focus:feedback", timeout: LONG_TIMEOUT },
  { name: "moderation", script: "phase7:focus:moderation", timeout: LONG_TIMEOUT },
  { name: "suppression", script: "phase7:focus:suppression", timeout: LONG_TIMEOUT },
  { name: "summaries", script: "phase7:focus:summaries", timeout: LONG_TIMEOUT },
  { name: "events", script: "phase7:focus:events", timeout: LONG_TIMEOUT },
  { name: "event-facts", script: "phase7:focus:events", args: ["--", "--ticket-197"], timeout: LONG_TIMEOUT },
  { name: "event-capabilities", script: "phase7:focus:events", args: ["--", "--ticket-198"], timeout: LONG_TIMEOUT },
  { name: "goal-versions", script: "phase7:focus:goal-versions", timeout: LONG_TIMEOUT },
  { name: "goal-conversions", script: "phase7:focus:goal-conversions", timeout: LONG_TIMEOUT },
  { name: "daily-aggregates", script: "phase7:focus:daily-aggregates", timeout: LONG_TIMEOUT },
  { name: "aggregate-privacy", script: "phase7:focus:aggregate-privacy", timeout: LONG_TIMEOUT },
  { name: "measurement-retention", script: "phase7:focus:retention", timeout: LONG_TIMEOUT },
  { name: "feedback-retention", script: "phase7:focus:feedback-retention", timeout: LONG_TIMEOUT },
  { name: "jobs", script: "phase7:focus:jobs", timeout: LONG_TIMEOUT },
  { name: "route-inventory", script: "route:inventory" },
  { name: "http-assembly", script: "phase7:http:assembly", timeout: 20 * 60 * 1000 },
  { name: "integrated", script: "phase7:focus:integrated", timeout: LONG_TIMEOUT },
  { name: "contract-verification", script: "contract:verify" },
  { name: "tooling-tests", script: "test:setup" },
  { name: "gate-negative-tests", script: "test:phase7:gate" },
  { name: "architecture", script: "test:arch" },
  { name: "runtime-boundary", script: "runtime:boundary" },
  { name: "runtime-architecture", script: "runtime:architecture" },
  { name: "lint", script: "lint" },
  { name: "typecheck", script: "typecheck" },
  { name: "production-build", script: "build", timeout: LONG_TIMEOUT },
]);

function json(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }
function git(args) { return spawnSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true,
  stdio: ["ignore", "pipe", "ignore"] }).stdout.trim(); }
function npmInvocation(script, args = []) {
  if (process.env.npm_execpath) return { entry: process.execPath, args: [process.env.npm_execpath, "run", script, ...args] };
  return { entry: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", script, ...args], shell: process.platform === "win32" };
}
function componentPathsForCommand(name) {
  const ids = name === "goal-versions" ? ["goal-versions", "goal-activation"] : [name];
  return PHASE7_GATE_COMPONENTS.filter((item) => ids.includes(item.id));
}
function captureComponentEvidence(name) {
  return new Map(componentPathsForCommand(name).map((component) => {
    const path = join(ROOT, component.path);
    try { return [component.id, createHash("sha256").update(readFileSync(path)).digest("hex")]; }
    catch { return [component.id, null]; }
  }));
}
function bindFreshComponentEvidence(name, gateRunId, sourceRevision, sourceTreeSha256, before) {
  let refreshed = true;
  for (const component of componentPathsForCommand(name)) {
    const path = join(ROOT, component.path);
    const report = json(path);
    let hash = null;
    try { hash = createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { /* missing output is rejected */ }
    const changed = hash !== null && hash !== before.get(component.id);
    const validRun = typeof report?.runId === "string" && report.runId.length >= 8;
    if (!changed || !validRun || report.sourceRevision !== sourceRevision || report.sourceTreeSha256 !== sourceTreeSha256) {
      refreshed = false;
      continue;
    }
    writeFileSync(path, `${JSON.stringify({ ...report, gateRunId }, null, 2)}\n`, "utf8");
  }
  return refreshed;
}
function countSkipped(output) {
  const values = [...String(output).replaceAll(/\u001B\[[0-9;]*m/gu, "").matchAll(/\b(\d+)\s+skipped\b/giu)].map((match) => Number(match[1]));
  return values.length ? Math.max(...values) : 0;
}
function execute(definition, context) {
  const began = new Date().toISOString();
  if (definition.requiresValidation && !context.validationReady) return { name: definition.name, ...context.binding,
    startedAt: began, completedAt: new Date().toISOString(), executed: false, passed: false, exitCode: 1,
    skipped: 0, timedOut: false, failure: "validation-ready-failed" };
  const invocation = definition.file ? { entry: process.execPath, args: [join(ROOT, definition.file)] } : npmInvocation(definition.script, definition.args);
  const result = spawnSync(invocation.entry, invocation.args, { cwd: ROOT,
    env: { ...process.env, CI: "1", SHIPWITHALI_PHASE: "phase7", PHASE7_GATE_RUN_ID: context.runId },
    encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: definition.timeout ?? DEFAULT_TIMEOUT,
    maxBuffer: 32 * 1024 * 1024, shell: invocation.shell ?? false });
  const output = sanitizePhase7Output(`${result.stdout ?? ""}${result.stderr ?? ""}`, { workspace: ROOT });
  const logName = `${definition.name}.log`;
  const logPath = join(CHECKS, logName);
  writeFileSync(logPath, `${output.trimEnd()}${output.trimEnd() ? "\n" : ""}`, "utf8");
  const skipped = countSkipped(output);
  const timedOut = result.error?.code === "ETIMEDOUT";
  const passed = result.status === 0 && !result.error && !timedOut && skipped === 0;
  return { name: definition.name, ...context.binding, startedAt: began, completedAt: new Date().toISOString(), executed: true,
    passed, exitCode: passed ? 0 : (result.status ?? 1), skipped, timedOut,
    aggregateSuccess: definition.name === "integrated" ? json(join(EVIDENCE, "phase7-integrated-208.json"))?.required?.success === true : undefined,
    failure: passed ? null : timedOut ? "timeout" : result.error?.code ?? (skipped ? "required-skip" : "check-failed"),
    evidence: { path: `evidence/phase7-gate-checks/${logName}`, sha256: createHash("sha256").update(readFileSync(logPath)).digest("hex") } };
}

async function main() {
  mkdirSync(CHECKS, { recursive: true });
  rmSync(REPORT, { force: true });
  for (const file of await import("node:fs/promises").then(({ readdir }) => readdir(CHECKS))) rmSync(join(CHECKS, file), { force: true });

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const sourceRevision = git(["rev-parse", "HEAD"]);
  let sourceTreeSha256;
  try { sourceTreeSha256 = workingTreeSourceSha256(); } catch { sourceTreeSha256 = "unknown"; }
  const binding = { runId, sourceRevision, sourceTreeSha256 };
  const runtime = observeRuntime();
  const packageJson = json(join(ROOT, "package.json")) ?? {};
  const expectedRuntime = { node: packageJson.engines?.node, npm: packageJson.engines?.npm };
  const readinessErrors = verifyEnvironment(ROOT, runtime);
  const checks = [{ name: "validation-ready", ...binding, startedAt, completedAt: new Date().toISOString(), executed: true,
    passed: readinessErrors.length === 0, exitCode: readinessErrors.length ? 1 : 0, skipped: 0, timedOut: false,
    failure: readinessErrors.length ? "validation-environment-invalid" : null }];
  const validationReady = readinessErrors.length === 0;
  for (const definition of COMMANDS) {
    const previousEvidence = captureComponentEvidence(definition.name);
    const result = execute({ ...definition, requiresValidation: true }, { runId, binding, validationReady });
    if (!bindFreshComponentEvidence(definition.name, runId, sourceRevision, sourceTreeSha256, previousEvidence)) {
      result.passed = false;
      result.exitCode = 1;
      result.failure = "component-evidence-not-refreshed";
    }
    checks.push(result);
    console.log(`${result.passed ? "PASS" : "FAIL"} ${definition.name}${result.failure ? ` (${result.failure})` : ""}`);
  }

  const finalRevision = git(["rev-parse", "HEAD"]);
  let finalTree;
  try { finalTree = workingTreeSourceSha256(); } catch { finalTree = "unknown"; }
  if (finalRevision !== sourceRevision || finalTree !== sourceTreeSha256) {
    for (const check of checks) { check.passed = false; check.exitCode = 1; check.failure = "source-changed-during-gate"; }
  }
  const evidenceArtifacts = readPhase7GateEvidence(ROOT, startedAt, sourceRevision, sourceTreeSha256, runId);
  const report = evaluatePhase7Gate({ runId, startedAt, sourceRevision, sourceTreeSha256, runtime, expectedRuntime,
    checks, evidenceArtifacts, serviceEvidence: json(join(EVIDENCE, "phase7-integrated-208.json")) });
  if (finalRevision !== sourceRevision) report.failures.push("HEAD changed while the gate was running");
  if (finalTree !== sourceTreeSha256) report.failures.push("source tree changed while the gate was running");
  if (readinessErrors.length) report.failures.push(...readinessErrors.map(() => "validation environment did not satisfy pinned runtime and dependencies"));
  report.failures = [...new Set(report.failures)];
  report.required.success = report.failures.length === 0;
  report.required.failed = report.failures.length;
  report.required.skipped = checks.reduce((sum, check) => sum + Number(check.skipped ?? 0), 0);
  report.required.failedSuites = checks.filter((check) => check.passed !== true || check.aggregateSuccess === false).length;
  report.statusLayers.localRequiredAcceptance = report.failures.length === 0 ? "passed" : "failed";
  report.verdict = report.required.success ? "pass" : "fail";
  report.completedAt = new Date().toISOString();
  report.reproduction = "npm run setup:validation; npm run validation:ready; npm run phase7:gate";
  report.cleanupInstructions = "Each focused PostgreSQL/Auth runner tears down only its disposable service; verify every component cleanup flag before accepting the report.";
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ticket: 209, runId, sourceRevision, sourceTreeSha256, verdict: report.verdict,
    required: report.required, failedChecks: checks.filter((item) => !item.passed).map(({ name, failure }) => ({ name, failure })),
    failures: report.failures, evidence: "evidence/phase7-gate-report.json" }, null, 2));
  return report.verdict === "pass" ? 0 : 1;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/phase7-gate.mjs")) process.exitCode = await main();
