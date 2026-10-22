import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyCheckResult,
  databaseEvidenceShapeErrors,
  evaluateGate,
  REQUIRED_PHASE4_CHECK_NAMES,
  sanitizeEvidenceOutput,
} from "../../scripts/phase4-gate-support.mjs";
import { approvedWindowsPhase2Skip, normalizeQualificationCommandResult, WINDOWS_PHASE2_NONREQUIRED_SKIP } from "../../scripts/qualification-command.mjs";

test("the required checklist includes every predecessor and Phase 4 acceptance runner", () => {
  assert.deepEqual(REQUIRED_PHASE4_CHECK_NAMES, [
    "predecessor-phase1",
    "predecessor-phase2",
    "predecessor-phase3-source",
    "validation-ready",
    "exact-toolchain",
    "contract-verification",
    "tooling-tests",
    "typecheck",
    "lint",
    "production-build",
    "architecture",
    "route-inventory",
    "runtime-boundary",
    "runtime-architecture",
    "phase4-context",
    "phase4-focused-tests",
    "phase4-migration-integrity-tests",
    "phase4-local-auth-real-token",
    "phase4-database-integrity",
  ]);
});

test("a passing constituent passes only when it exits cleanly", () => {
  assert.deepEqual(
    classifyCheckResult({ code: 0, output: "All assertions passed", failOnSkipped: true }),
    { passed: true, exitCode: 0, failure: null },
  );
  // Phase 5 maps the normalized prerequisite-cache outcome into writeCheck's
  // error field, which is forwarded unchanged as classifyCheckResult.spawnError.
  const classifyCached = (outcome) => classifyCheckResult({
    code: outcome.status, spawnError: outcome.errorCode ? { code: outcome.errorCode } : null,
    output: outcome.output, failOnSkipped: true,
  });
  const success = normalizeQualificationCommandResult({ status: 0, output: "All assertions passed" });
  assert.equal(success.errorCode, null);
  assert.deepEqual(classifyCached(success), { passed: true, exitCode: 0, failure: null });
  for (const outcome of [
    normalizeQualificationCommandResult({ status: 0, errorCode: "ENOENT", output: "command could not start" }),
    normalizeQualificationCommandResult({ status: 1, output: "command failed" }),
    normalizeQualificationCommandResult({ status: 0, output: "2 skipped" }),
    normalizeQualificationCommandResult({ status: 0, signal: "SIGTERM", output: "command interrupted" }),
    normalizeQualificationCommandResult({ status: 0, timedOut: true, output: "command timed out" }),
  ]) assert.equal(classifyCached(outcome).passed, false);
  for (const spawnError of [null, undefined]) {
    assert.deepEqual(classifyCheckResult({ code: 0, spawnError, output: "All assertions passed" }),
      { passed: true, exitCode: 0, failure: null });
  }
  assert.deepEqual(classifyCheckResult({ code: 0, spawnError: { code: "ENOENT" }, output: "All assertions passed" }),
    { passed: false, exitCode: 1, failure: "spawn-failed" });
});

test("a required local service cannot pass when unavailable even with exit code zero", () => {
  assert.deepEqual(
    classifyCheckResult({
      code: 0,
      output: "LOCAL_DB_UNAVAILABLE",
      requiresService: "loopback PostgreSQL",
    }),
    { passed: false, exitCode: 1, failure: "required-service-unavailable" },
  );
});

test("skipped and partial required results fail", () => {
  for (const output of ["2 skipped", "Skipped tests: 1", "partial result: 1 check missing"]) {
    assert.deepEqual(
      classifyCheckResult({ code: 0, output, failOnSkipped: true }),
      { passed: false, exitCode: 1, failure: "skipped-or-partial" },
    );
  }
  assert.deepEqual(
    classifyCheckResult({
      code: 0,
      output: "Phase 3 historical database invariants: 107 passed, 0 skipped before Phase 4 migrations.",
      failOnSkipped: true,
    }),
    { passed: true, exitCode: 0, failure: null },
  );
});

