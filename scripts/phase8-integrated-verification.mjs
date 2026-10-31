#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EVIDENCE_PATH = join(ROOT, "evidence", "phase8-integrated-verification-256.json");
const RUNS = Object.freeze([
  { id: "owner-exports", command: "phase8:focus:exports", artifacts: [
    "evidence/phase8-owner-exports-241.json", "evidence/phase8-owner-export-media-243.json",
    "evidence/phase8-owner-export-cv-244.json", "evidence/phase8-owner-export-moderation-245.json",
    "evidence/phase8-owner-export-reconciliation-247.json" ] },
  { id: "reference-import", command: "phase8:focus:reference-import", artifacts: ["evidence/phase8-owner-export-reference-import-250.json"],
    testReport: "artifacts/phase8-owner-export-reference-import-250-tests.json" },
  { id: "operational-failures", command: "phase8:focus:incidents", artifacts: ["evidence/phase8-actionable-incidents-252.json"] },
  { id: "isolated-recovery", command: "phase8:focus:recovery", artifacts: [] },
  { id: "contracts", command: "test:contracts", artifacts: [] },
  { id: "architecture", command: "test:arch", artifacts: [] },
  { id: "lint", command: "lint", artifacts: [] },
  { id: "typecheck", command: "typecheck", artifacts: [] },
  { id: "production-build", command: "build", artifacts: [] },
]);

export const PHASE8_INTEGRATED_CRITERIA = Object.freeze([
  { id: "AC01", runs: ["owner-exports", "reference-import"] },
  { id: "AC02", runs: ["owner-exports", "reference-import", "isolated-recovery"] },
  { id: "AC03", runs: ["owner-exports", "reference-import", "operational-failures"] },
  { id: "AC04", runs: ["contracts", "architecture"] },
  { id: "AC05", runs: ["operational-failures"] },
  { id: "AC06", runs: ["owner-exports", "reference-import", "isolated-recovery"] },
  { id: "AC07", runs: ["operational-failures"] },
  { id: "AC08", runs: ["contracts", "architecture", "lint", "typecheck", "production-build"] },
  { id: "AC09", runs: RUNS.map(({ id }) => id) },
]);

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function evidenceArtifact(path) {
  const fullPath = join(ROOT, path);
  const bytes = readFileSync(fullPath);
  const report = JSON.parse(bytes.toString("utf8"));
  const required = report.required ?? {};
  const cleanup = report.cleanup === true || report.cleanup === "passed" || report.cleanup?.success === true || report.cleanupComplete === true;
  const sourceRevision = report.sourceRevision ?? report.source?.revision ?? report.repository?.head ?? null;
  const sourceTreeSha256 = report.sourceTreeSha256 ?? report.source?.workingTreeSha256 ?? report.repository?.sourceTreeSha256After ?? null;
  const skippedValues = [];
  const passedValues = [];
  const failedValues = [];
  const failedStatuses = [];
  const testCases = [];
  const inspect = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    if (typeof value.skipped === "number") skippedValues.push(value.skipped);
    if (typeof value.passed === "number") passedValues.push(value.passed);
    if (typeof value.failed === "number") failedValues.push(value.failed);
    if (value.status === "failed" || value.status === "error") failedStatuses.push(value.status);
    if (typeof value.title === "string") testCases.push(value.title);
    if (typeof value.name === "string" && typeof value.suite === "string" && typeof value.status === "string") {
      testCases.push(`${value.suite} :: ${value.name}`);
    }
    for (const child of Object.values(value)) inspect(child);
  };
  inspect(report);
  const skipped = required.skipped ?? required.requiredSkipped ?? report.acceptance?.skipped ?? (skippedValues.length > 0 ? Math.max(...skippedValues) : null);
  const passed = required.passed ?? required.executed ?? report.acceptance?.passed ?? (passedValues.length > 0 ? Math.max(...passedValues) : null);
  const failed = required.failed ?? report.acceptance?.failed ?? (failedValues.length > 0 ? Math.max(...failedValues) : null);
  const sourceBound = sourceRevision === git(["rev-parse", "HEAD"]) && sourceTreeSha256 === workingTreeSourceSha256();
  const success = (required.success === true || (report.result === "passed" && cleanup) ||
    (report.cleanupComplete === true && report.acceptance?.failed === 0)) &&
    (failed === null || Number(failed) === 0) && failedStatuses.length === 0;
  return { path, sha256: createHash("sha256").update(bytes).digest("hex"), success, cleanup,
    sourceRevision, sourceTreeSha256, sourceBound, passed,
    failed, skipped, migrations: report.migrations ?? [], tests: [...new Set(testCases)] };
}

