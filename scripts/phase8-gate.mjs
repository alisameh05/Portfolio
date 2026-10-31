#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { observeRuntime, verifyEnvironment, fingerprint } from "./validation-environment.mjs";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";
import { countReportedSkips, evaluatePhase8Gate, PHASE8_GATE_COMPONENTS, PHASE8_GATE_CRITERION_MATRIX, PHASE8_GATE_REQUIRED_CHECKS, PHASE8_GATE_SCENARIOS, readBoundArtifact } from "./phase8-gate-support.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const EVIDENCE = join(ROOT, "evidence");
const REPORT = join(EVIDENCE, "phase8-gate-report.json");
const LOGS = join(EVIDENCE, "phase8-gate-checks");
export const PHASE8_GATE_COMMANDS = Object.freeze([
  ["phase8-prerequisites", "phase8:qualify"], ["integrated", "phase8:focus:integrated"],
  ["retry-recovery", "phase8:focus:retry-recovery"], ["retention-passes", "phase8:focus:retention-passes"],
  ["protected-trigger", "phase8:focus:protected-trigger"], ["owner-exports", "phase8:focus:exports"],
  ["taxonomy", "phase8:focus:taxonomy"], ["analytics-export", "phase8:focus:analytics-export"],
  ["reference-import", "phase8:focus:reference-import"], ["operations-observability", "phase8:focus:operations-observability"],
  ["incidents", "phase8:focus:incidents"], ["relational-backup", "test:phase8:relational-backup"],
  ["object-backup", "test:phase8:object-backup"], ["recovery", "phase8:focus:recovery"],
  ["contract-verification", "contract:verify"], ["architecture", "test:arch"], ["runtime-boundary", "runtime:boundary"],
  ["lint", "lint"], ["typecheck", "typecheck"], ["production-build", "build"],
  ["gate-negative-tests", "test:phase8:gate"],
].map((command) => Object.freeze(command)));
const REPORTING_COMMANDS = new Set(["phase8-prerequisites", "integrated", "retry-recovery", "retention-passes", "protected-trigger", "owner-exports",
  "taxonomy", "analytics-export", "reference-import", "operations-observability", "incidents", "relational-backup", "object-backup", "recovery", "gate-negative-tests"]);
