export const REQUIRED_PHASE5_GATE_CHECKS = Object.freeze([
  "validation-ready",
  "exact-toolchain",
  "phase5-context",
  "authoring-scenarios",
  "taxonomy-scenarios",
  "traceability-scenarios",
  "owner-postgres",
  "database-rls-postgres",
  "integrated-scenarios",
  "contract-verification",
  "tooling-tests",
  "architecture",
  "route-inventory",
  "runtime-boundary",
  "runtime-architecture",
  "lint",
  "typecheck",
  "production-build",
]);

const REQUIRED_SCENARIOS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 14, 15]);
const REQUIRED_PHASE5_SUITES = Object.freeze(["authoring", "taxonomy", "traceability", "owner", "database"]);
const REQUIRED_DATABASE_SUITES = Object.freeze([
  "tests/database/content-authoring.integration.test.ts",
  "tests/database/owner-composition.integration.test.ts",
  "tests/database/phase5-security.integration.test.ts",
]);
const REQUIRED_DATABASE_ASSERTIONS = Object.freeze([
  "publishes English and Arabic independently",
  "rolls back route, pointer, projection, success receipt, and event",
  "serializes simultaneous locale publication",
  "serializes assignment against merge and simultaneous merges",
  "queries only current published locale projections with stable tied-time cursors and controlled facets",
  "denies actual public, authenticated, worker, and backup logins",
]);
const REQUIRED_LOCALES = Object.freeze(["en", "ar"]);

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function countSkippedTests(output) {
  const text = String(output ?? "").replaceAll(/\u001B\[[0-9;]*m/g, "");
  const counts = [
    ...text.matchAll(/\b(\d+)\s+skipped\b/gi),
    ...text.matchAll(/\bskipped(?:\s+tests?)?\s*[:=]\s*(\d+)\b/gi),
    ...text.matchAll(/^\s*#?\s*skipped\s+(\d+)\b/gim),
    ...text.matchAll(/\b(\d+)\s+tests?\s+(?:were\s+)?skipped\b/gi),
  ].map((match) => Number(match[1]));
  return counts.length === 0 ? 0 : Math.max(...counts);
}

function validRunTime(value, startedAt) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) && time >= Date.parse(startedAt);
}

function sameSource(record, sourceRevision, sourceTreeSha256, startedAt) {
  return /^[a-f0-9]{40}$/i.test(record?.sourceRevision ?? "") &&
    record.sourceRevision === sourceRevision &&
    /^[a-f0-9]{64}$/i.test(record?.sourceTreeSha256 ?? "") &&
    record.sourceTreeSha256 === sourceTreeSha256 &&
    typeof record.runId === "string" && record.runId.length > 0 &&
    validRunTime(record.startedAt, startedAt);
}

function validCounts(counts, { requireExecuted = true } = {}) {
  return counts !== null && typeof counts === "object" &&
    nonnegativeInteger(counts.executed) && nonnegativeInteger(counts.failed) &&
    nonnegativeInteger(counts.skipped) && nonnegativeInteger(counts.total) &&
    (!requireExecuted || counts.executed > 0) && counts.failed === 0 && counts.skipped === 0 &&
    counts.total === counts.executed;
}

function hasPassingAssertion(report, phrase) {
  return Array.isArray(report?.databaseTestResults) && report.databaseTestResults.some((test) =>
    test?.status === "passed" && typeof test.name === "string" && test.name.includes(phrase));
}

function verifyChecks(checks, runId, sourceRevision, sourceTreeSha256, startedAt) {
  const failures = [];
  const names = Array.isArray(checks) ? checks.map((check) => check?.name) : [];
  for (const name of REQUIRED_PHASE5_GATE_CHECKS) {
    if (!names.includes(name)) failures.push(`missing required check: ${name}`);
  }
  for (const name of names.filter((value, index) => names.indexOf(value) !== index)) {
    failures.push(`duplicate check: ${name}`);
  }
  for (const check of Array.isArray(checks) ? checks : []) {
    if (!REQUIRED_PHASE5_GATE_CHECKS.includes(check?.name)) failures.push(`unexpected check: ${String(check?.name)}`);
    if (check?.runId !== runId || check?.sourceRevision !== sourceRevision || check?.sourceTreeSha256 !== sourceTreeSha256 || !validRunTime(check?.startedAt, startedAt)) {
      failures.push(`check is not bound to this fresh source/run: ${String(check?.name)}`);
    }
    if (check?.passed !== true || check?.exitCode !== 0) failures.push(`check failed or was not run: ${String(check?.name)}`);
    if (check?.executed !== true) failures.push(`check was not executed: ${String(check?.name)}`);
    if (check?.skipped !== 0) failures.push(`check reported skipped work: ${String(check?.name)}`);
    if (check?.evidence?.path === undefined || !/^[a-f0-9]{64}$/i.test(check?.evidence?.sha256 ?? "")) {
      failures.push(`check evidence is missing or malformed: ${String(check?.name)}`);
    }
  }
  return failures;
}

