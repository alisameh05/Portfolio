import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PHASE6_FORMATS, PHASE6_MEDIA_CV_CRITERION_IDS, PHASE6_PREDECESSOR_CONTEXTS, PHASE6_TOOL_DEFINITIONS, evaluatePhase6IntegrationTests,
  evaluatePhase6MediaCvIntegration, evaluatePhase6Setup, isolatedPhase6Config,
  loadPhase6PredecessorContexts, makePhase6Report, phase6CvScenarioProof, phase6CvDeferredMigrations, scrubPhase6Environment,
} from "../../scripts/phase6-verification-support.mjs";
import { createBarrier, createDeterministicClock, createUuidV7Sequence } from "../phase6/fixtures/deterministic.mjs";

function integratedMediaCvEvidence() {
  const criteria = PHASE6_MEDIA_CV_CRITERION_IDS.map((id) => ({
    id, cases: [{ caseId: `${id}-case-1`, name: "executed integration assertion", executed: true, status: "passed" }],
  }));
  return {
    schemaVersion: 1, ticket: 163, runId: "integrated-run", sourceRevision: "abc",
    sourceTreeSha256: "a".repeat(64), startedAt: "2026-10-14T10:00:00.000Z", completedAt: "2026-10-14T10:05:00.000Z",
    runtime: { node: "v24.21.0", npm: "11.19.0" },
    services: { postgres: { available: true, executionCount: 2, independentConnections: 2 },
      auth: { available: true, executionCount: 1 }, storage: { available: true, privateBucketVerified: true, executionCount: 3 },
      scanner: { available: true, version: "ClamAV fixture runtime", executions: 6 },
      processors: { pdf: { available: true, version: "OCRmyPDF", executions: 1 },
        image: { available: true, version: "Sharp", executions: 3 }, video: { available: true, version: "FFmpeg", executions: 2 } } },
    formats: PHASE6_FORMATS.map(({ id, processor }) => ({ id, executed: true, status: "passed", storageRoundTrip: true,
      scannerVerdict: "clean", processorVersion: `tool-${processor}` })),
    criteria, counts: { executed: 11, failed: 0, skipped: 0 }, cleanup: { attempted: true, success: true },
    testRun: { exitStatus: 0, total: 12, failed: 0, skipped: 0 },
  };
}

test("integrated Media/CV evidence requires all T18 cases and fresh real-service proof", () => {
  const evidence = integratedMediaCvEvidence();
  assert.deepEqual(evaluatePhase6MediaCvIntegration(evidence, { sourceRevision: "abc", sourceTreeSha256: "a".repeat(64), now: Date.parse("2026-10-14T10:06:00Z") }),
    { verdict: "pass", failures: [], counts: { criteria: 11, executed: 11, failed: 0, skipped: 0 } });
  const missing = structuredClone(evidence);
  missing.criteria.pop();
  assert.ok(evaluatePhase6MediaCvIntegration(missing, { sourceRevision: "abc", sourceTreeSha256: "a".repeat(64) }).failures.includes("criterion-matrix-incomplete-or-duplicated"));
  const skipped = structuredClone(evidence);
  skipped.criteria[4].cases[0].executed = false;
  skipped.criteria[4].cases[0].status = "skipped";
  skipped.counts.skipped = 1;
  assert.ok(evaluatePhase6MediaCvIntegration(skipped, { sourceRevision: "abc", sourceTreeSha256: "a".repeat(64) }).failures.includes("criterion-execution-counts-invalid"));
  const stale = structuredClone(evidence);
  assert.ok(evaluatePhase6MediaCvIntegration(stale, { sourceRevision: "newer", sourceTreeSha256: "b".repeat(64) }).failures.includes("evidence-source-stale-or-mismatched"));
  const fakeStorage = structuredClone(evidence);
  fakeStorage.services.storage.privateBucketVerified = false;
  fakeStorage.formats[0].scannerVerdict = "fake-clean";
  assert.ok(evaluatePhase6MediaCvIntegration(fakeStorage, { sourceRevision: "abc", sourceTreeSha256: "a".repeat(64) }).failures.includes("required-service-probe-missing"));
  assert.equal(evaluatePhase6MediaCvIntegration({ ...evidence, cleanup: { attempted: true, success: false } },
    { sourceRevision: "abc", sourceTreeSha256: "a".repeat(64) }).verdict, "fail");
});

