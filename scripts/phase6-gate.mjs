#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeEvidenceOutput } from "./phase4-gate-support.mjs";
import { observeRuntime, verifyEnvironment } from "./validation-environment.mjs";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";
import { evaluatePhase6Gate, PHASE6_GATE_COMPONENTS, PHASE6_GATE_REQUIRED_CHECKS, readPhase6GateEvidence } from "./phase6-gate-support.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const EVIDENCE = join(ROOT, "evidence");
const CHECKS = join(EVIDENCE, "phase6-gate-checks");
const REPORT = join(EVIDENCE, "phase6-gate-report.json");
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT = 30 * 60 * 1000;
const LONG_TIMEOUT = 60 * 60 * 1000;

const COMMANDS = Object.freeze([
  { name: "toolchain", file: "scripts/check-toolchain.mjs", timeout: 120_000 },
  { name: "phase6-setup", script: "phase6:focus:verification", timeout: LONG_TIMEOUT },
  { name: "upload-intents", script: "phase6:focus:upload-intents", timeout: LONG_TIMEOUT },
  { name: "pdf-processing", script: "phase6:focus:media-processing", timeout: LONG_TIMEOUT },
  { name: "image-processing", script: "phase6:focus:media-image-processing", timeout: LONG_TIMEOUT },
  { name: "video-processing", script: "phase6:focus:video-processing", timeout: LONG_TIMEOUT },
  { name: "media-acceptance", script: "phase6:focus:media-acceptance", timeout: LONG_TIMEOUT },
  { name: "publication-media", script: "phase6:focus:publication-media", timeout: LONG_TIMEOUT },
  { name: "cv-registration", script: "phase6:focus:cv-portfolio", timeout: LONG_TIMEOUT },
  { name: "cv-acceptance", script: "phase6:focus:cv-acceptance", timeout: LONG_TIMEOUT },
  { name: "cv-activation", script: "phase6:focus:cv-activation", timeout: LONG_TIMEOUT },
  { name: "media-rejection", script: "phase6:focus:media-rejection", timeout: LONG_TIMEOUT },
  { name: "media-delivery", script: "phase6:focus:media-delivery", timeout: LONG_TIMEOUT },
  { name: "cv-delivery-capabilities", script: "phase6:focus:cv-delivery", timeout: LONG_TIMEOUT },
  { name: "owner-composition", script: "phase6:focus:owner-composition", timeout: LONG_TIMEOUT },
  { name: "media-integration", script: "phase6:focus:media-integration", timeout: LONG_TIMEOUT },
  { name: "migration-access", script: "phase6:focus:migration-access", timeout: LONG_TIMEOUT },
  { name: "media-cv-integration", script: "phase6:focus:media-cv-integration", timeout: LONG_TIMEOUT },
  { name: "contract-verification", script: "contract:verify" },
  { name: "tooling-tests", script: "test:setup" },
  { name: "phase6-gate-negative-tests", script: "test:phase6:gate" },
  { name: "architecture", script: "test:arch" },
  { name: "route-inventory", script: "route:inventory" },
  { name: "runtime-boundary", script: "runtime:boundary" },
  { name: "runtime-architecture", script: "runtime:architecture" },
  { name: "lint", script: "lint" },
  { name: "typecheck", script: "typecheck" },
  { name: "production-build", script: "build", timeout: LONG_TIMEOUT },
]);

export { COMMANDS as PHASE6_GATE_COMMANDS };

const REPORTS_TO_REFRESH = Object.freeze([
  "phase-6-verification-setup.json", "phase6-upload-intent-148.json", "phase6-media-processing-149.json",
  "phase6-image-processing-150.json", "phase6-video-processing-151.json", "phase6-media-acceptance-152.json",
  "phase6-publication-media-153.json", "phase6-cv-portfolio-154.json", "phase6-cv-acceptance-155.json",
  "phase6-cv-activation-156.json", "phase6-media-rejection.json", "phase6-media-delivery-158.json",
  "phase6-cv-delivery-159.json", "phase6-public-capabilities-160.json", "phase6-owner-composition-161.json",
  "phase6-migration-access-162.json", "phase6-media-integration.json", "phase6-media-cv-integration-163.json",
]);

function json(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function gitRevision() {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return "unknown"; }
}

function npmInvocation(script) {
  if (process.env.npm_execpath) return { entry: process.execPath, args: [process.env.npm_execpath, "run", script] };
  return { entry: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", script], shell: process.platform === "win32" };
}

function sanitize(output) {
  const secrets = Object.entries(process.env)
    .filter(([name, value]) => /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SERVICE_ROLE_KEY)/iu.test(name) && typeof value === "string" && value.length >= 6)
    .map(([, value]) => value);
  return sanitizeEvidenceOutput(String(output ?? ""), { workspace: ROOT, temporary: process.env.TEMP ?? "", secrets });
}

export async function clearGateArtifacts({ reportPath, reportPaths, checksPath }) {
  mkdirSync(checksPath, { recursive: true });
  rmSync(reportPath, { force: true });
  for (const path of reportPaths) rmSync(path, { force: true });
  const { readdir } = await import("node:fs/promises");
  for (const file of await readdir(checksPath)) rmSync(join(checksPath, file), { force: true });
}

