import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const EVIDENCE_DIR = join(ROOT, "evidence");
const CONTENT = "tests/database/content-authoring.integration.test.ts";
const OWNER = "tests/database/owner-composition.integration.test.ts";
const SECURITY = "tests/database/phase5-security.integration.test.ts";
const VERIFICATION = "tests/phase4/phase5-verification.test.ts";
const STORY_ASSERTION = `${CONTENT} :: publishes English and Arabic independently, preserves first publication time, history, and the last valid projection`;
const OWNER_ASSERTION = `${OWNER} :: keeps the committed route and projection readable after optional delivery port failures`;
const DISCOVERY_ASSERTION = `${SECURITY} :: keeps private content private while the in-process discovery query returns only published approved projections`;
const SECURITY_ASSERTION = `${SECURITY} :: denies actual public, authenticated, worker, and backup logins direct access to private Phase 5 rows`;
const AUTHORIZATION_ASSERTION = OWNER_ASSERTION;
const TAXONOMY_ASSERTION = `${CONTENT} :: merges active values atomically across Projects, deduplicates survivors, preserves history, and replays the original receipt`;
const ROUTE_ASSERTION = `${CONTENT} :: corrects candidate collisions and resolves A to B to C to A directly under one durable route identity`;
const assertionRef = (file, title) => `${file} :: ${title}`;

const group = (ids, tickets, assertion) => ids.map((id) => ({ id, tickets, assertions: [assertion] }));

export const PHASE5_STORY_COVERAGE = Object.freeze([
  ...group([1, 2, 3, 4, 5, 6, 7, 8, 9], [109, 110, 111], STORY_ASSERTION),
  ...group([10, 11], [111, 121], DISCOVERY_ASSERTION),
  ...group([12, 13], [111], STORY_ASSERTION),
  ...group([14], [112], assertionRef(CONTENT, "publishes reviewed Achievements with internal or public evidence into a locale-specific ordered Timeline")),
  ...group([15, 16], [113], assertionRef(CONTENT, "publishes minimal Testimonials with explicit associations, localized review, and visibility-safe projections")),
  ...group([17, 18], [110, 111, 112, 113, 114], STORY_ASSERTION),
  ...group([19, 20, 21], [114], ROUTE_ASSERTION),
  ...group([22, 23], [114, 117, 121], DISCOVERY_ASSERTION),
  ...group([24, 25, 26], [115], ROUTE_ASSERTION),
  ...group([27], [110], AUTHORIZATION_ASSERTION),
  ...group([28, 29, 30], [116], OWNER_ASSERTION),
  ...group([31, 32], [117], DISCOVERY_ASSERTION),
  ...group([33, 34], [118], TAXONOMY_ASSERTION),
  ...group([35, 36], [119], TAXONOMY_ASSERTION),
  ...group([37, 38, 39], [120], TAXONOMY_ASSERTION),
  ...group([40, 41], [121], DISCOVERY_ASSERTION),
  ...group([42], [112], assertionRef(CONTENT, "publishes reviewed Achievements with internal or public evidence into a locale-specific ordered Timeline")),
  ...group([43], [109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122], AUTHORIZATION_ASSERTION),
  ...group([44, 45, 46], [109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120], STORY_ASSERTION),
  ...group([47], [123], SECURITY_ASSERTION),
  ...group([48], [109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121], STORY_ASSERTION),
  ...group([49], [106, 111, 114, 124], OWNER_ASSERTION),
  ...group([50], [106, 122], assertionRef(VERIFICATION, "declares separate focused suites for the five Phase 5 verification seams")),
  ...group([51], [123], SECURITY_ASSERTION),
  ...group([52], [106, 109, 110, 111, 112, 113, 114, 115, 118, 119, 120], STORY_ASSERTION),
  ...group([53], [124, 125], assertionRef("tests/phase4/phase5-scenario-coverage.test.ts", "rejects incomplete or stale focused evidence and accepts only zero-skip fresh results")),
  ...group([54], [106, 124], assertionRef("tests/architecture/architecture.test.ts", "must contain no Lab entry implementation in modules (ADR-0007)")),
]);

