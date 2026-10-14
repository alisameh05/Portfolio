import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PHASE6_TOOL_DEFINITIONS } from "./phase6-verification-support.mjs";

export const PHASE6_GATE_REQUIRED_CHECKS = Object.freeze([
  "validation-ready", "toolchain", "phase6-setup", "upload-intents", "pdf-processing",
  "image-processing", "video-processing", "media-acceptance", "publication-media",
  "cv-registration", "cv-acceptance", "cv-activation", "media-rejection", "media-delivery",
  "cv-delivery-capabilities", "owner-composition", "migration-access", "media-integration",
  "media-cv-integration", "contract-verification", "tooling-tests", "phase6-gate-negative-tests",
  "architecture", "route-inventory", "runtime-boundary", "runtime-architecture", "lint", "typecheck",
  "production-build",
]);

export const PHASE6_GATE_COMPONENTS = Object.freeze([
  { id: "setup", ticket: 146, path: "evidence/phase-6-verification-setup.json", criteria: [9, 12, 13, 24, 25, 45, 49, 50] },
  { id: "upload-intents", ticket: 148, path: "evidence/phase6-upload-intent-148.json", criteria: [3, 4, 5, 6, 7, 8, 41, 42] },
  { id: "pdf-processing", ticket: 149, path: "evidence/phase6-media-processing-149.json", criteria: [9, 10, 11, 12, 13, 14, 17] },
  { id: "image-processing", ticket: 150, path: "evidence/phase6-image-processing-150.json", criteria: [9, 10, 11, 12, 13, 14] },
  { id: "video-processing", ticket: 151, path: "evidence/phase6-video-processing-151.json", criteria: [9, 10, 11, 12, 13, 14] },
  { id: "media-acceptance", ticket: 152, path: "evidence/phase6-media-acceptance-152.json", criteria: [14, 15, 16, 17, 18, 19, 21, 51] },
  { id: "publication-media", ticket: 153, path: "evidence/phase6-publication-media-153.json", criteria: [18, 19, 20, 21, 22, 23, 48, 51] },
  { id: "cv-registration", ticket: 154, path: "evidence/phase6-cv-portfolio-154.json", criteria: [26, 27, 29, 41, 42] },
  { id: "cv-acceptance", ticket: 155, path: "evidence/phase6-cv-acceptance-155.json", criteria: [28, 29, 41, 42] },
  { id: "cv-activation", ticket: 156, path: "evidence/phase6-cv-activation-156.json", criteria: [30, 31, 32, 33, 34, 35, 41, 42, 51] },
  { id: "media-rejection", ticket: 157, path: "evidence/phase6-media-rejection.json", criteria: [16, 17, 20, 21, 22, 41, 42] },
  { id: "media-delivery", ticket: 158, path: "evidence/phase6-media-delivery-158.json", criteria: [23, 24, 25, 48, 49] },
  { id: "cv-delivery", ticket: 159, path: "evidence/phase6-cv-delivery-159.json", criteria: [36, 37, 38, 39, 40, 49] },
  { id: "public-capabilities", ticket: 160, path: "evidence/phase6-public-capabilities-160.json", criteria: [40, 41, 48, 49, 51] },
  { id: "owner-composition", ticket: 161, path: "evidence/phase6-owner-composition-161.json", criteria: [1, 2, 25, 26, 40, 42, 43, 44, 49] },
  { id: "migration-access", ticket: 162, path: "evidence/phase6-migration-access-162.json", criteria: [2, 13, 24, 25, 43, 44, 45, 46, 47] },
  { id: "media-integration", ticket: null, path: "evidence/phase6-media-integration.json", criteria: [3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 16, 17, 24, 41, 42] },
  { id: "media-cv-integration", ticket: 163, path: "evidence/phase6-media-cv-integration-163.json", criteria: [1, 2, 14, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 48, 49, 50, 51] },
]);

const componentById = new Map(PHASE6_GATE_COMPONENTS.map((component) => [component.id, component]));
const evidenceForCriteria = new Map();
for (const component of PHASE6_GATE_COMPONENTS) {
  for (const criterion of component.criteria) {
    const list = evidenceForCriteria.get(criterion) ?? [];
    list.push(component.id);
    evidenceForCriteria.set(criterion, list);
  }
}
for (const [criterion, suites] of [
  [51, ["cv-activation", "media-acceptance", "publication-media", "public-capabilities", "media-cv-integration"]],
  [52, ["setup", "media-cv-integration"]], [53, ["media-cv-integration"]],
  [54, ["migration-access", "media-cv-integration"]], [55, ["owner-composition", "media-cv-integration"]],
  [56, ["media-cv-integration"]],
]) evidenceForCriteria.set(criterion, suites);

