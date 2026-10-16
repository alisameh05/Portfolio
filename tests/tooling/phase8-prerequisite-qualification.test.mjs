import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluatePhase8Prerequisites, PHASE8_PREREQUISITES } from "../../scripts/phase8-prerequisite-qualification.mjs";

const revision = "a".repeat(40);
const tree = "b".repeat(64);
const now = Date.parse("2026-10-16T12:00:00.000Z");
const valid = (phase, overrides = {}) => ({ ticket: phase === 3 ? 55 : phase === 4 ? 90 : phase === 5 ? 125 : phase === 6 ? 164 : 209,
  verdict: "pass", runId: `phase-${phase}-run-123456`, sourceRevision: revision, sourceTreeSha256: tree,
  startedAt: new Date(now - 60_000).toISOString(), completedAt: new Date(now - 30_000).toISOString(),
  required: { success: true, executed: 10, failed: 0, skipped: 0 }, cleanup: true,
  guarantees: { sourceBound: true, successfulCleanup: true },
  migrations: [{ name: "migration.sql", sha256: "c".repeat(64) }], toolVersions: { node: "24.21.0", npm: "11.19.0" },
  realServiceScope: "isolated-postgresql", ...overrides });

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
    const result = evaluatePhase8Prerequisites({ root, sourceRevision: "d".repeat(40), sourceTreeSha256: "e".repeat(64), now,
      resolveTree: () => tree, isAncestor: () => true });
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
    const result = evaluatePhase8Prerequisites({ root, sourceRevision: "d".repeat(40), sourceTreeSha256: "e".repeat(64), now,
      resolveTree: () => tree, isAncestor: () => true });
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
    assert.equal(JSON.stringify(result).includes("TOKEN"), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects evidence whose source is outside the evaluated history", () => {
  const root = fixture({});
  try {
    const result = evaluatePhase8Prerequisites({ root, sourceRevision: "d".repeat(40), sourceTreeSha256: "e".repeat(64), now,
      resolveTree: () => tree, isAncestor: (source) => source !== revision });
    assert.ok(result.blockers.every(({ reasons }) => reasons.includes("source-revision-not-in-evaluated-history")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