test("CV upgrade defers every migration from CV initialization onward, including later domain migrations", () => {
  const before = "20261012020000_enforce_visible_media_usage_and_lock_order.sql";
  const cv = "20261012030000_initialize_cv_portfolio_register_english_versions.sql";
  const acceptance = "20261012040000_accept_registered_cv_versions.sql";
  const activation = "20261012050000_activate_current_cv_atomically.sql";
  const rejection = "20261012060000_reject_media_with_usage_guard.sql";
  const profile = "20261013100000_configure_public_profile_media.sql";
  const future = "20261101000000_future_cv_dependent_change.sql";
  assert.deepEqual(phase6CvDeferredMigrations([profile, before, activation, future, cv, rejection, acceptance]),
    [cv, acceptance, activation, rejection, profile, future]);
  assert.throws(() => phase6CvDeferredMigrations([profile, before]), /PHASE6_CV_UPGRADE_TARGET_MISSING/u);
});

test("CV evidence requires recorded execution of every T09 criterion", () => {
  const counts = { cvScenarios: Array.from({ length: 9 }, (_, index) => ({
    name: `T09-0${index + 1} actual assertion`, executed: true, status: "passed",
  })) };
  assert.equal(phase6CvScenarioProof(counts), true);
  assert.equal(phase6CvScenarioProof(undefined), false);
  assert.equal(phase6CvScenarioProof({ cvScenarios: [] }), false);
  const missing = structuredClone(counts);
  missing.cvScenarios[8].name = "T09-01 duplicate";
  assert.equal(phase6CvScenarioProof(missing), false);
  const skipped = structuredClone(counts);
  skipped.cvScenarios[0].executed = false;
  assert.equal(phase6CvScenarioProof(skipped), false);
  const failed = structuredClone(counts);
  failed.cvScenarios[0].status = "failed";
  assert.equal(phase6CvScenarioProof(failed), false);
});

test("the complete real integration gate rejects skipped, missing, failed, and partial test reports", () => {
  const report = {
    success: true, numTotalTests: 7, numPassedTests: 7, numFailedTests: 0, numFailedTestSuites: 0, numPendingTests: 0,
    testResults: [{ assertionResults: [
      "commits a scoped candidate and replays the same encrypted target without re-signing",
      "allows the exact scoped signed upload and denies anonymous and non-Owner Storage reads/writes",
      "rolls back a failed candidate commit and idempotently removes its expired private orphan",
      "processes PDF candidates and real PNG JPEG WebP images through PostgreSQL, private Storage, ClamAV and trusted processors",
      "issues bounded delivery only for current published-locale and profile Media uses",
      "processes MP4 and WebM candidates with real PostgreSQL, private Storage, ClamAV and FFmpeg",
      "rejects accepted Media safely and serializes with current usage changes",
    ].map((title) => ({ title, status: "passed" })) }],
  };
  assert.deepEqual(evaluatePhase6IntegrationTests(report, 0), { total: 7, passed: 7, failed: 0, skipped: 0, verdict: "pass" });
  assert.equal(evaluatePhase6IntegrationTests(report, 1).verdict, "fail");
  assert.equal(evaluatePhase6IntegrationTests(undefined, 0).verdict, "fail");
  for (const status of ["pending", "disabled", "todo", "failed"]) {
    const changed = structuredClone(report);
    changed.testResults[0].assertionResults[0].status = status;
    assert.equal(evaluatePhase6IntegrationTests(changed, 0).verdict, "fail");
  }
  const partial = structuredClone(report);
  partial.testResults[0].assertionResults.pop();
  assert.equal(evaluatePhase6IntegrationTests(partial, 0).verdict, "fail");
  const aggregateMismatch = structuredClone(report);
  aggregateMismatch.success = false;
  const aggregateDiagnostics = evaluatePhase6IntegrationTests(aggregateMismatch, 0).diagnostics;
  assert.equal(aggregateDiagnostics.conditions.reportSucceeded, false);
  assert.equal(aggregateDiagnostics.assertionTitles.length, 7);
  const failedSuite = structuredClone(report);
  failedSuite.testResults[0].status = "failed";
  failedSuite.numFailedTestSuites = 1;
  failedSuite.testResults[0].message = "Error: fixture-secret\n at tests/database/media-upload-intent.integration.test.ts:605:9";
  const suiteDiagnostics = evaluatePhase6IntegrationTests(failedSuite, 0).diagnostics;
  assert.deepEqual(suiteDiagnostics.suiteResults, [{ name: "unknown-suite", status: "failed",
    reason: "Error", location: "tests/database/media-upload-intent.integration.test.ts:605:9" }]);
  assert.doesNotMatch(JSON.stringify(suiteDiagnostics), /fixture-secret/u);
  assert.equal(evaluatePhase6IntegrationTests({ ...report, numPendingTests: 1 }, 0).verdict, "fail");
  for (const title of [report.testResults[0].assertionResults[1].title, "unrelated passing test"]) {
    const substituted = structuredClone(report);
    substituted.testResults[0].assertionResults[0].title = title;
    assert.equal(evaluatePhase6IntegrationTests(substituted, 0).verdict, "fail");
  }
  const extra = structuredClone(report);
  extra.testResults[0].assertionResults.push({ title: "unexpected test", status: "passed" });
  assert.equal(evaluatePhase6IntegrationTests(extra, 0).verdict, "fail");
});

