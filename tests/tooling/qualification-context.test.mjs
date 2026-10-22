import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contextIdentityErrors,
  currentRuntimeIdentity,
  emptyQualificationRun,
  evidenceFileSha256,
  qualificationDefinitionErrors,
  qualificationDefinitionSha256,
  QUALIFICATION_NODES,
  setQualificationNodeState,
  readQualificationRun,
  recordQualificationNode,
  reusableNodes,
  verifyGatePredecessors,
  writeQualificationRun,
  requiredQualificationCheckNames,
  qualificationReportIsReusable,
  reportArtifactPaths,
} from "../../scripts/qualification-context.mjs";

const identity = { revision: "a".repeat(40), tree: "b".repeat(64), runtime: currentRuntimeIdentity() };
const definitionHash = qualificationDefinitionSha256();
const freshPhase1Report = (checks = requiredQualificationCheckNames("phase1").map((name) => ({ name, ok: true, passed: true,
  exitCode: 0, skipped: 0 }))) => {
  const now = new Date().toISOString();
  return { verdict: "pass", sourceRevision: identity.revision, sourceTreeSha256: identity.tree, toolVersions: identity.runtime,
    startedAt: now, completedAt: now, summary: { total: checks.length, failed: 0 }, checks,
    required: { success: true, failed: 0, skipped: 0 }, cleanup: { success: true }, evidence: [] };
};

function draft() {
  return emptyQualificationRun({ definitionHash, identity, startedAt: new Date().toISOString() });
}

test("the qualification DAG is a valid, acyclic, topologically ordered definition", () => {
  assert.deepEqual(qualificationDefinitionErrors(), []);
  assert.ok(QUALIFICATION_NODES.length >= 9);
  assert.ok(QUALIFICATION_NODES.find((node) => node.id === "evaluator")?.report === "evidence/phase8-prerequisite-qualification.json");
  const before = currentRuntimeIdentity();
  const phase2Checks = requiredQualificationCheckNames("phase2").map((name) => ({ name, passed: true, exitCode: 0,
    skipped: 0, executed: true, observedSkipped: name === "http-adapter-tests" ? 1 : 0,
    nonRequiredSkips: name === "http-adapter-tests" ? ["tests/runtime/media-processing-tools.test.ts > bounded PDF output reads > stops helper processes before rejecting a timed out or oversized worker"] : [] }));
  const windowsIdentity = { ...identity, sourceTreeSha256: identity.tree, runtime: { ...identity.runtime, platform: "win32" } };
  const phase2Report = { verdict: "pass", sourceRevision: identity.revision, sourceTreeSha256: identity.tree,
    toolVersions: windowsIdentity.runtime, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    summary: { total: phase2Checks.length, failed: 0 }, required: { success: true, failed: 0, skipped: 0 },
    cleanup: { success: true }, observedSkipped: 1, nonRequiredSkips: phase2Checks.at(-3).nonRequiredSkips, checks: phase2Checks };
  assert.equal(qualificationReportIsReusable(phase2Report, windowsIdentity, "phase2"), true);
  const linuxIdentity = { ...windowsIdentity, runtime: { ...identity.runtime, platform: "linux" } };
  assert.equal(qualificationReportIsReusable(phase2Report, linuxIdentity, "phase2"), false);
  const unexpectedWindowsSkip = structuredClone(phase2Report);
  unexpectedWindowsSkip.checks.at(-3).nonRequiredSkips = ["another skipped test"];
  assert.equal(qualificationReportIsReusable(unexpectedWindowsSkip, windowsIdentity, "phase2"), false);
  const saved = Object.fromEntries(["PHASE8_QUALIFICATION_CONTEXT", "PHASE8_ACTIVE_RUN_ID", "PHASE8_DEFINITION_HASH",
    "SHIPWITHALI_PHASE", "PHASE3_GATE_RUN_ID"].map((name) => [name, process.env[name]]));
  try {
    process.env.PHASE8_QUALIFICATION_CONTEXT = "temporary-context-path";
    process.env.PHASE8_ACTIVE_RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
    process.env.PHASE8_DEFINITION_HASH = "a".repeat(64);
    process.env.SHIPWITHALI_PHASE = "phase4";
    process.env.PHASE3_GATE_RUN_ID = "another-run";
    assert.deepEqual(currentRuntimeIdentity(), before);
    process.env.PHASE8_TEST_INPUT = "meaningful-input";
    assert.notDeepEqual(currentRuntimeIdentity(), before);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    delete process.env.PHASE8_TEST_INPUT;
  }
});