function execute(run) {
  const npmCli = process.env.npm_execpath;
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, "run", run.command], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    : spawnSync("npm", ["run", run.command], { cwd: ROOT, encoding: "utf8", shell: process.platform === "win32", maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output);
  const testNames = output.replace(/\u001b\[[0-9;]*m/gu, "").split(/\r?\n/u)
    .map((line) => line.trim()).filter((line) => /^(?:\u2713|\u2714|PASS)\s/u.test(line));
  const executed = result.error === undefined && result.status === 0;
  const artifacts = [];
  try {
    for (const artifact of run.artifacts) artifacts.push(evidenceArtifact(artifact));
  } catch (error) {
    return { id: run.id, command: `npm run ${run.command}`, success: false, exitCode: result.status,
      testResults: [], cleanupVerified: false,
      outputSha256: createHash("sha256").update(output).digest("hex"), testNames, artifacts, error: String(error.message ?? error) };
  }
  const testReportPath = run.testReport ? join(ROOT, run.testReport) : null;
  const failureReport = testReportPath !== null && existsSync(testReportPath) ? readFileSync(testReportPath, "utf8") : "";
  let testResults = [];
  if (failureReport !== "") {
    const parsedFailureReport = JSON.parse(failureReport);
    testResults = parsedFailureReport.suites.flatMap((suite) => suite.tests.map((test) => ({ title: test.title, status: test.status,
      ...(test.failureCode ? { failureCode: test.failureCode } : {}) })));
  }
  const resourceEvidence = output.replace(/\u001b\[[0-9;]*m/gu, "").split(/\r?\n/u).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return [];
    try { return [JSON.parse(trimmed)]; } catch { return []; }
  });
  const recoveryDatabase = resourceEvidence.find((item) => item.evidence === "isolated-postgres-object-recovery-small-fixture");
  const recoveryObjects = resourceEvidence.find((item) => item.evidence === "isolated-s3");
  const cleanupEvidence = run.id === "isolated-recovery" ? {
    postgresObjects: recoveryDatabase?.measurements?.cleanup ?? null,
    databaseAndObjectTargetsRemoved: recoveryDatabase?.checks?.ownedDatabaseAndObjectTargetsRemoved === true,
    isolatedObjectContainerRemoved: recoveryObjects?.ownedContainerRemoved === true,
  } : artifacts.map((item) => ({ artifact: item.path, cleanup: item.cleanup }));
  const cleanupVerified = run.id === "isolated-recovery"
    ? recoveryDatabase?.measurements?.cleanup?.complete === true && recoveryDatabase?.checks?.ownedDatabaseAndObjectTargetsRemoved === true &&
      recoveryObjects?.ownedContainerRemoved === true
    : artifacts.length > 0 ? artifacts.every((item) => item.cleanup) : true;
  const artifactsValid = artifacts.every((item) => item.success && item.cleanup && item.sourceBound && item.skipped !== null && Number(item.skipped) === 0);
  return { id: run.id, command: `npm run ${run.command}`, testReport: run.testReport ?? null,
    success: executed && artifactsValid && cleanupVerified &&
      (!new Set(["isolated-recovery", "contracts"]).has(run.id) || testNames.length > 0),
    cleanupVerified, cleanupEvidence,
    exitCode: result.status ?? null, outputSha256: createHash("sha256").update(output).digest("hex"), testNames, testResults, artifacts,
    ...(result.error ? { error: String(result.error.message ?? result.error) } : {}) };
}

const startedAt = new Date().toISOString();
const sourceRevision = git(["rev-parse", "HEAD"]);
const sourceTreeSha256 = workingTreeSourceSha256();
const runId = randomUUID();
const runs = [];
for (const run of RUNS) {
  const result = execute(run);
  runs.push(result);
  if (!result.success) break;
}

const completedAt = new Date().toISOString();
const sourceStable = sourceTreeSha256 === workingTreeSourceSha256();
const passedRuns = runs.filter((run) => run.success).length;
const runById = new Map(runs.map((run) => [run.id, run]));
const criteria = PHASE8_INTEGRATED_CRITERIA.map((criterion) => ({ ...criterion,
  executedRuns: criterion.runs.filter((id) => runById.get(id)?.success),
  success: criterion.runs.every((id) => runById.get(id)?.success === true) }));
const success = sourceStable && runs.length === RUNS.length && passedRuns === RUNS.length && criteria.every(({ success: passed }) => passed);
const testReports = runs.flatMap((run) => run.artifacts.flatMap((artifact) => artifact.tests.map((title) => ({ run: run.id, artifact: artifact.path, title }))))
  .concat(runs.flatMap((run) => run.testResults.map((test) => ({ run: run.id, artifact: run.testReport ?? null, ...test }))))
  .concat(runs.flatMap((run) => run.testNames.map((title) => ({ run: run.id, artifact: null, title, status: "passed" }))));
const uniqueTestReports = [...new Map(testReports.map((item) => [`${item.run}\0${item.title}`, item])).values()];
const artifactFailures = runs.flatMap((run) => run.artifacts.map((artifact) => artifact.failed ?? 0)).reduce((sum, value) => sum + Number(value || 0), 0);
const testFailures = runs.flatMap((run) => run.testResults.filter((test) => test.status === "failed")).length;
const testSkips = runs.flatMap((run) => run.artifacts.map((artifact) => artifact.skipped ?? 0)).reduce((sum, value) => sum + Number(value || 0), 0) +
  runs.flatMap((run) => run.testResults.filter((test) => test.status === "skipped" || test.status === "pending" || test.status === "todo")).length;
const reportedPasses = uniqueTestReports.filter((item) => !["failed", "skipped", "pending", "todo"].includes(item.status)).length + passedRuns;
const evidence = { schemaVersion: 1, ticket: 256, runId, startedAt, completedAt,
  source: { revision: sourceRevision, branch: git(["branch", "--show-current"]) || null, workingTreeSha256: sourceTreeSha256,
    stableDuringRun: sourceStable },
  tools: { node: process.version.replace(/^v/u, ""), npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? null },
  required: { success, passed: reportedPasses, failed: RUNS.length - passedRuns + artifactFailures + testFailures,
    skipped: testSkips, failedSuites: RUNS.length - passedRuns },
  cleanup: runs.every((run) => run.cleanupVerified === true), runs, criteria, testReports: uniqueTestReports };
mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ evidence: "evidence/phase8-integrated-verification-256.json", success,
  passed: evidence.required.passed, failed: evidence.required.failed, skipped: evidence.required.skipped, cleanup: evidence.cleanup }));
if (!success) process.exitCode = 1;
