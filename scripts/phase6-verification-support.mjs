import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";
import { observeRuntime, verifyEnvironment } from "./validation-environment.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const PHASE6_SCHEMA_VERSION = 1;
export const PHASE6_TOOL_DEFINITIONS = Object.freeze({
  scanner: "clamav/clamav@sha256:75fb5fd95fcbe1d7e6d240c369c1572b686ee2c95949d1042b5148de8eddebb4",
  imageProcessor: "dpokidov/imagemagick:7.1.1-47",
  videoProcessor: "jrottenberg/ffmpeg:7.1-ubuntu2404",
  pdfProcessor: "jbarlow83/ocrmypdf-alpine@sha256:7f4055a0db3f6301a6d58d9ed0302f96d90ec06c038b065c6197d4d22ceae71c",
});
export const PHASE6_FORMATS = Object.freeze([
  { id: "pdf", kind: "document", mimeType: "application/pdf", processor: "pdfProcessor" },
  { id: "png", kind: "image", mimeType: "image/png", processor: "imageProcessor" },
  { id: "jpeg", kind: "image", mimeType: "image/jpeg", processor: "imageProcessor" },
  { id: "webp", kind: "image", mimeType: "image/webp", processor: "imageProcessor" },
  { id: "mp4", kind: "video", mimeType: "video/mp4", processor: "videoProcessor" },
  { id: "webm", kind: "video", mimeType: "video/webm", processor: "videoProcessor" },
]);

export function isolatedPhase6Config(source, projectId, ports = { api: 57321, db: 57322, shadow: 57320, studio: 57323 }) {
  const config = source
    .replace(/^project_id = .*$/m, `project_id = "${projectId}"`)
    .replace(/(\[api\]\s*)enabled = false/, "$1enabled = true")
    .replace(/(\[auth\]\s*)enabled = false/, "$1enabled = true")
    .replace(/(\[storage\]\s*)enabled = false/, "$1enabled = true")
    .replace(/(\[api\][\s\S]*?^port = )54321$/m, (_match, prefix) => `${prefix}${ports.api}`)
    .replace(/(\[db\][\s\S]*?^port = )54322$/m, (_match, prefix) => `${prefix}${ports.db}`)
    .replace(/^shadow_port = 54320$/m, `shadow_port = ${ports.shadow}`)
    .replace(/(\[studio\][\s\S]*?^port = )54323$/m, (_match, prefix) => `${prefix}${ports.studio}`);
  return `${config.trimEnd()}\n\n[storage.buckets.phase6-private-fixtures]\npublic = false\nfile_size_limit = "50MiB"\n\n[storage.buckets.media-candidates]\npublic = false\nfile_size_limit = "50MiB"\nallowed_mime_types = ["application/pdf", "image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm"]\n\n[storage.buckets.media-processed]\npublic = false\nfile_size_limit = "50MiB"\nallowed_mime_types = ["application/pdf", "image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm"]\n`;
}

export function scrubPhase6Environment(source = process.env) {
  const env = { ...source, CI: "1" };
  for (const key of Object.keys(env)) {
    if (/^(?:SUPABASE_|PHASE[456]_|DATABASE_|OWNER_GITHUB_)/.test(key)) delete env[key];
  }
  env.SUPABASE_TELEMETRY_DISABLED = "1";
  return env;
}

export const PHASE6_MEDIA_INTEGRATION_TEST_NAMES = Object.freeze([
  "commits a scoped candidate and replays the same encrypted target without re-signing",
  "allows the exact scoped signed upload and denies anonymous and non-Owner Storage reads/writes",
  "rolls back a failed candidate commit and idempotently removes its expired private orphan",
  "processes PDF candidates and real PNG JPEG WebP images through PostgreSQL, private Storage, ClamAV and trusted processors",
  "issues bounded delivery only for current published-locale and profile Media uses",
  "processes MP4 and WebM candidates with real PostgreSQL, private Storage, ClamAV and FFmpeg",
  "rejects accepted Media safely and serializes with current usage changes",
]);