function verifyContext(context, sourceRevision, sourceTreeSha256, startedAt) {
  if (!context || context.phase !== "phase5" || context.verdict !== "pass" ||
    !sameSource(context, sourceRevision, sourceTreeSha256, startedAt) ||
    !Array.isArray(context.failures) || context.failures.length !== 0 ||
    context.operations?.public !== 5 || context.operations?.owner !== 48 || context.operations?.forbiddenFindings !== 0) {
    return ["fresh Phase 5 context or predecessor-compatible boundary verdict is missing or failed"];
  }
  return [];
}

function verifyIntegratedEvidence(report, sourceRevision, sourceTreeSha256, startedAt) {
  const failures = [];
  if (report?.ticket !== 124 || report?.parent !== 106 || report?.verdict !== "pass" || report?.scenarioAcceptance !== true ||
    !sameSource(report, sourceRevision, sourceTreeSha256, startedAt)) {
    failures.push("integrated scenario evidence is missing, stale, malformed, or failed");
  }
  if (!validCounts(report?.counts)) failures.push("integrated scenario counts must show execution with zero failure and skip");

  const stories = report?.coverage?.userStories;
  const storyIds = Array.isArray(stories) ? stories.map((item) => item?.id) : [];
  if (storyIds.length !== 54 || storyIds.some((id, index) => id !== index + 1) ||
    stories.some((item) => !Array.isArray(item?.tickets) || item.tickets.length === 0 || !Array.isArray(item?.assertions) || item.assertions.length === 0)) {
    failures.push("all 54 user stories must map to executable assertions and owning tickets");
  }
  const scenarioIds = Array.isArray(report?.coverage?.scenarios) ? report.coverage.scenarios.map((item) => item?.id) : [];
  if (scenarioIds.length !== REQUIRED_SCENARIOS.length || REQUIRED_SCENARIOS.some((id, index) => scenarioIds[index] !== id)) {
    failures.push("required Phase 5 scenarios are missing or out of order");
  }
  for (const phase of ["Phase 6", "Phase 7", "Phase 8", "Phase 9-10"]) {
    if (!Array.isArray(report?.deferred) || !report.deferred.some((item) => String(item).includes(phase))) {
      failures.push(`later-phase limitation is not recorded: ${phase}`);
    }
  }

  const constituents = Array.isArray(report?.constituents) ? report.constituents : [];
  const byName = new Map(constituents.map((item) => [item?.name, item]));
  if (constituents.length !== REQUIRED_PHASE5_SUITES.length || byName.size !== REQUIRED_PHASE5_SUITES.length) {
    failures.push("integrated evidence must contain each required suite exactly once");
  }
  for (const name of REQUIRED_PHASE5_SUITES) {
    const item = byName.get(name);
    if (!item || item.verdict !== "pass" || !sameSource(item, sourceRevision, sourceTreeSha256, startedAt) ||
      item.issues?.length !== 0 || !validCounts(item.counts)) {
      failures.push(`integrated constituent is incomplete, failed, skipped, or stale: ${name}`);
    }
    if ((name === "owner" && item?.ticket !== 122) || (name === "database" && item?.ticket !== 123) ||
      (["authoring", "taxonomy", "traceability"].includes(name) && item?.suite !== name)) {
      failures.push(`integrated constituent identity is invalid: ${name}`);
    }
  }
  return failures;
}

