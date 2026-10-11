import test from "node:test";
import assert from "node:assert/strict";
import {
  PHASE6_FORMATS, PHASE6_TOOL_DEFINITIONS, evaluatePhase6Setup, isolatedPhase6Config,
  loadPhase6PredecessorContexts, makePhase6Report, scrubPhase6Environment,
} from "../../scripts/phase6-verification-support.mjs";
import { createBarrier, createDeterministicClock, createUuidV7Sequence } from "../phase6/fixtures/deterministic.mjs";

function passingReport() {
  const predecessorContexts = loadPhase6PredecessorContexts();
  predecessorContexts.phase5.sourceTreeSha256 = "tree";
  return makePhase6Report({
    sourceRevision: "abc", sourceTreeSha256: "tree", runtime: { node: "v24.21.0", npm: "11.19.0" },
    startedAt: new Date(Date.now() - 60_000).toISOString(), tools: Object.fromEntries(Object.keys(PHASE6_TOOL_DEFINITIONS).map((name) => [name, `tool-${name}`])),
    services: { postgres: { available: true, executionCount: 3, independentConnections: 2 }, auth: { available: true, executionCount: 1 }, storage: { available: true, privateBucketVerified: true, executionCount: 20 } },
    formats: PHASE6_FORMATS.map((item) => ({ id: item.id, executed: true, status: "passed", storageRoundTrip: true, scannerVerdict: "clean", processorVersion: `tool-${item.processor}` })),
    cleanup: { attempted: true, success: true }, failures: [], predecessorContexts,
  });
}

test("isolated configuration enables only the local API, Auth and Storage on reserved ports", () => {
  const result = isolatedPhase6Config("project_id = \"before\"\n[api]\nenabled = false\nport = 54321\n[db]\nport = 54322\nshadow_port = 54320\n[auth]\nenabled = false\n[storage]\nenabled = false\n", "after");
  assert.match(result, /project_id = "after"/u);
  assert.match(result, /port = 57321/u);
  assert.match(result, /port = 57322/u);
  assert.match(result, /\[storage\.buckets\.phase6-private-fixtures\]\s+public = false/u);
  assert.match(result, /\[storage\.buckets\.media-candidates\]\s+public = false\s+file_size_limit = "50MiB"/u);
  assert.match(result, /\[storage\.buckets\.media-processed\]\s+public = false\s+file_size_limit = "50MiB"/u);
  assert.doesNotMatch(result, /\[studio\][\s\S]*?enabled = true/u);
});

test("local runner removes inherited provider credentials", () => {
  const safe = scrubPhase6Environment({ SUPABASE_ACCESS_TOKEN: "secret", DATABASE_URL: "private", OWNER_GITHUB_ID: "owner", PATH: "safe" });
  assert.equal(safe.SUPABASE_ACCESS_TOKEN, undefined);
  assert.equal(safe.DATABASE_URL, undefined);
  assert.equal(safe.OWNER_GITHUB_ID, undefined);
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
