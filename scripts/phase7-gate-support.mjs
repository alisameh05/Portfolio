import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sanitizeEvidenceOutput } from "./phase4-gate-support.mjs";

export const PHASE7_GATE_COMPONENTS = Object.freeze([
  ["consent", "evidence/phase7-consent-189.json"],
  ["reactions", "evidence/phase7-reactions-190.json"],
  ["ratings", "evidence/phase7-ratings-191.json"],
  ["feedback", "evidence/phase7-feedback-192.json"],
  ["moderation", "evidence/phase7-moderation-193.json"],
  ["suppression", "evidence/phase7-suppression-194.json"],
  ["summaries", "evidence/phase7-summaries-195.json"],
  ["events", "evidence/phase7-events-196.json"],
  ["event-facts", "evidence/phase7-event-facts-197.json"],
  ["event-capabilities", "evidence/phase7-event-capabilities-198.json"],
  ["goal-versions", "evidence/phase7-goal-versions-199.json"],
  ["goal-conversions", "evidence/phase7-goal-conversions-201.json"],
  ["daily-aggregates", "evidence/phase7-daily-aggregates-202.json"],
  ["aggregate-privacy", "evidence/phase7-aggregate-privacy-203.json"],
  ["measurement-retention", "evidence/phase7-retention-204.json"],
  ["feedback-retention", "evidence/phase7-feedback-retention-205.json"],
  ["jobs", "evidence/phase7-due-work-206.json"],
  ["goal-activation", "evidence/phase7-goal-activation-200.json"],
  ["http-assembly", "evidence/phase7-http-assembly-207.json"],
  ["integrated", "evidence/phase7-integrated-208.json"],
].map(([id, path]) => Object.freeze({ id, path })));

export const PHASE7_GATE_REQUIRED_CHECKS = Object.freeze([
  "validation-ready", "toolchain", "consent", "reactions", "ratings", "feedback", "moderation", "suppression",
  "summaries", "events", "event-facts", "event-capabilities", "goal-versions", "goal-conversions",
  "daily-aggregates", "aggregate-privacy", "measurement-retention", "feedback-retention", "jobs", "http-assembly",
  "integrated", "contract-verification", "tooling-tests", "gate-negative-tests", "architecture", "route-inventory",
  "runtime-boundary", "runtime-architecture", "lint", "typecheck", "production-build",
]);

export function sanitizePhase7Output(value, { workspace = "", temporary = process.env.TEMP ?? "", environment = process.env } = {}) {
  const secrets = Object.entries(environment)
    .filter(([name, secret]) => /(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SERVICE_ROLE_KEY)/iu.test(name) && typeof secret === "string" && secret.length >= 6)
    .map(([, secret]) => secret);
  return sanitizeEvidenceOutput(String(value ?? ""), { workspace, temporary, secrets });
}

const SUITES = Object.freeze({
  contracts: ["integrated"],
  interactions: ["reactions", "ratings", "summaries"],
  moderation: ["feedback", "moderation", "suppression", "feedback-retention"],
  measurement: ["consent", "events", "event-facts", "event-capabilities", "goal-versions", "goal-conversions", "daily-aggregates", "aggregate-privacy", "measurement-retention", "jobs"],
  integrated: ["integrated"],
  http: ["http-assembly"],
  architecture: ["integrated"],
  gate: ["integrated"],
});

function criteriaFor(number) {
  if (number <= 4) return [...SUITES.contracts, ...SUITES.interactions, ...SUITES.integrated];
  if (number <= 17) return [...SUITES.interactions, "consent", "integrated"];
  if (number <= 29) return [...SUITES.moderation, "integrated"];
  if (number <= 40) return ["consent", "events", "event-facts", "event-capabilities", "integrated"];
  if (number <= 47) return ["goal-versions", "goal-activation", "goal-conversions", "integrated"];
  if (number <= 53) return ["daily-aggregates", "aggregate-privacy", "integrated"];
  if (number <= 63) return ["measurement-retention", "feedback-retention", "jobs", "integrated"];
  if (number <= 68) return [...SUITES.http, "integrated"];
  if (number === 69) return ["integrated", "contract-verification", "route-inventory", "architecture", "runtime-boundary", "runtime-architecture", "typecheck", "production-build"];
  return ["integrated", "validation-ready", "tooling-tests", "gate-negative-tests"];
}

export const PHASE7_GATE_CRITERION_MATRIX = Object.freeze(Array.from({ length: 70 }, (_, index) => {
  const number = index + 1;
  return Object.freeze({ id: `P7-${String(number).padStart(2, "0")}`, suites: Object.freeze([...new Set(criteriaFor(number))]) });
}));