export function phase6CvDeferredMigrations(migrationNames) {
  const firstCvMigration = "20261012030000_initialize_cv_portfolio_register_english_versions.sql";
  if (!migrationNames.includes(firstCvMigration)) throw new Error("PHASE6_CV_UPGRADE_TARGET_MISSING");
  // A pre-CV database cannot already contain later migration history. Defer
  // the entire suffix so future CV-dependent changes also upgrade in order.
  return migrationNames.filter((name) => /^\d{14}_.+\.sql$/u.test(name) &&
    name.slice(0, 14) >= firstCvMigration.slice(0, 14)).sort();
}

export function evaluatePhase6IntegrationTests(report, exitStatus) {
  const assertions = (report?.testResults ?? []).flatMap((suite) => suite.assertionResults ?? []);
  const counts = {
    total: assertions.length,
    passed: assertions.filter((item) => item.status === "passed").length,
    failed: assertions.filter((item) => item.status === "failed").length,
    skipped: assertions.filter((item) => item.status !== "passed" && item.status !== "failed").length,
  };
  const safeCodes = ["MEDIA_SCANNER_UNAVAILABLE", "MEDIA_PROCESSING_TIMEOUT", "MEDIA_PROCESSOR_UNAVAILABLE",
    "MEDIA_PDF_PROCESSOR_UNAVAILABLE", "MEDIA_PDF_OUTPUT_INVALID", "MEDIA_VIDEO_PROCESSOR_UNAVAILABLE",
    "MEDIA_VIDEO_PROCESSOR_TIMEOUT", "MEDIA_CONTAINER_CLEANUP_FAILED", "MEDIA_STORAGE_UNAVAILABLE",
    "MEDIA_VIDEO_INPUT_INVALID", "MEDIA_VIDEO_OUTPUT_INVALID", "CV_MEDIA_NOT_ELIGIBLE", "CV_PORTFOLIO_READ_FAILED", "CV_PORTFOLIO_NOT_CONFIGURED"];
  const failedTests = assertions.filter((item) => item.status === "failed").map((item) => {
    const failure = String(item.failureMessages?.[0] ?? "");
    const codes = safeCodes.filter((code) => failure.includes(code));
    const criteria = [...new Set(failure.match(/\b(?:T09-0[1-9]|T10-0[1-8])\b/gu) ?? [])];
    return {
    name: item.fullName ?? "unknown-test",
    // Auth assertions can embed entire credential-bearing responses. Retain
    // only an error category and the known test's source location, never payloads.
    reason: String(item.failureMessages?.[0] ?? "").match(/AssertionError|TypeError|Test timed out|Error/u)?.[0] ?? "assertion-failed",
    location: failure.match(/tests[\\/]database[\\/]media-upload-intent\.integration\.test\.ts:\d+:\d+/u)?.[0] ?? "unknown-location",
    ...(failure.match(/T09-01 (?:first|second) authenticated read returned HTTP \d+ \([A-Za-z0-9_-]+; repo=(?:ok|CV_PORTFOLIO_READ_FAILED|CV_PORTFOLIO_NOT_CONFIGURED|other-safe-error)(?:,(?:ok|CV_PORTFOLIO_READ_FAILED|CV_PORTFOLIO_NOT_CONFIGURED|other-safe-error))*\)/u)?.[0]
      ? { detail: failure.match(/T09-01 (?:first|second) authenticated read returned HTTP \d+ \([A-Za-z0-9_-]+; repo=(?:ok|CV_PORTFOLIO_READ_FAILED|CV_PORTFOLIO_NOT_CONFIGURED|other-safe-error)(?:,(?:ok|CV_PORTFOLIO_READ_FAILED|CV_PORTFOLIO_NOT_CONFIGURED|other-safe-error))*\)/u)[0] }
      : {}),
    ...(codes.length ? { codes } : {}), ...(criteria.length ? { criteria } : {}),
  }; });
  const expected = PHASE6_MEDIA_INTEGRATION_TEST_NAMES.length;
  const names = new Set(assertions.map((item) => item.title));
  const conditions = {
    processSucceeded: exitStatus === 0,
    expectedAssertionCount: counts.total === expected,
    allAssertionsPassed: counts.passed === expected,
    uniqueExpectedNames: names.size === expected && PHASE6_MEDIA_INTEGRATION_TEST_NAMES.every((name) => names.has(name)),
    reportTotalMatches: report?.numTotalTests === expected,
    reportPassedMatches: report?.numPassedTests === expected,
    reportHasNoFailures: report?.numFailedTests === 0,
    reportHasNoPending: report?.numPendingTests === 0,
    reportSucceeded: report?.success === true,
  };
  const passed = Object.values(conditions).every(Boolean);
  return { ...counts, ...(failedTests.length ? { failedTests } : {}), ...(!passed ? {
    diagnostics: { conditions, assertionTitles: assertions.map((item) => item.title ?? "missing-title"),
      reportCounts: { total: report?.numTotalTests, passed: report?.numPassedTests,
        failed: report?.numFailedTests, pending: report?.numPendingTests, todo: report?.numTodoTests,
        failedSuites: report?.numFailedTestSuites, pendingSuites: report?.numPendingTestSuites } },
  } : {}), verdict: passed ? "pass" : "fail" };
}