function verifyDatabaseEvidence(report, sourceRevision, sourceTreeSha256, startedAt) {
  const failures = [];
  if (!report || report.ticket !== 123 || report.parent !== 106 ||
    !sameSource(report, sourceRevision, sourceTreeSha256, startedAt)) {
    return ["fresh ticket #123 real PostgreSQL evidence is required"];
  }
  if (!nonnegativeInteger(report.databaseIntegrationTestsPassed) || report.databaseIntegrationTestsPassed === 0 ||
    report.skippedCases !== 0 || report.isolatedLoopbackProjects !== true ||
    report.credentialsRecorded !== false || report.secretValuesRecorded !== false) {
    failures.push("PostgreSQL evidence must execute without skips, use isolated loopback projects, and exclude credentials/secrets");
  }
  if (report.toolVersions?.node !== "24.21.0" || report.toolVersions?.npm !== "11.19.0") failures.push("database evidence tool versions do not match the pinned runtime");
  const checksums = report.migrationChecksums;
  if (!Array.isArray(checksums) || checksums.length === 0 || checksums.some((item) =>
    typeof item?.file !== "string" || !/^[a-f0-9]{64}$/i.test(item?.sha256 ?? ""))) {
    failures.push("migration files and SHA-256 checksums are missing or malformed");
  }
  if (!Array.isArray(report.migrationLedger) || report.migrationLedger.length === 0 ||
    report.cleanUpgradeEquivalent !== true || report.migrationReplayNoop !== true || report.generatedTypeDrift !== false ||
    report.phase4ReleaseUpgrade?.cleanAndPhase4UpgradeFinalSchemasEquivalent !== true) {
    failures.push("clean/upgrade migration equivalence, replay, generated types, or predecessor retention is incomplete");
  }
  const suites = Array.isArray(report.databaseIntegrationSuites) ? report.databaseIntegrationSuites : [];
  const suitesByFile = new Map(suites.map((suite) => [suite?.file, suite]));
  if (suites.length !== REQUIRED_DATABASE_SUITES.length || REQUIRED_DATABASE_SUITES.some((file) => {
    const suite = suitesByFile.get(file);
    return !suite || suite.passed <= 0 || suite.failed !== 0 || suite.skipped !== 0;
  })) failures.push("required real PostgreSQL publication, composition, and RLS suites did not all execute cleanly");

  const roles = report.restrictedPrincipalMatrix;
  const denied = (value) => typeof value === "string" && /^denied$|^deny(?: by grants and forced RLS)?$/i.test(value);
  const roleFor = (phrase) => Array.isArray(roles) ? roles.find((role) => role?.principal?.includes(phrase)) : undefined;
  for (const phrase of ["anon", "authenticated", "worker", "migration"]) {
    if (!roleFor(phrase)) failures.push(`restricted principal matrix is missing ${phrase}`);
  }
  const anon = roleFor("anon");
  const authenticated = roleFor("authenticated");
  const configuredOwner = roleFor("configured Owner");
  const foreignOwner = roleFor("foreign Portfolio");
  const worker = roleFor("worker");
  const migration = roleFor("migration");
  if (!denied(anon?.privateContentRead) || !denied(anon?.privateWrite) ||
    !denied(authenticated?.privateContentRead) || !denied(authenticated?.privateWrite) ||
    !denied(worker?.privateContentRead) || !denied(worker?.privateWrite) ||
    configuredOwner?.privateContentRead !== "configured Portfolio only" ||
    configuredOwner?.privateWrite !== "approved application grants and forced RLS" ||
    !denied(foreignOwner?.privateContentRead) || !denied(foreignOwner?.privateWrite) ||
    !denied(migration?.runtimeLogin) || migration?.runtimeCredential !== false) {
    failures.push("actual restricted principals are not denied private content reads and writes");
  }
  if (!Array.isArray(report.authoringTablesWithForcedRls) ||
    !["content.items", "content.revisions"].every((table) => report.authoringTablesWithForcedRls.includes(table))) {
    failures.push("forced-RLS ownership evidence for private authoring tables is missing");
  }
  const pooled = report.pooledConnectionScope;
  if (pooled?.knownPrivateIdsRequireOwnerAuthorization !== true ||
    JSON.stringify(pooled?.verifiedAfter) !== JSON.stringify(["success", "expected rejection", "rollback", "fault"])) {
    failures.push("pooled Owner/Portfolio scope isolation is incomplete");
  }
  const diagnostics = report.diagnosticsPrivacy;
  const auditSuites = Array.isArray(diagnostics?.auditSuites) ? diagnostics.auditSuites : [];
  if (auditSuites.length === 0 || auditSuites.some((suite) => suite.passed <= 0 || suite.failed !== 0 || suite.skipped !== 0) ||
    !Array.isArray(diagnostics?.safeFaultOutcomes) || diagnostics.safeFaultOutcomes.length === 0 ||
    !Array.isArray(diagnostics?.redactedValuesCovered) || diagnostics.redactedValuesCovered.length < 4) {
    failures.push("privacy and sanitized diagnostic evidence is incomplete");
  }
  if (!Array.isArray(report.databaseTestResults) || report.databaseTestResults.some((item) => item?.status !== "passed")) {
    failures.push("database result transcript is missing, failed, or skipped");
  }
  for (const assertion of REQUIRED_DATABASE_ASSERTIONS) {
    if (!hasPassingAssertion(report, assertion)) failures.push(`required atomicity, race, discovery, ordering, filter, or query-plan assertion is missing: ${assertion}`);
  }
  return failures;
}

