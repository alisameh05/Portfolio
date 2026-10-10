import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const EVIDENCE_DIR = join(ROOT, "evidence");
const STORY_ASSERTION = "tests/database/content-authoring.integration.test.ts :: publication, lifecycle, route, evidence and retry assertions";
const OWNER_ASSERTION = "tests/database/owner-composition.integration.test.ts :: real Owner and public-query workflow through production composition";
const DISCOVERY_ASSERTION = "tests/database/phase5-security.integration.test.ts :: scoped public discovery and restricted-principal assertions";
const SECURITY_ASSERTION = "tests/database/phase5-security.integration.test.ts :: private-content, RLS and pooled-scope assertions";
const AUTHORIZATION_ASSERTION = "tests/database/owner-composition.integration.test.ts :: Owner handlers and histories through production assembly";
const TAXONOMY_ASSERTION = "tests/database/owner-composition.integration.test.ts :: assignment, rename, retirement and merge history";
const ROUTE_ASSERTION = "tests/database/content-authoring.integration.test.ts :: durable route reservation and lifecycle assertions";

const group = (ids, tickets, assertion) => ids.map((id) => ({ id, tickets, assertions: [assertion] }));

export const PHASE5_STORY_COVERAGE = Object.freeze([
  ...group([1, 2, 3, 4, 5, 6, 7, 8, 9], [109, 110, 111], STORY_ASSERTION),
  ...group([10, 11], [111, 121], DISCOVERY_ASSERTION),
  ...group([12, 13], [111], STORY_ASSERTION),
  ...group([14], [112], STORY_ASSERTION),
  ...group([15, 16], [113], STORY_ASSERTION),
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
  ...group([42], [112], STORY_ASSERTION),
  ...group([43], [109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122], AUTHORIZATION_ASSERTION),
  ...group([44, 45, 46], [109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120], STORY_ASSERTION),
  ...group([47], [123], SECURITY_ASSERTION),
  ...group([48], [109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121], STORY_ASSERTION),
  ...group([49], [106, 111, 114], "tests/database/content-authoring.integration.test.ts :: preserves last valid publication when required acceptance facts fail; optional delivery services are outside this phase's runtime dependency graph"),
  ...group([50], [106, 122], "tests/phase4/phase5-verification.test.ts :: Phase 5 route, architecture, contract and public-boundary verification"),
  ...group([51], [123], SECURITY_ASSERTION),
  ...group([52], [106, 109, 110, 111, 112, 113, 114, 115, 118, 119, 120], STORY_ASSERTION),
  ...group([53], [124, 125], "tests/phase4/phase5-scenario-coverage.test.ts :: fresh zero-skip evidence aggregation rejects incomplete constituents"),
  ...group([54], [106, 124], "tests/phase4/phase5-verification.test.ts :: executable boundary inventory rejects Lab and frontend surfaces"),
]);

export const PHASE5_SCENARIO_COVERAGE = Object.freeze([
  { id: 1, tickets: [111, 112, 113], assertions: ["tests/database/content-authoring.integration.test.ts :: publishes English and Arabic independently and preserves first publication time"] },
  { id: 2, tickets: [121], assertions: ["tests/phase5/taxonomy/public-discovery.test.ts :: rejects cross-locale cursors", DISCOVERY_ASSERTION] },
  { id: 3, tickets: [111, 114], assertions: ["tests/database/content-authoring.integration.test.ts :: preserves the last valid locale and both projections when a replacement is rejected"] },
  { id: 4, tickets: [115], assertions: ["tests/database/content-authoring.integration.test.ts :: corrects candidate collisions and resolves A to B to C to A directly under one durable route identity"] },
  { id: 5, tickets: [114, 117, 121], assertions: ["tests/database/content-authoring.integration.test.ts :: hides, archives, and restores all three content kinds through atomic owner lifecycle commands", DISCOVERY_ASSERTION], deferred: "Phase 7 Reaction, Rating, Feedback, and aggregate behavior remains deferred." },
  { id: 6, tickets: [116, 121], assertions: ["tests/database/owner-composition.integration.test.ts :: keeps Project status and Featured independent of publication", DISCOVERY_ASSERTION] },
  { id: 7, tickets: [121], assertions: ["tests/database/phase5-security.integration.test.ts :: public discovery query plans and visibility-scoped Project projections"] },
  { id: 8, tickets: [118, 119, 120], assertions: ["tests/database/owner-composition.integration.test.ts :: assignment, rename, retirement, merge, deduplication and retained history"] },
  { id: 12, tickets: [110, 111, 112, 113, 114], assertions: ["tests/database/content-authoring.integration.test.ts :: rejects invalid evidence, review, and Media facts without creating public state"] },
  { id: 13, tickets: [110, 111], assertions: ["tests/database/content-authoring.integration.test.ts :: uses fixture-only accepted Media facts and fails closed when production facts are unresolved", DISCOVERY_ASSERTION], deferred: "Real Media processing and CV delivery are Phase 6 work." },
  { id: 14, tickets: [106, 124], assertions: ["tests/phase4/phase5-verification.test.ts :: executable Lab/frontend boundary inventory"] },
  { id: 15, tickets: [109, 111, 114, 124], assertions: ["tests/database/content-authoring.integration.test.ts :: required acceptance outage leaves public state unchanged", OWNER_ASSERTION], deferred: "External optional delivery implementations and full release/load/restore qualification remain deferred." },
]);