export const PHASE7_GATE_SCENARIOS = Object.freeze([
  { id: "scenario-02-locale-safety", suites: ["summaries", "feedback", "integrated"] },
  { id: "scenario-05-lifecycle-retention", suites: ["summaries", "moderation", "suppression", "feedback-retention", "integrated"] },
  { id: "scenario-10-interaction-deduplication", suites: ["reactions", "ratings", "integrated"] },
  { id: "scenario-11-moderation-privacy", suites: ["feedback", "moderation", "suppression", "feedback-retention", "integrated"] },
  { id: "scenario-13-arabic-boundary", suites: ["summaries", "feedback", "http-assembly", "integrated"] },
  { id: "scenario-14-lab-exclusion", suites: ["http-assembly", "integrated"] },
  { id: "scenario-15-phase7-degraded-dependencies", suites: ["jobs", "http-assembly", "integrated"] },
]);

const parseJson = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };
const counts = (report) => report?.required ?? report?.focusedAcceptance ?? report?.counts ?? {};
const cleanupPassed = (report) => report?.cleanup === true || report?.cleanup?.success === true;

export function readPhase7GateEvidence(root, startedAt, sourceRevision, sourceTreeSha256, gateRunId) {
  const gateStart = Date.parse(startedAt);
  return PHASE7_GATE_COMPONENTS.map((component) => {
    const path = join(root, component.path);
    const report = parseJson(path);
    let fresh = false;
    let sha256 = null;
    try {
      const stat = statSync(path);
      fresh = Number.isFinite(gateStart) && stat.mtimeMs >= gateStart;
      sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch { /* missing evidence is rejected below */ }
    const required = counts(report);
    const sourceBound = report?.sourceRevision === sourceRevision && report?.sourceTreeSha256 === sourceTreeSha256 && report?.gateRunId === gateRunId;
    const positiveExecution = Number(required?.passed ?? required?.executed ?? 0) > 0;
    const aggregateSuccess = required?.success === true && Number(required?.failed ?? 0) === 0 &&
      Number(required?.skipped ?? required?.requiredSkipped ?? 0) === 0 && Number(required?.failedSuites ?? 0) === 0;
    const cleanup = cleanupPassed(report);
    return Object.freeze({ id: component.id, path: component.path, runId: report?.runId ?? null,
      sourceRevision: report?.sourceRevision ?? null, sourceTreeSha256: report?.sourceTreeSha256 ?? null, gateRunId: report?.gateRunId ?? null,
      sha256, fresh, sourceBound, positiveExecution, aggregateSuccess, cleanup,
      accepted: Boolean(report && fresh && sourceBound && positiveExecution && aggregateSuccess && cleanup),
      required: { success: required?.success ?? null, passed: required?.passed ?? required?.executed ?? null,
        failed: required?.failed ?? null, skipped: required?.skipped ?? required?.requiredSkipped ?? null,
        failedSuites: required?.failedSuites ?? null },
      migrations: Array.isArray(report?.migrations) ? report.migrations.map(({ name, sha256: checksum }) => ({ name, sha256: checksum })) : [],
      toolVersions: report?.tools ?? report?.toolVersions ?? null,
      databaseRoles: report?.databaseRoles ?? report?.roles ?? report?.roleFlags ?? null,
      boundedPlans: report?.boundedPlans ?? report?.queryPlans ?? null,
      routes: report?.routes ?? null,
      criterionIds: Array.isArray(report?.criteria) ? report.criteria.map((item) => typeof item === "string" ? item : item?.id).filter(Boolean) : [],
    });
  });
}

export function evaluatePhase7Gate({ runId, startedAt, sourceRevision, sourceTreeSha256, runtime, expectedRuntime,
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
  for (const name of PHASE7_GATE_REQUIRED_CHECKS) {
    const check = checksByName.get(name);
    if (check?.executed !== true || check?.passed !== true || check?.exitCode !== 0 || check?.skipped !== 0 || check?.aggregateSuccess === false) {
      failures.push(`required-check-failed:${name}`);
    }
  }
  if ((checks ?? []).some((check) => check?.timedOut === true)) failures.push("check-timeout");

  const artifactsById = new Map((evidenceArtifacts ?? []).map((artifact) => [artifact?.id, artifact]));
  const evidenceAccepted = (id) => artifactsById.get(id)?.accepted === true ||
    (checksByName.get(id)?.executed === true && checksByName.get(id)?.passed === true && checksByName.get(id)?.exitCode === 0 && checksByName.get(id)?.skipped === 0);
  for (const component of PHASE7_GATE_COMPONENTS) {
    const artifact = artifactsById.get(component.id);
    if (!artifact?.accepted || !/^[a-f0-9]{64}$/iu.test(artifact?.sha256 ?? "") ||
        typeof artifact?.runId !== "string" || artifact.runId.length < 8 || artifact.gateRunId !== runId) failures.push(`required-evidence-invalid:${component.id}`);
  }

  const httpRoutes = artifactsById.get("http-assembly")?.routes;
  if (httpRoutes?.publicOperations !== 5 || httpRoutes?.ownerOperations !== 48 || httpRoutes?.operationalRoutes !== 2 ||
      httpRoutes?.runtimeRoutes !== 0 || httpRoutes?.phase7PublicMutations !== 4 || httpRoutes?.phase7OwnerOperations !== 7) {
    failures.push("http-operation-boundary-evidence-incomplete");
  }

  const criterionIds = new Set(PHASE7_GATE_CRITERION_MATRIX.map(({ id }) => id));
  if (PHASE7_GATE_CRITERION_MATRIX.length !== 70 || criterionIds.size !== 70 ||
      PHASE7_GATE_CRITERION_MATRIX.some(({ suites }) => !suites.length || suites.some((id) => !evidenceAccepted(id)))) {
    failures.push("criterion-coverage-incomplete-or-unexecuted");
  }
  if (PHASE7_GATE_SCENARIOS.length !== 7 || PHASE7_GATE_SCENARIOS.some(({ suites }) => !suites.length || suites.some((id) => !artifactsById.get(id)?.accepted))) {
    failures.push("domain-scenario-coverage-incomplete-or-unexecuted");
  }
  const integrated = serviceEvidence;
  const requiredPrincipals = new Set((integrated?.restrictedAccess?.matrix ?? []).map((entry) => entry?.grantee));
  const migrationChecksumsValid = Array.isArray(integrated?.migrations) && integrated.migrations.length > 0 &&
    integrated.migrations.every((migration) => typeof migration?.name === "string" && /^[a-f0-9]{64}$/iu.test(migration?.sha256 ?? ""));
  const boundedPlansValid = Array.isArray(integrated?.queryPlans?.plans) && integrated.queryPlans.plans.length >= 5 &&
    integrated.queryPlans.plans.every((plan) => Array.isArray(plan?.indexes) && plan.indexes.length > 0);
  if (integrated?.ticket !== 208 || integrated?.required?.success !== true || integrated.required.passed !== 10 ||
      integrated.required.failed !== 0 || integrated.required.skipped !== 0 || integrated.required.failedSuites !== 0 ||
      integrated?.cleanup !== true || integrated?.cleanUpgrade?.equivalent !== true ||
      integrated?.cleanUpgrade?.generatedTypesVerified?.length !== 2 ||
      !Array.isArray(integrated?.restrictedAccess?.matrix) || integrated.restrictedAccess.matrix.length === 0 ||
      !["anon", "authenticated", "service_role"].every((role) => requiredPrincipals.has(role)) ||
      typeof integrated?.restrictedAccess?.privateSentinel !== "string" || !integrated.restrictedAccess.privateSentinel.includes("absent") ||
      !boundedPlansValid || !migrationChecksumsValid || typeof integrated?.postgresVersion !== "string") {
    failures.push("integrated-postgres-auth-privacy-plan-evidence-incomplete");
  }

  return { ticket: 209, runId, startedAt, sourceRevision, sourceTreeSha256, runtime, expectedRuntime,
    required: { success: failures.length === 0, passed: (checks ?? []).filter((check) => check?.passed === true).length,
      failed: failures.length, skipped: (checks ?? []).reduce((sum, check) => sum + Number(check?.skipped ?? 0), 0),
      failedSuites: (checks ?? []).filter((check) => check?.aggregateSuccess === false || check?.passed !== true).length },
    counts: { components: evidenceArtifacts?.length ?? 0, acceptedComponents: (evidenceArtifacts ?? []).filter((item) => item?.accepted).length,
      criterionCount: PHASE7_GATE_CRITERION_MATRIX.length, executedCriteria: PHASE7_GATE_CRITERION_MATRIX.filter(({ suites }) => suites.every(evidenceAccepted)).length,
      scenarioCount: PHASE7_GATE_SCENARIOS.length },
    failures, verdict: failures.length === 0 ? "pass" : "fail",
    criteria: PHASE7_GATE_CRITERION_MATRIX.map((item) => ({ ...item, evidence: item.suites.map((id) => artifactsById.get(id)?.runId ?? checksByName.get(id)?.runId ?? null) })),
    scenarios: PHASE7_GATE_SCENARIOS.map((item) => ({ ...item, executed: item.suites.every((id) => artifactsById.get(id)?.accepted) })),
    components: evidenceArtifacts, checks, serviceEvidence: integrated,
    statusLayers: { localRequiredAcceptance: failures.length === 0 ? "passed" : "failed",
      broadSuite: "not-run-by-phase7-gate; environment-gated skips are outside required focused acceptance",
      hostedCi: "reported separately from local acceptance after PR checks run",
      humanApproval: "separate required review condition" },
    guarantees: { sourceBound: evidenceArtifacts?.every((item) => item.sourceBound) === true,
      freshEvidence: evidenceArtifacts?.every((item) => item.fresh && item.accepted) === true,
      zeroRequiredSkips: failures.length === 0 && (checks ?? []).every((item) => item.skipped === 0),
      successfulCleanup: evidenceArtifacts?.every((item) => item.cleanup) === true } };
}
