import { describe, expect, it } from "vitest";
import {
  evaluateIntegratedScenarioEvidence,
  PHASE5_SCENARIO_COVERAGE,
  PHASE5_STORY_COVERAGE,
  validateScenarioCoverage,
} from "../../scripts/phase5-scenario-coverage.mjs";

describe("Phase 5 integrated scenario evidence", () => {
  it("maps all user stories and required scenarios to executable assertions and owning tickets", () => {
    const validation = validateScenarioCoverage();

    expect(validation).toEqual({ valid: true, missingStories: [], missingScenarios: [], invalidEntries: [] });
    expect(PHASE5_STORY_COVERAGE.map((entry) => entry.id)).toEqual(Array.from({ length: 54 }, (_, index) => index + 1));
    expect(PHASE5_SCENARIO_COVERAGE.map((entry) => entry.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 14, 15]);
    for (const entry of [...PHASE5_STORY_COVERAGE, ...PHASE5_SCENARIO_COVERAGE]) {
      expect(entry.tickets.length, `ticket mapping for ${entry.id}`).toBeGreaterThan(0);
      expect(entry.assertions.length, `assertion mapping for ${entry.id}`).toBeGreaterThan(0);
    }
    expect(validateScenarioCoverage(PHASE5_STORY_COVERAGE.slice(1), PHASE5_SCENARIO_COVERAGE).missingStories).toContain(1);
    expect(validateScenarioCoverage(PHASE5_STORY_COVERAGE, PHASE5_SCENARIO_COVERAGE.slice(1)).missingScenarios).toContain(1);
    const nonexistentAssertion = PHASE5_STORY_COVERAGE.map((entry, index) => index === 0
      ? { ...entry, assertions: ["tests/database/content-authoring.integration.test.ts :: this assertion does not exist"] }
      : entry);
    expect(validateScenarioCoverage(nonexistentAssertion, PHASE5_SCENARIO_COVERAGE).invalidEntries).toContain("entry 1");
  });

  it("rejects incomplete or stale focused evidence and accepts only zero-skip fresh results", () => {
    const startedAt = "2026-10-10T00:00:00.000Z";
    const evidence = {
      authoring: { suite: "authoring", runId: "authoring-run", startedAt, verdict: "pass", sourceRevision: "a".repeat(40), scenarioAcceptance: true, counts: { executed: 12, failed: 0, skipped: 0, total: 12 } },
      taxonomy: { suite: "taxonomy", runId: "taxonomy-run", startedAt, verdict: "pass", sourceRevision: "a".repeat(40), scenarioAcceptance: true, counts: { executed: 4, failed: 0, skipped: 0, total: 4 } },
      owner: { ticket: 122, runId: "owner-run", startedAt, sourceRevision: "a".repeat(40), databaseIntegrationTestsPassed: 2, skippedCases: 0, cleanUpgradeEquivalent: true },
      database: { ticket: 123, runId: "database-run", startedAt, sourceRevision: "a".repeat(40), databaseIntegrationTestsPassed: 40, skippedCases: 0, cleanUpgradeEquivalent: true, generatedTypeDrift: false },
    };

    expect(evaluateIntegratedScenarioEvidence(evidence, "a".repeat(40))).toMatchObject({
      verdict: "pass",
      counts: { executed: 58, failed: 0, skipped: 0 },
      constituents: [
        expect.objectContaining({ name: "authoring", runId: "authoring-run", startedAt, sourceRevision: "a".repeat(40) }),
        expect.objectContaining({ name: "taxonomy", runId: "taxonomy-run", startedAt, sourceRevision: "a".repeat(40) }),
        expect.objectContaining({ name: "owner", runId: "owner-run", startedAt, sourceRevision: "a".repeat(40) }),
        expect.objectContaining({ name: "database", runId: "database-run", startedAt, sourceRevision: "a".repeat(40) }),
      ],
    });
    expect(evaluateIntegratedScenarioEvidence({ ...evidence, taxonomy: { ...evidence.taxonomy, sourceRevision: "b".repeat(40) } }, "a".repeat(40)).verdict).toBe("fail");
    expect(evaluateIntegratedScenarioEvidence({ ...evidence, owner: { ...evidence.owner, skippedCases: 1 } }, "a".repeat(40)).verdict).toBe("fail");
    expect(evaluateIntegratedScenarioEvidence({ ...evidence, owner: { ...evidence.owner, runId: undefined } }, "a".repeat(40)).verdict).toBe("fail");
    expect(evaluateIntegratedScenarioEvidence({ ...evidence, authoring: { ...evidence.authoring, counts: { executed: 0, failed: 0, skipped: 0, total: 0 } } }, "a".repeat(40)).verdict).toBe("fail");
  });
});
