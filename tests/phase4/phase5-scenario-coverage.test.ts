import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateIntegratedScenarioEvidence,
  invalidateIntegratedScenarioReport,
  PHASE5_SCENARIO_COVERAGE,
  PHASE5_STORY_COVERAGE,
  validateScenarioCoverage,
} from "../../scripts/phase5-scenario-coverage.mjs";

describe("Phase 5 integrated scenario evidence", () => {
  it("invalidates an earlier constituent report before a new attempt", () => {
    const directory = mkdtempSync(join(tmpdir(), "phase5-evidence-invalidation-"));
    const path = join(directory, "previous-pass.json");
    try {
      writeFileSync(path, "{\"verdict\":\"pass\"}", "utf8");
      expect(existsSync(path)).toBe(true);
      invalidateIntegratedScenarioReport(path);
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("maps all user stories and required scenarios to executable assertions and owning tickets", () => {
    const validation = validateScenarioCoverage();

    expect(validation).toEqual({ valid: true, missingStories: [], missingScenarios: [], invalidEntries: [] });
    expect(PHASE5_STORY_COVERAGE.map((entry) => entry.id)).toEqual(Array.from({ length: 54 }, (_, index) => index + 1));
    expect(PHASE5_SCENARIO_COVERAGE.map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 14, 15]);
    for (const entry of [...PHASE5_STORY_COVERAGE, ...PHASE5_SCENARIO_COVERAGE]) {
      expect(entry.tickets.length, `ticket mapping for ${entry.id}`).toBeGreaterThan(0);
      expect(entry.assertions.length, `assertion mapping for ${entry.id}`).toBeGreaterThan(0);
    }
    expect(PHASE5_STORY_COVERAGE.find((entry) => entry.id === 14)?.assertions[0]).toContain("publishes reviewed Achievements with internal or public evidence");
    expect(PHASE5_STORY_COVERAGE.find((entry) => entry.id === 42)?.assertions[0]).toContain("publishes reviewed Achievements with internal or public evidence");
    expect(PHASE5_STORY_COVERAGE.find((entry) => entry.id === 15)?.assertions[0]).toContain("publishes minimal Testimonials with explicit associations");
    expect(PHASE5_STORY_COVERAGE.find((entry) => entry.id === 16)?.assertions[0]).toBe(PHASE5_STORY_COVERAGE.find((entry) => entry.id === 15)?.assertions[0]);
    expect(validateScenarioCoverage(PHASE5_STORY_COVERAGE.slice(1), PHASE5_SCENARIO_COVERAGE).missingStories).toContain(1);
    expect(validateScenarioCoverage(PHASE5_STORY_COVERAGE, PHASE5_SCENARIO_COVERAGE.slice(1)).missingScenarios).toContain(1);
    const nonexistentAssertion = PHASE5_STORY_COVERAGE.map((entry, index) => index === 0
      ? { ...entry, assertions: ["tests/database/content-authoring.integration.test.ts :: this assertion does not exist"] }
      : entry);
    expect(validateScenarioCoverage(nonexistentAssertion, PHASE5_SCENARIO_COVERAGE).invalidEntries).toContain("entry 1");
  });

  it("rejects incomplete or stale focused evidence and accepts only zero-skip fresh results", () => {
    const startedAt = "2026-10-10T00:00:00.000Z";
    const sourceTreeSha256 = "c".repeat(64);
    const evidence = {
      authoring: { suite: "authoring", runId: "authoring-run", startedAt, verdict: "pass", sourceRevision: "a".repeat(40), sourceTreeSha256, scenarioAcceptance: true, counts: { executed: 12, failed: 0, skipped: 0, total: 12 } },
      taxonomy: { suite: "taxonomy", runId: "taxonomy-run", startedAt, verdict: "pass", sourceRevision: "a".repeat(40), sourceTreeSha256, scenarioAcceptance: true, counts: { executed: 4, failed: 0, skipped: 0, total: 4 } },
      traceability: { suite: "traceability", runId: "traceability-run", startedAt, verdict: "pass", sourceRevision: "a".repeat(40), sourceTreeSha256, scenarioAcceptance: true, counts: { executed: 30, failed: 0, skipped: 0, total: 30 }, details: { files: ["tests/architecture/architecture.test.ts", "tests/phase4/phase5-verification.test.ts"] } },
      owner: { ticket: 122, runId: "owner-run", startedAt, sourceRevision: "a".repeat(40), sourceTreeSha256, databaseIntegrationTestsPassed: 2, skippedCases: 0, cleanUpgradeEquivalent: true },
      database: { ticket: 123, runId: "database-run", startedAt, sourceRevision: "a".repeat(40), sourceTreeSha256, databaseIntegrationTestsPassed: 40, skippedCases: 0, cleanUpgradeEquivalent: true, generatedTypeDrift: false },
    };

    expect(evaluateIntegratedScenarioEvidence(evidence, "a".repeat(40), sourceTreeSha256)).toMatchObject({
      verdict: "pass",
      counts: { executed: 88, failed: 0, skipped: 0 },
      constituents: [
        expect.objectContaining({ name: "authoring", runId: "authoring-run", startedAt, sourceRevision: "a".repeat(40), sourceTreeSha256 }),
        expect.objectContaining({ name: "taxonomy", runId: "taxonomy-run", startedAt, sourceRevision: "a".repeat(40), sourceTreeSha256 }),
        expect.objectContaining({ name: "traceability", runId: "traceability-run", startedAt, sourceRevision: "a".repeat(40), sourceTreeSha256 }),
        expect.objectContaining({ name: "owner", runId: "owner-run", startedAt, sourceRevision: "a".repeat(40), sourceTreeSha256 }),
        expect.objectContaining({ name: "database", runId: "database-run", startedAt, sourceRevision: "a".repeat(40), sourceTreeSha256 }),
      ],
    });
    expect(evaluateIntegratedScenarioEvidence({ ...evidence, taxonomy: { ...evidence.taxonomy, sourceRevision: "b".repeat(40) } }, "a".repeat(40), sourceTreeSha256).verdict).toBe("pass");
    expect(evaluateIntegratedScenarioEvidence({ ...evidence, taxonomy: { ...evidence.taxonomy, sourceRevision: "not-a-commit" } }, "a".repeat(40), sourceTreeSha256).verdict).toBe("fail");
    expect(evaluateIntegratedScenarioEvidence({ ...evidence, taxonomy: { ...evidence.taxonomy, sourceTreeSha256: "d".repeat(64) } }, "a".repeat(40), sourceTreeSha256).verdict).toBe("fail");
    expect(evaluateIntegratedScenarioEvidence({ ...evidence, owner: { ...evidence.owner, skippedCases: 1 } }, "a".repeat(40), sourceTreeSha256).verdict).toBe("fail");
    expect(evaluateIntegratedScenarioEvidence({ ...evidence, owner: { ...evidence.owner, runId: undefined } }, "a".repeat(40), sourceTreeSha256).verdict).toBe("fail");
    expect(evaluateIntegratedScenarioEvidence({ ...evidence, authoring: { ...evidence.authoring, counts: { executed: 0, failed: 0, skipped: 0, total: 0 } } }, "a".repeat(40), sourceTreeSha256).verdict).toBe("fail");
    expect(evaluateIntegratedScenarioEvidence({ ...evidence, traceability: { ...evidence.traceability, details: { files: [] } } }, "a".repeat(40), sourceTreeSha256).verdict).toBe("fail");
    expect(evaluateIntegratedScenarioEvidence({ ...evidence, traceability: { ...evidence.traceability, details: { files: ["tests/architecture/architecture.test.ts"] } } }, "a".repeat(40), sourceTreeSha256).verdict).toBe("fail");
  });
});
