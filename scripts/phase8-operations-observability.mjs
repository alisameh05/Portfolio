#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";
import { REQUIRED_CACHE_TESTS, REQUIRED_REGRESSION_TESTS } from "./run-validation-evolution-tests.mjs";

let Client;

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const EVIDENCE_PATH = path.join(ROOT, "evidence", "phase8-operations-observability-251.json");
const EXPECTED_TESTS_PATH = path.join(ROOT, "tests", "phase8", "operations-observability.expected.json");
const MIGRATION = "20261027014402_operations_observability_summary_indexes.sql";
const NEW_INDEXES = [
  "outbox_events_operational_summary_dead_idx", "outbox_events_operational_summary_retry_idx",
  "outbox_events_operational_summary_lease_idx", "outbox_events_operational_summary_eligible_idx",
  "jobs_operational_summary_status_idx", "jobs_operational_summary_dead_idx", "jobs_operational_summary_lease_idx",
  "owner_exports_operational_summary_recent_idx", "owner_exports_operational_summary_ready_idx",
  "owner_exports_operational_summary_failed_idx", "owner_exports_operational_summary_expired_idx",
];
const EXPECTED_INDEX_DEFINITIONS = new Map([
  ["outbox_events_operational_summary_dead_idx", "CREATE INDEX outbox_events_operational_summary_dead_idx ON operations.outbox_events USING btree (dead_at, event_id) INCLUDE (attempt_count) WHERE (dead_at IS NOT NULL)"],
  ["outbox_events_operational_summary_retry_idx", "CREATE INDEX outbox_events_operational_summary_retry_idx ON operations.outbox_events USING btree (available_at, occurred_at, event_id) INCLUDE (attempt_count) WHERE ((completed_at IS NULL) AND (dead_at IS NULL) AND (attempt_count > 0))"],
  ["outbox_events_operational_summary_lease_idx", "CREATE INDEX outbox_events_operational_summary_lease_idx ON operations.outbox_events USING btree (lease_expires_at, event_id) INCLUDE (available_at, attempt_count, lease_acquired_at) WHERE ((lease_expires_at IS NOT NULL) AND (completed_at IS NULL) AND (dead_at IS NULL))"],
  ["outbox_events_operational_summary_eligible_idx", "CREATE INDEX outbox_events_operational_summary_eligible_idx ON operations.outbox_events USING btree (occurred_at, event_id) INCLUDE (available_at, attempt_count, lease_expires_at, lease_acquired_at) WHERE ((completed_at IS NULL) AND (dead_at IS NULL))"],
  ["jobs_operational_summary_status_idx", "CREATE INDEX jobs_operational_summary_status_idx ON operations.jobs USING btree (status, available_at, job_id) INCLUDE (attempt_count, lease_expires_at) WHERE (status = ANY (ARRAY['available'::text, 'leased'::text, 'dead'::text]))"],
  ["jobs_operational_summary_dead_idx", "CREATE INDEX jobs_operational_summary_dead_idx ON operations.jobs USING btree (available_at, job_id) INCLUDE (attempt_count) WHERE (status = 'dead'::text)"],
  ["jobs_operational_summary_lease_idx", "CREATE INDEX jobs_operational_summary_lease_idx ON operations.jobs USING btree (lease_expires_at, job_id) INCLUDE (attempt_count, lease_acquired_at) WHERE (status = 'leased'::text)"],
  ["owner_exports_operational_summary_recent_idx", "CREATE INDEX owner_exports_operational_summary_recent_idx ON portability.owner_exports USING btree (portfolio_id, status, requested_at DESC, export_id DESC) INCLUDE (started_at, completed_at, artifact_content_length)"],
  ["owner_exports_operational_summary_ready_idx", "CREATE INDEX owner_exports_operational_summary_ready_idx ON portability.owner_exports USING btree (portfolio_id, completed_at DESC, export_id DESC) INCLUDE (started_at, artifact_content_length) WHERE ((status = 'ready'::text) AND (completed_at IS NOT NULL))"],
  ["owner_exports_operational_summary_failed_idx", "CREATE INDEX owner_exports_operational_summary_failed_idx ON portability.owner_exports USING btree (portfolio_id, failed_at DESC, export_id DESC) WHERE ((status = 'failed'::text) AND (failed_at IS NOT NULL))"],
  ["owner_exports_operational_summary_expired_idx", "CREATE INDEX owner_exports_operational_summary_expired_idx ON portability.owner_exports USING btree (portfolio_id, expired_at DESC, export_id DESC) WHERE ((status = 'expired'::text) AND (expired_at IS NOT NULL))"],
]);

