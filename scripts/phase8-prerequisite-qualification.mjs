#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";
import { migrationSha256 } from "./migration-checksum.mjs";
import { REQUIRED_PHASE3_CHECK_NAMES } from "./phase3-gate-support.mjs";
import { REQUIRED_PHASE4_CHECK_NAMES } from "./phase4-gate-support.mjs";
import { REQUIRED_PHASE5_GATE_CHECKS } from "./phase5-gate-support.mjs";
import { PHASE6_GATE_REQUIRED_CHECKS, PHASE6_GATE_ACCEPTANCE_MATRIX, PHASE6_GATE_STORY_MATRIX,
  PHASE6_GATE_MANDATORY_MATRICES, PHASE6_GATE_COMPONENTS } from "./phase6-gate-support.mjs";
import { PHASE7_GATE_REQUIRED_CHECKS, PHASE7_GATE_CRITERION_MATRIX, PHASE7_GATE_SCENARIOS,
  PHASE7_GATE_COMPONENTS } from "./phase7-gate-support.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PHASE8_PREREQUISITES = Object.freeze([
  { phase: 3, ticket: 55, path: "evidence/phase-3-gate-report.json" },
  { phase: 4, ticket: 90, path: "evidence/phase-4-gate-report.json" },
  { phase: 5, ticket: 125, path: "evidence/phase-5-gate-report.json" },
  { phase: 6, ticket: 164, path: "evidence/phase6-gate-report.json" },
  { phase: 7, ticket: 209, path: "evidence/phase7-gate-report.json" },
]);
export const MAX_EVIDENCE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const REQUIRED_TOOL_VERSIONS = Object.freeze({ node: "24.21.0", npm: "11.19.0" });
export const PHASE8_REQUIRED_CHECKS = Object.freeze({
  3: REQUIRED_PHASE3_CHECK_NAMES, 4: REQUIRED_PHASE4_CHECK_NAMES, 5: REQUIRED_PHASE5_GATE_CHECKS,
  6: PHASE6_GATE_REQUIRED_CHECKS, 7: PHASE7_GATE_REQUIRED_CHECKS,
});
const sourceMetadataCache = new Map();

