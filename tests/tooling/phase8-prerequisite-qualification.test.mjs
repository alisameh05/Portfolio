import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { migrationSha256 } from "../../scripts/migration-checksum.mjs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluatePhase8Prerequisites, sourceMetadataAtRevision, PHASE8_PREREQUISITES, PHASE8_REQUIRED_CHECKS } from "../../scripts/phase8-prerequisite-qualification.mjs";
import { PHASE6_GATE_ACCEPTANCE_MATRIX, PHASE6_GATE_STORY_MATRIX, PHASE6_GATE_MANDATORY_MATRICES,
  PHASE6_GATE_COMPONENTS, evaluatePhase6Gate } from "../../scripts/phase6-gate-support.mjs";
import { PHASE6_TOOL_DEFINITIONS } from "../../scripts/phase6-verification-support.mjs";
import { PHASE7_GATE_CRITERION_MATRIX, PHASE7_GATE_SCENARIOS, PHASE7_GATE_COMPONENTS } from "../../scripts/phase7-gate-support.mjs";

const revision = "d".repeat(40);
const tree = "e".repeat(64);
const now = Date.parse("2026-10-16T12:00:00.000Z");
const migrationInventory = [{ name: "migration.sql", sha256: "c".repeat(64) }, { name: "second.sql", sha256: "d".repeat(64) }];
const executedChecks = (phase) => PHASE8_REQUIRED_CHECKS[phase].map((name) => ({ name, runId: `phase-${phase}-run-123456`, executed: true, passed: true }));
const componentEvidence = ({ id, path }, phase) => ({ id, path, accepted: true, runId: `component-${id}-run`,
  sha256: "b".repeat(64), sourceRevision: revision, sourceTreeSha256: tree, cleanup: true, fresh: true, sourceBound: true,
  ...(phase === 6 ? { startedAt: new Date(now - 50_000).toISOString(), counts: { executed: 1, failed: 0, skipped: 0 } } :
    { gateRunId: "phase-7-run-123456", positiveExecution: true, aggregateSuccess: true,
      required: { success: true, passed: 1, failed: 0, skipped: 0, failedSuites: 0 } }) });
function coverageEvidence(phase) {
  if (phase === 6) return {
    counts: { checks: 29, checksPassed: 29, acceptanceCriteria: 56, userStories: 48, matrices: PHASE6_GATE_MANDATORY_MATRICES.length,
      evidenceReports: PHASE6_GATE_COMPONENTS.length },
    coverage: structuredClone({ acceptanceCriteria: PHASE6_GATE_ACCEPTANCE_MATRIX, userStories: PHASE6_GATE_STORY_MATRIX,
      mandatoryMatrices: PHASE6_GATE_MANDATORY_MATRICES }),
    evidenceArtifacts: PHASE6_GATE_COMPONENTS.map((component) => ({ ...componentEvidence(component, phase),
      evidenceBinding: { scenarioEvidence: [...new Set(PHASE6_GATE_MANDATORY_MATRICES
        .filter((matrix) => matrix.component === component.id).flatMap((matrix) => matrix.requiredScenarioIds ?? []))]
        .map((scenarioId) => ({ id: scenarioId, executed: true, status: "passed" })) } })),
  };
  if (phase === 7) return {
    counts: { criterionCount: 70, executedCriteria: 70, scenarioCount: 7,
      components: PHASE7_GATE_COMPONENTS.length, acceptedComponents: PHASE7_GATE_COMPONENTS.length },
    criteria: PHASE7_GATE_CRITERION_MATRIX.map((criterion) => ({ ...structuredClone(criterion),
      evidence: criterion.suites.map((id) => PHASE7_GATE_COMPONENTS.some((component) => component.id === id)
        ? `component-${id}-run` : "phase-7-run-123456") })),
    scenarios: PHASE7_GATE_SCENARIOS.map((scenario) => ({ ...structuredClone(scenario), executed: true })),
    components: PHASE7_GATE_COMPONENTS.map((component) => componentEvidence(component, phase)),
  };
  return {};
}
const evaluate = (root, overrides = {}) => evaluatePhase8Prerequisites({ root, sourceRevision: "d".repeat(40),
  sourceTreeSha256: "e".repeat(64), now, resolveSourceTree: () => tree,
  resolveMigrationInventory: () => migrationInventory, isAncestor: () => true, ...overrides });
