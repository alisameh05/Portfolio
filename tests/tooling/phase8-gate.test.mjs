import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countReportedSkips, evaluatePhase8Gate, PHASE8_GATE_COMPONENTS, PHASE8_GATE_CRITERION_MATRIX, PHASE8_GATE_REQUIRED_CHECKS, PHASE8_GATE_SCENARIOS, PHASE8_GATE_SCENARIO_EVIDENCE, readBoundArtifact } from "../../scripts/phase8-gate-support.mjs";

function matchingTitle(pattern, prefix) {
  const alternatives = pattern.source.split("|").map((value) => value.replace(/[\\()[\]{}?*+.^$]/gu, " ").trim()).filter(Boolean);
  for (const term of alternatives.reverse()) {
    const candidate = `${prefix} ${term}`;
    if (pattern.test(candidate)) return candidate;
  }
  throw new Error(`No evidence title fixture for ${pattern}`);
}

function fixture() {
  const sourceRevision = "a".repeat(40), sourceTreeSha256 = "b".repeat(64), runId = "gate-run-12345678";
  const namedTests = [
    ...PHASE8_GATE_CRITERION_MATRIX.map(({ id, evidencePattern }) => matchingTitle(evidencePattern, `executed ${id}`)),
    ...PHASE8_GATE_SCENARIOS.map(({ id }, index) => matchingTitle(PHASE8_GATE_SCENARIO_EVIDENCE[index], `executed scenario ${id}`)),
  ];
  const artifacts = PHASE8_GATE_COMPONENTS.map((c) => ({ id: c.id, paths: c.paths, sha256: "c".repeat(64), sourceRevision,
    sourceTreeSha256, gateRunId: runId, generatedThisRun: true, fresh: true, positiveExecution: true, aggregateSuccess: true, cleanup: true,
    scenarios: [], tests: namedTests }));
  const checks = PHASE8_GATE_REQUIRED_CHECKS.map((name) => ({ name, executed: true, passed: true, skipped: 0 }));
  return { runId, startedAt: "2026-10-31T10:00:00.000Z", sourceRevision, sourceTreeSha256, runtime: { node: "v24.21.0", npm: "11.19.0" },
    expectedRuntime: { node: "24.21.0", npm: "11.19.0" }, checks, artifacts,
    installEvidence: { expectedFingerprint: "d".repeat(64), actualFingerprint: "d".repeat(64) },
    integratedEvidence: { required: { success: true, passed: 412, failed: 0, skipped: 0 }, cleanup: true,
      source: { revision: sourceRevision, workingTreeSha256: sourceTreeSha256 } },
    prerequisiteEvidence: { verdict: "pass", mergeEligible: true, acceptedPhases: [3, 4, 5, 6, 7], sourceTreeVerified: true,
      evaluator: { sourceRevision, sourceTreeSha256 } }, now: Date.parse("2026-10-31T10:10:00.000Z") };
}

test("Phase 8 gate enumerates every criterion and scenario and accepts complete fresh evidence", () => {
  assert.equal(PHASE8_GATE_CRITERION_MATRIX.length, 70);
  assert.deepEqual(PHASE8_GATE_CRITERION_MATRIX.map((x) => x.id), Array.from({ length: 70 }, (_, i) => `P8-${String(i + 1).padStart(2, "0")}`));
  assert.equal(PHASE8_GATE_SCENARIOS.length, 16);
  const result = evaluatePhase8Gate(fixture());
  assert.equal(result.verdict, "pass", result.failures.join(", "));
  assert.equal(result.counts.executedCriteria, 70);
  assert.equal(result.counts.executedScenarios, 16);
});

test("gate reads skip counts from real runner summaries and rejects missing aggregate counts", () => {
  assert.equal(countReportedSkips("ℹ skipped 0"), 0);
  assert.equal(countReportedSkips('{"required":{"skipped":0}}'), 0);
  assert.equal(countReportedSkips("Tests 4 passed | 2 skipped"), 2);
  assert.equal(countReportedSkips("no test summary"), null);
});

