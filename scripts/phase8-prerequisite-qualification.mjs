#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PHASE8_PREREQUISITES = Object.freeze([
  { phase: 3, ticket: 55, path: "evidence/phase-3-gate-report.json" },
  { phase: 4, ticket: 90, path: "evidence/phase-4-gate-report.json" },
  { phase: 5, ticket: 125, path: "evidence/phase-5-gate-report.json" },
  { phase: 6, ticket: 164, path: "evidence/phase6-gate-report.json" },
  { phase: 7, ticket: 209, path: "evidence/phase7-gate-report.json" },
]);
export const MAX_EVIDENCE_AGE_MS = 14 * 24 * 60 * 60 * 1000;

const validSha = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "iu").test(value);
const parseJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

function normalize(phase, report) {
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const required = report?.required ?? report?.counts ?? {};
  const sourceRevision = report?.sourceRevision ?? report?.revision ?? null;
  const sourceTreeSha256 = report?.sourceTreeSha256 ?? null;
  const runId = report?.runId ?? checks.find((check) => check?.runId)?.runId ?? null;
  const executed = Number(required?.executed ?? required?.passed ?? report?.coverage?.executed ??
    checks.filter((check) => check?.executed === true || check?.passed === true).length ?? 0);
  const failed = Number(required?.failed ?? report?.failureCount ?? checks.filter((check) => check?.passed !== true).length ?? 0);
  const skipped = Number(required?.skipped ?? required?.requiredSkipped ?? report?.skipped ??
    checks.reduce((total, check) => total + Number(check?.skipped ?? 0), 0));
  const aggregateFailed = report?.verdict === "fail" || required?.success === false || failed > 0;
  const aggregateSuccess = report?.verdict === "pass" && required?.success !== false && failed === 0 && skipped === 0;
  const cleanup = typeof report?.cleanup === "boolean" ? report.cleanup : report?.cleanup?.success === true ||
    report?.guarantees?.successfulCleanup === true ||
    (phase === 7 && Array.isArray(report?.components) && report.components.length > 0 && report.components.every((item) => item.cleanup === true));
  const generatedAt = report?.completedAt ?? report?.generatedAt ?? report?.startedAt ?? null;
  const migrations = report?.migrations ?? report?.migrationChecksums ?? report?.databaseProof?.migrations ??
    report?.serviceEvidence?.migrations ?? report?.migrationLedger ?? [];
  const tools = report?.toolVersions ?? report?.tools ?? report?.runtime ?? report?.expectedToolVersions ?? report?.serviceEvidence?.tools ?? null;
  const realServiceScope = report?.realServiceScope ?? report?.databaseProof?.isolatedLoopbackProjects ??
    report?.serviceEvidence?.postgresVersion ?? report?.reproduction?.services ?? null;
  const counts = report?.counts ?? report?.coverage ?? {};
  const expectedExecuted = Number(counts?.total ?? report?.expectedExecuted ?? checks.length ?? 0);
  const coverageComplete = (counts?.criterionCount == null || Number(counts?.executedCriteria) === Number(counts?.criterionCount)) &&
    (expectedExecuted === 0 || executed >= expectedExecuted);
  return { sourceRevision, sourceTreeSha256, runId, generatedAt, executed, failed, skipped, expectedExecuted,
    aggregateFailed, aggregateSuccess, coverageComplete, cleanup,
    cleanupFailed: report?.cleanup === false || report?.cleanup?.success === false || report?.guarantees?.successfulCleanup === false,
    migrations: Array.isArray(migrations) ? migrations : [], tools,
    realServiceScope, required: { success: required?.success ?? (report?.verdict === "pass" ? true : null), executed, failed, skipped } };
}

function sourceBindingState(report, details) {
  const boundItems = [...(report?.checks ?? []), ...(report?.evidenceArtifacts ?? []), ...(report?.components ?? [])]
    .filter((item) => item && ("sourceRevision" in item || "sourceTreeSha256" in item || "gateRunId" in item));
  const itemsMatch = boundItems.every((item) => (!item.sourceRevision || item.sourceRevision === details.sourceRevision) &&
    (!item.sourceTreeSha256 || item.sourceTreeSha256 === details.sourceTreeSha256) && (!item.runId || item.runId === details.runId) &&
    (!item.gateRunId || item.gateRunId === details.runId));
  const gateProvesBinding = report?.guarantees?.evidenceBoundToSourceTreeAndRun === true ||
    report?.guarantees?.sourceBound === true || report?.sourceBindingVerified === true;
  if (!itemsMatch) return "mismatched";
  return gateProvesBinding ? "verified" : "unverified";
}

