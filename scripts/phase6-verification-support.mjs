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
  scanner: "clamav/clamav:1.4.3",
  imageProcessor: "dpokidov/imagemagick:7.1.1-47",
  videoProcessor: "jrottenberg/ffmpeg:7.1-ubuntu2404",
  pdfProcessor: "jbarlow83/ocrmypdf-alpine:v17.12.1",
});
export const PHASE6_FORMATS = Object.freeze([
  { id: "pdf", kind: "document", mimeType: "application/pdf", processor: "pdfProcessor" },
  { id: "png", kind: "image", mimeType: "image/png", processor: "imageProcessor" },
  { id: "jpeg", kind: "image", mimeType: "image/jpeg", processor: "imageProcessor" },
  { id: "webp", kind: "image", mimeType: "image/webp", processor: "imageProcessor" },
  { id: "mp4", kind: "video", mimeType: "video/mp4", processor: "videoProcessor" },
  { id: "webm", kind: "video", mimeType: "video/webm", processor: "videoProcessor" },
]);

export function isolatedPhase6Config(source, projectId) {
  const config = source
    .replace(/^project_id = .*$/m, `project_id = "${projectId}"`)
    .replace(/(\[api\]\s*)enabled = false/, "$1enabled = true")
    .replace(/(\[auth\]\s*)enabled = false/, "$1enabled = true")
    .replace(/(\[storage\]\s*)enabled = false/, "$1enabled = true")
    .replace(/^port = 54321$/m, "port = 57321")
    .replace(/^port = 54322$/m, "port = 57322")
    .replace(/^shadow_port = 54320$/m, "shadow_port = 57320");
  return `${config.trimEnd()}\n\n[storage.buckets.phase6-private-fixtures]\npublic = false\nfile_size_limit = "50MiB"\n`;
}

export function scrubPhase6Environment(source = process.env) {
  const env = { ...source, CI: "1" };
  for (const key of Object.keys(env)) {
    if (/^(?:SUPABASE_|PHASE[456]_|DATABASE_|OWNER_GITHUB_)/.test(key)) delete env[key];
  }
  return env;
}

export const PHASE6_PREDECESSOR_CONTEXTS = Object.freeze({
  phase4: Object.freeze({ issue: 90, pullRequest: 105, mergeCommit: "9806af81d4ce705c36d9b22089f77213d16887bc", contextVerdict: "pass", context: "phase4 historical baseline; five public and 39 Owner operations; six negative fixtures rejected" }),
  phase5: Object.freeze({ issue: 125, pullRequest: 144, mergeCommit: "26d6efb3d9e281265cc9c099195492b5dcbec79d", contextVerdict: "pass", context: "current Phase 5 context; five public and 48 Owner operations" }),
  activationDifferences: Object.freeze({ phase4: ["identity-access", "portfolio-configuration"], phase5: ["content-and-publishing", "taxonomy-and-discovery"], phase6Owned: ["media", "cv-portfolio"] }),
});

export function makePhase6Report({ sourceRevision, sourceTreeSha256, runtime, startedAt, tools, services, formats, cleanup, failures, predecessorContexts = PHASE6_PREDECESSOR_CONTEXTS }) {
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
  if (report?.predecessorContexts?.phase4?.contextVerdict !== "pass" || report?.predecessorContexts?.phase5?.contextVerdict !== "pass") failures.push("predecessor-context-evidence-missing");
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