const AC_CHECKS = Object.freeze({
  "AC-52": ["validation-ready", "toolchain"],
  "AC-53": ["phase6-gate-negative-tests"],
  "AC-54": ["contract-verification", "architecture", "lint", "typecheck", "production-build"],
  "AC-55": ["route-inventory", "runtime-boundary", "runtime-architecture"],
  "AC-56": ["media-cv-integration"],
});

export const PHASE6_GATE_ACCEPTANCE_MATRIX = Object.freeze(Array.from({ length: 56 }, (_, index) => {
  const number = index + 1;
  const id = `AC-${String(number).padStart(2, "0")}`;
  return Object.freeze({ id, suites: Object.freeze(evidenceForCriteria.get(number) ?? []), checks: Object.freeze(AC_CHECKS[id] ?? []) });
}));

const STORY_RANGES = Object.freeze([
  [1, 1, [3, 4, 5, 6]], [2, 2, [3, 4, 6]], [3, 3, [4, 7]], [4, 4, [5, 9, 12]],
  [5, 5, [5, 10, 11]], [6, 7, [9, 12]], [8, 10, [9, 10, 11, 12, 13]], [11, 12, [14]],
  [13, 15, [14, 15, 16]], [16, 17, [16, 17]], [18, 19, [18, 19]], [20, 21, [20, 21]],
  [22, 24, [22, 23, 24, 41]], [25, 25, [2, 25]], [26, 27, [26, 27]], [28, 29, [28, 29]],
  [30, 34, [30, 31, 32, 33, 34, 35]], [35, 39, [36, 37, 38, 39, 40]], [40, 42, [41, 42]],
  [43, 44, [43, 44, 49]], [45, 45, [45, 48]], [46, 46, [46, 49]], [47, 47, [47]], [48, 48, [50, 51, 52, 53, 54, 55, 56]],
]);

export const PHASE6_GATE_STORY_MATRIX = Object.freeze(Array.from({ length: 48 }, (_, index) => {
  const story = index + 1;
  const [, , criteria] = STORY_RANGES.find(([first, last]) => story >= first && story <= last) ?? [];
  return Object.freeze({ id: `US-${String(story).padStart(2, "0")}`, acceptanceCriteria: Object.freeze((criteria ?? []).map((number) => `AC-${String(number).padStart(2, "0")}`)) });
}));

export const PHASE6_GATE_MANDATORY_MATRICES = Object.freeze([
  { id: "real-services-and-tools", component: "setup", scenario: "real Postgres/Auth/private Storage/ClamAV/PDF/image/video probes" },
  { id: "six-real-formats-and-immutable-bytes", component: "media-cv-integration", scenario: "pdf,png,jpeg,webp,mp4,webm" },
  { id: "restricted-principals-and-storage-policies", component: "migration-access", scenario: "runtime/public/Owner/worker and private-object policy cases" },
  { id: "migration-checksums-equivalence-and-generated-types", component: "migration-access", scenario: "clean upgrade and migration ledger" },
  { id: "owner-route-and-response-matrix", component: "owner-composition", scenario: "all nine Owner Media/CV operations" },
  { id: "races-rollback-replay-conflict-and-outbox", component: "media-cv-integration", scenario: "T18-01,T18-04,T18-05,T18-06",
    requiredScenarioIds: ["T18-01", "T18-04", "T18-05", "T18-06"] },
  { id: "indexed-plans", component: "migration-access", scenario: "bounded migration/query plan assertions" },
  { id: "redaction-safe-events-and-deferred-services", component: "media-cv-integration", scenario: "T18-09,T18-11",
    requiredScenarioIds: ["T18-09", "T18-11"] },
  { id: "scenario-9-atomic-cv-replacement", component: "cv-activation", scenario: "T11 activation/history/race/rollback plus T18-01,T18-04,T18-05,T18-06",
    requiredScenarioIds: Array.from({ length: 10 }, (_, index) => `T11-${String(index + 1).padStart(2, "0")}`) },
  { id: "scenario-12-media-acceptance", component: "media-acceptance", scenario: "T07 candidate facts, replay, rollback, ownership, locking, privacy, and six real formats",
    requiredScenarioIds: Array.from({ length: 10 }, (_, index) => `T07-${String(index + 1).padStart(2, "0")}`) },
  { id: "scenario-12-publication-gates", component: "publication-media", scenario: "T07/T08 publication, restore, stale/foreign/unsafe facts and T18-02,T18-05",
    requiredScenarioIds: Array.from({ length: 8 }, (_, index) => `T08-${String(index + 1).padStart(2, "0")}`) },
  { id: "scenario-12-integrated-publication", component: "media-cv-integration", scenario: "T18 publication and rollback cases for scenario 12",
    requiredScenarioIds: ["T18-02", "T18-05"] },
  { id: "scenario-13-arabic-boundary", component: "public-capabilities", scenario: "T15 Arabic accepted-English-Media reuse, no English text fallback and Arabic CV unavailable",
    requiredScenarioIds: Array.from({ length: 8 }, (_, index) => `T15-${String(index + 1).padStart(2, "0")}`) },
  { id: "scenario-15-phase6-degraded-dependencies", component: "cv-delivery", scenario: "T14 safe delivery failure plus T18-04,T18-11; no outage-survival claim",
    requiredScenarioIds: Array.from({ length: 10 }, (_, index) => `T14-${String(index + 1).padStart(2, "0")}`) },
]);