export function phase6CvScenarioProof(processingCounts) {
  const checks = processingCounts?.cvScenarios;
  if (!Array.isArray(checks) || checks.length !== 9 || checks.some((item) => item?.executed !== true || item?.status !== "passed")) return false;
  const ids = new Set(checks.flatMap((item) => typeof item.name === "string" ? item.name.match(/T09-0[1-9]/gu) ?? [] : []));
  return ids.size === 9;
}

export const PHASE6_PREDECESSOR_CONTEXTS = Object.freeze({
  phase4: Object.freeze({ issue: 90, pullRequest: 105, mergeCommit: "9806af81d4ce705c36d9b22089f77213d16887bc", evidence: "evidence/phase4-context-90-105.json" }),
  phase5: Object.freeze({ issue: 125, pullRequest: 144, mergeCommit: "26d6efb3d9e281265cc9c099195492b5dcbec79d", evidence: "evidence/phase-5-context.json" }),
  activationDifferences: Object.freeze({ phase4: ["identity-access", "portfolio-configuration"], phase5: ["content-and-publishing", "taxonomy-and-discovery"], phase6Owned: ["media", "cv-portfolio"] }),
});

export function loadPhase6PredecessorContexts(root = ROOT) {
  const phase4Evidence = JSON.parse(readFileSync(join(root, PHASE6_PREDECESSOR_CONTEXTS.phase4.evidence), "utf8"));
  const phase5Evidence = JSON.parse(readFileSync(join(root, PHASE6_PREDECESSOR_CONTEXTS.phase5.evidence), "utf8"));
  const phase4Report = phase4Evidence.report;
  return {
    phase4: {
      ...PHASE6_PREDECESSOR_CONTEXTS.phase4,
      contextRunId: phase4Evidence.runId,
      executedAt: phase4Evidence.executedAt,
      sourceRevision: phase4Evidence.sourceRevision,
      gitTreeId: phase4Evidence.gitTreeId,
      contextVerdict: phase4Report?.verdict,
      operations: phase4Report?.inventory,
      boundary: phase4Report?.boundary,
      runtimeArchitecture: phase4Report?.runtimeArchitecture,
      fixtureResults: phase4Report?.fixtureResults,
      depcruiseResults: phase4Report?.depcruiseResults,
    },
    phase5: {
      ...PHASE6_PREDECESSOR_CONTEXTS.phase5,
      contextRunId: phase5Evidence.runId,
      sourceRevision: phase5Evidence.sourceRevision,
      sourceTreeSha256: phase5Evidence.sourceTreeSha256,
      contextVerdict: phase5Evidence.verdict,
      operations: phase5Evidence.operations,
      runtimeBoundary: phase5Evidence.runtimeBoundary,
      runtimeArchitecture: phase5Evidence.runtimeArchitecture,
    },
    activationDifferences: PHASE6_PREDECESSOR_CONTEXTS.activationDifferences,
  };
}

