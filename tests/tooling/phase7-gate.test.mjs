import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluatePhase7Gate,
  PHASE7_GATE_COMPONENTS,
  PHASE7_GATE_CRITERION_MATRIX,
  PHASE7_GATE_REQUIRED_CHECKS,
  PHASE7_GATE_SCENARIOS,
} from "../../scripts/phase7-gate-support.mjs";

const sourceRevision = "a".repeat(40);
const sourceTreeSha256 = "b".repeat(64);
const startedAt = "2026-10-16T10:00:00.000Z";

function fixture() {
  const artifacts = PHASE7_GATE_COMPONENTS.map((component) => ({
    id: component.id, path: component.path, runId: `run-${component.id}-1234`, sourceRevision, sourceTreeSha256,
    sha256: "c".repeat(64), fresh: true, sourceBound: true, positiveExecution: true, aggregateSuccess: true,
    cleanup: true, accepted: true,
    ...(component.id === "http-assembly" ? { routes: { publicOperations: 5, ownerOperations: 48, operationalRoutes: 2,
      runtimeRoutes: 0, phase7PublicMutations: 4, phase7OwnerOperations: 7 } } : {}),
  }));
  const checks = PHASE7_GATE_REQUIRED_CHECKS.map((name) => ({ name, executed: true, passed: true, exitCode: 0, skipped: 0 }));
  const serviceEvidence = {
    ticket: 208,
    required: { success: true, passed: 10, failed: 0, skipped: 0, failedSuites: 0 },
    cleanup: true,
    cleanUpgrade: { equivalent: true, generatedTypesVerified: ["interaction", "measurement"] },
    postgresVersion: "PostgreSQL 18.3",
    restrictedAccess: { matrix: [{ grantee: "anon" }, { grantee: "authenticated" }, { grantee: "service_role" }], privateSentinel: "private sentinel absent" },
    queryPlans: { plans: [{ indexes: ["a"] }, { indexes: ["b"] }, { indexes: ["c"] }, { indexes: ["d"] }, { indexes: ["e"] }] },
    migrations: [{ name: "20261014194925_measurement_consent.sql", sha256: "d".repeat(64) }],
  };
  return {
    runId: "gate-run-12345678", startedAt, sourceRevision, sourceTreeSha256,
    runtime: { node: "v24.21.0", npm: "11.19.0" }, expectedRuntime: { node: "24.21.0", npm: "11.19.0" },
    checks, evidenceArtifacts: artifacts, serviceEvidence,
    now: Date.parse("2026-10-16T10:10:00.000Z"),
  };
}

test("Phase 7 gate maps each parent criterion and required domain scenario to executed evidence", () => {
  assert.equal(PHASE7_GATE_CRITERION_MATRIX.length, 70);
  assert.deepEqual(PHASE7_GATE_CRITERION_MATRIX.map(({ id }) => id), Array.from({ length: 70 }, (_, i) => `P7-${String(i + 1).padStart(2, "0")}`));
  assert.equal(PHASE7_GATE_SCENARIOS.length, 7);
  const result = evaluatePhase7Gate(fixture());
  assert.equal(result.verdict, "pass", result.failures.join(", "));
  assert.equal(result.counts.executedCriteria, 70);
});

test("gate rejects runtime mismatch, missing services, stale evidence, skips, failed aggregates, incomplete reports, and failed cleanup", () => {
  const runtime = fixture();
  runtime.runtime.node = "v20.0.0";
  assert.ok(evaluatePhase7Gate(runtime).failures.includes("runtime-pin-mismatch"));

  const missingServices = fixture();
  missingServices.serviceEvidence = null;
  assert.ok(evaluatePhase7Gate(missingServices).failures.includes("integrated-postgres-auth-privacy-plan-evidence-incomplete"));

  const stale = fixture();
  stale.evidenceArtifacts[0].sourceTreeSha256 = "e".repeat(64);
  stale.evidenceArtifacts[0].sourceBound = false;
  stale.evidenceArtifacts[0].accepted = false;
  assert.ok(evaluatePhase7Gate(stale).failures.includes("required-evidence-invalid:consent"));

  const skipped = fixture();
  skipped.checks[0].passed = false;
  skipped.checks[0].exitCode = 1;
  skipped.checks[0].skipped = 1;
  assert.ok(evaluatePhase7Gate(skipped).failures.includes("required-check-failed:validation-ready"));

  const aggregateFailure = fixture();
  aggregateFailure.checks.find(({ name }) => name === "integrated").aggregateSuccess = false;
  assert.ok(evaluatePhase7Gate(aggregateFailure).failures.includes("required-check-failed:integrated"));

  const incomplete = fixture();
  incomplete.evidenceArtifacts = incomplete.evidenceArtifacts.filter(({ id }) => id !== "jobs");
  assert.ok(evaluatePhase7Gate(incomplete).failures.includes("required-evidence-invalid:jobs"));

  const cleanup = fixture();
  cleanup.evidenceArtifacts.find(({ id }) => id === "integrated").cleanup = false;
  cleanup.evidenceArtifacts.find(({ id }) => id === "integrated").accepted = false;
  assert.ok(evaluatePhase7Gate(cleanup).failures.includes("required-evidence-invalid:integrated"));

  const wrongRouteCount = fixture();
  wrongRouteCount.evidenceArtifacts.find(({ id }) => id === "http-assembly").routes.phase7OwnerOperations = 6;
  assert.ok(evaluatePhase7Gate(wrongRouteCount).failures.includes("http-operation-boundary-evidence-incomplete"));
});