function scenarioReferences(item) {
  const references = [item?.id, item?.caseId, ...(Array.isArray(item?.criteria) ? item.criteria : [])];
  if (typeof item?.name === "string") references.push(...(item.name.match(/\bT\d{2}-\d{2}\b/gu) ?? []));
  return [...new Set(references.filter((id) => typeof id === "string" && /^T\d{2}-\d{2}$/u.test(id)))];
}

function passedScenarioEvidence(report) {
  const records = new Map();
  const visit = (items, inherited = []) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const references = [...new Set([...inherited, ...scenarioReferences(item)])];
      const children = Array.isArray(item.cases) ? item.cases : [];
      const explicitPass = item.executed === true && item.status === "passed";
      const inferredPass = children.length > 0 && children.every((child) => child?.executed === true && child?.status === "passed");
      for (const id of references) {
        const prior = records.get(id) ?? [];
        prior.push(explicitPass || inferredPass);
        records.set(id, prior);
      }
      visit(children, references.filter((id) => item.id === id || inherited.includes(id)));
    }
  };
  visit(report?.criteria);
  visit(report?.scenarios);
  visit(report?.checks?.scenarios);
  return [...records].map(([id, results]) => ({ id, executed: results.length > 0 && results.every(Boolean), status: results.length > 0 && results.every(Boolean) ? "passed" : "failed" }));
}

function parseJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function reportCounts(report) {
  const counts = report?.counts ?? report?.testRun ?? {};
  const executionCounts = report?.executionCounts ?? {};
  const checkCounts = report?.checks?.counts ?? {};
  const scenarios = report?.scenarios ?? report?.checks?.scenarios ?? [];
  const executed = counts.executed ?? counts.total ?? counts.passed ?? counts.integrationExecuted ?? counts.executedFormats ??
    counts.criteria ?? executionCounts.criteriaExecuted ?? checkCounts.executed ?? report?.checks?.total ??
    report?.acceptanceOperations ?? scenarios.filter((item) => item?.executed === true).length;
  const failed = counts.failed ?? counts.integrationFailures ?? counts.failedFormats ?? checkCounts.failed ?? report?.checks?.failed ??
    report?.failures?.length ?? scenarios.filter((item) => item?.executed === true && item?.status === "failed").length;
  const skipped = counts.skipped ?? counts.integrationSkips ?? counts.skippedFormats ?? checkCounts.skipped ?? report?.checks?.skipped ??
    report?.skippedCases ?? scenarios.filter((item) => item?.executed !== true || item?.status === "skipped").length;
  return { executed, failed, skipped };
}

