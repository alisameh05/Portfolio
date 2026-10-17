import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearGateArtifacts, PHASE6_GATE_COMMANDS } from "../../scripts/phase6-gate.mjs";
import {
  evaluatePhase6Gate, PHASE6_GATE_ACCEPTANCE_MATRIX, PHASE6_GATE_COMPONENTS,
  PHASE6_GATE_MANDATORY_MATRICES, PHASE6_GATE_REQUIRED_CHECKS, PHASE6_GATE_STORY_MATRIX,
} from "../../scripts/phase6-gate-support.mjs";
import { PHASE6_TOOL_DEFINITIONS } from "../../scripts/phase6-verification-support.mjs";

const sourceRevision = "a".repeat(40);
const sourceTreeSha256 = "b".repeat(64);
const observedToolVersions = Object.freeze({ scanner: "ClamAV 1.4.3/27927", pdfProcessor: "17.12.1",
  imageProcessor: "Version: ImageMagick 7.1.1-47 Q16-HDRI", videoProcessor: "ffprobe version 7.1",
  sharp: "sharp-0.35.4;libvips-8.18.6" });

test("gate startup clears stale reports and logs before checks run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "phase6-gate-clear-"));
  try {
    const checksPath = join(directory, "phase6-gate-checks");
    mkdirSync(checksPath);
    const gateReport = join(directory, "phase6-gate-report.json");
    const componentReport = join(directory, "phase6-component.json");
    writeFileSync(gateReport, "stale");
    writeFileSync(componentReport, "stale");
    writeFileSync(join(checksPath, "old.log"), "stale");
    await clearGateArtifacts({ reportPath: gateReport, reportPaths: [componentReport], checksPath });
    assert.throws(() => readFileSync(gateReport));
    assert.throws(() => readFileSync(componentReport));
    assert.deepEqual(await (await import("node:fs/promises")).readdir(checksPath), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function validInput() {
  const criteria = Array.from({ length: 11 }, (_, index) => ({ id: `T18-${String(index + 1).padStart(2, "0")}`,
    cases: [{ caseId: `case:T18-${index + 1}`, executed: true, status: "passed" }] }));
  return {
    runId: "gate-run-12345678", startedAt: "2026-10-14T14:00:00.000Z", sourceRevision, sourceTreeSha256,
    runtime: { node: "v24.21.0", npm: "11.19.0" }, expectedRuntime: { node: "24.21.0", npm: "11.19.0" }, now: Date.parse("2026-10-14T14:10:00Z"),
    checks: PHASE6_GATE_REQUIRED_CHECKS.map((name) => ({ name, executed: true, passed: true, exitCode: 0, skipped: 0, timedOut: false })),
    evidenceArtifacts: PHASE6_GATE_COMPONENTS.map(({ id, ticket }) => ({ id, ticket, accepted: true, sha256: "c".repeat(64),
      evidenceBinding: { scenarioEvidence: PHASE6_GATE_MANDATORY_MATRICES.filter((matrix) => matrix.component === id)
        .flatMap((matrix) => (matrix.requiredScenarioIds ?? []).map((scenarioId) => ({ id: scenarioId, executed: true, status: "passed" }))),
      ...(id === "setup" ? { toolDefinitions: { ...PHASE6_TOOL_DEFINITIONS }, toolVersions: { ...observedToolVersions } } : {}) } })),
    serviceEvidence: {
      toolVersions: { ...observedToolVersions },
      services: {
        postgres: { available: true, executionCount: 12, independentConnections: 2, majorVersion: 17 },
        auth: { available: true, executionCount: 2 },
        storage: { available: true, privateBucketVerified: true, executionCount: 19 },
        scanner: { available: true, version: observedToolVersions.scanner, executions: 12 },
        processors: {
          pdf: { available: true, version: observedToolVersions.pdfProcessor, executions: 5 },
          image: { available: true, version: observedToolVersions.sharp, executions: 3 },
          video: { available: true, version: observedToolVersions.videoProcessor, executions: 2 },
        },
      },
      principalScope: { database: "shipwithali_application with scoped Owner/Portfolio policies",
        auth: "disposable loopback Supabase Auth with real issued Owner session claims",
        storage: "private local Storage; anonymous and non-Owner access denied" },
      formats: ["pdf", "png", "jpeg", "webp", "mp4", "webm"].map((id) => ({ id, executed: true, status: "passed" })),
      criteria, counts: { executed: 11, failed: 0, skipped: 0 },
      testRun: { exitStatus: 0, total: 22, failed: 0, skipped: 0 }, cleanup: { attempted: true, success: true },
    },
  };
}

function expectFailure(change, expected) {
  const input = validInput();
  change(input);
  const result = evaluatePhase6Gate(input);
  assert.equal(result.verdict, "fail");
  assert.ok(result.failures.includes(expected), `${expected} missing from ${result.failures.join(", ")}`);
}

test("Phase 6 gate traceability covers all parent criteria, stories and mandatory matrices", () => {
  assert.equal(PHASE6_GATE_ACCEPTANCE_MATRIX.length, 56);
  assert.equal(new Set(PHASE6_GATE_ACCEPTANCE_MATRIX.map((item) => item.id)).size, 56);
  assert.ok(PHASE6_GATE_ACCEPTANCE_MATRIX.every((item) => item.suites.length > 0));
  assert.equal(PHASE6_GATE_STORY_MATRIX.length, 48);
  assert.ok(PHASE6_GATE_STORY_MATRIX.every((item) => item.acceptanceCriteria.length > 0));
  assert.ok(PHASE6_GATE_MANDATORY_MATRICES.length >= 8);
  assert.equal(evaluatePhase6Gate(validInput()).verdict, "pass");
});

test("runtime pin comparison accepts Node versions with or without the version prefix", () => {
  const input = validInput();
  input.runtime.node = "24.21.0";
  assert.equal(evaluatePhase6Gate(input).verdict, "pass");
  input.runtime.node = "v24.20.0";
  assert.ok(evaluatePhase6Gate(input).failures.includes("runtime-pin-mismatch"));
});

test("observed tool versions bind to pinned definitions without equating versions to image references", () => {
  const input = validInput();
  assert.notEqual(input.serviceEvidence.services.scanner.version, PHASE6_TOOL_DEFINITIONS.scanner);
  assert.equal(evaluatePhase6Gate(input).verdict, "pass");
});

for (const key of Object.keys(PHASE6_TOOL_DEFINITIONS)) {
  test(`${key} requires the pinned definition and matching independently observed versions`, () => {
    for (const change of [
      (input) => { delete input.evidenceArtifacts.find(({ id }) => id === "setup").evidenceBinding.toolDefinitions[key]; },
      (input) => { input.evidenceArtifacts.find(({ id }) => id === "setup").evidenceBinding.toolDefinitions[key] = "unapproved-tool"; },
      (input) => { delete input.evidenceArtifacts.find(({ id }) => id === "setup").evidenceBinding.toolVersions[key]; },
      (input) => { input.serviceEvidence.toolVersions[key] = "inconsistent-observation"; },
      (input) => {
        input.evidenceArtifacts.find(({ id }) => id === "setup").evidenceBinding.toolVersions[key] = PHASE6_TOOL_DEFINITIONS[key];
        input.serviceEvidence.toolVersions[key] = PHASE6_TOOL_DEFINITIONS[key];
        const service = { scanner: input.serviceEvidence.services.scanner, pdfProcessor: input.serviceEvidence.services.processors.pdf,
          videoProcessor: input.serviceEvidence.services.processors.video }[key];
        if (service) service.version = PHASE6_TOOL_DEFINITIONS[key];
      },
    ]) expectFailure(change, "real-adapter-tool-or-principal-scope-unverified");
  });
}

test("absent required service is rejected", () => expectFailure((input) => { input.serviceEvidence.services.auth.available = false; }, "required-real-service-evidence-missing"));
test("stale source evidence is rejected", () => expectFailure((input) => { input.evidenceArtifacts[0].accepted = false; }, "required-evidence-invalid:setup"));
test("failed constituent is rejected", () => expectFailure((input) => { input.checks[0].passed = false; }, "required-check-failed:validation-ready"));
test("missing matrix or scenario is rejected", () => expectFailure((input) => { input.serviceEvidence.criteria.pop(); }, "integrated-scenario-matrix-missing-or-unexecuted"));
for (const matrixId of ["scenario-9-atomic-cv-replacement", "scenario-12-media-acceptance", "scenario-12-publication-gates",
  "scenario-12-integrated-publication", "scenario-13-arabic-boundary", "scenario-15-phase6-degraded-dependencies"]) {
  test(`${matrixId} rejects missing scenario evidence`, () => {
    const matrix = PHASE6_GATE_MANDATORY_MATRICES.find((item) => item.id === matrixId);
    const input = validInput();
    const target = input.evidenceArtifacts.find((item) => item.id === matrix.component);
    target.evidenceBinding.scenarioEvidence = target.evidenceBinding.scenarioEvidence.filter((item) => item.id !== matrix.requiredScenarioIds[0]);
    const result = evaluatePhase6Gate(input);
    assert.equal(result.verdict, "fail");
    assert.ok(result.failures.includes(`required-matrix-scenario-missing:${matrixId}:${matrix.requiredScenarioIds[0]}`));
  });
}
test("zero real execution is rejected", () => expectFailure((input) => { input.serviceEvidence.services.processors.pdf.executions = 0; }, "real-scanner-or-processor-evidence-missing"));
test("fake-only evidence is rejected", () => expectFailure((input) => { input.serviceEvidence.evidenceMode = "fake-only"; }, "fake-only-evidence-cannot-certify-phase6"));
test("required skip is rejected", () => expectFailure((input) => { input.checks[0].skipped = 1; }, "required-check-failed:validation-ready"));
test("timeout is rejected", () => expectFailure((input) => { input.checks[0].timedOut = true; }, "check-timeout"));
test("failed cleanup is rejected", () => expectFailure((input) => { input.serviceEvidence.cleanup.success = false; }, "real-service-cleanup-unconfirmed"));

test("gate dependencies are produced before migration access consumes them", () => {
  const names = PHASE6_GATE_COMMANDS.map((check) => check.name);
  for (const dependency of ["media-integration", "cv-delivery-capabilities", "owner-composition", "cv-activation"]) {
    assert.ok(names.indexOf(dependency) >= 0 && names.indexOf(dependency) < names.indexOf("migration-access"), dependency);
  }
});