const validSha = (value, length) => typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`, "iu").test(value);
const parseJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
const positive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

export function sourceMetadataAtRevision(root, revision) {
  if (!validSha(revision, 40)) throw new TypeError("Expected an immutable Git commit SHA.");
  const cacheKey = `${root}\0${revision}`;
  if (sourceMetadataCache.has(cacheKey)) return sourceMetadataCache.get(cacheKey);
  // Inspect immutable objects without creating a checkout or writing .git.
  // --filters plus GIT_ATTR_SOURCE reproduces the revision's checkout bytes,
  // including historical attributes and Windows CRLF rules, for v1 hashes.
  const options = { cwd: root, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_ATTR_SOURCE: revision } };
  const entries = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", revision, "--"],
    { ...options, encoding: "utf8" }).split("\0").filter(Boolean).map((entry) => {
    const match = /^(\d+) (\w+) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(entry);
    if (!match || match[2] !== "blob") throw new Error("Unsupported immutable source entry.");
    return { mode: match[1], oid: match[3], path: match[4] };
  }).filter(({ path }) => !path.startsWith("evidence/")).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const digest = createHash("sha256").update("portfolio-source-files-v1\0");
  const migrations = [];
  for (const { path, mode, oid } of entries) {
    // Batch headers report the unfiltered size, which cannot delimit binary
    // filtered content safely. Read each blob as an opaque byte buffer.
    const content = execFileSync("git", mode === "120000"
      ? ["cat-file", "blob", oid] : ["cat-file", "--filters", `--path=${path}`, oid], options);
    const sha256 = createHash("sha256").update(content).digest("hex");
    digest.update(JSON.stringify([path, mode === "120000" ? "symlink" : "file", sha256])).update("\0");
    if (/^supabase\/migrations\/[^/]+\.sql$/iu.test(path)) migrations.push({ name: path.slice("supabase/migrations/".length), sha256: migrationSha256(content.toString("utf8")) });
  }
  const metadata = Object.freeze({ sourceTreeSha256: digest.digest("hex"), migrations: Object.freeze(migrations) });
  sourceMetadataCache.set(cacheKey, metadata);
  return metadata;
}

function versionsMatch(tools) {
  if (!tools || typeof tools !== "object") return false;
  const node = String(tools.node ?? "").replace(/^v/u, "");
  const npm = String(tools.npm ?? "");
  return node === REQUIRED_TOOL_VERSIONS.node && npm === REQUIRED_TOOL_VERSIONS.npm;
}

function migrationsComplete(migrations, inventory) {
  if (!Array.isArray(inventory) || inventory.length === 0 || migrations.length !== inventory.length) return false;
  const actual = new Map();
  for (const migration of migrations) {
    const name = migration?.name ?? migration?.file;
    if (typeof name !== "string" || name.trim().length === 0 || !validSha(migration?.sha256, 64) || actual.has(name)) return false;
    actual.set(name, migration.sha256);
  }
  return inventory.every((migration) => actual.get(migration.name) === migration.sha256);
}

function summarizeRealServiceScope(phase, scope, parent) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  const services = scope.services ?? {};
  const postgresMajor = services.postgres?.majorVersion;
  const postgresVersion = typeof scope.postgresVersion === "string" ? scope.postgresVersion :
    typeof scope.version === "string" && /postgres/iu.test(String(scope.service ?? scope.engine ?? "")) ? `${scope.service ?? scope.engine} ${scope.version}` :
      positive(postgresMajor) ? `PostgreSQL ${postgresMajor}` : null;
  if (!postgresVersion || !/postgres(?:ql)?/iu.test(postgresVersion) || !/\d+(?:\.\d+)?/u.test(postgresVersion)) return null;
  const isolationValues = new Set(["isolated", "isolated-loopback", "loopback-only", "disposable", "disposable-loopback"]);
  const isolationValuesRecorded = [scope.isolation, scope.scope].some((value) =>
    typeof value === "string" && isolationValues.has(value.trim().toLowerCase().replaceAll("_", "-")));
  const principalScopeText = JSON.stringify(scope.principalScope ?? {}).toLowerCase();
  const explicitIsolation = isolationValuesRecorded || /disposable loopback|loopback supabase|private local storage/u.test(principalScopeText);
  const namedChecks = Array.isArray(scope.checks) ? scope.checks : Array.isArray(scope.criteria) ? scope.criteria : [];
  const namedExecutedChecks = namedChecks.length > 0 && namedChecks.every((check) =>
    typeof (check?.name ?? check?.command ?? check?.id) === "string" &&
    (check.name ?? check.command ?? check.id).trim().length > 0 &&
    (check.passed === true || (check.executed === true && check.status === "passed") ||
      (Array.isArray(check.cases) && check.cases.length > 0 && check.cases.every((item) => item?.executed === true && item?.status === "passed"))) &&
    check.executed !== false);
  const provenance = typeof scope.runId === "string" && scope.runId.length >= 8 && validSha(scope.sourceRevision, 40) &&
    validSha(scope.sourceTreeSha256, 64) && scope.sourceRevision === parent.sourceRevision &&
    scope.sourceTreeSha256 === parent.sourceTreeSha256 && Number.isFinite(Date.parse(scope.startedAt ?? "")) &&
    Number.isFinite(Date.parse(scope.completedAt ?? "")) &&
    (scope.cleanup === true || scope.cleanup?.success === true);
  const restrictedMatrix = scope.restrictedAccess?.matrix;
  const grantees = Array.isArray(restrictedMatrix) ? restrictedMatrix.map((row) => row?.grantee) : [];
  const requiredGrantees = phase === 7 ? ["anon", "authenticated", "service_role"] : [];
  const restrictedMatrixValid = Array.isArray(restrictedMatrix) && restrictedMatrix.length >= 2 &&
    grantees.every((grantee) => typeof grantee === "string" && grantee.trim().length > 0) &&
    new Set(grantees).size === grantees.length && requiredGrantees.every((grantee) => grantees.includes(grantee)) && restrictedMatrix.every((row) => {
    if (typeof row?.grantee !== "string" || row.grantee.trim().length === 0 || !row.schemaPrivileges ||
      typeof row.schemaPrivileges !== "object" || Array.isArray(row.schemaPrivileges) || Object.keys(row.schemaPrivileges).length === 0) return false;
    const schemaPrivilegesComplete = Object.values(row.schemaPrivileges).every((privileges) =>
      typeof privileges?.usage === "boolean" && typeof privileges?.create === "boolean");
    let tablePrivileges = row.tablePrivileges;
    if (typeof tablePrivileges === "string") {
      try { tablePrivileges = JSON.parse(tablePrivileges); } catch { return false; }
    }
    const tablePrivilegesComplete = Boolean(tablePrivileges) && typeof tablePrivileges === "object" && !Array.isArray(tablePrivileges);
    const phaseSevenDeniesPrivateAccess = phase !== 7 ||
      (Object.values(row.schemaPrivileges).every((privileges) => privileges.usage === false && privileges.create === false) &&
        Object.keys(tablePrivileges ?? {}).length === 0);
    return schemaPrivilegesComplete && tablePrivilegesComplete && phaseSevenDeniesPrivateAccess;
  });
  const restrictedMatrixComplete = restrictedMatrix === undefined || restrictedMatrix === null
    ? phase !== 7
    : restrictedMatrixValid;
  const postgres = services.postgres;
  const postgresProven = (postgres?.available === true &&
    (Number(postgres.executionCount ?? 0) > 0 || Number(postgres.independentConnections ?? 0) >= 2)) ||
    (phase === 7 && typeof scope.postgresVersion === "string");
  const authRequired = phase === 4 || phase === 6;
  const authProven = !authRequired || (services.auth?.available === true && Number(services.auth.executionCount ?? 0) > 0);
  const storageRequired = phase === 6;
  const storageProven = !storageRequired || (services.storage?.available === true && services.storage.privateBucketVerified === true &&
    Number(services.storage.executionCount ?? 0) > 0);
  const serviceChecks = (scope.required?.success === true || (scope.verdict === "pass" && scope.counts?.failed === 0 && scope.counts?.skipped === 0)) &&
    (scope.cleanUpgrade?.equivalent === true || scope.cleanUpgradeEquivalent === true || phase === 6) &&
    postgresProven && authProven && storageProven && restrictedMatrixComplete && namedExecutedChecks;
  return explicitIsolation && provenance && serviceChecks
    ? { service: "PostgreSQL", version: postgresVersion, scope: "isolated", services: {
      postgres: true, auth: authProven, storage: storageProven,
    }, runId: scope.runId, serviceChecksRecorded: true } : null;
}

function sameInventory(rows, expected) {
  if (!Array.isArray(rows) || rows.length !== expected.length || new Set(rows.map((row) => row?.id)).size !== expected.length) return false;
  const byId = new Map(rows.map((row) => [row?.id, row]));
  return expected.every((item) => {
    const row = byId.get(item.id);
    return row && Object.entries(item).every(([field, value]) => Array.isArray(value)
      ? Array.isArray(row[field]) && row[field].length === value.length && new Set(row[field]).size === value.length &&
        value.every((entry) => row[field].includes(entry))
      : row[field] === value);
  });
}

function componentExecutionComplete(phase, component) {
  const counts = phase === 6 ? component.counts : component.required;
  const executed = phase === 6 ? counts?.executed : counts?.passed;
  return Number.isSafeInteger(executed) && executed > 0 && counts.failed === 0 && counts.skipped === 0 &&
    (phase === 6 || counts.success === true && (counts.failedSuites === 0 || counts.failedSuites === null));
}

function phaseCoverageComplete(phase, report, checks) {
  if (phase !== 6 && phase !== 7) return true;
  const counts = report?.counts;
  const components = phase === 6 ? report?.evidenceArtifacts : report?.components;
  const expectedComponents = phase === 6 ? PHASE6_GATE_COMPONENTS : PHASE7_GATE_COMPONENTS;
  if (!sameInventory(components, expectedComponents.map(({ id, path }) => ({ id, path }))) ||
      components.some((component) => component.accepted !== true || !componentExecutionComplete(phase, component) ||
        typeof component.runId !== "string" || component.runId.length < 8 ||
        !validSha(component.sha256, 64) || component.sourceRevision !== report?.sourceRevision ||
        component.sourceTreeSha256 !== report?.sourceTreeSha256 || component.cleanup !== true ||
        component.fresh !== true || component.sourceBound !== true || (phase === 6
          ? !Number.isFinite(Date.parse(component.startedAt ?? ""))
          : component.gateRunId !== report?.runId || component.positiveExecution !== true || component.aggregateSuccess !== true))) return false;
  const artifacts = new Map(components.map((component) => [component.id, component]));
  const commands = new Map(checks.map((check) => [check?.name, check]));
  const commandPassed = (id) => commands.get(id)?.passed === true && commands.get(id)?.executed !== false;
  if (phase === 6) {
    const coverage = report?.coverage;
    return counts?.checks === PHASE6_GATE_REQUIRED_CHECKS.length && counts?.checksPassed === PHASE6_GATE_REQUIRED_CHECKS.length &&
      counts?.acceptanceCriteria === PHASE6_GATE_ACCEPTANCE_MATRIX.length &&
      counts?.userStories === PHASE6_GATE_STORY_MATRIX.length && counts?.matrices === PHASE6_GATE_MANDATORY_MATRICES.length &&
      counts?.evidenceReports === expectedComponents.length &&
      sameInventory(coverage?.acceptanceCriteria, PHASE6_GATE_ACCEPTANCE_MATRIX) &&
      sameInventory(coverage?.userStories, PHASE6_GATE_STORY_MATRIX) &&
      sameInventory(coverage?.mandatoryMatrices, PHASE6_GATE_MANDATORY_MATRICES) &&
      coverage.acceptanceCriteria.every((criterion) => criterion.suites.every((id) => artifacts.get(id)?.accepted === true) &&
        criterion.checks.every(commandPassed)) &&
      coverage.mandatoryMatrices.every((matrix) => {
        const scenarios = artifacts.get(matrix.component)?.evidenceBinding?.scenarioEvidence;
        if (!matrix.requiredScenarioIds?.length) return true;
        if (!Array.isArray(scenarios) || new Set(scenarios.map((scenario) => scenario?.id)).size !== scenarios.length) return false;
        return matrix.requiredScenarioIds.every((id) => scenarios.some((scenario) =>
          scenario?.id === id && scenario.executed === true && scenario.status === "passed"));
      });
  }
  if (counts?.criterionCount !== PHASE7_GATE_CRITERION_MATRIX.length || counts?.executedCriteria !== PHASE7_GATE_CRITERION_MATRIX.length ||
      counts?.scenarioCount !== PHASE7_GATE_SCENARIOS.length || counts?.components !== expectedComponents.length ||
      counts?.acceptedComponents !== expectedComponents.length || !sameInventory(report?.criteria, PHASE7_GATE_CRITERION_MATRIX) ||
      !sameInventory(report?.scenarios, PHASE7_GATE_SCENARIOS)) return false;
  return report.criteria.every((criterion) => Array.isArray(criterion.evidence) && criterion.evidence.length === criterion.suites.length &&
    criterion.suites.every((id, index) => {
      const artifact = artifacts.get(id);
      const runId = artifact?.runId ?? commands.get(id)?.runId;
      return (artifact?.accepted === true || commandPassed(id)) && typeof runId === "string" && runId.length >= 8 &&
        criterion.evidence[index] === runId;
    })) && report.scenarios.every((scenario) => scenario.executed === true &&
      scenario.suites.every((id) => artifacts.get(id)?.accepted === true));
}

function phase6AggregateServiceScope(report) {
  const artifacts = Array.isArray(report?.evidenceArtifacts) ? report.evidenceArtifacts : [];
  const migration = artifacts.find((artifact) => artifact?.id === "migration-access");
  const integration = artifacts.find((artifact) => artifact?.id === "media-cv-integration");
  const summary = report?.evidenceSummary;
  if (report?.ticket !== 164 || report.schemaVersion !== 1 || migration?.accepted !== true || integration?.accepted !== true ||
      !summary?.migrationAccess || !summary?.realServiceAndAdapterProof ||
      !isDeepStrictEqual(summary.migrationAccess, migration.evidenceBinding) ||
      !isDeepStrictEqual(summary.realServiceAndAdapterProof, integration.evidenceBinding) ||
      summary.migrationAccess.migrationSetEquivalent !== true) return null;
  const principalScope = summary.realServiceAndAdapterProof.principalScope;
  const services = report.services;
  const checks = Array.isArray(report.checks) ? report.checks : [];
  const realAdapters = services?.scanner?.available === true && positive(services.scanner.executions) &&
    typeof services.scanner.version === "string" && services.scanner.version.length > 0 &&
    ["pdf", "image", "video"].every((kind) => services?.processors?.[kind]?.available === true &&
      positive(services.processors[kind].executions) && typeof services.processors[kind].version === "string" &&
      services.processors[kind].version.length > 0);
  const scopeRecorded = [["database", "shipwithali_application"], ["auth", "loopback Supabase Auth"],
    ["storage", "private local Storage"]].every(([field, marker]) =>
    typeof principalScope?.[field] === "string" && principalScope[field].includes(marker));
  const formatProof = sameInventory(report.formats, ["pdf", "png", "jpeg", "webp", "mp4", "webm"]
    .map((id) => ({ id, executed: true, status: "passed" })));
  const success = report.verdict === "pass" && report.failureCount === 0 && Array.isArray(report.failures) && report.failures.length === 0 &&
    phaseCoverageComplete(6, report, checks) && checks.every((check) => check?.executed === true && check.passed === true &&
      check.exitCode === 0 && check.skipped === 0 && check.timedOut !== true) &&
    positive(services?.postgres?.executionCount) && Number(services?.postgres?.independentConnections) >= 2 &&
    report.cleanup?.attempted === true && realAdapters && scopeRecorded && formatProof;
  return { runId: report.runId, sourceRevision: report.sourceRevision, sourceTreeSha256: report.sourceTreeSha256,
    startedAt: report.startedAt, completedAt: report.completedAt, services, principalScope, checks,
    cleanup: report.cleanup, cleanUpgradeEquivalent: summary.migrationAccess.migrationSetEquivalent,
    required: { success } };
}

function normalize(phase, report) {
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const required = report?.required ?? report?.counts ?? {};
  const sourceRevision = report?.sourceRevision ?? report?.revision ?? null;
  const sourceTreeSha256 = report?.sourceTreeSha256 ?? null;
  const runId = report?.runId ?? checks.find((check) => check?.runId)?.runId ?? null;
  const executed = Number(required?.executed ?? required?.passed ?? report?.coverage?.executed ??
    checks.filter((check) => check?.executed === true || check?.passed === true).length ?? 0);
  const failed = Math.max(Number(required?.failed ?? report?.failureCount ?? 0),
    checks.filter((check) => check?.passed === false || check?.executed === false).length);
  const skipped = Math.max(Number(required?.skipped ?? required?.requiredSkipped ?? report?.skipped ?? 0),
    checks.reduce((total, check) => total + Number(check?.skipped ?? 0), 0));
  const aggregateFailed = report?.verdict === "fail" || required?.success === false || failed > 0;
  const aggregateSuccess = report?.verdict === "pass" && required?.success !== false && failed === 0 && skipped === 0;
  const componentCleanupFailed = Array.isArray(report?.components) && report.components.some((item) => item?.cleanup === false);
  const cleanup = !componentCleanupFailed && (typeof report?.cleanup === "boolean" ? report.cleanup : report?.cleanup?.success === true ||
    report?.guarantees?.successfulCleanup === true ||
    (phase === 7 && Array.isArray(report?.components) && report.components.length > 0 && report.components.every((item) => item.cleanup === true)));
  const generatedAt = report?.completedAt ?? report?.generatedAt ?? report?.startedAt ?? null;
  const migrations = report?.migrations ?? report?.migrationChecksums ?? report?.coverage?.database?.migrationIdsAndChecksums ??
    report?.databaseProof?.migrations ?? report?.serviceEvidence?.migrations ?? report?.evidenceSummary?.database?.migrationChecksums ??
    (phase === 6 ? report?.evidenceSummary?.migrationAccess?.migrationChecksums : null) ?? report?.migrationLedger ?? [];
  const tools = report?.toolVersions ?? report?.tools ?? report?.runtime ?? report?.expectedToolVersions ?? report?.serviceEvidence?.tools ??
    (report?.node ? { node: report.node, npm: report.npm ?? null } : null);
  const realServiceScope = report?.realServiceScope ?? report?.serviceEvidence ?? report?.databaseProof ??
    report?.reproduction?.services ?? (phase === 6 ? phase6AggregateServiceScope(report) : null);
  const counts = report?.counts ?? report?.coverage ?? {};
  const checksEstablishDenominator = checks.length > 0 && checks.every((check) =>
    typeof (check?.name ?? check?.id ?? check?.artifact) === "string" &&
    (check.name ?? check.id ?? check.artifact).trim().length > 0 &&
    (typeof check.executed === "boolean" || typeof check.passed === "boolean"));
  // Gate command coverage comes from the owning gate's manifest. Phase 5's
  // counts.total counts assertions, so it cannot serve as a command inventory.
  const requiredNames = PHASE8_REQUIRED_CHECKS[phase];
  const expectedExecuted = requiredNames.length;
  const names = checks.map((check) => check?.name ?? check?.id ?? check?.artifact);
  const commandCoverageComplete = checksEstablishDenominator && names.length === expectedExecuted &&
    new Set(names).size === expectedExecuted && requiredNames.every((name) => names.includes(name));
  const assertionCoverageComplete = phase !== 5 || positive(counts.total) && Number(counts.executed ?? required.executed) === Number(counts.total);
  const namedExecuted = checks.filter((check) => check?.passed === true && check?.executed !== false &&
    typeof (check?.name ?? check?.id ?? check?.artifact) === "string" &&
    (check.name ?? check.id ?? check.artifact).trim().length > 0).length;
  const coverageComplete = commandCoverageComplete && assertionCoverageComplete && phaseCoverageComplete(phase, report, checks) &&
    (counts?.criterionCount == null || Number(counts?.executedCriteria) === Number(counts?.criterionCount)) &&
    positive(expectedExecuted) && (phase === 5 ? executed >= expectedExecuted : executed === expectedExecuted) && namedExecuted >= expectedExecuted;
  return { sourceRevision, sourceTreeSha256, runId, generatedAt, executed, failed, skipped, expectedExecuted, namedExecuted,
    aggregateFailed, aggregateSuccess, coverageComplete, cleanup,
    cleanupFailed: report?.cleanup === false || report?.cleanup?.success === false || report?.guarantees?.successfulCleanup === false || componentCleanupFailed,
    migrations: Array.isArray(migrations) ? migrations : [], tools,
    realServiceScope, required: { success: required?.success ?? (report?.verdict === "pass" ? true : null), executed, failed, skipped } };
}

function sourceBindingState(report, details) {
  const checks = Array.isArray(report?.checks) ? report.checks : [];
  const evidenceArtifacts = Array.isArray(report?.evidenceArtifacts) ? report.evidenceArtifacts : [];
  const components = Array.isArray(report?.components) ? report.components : [];
  const boundItems = [...checks, ...evidenceArtifacts, ...components,
    report?.realServiceScope, report?.serviceEvidence]
    .filter((item) => item && typeof item === "object" &&
      ("sourceRevision" in item || "sourceTreeSha256" in item || "gateRunId" in item));
  const itemsMatch = boundItems.every((item) => (!item.sourceRevision || item.sourceRevision === details.sourceRevision) &&
    (!item.sourceTreeSha256 || item.sourceTreeSha256 === details.sourceTreeSha256) &&
    (!item.gateRunId || item.gateRunId === details.runId)) &&
    checks.every((item) => !item?.runId || item.runId === details.runId);
  const gateProvesBinding = report?.guarantees?.evidenceBoundToSourceTreeAndRun === true ||
    report?.guarantees?.sourceBound === true || report?.sourceBindingVerified === true;
  if (!itemsMatch) return "mismatched";
  return gateProvesBinding ? "verified" : "unverified";
}

function failedCheckNames(report) {
  if (!Array.isArray(report?.checks)) return [];
  return [...new Set(report.checks
    .filter((check) => check && typeof check === "object" && (check.passed === false || typeof check.failure === "string"))
    .map((check) => check.name ?? check.id)
    .filter((name) => typeof name === "string" && /^[a-z0-9][a-z0-9._-]{0,79}$/iu.test(name)))].sort();
}

function predecessorAction(phase, reasons) {
  if (reasons.every((reason) => ["source-tree-mismatch", "evidence-stale"].includes(reason))) {
    const ticket = PHASE8_PREREQUISITES.find((item) => item.phase === phase).ticket;
    return `Phase ${phase} (#${ticket}) evidence needs refreshing. Commit the final source, then run npm run phase8:qualify to regenerate Phases 3–7 evidence and evaluate the same source tree.`;
  }
  const actions = {
    3: "In predecessor #55, resolve the Phase 3 migration and isolated database failures, then rerun npm run phase3:gate and publish complete source-bound evidence with successful cleanup.",
    4: "In predecessor #90, resolve the named Phase 4 and prerequisite gate failures, restore isolated PostgreSQL/Auth execution, then rerun npm run phase4:gate and publish complete source-bound evidence with successful cleanup.",
    5: "In predecessor #125, restore isolated PostgreSQL execution, rerun npm run phase5:gate until the Owner, RLS, and integrated checks pass, then publish complete migration, service-scope, and cleanup evidence.",
    6: "In predecessor #164, restore isolated PostgreSQL and Storage execution, rerun npm run phase6:gate until every required check passes, then publish complete service-scope and cleanup evidence.",
    7: "In predecessor #209, resolve the named Phase 7 gate failures, rerun npm run phase7:gate, and publish complete source-bound evidence with zero skips and successful cleanup.",
  };
  return actions[phase];
}

