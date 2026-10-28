import { describe, expect, it } from "vitest";
import { PHASE7_DUE_WORK_SCHEDULES } from "../../src/runtime/phase7-due-work.js";
import { addDays, makeFixture, now, otherPortfolioId, portfolioId, RETENTION_TYPES } from "./resumable-retention-passes.fixture.js";
describe("Phase 8 resumable retention policy passes (#248)", () => {
  it("publishes daily and catch-up invocations as UTC handoffs that remain uninstalled", () => {
    expect(PHASE7_DUE_WORK_SCHEDULES).toEqual([
      { name: "phase7-policy-daily", cadence: "daily", timezone: "UTC", invocation: "runDueWork",
        installed: false, maxCatchUpPeriods: 15, maxClaimsPerPhase: 1_000 },
      { name: "phase7-policy-catch-up", cadence: "on-incomplete-or-missed-period", timezone: "UTC", invocation: "runDueWork",
        installed: false, maxCatchUpPeriods: 15, maxClaimsPerPhase: 1_000 },
    ]);
  });

  it("deduplicates the same Portfolio/type/due-period across restarts and bounds catch-up", async () => {
    const fixture = makeFixture();
    const first = await fixture.makeService(portfolioId).runDueWork({ workerId: "first-worker", maxClaimsPerPhase: 1 });
    const second = await fixture.makeService(portfolioId).runDueWork({ workerId: "restarted-worker", maxClaimsPerPhase: 1 });
    const other = await fixture.makeService(otherPortfolioId).runDueWork({ workerId: "other-portfolio", maxClaimsPerPhase: 1 });

    expect(first).toMatchObject({ ok: true, value: { scheduled: 60, incompleteBacklog: true, incomplete: true } });
    expect(second).toMatchObject({ ok: true, value: { scheduled: 0, deduplicated: 0, incompleteBacklog: true } });
    expect(other).toMatchObject({ ok: true, value: { scheduled: 60, incompleteBacklog: true } });
    expect(fixture.rows.size).toBe(120);
    expect(new Set([...fixture.rows.values()].map(row => `${row.semanticSchedule.portfolioId}:${row.payload.type}:${row.semanticSchedule.period}`)).size).toBe(120);
    expect([...fixture.rows.values()].filter(row => row.semanticSchedule.portfolioId === portfolioId)
      .every(row => row.semanticSchedule.period >= "2026-10-12" && row.semanticSchedule.period <= "2026-10-26")).toBe(true);
    expect([...fixture.rows.values()].some(row => row.payload.type === "measurement.daily-aggregate.v1" && row.semanticSchedule.portfolioId === portfolioId)).toBe(false);
  });

  it("resumes a bounded owner-module checkpoint with the same job identity and UTC anchor before aggregates", async () => {
    let detailBatches = 0;
    const fixture = makeFixture({ expireDetail: () => {
      detailBatches += 1;
      return { processedCount: detailBatches === 1 ? 100 : 1, nextCursor: detailBatches === 1 ? "durable-cursor" : null,
        incomplete: detailBatches === 1 };
    } });
    const first = await fixture.makeService(portfolioId).runDueWork({ workerId: "before-restart", maxClaimsPerPhase: 1 });
    const second = await fixture.makeService(portfolioId).runDueWork({ workerId: "after-restart", maxClaimsPerPhase: 1 });
    const detailEffects = fixture.effects.filter(effect => effect.kind === "detail-retention");

    expect(first).toMatchObject({ ok: true, value: { released: 1, incompleteBacklog: true } });
    expect(second).toMatchObject({ ok: true, value: { completed: 1, incompleteBacklog: true } });
    expect(detailEffects).toHaveLength(2);
    expect(detailEffects[0]?.command.actor.jobId).toBe(detailEffects[1]?.command.actor.jobId);
    expect(detailEffects[0]?.command.now).toBe("2026-10-12T00:00:00.000Z");
    expect(detailEffects[1]?.command.now).toBe(detailEffects[0]?.command.now);
    expect(fixture.effects.some(effect => effect.kind === "aggregate")).toBe(false);
  });

  it("keeps policy completion incomplete when a durable aggregate reports coverage gaps", async () => {
    const fixture = makeFixture({ aggregateDay: command => ({ processedCount: 0, nextCursor: null,
      incomplete: true, coverageIncomplete: command.now.startsWith("2026-10-26") }) });
    await fixture.makeService(portfolioId).runDueWork({ workerId: "coverage-retention" });
    const result = await fixture.makeService(portfolioId).runDueWork({ workerId: "coverage-aggregate" });

    expect(result).toMatchObject({ ok: true, value: { incompleteCoverage: true, incomplete: true,
      lastCompletePolicyPeriod: "2026-10-25", oldestOverduePeriod: "2026-10-26" } });
    const todayRows = [...fixture.rows.values()].filter(row => row.semanticSchedule.portfolioId === portfolioId &&
      row.semanticSchedule.period.startsWith("2026-10-26"));
    expect(todayRows.some(row => row.payload.type === "measurement.daily-aggregate.v1" && row.coverageIncomplete)).toBe(true);
    expect(fixture.effects.findIndex(effect => effect.kind === "feedback-retention"))
      .toBeLessThan(fixture.effects.findIndex(effect => effect.kind === "aggregate"));
  });

  it("reports shutdown before work as incomplete and preserves the bounded scheduled backlog", async () => {
    const fixture = makeFixture();
    const result = await fixture.makeService(portfolioId).runDueWork({ workerId: "stopping-worker", shouldStop: () => true });

    expect(result).toMatchObject({ ok: true, value: { scheduled: 60, claimed: 0,
      incompleteBacklog: true, incomplete: true, lastCompletePolicyPeriod: null, oldestOverduePeriod: "2026-10-12" } });
  });

  it("drains a twenty-day outage in contiguous bounded slices without losing the older completion watermark", async () => {
    let clock = "2026-10-01T12:00:00.000Z";
    const fixture = makeFixture({ clockNow: () => clock });
    const initialRetention = await fixture.makeService(portfolioId).runDueWork({ workerId: "before-outage-retention" });
    expect(initialRetention).toMatchObject({ ok: true, value: { incomplete: true, lastCompletePolicyPeriod: null } });
    const initialAggregation = await fixture.makeService(portfolioId).runDueWork({ workerId: "before-outage-aggregation" });
    expect(initialAggregation).toMatchObject({ ok: true, value: { incomplete: false, lastCompletePolicyPeriod: "2026-10-01" } });

    clock = "2026-10-21T12:00:00.000Z";
    const firstSlice = await fixture.makeService(portfolioId).runDueWork({ workerId: "outage-slice-one" });
    expect(firstSlice).toMatchObject({ ok: true, value: { scheduled: 60, incompleteBacklog: true,
      lastCompletePolicyPeriod: "2026-10-01" } });
    expect([...fixture.rows.values()].filter(row => row.payload.type === "measurement.daily-aggregate.v1")).toHaveLength(225);

    const secondSlice = await fixture.makeService(portfolioId).runDueWork({ workerId: "outage-slice-two" });
    expect(secondSlice).toMatchObject({ ok: true, value: { scheduled: 170, lastCompletePolicyPeriod: "2026-10-11" } });
    const thirdSlice = await fixture.makeService(portfolioId).runDueWork({ workerId: "outage-slice-three" });
    expect(thirdSlice).toMatchObject({ ok: true, value: { scheduled: 150, incomplete: false,
      lastCompletePolicyPeriod: "2026-10-21" } });

    const retentionPeriods = [...fixture.rows.values()].filter(row => row.payload.type === RETENTION_TYPES[0] &&
      row.semanticSchedule.portfolioId === portfolioId && row.semanticSchedule.period > "2026-10-01")
      .map(row => row.semanticSchedule.period).sort();
    expect(retentionPeriods).toEqual(Array.from({ length: 20 }, (_, index) => addDays("2026-10-01", index + 1)));
    expect(fixture.progressByPortfolio.get(portfolioId)?.complete).toBe("2026-10-21");
  });
});