export const OPERATIONS_ACCEPTANCE_EVIDENCE_PLAN = [
  { id: "AC01", criterion: "Every parent-required signal has documented units/meaning/source/access/window and a bounded executable observation/query definition.", evidence: [
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability documents every operational signal with a bounded source, query, and explicit unknown rule" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability evaluates bounded dashboard definitions over serialized safe producer records and rejects field drift and inherited metric IDs" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability queries and summarizes an actual streamed Owner export integrity mismatch from a complete bounded system log window" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability queries actual terminal retention failures through a bounded system-wide query and summary" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification reads a bounded one-Portfolio summary under worker RLS, preserves unknown values, and performs no writes" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification keeps bootstrap completion dates unknown until the first policy period finishes" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification reports 24-hour export measurement windows separately from 15-minute integrity failures" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification records one safe authorization failure when Owner Export transition RLS is wrapped inside a transaction" },
  ] },
  { id: "AC02", criterion: "Application/queue/export/privacy producers emit actual safe observations; backup/recovery producer obligations are explicit and cannot be reported complete from fake data.", evidence: [
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability observes otherwise-uninstrumented public and Owner adapters with safe status classes" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability records consent rejection separately from HTTP status without leaking request markers" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability records one Owner export download read success only after verified stream completion" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability records one failed Owner export download read without provider or identity details" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability records streamed integrity mismatch and read failure once without buffering or consuming twice" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability keeps a cancelled Owner export HTTP read out of Storage failures without claiming readiness" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability records a provider read failure when cancellation races with its rejection" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability records a safe Storage failure when the content iterator cannot be initialized" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability retains integrity classification when cancellation races with a proven mismatch" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability keeps event drops unknown while measuring accepted intake without an owning drop producer" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability queries and summarizes an actual streamed Owner export integrity mismatch from a complete bounded system log window" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability queries actual terminal retention failures through a bounded system-wide query and summary" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability records an export assembly Storage write failure from a fixture adapter without private values" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability distinguishes Owner export assembly read interruption from completed integrity mismatch" },
    { kind: "test", suite: "tests/phase8/operations-observability-retention-producer.test.ts", name: "Phase 8 operations observability records actual due-work completion after a sink failure without changing the committed checkpoint" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification records one safe authorization failure when PostgreSQL outbox RLS is wrapped inside a transaction" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification records one safe authorization failure when Owner Export transition RLS is wrapped inside a transaction" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification reads a bounded one-Portfolio summary under worker RLS, preserves unknown values, and performs no writes" },
  ] },
  { id: "AC03", criterion: "Metrics label cardinality is bounded; unknown provider limits/uninstalled signals remain unknown rather than zero/healthy.", evidence: [
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability documents every operational signal with a bounded source, query, and explicit unknown rule" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability source-inventories every active handwritten HTTP handler and its fixed observer wrapper" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability marks age unknown when bounded queue or lease samples cannot establish coverage" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability evaluates relational and object backup RPOs from separate source watermarks and leaves absent producers unknown" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability keeps event drops unknown while measuring accepted intake without an owning drop producer" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability keeps a cancelled Owner export HTTP read out of Storage failures without claiming readiness" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability keeps export integrity unknown for absent, incomplete, malformed, capped or unavailable log windows and measures a complete zero" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability queries actual terminal retention failures through a bounded system-wide query and summary" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification returns unknown bytes when any bounded ready export is missing its content length" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification sums all five bounded export-state samples and preserves per-state cap reporting" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification reads a bounded one-Portfolio summary under worker RLS, preserves unknown values, and performs no writes" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification keeps bootstrap completion dates unknown until the first policy period finishes" },
  ] },
  { id: "AC04", criterion: "Dashboard definitions show oldest eligible outbox, dead/retry/lease state, retention last-complete/backlog and export/storage health with correct inclusion rules.", evidence: [
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification reads a bounded one-Portfolio summary under worker RLS, preserves unknown values, and performs no writes" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification keeps bootstrap completion dates unknown until the first policy period finishes" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification separates active and expired PostgreSQL job lease counts at the observed time" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification excludes expired leases and their missing acquisition timestamps from active lease age" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification returns unknown bytes when any bounded ready export is missing its content length" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification reports 24-hour export measurement windows separately from 15-minute integrity failures" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification sums all five bounded export-state samples and preserves per-state cap reporting" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability evaluates bounded dashboard definitions over serialized safe producer records and rejects field drift and inherited metric IDs" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability keeps a cancelled Owner export HTTP read out of Storage failures without claiming readiness" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability queries and summarizes an actual streamed Owner export integrity mismatch from a complete bounded system log window" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability queries actual terminal retention failures through a bounded system-wide query and summary" },
    { kind: "test", suite: "tests/phase8/resumable-retention-passes.test.ts", name: "Phase 8 resumable retention policy passes (#248) drains a twenty-day outage in contiguous bounded slices without losing the older completion watermark" },
  ] },
  { id: "AC05", criterion: "Private marker tests prove no Feedback/CV/Visitor/credential/signed-URL/provider exception leakage in responses/logs/metrics/evidence.", evidence: [
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability records consent rejection separately from HTTP status without leaking request markers" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability observes the existing private Owner export status route without recording URL or session markers" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability observes otherwise-uninstrumented public and Owner adapters with safe status classes" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability evaluates bounded dashboard definitions over serialized safe producer records and rejects field drift and inherited metric IDs" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability records one failed Owner export download read without provider or identity details" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability records streamed integrity mismatch and read failure once without buffering or consuming twice" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability records a provider read failure when cancellation races with its rejection" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability records a safe Storage failure when the content iterator cannot be initialized" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability retains integrity classification when cancellation races with a proven mismatch" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability queries and summarizes an actual streamed Owner export integrity mismatch from a complete bounded system log window" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability queries actual terminal retention failures through a bounded system-wide query and summary" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability records an export assembly Storage write failure from a fixture adapter without private values" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification records one safe authorization failure when PostgreSQL outbox RLS is wrapped inside a transaction" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification records one safe authorization failure when Owner Export transition RLS is wrapped inside a transaction" },
  ] },
  { id: "AC06", criterion: "Restricted operational summaries deny unapproved access and never create a product/public metrics interface.", evidence: [
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability requires the fixed system purpose and returns durable zero, watermark, and explicit unknown values" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification enforces purpose and role denial and uses bounded indexes over completed history" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification reads a bounded one-Portfolio summary under worker RLS, preserves unknown values, and performs no writes" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability documents every operational signal with a bounded source, query, and explicit unknown rule" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability accepts only the documented Portfolio CLI flag and rejects missing, extra, conflicting, and oversized scope" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability source-inventories every active handwritten HTTP handler and its fixed observer wrapper" },
  ] },
  { id: "AC07", criterion: "Instrumentation failure does not undo committed domain state or expose sensitive fallback errors.", evidence: [
    { kind: "test", suite: "tests/phase8/operations-observability-retention-producer.test.ts", name: "Phase 8 operations observability records actual due-work completion after a sink failure without changing the committed checkpoint" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability queries actual terminal retention failures through a bounded system-wide query and summary" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability records unavailable, committed acceptance, and indeterminate commit acknowledgement as distinct outcomes" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability ignores sink failures and rejects out-of-contract observations without throwing" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability keeps a successful adapter response when its telemetry logger throws" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification records one safe authorization failure when PostgreSQL outbox RLS is wrapped inside a transaction" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification emits database pool, transaction, authorization, lease-reclaim, and stale-write observations from real PostgreSQL boundaries" },
  ] },
  { id: "AC08", criterion: "Representative observation/query plans are bounded and do not perform backup/restore, unbounded scans or source mutations.", evidence: [
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification EXPLAIN ANALYZE bounds oldest-eligible traversal over a large pending and future queue" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification EXPLAIN ANALYZE bounds current export states and recent transition windows across old requests" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification sums all five bounded export-state samples and preserves per-state cap reporting" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification EXPLAIN ANALYZE bounds active lease-age reads after a large expired-lease prefix" },
    { kind: "test", suite: "tests/phase8/operations-observability-postgres.gate.ts", name: "operations summary PostgreSQL qualification reads a bounded one-Portfolio summary under worker RLS, preserves unknown values, and performs no writes" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability documents every operational signal with a bounded source, query, and explicit unknown rule" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability evaluates bounded dashboard definitions over serialized safe producer records and rejects field drift and inherited metric IDs" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability keeps export integrity unknown for absent, incomplete, malformed, capped or unavailable log windows and measures a complete zero" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability queries actual terminal retention failures through a bounded system-wide query and summary" },
    { kind: "test", suite: "tests/phase8/operations-observability.test.ts", name: "Phase 8 operations observability evaluates relational and object backup RPOs from separate source watermarks and leaves absent producers unknown" },
  ] },
];

