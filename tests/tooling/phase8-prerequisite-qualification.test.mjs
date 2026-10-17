import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluatePhase8Prerequisites, PHASE8_PREREQUISITES } from "../../scripts/phase8-prerequisite-qualification.mjs";

const revision = "d".repeat(40);
const tree = "e".repeat(64);
const now = Date.parse("2026-10-16T12:00:00.000Z");
const migrationInventory = [{ name: "migration.sql", sha256: "c".repeat(64) }, { name: "second.sql", sha256: "d".repeat(64) }];
const executedChecks = (phase) => Array.from({ length: 10 }, (_, index) => ({ name: `acceptance-${index + 1}`, runId: `phase-${phase}-run-123456`, executed: true, passed: true }));
const evaluate = (root, overrides = {}) => evaluatePhase8Prerequisites({ root, sourceRevision: "d".repeat(40),
  sourceTreeSha256: "e".repeat(64), now, resolveSourceTree: () => tree,
  resolveMigrationInventory: () => migrationInventory, isAncestor: () => true, ...overrides });
const valid = (phase, overrides = {}) => ({ ticket: phase === 3 ? 55 : phase === 4 ? 90 : phase === 5 ? 125 : phase === 6 ? 164 : 209,
  verdict: "pass", runId: `phase-${phase}-run-123456`, sourceRevision: revision, sourceTreeSha256: tree,
  startedAt: new Date(now - 60_000).toISOString(), completedAt: new Date(now - 30_000).toISOString(),
  required: { success: true, executed: 10, failed: 0, skipped: 0 }, counts: { total: 10 }, checks: executedChecks(phase), cleanup: true,
  guarantees: { sourceBound: true, successfulCleanup: true },
  migrations: migrationInventory, toolVersions: { node: "24.21.0", npm: "11.19.0" },
  realServiceScope: { postgresVersion: "PostgreSQL 18.3", runId: `phase-${phase}-run-123456`, sourceRevision: revision,
    sourceTreeSha256: tree, isolation: "isolated-loopback",
    startedAt: new Date(now - 60_000).toISOString(), completedAt: new Date(now - 30_000).toISOString(),
    cleanup: true, cleanUpgrade: { equivalent: true }, services: {
      postgres: { available: true, majorVersion: 18, executionCount: 2 },
      auth: { available: true, executionCount: 1 },
      storage: { available: true, privateBucketVerified: true, executionCount: 3 },
    }, restrictedAccess: { matrix: [
      { grantee: "anon", schemaPrivileges: { measurement: { usage: false, create: false } }, tablePrivileges: "{}" },
      { grantee: "authenticated", schemaPrivileges: { measurement: { usage: false, create: false } }, tablePrivileges: "{}" },
      { grantee: "service_role", schemaPrivileges: { measurement: { usage: false, create: false } }, tablePrivileges: "{}" },
    ] }, required: { success: true }, checks: [{ command: "postgres-clean-upgrade", passed: true }] }, ...overrides });

function fixture(reports) {
  const root = mkdtempSync(join(tmpdir(), "phase8-prereq-"));
  for (const { phase, ticket, path } of PHASE8_PREREQUISITES) {
    const report = Object.hasOwn(reports, phase) ? reports[phase] : valid(phase);
    const target = join(root, path);
    mkdirSync(join(target, ".."), { recursive: true });
    if (report !== null) writeFileSync(target, JSON.stringify(report));
  }
  return root;
}