const valid = (phase, overrides = {}) => ({ ticket: phase === 3 ? 55 : phase === 4 ? 90 : phase === 5 ? 125 : phase === 6 ? 164 : 209,
  verdict: "pass", runId: `phase-${phase}-run-123456`, sourceRevision: revision, sourceTreeSha256: tree,
  startedAt: new Date(now - 60_000).toISOString(), completedAt: new Date(now - 30_000).toISOString(),
  required: { success: true, executed: PHASE8_REQUIRED_CHECKS[phase].length, failed: 0, skipped: 0 },
  counts: { total: PHASE8_REQUIRED_CHECKS[phase].length }, checks: executedChecks(phase), cleanup: true,
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
    ] }, required: { success: true }, checks: [{ command: "postgres-clean-upgrade", passed: true }] }, ...coverageEvidence(phase), ...overrides });

function phase6Aggregate() {
  const base = valid(6);
  const toolVersions = { scanner: "ClamAV 1.4.3/27927", pdfProcessor: "17.12.1",
    imageProcessor: "Version: ImageMagick 7.1.1-47 Q16-HDRI", videoProcessor: "ffprobe version 7.1",
    sharp: "sharp-0.35.4;libvips-8.18.6" };
  const principalScope = { database: "shipwithali_application with scoped Owner/Portfolio policies",
    auth: "disposable loopback Supabase Auth with real issued Owner session claims",
    storage: "private local Storage; anonymous and non-Owner access denied" };
  const evidenceArtifacts = base.evidenceArtifacts.map((artifact, index) => ({ ...artifact,
    ticket: PHASE6_GATE_COMPONENTS[index].ticket }));
  Object.assign(evidenceArtifacts.find(({ id }) => id === "setup").evidenceBinding,
    { toolDefinitions: { ...PHASE6_TOOL_DEFINITIONS }, toolVersions: { ...toolVersions } });
  Object.assign(evidenceArtifacts.find(({ id }) => id === "migration-access").evidenceBinding,
    { migrationChecksums: migrationInventory.map(({ name, sha256 }) => ({ file: name, sha256 })), migrationSetEquivalent: true });
  Object.assign(evidenceArtifacts.find(({ id }) => id === "media-cv-integration").evidenceBinding, { principalScope });
  return evaluatePhase6Gate({ runId: base.runId, startedAt: base.startedAt, sourceRevision: revision, sourceTreeSha256: tree,
    runtime: { node: "24.21.0", npm: "11.19.0" }, expectedRuntime: { node: "24.21.0", npm: "11.19.0" }, now,
    checks: base.checks.map((check) => ({ ...check, exitCode: 0, skipped: 0, timedOut: false })), evidenceArtifacts,
    serviceEvidence: { toolVersions, services: { ...base.realServiceScope.services,
      postgres: { ...base.realServiceScope.services.postgres, independentConnections: 2 },
      scanner: { available: true, version: toolVersions.scanner, executions: 1 },
      processors: { pdf: { available: true, version: toolVersions.pdfProcessor, executions: 1 },
        image: { available: true, version: toolVersions.sharp, executions: 1 },
        video: { available: true, version: toolVersions.videoProcessor, executions: 1 } } },
      principalScope, formats: ["pdf", "png", "jpeg", "webp", "mp4", "webm"].map((id) => ({ id, executed: true, status: "passed" })),
      criteria: Array.from({ length: 11 }, (_, index) => ({ id: `T18-${String(index + 1).padStart(2, "0")}`,
        cases: [{ caseId: `case:T18-${index + 1}`, executed: true, status: "passed" }] })),
      counts: { executed: 11, failed: 0, skipped: 0 }, testRun: { exitStatus: 0, total: 11, failed: 0, skipped: 0 },
      cleanup: { attempted: true, success: true } } });
}

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

