import assert from "node:assert/strict";
import test from "node:test";

import { countSkippedTests, evaluatePhase5Gate, REQUIRED_PHASE5_GATE_CHECKS } from "../../scripts/phase5-gate-support.mjs";

const runId = "gate-run-125";
const sourceRevision = "a".repeat(40);
const sourceTreeSha256 = "b".repeat(64);
const startedAt = "2026-10-10T12:00:00.000Z";
const suites = ["authoring", "taxonomy", "traceability", "owner", "database"];

test("counts skipped cases from zero-exit Vitest and Node test summaries", () => {
  assert.equal(countSkippedTests("Test Files 68 passed | 7 skipped (75)\nTests 1013 passed | 143 skipped (1156)"), 143);
  assert.equal(countSkippedTests("# tests 8\n# pass 7\n# skipped 1\n# todo 0"), 1);
  assert.equal(countSkippedTests("All 12 tests passed; 0 skipped."), 0);
});

function makeEvidence() {
  const checks = REQUIRED_PHASE5_GATE_CHECKS.map((name) => ({
    name,
    runId,
    sourceRevision,
    sourceTreeSha256,
    startedAt: "2026-10-10T12:01:00.000Z",
    executed: true,
    passed: true,
    exitCode: 0,
    skipped: 0,
    evidence: { path: `evidence/${name}.log`, sha256: "c".repeat(64) },
  }));
  const constituents = suites.map((suite, index) => ({
    name: suite,
    suite,
    ticket: suite === "owner" ? 122 : suite === "database" ? 123 : null,
    runId: `${suite}-run`,
    startedAt: "2026-10-10T12:02:00.000Z",
    sourceRevision,
    sourceTreeSha256,
    verdict: "pass",
    issues: [],
    counts: { executed: index === 3 || index === 4 ? 1 : 4, failed: 0, skipped: 0, total: index === 3 || index === 4 ? 1 : 4 },
  }));
  const stories = Array.from({ length: 54 }, (_, index) => ({ id: index + 1, tickets: [106], assertions: ["test assertion"] }));
  const scenarios = [1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 14, 15].map((id) => ({ id, tickets: [106], assertions: ["test assertion"] }));
  const integratedEvidence = {
    runId: "integrated-run",
    ticket: 124,
    parent: 106,
    sourceRevision,
    sourceTreeSha256,
    startedAt: "2026-10-10T12:03:00.000Z",
    verdict: "pass",
    scenarioAcceptance: true,
    counts: { executed: 17, failed: 0, skipped: 0, total: 17 },
    constituents,
    coverage: { userStories: stories, scenarios },
    deferred: ["Phase 6 Media processing", "Phase 7 interactions", "Phase 8 workers", "Phase 9-10 release gates"],
  };
  const databaseEvidence = {
    ticket: 123,
    parent: 106,
    runId: "database-run",
    sourceRevision,
    sourceTreeSha256,
    startedAt: "2026-10-10T12:02:00.000Z",
    toolVersions: { node: "24.21.0", npm: "11.19.0" },
    databaseIntegrationTestsPassed: 5,
    skippedCases: 0,
    isolatedLoopbackProjects: true,
    credentialsRecorded: false,
    secretValuesRecorded: false,
    migrationChecksums: [{ file: "20261001000000_example.sql", sha256: "d".repeat(64) }],
    migrationLedger: [{ version: "20261001000000", name: "example" }],
    phase4ReleaseUpgrade: { cleanAndPhase4UpgradeFinalSchemasEquivalent: true },
    cleanUpgradeEquivalent: true,
    migrationReplayNoop: true,
    generatedTypeDrift: false,
    restrictedPrincipalMatrix: [
      { principal: "anon login", privateContentRead: "denied", privateWrite: "denied" },
      { principal: "authenticated login", privateContentRead: "denied", privateWrite: "denied" },
      { principal: "shipwithali_application login with configured Owner claims", privateContentRead: "configured Portfolio only", privateWrite: "approved application grants and forced RLS" },
      { principal: "shipwithali_application login with foreign Portfolio claims", privateContentRead: "denied", privateWrite: "denied" },
      { principal: "shipwithali_worker login", privateContentRead: "denied", privateWrite: "denied" },
      { principal: "shipwithali_migration capability", runtimeLogin: "denied", runtimeCredential: false },
    ],
    authoringTablesWithForcedRls: ["content.items", "content.revisions"],
    databaseIntegrationSuites: [
      { file: "tests/database/content-authoring.integration.test.ts", passed: 4, failed: 0, skipped: 0 },
      { file: "tests/database/owner-composition.integration.test.ts", passed: 1, failed: 0, skipped: 0 },
      { file: "tests/database/phase5-security.integration.test.ts", passed: 1, failed: 0, skipped: 0 },
    ],
    pooledConnectionScope: { verifiedAfter: ["success", "expected rejection", "rollback", "fault"], knownPrivateIdsRequireOwnerAuthorization: true },
    diagnosticsPrivacy: {
      auditSuites: [{ passed: 1, failed: 0, skipped: 0 }],
      safeFaultOutcomes: ["POSTGRES_UNAVAILABLE"],
      redactedValuesCovered: ["database URLs", "cookies", "CSRF proofs", "private log fields"],
    },
    databaseTestResults: REQUIRED_PHASE5_GATE_CHECKS.slice(0, 0).concat([
      "publishes English and Arabic independently",
      "rolls back route, pointer, projection, success receipt, and event",
      "serializes simultaneous locale publication",
      "serializes assignment against merge and simultaneous merges",
      "queries only current published locale projections with stable tied-time cursors and controlled facets",
      "denies actual public, authenticated, worker, and backup logins",
    ]).map((name) => ({ name, status: "passed" })),
  };
  const ownerEvidence = {
    ticket: 122,
    parent: 106,
    runId: "owner-run",
    sourceRevision,
    sourceTreeSha256,
    startedAt: "2026-10-10T12:02:00.000Z",
    databaseIntegrationTestsPassed: 1,
    injectedAdapterAndContractTestsPassed: 20,
    skippedCases: 0,
    isolatedLoopbackProjects: true,
    credentialsRecorded: false,
    secretValuesRecorded: false,
    databaseTestResults: [{ name: "keeps the committed route and projection readable after optional delivery port failures", status: "passed" }],
  };
  const contextEvidence = {
    runId: "context-run",
    sourceRevision,
    sourceTreeSha256,
    startedAt: "2026-10-10T12:01:00.000Z",
    phase: "phase5",
    verdict: "pass",
    failures: [],
    operations: { public: 5, owner: 48, forbiddenFindings: 0 },
  };
  return { checks, contextEvidence, integratedEvidence, databaseEvidence, ownerEvidence };
}