test("accepts only complete source-bound successful artifacts with cleanup", () => {
  const root = fixture({});
  try {
    const result = evaluate(root);
    assert.equal(result.verdict, "pass");
    assert.equal(result.mergeEligible, true);
    assert.deepEqual(result.acceptedPhases, [3, 4, 5, 6, 7]);
    assert.equal(result.statusLayers.humanApproval, "not-recorded-by-this-evaluator");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reports precise safe blockers for missing, stale, mismatched, partial, skipped and failed evidence", () => {
  const root = fixture({
    3: null,
    4: valid(4, { sourceTreeSha256: "f".repeat(64), checks: [{ runId: "phase-4-run-123456",
      sourceRevision: revision, sourceTreeSha256: tree }] }),
    5: valid(5, { startedAt: "2026-09-01T00:00:00.000Z", completedAt: "2026-09-01T00:01:00.000Z" }),
    6: valid(6, { required: { success: true, executed: 0, failed: 0, skipped: 0 } }),
    7: valid(7, { verdict: "fail", required: { success: false, executed: 10, failed: 2, skipped: 1 }, cleanup: false }),
  });
  try {
    const result = evaluate(root);
    assert.equal(result.verdict, "blocked");
    assert.equal(result.mergeEligible, false);
    const reasonMap = new Map(result.blockers.map((blocker) => [blocker.phase, blocker.reasons]));
    assert.ok(reasonMap.get(3).includes("evidence-report-absent"));
    assert.ok(reasonMap.get(4).includes("source-binding-mismatch"));
    assert.ok(reasonMap.get(5).includes("evidence-stale"));
    assert.ok(reasonMap.get(6).includes("executed-coverage-missing"));
    assert.ok(reasonMap.get(7).includes("aggregate-failed"));
    assert.ok(reasonMap.get(7).includes("required-failures-present"));
    assert.ok(reasonMap.get(7).includes("required-skips-present"));
    assert.ok(reasonMap.get(7).includes("cleanup-failed"));
    assert.ok(result.blockers.every((blocker) => blocker.nextAction.includes(`#${blocker.ticket}`)));
    assert.ok(result.phases.every((phase) => Array.isArray(phase.failedChecks)));
    assert.equal(JSON.stringify(result).includes("TOKEN"), false);
    assert.equal(result.guarantees.allPrerequisitesSourceBound, false);
    assert.equal(result.guarantees.zeroRequiredFailures, false);
    assert.equal(result.guarantees.zeroRequiredSkips, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects evidence whose source is outside the evaluated history", () => {
  const root = fixture({});
  try {
    const result = evaluate(root, { isAncestor: (source) => source !== revision });
    assert.ok(result.blockers.every(({ reasons }) => reasons.includes("source-revision-not-in-evaluated-history")));
    assert.equal(result.guarantees.zeroRequiredFailures, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("accepts ancestor evidence when its source tree matches the evaluated tree", () => {
  const ancestorEvidence = valid(3, { sourceRevision: "a".repeat(40) });
  ancestorEvidence.realServiceScope.sourceRevision = "a".repeat(40);
  const root = fixture({ 3: ancestorEvidence });
  try {
    const result = evaluate(root, { isAncestor: () => true });
    const reasons = result.blockers.find((phase) => phase.phase === 3)?.reasons ?? [];
    assert.equal(reasons.includes("source-revision-mismatch"), false);
    assert.equal(result.phases.find((phase) => phase.phase === 3).accepted, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects a source-tree fingerprint that does not match the immutable source revision", () => {
  const root = fixture({});
  try {
    const result = evaluate(root, { resolveSourceTree: () => "f".repeat(64) });
    assert.ok(result.blockers.every(({ reasons }) => reasons.includes("source-tree-fingerprint-mismatch")));
    assert.equal(result.guarantees.zeroRequiredSkips, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects absent denominators, unnamed coverage, wrong tool pins, and incomplete migration checksums", () => {
  const root = fixture({
    3: valid(3, { counts: undefined, checks: undefined }),
    4: valid(4, { toolVersions: { node: "18.0.0", npm: "8.0.0" } }),
    5: valid(5, { migrations: [{ name: "migration.sql" }] }),
    6: valid(6, { counts: { total: 10 }, checks: Array.from({ length: 10 }, (_, index) => ({ id: `check-${index}`, executed: true, passed: true })).map(({ id }) => ({ executed: true, passed: true, id: "" })) }),
  });
  try {
    const result = evaluate(root);
    const reasonMap = new Map(result.blockers.map((blocker) => [blocker.phase, blocker.reasons]));
    assert.ok(reasonMap.get(3).includes("executed-coverage-partial"));
    assert.ok(reasonMap.get(4).includes("tool-version-mismatch"));
    assert.ok(reasonMap.get(5).includes("migration-checksum-incomplete-or-invalid"));
    assert.ok(reasonMap.get(6).includes("executed-coverage-partial"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("uses a complete named gate checklist as the denominator when aggregate counts are absent", () => {
  const phaseFourChecks = Array.from({ length: 19 }, (_, index) => ({ name: `phase4-check-${index + 1}`, passed: true }));
  const root = fixture({ 4: valid(4, { counts: undefined, required: undefined, checks: phaseFourChecks, migrations: migrationInventory }) });
  try {
    const result = evaluate(root);
    const phaseFour = result.phases.find((phase) => phase.phase === 4);
    assert.equal(phaseFour.required.executed, 19);
    assert.equal(phaseFour.reasons.includes("executed-coverage-partial"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("component cleanup failures cannot be overridden by aggregate cleanup claims", () => {
  const root = fixture({ 7: valid(7, { components: [{ cleanup: false }], cleanup: true,
    guarantees: { sourceBound: true, successfulCleanup: true } }) });
  try {
    const result = evaluate(root);
    const phaseSeven = result.phases.find((phase) => phase.phase === 7);
    assert.ok(phaseSeven.reasons.includes("cleanup-failed"));
    assert.equal(result.guarantees.successfulCleanup, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reports sanitized failed check names and the owning predecessor action", () => {
  const root = fixture({ 5: valid(5, { checks: [
    { name: "owner-postgres", passed: false, failure: "exit-nonzero", output: "postgres://private" },
    { name: "database-rls", passed: true },
  ] }) });
  try {
    const result = evaluate(root);
    const phaseFive = result.phases.find((phase) => phase.phase === 5);
    const blocker = result.blockers.find((item) => item.phase === 5);
    assert.deepEqual(phaseFive.failedChecks, ["owner-postgres"]);
    assert.match(phaseFive.nextAction, /predecessor #125/u);
    assert.equal(JSON.stringify(blocker).includes("postgres://private"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects incomplete migration inventories and malformed real-service scope", () => {
  const root = fixture({ 5: valid(5, { migrations: migrationInventory.slice(0, 1) }),
    4: valid(4, { realServiceScope: { ...valid(4).realServiceScope, sourceRevision: "f".repeat(40) } }),
    3: valid(3, { realServiceScope: "isolated PostgreSQL" }),
    7: valid(7, { realServiceScope: { ...valid(7).realServiceScope, isolation: "not isolated-loopback" } }),
    6: valid(6, { realServiceScope: { postgresVersion: "PostgreSQL 18.3", projects: ["production"], isolatedLoopbackProjects: ["production"], required: { success: true },
      cleanUpgrade: { equivalent: true }, restrictedAccess: { matrix: [
        { grantee: "anon", schemaPrivileges: { measurement: { usage: false, create: false } }, tablePrivileges: "{}" },
        { grantee: "authenticated", schemaPrivileges: { measurement: { usage: false, create: false } }, tablePrivileges: "{}" },
      ] }, checks: [{ command: "check", passed: true }],
      runId: "phase-6-run-123456", sourceRevision: revision, sourceTreeSha256: tree,
      startedAt: new Date(now - 60_000).toISOString(), completedAt: new Date(now - 30_000).toISOString(), cleanup: true } }) });
  try {
    const result = evaluate(root);
    const reasonMap = new Map(result.blockers.map((blocker) => [blocker.phase, blocker.reasons]));
    assert.ok(reasonMap.get(5).includes("migration-checksum-incomplete-or-invalid"));
    assert.ok(reasonMap.get(4).includes("real-service-scope-unverified"));
    assert.ok(reasonMap.get(4).includes("source-binding-mismatch"));
    assert.ok(reasonMap.get(3).includes("real-service-scope-unverified"));
    assert.ok(reasonMap.get(6).includes("real-service-scope-unverified"));
    assert.ok(reasonMap.get(7).includes("real-service-scope-unverified"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects restricted-access matrices with empty schema privileges or malformed table grants", () => {
  const malformedScope = (tablePrivileges) => ({ ...valid(4).realServiceScope,
    restrictedAccess: { matrix: [
      { grantee: "anon", schemaPrivileges: {}, tablePrivileges },
      { grantee: "authenticated", schemaPrivileges: { measurement: { usage: false, create: false } }, tablePrivileges },
    ] } });
  const root = fixture({ 3: valid(3, { realServiceScope: malformedScope("{}") }),
    4: valid(4, { realServiceScope: malformedScope("not-json") }) });
  try {
    const result = evaluate(root);
    const reasonMap = new Map(result.blockers.map((blocker) => [blocker.phase, blocker.reasons]));
    assert.ok(reasonMap.get(3).includes("real-service-scope-unverified"));
    assert.ok(reasonMap.get(4).includes("real-service-scope-unverified"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("requires unique Phase 7 restricted-access principals including service_role", () => {
  const matrix = valid(7).realServiceScope.restrictedAccess.matrix;
  for (const incomplete of [matrix.slice(0, 2), [matrix[0], matrix[0], matrix[2]]]) {
    const root = fixture({ 7: valid(7, { realServiceScope: { ...valid(7).realServiceScope,
      restrictedAccess: { matrix: incomplete } } }) });
    try {
      const result = evaluate(root);
      const phaseSeven = result.phases.find((phase) => phase.phase === 7);
      assert.ok(phaseSeven.reasons.includes("real-service-scope-unverified"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("Phase 4 requires real Auth evidence and Phase 6 requires real Auth and private Storage evidence", () => {
  const phaseFourScope = valid(4).realServiceScope;
  const phaseSixScope = valid(6).realServiceScope;
  const root = fixture({
    4: valid(4, { realServiceScope: { ...phaseFourScope, services: { ...phaseFourScope.services,
      auth: { available: false, executionCount: 0 } } } }),
    6: valid(6, { realServiceScope: { ...phaseSixScope, services: { ...phaseSixScope.services,
      storage: { available: true, privateBucketVerified: false, executionCount: 3 } } } }),
  });
  try {
    const result = evaluate(root);
    const reasonMap = new Map(result.blockers.map((blocker) => [blocker.phase, blocker.reasons]));
    assert.ok(reasonMap.get(4).includes("real-service-scope-unverified"));
    assert.ok(reasonMap.get(6).includes("real-service-scope-unverified"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects Phase 7 public-role grants to sensitive schemas", () => {
  const scope = valid(7).realServiceScope;
  const root = fixture({ 7: valid(7, { realServiceScope: { ...scope, restrictedAccess: { matrix: scope.restrictedAccess.matrix.map((row, index) =>
    index === 0 ? { ...row, schemaPrivileges: { measurement: { usage: true, create: false } }, tablePrivileges: JSON.stringify({ SELECT: true }) } : row) } } }) });
  try {
    const result = evaluate(root);
    const phaseSeven = result.phases.find((phase) => phase.phase === 7);
    assert.ok(phaseSeven.reasons.includes("real-service-scope-unverified"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reports malformed evidence collection shapes without throwing", () => {
  const root = fixture({ 4: valid(4, { checks: {} }), 5: valid(5, { evidenceArtifacts: {} }), 6: valid(6, { components: {} }) });
  try {
    const result = evaluate(root);
    const reasonMap = new Map(result.blockers.map((blocker) => [blocker.phase, blocker.reasons]));
    for (const phase of [4, 5, 6]) assert.ok(reasonMap.get(phase).includes("evidence-structure-invalid"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