export function readPhase6GateEvidence(root, startedAt, sourceRevision, sourceTreeSha256) {
  const gateStart = Date.parse(startedAt);
  return PHASE6_GATE_COMPONENTS.map((component) => {
    const path = join(root, component.path);
    const report = parseJson(path);
    let fresh = false;
    let sha256 = null;
    try {
      const stat = statSync(path);
      fresh = stat.mtimeMs >= gateStart;
      sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch { /* reported below as missing */ }
    const counts = reportCounts(report);
    const sourceBound = report?.sourceRevision === sourceRevision && report?.sourceTreeSha256 === sourceTreeSha256;
    const cleanup = report?.cleanup?.success === true && report?.cleanup?.attempted !== false;
    const reportPassed = report?.verdict === "pass" && report?.schemaVersion >= 1 &&
      typeof report?.runId === "string" && report.runId.length >= 8 && sourceBound && fresh &&
      counts.executed > 0 && counts.failed === 0 && counts.skipped === 0 && cleanup;
    const scenarioIds = [
      ...(Array.isArray(report?.criteria) ? report.criteria : []),
      ...(Array.isArray(report?.scenarios) ? report.scenarios : []),
      ...(Array.isArray(report?.checks?.scenarios) ? report.checks.scenarios : []),
    ].flatMap((item) => [item?.id, item?.caseId].filter((id) => typeof id === "string" && id.length > 0));
    return {
      id: component.id, ticket: component.ticket, path: component.path, sha256, runId: report?.runId ?? null,
      sourceRevision: report?.sourceRevision ?? null, sourceTreeSha256: report?.sourceTreeSha256 ?? null,
      startedAt: report?.startedAt ?? null, fresh, sourceBound, counts, cleanup, verdict: report?.verdict ?? "missing",
      evidenceBinding: {
        scope: report?.scope ?? null,
        toolVersions: report?.toolVersions ?? report?.runtime ?? null,
        toolDefinitions: report?.toolDefinitions ?? null,
        policyIds: report?.policyIds ?? null,
        principalScope: report?.principalScope ?? null,
        migrationChecksums: report?.migrationChecksums ?? null,
        migrationSetEquivalent: report?.migrationSetEquivalent ?? report?.cleanUpgradeEquivalent ?? null,
        generatedTypesSha256: report?.generatedTypesSha256 ?? null,
        databasePrincipals: report?.databasePrincipals ?? null,
        storageMatrix: report?.storageMatrix ?? null,
        boundedPlans: report?.boundedPlans ?? null,
        scenarioIds: [...new Set(scenarioIds)],
        scenarioEvidence: passedScenarioEvidence(report),
        caseCounts: counts,
      },
      accepted: reportPassed,
    };
  });
}

export function evaluatePhase6Gate({ runId, startedAt, sourceRevision, sourceTreeSha256, runtime, expectedRuntime,
  checks, evidenceArtifacts, serviceEvidence, now = Date.now() }) {
  const failures = [];
  if (typeof runId !== "string" || runId.length < 8) failures.push("gate-run-id-invalid");
  if (!/^[a-f0-9]{40}$/iu.test(sourceRevision ?? "") || !/^[a-f0-9]{64}$/iu.test(sourceTreeSha256 ?? "")) failures.push("gate-source-identity-invalid");
  const start = Date.parse(startedAt ?? "");
  if (!Number.isFinite(start) || start > now || now - start > 24 * 60 * 60 * 1000) failures.push("gate-run-time-invalid");
  if (runtime?.node !== `v${expectedRuntime?.node}` || runtime?.npm !== expectedRuntime?.npm) failures.push("runtime-pin-mismatch");

  const checksByName = new Map();
  for (const check of checks ?? []) {
    if (checksByName.has(check?.name)) failures.push(`duplicate-check:${check.name}`);
    checksByName.set(check?.name, check);
  }
  for (const name of PHASE6_GATE_REQUIRED_CHECKS) {
    const check = checksByName.get(name);
    if (check?.executed !== true || check?.passed !== true || check?.exitCode !== 0 || check?.skipped !== 0) failures.push(`required-check-failed:${name}`);
  }
  if ((checks ?? []).some((check) => check?.timedOut === true)) failures.push("check-timeout");

  const artifactsById = new Map((evidenceArtifacts ?? []).map((artifact) => [artifact?.id, artifact]));
  for (const component of PHASE6_GATE_COMPONENTS) {
    const artifact = artifactsById.get(component.id);
    if (!artifact?.accepted || (component.ticket === null ? artifact?.ticket !== null : artifact?.ticket !== component.ticket) ||
        !/^[a-f0-9]{64}$/iu.test(artifact?.sha256 ?? "")) {
      failures.push(`required-evidence-invalid:${component.id}`);
    }
  }
  const acceptanceIds = new Set((PHASE6_GATE_ACCEPTANCE_MATRIX ?? []).map((item) => item?.id));
  if (PHASE6_GATE_ACCEPTANCE_MATRIX.length !== 56 || acceptanceIds.size !== 56 ||
      PHASE6_GATE_ACCEPTANCE_MATRIX.some((item) => item.suites.length === 0 || item.suites.some((id) => !artifactsById.get(id)?.accepted) ||
        item.checks.some((name) => checksByName.get(name)?.passed !== true))) {
    failures.push("acceptance-matrix-incomplete-or-unexecuted");
  }
  const storyIds = new Set((PHASE6_GATE_STORY_MATRIX ?? []).map((item) => item?.id));
  if (PHASE6_GATE_STORY_MATRIX.length !== 48 || storyIds.size !== 48 ||
      PHASE6_GATE_STORY_MATRIX.some((story) => story.acceptanceCriteria.length === 0 || story.acceptanceCriteria.some((id) => !acceptanceIds.has(id)))) {
    failures.push("user-story-matrix-incomplete");
  }
  if (PHASE6_GATE_MANDATORY_MATRICES.length < 8 || PHASE6_GATE_MANDATORY_MATRICES.some((matrix) =>
    typeof matrix.id !== "string" || typeof matrix.scenario !== "string" || !artifactsById.get(matrix.component)?.accepted)) {
    failures.push("mandatory-matrix-incomplete-or-unexecuted");
  }
  for (const matrix of PHASE6_GATE_MANDATORY_MATRICES) {
    const artifact = artifactsById.get(matrix.component);
    const observed = new Map((artifact?.evidenceBinding?.scenarioEvidence ?? []).map((item) => [item.id, item]));
    for (const id of matrix.requiredScenarioIds ?? []) {
      const scenario = observed.get(id);
      if (scenario?.executed !== true || scenario?.status !== "passed") failures.push(`required-matrix-scenario-missing:${matrix.id}:${id}`);
    }
  }
  if (!Array.isArray(serviceEvidence?.formats) || serviceEvidence.formats.length !== 6 ||
      new Set(serviceEvidence.formats.map((item) => item.id)).size !== 6 ||
      ["pdf", "png", "jpeg", "webp", "mp4", "webm"].some((id) => !serviceEvidence.formats.some((item) => item.id === id && item.executed === true && item.status === "passed"))) {
    failures.push("real-format-matrix-incomplete");
  }
  const services = serviceEvidence?.services;
  if (services?.postgres?.available !== true || services.postgres.executionCount < 1 || services.postgres.independentConnections < 2 ||
      services?.auth?.available !== true || services.auth.executionCount < 1 ||
      services?.storage?.available !== true || services.storage.privateBucketVerified !== true || services.storage.executionCount < 1) {
    failures.push("required-real-service-evidence-missing");
  }
  if (services?.scanner?.available !== true || !services.scanner.version || services.scanner.executions < 1 ||
      ["pdf", "image", "video"].some((kind) => services?.processors?.[kind]?.available !== true ||
        !services.processors[kind].version || services.processors[kind].executions < 1)) failures.push("real-scanner-or-processor-evidence-missing");
  if (serviceEvidence?.cleanup?.attempted !== true || serviceEvidence.cleanup.success !== true) failures.push("real-service-cleanup-unconfirmed");
  if (serviceEvidence?.evidenceMode === "fake-only" || serviceEvidence?.testRun?.unitOnly === true ||
      services?.storage?.fakeOnly === true || serviceEvidence?.principalScope?.database?.includes("fixture") === true) {
    failures.push("fake-only-evidence-cannot-certify-phase6");
  }
  const expectedT18 = Array.from({ length: 11 }, (_, index) => `T18-${String(index + 1).padStart(2, "0")}`);
  const criteria = Array.isArray(serviceEvidence?.criteria) ? serviceEvidence.criteria : [];
  const criterionIds = criteria.map((criterion) => criterion?.id);
  const allCases = criteria.flatMap((criterion) => Array.isArray(criterion?.cases) ? criterion.cases : []);
  const failedCases = allCases.filter((item) => item?.executed !== true || item?.status !== "passed" || typeof item?.caseId !== "string" || item.caseId.length === 0);
  const casesExecuted = allCases.filter((item) => item?.executed === true && item?.status === "passed").length;
  if (criteria.length !== expectedT18.length || new Set(criterionIds).size !== expectedT18.length ||
      expectedT18.some((id) => !criterionIds.includes(id)) || criteria.some((criterion) => !Array.isArray(criterion?.cases) || criterion.cases.length === 0) || failedCases.length > 0) {
    failures.push("integrated-scenario-matrix-missing-or-unexecuted");
  }
  if (serviceEvidence?.counts?.executed !== casesExecuted || serviceEvidence?.counts?.failed !== 0 || serviceEvidence?.counts?.skipped !== 0 ||
      serviceEvidence?.testRun?.exitStatus !== 0 || serviceEvidence?.testRun?.failed !== 0 || serviceEvidence?.testRun?.skipped !== 0 || serviceEvidence?.testRun?.total < 1) {
    failures.push("integrated-scenario-execution-counts-invalid");
  }
  if (services?.scanner?.version !== PHASE6_TOOL_DEFINITIONS.scanner ||
      services?.processors?.pdf?.version !== PHASE6_TOOL_DEFINITIONS.pdfProcessor ||
      services?.processors?.video?.version !== PHASE6_TOOL_DEFINITIONS.videoProcessor ||
      typeof services?.processors?.image?.version !== "string" || !services.processors.image.version.startsWith("sharp-") ||
      !String(serviceEvidence?.principalScope?.database ?? "").includes("shipwithali_application") ||
      !String(serviceEvidence?.principalScope?.auth ?? "").includes("loopback Supabase Auth") ||
      !String(serviceEvidence?.principalScope?.storage ?? "").includes("private local Storage")) {
    failures.push("real-adapter-tool-or-principal-scope-unverified");
  }

  const uniqueFailures = [...new Set(failures)];
  return {
    ticket: 164, parent: 145, schemaVersion: 1, runId, startedAt, completedAt: new Date(now).toISOString(),
    sourceRevision, sourceTreeSha256, runtime, expectedRuntime, checks, evidenceArtifacts,
    evidenceSummary: { migrationAccess: evidenceArtifacts.find((item) => item.id === "migration-access")?.evidenceBinding,
      realServiceAndAdapterProof: evidenceArtifacts.find((item) => item.id === "media-cv-integration")?.evidenceBinding,
      ownerCompositionAndRouteProof: evidenceArtifacts.find((item) => item.id === "owner-composition")?.evidenceBinding,
      storageAndByteDelivery: evidenceArtifacts.filter((item) => ["setup", "media-integration", "media-cv-integration"].includes(item.id))
        .map(({ id, evidenceBinding }) => ({ id, ...evidenceBinding })),
      safeEventExamples: [
        { eventType: "cv.current_changed.v1", schemaVersion: 1,
          payload: { previousCurrentCvId: "[redacted]", newCurrentCvId: "[redacted]", activatedAt: "[timestamp]" },
          verifiedBy: "CV activation and integrated T18 race/rollback cases", privateValuesIncluded: false },
        { eventType: "media.asset_rejected.v1", schemaVersion: 1,
          payload: { mediaAssetId: "[redacted]", reason: "OWNER_REJECTED" },
          verifiedBy: "Media rejection integration and T18 privacy cases", privateValuesIncluded: false },
      ] },
    coverage: { acceptanceCriteria: PHASE6_GATE_ACCEPTANCE_MATRIX, userStories: PHASE6_GATE_STORY_MATRIX,
      mandatoryMatrices: PHASE6_GATE_MANDATORY_MATRICES },
    counts: { checks: checks?.length ?? 0, checksPassed: checks?.filter((check) => check.passed).length ?? 0,
      acceptanceCriteria: acceptanceIds.size, userStories: storyIds.size, matrices: PHASE6_GATE_MANDATORY_MATRICES.length,
      evidenceReports: evidenceArtifacts?.filter((item) => item.accepted).length ?? 0 },
    services: serviceEvidence?.services ?? null, formats: serviceEvidence?.formats ?? [], cleanup: serviceEvidence?.cleanup ?? { attempted: false, success: false },
    limitations: [
      "Evidence certifies backend Media/CV behavior, not frontend rendering or accessibility certification.",
      "Deployment, TestSprite, release-load, backup/restore, and operations qualification remain deferred.",
      "No guarantee is made that already-issued delivery capabilities survive a Storage outage beyond their bounded expiry.",
    ],
    guarantees: { freshEvidence: uniqueFailures.every((item) => !item.includes("evidence")), sourceBound: sourceRevision !== "unknown" && sourceTreeSha256 !== "unknown",
      realServices: !uniqueFailures.includes("required-real-service-evidence-missing"), zeroRequiredSkips: checks?.every((check) => check.skipped === 0) ?? false,
      successfulCleanup: serviceEvidence?.cleanup?.success === true },
    failures: uniqueFailures, failureCount: uniqueFailures.length, verdict: uniqueFailures.length === 0 ? "pass" : "fail",
  };
}