test("completed nodes are reusable only while identity, definition, and evidence digests still verify", () => {
  const root = mkdtempSync(join(tmpdir(), "qualification-context-"));
  try {
    mkdirSync(join(root, "evidence"), { recursive: true });
    const reportFile = join(root, "evidence", "phase-1-gate-report.json");
    const artifactFile = join(root, "evidence", "phase-1-check.log");
    writeFileSync(artifactFile, "passed\n", "utf8");
    const report = freshPhase1Report();
    writeFileSync(join(root, "evidence", "phase7-component.json"), "{}\n", "utf8");
    writeFileSync(join(root, "evidence", "phase7-service.json"), "{}\n", "utf8");
    report.evidence.push({ file: "evidence/phase-1-check.log", fresh: true });
    report.components = [{ path: "evidence/phase7-component.json" }];
    report.serviceEvidence = { evidence: "evidence/phase7-service.json" };
    writeFileSync(reportFile, JSON.stringify(report) + "\n", "utf8");
    const digest = createHash("sha256").update(readFileSync(reportFile)).digest("hex");
    const run = draft();
    run.status = "complete";
    recordQualificationNode(run, { id: "validation-environment" });
    recordQualificationNode(run, { id: "phase1", report: { file: "evidence/phase-1-gate-report.json", sha256: digest },
      artifacts: reportArtifactPaths(report).map((file) => ({ file, sha256: evidenceFileSha256(root, file) })) });
    assert.deepEqual(
      contextIdentityErrors(run, { revision: identity.revision, sourceTreeSha256: identity.tree, definitionHash }),
      [],
    );
    assert.ok(reusableNodes(run, ["phase1"], root).has("phase1"));
    assert.deepEqual(reportArtifactPaths(report), ["evidence/phase-1-check.log", "evidence/phase7-component.json", "evidence/phase7-service.json"]);
    writeFileSync(reportFile, JSON.stringify({ verdict: "pass" }) + "\n", "utf8");
    run.nodes.phase1.report.sha256 = evidenceFileSha256(root, "evidence/phase-1-gate-report.json");
    assert.equal(reusableNodes(run, ["phase1"], root).size, 0, "a verdict-only report is never a successful proof");
    writeFileSync(reportFile, JSON.stringify(report) + "\n", "utf8");
    run.nodes.phase1.report.sha256 = evidenceFileSha256(root, "evidence/phase-1-gate-report.json");
    assert.ok(
      contextIdentityErrors(run, { revision: "c".repeat(40), sourceTreeSha256: identity.tree, definitionHash })
        .includes("QUALIFICATION_CONTEXT_SOURCE_CHANGED"),
    );
    assert.ok(
      contextIdentityErrors(run, { revision: identity.revision, sourceTreeSha256: identity.tree, definitionHash: "d".repeat(64) })
        .includes("QUALIFICATION_CONTEXT_DEFINITION_DRIFTED"),
    );
    // Digest drift in the recorded node fails closed.
    const corrupted = structuredClone(run);
    corrupted.nodes.phase1.report.sha256 = "e".repeat(64);
    assert.equal(reusableNodes(corrupted, ["phase1"], root).size, 0);
    writeFileSync(artifactFile, "changed after the gate\n", "utf8");
    assert.equal(reusableNodes(run, ["phase1"], root).size, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("safe resume reuses only a clean successful prefix and invalidates descendants when an artifact changes", () => {
  const root = mkdtempSync(join(tmpdir(), "qualification-prefix-"));
  try {
    mkdirSync(join(root, "evidence"), { recursive: true });
    const phase1 = join(root, "evidence/phase-1-gate-report.json");
    writeFileSync(phase1, JSON.stringify(freshPhase1Report()));
    const run = draft();
    recordQualificationNode(run, { id: "validation-environment" });
    recordQualificationNode(run, { id: "phase1", report: { file: "evidence/phase-1-gate-report.json", sha256: evidenceFileSha256(root, "evidence/phase-1-gate-report.json") } });
    setQualificationNodeState(run, "phase2", "failed", 1);
    run.status = "failed";
    assert.deepEqual([...reusableNodes(run, ["phase1", "phase2", "phase3"], root, { allowIncomplete: true })], ["phase1"]);
    writeFileSync(phase1, "corrupted artifact");
    assert.equal(reusableNodes(run, ["phase1", "phase2", "phase3"], root, { allowIncomplete: true }).size, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resume report proof rejects missing or changed tools, migrations, scope, checks, freshness, or cleanup", () => {
  const migration = { name: "001_baseline.sql", sha256: "f".repeat(64) };
  const expected = { revision: identity.revision, sourceTreeSha256: identity.tree, runtime: identity.runtime, migrations: [{ ...migration }] };
  const names = requiredQualificationCheckNames("phase3");
  const now = Date.now();
  const makeReport = () => ({
    verdict: "pass", sourceRevision: identity.revision, sourceTreeSha256: identity.tree,
    toolVersions: { node: process.version, npm: identity.runtime.npm },
    required: { success: true, failed: 0, skipped: 0 },
    cleanup: { attempted: true, success: true },
    realServiceScope: { isolation: "isolated", postgresVersion: "PostgreSQL 18", cleanup: { success: true },
      runId: "run-12345678", sourceRevision: identity.revision, sourceTreeSha256: identity.tree,
      startedAt: new Date(now - 1000).toISOString(), completedAt: new Date(now).toISOString(),
      services: { postgres: { available: true, executionCount: 1 } }, checks: [{ name: "role-rls", passed: true }] },
    migrations: [{ ...migration }], checks: names.map((name) => ({ name, passed: true, exitCode: 0, skipped: 0 })),
    evidence: [], startedAt: new Date(now - 1000).toISOString(), completedAt: new Date(now).toISOString(),
  });
  const root = mkdtempSync(join(tmpdir(), "qualification-proof-"));
  try {
    mkdirSync(join(root, "evidence"), { recursive: true });
    for (const phase of [3, 4, 5, 6, 7]) {
      const nodeId = `phase${phase}`;
      const reportPath = phase === 6 ? "evidence/phase6-gate-report.json" :
        phase === 7 ? "evidence/phase7-gate-report.json" : `evidence/phase-${phase}-gate-report.json`;
      const requiredNames = requiredQualificationCheckNames(nodeId);
      const original = { ...makeReport(), checks: requiredNames.map((name) => ({ name, passed: true, exitCode: 0, skipped: 0 })) };
      writeFileSync(join(root, reportPath), JSON.stringify(original));
      assert.equal(qualificationReportIsReusable(original, expected, nodeId, { root, reportPath }), false,
        `${nodeId}: a pass verdict and fabricated top-level fields do not replace the full normalized migration, scope, freshness, coverage, and cleanup proof`);
    }
    const reportPath = "evidence/phase-3-gate-report.json";
    const original = makeReport();
    assert.equal(qualificationReportIsReusable({ ...original, sourceTreeSha256: "0".repeat(64) }, expected, "phase3", { root, reportPath }), false,
      "the object being checked must match the persisted report bytes");
  } finally { rmSync(root, { recursive: true, force: true }); }
  const mutations = [
    (report) => { delete report.sourceTreeSha256; },
    (report) => { report.toolVersions.npm = "99.0.0"; },
    (report) => { report.migrations[0].sha256 = "0".repeat(64); },
    (report) => { delete report.realServiceScope; },
    (report) => { report.realServiceScope.services.postgres.available = false; },
    (report) => { report.realServiceScope.sourceTreeSha256 = "0".repeat(64); },
    (report) => { report.checks.pop(); },
    (report) => { report.checks[0].passed = false; },
    (report) => { report.cleanup.success = false; },
    (report) => { report.completedAt = new Date(now + 60_000).toISOString(); },
    (report) => { report.completedAt = new Date(now - 15 * 24 * 60 * 60 * 1000).toISOString(); },
    (report) => { delete report.required; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const report = makeReport();
    mutate(report);
    assert.equal(qualificationReportIsReusable(report, expected, "phase3"), false, `mutation ${index}`);
  }
});

test("gate predecessor verification fails closed for missing or drifting contexts", () => {
  const closed = verifyGatePredecessors({
    context: null, nodeIds: ["phase2"], root: process.cwd(),
    revision: identity.revision, sourceTreeSha256: identity.tree, definitionHash,
  });
  assert.equal(closed.usable, false);
  assert.equal(closed.reuse.size, 0);
  const standby = Object.assign(draft(), { status: "complete" });
  const openEmpty = verifyGatePredecessors({
    context: standby, nodeIds: ["phase2"], root: process.cwd(),
    revision: identity.revision, sourceTreeSha256: identity.tree, definitionHash,
  });
  assert.equal(openEmpty.usable, false);
  assert.equal(openEmpty.reuse.size, 0);
  const active = { ...standby, status: "running" };
  const runningContext = verifyGatePredecessors({
    context: active, nodeIds: ["phase2"], root: process.cwd(), revision: identity.revision,
    sourceTreeSha256: identity.tree, definitionHash, activeRunId: active.runId, activeDefinitionHash: definitionHash,
  });
  assert.equal(runningContext.usable, true);
  assert.equal(runningContext.reuse.size, 0);
  const root = mkdtempSync(join(tmpdir(), "qualification-cold-predecessor-"));
  try {
    mkdirSync(join(root, "evidence"), { recursive: true });
    const report = freshPhase1Report();
    report.evidence.push({ file: "evidence/retained-check.log" });
    writeFileSync(join(root, "evidence/retained-check.log"), "passed\n");
    writeFileSync(join(root, "evidence/phase-1-gate-report.json"), JSON.stringify(report));
    const cold = draft();
    cold.identity.services = { unverifiedImages: ["postgres", "gotrue"] };
    recordQualificationNode(cold, { id: "validation-environment" });
    recordQualificationNode(cold, { id: "phase1", report: { file: "evidence/phase-1-gate-report.json",
      sha256: evidenceFileSha256(root, "evidence/phase-1-gate-report.json") },
      artifacts: [{ file: "evidence/retained-check.log", sha256: evidenceFileSha256(root, "evidence/retained-check.log") }] });
    const verify = () => verifyGatePredecessors({ context: cold, nodeIds: ["phase1"], root,
      revision: identity.revision, sourceTreeSha256: identity.tree, definitionHash,
      activeRunId: cold.runId, activeDefinitionHash: definitionHash });
    assert.deepEqual([...verify().reuse.keys()], ["phase1"], "service-free evidence is reusable before service images are pulled");
    assert.ok(contextIdentityErrors(cold, { revision: identity.revision, sourceTreeSha256: identity.tree, definitionHash })
      .includes("QUALIFICATION_CONTEXT_SERVICE_IMAGE_IDENTITY_UNVERIFIED"), "general resume still requires verified images");
    cold.identity.services.unverifiedImages = [];
    assert.deepEqual([...verify().reuse.keys()], ["phase1"], "warming service images preserves the predecessor bytes");
    writeFileSync(join(root, "evidence/retained-check.log"), "changed\n");
    assert.throws(verify, /QUALIFICATION_CONTEXT_PREDECESSOR_INVALID/u, "a completed predecessor cannot silently rerun over its recorded evidence");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the run file round-trips through read/record/write with digest evidence", () => {
  const root = mkdtempSync(join(tmpdir(), "qualification-run-"));
  try {
    const run = draft();
    recordQualificationNode(run, { id: "validation-environment" });
    writeQualificationRun(run, root);
    const parsed = readQualificationRun(root);
    assert.equal(parsed.algorithm, run.algorithm);
    assert.equal(parsed.nodes["validation-environment"].completed, true);
    assert.equal(parsed.nodes["validation-environment"].exitCode, 0);
    assert.equal(parsed.nodes["validation-environment"].report, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("evidence digests are computed for existing files and null otherwise", () => {
  const root = mkdtempSync(join(tmpdir(), "qualification-evidence-"));
  try {
    writeFileSync(join(root, "x.txt"), "payload", "utf8");
    assert.equal(evidenceFileSha256(root, "x.txt").length, 64);
    assert.equal(evidenceFileSha256(root, "missing.txt"), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