test("artifact reader retains named passing checks from testNames and status-bearing reports", () => {
  const root = mkdtempSync(join(tmpdir(), "phase8-gate-artifact-reader-"));
  const sourceRevision = "a".repeat(40), sourceTreeSha256 = "b".repeat(64);
  try {
    const component = PHASE8_GATE_COMPONENTS[0];
    const artifactPath = join(root, component.paths[0]);
    mkdirSync(join(root, "evidence"), { recursive: true });
    writeFileSync(artifactPath, JSON.stringify({ startedAt: "2026-10-31T10:05:00.000Z", sourceRevision, sourceTreeSha256, required: { success: true, passed: 2, failed: 0, skipped: 0 },
      cleanup: true, testNames: ["executed report title"], assertions: [{ title: "passed suite title", status: "passed" }] }));
    const evidence = readBoundArtifact(root, component, { sourceRevision, sourceTreeSha256, gateRunId: "gate-run", gateStartedAt: "2026-10-31T10:00:00.000Z", generatedThisRun: true, scenarios: [], now: Date.parse("2026-10-31T10:10:00.000Z") });
    assert.deepEqual(evidence.tests, ["executed report title", "passed suite title"]);
    assert.equal(evidence.fresh, true);
    const stale = readBoundArtifact(root, component, { sourceRevision, sourceTreeSha256, gateRunId: "gate-run", gateStartedAt: "2026-10-31T10:06:00.000Z", generatedThisRun: true, scenarios: [], now: Date.parse("2026-10-31T10:10:00.000Z") });
    assert.equal(stale.fresh, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("gate rejects runtime/install, missing or stale artifact, run/coverage, aggregate, skip, cleanup, and prerequisite failures", () => {
  const wrongRuntime = fixture(); wrongRuntime.runtime.node = "20.0.0";
  assert.ok(evaluatePhase8Gate(wrongRuntime).failures.includes("runtime-pin-mismatch"));
  const staleInstall = fixture(); staleInstall.runtime.installFingerprint = "stale"; staleInstall.runtime.npm = "10.0.0";
  assert.ok(evaluatePhase8Gate(staleInstall).failures.includes("runtime-pin-mismatch"));
  const staleStamp = fixture(); staleStamp.installEvidence.actualFingerprint = "e".repeat(64);
  assert.ok(evaluatePhase8Gate(staleStamp).failures.includes("validation-install-stale-or-missing"));
  const missing = fixture(); missing.artifacts = missing.artifacts.filter((x) => x.id !== "content-and-exports");
  assert.ok(evaluatePhase8Gate(missing).failures.includes("required-evidence-invalid:content-and-exports"));
  const stale = fixture(); stale.artifacts[0].fresh = false;
  assert.ok(evaluatePhase8Gate(stale).failures.includes(`required-evidence-invalid:${PHASE8_GATE_COMPONENTS[0].id}`));
  const wrongRun = fixture(); wrongRun.artifacts[0].gateRunId = "other-run";
  assert.ok(evaluatePhase8Gate(wrongRun).failures.includes(`required-evidence-invalid:${PHASE8_GATE_COMPONENTS[0].id}`));
  const notExecutedThisRun = fixture(); notExecutedThisRun.artifacts[0].generatedThisRun = false;
  assert.ok(evaluatePhase8Gate(notExecutedThisRun).failures.includes(`required-evidence-invalid:${PHASE8_GATE_COMPONENTS[0].id}`));
  const noNamedTests = fixture(); noNamedTests.artifacts[0].tests = [];
  assert.ok(evaluatePhase8Gate(noNamedTests).failures.includes(`required-evidence-invalid:${PHASE8_GATE_COMPONENTS[0].id}`));
  const noScenario = fixture(); noScenario.artifacts.forEach((x) => { x.tests = x.tests.filter((title) => !PHASE8_GATE_SCENARIO_EVIDENCE[15].test(title)); });
  assert.ok(evaluatePhase8Gate(noScenario).failures.includes("scenario-coverage-incomplete:S16"));
  const noOptionalOutage = fixture(); noOptionalOutage.artifacts.forEach((x) => { x.tests = x.tests.filter((title) => !PHASE8_GATE_SCENARIO_EVIDENCE[14].test(title)); });
  assert.ok(evaluatePhase8Gate(noOptionalOutage).failures.includes("scenario-coverage-incomplete:S15"));
  const absentCriterion = fixture();
  assert.ok(evaluatePhase8Gate({ ...absentCriterion, criterionMatrix: PHASE8_GATE_CRITERION_MATRIX.slice(1) }).failures.includes("criterion-inventory-incomplete"));
  const skipped = fixture(); skipped.checks[0].skipped = 1; skipped.checks[0].passed = false;
  assert.ok(evaluatePhase8Gate(skipped).failures.includes("required-check-failed:validation-ready"));
  const aggregate = fixture(); aggregate.integratedEvidence.required.success = false;
  assert.ok(evaluatePhase8Gate(aggregate).failures.includes("integrated-real-service-evidence-invalid"));
  const staleIntegrated = fixture(); staleIntegrated.integratedEvidence.source.workingTreeSha256 = "f".repeat(64);
  assert.ok(evaluatePhase8Gate(staleIntegrated).failures.includes("integrated-real-service-evidence-stale"));
  const missingService = fixture(); missingService.integratedEvidence = null;
  assert.ok(evaluatePhase8Gate(missingService).failures.includes("integrated-real-service-evidence-invalid"));
  const zeroExecution = fixture(); zeroExecution.artifacts[0].positiveExecution = false;
  assert.ok(evaluatePhase8Gate(zeroExecution).failures.includes(`required-evidence-invalid:${PHASE8_GATE_COMPONENTS[0].id}`));
  const partial = fixture(); partial.integratedEvidence.required.partial = true;
  assert.ok(evaluatePhase8Gate(partial).failures.includes("integrated-real-service-evidence-invalid"));
  const cleanup = fixture(); cleanup.artifacts[0].cleanup = false;
  assert.ok(evaluatePhase8Gate(cleanup).failures.includes(`required-evidence-invalid:${PHASE8_GATE_COMPONENTS[0].id}`));
  const prerequisite = fixture(); prerequisite.prerequisiteEvidence.acceptedPhases = [3, 4];
  assert.ok(evaluatePhase8Gate(prerequisite).failures.includes("failed-or-stale-prerequisite-evidence"));
  const stalePrerequisite = fixture(); stalePrerequisite.prerequisiteEvidence.evaluator.sourceRevision = "f".repeat(40);
  assert.ok(evaluatePhase8Gate(stalePrerequisite).failures.includes("failed-or-stale-prerequisite-evidence"));
});