export function evaluatePhase8Prerequisites({ root, sourceRevision, sourceTreeSha256, now = Date.now(),
  maxAgeMs = MAX_EVIDENCE_AGE_MS,
  isAncestor = (revision) => {
    try { execFileSync("git", ["merge-base", "--is-ancestor", revision, sourceRevision], { cwd: root, stdio: "ignore" }); return true; }
    catch { return false; }
  } }) {
  const phases = PHASE8_PREREQUISITES.map(({ phase, ticket, path }) => {
    const absolutePath = join(root, path);
    const report = existsSync(absolutePath) ? parseJson(absolutePath) : null;
    const details = normalize(phase, report);
    const reasons = [];
    let sha256 = null;
    if (report) sha256 = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
    else reasons.push("evidence-report-absent");
    if (report && (!validSha(details.sourceRevision, 40) || !validSha(details.sourceTreeSha256, 64))) reasons.push("source-identity-missing-or-invalid");
    if (validSha(details.sourceRevision, 40) && !isAncestor(details.sourceRevision)) reasons.push("source-revision-not-in-evaluated-history");
    if (report && sourceBindingState(report, details) === "mismatched") reasons.push("source-binding-mismatch");
    else if (report && sourceBindingState(report, details) === "unverified") reasons.push("source-binding-unverified");
    if (typeof details.runId !== "string" || details.runId.length < 8) reasons.push("run-identity-missing-or-invalid");
    const generated = Date.parse(details.generatedAt ?? "");
    if (!Number.isFinite(generated)) reasons.push("evidence-time-missing-or-invalid");
    else if (generated > now || now - generated > maxAgeMs) reasons.push("evidence-stale");
    if (details.aggregateFailed) reasons.push("aggregate-failed");
    else if (!details.aggregateSuccess) reasons.push("aggregate-success-unproven");
    if (!positive(details.executed)) reasons.push("executed-coverage-missing");
    if (!details.coverageComplete) reasons.push("executed-coverage-partial");
    if (details.failed !== 0) reasons.push("required-failures-present");
    if (details.skipped !== 0) reasons.push("required-skips-present");
    if (details.cleanupFailed) reasons.push("cleanup-failed");
    else if (!details.cleanup) reasons.push("cleanup-unverified");
    if (!details.tools) reasons.push("tool-version-evidence-unavailable");
    if (!details.migrations.length) reasons.push("migration-checksum-evidence-unavailable");
    if (details.realServiceScope == null) reasons.push("real-service-scope-unverified");
    return Object.freeze({ phase, ticket, path, sha256, sourceRevision: details.sourceRevision,
      sourceTreeSha256: details.sourceTreeSha256, runId: details.runId, generatedAt: details.generatedAt,
      required: details.required, migrations: details.migrations.map((migration) => ({
        name: migration?.name ?? migration?.file ?? null, sha256: migration?.sha256 ?? null,
      })), toolVersions: details.tools, realServiceScope: details.realServiceScope, sourceBinding: sourceBindingState(report, details),
      cleanup: details.cleanup, reasons, accepted: reasons.length === 0 });
  });
  const failed = phases.filter((phase) => !phase.accepted);
  return Object.freeze({ schemaVersion: 1, ticket: 234, evaluatedAt: new Date(now).toISOString(),
    evaluator: { sourceRevision, sourceTreeSha256, runtime: { node: process.versions.node,
      npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? null } },
    verdict: failed.length === 0 ? "pass" : "blocked", mergeEligible: failed.length === 0,
    acceptedPhases: phases.filter((phase) => phase.accepted).map((phase) => phase.phase),
    blockers: failed.map((phase) => ({ phase: phase.phase, ticket: phase.ticket, reasons: phase.reasons })),
    phases,
    statusLayers: { localAcceptance: failed.length === 0 ? "passed" : "blocked",
      hostedChecks: "not-recorded-by-this-evaluator", codexReview: "not-recorded-by-this-evaluator",
      humanApproval: "not-recorded-by-this-evaluator", merge: "not-recorded-by-this-evaluator",
      deployment: "not-recorded-by-this-evaluator" },
    guarantees: { allPrerequisitesSourceBound: phases.every((phase) => validSha(phase.sourceRevision, 40) && validSha(phase.sourceTreeSha256, 64)),
      zeroRequiredFailures: phases.every((phase) => phase.required.failed === 0),
      zeroRequiredSkips: phases.every((phase) => phase.required.skipped === 0),
      successfulCleanup: phases.every((phase) => phase.cleanup) } });
}

export async function main() {
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const sourceTreeSha256 = workingTreeSourceSha256();
  const report = evaluatePhase8Prerequisites({ root: ROOT, sourceRevision, sourceTreeSha256 });
  const output = join(ROOT, "evidence", "phase8-prerequisite-qualification.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ticket: 234, verdict: report.verdict, mergeEligible: report.mergeEligible,
    acceptedPhases: report.acceptedPhases, blockers: report.blockers, evidence: "evidence/phase8-prerequisite-qualification.json" }, null, 2));
  return report.mergeEligible ? 0 : 1;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/phase8-prerequisite-qualification.mjs")) process.exitCode = await main();