export const PHASE5_SCENARIO_COVERAGE = Object.freeze([
  { id: 1, tickets: [111, 112, 113], assertions: [STORY_ASSERTION] },
  { id: 2, tickets: [121], assertions: [assertionRef("tests/phase5/taxonomy/public-discovery.test.ts", "rejects malformed and cross-locale or cross-filter cursors"), DISCOVERY_ASSERTION] },
  { id: 3, tickets: [111, 114], assertions: [assertionRef(CONTENT, "preserves the last valid locale and both projections when a replacement is rejected")] },
  { id: 4, tickets: [115], assertions: [ROUTE_ASSERTION] },
  { id: 5, tickets: [114, 117, 121], assertions: [assertionRef(CONTENT, "hides, archives, and restores all three content kinds through atomic owner lifecycle commands"), DISCOVERY_ASSERTION], deferred: "Phase 7 Reaction, Rating, Feedback, and aggregate behavior remains deferred." },
  { id: 6, tickets: [116, 121], assertions: [assertionRef(CONTENT, "keeps Project status identities, histories, Featured state, and published projections atomic"), DISCOVERY_ASSERTION] },
  { id: 7, tickets: [121], assertions: [assertionRef(CONTENT, "queries only current published locale projections with stable tied-time cursors and controlled facets")] },
  { id: 8, tickets: [118, 119, 120], assertions: [TAXONOMY_ASSERTION] },
  { id: 12, tickets: [110, 111, 112, 113, 114], assertions: [assertionRef(CONTENT, "rejects invalid evidence, review, and Media facts without creating public state")] },
  { id: 13, tickets: [110, 111], assertions: [assertionRef(CONTENT, "uses fixture-only accepted Media facts and fails closed when production facts are unresolved"), DISCOVERY_ASSERTION], deferred: "Real Media processing and CV delivery are Phase 6 work." },
  { id: 14, tickets: [106, 124], assertions: [assertionRef("tests/architecture/architecture.test.ts", "must contain no Lab entry implementation in modules (ADR-0007)")] },
  { id: 15, tickets: [109, 111, 114, 124], assertions: [assertionRef(CONTENT, "rolls back route, pointer, projection, success receipt, and event after injected writes fail"), OWNER_ASSERTION], deferred: "Production optional worker integrations and full release/load/restore qualification remain deferred." },
]);

export const PHASE5_DEFERRED_SCOPE = Object.freeze([
  "Phase 6: real Media processing, revocation, storage delivery, and CV delivery.",
  "Phase 7: persisted Reactions, Ratings, Feedback, Moderation, and their public aggregates.",
  "Phase 8: production optional workers, exports, alerts, analytics pipelines, backups, and recovery automation.",
  "Phase 9-10 and release: deployed TestSprite, container publication, promotion, load/resilience, and measured backup restore RPO/RTO.",
  "Phase 5 passes a persisted publication event to injected Media, link, analytics, and alert delivery ports, confirms each failure, and verifies the outbox event, public Project route, and projection remain readable. Production dispatchers and worker integrations remain Phase 6/8 work; required publication acceptance facts remain fail closed.",
]);

const EXPECTED_SCENARIOS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 14, 15]);