function evaluate(overrides = {}) {
  return evaluatePhase5Gate({
    runId,
    sourceRevision,
    sourceTreeSha256,
    startedAt,
    toolVersions: { node: "24.21.0", npm: "11.19.0" },
    ...makeEvidence(),
    ...overrides,
  });
}

test("accepts a complete fresh Phase 5 run with real database and deferred-work evidence", () => {
  const report = evaluate();
  assert.equal(report.verdict, "pass", report.failures.join("; "));
  assert.deepEqual(report.failures, []);
  assert.equal(report.counts.skipped, 0);
  assert.equal(report.coverage.userStories, 54);
  assert.equal(report.coverage.scenarios, 12);
});

test("fails closed when required Docker/PostgreSQL evidence is missing", () => {
  const { databaseEvidence, ...evidence } = makeEvidence();
  const report = evaluate({ ...evidence, databaseEvidence: null });
  assert.equal(report.verdict, "fail");
  assert.ok(report.failures.some((failure) => failure.includes("PostgreSQL")));
});

test("rejects partial suites, zero executions, and required skips", () => {
  const evidence = makeEvidence();
  evidence.integratedEvidence.constituents[0].counts.skipped = 1;
  evidence.integratedEvidence.constituents[0].counts.total = 5;
  evidence.checks[0].skipped = 1;
  const report = evaluate(evidence);
  assert.equal(report.verdict, "fail");
  assert.ok(report.failures.length > 0);

  const zeroRun = makeEvidence();
  zeroRun.integratedEvidence.counts = { executed: 0, failed: 0, skipped: 0, total: 0 };
  assert.equal(evaluate(zeroRun).verdict, "fail");
});

test("rejects stale or malformed source and run identities", () => {
  const evidence = makeEvidence();
  evidence.databaseEvidence.sourceTreeSha256 = "e".repeat(64);
  evidence.checks[1].runId = "another-run";
  assert.equal(evaluate(evidence).verdict, "fail");

  const malformed = makeEvidence();
  malformed.integratedEvidence.sourceRevision = "not-a-commit";
  assert.equal(evaluate(malformed).verdict, "fail");
});

test("rejects failed constituents, missing suites, and unit-only database substitutes", () => {
  const failed = makeEvidence();
  failed.integratedEvidence.constituents[1].verdict = "fail";
  assert.equal(evaluate(failed).verdict, "fail");

  const missing = makeEvidence();
  missing.integratedEvidence.constituents.pop();
  assert.equal(evaluate(missing).verdict, "fail");

  const unitOnly = makeEvidence();
  unitOnly.databaseEvidence.databaseIntegrationTestsPassed = 0;
  unitOnly.databaseEvidence.isolatedLoopbackProjects = false;
  assert.equal(evaluate(unitOnly).verdict, "fail");
});