test("integration diagnostics retain source locations without arbitrary Auth or database payloads", () => {
  const message = 'AssertionError: {"password":"fixture-secret","apikey":"fixture-secret","refresh_token":"fixture-secret","access_token":"fixture-secret","serviceRoleKey":"fixture-secret","replayKey":"fixture-secret"} Bearer fixture-secret https://example.test/upload?token=fixture-secret postgresql://user:fixture-secret@localhost/test eyJfixture.fixture.signature\n at tests/database/media-upload-intent.integration.test.ts:605:9';
  const result = evaluatePhase6IntegrationTests({ testResults: [{ assertionResults: [{
    fullName: "known integration assertion", status: "failed", failureMessages: [message],
  }] }] }, 1);
  assert.equal(result.verdict, "fail");
  assert.deepEqual(result.failedTests, [{ name: "known integration assertion", reason: "AssertionError",
    location: "tests/database/media-upload-intent.integration.test.ts:605:9" }]);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|eyJfixture|postgresql:|https:/u);
});

test("integration diagnostics retain only known Media codes and CV criterion IDs", () => {
  const result = evaluatePhase6IntegrationTests({ testResults: [{ assertionResults: [{
    fullName: "safe assertion", status: "failed", failureMessages: [
      "AssertionError: T09-04 MEDIA_SCANNER_UNAVAILABLE token=fixture-secret MEDIA_PRIVATE_SECRET at tests/database/media-upload-intent.integration.test.ts:100:2",
    ],
  }] }] }, 1);
  assert.deepEqual(result.failedTests[0].codes, ["MEDIA_SCANNER_UNAVAILABLE"]);
  assert.deepEqual(result.failedTests[0].criteria, ["T09-04"]);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|MEDIA_PRIVATE_SECRET|token=/u);
});

function passingReport() {
  const predecessorContexts = {
    phase4: {
      ...PHASE6_PREDECESSOR_CONTEXTS.phase4,
      contextRunId: "90000000-0000-4000-8000-000000000004",
      executedAt: "2026-10-10T17:55:06.000Z",
      sourceRevision: PHASE6_PREDECESSOR_CONTEXTS.phase4.mergeCommit,
      gitTreeId: "a".repeat(40),
      contextVerdict: "pass",
      operations: { publicOperations: 5, ownerOperations: 39, forbiddenFindings: 0 },
      boundary: "pass",
      runtimeArchitecture: "pass",
      fixtureResults: Array.from({ length: 6 }, () => ({ rejected: true })),
      depcruiseResults: Array.from({ length: 2 }, () => ({ rejected: true })),
    },
    phase5: {
      ...PHASE6_PREDECESSOR_CONTEXTS.phase5,
      contextRunId: PHASE6_PREDECESSOR_CONTEXTS.phase5.runId,
      contextVerdict: "pass",
      operations: { public: 5, owner: 48, forbiddenFindings: 0 },
      runtimeBoundary: "pass",
      runtimeArchitecture: "pass",
    },
    activationDifferences: PHASE6_PREDECESSOR_CONTEXTS.activationDifferences,
  };
  return makePhase6Report({
    sourceRevision: "abc", sourceTreeSha256: "tree", runtime: { node: "v24.21.0", npm: "11.19.0" },
    startedAt: new Date(Date.now() - 60_000).toISOString(), tools: Object.fromEntries(Object.keys(PHASE6_TOOL_DEFINITIONS).map((name) => [name, `tool-${name}`])),
    services: { postgres: { available: true, executionCount: 3, independentConnections: 2 }, auth: { available: true, executionCount: 1 }, storage: { available: true, privateBucketVerified: true, executionCount: 20 } },
    formats: PHASE6_FORMATS.map((item) => ({ id: item.id, executed: true, status: "passed", storageRoundTrip: true, scannerVerdict: "clean", processorVersion: `tool-${item.processor}` })),
    cleanup: { attempted: true, success: true }, failures: [], predecessorContexts,
  });
}

