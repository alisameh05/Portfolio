import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const PHASE8_GATE_SCENARIOS = Object.freeze(Array.from({ length: 16 }, (_, i) => ({
  id: `S${String(i + 1).padStart(2, "0")}`,
  description: ["public journey", "project discovery", "case-study reading", "locale publication", "hidden/archive lifecycle",
    "taxonomy evolution", "durable routes", "accepted media", "current CV", "interaction dedup regression", "Feedback retention",
    "analytics privacy", "owner export scopes", "outbox lease recovery", "optional dependency degradation", "full export round trip"][i],
})));

const componentDefinitions = [
  ["interfaces", "evidence/phase8-portability-interfaces-235.json"],
  ["outbox", "evidence/phase8-retry-recovery-237.json"],
  ["export-replay", "evidence/phase8-owner-exports-238.json"],
  ["portable-schemas", "evidence/phase8-owner-export-schemas-239.json"],
  ["configuration", "evidence/phase8-owner-export-configuration-240.json"],
  ["content", "evidence/phase8-owner-exports-241.json"],
  ["taxonomy", "evidence/phase8-owner-export-taxonomy-242.json"],
  ["media", "evidence/phase8-owner-export-media-243.json"],
  ["cv", "evidence/phase8-owner-export-cv-244.json"],
  ["moderation", "evidence/phase8-owner-export-moderation-245.json"],
  ["analytics", "evidence/phase8-owner-export-analytics-246.json"],
  ["reconciliation", "evidence/phase8-owner-export-reconciliation-247.json"],
  ["retention", "evidence/phase8-retention-passes-248.json"],
  ["trigger", "evidence/phase8-protected-trigger-249.json"],
  ["reference-import", "evidence/phase8-owner-export-reference-import-250.json"],
  ["operations", "evidence/phase8-operations-observability-251.json"],
  ["incidents", "evidence/phase8-actionable-incidents-252.json"],
  ["relational-backup", "evidence/phase8-relational-backup-253.json"],
  ["object-backup", "evidence/phase8-object-backup-254.json"],
  ["recovery", "evidence/phase8-recovery-rehearsal-255.json"],
  ["integrated", "evidence/phase8-integrated-verification-256.json"],
  ["prerequisites", "evidence/phase8-prerequisite-qualification.json"],
];
export const PHASE8_GATE_COMPONENTS = Object.freeze(componentDefinitions.map(([id, path]) => ({ id, path })));
export const PHASE8_GATE_REQUIRED_CHECKS = Object.freeze(["validation-ready", "phase8-prerequisites", "integrated", "contract-verification", "architecture", "runtime-boundary", "lint", "typecheck", "production-build", "gate-negative-tests"]);
export const PHASE8_GATE_CRITERION_MATRIX = Object.freeze(Array.from({ length: 70 }, (_, i) => {
  const n = i + 1;
  const components = n < 12 ? ["interfaces", "integrated"] : n < 35 ? ["export-replay", "portable-schemas", "content", "taxonomy", "media", "cv", "moderation", "analytics", "reconciliation", "reference-import", "integrated"]
    : n < 57 ? ["outbox", "retention", "trigger", "operations", "incidents", "integrated"]
      : n < 67 ? ["relational-backup", "object-backup", "recovery", "integrated"]
        : ["integrated", "prerequisites"];
  return { id: `P8-${String(n).padStart(2, "0")}`, components };
}));

function executionOk(value) {
  if (!value || typeof value !== "object") return false;
  const req = value.required ?? value.acceptance ?? {};
  const executed = Number(req.executed ?? req.passed ?? value.executed ?? value.passed ?? (value.mergeEligible === true ? 1 : 0));
  const failed = Number(req.failed ?? value.failed ?? 0);
  const skipped = Number(req.skipped ?? value.skipped ?? 0);
  return (req.success === true || value.success === true || value.verdict === "pass" || value.result === "passed") &&
    executed > 0 && failed === 0 && skipped === 0;
}