function verifyOwnerEvidence(report, sourceRevision, sourceTreeSha256, startedAt) {
  if (!report || report.ticket !== 122 || report.parent !== 106 || !sameSource(report, sourceRevision, sourceTreeSha256, startedAt) ||
    report.databaseIntegrationTestsPassed <= 0 || report.injectedAdapterAndContractTestsPassed <= 0 ||
    report.skippedCases !== 0 || report.isolatedLoopbackProjects !== true ||
    report.credentialsRecorded !== false || report.secretValuesRecorded !== false ||
    !hasPassingAssertion(report, "keeps the committed route and projection readable after optional delivery port failures")) {
    return ["fresh Owner composition evidence, safe committed event, or optional-delivery failure proof is missing"];
  }
  return [];
}

export function evaluatePhase5Gate({
  runId,
  sourceRevision,
  sourceTreeSha256,
  startedAt,
  toolVersions,
  checks,
  contextEvidence,
  integratedEvidence,
  databaseEvidence,
  ownerEvidence,
}) {
  const failures = [];
  if (typeof runId !== "string" || runId.length === 0 || !/^[a-f0-9]{40}$/i.test(sourceRevision ?? "") ||
    !/^[a-f0-9]{64}$/i.test(sourceTreeSha256 ?? "") || !Number.isFinite(Date.parse(startedAt ?? ""))) {
    failures.push("gate run or source identity is missing or malformed");
  }
  if (toolVersions?.node !== "24.21.0" || toolVersions?.npm !== "11.19.0") failures.push("exact Node 24.21.0 and npm 11.19.0 are required");
  failures.push(...verifyChecks(checks, runId, sourceRevision, sourceTreeSha256, startedAt));
  failures.push(...verifyContext(contextEvidence, sourceRevision, sourceTreeSha256, startedAt));
  failures.push(...verifyIntegratedEvidence(integratedEvidence, sourceRevision, sourceTreeSha256, startedAt));
  failures.push(...verifyDatabaseEvidence(databaseEvidence, sourceRevision, sourceTreeSha256, startedAt));
  failures.push(...verifyOwnerEvidence(ownerEvidence, sourceRevision, sourceTreeSha256, startedAt));

  const counts = {
    executed: (integratedEvidence?.counts?.executed ?? 0) + (checks ?? []).filter((check) => check?.executed === true).length,
    failed: failures.length,
    skipped: (integratedEvidence?.counts?.skipped ?? 0) + (checks ?? []).reduce((total, check) => total + (check?.skipped ?? 0), 0),
  };
  counts.total = counts.executed + counts.failed + counts.skipped;
  return {
    schemaVersion: 1,
    ticket: 125,
    parent: 106,
    runId,
    sourceRevision,
    sourceTreeSha256,
    startedAt,
    verdict: failures.length === 0 ? "pass" : "fail",
    scenarioAcceptance: failures.length === 0,
    toolVersions,
    checks,
    counts,
    coverage: {
      userStories: integratedEvidence?.coverage?.userStories?.length ?? 0,
      scenarios: integratedEvidence?.coverage?.scenarios?.length ?? 0,
    },
    databaseProof: {
      migrationCount: databaseEvidence?.migrationChecksums?.length ?? 0,
      restrictedPrincipalCount: databaseEvidence?.restrictedPrincipalMatrix?.length ?? 0,
      postgresAssertions: databaseEvidence?.databaseIntegrationTestsPassed ?? 0,
      queryPlanAssertion: REQUIRED_DATABASE_ASSERTIONS[4],
      safeEventAssertion: "keeps the committed route and projection readable after optional delivery port failures",
    },
    deferred: integratedEvidence?.deferred ?? [],
    failureCount: failures.length,
    failures,
    guarantees: {
      requiredPostgres: true,
      allRequiredSuitesExecuted: true,
      zeroRequiredSkips: true,
      evidenceBoundToSourceTreeAndRun: true,
      unitOnlyCannotSatisfyDatabase: true,
      phase5CompletionClaimed: false,
    },
    reproduction: ["npm run setup:validation", "npm run validation:ready", "npm run phase5:gate"],
    cleanup: "Ticket 123 and 122 use their isolated loopback PostgreSQL projects and verify cleanup.",
  };
}