export const PHASE5_DEFERRED_SCOPE = Object.freeze([
  "Phase 6: real Media processing, revocation, storage delivery, and CV delivery.",
  "Phase 7: persisted Reactions, Ratings, Feedback, Moderation, and their public aggregates.",
  "Phase 8: production optional workers, exports, alerts, analytics pipelines, backups, and recovery automation.",
  "Phase 9-10 and release: deployed TestSprite, container publication, promotion, load/resilience, and measured backup restore RPO/RTO.",
  "Optional Media/link/analytics/alert delivery adapters are not Phase 5 runtime dependencies; publication acceptance facts remain required and fail closed.",
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
      entry.assertions.some((assertion) => typeof assertion !== "string" || !assertion.includes(" :: ") ||
        !existsSync(join(ROOT, assertion.split(" :: ", 1)[0])))
      ? [key] : [];
  });
  if (new Set(storyIds).size !== storyIds.length || new Set(scenarioIds).size !== scenarioIds.length) invalidEntries.push("duplicate IDs");
  return { valid: missingStories.length === 0 && missingScenarios.length === 0 && invalidEntries.length === 0, missingStories, missingScenarios, invalidEntries };
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function evaluateIntegratedScenarioEvidence(evidence, sourceRevision) {
  const requirements = [
    { key: "authoring", suite: "authoring" },
    { key: "taxonomy", suite: "taxonomy" },
    { key: "owner", ticket: 122 },
    { key: "database", ticket: 123 },
  ];
  const constituents = requirements.map((requirement) => {
    const report = evidence?.[requirement.key];
    const issues = [];
    if (!report || report.sourceRevision !== sourceRevision) issues.push("missing or stale source revision");
    if (requirement.suite !== undefined) {
      const counts = report?.counts;
      if (report?.suite !== requirement.suite || report?.verdict !== "pass" || report?.scenarioAcceptance !== true) issues.push("focused suite did not pass scenario acceptance");
      if (!counts || !nonnegativeInteger(counts.executed) || counts.executed === 0 || counts.failed !== 0 || counts.skipped !== 0 || counts.total !== counts.executed) issues.push("focused suite must execute with zero failures and skips");
    } else {
      if (report?.ticket !== requirement.ticket || !nonnegativeInteger(report?.databaseIntegrationTestsPassed) || report.databaseIntegrationTestsPassed === 0 || report?.skippedCases !== 0) issues.push("real PostgreSQL ticket suite is incomplete or skipped");
      if (report?.cleanUpgradeEquivalent !== true) issues.push("clean reset and upgrade are not equivalent");
      if (requirement.ticket === 123 && report?.generatedTypeDrift !== false) issues.push("generated database types are stale");
    }
    return {
      name: requirement.key,
      ticket: requirement.ticket ?? null,
      suite: requirement.suite ?? null,
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

export function buildIntegratedScenarioEvidence({ sourceRevision, evidence, runId = randomUUID(), startedAt = new Date().toISOString() }) {
  const evaluated = evaluateIntegratedScenarioEvidence(evidence, sourceRevision);
  return {
    schemaVersion: 1,
    runId,
    ticket: 124,
    parent: 106,
    sourceRevision,
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

function currentRevision() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

function run() {
  const coverage = validateScenarioCoverage();
  const sourceRevision = currentRevision();
  const evidence = {
    authoring: readJson("phase-5-verification-authoring.json"),
    taxonomy: readJson("phase-5-verification-taxonomy.json"),
    owner: readJson("phase-5-owner-composition-postgres.json"),
    database: readJson("phase-5-security-migrations-postgres.json"),
  };
  const report = buildIntegratedScenarioEvidence({ sourceRevision, evidence });
  const output = join(EVIDENCE_DIR, "phase-5-integrated-scenarios.json");
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ verdict: report.verdict, counts: report.counts, constituents: report.constituents, traceability: coverage, evidence: relative(ROOT, output) }, null, 2));
  return report.verdict === "pass" ? 0 : 1;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/phase5-scenario-coverage.mjs")) process.exitCode = run();