function predecessorContextFailures(contexts, sourceTreeSha256) {
  const failures = [];
  const phase4 = contexts?.phase4;
  const phase4Fixtures = Array.isArray(phase4?.fixtureResults) ? phase4.fixtureResults : [];
  const phase4Depcruise = Array.isArray(phase4?.depcruiseResults) ? phase4.depcruiseResults : [];
  if (phase4?.issue !== 90 || phase4?.pullRequest !== 105 || phase4?.sourceRevision !== PHASE6_PREDECESSOR_CONTEXTS.phase4.mergeCommit || !/^[0-9a-f]{40}$/u.test(phase4?.gitTreeId ?? "") || !/^[0-9a-f-]{36}$/iu.test(phase4?.contextRunId ?? "") || !Number.isFinite(Date.parse(phase4?.executedAt))) failures.push("phase4-run-provenance-invalid");
  if (phase4?.contextVerdict !== "pass" || phase4?.operations?.publicOperations !== 5 || phase4?.operations?.ownerOperations !== 39 || phase4?.operations?.forbiddenFindings !== 0 || phase4?.boundary !== "pass" || phase4?.runtimeArchitecture !== "pass" || phase4Fixtures.length !== 6 || phase4Fixtures.some((item) => item?.rejected !== true) || phase4Depcruise.length !== 2 || phase4Depcruise.some((item) => item?.rejected !== true)) failures.push("phase4-context-assertions-incomplete");

  const phase5 = contexts?.phase5;
  if (phase5?.issue !== 125 || phase5?.pullRequest !== 144 || !/^[0-9a-f]{40}$/u.test(phase5?.sourceRevision ?? "") || !/^[0-9a-f-]{36}$/iu.test(phase5?.contextRunId ?? "") || phase5?.sourceTreeSha256 !== sourceTreeSha256) failures.push("phase5-run-provenance-invalid");
  if (phase5?.contextVerdict !== "pass" || phase5?.operations?.public !== 5 || phase5?.operations?.owner !== 48 || phase5?.operations?.forbiddenFindings !== 0 || phase5?.runtimeBoundary !== "pass" || phase5?.runtimeArchitecture !== "pass") failures.push("phase5-context-assertions-incomplete");
  const differences = contexts?.activationDifferences;
  if (JSON.stringify(differences) !== JSON.stringify(PHASE6_PREDECESSOR_CONTEXTS.activationDifferences)) failures.push("predecessor-activation-differences-missing");
  return failures;
}

export function makePhase6Report({ sourceRevision, sourceTreeSha256, runtime, startedAt, tools, services, formats, cleanup, failures, predecessorContexts = loadPhase6PredecessorContexts() }) {
  const executed = formats.filter((item) => item.executed).length;
  const failed = formats.filter((item) => item.status === "failed").length;
  const skipped = formats.filter((item) => item.status === "skipped").length;
  const report = {
    schemaVersion: PHASE6_SCHEMA_VERSION,
    ticket: 146,
    parent: 145,
    runId: randomUUID(),
    sourceRevision,
    sourceTreeSha256,
    startedAt,
    completedAt: new Date().toISOString(),
    scope: "phase6-reproducible-service-and-processor-context",
    suite: "phase6-setup-context",
    toolVersions: { node: runtime.node, npm: runtime.npm, ...tools },
    toolDefinitions: { ...PHASE6_TOOL_DEFINITIONS },
    predecessorContexts,
    serviceDefinitions: {
      postgres: "Supabase CLI local stack, PostgreSQL 17 from the committed config",
      auth: "Supabase local Auth and API gateway",
      storage: "Supabase local private Storage API and private bucket",
    },
    services,
    formats,
    counts: { expectedFormats: PHASE6_FORMATS.length, executedFormats: executed, failedFormats: failed, skippedFormats: skipped },
    cleanup,
    failures,
    verdict: failures.length === 0 && executed === PHASE6_FORMATS.length && failed === 0 && skipped === 0 && cleanup.success === true ? "pass" : "fail",
    reproduction: ["npm run setup:validation", "npm run validation:ready", "npm run phase6:focus:verification"],
    limitations: ["This setup probe does not certify Phase 6 application behavior, RLS matrices, race/rollback scenarios, or the final phase6:gate."],
  };
  return report;
}