export function validateScenarioCoverage(stories = PHASE5_STORY_COVERAGE, scenarios = PHASE5_SCENARIO_COVERAGE) {
  const storyIds = stories.map((entry) => entry?.id);
  const scenarioIds = scenarios.map((entry) => entry?.id);
  const missingStories = Array.from({ length: 54 }, (_, index) => index + 1).filter((id) => !storyIds.includes(id));
  const missingScenarios = EXPECTED_SCENARIOS.filter((id) => !scenarioIds.includes(id));
  const invalidEntries = [...stories, ...scenarios].flatMap((entry) => {
    const key = `entry ${String(entry?.id ?? "unknown")}`;
    return !Number.isSafeInteger(entry?.id) || !Array.isArray(entry?.tickets) || entry.tickets.length === 0 ||
      entry.tickets.some((ticket) => !Number.isSafeInteger(ticket) || ticket < 1) ||
      !Array.isArray(entry?.assertions) || entry.assertions.length === 0 ||
      entry.assertions.some((assertion) => {
        if (typeof assertion !== "string" || !assertion.includes(" :: ")) return true;
        const [file, title] = assertion.split(" :: ");
        const path = join(ROOT, file);
        if (!existsSync(path)) return true;
        const source = readFileSync(path, "utf8");
        return !source.includes(`it("${title}"`) && !source.includes(`test("${title}"`);
      })
      ? [key] : [];
  });
  if (new Set(storyIds).size !== storyIds.length || new Set(scenarioIds).size !== scenarioIds.length) invalidEntries.push("duplicate IDs");
  return { valid: missingStories.length === 0 && missingScenarios.length === 0 && invalidEntries.length === 0, missingStories, missingScenarios, invalidEntries };
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isSourceRevisionAncestor(revision, aggregateRevision) {
  if (revision === aggregateRevision) return true;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", revision, aggregateRevision], { cwd: ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function evaluateIntegratedScenarioEvidence(evidence, sourceRevision, sourceTreeSha256, isRevisionAncestor = isSourceRevisionAncestor) {
  const requirements = [
    { key: "authoring", suite: "authoring" },
    { key: "taxonomy", suite: "taxonomy" },
    { key: "traceability", suite: "traceability" },
    { key: "owner", ticket: 122 },
    { key: "database", ticket: 123 },
  ];
  const constituents = requirements.map((requirement) => {
    const report = evidence?.[requirement.key];
    const issues = [];
    if (!report || !/^[a-f0-9]{40}$/i.test(report.sourceRevision ?? "") || !isRevisionAncestor(report.sourceRevision, sourceRevision)) issues.push("missing, invalid, or unrelated source revision");
    if (typeof sourceTreeSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(sourceTreeSha256) || report?.sourceTreeSha256 !== sourceTreeSha256) issues.push("missing or stale source tree identity");
    if (typeof report?.runId !== "string" || report.runId.length === 0 || typeof report?.startedAt !== "string" || Number.isNaN(Date.parse(report.startedAt))) issues.push("missing focused run identity");
    if (requirement.suite !== undefined) {
      const counts = report?.counts;
      if (report?.suite !== requirement.suite || report?.verdict !== "pass" || report?.scenarioAcceptance !== true) issues.push("focused suite did not pass scenario acceptance");
      if (!counts || !nonnegativeInteger(counts.executed) || counts.executed === 0 || counts.failed !== 0 || counts.skipped !== 0 || counts.total !== counts.executed) issues.push("focused suite must execute with zero failures and skips");
      if (requirement.suite === "traceability") {
        if (!report?.details?.files?.includes("tests/architecture/architecture.test.ts")) issues.push("architecture assertions were not executed in the traceability suite");
        if (!report?.details?.files?.includes("tests/phase4/phase5-verification.test.ts")) issues.push("verification seam assertions were not executed in the traceability suite");
      }
    } else {
      if (report?.ticket !== requirement.ticket || !nonnegativeInteger(report?.databaseIntegrationTestsPassed) || report.databaseIntegrationTestsPassed === 0 || report?.skippedCases !== 0) issues.push("real PostgreSQL ticket suite is incomplete or skipped");
      if (report?.cleanUpgradeEquivalent !== true) issues.push("clean reset and upgrade are not equivalent");
      if (requirement.ticket === 123 && report?.generatedTypeDrift !== false) issues.push("generated database types are stale");
    }
    return {
      name: requirement.key,
      ticket: requirement.ticket ?? null,
      suite: requirement.suite ?? null,
      runId: report?.runId ?? null,
      startedAt: report?.startedAt ?? null,
      sourceRevision: report?.sourceRevision ?? null,
      sourceTreeSha256: report?.sourceTreeSha256 ?? null,
      verdict: issues.length === 0 ? "pass" : "fail",
      issues,
      counts: requirement.suite !== undefined
        ? { executed: report?.counts?.executed ?? 0, failed: report?.counts?.failed ?? 0, skipped: report?.counts?.skipped ?? 0, total: report?.counts?.total ?? 0 }
        : { executed: report?.databaseIntegrationTestsPassed ?? 0, failed: 0, skipped: report?.skippedCases ?? 0, total: report?.databaseIntegrationTestsPassed ?? 0 },
    };
  });
  const counts = constituents.reduce((total, item) => ({
    executed: total.executed + item.counts.executed,
    failed: total.failed + item.counts.failed,
    skipped: total.skipped + item.counts.skipped,
    total: total.total + item.counts.total,
  }), { executed: 0, failed: 0, skipped: 0, total: 0 });
  const coverage = validateScenarioCoverage();
  if (!coverage.valid) constituents.push({ name: "traceability", ticket: 124, suite: null, verdict: "fail", issues: ["scenario traceability matrix is incomplete"], counts: { executed: 0, failed: 1, skipped: 0, total: 1 } });
  return {
    verdict: constituents.every((item) => item.verdict === "pass") ? "pass" : "fail",
    counts,
    constituents,
    coverage,
  };
}

function readJson(filename) {
  try { return JSON.parse(readFileSync(join(EVIDENCE_DIR, filename), "utf8")); } catch { return null; }
}

export function buildIntegratedScenarioEvidence({ sourceRevision, sourceTreeSha256, evidence, runId = randomUUID(), startedAt = new Date().toISOString() }) {
  const evaluated = evaluateIntegratedScenarioEvidence(evidence, sourceRevision, sourceTreeSha256);
  return {
    schemaVersion: 1,
    runId,
    ticket: 124,
    parent: 106,
    sourceRevision,
    sourceTreeSha256,
    startedAt,
    verdict: evaluated.verdict,
    scenarioAcceptance: evaluated.verdict === "pass",
    counts: evaluated.counts,
    constituents: evaluated.constituents,
    coverage: { userStories: PHASE5_STORY_COVERAGE, scenarios: PHASE5_SCENARIO_COVERAGE },
    deferred: PHASE5_DEFERRED_SCOPE,
    reproduction: [
      "npm run phase5:focus:authoring-review-publication-routes",
      "npm run phase5:focus:taxonomy-status-relationships-discovery",
      "npm run phase5:focus:owner-adapters-composition",
      "npm run phase5:focus:database-rls-migrations-concurrency",
      "npm run phase5:focus:integrated-scenarios",
    ],
    cleanup: "Each PostgreSQL constituent creates isolated loopback projects and scoped roles, then verifies cleanup.",
  };
}

export function invalidateIntegratedEvidence(path) {
  try {
    unlinkSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function invalidateSuiteEvidence(suite) {
  const files = {
    authoring: ["phase-5-verification-authoring.json"],
    taxonomy: ["phase-5-verification-taxonomy.json"],
    traceability: ["phase-5-verification-traceability.json"],
    owner: ["phase-5-owner-composition-postgres.json"],
    database: ["phase-5-verification-database.json", "phase-5-security-migrations-postgres.json"],
  }[suite];
  if (files === undefined) throw new Error("PHASE5_EVIDENCE_SUITE_INVALID");
  for (const filename of files) invalidateIntegratedEvidence(join(EVIDENCE_DIR, filename));
}

export function invalidateIntegratedScenarioReport(path = join(EVIDENCE_DIR, "phase-5-integrated-scenarios.json")) {
  invalidateIntegratedEvidence(path);
}

function currentRevision() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

function run() {
  const coverage = validateScenarioCoverage();
  const sourceRevision = currentRevision();
  const sourceTreeSha256 = workingTreeSourceSha256();
  const evidence = {
    authoring: readJson("phase-5-verification-authoring.json"),
    taxonomy: readJson("phase-5-verification-taxonomy.json"),
    traceability: readJson("phase-5-verification-traceability.json"),
    owner: readJson("phase-5-owner-composition-postgres.json"),
    database: readJson("phase-5-security-migrations-postgres.json"),
  };
  const report = buildIntegratedScenarioEvidence({ sourceRevision, sourceTreeSha256, evidence });
  const output = join(EVIDENCE_DIR, "phase-5-integrated-scenarios.json");
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ verdict: report.verdict, counts: report.counts, constituents: report.constituents, traceability: coverage, evidence: relative(ROOT, output) }, null, 2));
  return report.verdict === "pass" ? 0 : 1;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/phase5-scenario-coverage.mjs")) {
  if (process.argv[2] === "--invalidate-suite") {
    try {
      invalidateSuiteEvidence(process.argv[3]);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "PHASE5_EVIDENCE_INVALIDATION_FAILED");
      process.exitCode = 2;
    }
  } else if (process.argv[2] === "--invalidate-integrated") {
    try {
      invalidateIntegratedScenarioReport();
    } catch (error) {
      console.error(error instanceof Error ? error.message : "PHASE5_EVIDENCE_INVALIDATION_FAILED");
      process.exitCode = 2;
    }
  } else process.exitCode = run();
}