const REPORTING_ARTIFACTS = Object.freeze({
  "phase8-prerequisites": "evidence/phase8-prerequisite-qualification.json", integrated: "evidence/phase8-integrated-verification-256.json",
  "retry-recovery": "evidence/phase8-retry-recovery-237.json", "retention-passes": "evidence/phase8-retention-passes-248.json",
  "protected-trigger": "evidence/phase8-protected-trigger-249.json", "owner-exports": "evidence/phase8-owner-exports-241.json",
  taxonomy: "evidence/phase8-owner-export-taxonomy-242.json", "analytics-export": "evidence/phase8-owner-export-analytics-246.json",
  "reference-import": "evidence/phase8-owner-export-reference-import-250.json", "operations-observability": "evidence/phase8-operations-observability-251.json",
  incidents: "evidence/phase8-actionable-incidents-252.json",
});
function readJson(path) { try { return JSON.parse(readFileSync(join(ROOT, path), "utf8")); } catch { return null; } }
function countArtifactSkips(name) {
  const reportPath = REPORTING_ARTIFACTS[name];
  if (!reportPath) return null;
  const report = readJson(reportPath);
  if (!report) return null;
  const counts = [];
  const inspect = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    if (typeof value.skipped === "number") counts.push(value.skipped);
    Object.values(value).forEach(inspect);
  };
  inspect(report);
  return counts.length ? Math.max(...counts) : null;
}
function git(args) { return spawnSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true }).stdout.trim(); }
function run(name, script) {
  const startedAt = new Date().toISOString();
  const entry = process.env.npm_execpath ? process.execPath : (process.platform === "win32" ? "npm.cmd" : "npm");
  const args = process.env.npm_execpath ? [process.env.npm_execpath, "run", script] : ["run", script];
  const env = process.platform === "win32" ? { ...process.env, TEMP: "C:/t", TMP: "C:/t" } : process.env;
  const result = spawnSync(entry, args, { cwd: ROOT, env, encoding: "utf8", windowsHide: true, shell: process.platform === "win32" && !process.env.npm_execpath, timeout: 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const safe = output.replace(/(?:postgres(?:ql)?:\/\/|https?:\/\/)[^\s]+/giu, "[redacted-url]").replace(/(?:password|secret|token|service_role_key)[=: ]+[^\s]+/giu, "[redacted]");
  writeFileSync(join(LOGS, `${name}.log`), safe, "utf8");
  const reportedSkipped = countReportedSkips(output) ?? countArtifactSkips(name);
  const skipped = reportedSkipped ?? (REPORTING_COMMANDS.has(name) ? null : 0);
  const aggregateReported = !REPORTING_COMMANDS.has(name) || reportedSkipped !== null;
  const passed = result.status === 0 && !result.error && aggregateReported && (skipped === 0 || skipped === null && !REPORTING_COMMANDS.has(name));
  console.log(`${passed ? "PASS" : "FAIL"} ${name}`);
  return { name, command: `npm run ${script}`, startedAt, completedAt: new Date().toISOString(), executed: true, passed, exitCode: result.status ?? 1, skipped, aggregateReported, aggregateSuccess: passed,
    outputSha256: createHash("sha256").update(safe).digest("hex"), log: `evidence/phase8-gate-checks/${name}.log` };
}

async function main() {
  if (PHASE8_GATE_COMMANDS.some(([name]) => !PHASE8_GATE_REQUIRED_CHECKS.includes(name))) {
    throw new Error("PHASE8_REQUIRED_CHECK_INVENTORY_INCOMPLETE");
  }
  mkdirSync(LOGS, { recursive: true }); rmSync(REPORT, { force: true });
  const runId = randomUUID(), startedAt = new Date().toISOString(), sourceRevision = git(["rev-parse", "HEAD"]), sourceTreeSha256 = workingTreeSourceSha256();
  const initialArtifactDigests = new Map(PHASE8_GATE_COMPONENTS.map((component) => {
    try { return [component.id, createHash("sha256").update(Buffer.concat(component.paths.map((path) => readFileSync(join(ROOT, path))))).digest("hex")]; }
    catch { return [component.id, null]; }
  }));
  const runtime = observeRuntime();
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const readinessErrors = verifyEnvironment(ROOT, runtime);
  const installEvidence = { expectedFingerprint: fingerprint(ROOT),
    actualFingerprint: readJson("node_modules/.shipwithali-validation.json")?.fingerprint ?? null };
  const checks = [{ name: "validation-ready", executed: true, passed: readinessErrors.length === 0, exitCode: readinessErrors.length ? 1 : 0, skipped: 0 }];
  if (readinessErrors.length === 0) for (const [name, script] of PHASE8_GATE_COMMANDS) checks.push(run(name, script));
  const stable = git(["rev-parse", "HEAD"]) === sourceRevision && workingTreeSourceSha256() === sourceTreeSha256;
  if (!stable) for (const check of checks) { check.passed = false; check.exitCode = 1; }
  const artifacts = [];
  for (const component of PHASE8_GATE_COMPONENTS) {
    try {
      const bytes = Buffer.concat(component.paths.map((path) => readFileSync(join(ROOT, path))));
      const digest = createHash("sha256").update(bytes).digest("hex");
      artifacts.push(readBoundArtifact(ROOT, component, { sourceRevision, sourceTreeSha256, gateRunId: runId,
        gateStartedAt: startedAt, generatedThisRun: digest !== initialArtifactDigests.get(component.id), scenarios: PHASE8_GATE_SCENARIOS.map(({ id }) => id) }));
    }
    catch { artifacts.push({ id: component.id, paths: component.paths, fresh: false, positiveExecution: false, aggregateSuccess: false, cleanup: false, sourceRevision: null, sourceTreeSha256: null, gateRunId: runId, sha256: "", scenarios: [], tests: [] }); }
  }
  const integratedEvidence = readJson("evidence/phase8-integrated-verification-256.json");
  const prerequisiteEvidence = readJson("evidence/phase8-prerequisite-qualification.json");
  const expectedMigrations = readdirSync(join(ROOT, "supabase/migrations")).filter((name) => name.endsWith(".sql")).sort().map((name) => ({
    name, sha256: createHash("sha256").update(readFileSync(join(ROOT, "supabase/migrations", name))).digest("hex"),
  }));
  const walkNamed = (value, wanted, output = []) => {
    if (!value || typeof value !== "object") return output;
    if (Array.isArray(value)) { for (const child of value) walkNamed(child, wanted, output); return output; }
    for (const [key, child] of Object.entries(value)) {
      if (wanted.has(key) && child && typeof child === "object") output.push(child);
      walkNamed(child, wanted, output);
    }
    return output;
  };
  const sourceReports = PHASE8_GATE_COMPONENTS.flatMap(({ paths }) => paths.map((path) => readJson(path)).filter(Boolean));
  const roleEvidence = walkNamed(sourceReports, new Set(["databaseRoles", "roles", "roleMatrix"]));
  const volumeEvidence = walkNamed(sourceReports, new Set(["volumes", "fixture", "measurements"]));
  const namedRoles = roleEvidence.flatMap((entry) => Array.isArray(entry) ? entry : Array.isArray(entry.roles) ? entry.roles : [])
    .map((role) => typeof role === "string" ? role : role?.role ?? role?.name).filter((role) => typeof role === "string" && role.length > 0);
  const hasFixtureVolume = volumeEvidence.some((entry) => Object.entries(entry).some(([key, value]) =>
    /count|bytes|volume|size|rto|rpo|elapsed|objects|records|schemas|relations|items/iu.test(key) && typeof value === "number"));
  const serviceVersions = sourceReports.flatMap((report) => [
    ...Object.entries(report.tools ?? {}).filter(([key, value]) => /version/iu.test(key) && typeof value === "string").map(([key, value]) => ({ source: "tools", name: key, version: value })),
    ...Object.entries(report.services ?? {}).filter(([key, value]) => /version/iu.test(key) && typeof value === "string").map(([key, value]) => ({ source: "services", name: key, version: value })),
    ...(typeof report.postgresVersion === "string" ? [{ source: "report", name: "postgres", version: report.postgresVersion }] : []),
  ]);
  const allMigrations = walkNamed(sourceReports, new Set(["migrations"])).flat();
  const evidenceMigrationMap = new Map(allMigrations.filter((migration) => migration && migration.name && migration.sha256).map((migration) => [migration.name, migration.sha256]));
  const migrationEvidence = expectedMigrations.map(({ name, sha256 }) => ({ name, sha256, verified: evidenceMigrationMap.get(name) === sha256 }));
  const result = evaluatePhase8Gate({ runId, startedAt, sourceRevision, sourceTreeSha256, runtime,
    expectedRuntime: { node: packageJson.engines.node, npm: packageJson.engines.npm }, checks, artifacts, installEvidence, integratedEvidence, prerequisiteEvidence });
  if (migrationEvidence.some(({ verified }) => !verified)) result.failures.push("migration-checksum-inventory-incomplete");
  if (!namedRoles.length) result.failures.push("service-role-evidence-missing");
  if (!hasFixtureVolume) result.failures.push("fixture-volume-evidence-missing");
  if (!serviceVersions.some(({ name }) => /postgres|supabase|node|npm/iu.test(name))) result.failures.push("service-version-evidence-missing");
  if (!stable) result.failures.push("source-changed-during-gate");
  result.verdict = result.failures.length ? "fail" : "pass";
  const report = { schemaVersion: 1, ticket: 257, runId, startedAt, completedAt: new Date().toISOString(), source: { revision: sourceRevision,
    treeSha256: sourceTreeSha256, stableDuringRun: stable }, runtime, validationInstall: installEvidence, checks, artifacts,
    criterionMatrix: PHASE8_GATE_CRITERION_MATRIX.map(({ id, components }) => ({ id, components })),
    criterionEvidence: result.criterionEvidence, requiredCheckInventory: PHASE8_GATE_REQUIRED_CHECKS,
    scenarios: PHASE8_GATE_SCENARIOS.map((scenario, index) => ({ ...scenario, ...result.scenarioEvidence[index] })),
    serviceEvidence: { tools: integratedEvidence?.tools ?? null,
      migrations: migrationEvidence,
      versions: [...new Map(serviceVersions.map((item) => [`${item.name}:${item.version}`, item])).values()],
      roles: roleEvidence.map((entry) => ({ roles: (entry.roles ?? entry).map?.((role) => typeof role === "string" ? role : ({ role: role.role ?? role.name ?? role.id, purpose: role.purpose, privileges: role.privileges })) ?? [],
        worker: entry.worker, application: entry.application, anon: entry.anon })),
      fixturesAndVolumes: volumeEvidence.map((entry) => Object.fromEntries(Object.entries(entry).filter(([key, value]) =>
        /count|bytes|volume|size|rto|rpo|elapsed|objects|records|schemas|relations|items|fixture/iu.test(key) && ["string", "number", "boolean"].includes(typeof value)))),
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