function evidenceValue(root, dottedPath) {
  let value = root;
  for (const part of dottedPath.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

function nonempty(value) {
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && typeof value === "object" && Object.keys(value).length > 0;
}

function artifactReferencePassed(reference, evidence) {
  const value = evidenceValue(evidence, reference.path);
  switch (reference.check) {
    case "sha256": return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
    case "nonempty": return nonempty(value);
    case "equals": return value === reference.value;
    case "same-as": return value !== undefined && value === evidenceValue(evidence, reference.otherPath);
    case "nonnegative-number": return typeof value === "number" && Number.isFinite(value) && value >= 0;
    case "cli-rejections": return Array.isArray(value) && value.length === 5 && value.every((item) => item?.status !== 0 &&
      item?.outcome === "OPERATIONS_SUMMARY_ARGUMENTS_INVALID");
    case "migration64-record": return Array.isArray(value) && value.some((item) => item?.name === MIGRATION &&
      typeof item?.sha256 === "string" && /^[a-f0-9]{64}$/u.test(item.sha256));
    default: return false;
  }
}

/** Resolve evidence links only to passed named checks or populated proof fields. */
export function resolveAcceptanceEvidence(plan, evidence) {
  if (!Array.isArray(plan) || plan.length === 0 || !Array.isArray(evidence?.testInventory)) {
    throw new Error("GATE_ACCEPTANCE_EVIDENCE_UNRESOLVED");
  }
  const ids = plan.map((criterion) => criterion?.id);
  if (new Set(ids).size !== ids.length || plan.some((criterion) => typeof criterion.criterion !== "string" ||
      criterion.criterion.length === 0 || !Array.isArray(criterion.evidence) || criterion.evidence.length === 0)) {
    throw new Error("GATE_ACCEPTANCE_EVIDENCE_UNRESOLVED");
  }
  return plan.map((criterion) => ({
    id: criterion.id,
    criterion: criterion.criterion,
    evidence: criterion.evidence.map((reference) => {
      if (reference?.kind === "test") {
        const matches = evidence.testInventory.filter((test) => test?.suite === reference.suite && test?.name === reference.name);
        if (matches.length !== 1 || matches[0]?.status !== "passed") throw new Error("GATE_ACCEPTANCE_EVIDENCE_UNRESOLVED");
        return { kind: "test", suite: reference.suite, name: reference.name, status: "passed" };
      }
      if (reference?.kind === "artifact" && typeof reference.path === "string" && artifactReferencePassed(reference, evidence)) {
        return { kind: "artifact", path: reference.path, status: "resolved" };
      }
      throw new Error("GATE_ACCEPTANCE_EVIDENCE_UNRESOLVED");
    }),
  }));
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

/** Platform-injected helpers keep path rules unit-testable without native PG binaries. */
export function operationsTempBase({ platform = process.platform, env = process.env, tmpdir = os.tmpdir() } = {}) {
  return platform === "win32" ? path.win32.resolve(env.PHASE8_TEMP_ROOT ?? "C:\\t") : path.posix.resolve(env.PHASE8_TEMP_ROOT ?? tmpdir);
}

export function operationsRunRoot({ platform = process.platform, tempBase, runId }) {
  const api = platform === "win32" ? path.win32 : path.posix;
  return api.join(tempBase, `phase8-operations-observability-${runId}`);
}

export function isOwnedOperationsRunPath(runRoot, tempBase, platform = process.platform, runId) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const root = api.resolve(tempBase);
  const candidate = api.resolve(runRoot);
  const relative = api.relative(root, candidate);
  const expectedName = typeof runId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(runId)
    ? `phase8-operations-observability-${runId}` : null;
  return relative !== "" && !relative.startsWith(`..${api.sep}`) && relative !== ".." &&
    !api.isAbsolute(relative) && api.dirname(candidate) === root &&
    expectedName !== null && api.basename(candidate) === expectedName;
}

function normalizedPath(value, platform) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const resolved = api.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function parsePostmasterPidFile(contents, dataRoot, platform = process.platform) {
  if (typeof contents !== "string") return null;
  const lines = contents.split(/\r?\n/u);
  const pid = Number(lines[0]);
  const recordedDataRoot = lines[1];
  if (!Number.isSafeInteger(pid) || pid < 1 || typeof recordedDataRoot !== "string" || recordedDataRoot.length === 0 ||
      normalizedPath(recordedDataRoot, platform) !== normalizedPath(dataRoot, platform)) return null;
  return { pid, dataRoot: normalizedPath(recordedDataRoot, platform) };
}

export function postgresCommandLineOwnsDataDirectory(commandLine, dataRoot, platform = process.platform) {
  if (typeof commandLine !== "string" || commandLine.length === 0) return false;
  const executable = commandLine.match(/^\s*(?:"([^"]+)"|(\S+))/u);
  const executableName = path.win32.basename(executable?.[1] ?? executable?.[2] ?? "").replace(/\.exe$/iu, "").toLowerCase();
  if (executableName !== "postgres") return false;
  const normalizedRoot = normalizedPath(dataRoot, platform);
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const rootPattern = platform === "win32"
    ? normalizedRoot.split(/[\\/]/u).map(escapeRegex).join("[\\\\/]")
    : escapeRegex(normalizedRoot);
  const flags = platform === "win32" ? "iu" : "u";
  return new RegExp(`(?:^|\\s)-D\\s+(?:"${rootPattern}"|${rootPattern})(?=\\s|$)`, flags).test(commandLine) ||
    new RegExp(`(?:^|\\s)-D(?:"${rootPattern}"|${rootPattern})(?=\\s|$)`, flags).test(commandLine);
}

/**
 * Shared cleanup decision logic. `inspect` must identify the live process by
 * both PID and the exact data-directory argument; unknown ownership never
 * authorizes either stop or recursive removal.
 */
export async function cleanupOwnedOperationsRun({
  runRoot, tempBase, dataRoot, runId, platform = process.platform, ownerRecord, startupAttempted,
  inspect, stop, remove,
}) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const exactDataRoot = api.join(api.resolve(runRoot), "data");
  if (!isOwnedOperationsRunPath(runRoot, tempBase, platform, runId) ||
      normalizedPath(dataRoot, platform) !== normalizedPath(exactDataRoot, platform) ||
      !ownerRecord || ownerRecord.version !== 1 || ownerRecord.runId !== runId ||
      ownerRecord.dataDirectoryRelative !== "data" || ownerRecord.startupAttempted !== startupAttempted) {
    return { ok: false, stage: "cleanup-ownership-invalid", stopAttempted: false };
  }
  let stopAttempted = false;
  if (startupAttempted) {
    let processState;
    try { processState = await inspect(); } catch { processState = { state: "unknown" }; }
    if (!processState || processState.state === "unknown") {
      return { ok: false, stage: "cleanup-process-identity-unknown", stopAttempted };
    }
    if (processState.state === "owned") {
      stopAttempted = true;
      try { await stop(processState.pid); } catch { /* verify ownership and liveness before deciding cleanup */ }
      try { processState = await inspect(processState.pid); } catch { processState = { state: "unknown" }; }
      if (!processState || processState.state === "owned" || processState.state === "unknown") {
        return { ok: false, stage: "cleanup-postgres-still-live-or-unknown", stopAttempted };
      }
    }
  }
  try {
    await remove();
    return { ok: true, stage: "cleanup-complete", stopAttempted };
  } catch {
    return { ok: false, stage: "cleanup-remove-failed", stopAttempted };
  }
}

export function validRepositoryIdentity(head, branch) {
  return /^[0-9a-f]{40}$/iu.test(head) && typeof branch === "string";
}

export function resolvePostgresBinaryDirectory({ env = process.env, platform = process.platform,
  pathValue = env.PATH ?? "", exists = existsSync } = {}) {
  const api = platform === "win32" ? path.win32 : path.posix;
  const suffix = platform === "win32" ? ".exe" : "";
  const candidates = env.PHASE7_POSTGRES_BIN !== undefined
    ? [api.resolve(env.PHASE7_POSTGRES_BIN)]
    : pathValue.split(platform === "win32" ? ";" : ":").filter(Boolean).map((entry) => api.resolve(entry));
  for (const candidate of candidates) {
    if (["postgres", "initdb", "pg_ctl"].every((name) => exists(api.join(candidate, `${name}${suffix}`)))) return candidate;
  }
  return null;
}

function fixedFailure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function packageVersion(name) {
  try { return JSON.parse(readFileSync(path.join(ROOT, "node_modules", name, "package.json"), "utf8")).version; }
  catch { return "unavailable"; }
}

function command(commandName, args, { env = process.env, timeout = 240_000, allowFailure = false, stdio = "pipe" } = {}) {
  const result = spawnSync(commandName, args, { cwd: ROOT, env, encoding: "utf8", windowsHide: true, timeout,
    stdio, maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0 && !allowFailure) {
    const spawnCode = result.error?.code;
    const safeSpawnCode = spawnCode === "ETIMEDOUT" ? "timeout" : spawnCode === "ENOENT" ? "not-found"
      : spawnCode === "EACCES" || spawnCode === "EPERM" ? "permission-denied" : result.error ? "spawn-error" : null;
    throw fixedFailure(`GATE_COMMAND_FAILED:${safeSpawnCode ?? `exit-${Number.isInteger(result.status) ? result.status : "unknown"}`}`);
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function inspectPostgresOwner(dataRoot, platform, env) {
  const pidFile = path.join(dataRoot, "postmaster.pid");
  let owner = null;
  let malformedPidFile = false;
  if (existsSync(pidFile)) {
    try { owner = parsePostmasterPidFile(readFileSync(pidFile, "utf8"), dataRoot, platform); }
    catch { malformedPidFile = true; }
    if (!owner) malformedPidFile = true;
  }
  try {
    if (owner && platform === "win32") {
      const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${owner.pid}' -ErrorAction Stop; if ($null -ne $p) { $p.CommandLine }`;
      const result = command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env, timeout: 10_000 });
      if (result.stdout.trim() && postgresCommandLineOwnsDataDirectory(result.stdout.trim(), dataRoot, platform)) {
        return { state: "owned", pid: owner.pid };
      }
    } else if (owner) {
      const args = readFileSync(`/proc/${owner.pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      const commandLine = args.map((argument) => /\s/u.test(argument) ? `"${argument.replaceAll('"', '\\"')}"` : argument).join(" ");
      if (postgresCommandLineOwnsDataDirectory(commandLine, dataRoot, platform)) return { state: "owned", pid: owner.pid };
    }
    const matchingProcess = findPostgresProcess(dataRoot, platform, env);
    if (matchingProcess.state === "owned") return matchingProcess;
    if (matchingProcess.state === "unknown" || malformedPidFile) return { state: "unknown", ...(owner ? { pid: owner.pid } : {}) };
    return owner ? { state: "unrelated", pid: owner.pid } : { state: "absent" };
  } catch (error) {
    if (platform !== "win32" && error?.code === "ENOENT") {
      try { return findPostgresProcess(dataRoot, platform, env); } catch { return { state: "unknown", ...(owner ? { pid: owner.pid } : {}) }; }
    }
    return { state: "unknown", ...(owner ? { pid: owner.pid } : {}) };
  }
}

function findPostgresProcess(dataRoot, platform, env) {
  if (platform === "win32") {
    const escapedRoot = dataRoot.replaceAll("\\", "/").replaceAll("'", "''");
    const script = `$root = '${escapedRoot}'; $rootPattern = [regex]::Escape($root).Replace('/', '[\\\\/]'); ` +
      `$pattern = '(?:^|\\s)-D\\s+(?:"' + $rootPattern + '"|' + $rootPattern + ')(?=\\s|$)'; ` +
      `Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -match '^postgres(?:\\.exe)?$' -and $_.CommandLine -match $pattern } | ` +
      `Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`;
    const result = command("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env, timeout: 10_000 });
    if (!result.stdout.trim()) return { state: "absent" };
    let processes;
    try { processes = JSON.parse(result.stdout); } catch { return { state: "unknown" }; }
    const matches = Array.isArray(processes) ? processes : [processes];
    const owned = matches.find((item) => Number.isSafeInteger(Number(item.ProcessId)) &&
      postgresCommandLineOwnsDataDirectory(String(item.CommandLine ?? ""), dataRoot, platform));
    return owned ? { state: "owned", pid: Number(owned.ProcessId) } : { state: "unknown" };
  }
  let entries;
  try { entries = readdirSync("/proc", { withFileTypes: true }); } catch { return { state: "unknown" }; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
    let args;
    try { args = readFileSync(`/proc/${entry.name}/cmdline`, "utf8").split("\0").filter(Boolean); }
    catch (error) { if (error?.code === "ENOENT") continue; else continue; }
    if (args.length === 0) continue;
    const commandLine = args.map((argument) => /\s/u.test(argument) ? `"${argument.replaceAll('"', '\\"')}"` : argument).join(" ");
    if (postgresCommandLineOwnsDataDirectory(commandLine, dataRoot, platform)) return { state: "owned", pid: Number(entry.name) };
  }
  return { state: "absent" };
}

function safeGateFailure(error) {
  if (typeof error?.code === "string" && /^GATE_(?:COMMAND_FAILED:(?:timeout|not-found|permission-denied|spawn-error|exit-(?:\d+|unknown))|[A-Z0-9_]+)$/u.test(error.code)) return error.code;
  return "GATE_DATABASE_OR_RUNTIME_FAILURE";
}

function pgExecutable(pgBin, name, platform = process.platform) {
  const api = platform === "win32" ? path.win32 : path.posix;
  return api.join(pgBin, `${name}${platform === "win32" ? ".exe" : ""}`);
}

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") { server.close(); reject(fixedFailure("GATE_PORT_UNAVAILABLE")); return; }
      server.close((error) => error ? reject(fixedFailure("GATE_PORT_UNAVAILABLE")) : resolvePort(address.port));
    });
  });
}

function sourceMigrations() {
  return readdirSync(path.join(ROOT, "supabase", "migrations")).filter((name) => name.endsWith(".sql")).sort();
}

async function applyMigrations(client, migrationNames) {
  for (const name of migrationNames) await client.query(readFileSync(path.join(ROOT, "supabase", "migrations", name), "utf8"));
}

async function captureSecurity(client) {
  const [relations, policies, grants, indexes] = await Promise.all([
    client.query(`select n.nspname as schema_name, c.relname as table_name, r.rolname as owner,
        c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
      from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_roles r on r.oid=c.relowner
      where n.nspname='operations' and c.relname in ('outbox_events','jobs') order by c.relname`),
    client.query(`select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
      from pg_policies where schemaname='operations' and tablename in ('outbox_events','jobs') order by tablename,policyname`),
    client.query(`select table_schema,table_name,grantee,privilege_type,is_grantable,grantor
      from information_schema.role_table_grants where table_schema='operations' and table_name in ('outbox_events','jobs')
      order by table_name,grantee,privilege_type,grantor`),
    client.query(`select t.relname as table_name, i.relname as index_name, pg_get_indexdef(i.oid) as index_definition
      from pg_index x join pg_class i on i.oid=x.indexrelid join pg_class t on t.oid=x.indrelid
      join pg_namespace n on n.oid=t.relnamespace where n.nspname='operations'
        and t.relname in ('outbox_events','jobs') order by t.relname,i.relname`),
  ]);
  return { relations: relations.rows, policies: policies.rows, grants: grants.rows, indexes: indexes.rows };
}

async function verifyNewIndexCatalog(client) {
  const result = await client.query(`select i.relname as index_name, pg_get_indexdef(i.oid) as index_definition
    from pg_index x join pg_class i on i.oid=x.indexrelid join pg_class t on t.oid=x.indrelid
    join pg_namespace n on n.oid=t.relnamespace
    where i.relname = any($1::text[]) order by i.relname`, [NEW_INDEXES]);
  const actual = new Map(result.rows.map((row) => [row.index_name, row.index_definition]));
  if (actual.size !== NEW_INDEXES.length) throw fixedFailure("GATE_MIGRATION_INDEX_INVENTORY_MISMATCH");
  const mismatched = NEW_INDEXES.some((name) => actual.get(name) !== EXPECTED_INDEX_DEFINITIONS.get(name));
  if (mismatched) throw fixedFailure("GATE_MIGRATION_INDEX_DEFINITION_MISMATCH");
  return Object.fromEntries([...actual.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

async function columnFacts(client) {
  const result = await client.query(`select table_name,column_name,data_type,is_nullable,column_default
    from information_schema.columns where table_schema='operations' and table_name in ('outbox_events','jobs')
      and column_name='lease_acquired_at' order by table_name`);
  return result.rows;
}

async function seedPredecessorRows(client) {
  await client.query(`insert into operations.outbox_events
    (event_id,event_type,schema_version,aggregate_id,aggregate_version,payload,correlation_id,occurred_at,available_at,completed_at)
    values ('0196a1b2-7c3d-7e11-9f22-000000000071','gate.predecessor.v1',1,
      '0196a1b2-7c3d-7e11-9f22-000000000072',1,'{}'::jsonb,'migration-proof',clock_timestamp(),clock_timestamp(),clock_timestamp())`);
  await client.query(`insert into operations.jobs
    (job_id,job_type,payload_version,payload,available_at,status,attempt_count,completed_at)
    values ('0196a1b2-7c3d-7e11-9f22-000000000073','gate.predecessor.v1',1,'{"type":"gate.predecessor.v1","version":1,"value":{}}'::jsonb,
      clock_timestamp(),'completed',0,clock_timestamp())`);
}

async function verifySeedRows(client) {
  const result = await client.query(`select
    (select count(*)::int from operations.outbox_events where event_id='0196a1b2-7c3d-7e11-9f22-000000000071') as outbox_rows,
    (select count(*)::int from operations.jobs where job_id='0196a1b2-7c3d-7e11-9f22-000000000073') as job_rows`);
  if (result.rows[0]?.outbox_rows !== 1 || result.rows[0]?.job_rows !== 1) throw fixedFailure("GATE_MIGRATION_DATA_NOT_PRESERVED");
}

async function proveMigration(client, migrationSql) {
  await seedPredecessorRows(client);
  const predecessorSecurity = await captureSecurity(client);
  const predecessorColumns = await columnFacts(client);
  if (predecessorColumns.length !== 0) throw fixedFailure("GATE_PREDECESSOR_IS_NOT_PRE_MIGRATION");

  await client.query(migrationSql);
  await verifySeedRows(client);
  const upgradedSecurity = await captureSecurity(client);
  if (JSON.stringify(upgradedSecurity.relations) !== JSON.stringify(predecessorSecurity.relations) ||
      JSON.stringify(upgradedSecurity.policies) !== JSON.stringify(predecessorSecurity.policies) ||
      JSON.stringify(upgradedSecurity.grants) !== JSON.stringify(predecessorSecurity.grants)) {
    throw fixedFailure("GATE_MIGRATION_SECURITY_CHANGED");
  }
  const baselineIndexNames = new Set(predecessorSecurity.indexes.map((row) => row.index_name));
  const unchangedIndexes = upgradedSecurity.indexes.filter((row) => baselineIndexNames.has(row.index_name));
  if (JSON.stringify(unchangedIndexes) !== JSON.stringify(predecessorSecurity.indexes)) throw fixedFailure("GATE_MIGRATION_PREEXISTING_INDEX_CHANGED");
  const columns = await columnFacts(client);
  if (columns.length !== 2 || columns.some((row) => row.data_type !== "timestamp with time zone" || row.is_nullable !== "YES" || row.column_default !== null)) {
    throw fixedFailure("GATE_MIGRATION_COLUMN_DEFINITION_MISMATCH");
  }
  const catalog = await verifyNewIndexCatalog(client);

  const dropIndexes = NEW_INDEXES.map((name) => `drop index ${name.startsWith("owner_exports_") ? "portability" : "operations"}.${name};`).join("\n");
  await client.query(`grant shipwithali_migration to current_user; set role shipwithali_migration; ${dropIndexes}
    alter table operations.outbox_events drop column lease_acquired_at;
    alter table operations.jobs drop column lease_acquired_at; reset role;`);
  await verifySeedRows(client);
  const rolledBackSecurity = await captureSecurity(client);
  const rollbackColumns = await columnFacts(client);
  if (rollbackColumns.length !== 0 || JSON.stringify(rolledBackSecurity) !== JSON.stringify(predecessorSecurity)) {
    throw fixedFailure("GATE_MIGRATION_ROLLBACK_MISMATCH");
  }
  await client.query(migrationSql);
  await verifySeedRows(client);
  const forwardCatalog = await verifyNewIndexCatalog(client);
  const forwardSecurity = await captureSecurity(client);
  if (JSON.stringify(forwardSecurity.relations) !== JSON.stringify(predecessorSecurity.relations) ||
      JSON.stringify(forwardSecurity.policies) !== JSON.stringify(predecessorSecurity.policies) ||
      JSON.stringify(forwardSecurity.grants) !== JSON.stringify(predecessorSecurity.grants)) {
    throw fixedFailure("GATE_MIGRATION_FORWARD_SECURITY_CHANGED");
  }
  return { predecessor: "rows, grants, RLS and policies captured before migration",
    upgradeCatalog: catalog, rollback: "indexes and nullable columns removed; rows, grants, RLS and policies preserved",
    forwardFixCatalog: forwardCatalog };
}

async function directoryBytes(directory) {
  let bytes = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(target);
    else if (entry.isFile()) bytes += statSync(target).size;
  }
  return bytes;
}

async function databaseUrl(client, database) {
  const result = await client.query("select current_user as role, current_database() as database");
  if (result.rows[0]?.database !== database) throw fixedFailure("GATE_DATABASE_SELECTION_FAILED");
}

function namedTestInventory(report, expectedFiles, expectedTests) {
  const suiteFiles = (report.testResults ?? []).map((result) => path.relative(ROOT, result.name).replaceAll("\\", "/")).sort();
  if (JSON.stringify(suiteFiles) !== JSON.stringify([...expectedFiles].sort())) throw fixedFailure("GATE_TEST_SUITE_INVENTORY_MISMATCH");
  const inventory = (report.testResults ?? []).flatMap((result) => (result.assertionResults ?? []).map((test) => ({
    name: test.fullName,
    suite: path.relative(ROOT, result.name).replaceAll("\\", "/"),
    status: test.status,
  }))).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const actualNames = inventory.map((test) => test.name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify([...expectedTests].sort())) throw fixedFailure("GATE_NAMED_TEST_INVENTORY_MISMATCH");
  return inventory;
}

function runSummaryCli(npmExecPath, env, args) {
  return command(process.execPath, [npmExecPath, "run", "operations:summary", "--", ...args], { env, timeout: 120_000, allowFailure: true });
}

function assertSafeCliFailure(result, expectedCode, forbiddenValues) {
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.status === 0 || !combined.includes(expectedCode) || forbiddenValues.some((value) => value && combined.includes(value))) {
    throw fixedFailure("GATE_CLI_REJECTION_OR_PRIVACY_INVALID");
  }
  return { status: result.status, outcome: expectedCode };
}

async function runGate() {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const branch = command("git", ["branch", "--show-current"]).stdout.trim();
  const head = command("git", ["rev-parse", "HEAD"]).stdout.trim();
  if (!validRepositoryIdentity(head, branch)) throw fixedFailure("GATE_GIT_IDENTITY_UNAVAILABLE");
  const sourceBefore = workingTreeSourceSha256();
  const platform = process.platform;
  const tempBase = operationsTempBase({ platform, env: process.env });
  if (platform === "win32") {
    mkdirSync(tempBase, { recursive: true });
    process.env.TEMP = tempBase;
    process.env.TMP = tempBase;
    process.env.TMPDIR = tempBase;
  }
  const runRoot = operationsRunRoot({ platform, tempBase, runId });
  const dataRoot = path.join(runRoot, "data");
  const ownerPath = path.join(runRoot, "owner.json");
  const pgLog = path.join(runRoot, "postgres.log");
  const testReport = path.join(runRoot, "vitest.json");
  const planPath = path.join(runRoot, "query-plan.json");
  const evidence = {
    evidenceVersion: 1,
    ticket: 251,
    runId,
    startedAt,
    completedAt: null,
    repository: { head, branch: branch || null, detached: branch.length === 0,
      sourceTreeSha256Before: sourceBefore, sourceTreeSha256After: null },
    tools: { node: process.version, npm: process.env.npm_config_user_agent?.match(/npm\/([^\s]+)/u)?.[1] ?? "unknown",
      vitest: packageVersion("vitest"),
      postgres: null, pgMajor: null },
    services: [], roles: [],
    migrations: sourceMigrations().map((name) => ({ name,
      sha256: sha256(readFileSync(path.join(ROOT, "supabase", "migrations", name), "utf8").replaceAll("\r\n", "\n")) })),
    volumes: { clusterBytesBeforeCleanup: null, clusterBytesAfterCleanup: null }, checks: { validationEvolution: null },
    suites: [], testCounts: { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 },
    testInventory: [], testFailureLocations: [], cli: { valid: null, rejectedInputs: [] }, queryPlan: null, migrationProof: null,
    acceptanceEvidencePlan: OPERATIONS_ACCEPTANCE_EVIDENCE_PLAN,
    acceptanceEvidenceResolved: [],
    startup: { attempted: false, commandOutcome: "not-started" },
    cleanupDiagnostics: { stage: "pending", stopAttempted: false },
    cleanup: "pending", result: "failed", failureCode: null, failureStage: null,
  };
  let client;
  let upgradeClient;
  let freshClient;
  let predecessorClient;
  let runRootCreated = false;
  let startupAttempted = false;
  let ownerRecord;
  let stage = "run-root-create";
  let cleanupSucceeded = true;
  let failureCode = null;
  let pgBin;
  const tempEnv = { ...process.env };
  if (platform === "win32") Object.assign(tempEnv, { TEMP: tempBase, TMP: tempBase, TMPDIR: tempBase });

  try {
    if (!isOwnedOperationsRunPath(runRoot, tempBase, platform, runId) || existsSync(runRoot)) {
      throw fixedFailure("GATE_TEMP_RUN_COLLISION_OR_SCOPE_INVALID");
    }
    mkdirSync(runRoot);
    runRootCreated = true;
    ownerRecord = { version: 1, runId, dataDirectoryRelative: "data", startupAttempted: false };
    writeFileSync(ownerPath, `${JSON.stringify(ownerRecord)}\n`, { flag: "wx" });
    stage = "validation-environment";
    const readiness = command(process.execPath, [path.join(ROOT, "scripts", "validation-environment.mjs")], { env: tempEnv, allowFailure: true });
    if (readiness.status !== 0) {
      const codes = `${readiness.stdout}\n${readiness.stderr}`.split(/\r?\n/u).filter((line) => line.startsWith("VALIDATION_"));
      evidence.validationReadiness = codes;
      throw fixedFailure("GATE_VALIDATION_ENVIRONMENT_NOT_READY");
    }
    evidence.validationReadiness = ["ready"];
    ({ Client } = await import("pg"));
    pgBin = resolvePostgresBinaryDirectory({ env: tempEnv, platform });
    if (!pgBin) throw fixedFailure("GATE_NATIVE_POSTGRES_BINARIES_NOT_FOUND");
    const pg = (name) => pgExecutable(pgBin, name, platform);
    evidence.tools.postgres = command(pg("postgres"), ["--version"], { env: tempEnv }).stdout.trim();
    const major = Number(evidence.tools.postgres.match(/(?:PostgreSQL|postgres)\)\s*([0-9]+)/iu)?.[1]);
    if (major !== 17 && major !== 18) throw fixedFailure("GATE_POSTGRES_MAJOR_UNSUPPORTED");
    evidence.tools.pgMajor = major;

    stage = "postgres-initdb";
    command(pg("initdb"), ["-D", dataRoot, "--no-locale", "-A", "trust", "-U", "postgres"], { env: tempEnv, timeout: 90_000 });
    const configPath = path.join(dataRoot, "postgresql.conf");
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = ''\n`);
    const port = await availablePort();
    startupAttempted = true;
    evidence.startup.attempted = true;
    ownerRecord = { ...ownerRecord, startupAttempted: true };
    writeFileSync(ownerPath, `${JSON.stringify(ownerRecord)}\n`);
    stage = "postgres-start";
    const startup = command(pg("pg_ctl"), ["-D", dataRoot, "-l", pgLog, "-o", `-h 127.0.0.1 -p ${port} -F`, "-w", "start"],
      { env: tempEnv, timeout: 60_000, stdio: "ignore" });
    evidence.startup.commandOutcome = startup.status === 0 ? "exited-successfully" : "exited-failed";
    const rootUrl = `postgres://postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
    stage = "postgres-connect";
    client = new Client({ connectionString: rootUrl });
    await client.connect();
    stage = "postgres-role-setup";
    await client.query("create role anon nologin");
    await client.query("create role authenticated nologin");
    await client.query("create role shipwithali_migration nologin nosuperuser nobypassrls");
    stage = "postgres-database-setup";
    await client.query("create database operations_summary_upgrade");
    await client.query("create database operations_summary_fresh");
    await client.query("create database operations_summary_predecessor");
    await client.query("grant create on database operations_summary_upgrade to shipwithali_migration");
    await client.query("grant create on database operations_summary_fresh to shipwithali_migration");
    await client.query("grant create on database operations_summary_predecessor to shipwithali_migration");

    stage = "migration-upgrade";
    const migrationFiles = sourceMigrations();
    const migrationSql = readFileSync(path.join(ROOT, "supabase", "migrations", MIGRATION), "utf8");
    if (!migrationFiles.includes(MIGRATION)) throw fixedFailure("GATE_MIGRATION_SOURCE_MISSING");
    const previous = migrationFiles.filter((name) => name !== MIGRATION);
    const upgradeUrl = `postgres://postgres@127.0.0.1:${port}/operations_summary_upgrade?sslmode=disable`;
    upgradeClient = new Client({ connectionString: upgradeUrl });
    await upgradeClient.connect();
    await applyMigrations(upgradeClient, previous);
    evidence.migrationProof = await proveMigration(upgradeClient, migrationSql);

    const freshUrl = `postgres://postgres@127.0.0.1:${port}/operations_summary_fresh?sslmode=disable`;
    freshClient = new Client({ connectionString: freshUrl });
    await freshClient.connect();
    await applyMigrations(freshClient, migrationFiles);
    await verifyNewIndexCatalog(freshClient);
    const freshColumns = await columnFacts(freshClient);
    if (freshColumns.length !== 2) throw fixedFailure("GATE_FRESH_MIGRATION_COLUMN_MISMATCH");

    await client.query(`create role operations_summary_worker_runtime login nosuperuser nobypassrls;
      grant shipwithali_worker to operations_summary_worker_runtime;
      create role operations_summary_application_runtime login nosuperuser nobypassrls;
      grant shipwithali_application to operations_summary_application_runtime`);
    const predecessorUrl = `postgres://postgres@127.0.0.1:${port}/operations_summary_predecessor?sslmode=disable`;
    predecessorClient = new Client({ connectionString: predecessorUrl });
    await predecessorClient.connect();
    await applyMigrations(predecessorClient, previous);
    await client.query("grant connect on database operations_summary_upgrade, operations_summary_fresh, operations_summary_predecessor to operations_summary_worker_runtime, operations_summary_application_runtime");
    const workerUrl = `postgres://operations_summary_worker_runtime@127.0.0.1:${port}/operations_summary_upgrade?sslmode=disable`;
    const freshWorkerUrl = `postgres://operations_summary_worker_runtime@127.0.0.1:${port}/operations_summary_fresh?sslmode=disable`;
    const predecessorWorkerUrl = `postgres://operations_summary_worker_runtime@127.0.0.1:${port}/operations_summary_predecessor?sslmode=disable`;
    const applicationUrl = `postgres://operations_summary_application_runtime@127.0.0.1:${port}/operations_summary_upgrade?sslmode=disable`;
    const testEnv = { ...tempEnv, npm_config_loglevel: "silent", DATABASE_URL: workerUrl, OPERATIONS_SUMMARY_PORTFOLIO_ID: "0196a1b2-7c3d-7e11-9f22-000000000001",
      OPERATIONS_SUMMARY_ADMIN_DATABASE_URL: upgradeUrl, OPERATIONS_SUMMARY_WORKER_DATABASE_URL: workerUrl,
      OPERATIONS_SUMMARY_APPLICATION_DATABASE_URL: applicationUrl, OPERATIONS_SUMMARY_PREDECESSOR_ADMIN_DATABASE_URL: predecessorUrl,
      OPERATIONS_SUMMARY_PREDECESSOR_WORKER_DATABASE_URL: predecessorWorkerUrl, OPERATIONS_SUMMARY_FRESH_ADMIN_DATABASE_URL: freshUrl,
      OPERATIONS_SUMMARY_FRESH_WORKER_DATABASE_URL: freshWorkerUrl, OPERATIONS_SUMMARY_PLAN_PATH: planPath };
    evidence.services = [{ name: "postgresql", status: "running", mode: "isolated disposable local cluster" },
      { name: "operations_summary_upgrade", status: "migrated predecessor, upgraded, rolled back, and forward-applied" },
      { name: "operations_summary_fresh", status: "fresh replay includes current migration" },
      { name: "operations_summary_predecessor", status: "fresh replay through migration63; migration64 absent" }];
    evidence.roles = ["operations_summary_worker_runtime -> shipwithali_worker", "operations_summary_application_runtime -> shipwithali_application",
      "shipwithali_migration (DDL only; no new product grants)"];

    stage = "operations-observability-tests";
    const testManifest = JSON.parse(readFileSync(EXPECTED_TESTS_PATH, "utf8"));
    const expectedFiles = testManifest.suites;
    evidence.suites = expectedFiles;
    const testResult = command(process.execPath, [path.join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run",
      "--config", "vitest.operations-observability.config.ts", "--reporter=json", `--outputFile=${testReport}`, "--no-file-parallelism"],
    { env: testEnv, timeout: 240_000, allowFailure: true });
    if (!existsSync(testReport)) throw fixedFailure("GATE_TEST_REPORT_MISSING");
    const vitest = JSON.parse(readFileSync(testReport, "utf8"));
    evidence.testCounts = { total: vitest.numTotalTests ?? 0, passed: vitest.numPassedTests ?? 0, failed: vitest.numFailedTests ?? 0,
      skipped: vitest.numPendingTests ?? 0, todo: vitest.numTodoTests ?? 0 };
    evidence.discoveredTestInventory = (vitest.testResults ?? []).map((suite) => ({
      suite: path.relative(ROOT, suite.name).replaceAll("\\", "/"),
      status: suite.status,
      message: typeof suite.message === "string" ? suite.message.slice(0, 240) : null,
      tests: (suite.assertionResults ?? []).map((test) => ({ name: test.fullName, status: test.status })),
    }));
    evidence.testInventory = namedTestInventory(vitest, expectedFiles, testManifest.tests);
    evidence.testFailureLocations = (vitest.testResults ?? []).flatMap((suite) =>
      (suite.assertionResults ?? []).filter((test) => test.status === "failed").map((test) => {
        const messages = test.failureMessages ?? [];
        const combined = messages.join("\n");
        const sourceLines = [...new Set(messages.flatMap((message) =>
          [...message.matchAll(/operations-observability-postgres\.gate\.ts:(\d+):\d+/gu)].map((match) => Number(match[1]))))];
        const comparison = combined.match(/expected (-?\d+) to be (-?\d+)/iu);
        const databaseCode = combined.match(/(?:code|SQLSTATE)\s*[:= ]\s*['"]?([0-9A-Z]{5})/iu)?.[1] ?? null;
        const kind = /PostgresInfrastructureError/u.test(combined) ? "postgres-infrastructure-error"
          : /AssertionError/u.test(combined) ? "assertion" : /Error:/u.test(combined) ? "runtime-error" : "unknown";
        return { name: test.fullName, sourceLines, kind,
          ...(comparison ? { numericComparison: { expected: Number(comparison[2]), received: Number(comparison[1]) } } : {}),
          ...(databaseCode ? { databaseCode } : {}) };
      }));
    if (existsSync(planPath)) evidence.queryPlan = JSON.parse(readFileSync(planPath, "utf8"));
    if (evidence.testInventory.some((test) => test.status !== "passed") || vitest.numFailedTests !== 0 ||
        (vitest.numPendingTests ?? 0) !== 0 || (vitest.numTodoTests ?? 0) !== 0 || evidence.testInventory.length === 0) {
      throw fixedFailure("GATE_TEST_STATUS_NOT_GREEN");
    }
    if (testResult.status !== 0 || vitest.success !== true) throw fixedFailure("GATE_VITEST_FAILED");
    if (!evidence.queryPlan) throw fixedFailure("GATE_QUERY_PLAN_EVIDENCE_MISSING");

    stage = "validation-evolution";
    const validationEvolution = command(process.execPath, [path.join(ROOT, "scripts", "run-validation-evolution-tests.mjs")],
      { env: testEnv, timeout: 240_000, allowFailure: true });
    evidence.checks.validationEvolution = { status: validationEvolution.status,
      expectedRegistryTests: REQUIRED_REGRESSION_TESTS,
      expectedCacheTests: REQUIRED_CACHE_TESTS,
      inventoryEnforcedByRunner: true };
    if (validationEvolution.status !== 0) throw fixedFailure("GATE_VALIDATION_EVOLUTION_FAILED");

    stage = "portable-summary-cli";
    const npmExecPath = process.env.npm_execpath;
    if (!npmExecPath) throw fixedFailure("GATE_NPM_CLI_PATH_MISSING");
    const validId = testEnv.OPERATIONS_SUMMARY_PORTFOLIO_ID;
    const valid = runSummaryCli(npmExecPath, testEnv, ["--portfolio-id", validId]);
    const outputLines = valid.stdout.trim().split(/\r?\n/u);
    let summary;
    try { summary = JSON.parse(outputLines.at(-1)); } catch { throw fixedFailure("GATE_CLI_VALID_OUTPUT_INVALID"); }
    const cliOutput = `${valid.stdout}\n${valid.stderr}`;
    const scopeCategory = (value, expected) => value === expected ? "expected" : value === undefined ? "missing" : "unexpected";
    const summaryFields = ["generatedAt", "windowSeconds", "scope", "portfolio", "application", "database", "capacity",
      "outbox", "jobs", "leases", "exports", "publication", "events", "aggregates", "retention", "storage", "backup", "recovery"];
    evidence.cli.validAttempt = {
      status: valid.status,
      parsedJsonKind: summary === null ? "null" : Array.isArray(summary) ? "array" : typeof summary,
      rootObjectKeys: summary !== null && typeof summary === "object" && !Array.isArray(summary)
        ? Object.keys(summary).map((key) => /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(key) ? key : "redacted-key").sort() : [],
      recognizedSummaryFields: summaryFields.filter((field) => Object.hasOwn(summary ?? {}, field)),
      hasResultEnvelope: Object.hasOwn(summary ?? {}, "ok") || Object.hasOwn(summary ?? {}, "value") || Object.hasOwn(summary ?? {}, "error"),
      hasPortfolioObject: summary?.portfolio !== null && typeof summary?.portfolio === "object",
      hasScopeObject: summary?.scope !== null && typeof summary?.scope === "object",
      portfolioScopeMatches: summary?.portfolio?.scope === "one-authorized-portfolio",
      queueScopeMatches: summary?.scope?.queues === "system-wide-operations",
      runtimeObservationScopeMatches: summary?.scope?.runtimeObservations === "system-wide-restricted-operator-log-source",
      integrityFailuresRemainUnknownWithoutReader: summary?.exports?.integrityFailures?.state === "unknown" &&
        summary?.exports?.integrityFailures?.reason === "producer-not-installed",
      portfolioScopeCategory: scopeCategory(summary?.portfolio?.scope, "one-authorized-portfolio"),
      queueScopeCategory: scopeCategory(summary?.scope?.queues, "system-wide-operations"),
      summaryContainsPortfolioId: JSON.stringify(summary).includes(validId),
      outputContainsWorkerDatabaseUrl: cliOutput.includes(workerUrl),
      outputLineCount: outputLines.length,
    };
    if (valid.status !== 0 || !evidence.cli.validAttempt.portfolioScopeMatches ||
        !evidence.cli.validAttempt.queueScopeMatches || !evidence.cli.validAttempt.runtimeObservationScopeMatches ||
        !evidence.cli.validAttempt.integrityFailuresRemainUnknownWithoutReader || evidence.cli.validAttempt.summaryContainsPortfolioId ||
        evidence.cli.validAttempt.outputContainsWorkerDatabaseUrl) throw fixedFailure("GATE_CLI_VALID_SCOPE_OR_PRIVACY_INVALID");
    evidence.cli.valid = { status: valid.status, summaryPortfolioScope: summary.portfolio.scope, queueScope: summary.scope.queues,
      runtimeObservationScope: summary.scope.runtimeObservations, integrityFailuresRemainUnknownWithoutReader: true,
      outputContainsPortfolioId: false, outputContainsDatabaseUrl: false };
    const forbidden = [validId, workerUrl, applicationUrl];
    const rejected = [
      assertSafeCliFailure(runSummaryCli(npmExecPath, testEnv, []), "OPERATIONS_SUMMARY_ARGUMENTS_INVALID", forbidden),
      assertSafeCliFailure(runSummaryCli(npmExecPath, testEnv, ["--portfolio-id", "malformed"]), "OPERATIONS_SUMMARY_ARGUMENTS_INVALID", forbidden),
      assertSafeCliFailure(runSummaryCli(npmExecPath, testEnv, ["--portfolio-id", `${validId}${"x".repeat(65)}`]), "OPERATIONS_SUMMARY_ARGUMENTS_INVALID", forbidden),
      assertSafeCliFailure(runSummaryCli(npmExecPath, { ...testEnv, OPERATIONS_SUMMARY_PORTFOLIO_ID: "0196a1b2-7c3d-7e11-9f22-000000000002" },
        ["--portfolio-id", validId]), "OPERATIONS_SUMMARY_ARGUMENTS_INVALID", forbidden),
      assertSafeCliFailure(runSummaryCli(npmExecPath, testEnv, ["--portfolio-id", validId, "--unknown"]), "OPERATIONS_SUMMARY_ARGUMENTS_INVALID", forbidden),
    ];
    evidence.cli.rejectedInputs = rejected;
    stage = "evidence-finalization";
    await databaseUrl(upgradeClient, "operations_summary_upgrade");
    evidence.volumes.clusterBytesBeforeCleanup = await directoryBytes(dataRoot);
    evidence.volumes.clusterBytesAfterCleanup = null;

    const sourceAfter = workingTreeSourceSha256();
    evidence.repository.sourceTreeSha256After = sourceAfter;
    if (sourceAfter !== sourceBefore) throw fixedFailure("GATE_SOURCE_TREE_CHANGED_DURING_RUN");
    evidence.result = "passed";
  } catch (error) {
    failureCode = safeGateFailure(error);
    evidence.failureStage = stage;
    evidence.failureDiagnostic = failureCode;
    if (stage === "postgres-start") evidence.startup.commandOutcome = "command-failed";
  } finally {
    try { if (upgradeClient) await upgradeClient.end(); } catch { cleanupSucceeded = false; }
    try { if (freshClient) await freshClient.end(); } catch { cleanupSucceeded = false; }
    try { if (predecessorClient) await predecessorClient.end(); } catch { cleanupSucceeded = false; }
    try { if (client) await client.end(); } catch { cleanupSucceeded = false; }
    if (runRootCreated) {
      let persistedOwner;
      try { persistedOwner = JSON.parse(readFileSync(ownerPath, "utf8")); } catch { persistedOwner = undefined; }
      const cleanup = await cleanupOwnedOperationsRun({
        runRoot, tempBase, dataRoot, runId, platform, ownerRecord: persistedOwner, startupAttempted,
        inspect: () => inspectPostgresOwner(dataRoot, platform, tempEnv),
        stop: () => {
          if (!pgBin) throw fixedFailure("GATE_POSTGRES_STOP_BINARY_UNAVAILABLE");
          const result = command(pgExecutable(pgBin, "pg_ctl"), ["-D", dataRoot, "-m", "fast", "-w", "stop"],
            { env: tempEnv, timeout: 30_000, allowFailure: true, stdio: "ignore" });
          evidence.cleanupDiagnostics.stopCommandOutcome = result.status === 0 ? "exited-successfully" : "exited-failed";
        },
        remove: () => rmSync(runRoot, { recursive: true, force: false }),
      });
      cleanupSucceeded = cleanup.ok;
      evidence.cleanupDiagnostics = { stage: cleanup.stage, stopAttempted: cleanup.stopAttempted,
        stopCommandOutcome: evidence.cleanupDiagnostics.stopCommandOutcome ?? "not-run" };
    } else {
      evidence.cleanupDiagnostics = { stage: "run-root-not-created", stopAttempted: false, stopCommandOutcome: "not-run" };
    }
  }

  evidence.volumes.clusterBytesAfterCleanup = cleanupSucceeded && runRootCreated ? 0 : null;

  evidence.completedAt = new Date().toISOString();
  evidence.cleanup = cleanupSucceeded ? "passed" : "failed";
  if (failureCode === null && evidence.result === "passed" && evidence.cleanup === "passed") {
    try {
      evidence.acceptanceEvidenceResolved = resolveAcceptanceEvidence(OPERATIONS_ACCEPTANCE_EVIDENCE_PLAN, evidence);
    } catch {
      failureCode = "GATE_ACCEPTANCE_EVIDENCE_UNRESOLVED";
      evidence.failureStage = "acceptance-evidence-resolution";
      evidence.failureDiagnostic = failureCode;
    }
  }
  if (!cleanupSucceeded) {
    failureCode ??= "GATE_CLEANUP_FAILED";
    evidence.failureStage ??= "cleanup";
    evidence.failureDiagnostic ??= "GATE_CLEANUP_FAILED";
  }
  try {
    evidence.repository.sourceTreeSha256After = workingTreeSourceSha256();
    if (evidence.repository.sourceTreeSha256After !== sourceBefore) failureCode ??= "GATE_SOURCE_TREE_CHANGED_DURING_RUN";
    mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
    evidence.failureCode = failureCode;
    if (failureCode !== null && evidence.failureStage === null) evidence.failureStage = stage;
    evidence.result = failureCode === null && cleanupSucceeded ? "passed" : "failed";
    writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  } catch {
    failureCode ??= "GATE_EVIDENCE_WRITE_FAILED";
  }
  if (failureCode !== null) {
    process.stderr.write(`${failureCode}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`${JSON.stringify({ result: "passed", runId, testCounts: evidence.testCounts,
    migrationCount: evidence.migrations.length, cleanup: evidence.cleanup, evidence: "evidence/phase8-operations-observability-251.json" })}\n`);
}

if (isDirectRun) await runGate();