export function evaluatePhase8Prerequisites({ root, sourceRevision, sourceTreeSha256, now = Date.now(),
  maxAgeMs = MAX_EVIDENCE_AGE_MS,
  resolveSourceTree = (revision) => sourceMetadataAtRevision(root, revision).sourceTreeSha256,
  resolveMigrationInventory = (revision) => sourceMetadataAtRevision(root, revision).migrations,
  isAncestor = (revision) => {
    try { execFileSync("git", ["merge-base", "--is-ancestor", revision, sourceRevision], { cwd: root, stdio: "ignore" }); return true; }
    catch { return false; }
  } }) {
  const phases = PHASE8_PREREQUISITES.map(({ phase, ticket, path }) => {
    const absolutePath = join(root, path);
    const report = existsSync(absolutePath) ? parseJson(absolutePath) : null;
    const details = normalize(phase, report);
    const failedChecks = failedCheckNames(report);
    const reasons = [];
    let sha256 = null;
    const binding = report ? sourceBindingState(report, details) : "unverified";
    let sourceTreeVerified = false;
    if (report && ["checks", "evidenceArtifacts", "components"].some((key) => report[key] != null && !Array.isArray(report[key]))) {
      reasons.push("evidence-structure-invalid");
    }
    let migrationInventory = null;
    if (report) sha256 = createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
    else reasons.push("evidence-report-absent");
    if (report && (!validSha(details.sourceRevision, 40) || !validSha(details.sourceTreeSha256, 64))) reasons.push("source-identity-missing-or-invalid");
    if (validSha(details.sourceRevision, 40) && !isAncestor(details.sourceRevision)) reasons.push("source-revision-not-in-evaluated-history");
    if (validSha(details.sourceTreeSha256, 64) && details.sourceTreeSha256 !== sourceTreeSha256) reasons.push("source-tree-mismatch");
    if (report && validSha(details.sourceRevision, 40) && validSha(details.sourceTreeSha256, 64)) {
      try {
        sourceTreeVerified = resolveSourceTree(details.sourceRevision) === details.sourceTreeSha256;
        if (!sourceTreeVerified) reasons.push("source-tree-fingerprint-mismatch");
      }
      catch { reasons.push("source-tree-fingerprint-unverified"); }
      try { migrationInventory = resolveMigrationInventory(details.sourceRevision); }
      catch { reasons.push("migration-inventory-unverified"); }
    }
    if (report && binding === "mismatched") reasons.push("source-binding-mismatch");
    else if (report && binding === "unverified") reasons.push("source-binding-unverified");
    if (typeof details.runId !== "string" || details.runId.length < 8) reasons.push("run-identity-missing-or-invalid");
    const generated = Date.parse(details.generatedAt ?? "");
    if (!Number.isFinite(generated)) reasons.push("evidence-time-missing-or-invalid");
    else if (generated > now || now - generated > maxAgeMs) reasons.push("evidence-stale");
    if (details.aggregateFailed) reasons.push("aggregate-failed");
    else if (!details.aggregateSuccess) reasons.push("aggregate-success-unproven");
    if (!positive(details.executed)) reasons.push("executed-coverage-missing");
    if (!details.coverageComplete) reasons.push("executed-coverage-partial");
    if (details.failed !== 0) reasons.push("required-failures-present");
    if (details.skipped !== 0) reasons.push("required-skips-present");
    if (details.cleanupFailed) reasons.push("cleanup-failed");
    else if (!details.cleanup) reasons.push("cleanup-unverified");
    if (!details.tools) reasons.push("tool-version-evidence-unavailable");
    else if (!versionsMatch(details.tools)) reasons.push("tool-version-mismatch");
    if (!details.migrations.length) reasons.push("migration-checksum-evidence-unavailable");
    else if (!migrationsComplete(details.migrations, migrationInventory)) reasons.push("migration-checksum-incomplete-or-invalid");
    const serviceScope = summarizeRealServiceScope(phase, details.realServiceScope, details);
    if (!serviceScope) reasons.push("real-service-scope-unverified");
    return Object.freeze({ phase, ticket, path, sha256, evidencePresent: Boolean(report), sourceTreeVerified,
      aggregateSuccess: details.aggregateSuccess, sourceRevision: details.sourceRevision,
      sourceTreeSha256: details.sourceTreeSha256, runId: details.runId, generatedAt: details.generatedAt,
      required: details.required, failedChecks, nextAction: reasons.length ? predecessorAction(phase, reasons) : null,
      migrations: details.migrations.map((migration) => ({
        name: migration?.name ?? migration?.file ?? null, sha256: migration?.sha256 ?? null,
      })), toolVersions: details.tools, realServiceScope: serviceScope, sourceBinding: binding,
      cleanup: details.cleanup, reasons, accepted: reasons.length === 0 });
  });
  const failed = phases.filter((phase) => !phase.accepted);
  return Object.freeze({ schemaVersion: 1, ticket: 234, evaluatedAt: new Date(now).toISOString(),
    evaluator: { sourceRevision, sourceTreeSha256, runtime: { node: process.versions.node,
      npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? null } },
    verdict: failed.length === 0 ? "pass" : "blocked", mergeEligible: failed.length === 0,
    acceptedPhases: phases.filter((phase) => phase.accepted).map((phase) => phase.phase),
    blockers: failed.map((phase) => ({ phase: phase.phase, ticket: phase.ticket, reasons: phase.reasons,
      failedChecks: phase.failedChecks, nextAction: phase.nextAction })),
    phases,
    statusLayers: { localAcceptance: failed.length === 0 ? "passed" : "blocked",
      hostedChecks: "not-recorded-by-this-evaluator", codexReview: "not-recorded-by-this-evaluator",
      humanApproval: "not-recorded-by-this-evaluator", merge: "not-recorded-by-this-evaluator",
      deployment: "not-recorded-by-this-evaluator" },
    guarantees: { allPrerequisitesSourceBound: phases.every((phase) => phase.evidencePresent && phase.sourceBinding === "verified" &&
        phase.sourceTreeVerified && !phase.reasons.includes("source-revision-not-in-evaluated-history")),
      zeroRequiredFailures: phases.every((phase) => phase.accepted && phase.required.failed === 0),
      zeroRequiredSkips: phases.every((phase) => phase.accepted && phase.required.skipped === 0),
      successfulCleanup: phases.every((phase) => phase.evidencePresent && phase.cleanup && !phase.reasons.includes("cleanup-failed")) } });
}

export async function main() {
  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const sourceTreeSha256 = workingTreeSourceSha256();
  const report = evaluatePhase8Prerequisites({ root: ROOT, sourceRevision, sourceTreeSha256 });
  const output = join(ROOT, "evidence", "phase8-prerequisite-qualification.json");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ticket: 234, verdict: report.verdict, mergeEligible: report.mergeEligible,
    acceptedPhases: report.acceptedPhases, blockers: report.blockers, evidence: "evidence/phase8-prerequisite-qualification.json" }, null, 2));
  return report.mergeEligible ? 0 : 1;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/phase8-prerequisite-qualification.mjs")) process.exitCode = await main();