export function evaluatePhase6Setup(report, { sourceRevision, sourceTreeSha256, now = Date.now() } = {}) {
  const failures = [];
  if (!report || report.schemaVersion !== PHASE6_SCHEMA_VERSION) failures.push("evidence-schema-invalid");
  if (report?.sourceRevision !== sourceRevision || report?.sourceTreeSha256 !== sourceTreeSha256) failures.push("evidence-source-stale-or-mismatched");
  if (!Number.isFinite(Date.parse(report?.startedAt)) || !Number.isFinite(Date.parse(report?.completedAt)) || Date.parse(report.completedAt) < Date.parse(report.startedAt) || Date.parse(report.completedAt) > now) failures.push("evidence-time-invalid");
  if (report?.verdict !== "pass") failures.push("report-verdict-not-pass");
  failures.push(...predecessorContextFailures(report?.predecessorContexts, sourceTreeSha256));
  const formatRows = Array.isArray(report?.formats) ? report.formats : [];
  const actualCounts = {
    executed: formatRows.filter((item) => item?.executed === true).length,
    failed: formatRows.filter((item) => item?.status === "failed").length,
    skipped: formatRows.filter((item) => item?.status === "skipped").length,
  };
  if (report?.counts?.expectedFormats !== PHASE6_FORMATS.length || report?.counts?.executedFormats !== PHASE6_FORMATS.length || report?.counts?.failedFormats !== 0 || report?.counts?.skippedFormats !== 0 || actualCounts.executed !== PHASE6_FORMATS.length || actualCounts.failed !== 0 || actualCounts.skipped !== 0) failures.push("format-execution-counts-incomplete");
  if (!report?.services?.postgres?.available || !report?.services?.auth?.available || !report?.services?.storage?.privateBucketVerified) failures.push("required-service-probe-missing");
  if (!Number.isSafeInteger(report?.services?.postgres?.independentConnections) || report.services.postgres.independentConnections < 2) failures.push("independent-postgres-connections-unavailable");
  if (!report?.cleanup?.success) failures.push("cleanup-not-confirmed");
  for (const tool of Object.values(PHASE6_TOOL_DEFINITIONS)) {
    if (report?.toolDefinitions?.[Object.keys(PHASE6_TOOL_DEFINITIONS).find((key) => PHASE6_TOOL_DEFINITIONS[key] === tool)] !== tool) failures.push("processor-definition-missing");
  }
  const byFormat = new Map(formatRows.map((item) => [item.id, item]));
  if (byFormat.size !== PHASE6_FORMATS.length) failures.push("format-matrix-incomplete-or-duplicated");
  for (const format of PHASE6_FORMATS) {
    const result = byFormat.get(format.id);
    if (!result?.executed || result?.status !== "passed" || result?.storageRoundTrip !== true || result?.scannerVerdict !== "clean" || result?.processorVersion !== report?.toolVersions?.[format.processor]) failures.push(`format-probe-incomplete:${format.id}`);
  }
  return { verdict: failures.length === 0 ? "pass" : "fail", failures };
}

export function getPhase6SourceIdentity() {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  return { sourceRevision: revision, sourceTreeSha256: workingTreeSourceSha256() };
}

export function hashFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function phase6Root() { return ROOT; }
export function phase6RunId() { return randomUUID(); }
export function phase6Readiness() { return verifyEnvironment(ROOT, observeRuntime()); }
export function phase6Package() { return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")); }