export function evaluatePhase8Gate({ runId, startedAt, sourceRevision, sourceTreeSha256, runtime, expectedRuntime, checks,
  artifacts, scenarios = PHASE8_GATE_SCENARIOS.map(({ id }) => id), integratedEvidence, prerequisiteEvidence, now = Date.now() }) {
  const failures = [];
  const revision = String(sourceRevision ?? "");
  if (!/^[0-9a-f]{40}$/iu.test(revision) || !/^[0-9a-f]{64}$/iu.test(String(sourceTreeSha256 ?? ""))) failures.push("source-binding-invalid");
  if (String(runtime?.node ?? "").replace(/^v/u, "") !== expectedRuntime?.node || runtime?.npm !== expectedRuntime?.npm) failures.push("runtime-pin-mismatch");
  const requiredChecks = new Set(checks.map((c) => c.name));
  for (const name of PHASE8_GATE_REQUIRED_CHECKS) {
    const c = checks.find((item) => item.name === name);
    if (!c || c.executed !== true || c.passed !== true || c.skipped !== 0 || c.aggregateSuccess === false) failures.push(`required-check-failed:${name}`);
  }
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  for (const item of PHASE8_GATE_COMPONENTS) {
    const a = byId.get(item.id);
    if (!a || a.sourceRevision !== revision || a.sourceTreeSha256 !== sourceTreeSha256 || a.gateRunId !== runId ||
      a.fresh !== true || a.positiveExecution !== true || a.aggregateSuccess !== true || a.cleanup !== true || !/^[0-9a-f]{64}$/iu.test(a.sha256 ?? "")) {
      failures.push(`required-evidence-invalid:${item.id}`);
    }
  }
  for (const c of PHASE8_GATE_CRITERION_MATRIX) if (c.components.some((id) => !byId.has(id) || byId.get(id).positiveExecution !== true)) failures.push(`criterion-coverage-incomplete:${c.id}`);
  const scenarioSet = new Set(scenarios);
  for (const { id } of PHASE8_GATE_SCENARIOS) if (!scenarioSet.has(id) || !artifacts.some((a) => a.scenarios?.includes(id))) failures.push(`scenario-coverage-incomplete:${id}`);
  if (!executionOk(integratedEvidence)) failures.push("integrated-real-service-evidence-invalid");
  const integratedRevision = integratedEvidence?.source?.revision ?? integratedEvidence?.sourceRevision;
  const integratedTree = integratedEvidence?.source?.workingTreeSha256 ?? integratedEvidence?.sourceTreeSha256;
  if (integratedRevision !== revision || integratedTree !== sourceTreeSha256) failures.push("integrated-real-service-evidence-stale");
  const prerequisiteSource = prerequisiteEvidence?.evaluator ?? prerequisiteEvidence?.source ?? {};
  if (!executionOk(prerequisiteEvidence) || prerequisiteEvidence.acceptedPhases?.join(",") !== "3,4,5,6,7" ||
      prerequisiteSource.sourceRevision !== revision || prerequisiteSource.sourceTreeSha256 !== sourceTreeSha256) failures.push("failed-or-stale-prerequisite-evidence");
  if (Date.parse(startedAt) > now || now - Date.parse(startedAt) > 24 * 60 * 60 * 1000) failures.push("gate-run-stale");
  return { verdict: failures.length ? "fail" : "pass", failures: [...new Set(failures)], counts: {
    criteria: PHASE8_GATE_CRITERION_MATRIX.length, executedCriteria: failures.filter((f) => f.startsWith("criterion-coverage-incomplete:")).length ? 0 : 70,
    scenarios: PHASE8_GATE_SCENARIOS.length, executedScenarios: PHASE8_GATE_SCENARIOS.filter(({ id }) => artifacts.some((a) => a.scenarios?.includes(id))).length,
    requiredChecks: PHASE8_GATE_REQUIRED_CHECKS.length, executedChecks: requiredChecks.size,
  } };
}

export function readBoundArtifact(root, component, { sourceRevision, sourceTreeSha256, gateRunId, scenarios }) {
  const path = `${root}/${component.path}`;
  const bytes = readFileSync(path);
  const report = JSON.parse(bytes.toString("utf8"));
  const req = report.required ?? report.acceptance ?? {};
  const cleanup = report.cleanup === true || report.cleanup === "passed" || report.cleanup?.success === true || report.cleanupComplete === true;
  const sourceRev = report.sourceRevision ?? report.source?.revision ?? report.repository?.head ?? report.repository?.commit ?? report.evaluator?.sourceRevision;
  const sourceTree = report.sourceTreeSha256 ?? report.source?.workingTreeSha256 ?? report.repository?.sourceTreeSha256 ?? report.evaluator?.sourceTreeSha256;
  return { id: component.id, path: component.path, sha256: createHash("sha256").update(bytes).digest("hex"),
    sourceRevision: sourceRev, sourceTreeSha256: sourceTree, gateRunId,
    fresh: sourceRev === sourceRevision && sourceTree === sourceTreeSha256,
    positiveExecution: executionOk(report), aggregateSuccess: executionOk(report), cleanup,
    scenarios: scenarios.filter((id) => (report.scenarios ?? report.scenarioCoverage ?? []).includes(id)) };
}