test("qualifies the actual Phase 6 aggregate producer's migration and service evidence shape", () => {
  const report = phase6Aggregate();
  assert.equal(report.verdict, "pass", JSON.stringify(report.failures));
  assert.equal(Object.hasOwn(report, "migrations"), false);
  assert.equal(Object.hasOwn(report, "realServiceScope"), false);
  assert.equal(Object.hasOwn(report, "serviceEvidence"), false);
  const root = fixture({ 6: report });
  try {
    const prerequisite = evaluate(root).phases.find((item) => item.phase === 6);
    assert.equal(prerequisite.accepted, true, JSON.stringify(prerequisite.reasons));
    assert.deepEqual(prerequisite.migrations, migrationInventory);
    assert.deepEqual(prerequisite.realServiceScope.services, { postgres: true, auth: true, storage: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("actual Phase 6 aggregate evidence rejects missing or contradictory migrations, services and execution", () => {
  const mutations = [
    ["missing migrations", (report) => { delete report.evidenceSummary.migrationAccess.migrationChecksums; }],
    ["invalid migration checksum", (report) => { report.evidenceSummary.migrationAccess.migrationChecksums[0].sha256 = "invalid"; }],
    ["missing migration equivalence", (report) => { delete report.evidenceSummary.migrationAccess.migrationSetEquivalent; }],
    ["failed migration equivalence", (report) => { report.evidenceSummary.migrationAccess.migrationSetEquivalent = false; }],
    ["missing service proof", (report) => { delete report.evidenceSummary.realServiceAndAdapterProof; }],
    ["missing principal scope", (report) => { delete report.evidenceSummary.realServiceAndAdapterProof.principalScope; }],
    ...["database", "auth", "storage"].map((principal) => [`missing ${principal} scope`, (report) => {
      delete report.evidenceSummary.realServiceAndAdapterProof.principalScope[principal];
    }]),
    ...["database", "auth", "storage"].map((principal) => [`malformed ${principal} scope`, (report) => {
      const scope = report.evidenceSummary.realServiceAndAdapterProof.principalScope;
      scope[principal] = [scope[principal]];
    }]),
    ...["postgres", "auth", "storage", "scanner"].flatMap((service) => [
      [`missing ${service}`, (report) => { delete report.services[service]; }],
      [`unavailable ${service}`, (report) => { report.services[service].available = false; }],
    ]),
    ["zero postgres execution", (report) => { report.services.postgres.executionCount = 0; }],
    ["one postgres connection", (report) => { report.services.postgres.independentConnections = 1; }],
    ["zero auth execution", (report) => { report.services.auth.executionCount = 0; }],
    ["zero storage execution", (report) => { report.services.storage.executionCount = 0; }],
    ["public storage", (report) => { report.services.storage.privateBucketVerified = false; }],
    ["zero scanner execution", (report) => { report.services.scanner.executions = 0; }],
    ["missing scanner version", (report) => { delete report.services.scanner.version; }],
    ...["pdf", "image", "video"].flatMap((kind) => [
      [`missing ${kind} processor`, (report) => { delete report.services.processors[kind]; }],
      [`unavailable ${kind} processor`, (report) => { report.services.processors[kind].available = false; }],
      [`zero ${kind} executions`, (report) => { report.services.processors[kind].executions = 0; }],
    ]),
    ["missing format execution", (report) => { report.formats.pop(); }],
    ["unexecuted format", (report) => { report.formats[0].executed = false; }],
    ["missing failure count", (report) => { delete report.failureCount; }],
    ["nonzero failure count", (report) => { report.failureCount = 1; }],
    ["unreported failure", (report) => { report.failures.push("REQUIRED_CHECK_FAILED"); }],
    ["failed command", (report) => { report.checks[0].passed = false; }],
    ["failed command exit", (report) => { report.checks[0].exitCode = 1; }],
    ["skipped command", (report) => { report.checks[0].skipped = 1; }],
    ["timed out command", (report) => { report.checks[0].timedOut = true; }],
    ["contradictory check count", (report) => { report.counts.checksPassed -= 1; }],
    ["component execution failure", (report) => { report.evidenceArtifacts[0].counts.failed = 1; }],
    ["unattempted cleanup", (report) => { report.cleanup.attempted = false; }],
    ["unbound migration summary", (report) => {
      report.evidenceSummary = structuredClone(report.evidenceSummary);
      report.evidenceSummary.migrationAccess.unbound = true;
    }],
    ["unbound service summary", (report) => {
      report.evidenceSummary = structuredClone(report.evidenceSummary);
      report.evidenceSummary.realServiceAndAdapterProof.unbound = true;
    }],
  ];
  for (const [description, mutate] of mutations) {
    const report = phase6Aggregate();
    mutate(report);
    const root = fixture({ 6: report });
    try { assert.equal(evaluate(root).phases.find((item) => item.phase === 6).accepted, false, description); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("malformed Phase 6 aggregate check rows block qualification without throwing", () => {
  const report = phase6Aggregate();
  report.checks.push(null);
  const root = fixture({ 6: report });
  try { assert.doesNotThrow(() => assert.equal(evaluate(root).phases.find((item) => item.phase === 6).accepted, false)); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects absent or partial Phase 6 and Phase 7 coverage despite passing command inventories", () => {
  const cases = [
    [6, "missing coverage", (report) => { delete report.coverage; }],
    [6, "missing counts", (report) => { delete report.counts; }],
    [6, "missing acceptance", (report) => { delete report.coverage.acceptanceCriteria; }],
    [6, "missing stories", (report) => { delete report.coverage.userStories; }],
    [6, "missing matrices", (report) => { delete report.coverage.mandatoryMatrices; }],
    [6, "truncated acceptance", (report) => { report.coverage.acceptanceCriteria.pop(); }],
    [6, "truncated stories", (report) => { report.coverage.userStories.pop(); }],
    [6, "duplicate story", (report) => { report.coverage.userStories[1] = report.coverage.userStories[0]; }],
    [6, "duplicate acceptance", (report) => { report.coverage.acceptanceCriteria[1] = report.coverage.acceptanceCriteria[0]; }],
    [6, "duplicate matrix", (report) => { report.coverage.mandatoryMatrices[1] = report.coverage.mandatoryMatrices[0]; }],
    [6, "truncated matrices", (report) => { report.coverage.mandatoryMatrices.pop(); }],
    [6, "missing component", (report) => { report.evidenceArtifacts.pop(); }],
    [6, "duplicate component", (report) => { report.evidenceArtifacts[1] = report.evidenceArtifacts[0]; }],
    [6, "unaccepted component", (report) => { report.evidenceArtifacts[0].accepted = false; }],
    [6, "acceptance mapping missing", (report) => { report.coverage.acceptanceCriteria[0].suites = []; }],
    [6, "story mapping missing", (report) => { report.coverage.userStories[0].acceptanceCriteria = []; }],
    [6, "matrix mapping replaced", (report) => { report.coverage.mandatoryMatrices[0].component = "unknown"; }],
    [6, "unexecuted matrix scenario", (report) => {
      report.evidenceArtifacts.find((item) => item.evidenceBinding.scenarioEvidence.length).evidenceBinding.scenarioEvidence[0].executed = false;
    }],
    [6, "missing matrix scenario", (report) => {
      report.evidenceArtifacts.find((item) => item.evidenceBinding.scenarioEvidence.length).evidenceBinding.scenarioEvidence.pop();
    }],
    [6, "duplicated matrix scenario", (report) => {
      const scenarios = report.evidenceArtifacts.find((item) => item.evidenceBinding.scenarioEvidence.length > 1).evidenceBinding.scenarioEvidence;
      scenarios[1] = scenarios[0];
    }],
    [6, "count mismatch", (report) => { report.counts.acceptanceCriteria = 55; }],
    [6, "story count mismatch", (report) => { report.counts.userStories = 47; }],
    [6, "matrix count mismatch", (report) => { report.counts.matrices -= 1; }],
    [6, "component count mismatch", (report) => { report.counts.evidenceReports -= 1; }],
    [7, "missing counts", (report) => { delete report.counts; }],
    [7, "missing criteria", (report) => { delete report.criteria; }],
    [7, "truncated criteria", (report) => { report.criteria.pop(); }],
    [7, "duplicate criterion", (report) => { report.criteria[1] = report.criteria[0]; }],
    [7, "missing scenarios", (report) => { delete report.scenarios; }],
    [7, "truncated scenarios", (report) => { report.scenarios.pop(); }],
    [7, "duplicate scenario", (report) => { report.scenarios[1] = report.scenarios[0]; }],
    [7, "missing components", (report) => { delete report.components; }],
    [7, "truncated components", (report) => { report.components.pop(); }],
    [7, "duplicate component", (report) => { report.components[1] = report.components[0]; }],
    [7, "unaccepted component", (report) => { report.components[0].accepted = false; }],
    [7, "unexecuted scenario", (report) => { report.scenarios[0].executed = false; }],
    [7, "count mismatch", (report) => { report.counts.scenarioCount = 6; }],
    [7, "criterion count mismatch", (report) => { report.counts.criterionCount = 69; }],
    [7, "executed count mismatch", (report) => { report.counts.executedCriteria = 69; }],
    [7, "component count mismatch", (report) => { report.counts.components -= 1; }],
    [7, "accepted count mismatch", (report) => { report.counts.acceptedComponents -= 1; }],
    [7, "criterion mapping missing", (report) => { report.criteria[0].suites = []; }],
    [7, "scenario mapping replaced", (report) => { report.scenarios[0].suites[0] = "unknown"; }],
    [7, "criterion evidence absent", (report) => { report.criteria[0].evidence[0] = null; }],
    [7, "criterion evidence wrong run", (report) => { report.criteria[0].evidence[0] = "other-valid-run"; }],
  ];
  for (const [phase, description, mutate] of cases) {
    const report = valid(phase);
    mutate(report);
    const root = fixture({ [phase]: report });
    try {
      const prerequisite = evaluate(root).phases.find((item) => item.phase === phase);
      assert.equal(prerequisite.accepted, false, `Phase ${phase}: ${description}`);
      assert.ok(prerequisite.reasons.includes("executed-coverage-partial"), description);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("requires each Phase 6 and Phase 7 mapped component's actual source, run and cleanup provenance", () => {
  for (const phase of [6, 7]) {
    const fields = ["runId", "path", "sha256", "sourceRevision", "sourceTreeSha256", "cleanup", "fresh", "sourceBound",
      ...(phase === 6 ? ["startedAt"] : ["gateRunId", "positiveExecution", "aggregateSuccess"])];
    for (const field of fields) {
      const report = valid(phase);
      const component = (phase === 6 ? report.evidenceArtifacts : report.components)[0];
      delete component[field];
      if (phase === 7 && field === "runId") {
        for (const criterion of report.criteria) criterion.suites.forEach((id, index) => {
          if (id === component.id) criterion.evidence[index] = "phase-7-run-123456";
        });
      }
      const root = fixture({ [phase]: report });
      try {
        const prerequisite = evaluate(root).phases.find((item) => item.phase === phase);
        assert.equal(prerequisite.accepted, false, `Phase ${phase}: missing component ${field}`);
        assert.ok(prerequisite.reasons.includes("executed-coverage-partial"), field);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }
});

test("component execution counts override accepted and successful aggregate flags", () => {
  for (const [phase, field, observations] of [
    [6, "counts", [undefined, {}, { executed: 0 }, { failed: 1 }, { skipped: 1 }, { executed: -1 }, { executed: "1" }]],
    [7, "required", [undefined, {}, { success: false }, { passed: 0 }, { failed: 1 }, { skipped: 1 },
      { failedSuites: 1 }, { passed: -1 }, { passed: "1" }]],
  ]) {
    for (const observed of observations) {
      const report = valid(phase);
      const component = (phase === 6 ? report.evidenceArtifacts : report.components)[0];
      if (observed === undefined || Object.keys(observed).length === 0) component[field] = observed;
      else Object.assign(component[field], observed);
      const root = fixture({ [phase]: report });
      try {
        const prerequisite = evaluate(root).phases.find((item) => item.phase === phase);
        assert.equal(prerequisite.accepted, false, `Phase ${phase}: ${JSON.stringify(observed)}`);
        assert.ok(prerequisite.reasons.includes("executed-coverage-partial"));
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  }
});

test("Phase 7 preserves the producer's explicit null for its optional failed-suite counter", () => {
  const report = valid(7);
  report.components[0].required.failedSuites = null;
  const root = fixture({ 7: report });
  try { assert.equal(evaluate(root).phases.find((item) => item.phase === 7).accepted, true); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

test("command execution totals equal complete prerequisite inventories", () => {
  for (const phase of [3, 4, 6, 7]) {
    const report = valid(phase);
    report.required.executed += 1;
    const root = fixture({ [phase]: report });
    try {
      assert.equal(evaluate(root).phases.find((item) => item.phase === phase).accepted, false, `Phase ${phase}`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
  for (const overrides of [{ checks: 28 }, { checksPassed: 28 }, { checks: 30, checksPassed: 30 }]) {
    const report = valid(6);
    Object.assign(report.counts, overrides);
    const root = fixture({ 6: report });
    try { assert.equal(evaluate(root).phases.find((item) => item.phase === 6).accepted, false, JSON.stringify(overrides)); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("rejects a truncated named checklist despite unchanged successful aggregate totals", () => {
  for (const phase of [3, 4, 5, 6, 7]) {
    const report = valid(phase);
    const root = fixture({ [phase]: { ...report, checks: report.checks.slice(0, 1) } });
    try {
      const result = evaluate(root);
      const prerequisite = result.phases.find((item) => item.phase === phase);
      assert.equal(prerequisite.accepted, false, `Phase ${phase} must reject incomplete command coverage`);
      assert.ok(prerequisite.reasons.includes("executed-coverage-partial"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("rejects duplicate check names that conceal a missing required command", () => {
  const report = valid(6);
  report.checks[1].name = report.checks[0].name;
  const root = fixture({ 6: report });
  try {
    assert.ok(evaluate(root).phases.find((item) => item.phase === 6).reasons.includes("executed-coverage-partial"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed or skipped named command overrides passing aggregate claims", () => {
  for (const command of [{ passed: false }, { skipped: 1 }, { executed: false }]) {
    const report = valid(3);
    Object.assign(report.checks[0], command);
    const root = fixture({ 3: report });
    try {
      assert.equal(evaluate(root).phases.find((item) => item.phase === 3).accepted, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("Phase 5 keeps assertion totals separate from its complete command inventory", () => {
  const report = valid(5, { counts: { total: 146, executed: 146, failed: 0, skipped: 0 } });
  const root = fixture({ 5: report });
  try { assert.equal(evaluate(root).phases.find((item) => item.phase === 5).accepted, true); }
  finally { rmSync(root, { recursive: true, force: true }); }
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

test("stale source evidence requests requalification without inventing predecessor failures", () => {
  const root = fixture({});
  try {
    const result = evaluate(root, { sourceTreeSha256: "f".repeat(64) });
    for (const blocker of result.blockers) {
      assert.deepEqual(blocker.reasons, ["source-tree-mismatch"]);
      assert.deepEqual(blocker.failedChecks, []);
      assert.match(blocker.nextAction, /npm run phase8:qualify/u);
      assert.doesNotMatch(blocker.nextAction, /resolve.*failures/u);
    }
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
  const phaseFourChecks = executedChecks(4).map(({ name }) => ({ name, passed: true }));
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

test("immutable metadata needs no worktree writes and uses historical checkout attributes", () => {
  const root = mkdtempSync(join(tmpdir(), "phase8-immutable-migrations-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "--initial-branch=fixture");
    git("config", "core.autocrlf", "true");
    git("config", "user.name", "Validation Fixture");
    git("config", "user.email", "fixture@example.invalid");
    mkdirSync(join(root, "supabase", "migrations"), { recursive: true });
    const sql = "set lock_timeout = '5s';\nselect 1;\n";
    const attributes = ".gitattributes text eol=lf\n*.sql text eol=lf\n";
    writeFileSync(join(root, ".gitattributes"), attributes);
    writeFileSync(join(root, "supabase", "migrations", "20261017000000_fixture.sql"), sql);
    const binary = Buffer.from([0, 10, 13, 255, 0]);
    writeFileSync(join(root, "binary fixture.dat"), binary);
    git("add", ".gitattributes", "binary fixture.dat", "supabase/migrations/20261017000000_fixture.sql");
    git("commit", "-m", "Fixture migration");
    // The previous implementation fails when it tries to create a worktree.
    writeFileSync(join(root, ".git", "worktrees"), "Worktree creation is unavailable.\n");
    writeFileSync(join(root, ".gitattributes"), "*.sql text eol=crlf\n");
    const before = git("status", "--porcelain=v1");
    const metadata = sourceMetadataAtRevision(root, git("rev-parse", "HEAD"));
    assert.deepEqual(metadata.migrations, [{ name: "20261017000000_fixture.sql", sha256: migrationSha256(sql) }]);
    assert.notEqual(metadata.migrations[0].sha256, migrationSha256(sql.replace("select 1", "select 2")));
    const digest = createHash("sha256").update("portfolio-source-files-v1\0");
    for (const [name, content] of [[".gitattributes", attributes], ["binary fixture.dat", binary],
      ["supabase/migrations/20261017000000_fixture.sql", sql]]) {
      digest.update(JSON.stringify([name, "file", createHash("sha256").update(content).digest("hex")])).update("\0");
    }
    assert.equal(metadata.sourceTreeSha256, digest.digest("hex"));
    assert.equal(git("status", "--porcelain=v1"), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