test("Phase 2's single known Windows helper-process skip is the only tolerated skip", () => {
  const knownSkip = `↓ ${WINDOWS_PHASE2_NONREQUIRED_SKIP}\nTests 629 passed | 1 skipped (630)`;
  assert.equal(approvedWindowsPhase2Skip(knownSkip, { platform: "win32", phase2RuntimeSuite: true }), true);
  assert.equal(approvedWindowsPhase2Skip(`${knownSkip}\n↓ other.test.ts > skipped`, { platform: "win32", phase2RuntimeSuite: true }), false);
  assert.equal(approvedWindowsPhase2Skip(knownSkip, { platform: "linux", phase2RuntimeSuite: true }), false);
  assert.deepEqual(classifyCheckResult({ code: 0, output: knownSkip, failOnSkipped: true,
    allowWindowsPhase2HelperProcessSkip: true, platform: "win32" }),
  { passed: true, exitCode: 0, failure: null });
  assert.deepEqual(classifyCheckResult({ code: 0, output: "Tests 623 passed | 2 skipped (625)", failOnSkipped: true,
    allowWindowsPhase2HelperProcessSkip: true, platform: "win32" }),
  { passed: false, exitCode: 1, failure: "skipped-or-partial" });
  assert.deepEqual(classifyCheckResult({ code: 0, output: knownSkip, failOnSkipped: true,
    allowWindowsPhase2HelperProcessSkip: true, platform: "linux" }),
  { passed: false, exitCode: 1, failure: "skipped-or-partial" });
});

test("evidence redacts database credentials, bearer tokens, and private payload fields", () => {
  const output = sanitizeEvidenceOutput(
    'postgres://user:db-secret@127.0.0.1/db Authorization: Bearer signed-token password=app-secret githubSubject=gh-private-123 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature123456 eyJhbGciOiJub25lIn0.e30. {"email":"owner@example.test","access_token":"access-secret","sessionId":"session-secret","githubSubject":"gh-private-456","github_subject":"gh-private-789","provider-user-subject":"provider-secret-123","provider_user_subject":"provider-secret-456","external_subject":"external-secret-123"}',
    { workspace: "C:\\repo", temporary: "C:\\temp", secrets: ["app-secret"] },
  );

  for (const secret of ["db-secret", "signed-token", "app-secret", "owner@example.test", "access-secret", "session-secret", "gh-private-123", "gh-private-456", "gh-private-789", "provider-secret-123", "provider-secret-456", "external-secret-123", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.signature123456", "eyJhbGciOiJub25lIn0.e30."]) {
    assert.equal(output.includes(secret), false);
  }
});

test("malformed database evidence is reported without crashing the gate", () => {
  assert.deepEqual(databaseEvidenceShapeErrors({ normalizedDatabaseState: { grants: [] } }), [
    "normalizedDatabaseState.policies must be an array",
  ]);
  assert.deepEqual(databaseEvidenceShapeErrors({ normalizedDatabaseState: { grants: [null], policies: [] } }), [
    "normalizedDatabaseState.grants contains an invalid entry",
  ]);
  assert.deepEqual(databaseEvidenceShapeErrors({ normalizedDatabaseState: { grants: [], policies: [] } }), []);
});

test("a successful gate requires every named constituent exactly once", () => {
  const evidence = [{ file: "evidence/phase-4-focused-tests.log", runId: "run-1", revision: "abc", fresh: true }];
  const result = evaluateGate({
    checks: [{ name: "phase4-focused-tests", passed: true }],
    requiredCheckNames: ["phase4-focused-tests", "phase4-local-auth"],
    evidence,
    runId: "run-1",
    revision: "abc",
  });

  assert.equal(result.verdict, "fail");
  assert.deepEqual(result.missingChecks, ["phase4-local-auth"]);
});

test("missing, stale, or duplicate evidence and failed constituents fail the verdict", () => {
  const result = evaluateGate({
    checks: [
      { name: "contracts", passed: true },
      { name: "contracts", passed: true },
      { name: "phase4-settings", passed: false },
    ],
    requiredCheckNames: ["contracts", "phase4-settings"],
    evidence: [
      { file: "evidence/current.json", runId: "run-old", revision: "old", fresh: true },
      { file: "evidence/missing.json", runId: "run-1", revision: "abc", fresh: false },
    ],
    runId: "run-1",
    revision: "abc",
  });

  assert.equal(result.verdict, "fail");
  assert.deepEqual(result.duplicateChecks, ["contracts"]);
  assert.deepEqual(result.failedChecks, ["phase4-settings"]);
  assert.deepEqual(result.staleEvidence, ["evidence/current.json", "evidence/missing.json"]);
});