test("loads predecessor contexts from an explicit evidence root", () => {
  const root = mkdtempSync(join(tmpdir(), "phase6-predecessor-fixture-"));
  const evidenceRoot = join(root, "evidence");
  mkdirSync(evidenceRoot, { recursive: true });
  try {
    writeFileSync(join(evidenceRoot, "phase4-context-90-105.json"), JSON.stringify({
      runId: "90000000-0000-4000-8000-000000000004",
      executedAt: "2026-10-10T17:55:06.000Z",
      sourceRevision: PHASE6_PREDECESSOR_CONTEXTS.phase4.mergeCommit,
      gitTreeId: "a".repeat(40),
      report: {
        verdict: "pass",
        inventory: { publicOperations: 5, ownerOperations: 39, forbiddenFindings: 0 },
        boundary: "pass",
        runtimeArchitecture: "pass",
        fixtureResults: Array.from({ length: 6 }, () => ({ rejected: true })),
        depcruiseResults: Array.from({ length: 2 }, () => ({ rejected: true })),
      },
    }));
    writeFileSync(join(evidenceRoot, "phase-5-gate-report.json"), JSON.stringify({
      runId: PHASE6_PREDECESSOR_CONTEXTS.phase5.runId,
      sourceRevision: PHASE6_PREDECESSOR_CONTEXTS.phase5.sourceRevision,
      sourceTreeSha256: PHASE6_PREDECESSOR_CONTEXTS.phase5.sourceTreeSha256,
      verdict: "pass",
    }));
    writeFileSync(join(evidenceRoot, "phase-5-context.json"), JSON.stringify({
      operations: { public: 5, owner: 48, forbiddenFindings: 0 },
      runtimeBoundary: "pass",
      runtimeArchitecture: "pass",
    }));

    const contexts = loadPhase6PredecessorContexts(root);
    assert.equal(contexts.phase4.contextVerdict, "pass");
    assert.equal(contexts.phase5.contextVerdict, "pass");
    assert.equal(contexts.phase5.contextRunId, PHASE6_PREDECESSOR_CONTEXTS.phase5.runId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("isolated configuration enables local Auth signups and private Storage on reserved ports", () => {
  const result = isolatedPhase6Config("project_id = \"before\"\n[api]\nenabled = false\nport = 54321\n[db]\nport = 54322\nshadow_port = 54320\n[auth]\nenabled = false\nenable_signup = false\n[auth.email]\nenable_signup = false\n[storage]\nenabled = false\n", "after");
  assert.match(result, /project_id = "after"/u);
  assert.match(result, /port = 57321/u);
  assert.match(result, /port = 57322/u);
  assert.match(result, /\[storage\.buckets\.phase6-private-fixtures\]\s+public = false/u);
  assert.match(result, /\[storage\.buckets\.media-candidates\]\s+public = false\s+file_size_limit = "50MiB"/u);
  assert.match(result, /\[storage\.buckets\.media-processed\]\s+public = false\s+file_size_limit = "50MiB"/u);
  assert.match(result, /\[auth\][\s\S]*?enable_signup = true/u);
  assert.match(result, /\[auth\.email\][\s\S]*?enable_signup = true/u);
  assert.doesNotMatch(result, /\[studio\][\s\S]*?enabled = true/u);
});

test("local runner removes inherited provider credentials", () => {
  const safe = scrubPhase6Environment({ SUPABASE_ACCESS_TOKEN: "secret", DATABASE_URL: "private", OWNER_GITHUB_ID: "owner", GOTRUE_EXTERNAL_EMAIL_ENABLED: "false", PATH: "safe" });
  assert.equal(safe.SUPABASE_ACCESS_TOKEN, undefined);
  assert.equal(safe.DATABASE_URL, undefined);
  assert.equal(safe.OWNER_GITHUB_ID, undefined);
  assert.equal(safe.GOTRUE_EXTERNAL_EMAIL_ENABLED, "true");
  assert.equal(safe.PATH, "safe");
});

test("source-bound service evidence with all six real format probes passes", () => {
  const report = passingReport();
  const result = evaluatePhase6Setup(report, { sourceRevision: "abc", sourceTreeSha256: "tree", now: Date.now() + 60_000 });
  assert.deepEqual(result, { verdict: "pass", failures: [] });
});

test("missing services, tool definitions, format executions, skipped cases, stale evidence and cleanup failures fail closed", () => {
  const report = passingReport();
  report.services.storage.privateBucketVerified = false;
  report.toolDefinitions.scanner = "latest";
  report.formats[0].executed = false;
  report.formats[1].status = "skipped";
  report.cleanup.success = false;
  const result = evaluatePhase6Setup(report, { sourceRevision: "different", sourceTreeSha256: "different", now: Date.now() + 60_000 });
  assert.equal(result.verdict, "fail");
  assert.ok(result.failures.includes("evidence-source-stale-or-mismatched"));
  assert.ok(result.failures.includes("required-service-probe-missing"));
  assert.ok(result.failures.includes("cleanup-not-confirmed"));
  assert.ok(result.failures.includes("processor-definition-missing"));
  assert.ok(result.failures.includes("format-execution-counts-incomplete"));
});

test("zero execution, missing reports, malformed times and fake-only scanner verdicts cannot pass", () => {
  assert.equal(evaluatePhase6Setup(null, {}).verdict, "fail");
  const report = passingReport();
  report.counts.executedFormats = 0;
  report.formats[2].scannerVerdict = "fake-clean";
  report.startedAt = "not a date";
  assert.equal(evaluatePhase6Setup(report, { sourceRevision: "abc", sourceTreeSha256: "tree", now: Date.now() + 60_000 }).verdict, "fail");
});

test("Docker absence, service startup timeout, and processor failures cannot certify setup", () => {
  const report = passingReport();
  report.failures.push("PHASE6_DOCKER_UNAVAILABLE", "PHASE6_COMMAND_FAILED:supabase:start:timeout", "PHASE6_COMMAND_FAILED:docker:nonzero-exit");
  report.verdict = "fail";
  const result = evaluatePhase6Setup(report, { sourceRevision: "abc", sourceTreeSha256: "tree", now: Date.now() + 60_000 });
  assert.equal(result.verdict, "fail");
  assert.ok(result.failures.includes("report-verdict-not-pass"));
});

test("a single PostgreSQL connection cannot certify race-test setup", () => {
  const report = passingReport();
  report.services.postgres.independentConnections = 1;
  const result = evaluatePhase6Setup(report, { sourceRevision: "abc", sourceTreeSha256: "tree", now: Date.now() + 60_000 });
  assert.equal(result.verdict, "fail");
  assert.ok(result.failures.includes("independent-postgres-connections-unavailable"));
});

test("predecessor assertions require source-bound Phase 4 and current Phase 5 run evidence", () => {
  const report = passingReport();
  report.predecessorContexts.phase4.fixtureResults[0].rejected = false;
  report.predecessorContexts.phase5.sourceTreeSha256 = "stale-tree";
  const result = evaluatePhase6Setup(report, { sourceRevision: "abc", sourceTreeSha256: "tree", now: Date.now() + 60_000 });
  assert.equal(result.verdict, "fail");
  assert.ok(result.failures.includes("phase4-context-assertions-incomplete"));
  assert.ok(result.failures.includes("phase5-run-provenance-invalid"));
});

test("future acceptance tests have deterministic time and UUIDv7 identity factories", () => {
  const clock = createDeterministicClock(Date.UTC(2026, 0, 1), 5);
  const ids = createUuidV7Sequence(clock);
  const first = ids.next();
  const second = ids.next();
  assert.match(first, /^[0-9a-f-]{36}$/u);
  assert.ok(first < second);
  assert.equal(clock.nowIso(), "2026-01-01T00:00:00.000Z");
  clock.advance();
  assert.equal(clock.nowIso(), "2026-01-01T00:00:00.005Z");
  assert.equal(ids.count(), 2);
});

test("race scenarios can wait on independent test actors at a deterministic barrier", async () => {
  const barrier = createBarrier(3);
  let released = 0;
  await Promise.all([barrier.arrive(), barrier.arrive(), barrier.arrive()].map(async () => { released += 1; }));
  assert.equal(barrier.arrived(), 3);
  assert.equal(released, 3);
});