function countSkipped(output) {
  const matches = [...String(output).replaceAll(/\u001B\[[0-9;]*m/gu, "").matchAll(/\b(\d+)\s+skipped\b/giu)];
  return matches.length ? Math.max(...matches.map((match) => Number(match[1]))) : 0;
}

function execute(definition, { runId, sourceRevision, sourceTreeSha256, validationReady, startedAt }) {
  const began = new Date().toISOString();
  if (definition.requiresValidation && !validationReady) {
    return { name: definition.name, runId, sourceRevision, sourceTreeSha256, startedAt: began, completedAt: new Date().toISOString(),
      executed: false, passed: false, exitCode: 1, skipped: 0, timedOut: false, failure: "validation-ready-failed" };
  }
  const invocation = definition.file
    ? { entry: process.execPath, args: [join(ROOT, definition.file)] }
    : npmInvocation(definition.script);
  const result = spawnSync(invocation.entry, invocation.args, {
    cwd: ROOT, env: { ...process.env, CI: "1", SHIPWITHALI_PHASE: "phase6", PHASE6_GATE_RUN_ID: runId },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: definition.timeout ?? DEFAULT_TIMEOUT,
    maxBuffer: MAX_OUTPUT_BYTES, shell: invocation.shell ?? false, windowsHide: true,
  });
  const output = sanitize(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  const logName = `${definition.name}.log`;
  const logPath = join(CHECKS, logName);
  writeFileSync(logPath, `${output.trimEnd()}${output.trimEnd() ? "\n" : ""}`, "utf8");
  const skipped = countSkipped(output);
  const timedOut = result.error?.code === "ETIMEDOUT";
  const passed = result.status === 0 && !result.error && !timedOut && skipped === 0;
  return {
    name: definition.name, runId, sourceRevision, sourceTreeSha256, startedAt: began, completedAt: new Date().toISOString(),
    executed: true, passed, exitCode: passed ? 0 : (result.status ?? 1), skipped, timedOut,
    failure: passed ? null : timedOut ? "timeout" : result.error?.code ?? (skipped ? "required-skip" : "check-failed"),
    evidence: { path: `evidence/phase6-gate-checks/${logName}`, sha256: createHash("sha256").update(readFileSync(logPath)).digest("hex") },
  };
}

async function main() {
  await clearGateArtifacts({ reportPath: REPORT, reportPaths: REPORTS_TO_REFRESH.map((file) => join(EVIDENCE, file)), checksPath: CHECKS });

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const sourceRevision = gitRevision();
  let sourceTreeSha256;
  try { sourceTreeSha256 = workingTreeSourceSha256(); } catch { sourceTreeSha256 = "unknown"; }
  const runtime = observeRuntime();
  const packageJson = json(join(ROOT, "package.json")) ?? {};
  const expectedRuntime = { node: packageJson.engines?.node, npm: packageJson.engines?.npm };
  const readinessErrors = verifyEnvironment(ROOT, runtime);
  const checks = [{
    name: "validation-ready", runId, sourceRevision, sourceTreeSha256, startedAt, completedAt: new Date().toISOString(),
    executed: true, passed: readinessErrors.length === 0, exitCode: readinessErrors.length ? 1 : 0,
    skipped: 0, timedOut: false, failure: readinessErrors.length ? "validation-environment-invalid" : null,
  }];
  const validationReady = readinessErrors.length === 0;
  for (const definition of COMMANDS) {
    const result = execute({ ...definition, requiresValidation: definition.name !== "toolchain" },
      { runId, sourceRevision, sourceTreeSha256, validationReady, startedAt });
    checks.push(result);
    console.log(`${result.passed ? "PASS" : "FAIL"} ${definition.name}${result.failure ? ` (${result.failure})` : ""}`);
  }

  const finalRevision = gitRevision();
  let finalTree;
  try { finalTree = workingTreeSourceSha256(); } catch { finalTree = "unknown"; }
  if (finalRevision !== sourceRevision || finalTree !== sourceTreeSha256) {
    for (const check of checks) { check.passed = false; check.exitCode = 1; check.failure = "source-changed-during-gate"; }
  }
  const evidenceArtifacts = readPhase6GateEvidence(ROOT, startedAt, sourceRevision, sourceTreeSha256);
  const integrationEvidence = json(join(ROOT, "evidence/phase6-media-cv-integration-163.json"));
  const report = evaluatePhase6Gate({ runId, startedAt, sourceRevision, sourceTreeSha256, runtime, expectedRuntime,
    checks, evidenceArtifacts, serviceEvidence: integrationEvidence });
  const gateSpecificFailures = [
    ...(finalRevision === sourceRevision ? [] : ["HEAD changed while the gate was running"]),
    ...(finalTree === sourceTreeSha256 ? [] : ["source tree changed while the gate was running"]),
    ...readinessErrors.map(() => "validation environment did not satisfy the pinned runtime and dependency set"),
  ];
  report.failures.push(...gateSpecificFailures);
  report.failures = [...new Set(report.failures)];
  report.failureCount = report.failures.length;
  report.verdict = report.failureCount === 0 ? "pass" : "fail";
  report.scenarioAcceptance = report.verdict === "pass";
  report.guarantees.freshEvidence = evidenceArtifacts.every((item) => item.fresh && item.accepted);
  report.guarantees.sourceBound = evidenceArtifacts.every((item) => item.sourceBound);
  report.guarantees.zeroRequiredSkips = checks.every((item) => item.skipped === 0);
  report.guarantees.successfulCleanup = evidenceArtifacts.every((item) => item.cleanup);
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ticket: 164, runId, sourceRevision, sourceTreeSha256, verdict: report.verdict,
    counts: report.counts, failedChecks: checks.filter((item) => !item.passed).map(({ name, failure }) => ({ name, failure })),
    failures: report.failures, evidence: "evidence/phase6-gate-report.json" }, null, 2));
  return report.verdict === "pass" ? 0 : 1;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/phase6-gate.mjs")) process.exitCode = await main();
