import { describe, expect, it } from "vitest";
import { createPhase7DueWorkService, PHASE7_DUE_WORK_SCHEDULES } from "../../src/runtime/phase7-due-work.js";
import type { LeasedJobRecord, Phase7ScheduleStatus, VersionedPayload } from "../../src/modules/portability-operations/index.js";
import type { MeasurementWorkCommand } from "../../src/modules/measurement/index.js";
import type { FeedbackWorkCommand } from "../../src/modules/interaction-moderation/index.js";
import type { StableId } from "../../src/shared/domain/index.js";

const portfolioId = "0196a1b2-7c3d-7e11-9f22-000000000001" as StableId<"Portfolio">;
const otherPortfolioId = "0196a1b2-7c3d-7e11-9f22-000000000002" as StableId<"Portfolio">;
const now = "2026-10-26T12:00:00.000Z";
type Row = {
  jobId: string;
  payload: VersionedPayload;
  availableAt: string;
  semanticSchedule: { portfolioId: StableId<"Portfolio">; period: string };
  status: "available" | "leased" | "completed" | "dead" | "failed";
  coverageIncomplete: boolean;
  attemptCount: number;
};
type Progress = { first: string; required: string; retentionScheduled: string; retentionComplete: string;
  aggregateScheduled: string; aggregateFinished: string; complete: string; phase: "retention" | "aggregate" };

const addDays = (day: string, count: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + count * 86_400_000).toISOString().slice(0, 10);
const RETENTION_TYPES = ["measurement.detail-retention.v1", "measurement.aggregate-retention.v1",
  "measurement.withdrawal-cleanup.v1", "interaction.feedback-retention.v1"] as const;
const AGGREGATE_TYPE = "measurement.daily-aggregate.v1";
const finished = (row: Row | undefined) => row?.status === "completed";

function makeFixture(options: {
  readonly clockNow?: () => string;
  readonly expireDetail?: (command: MeasurementWorkCommand) => { processedCount: number; nextCursor: string | null; incomplete: boolean };
  readonly aggregateDay?: (command: MeasurementWorkCommand & { utcDay: string }) => { processedCount: number; nextCursor: string | null; incomplete: boolean; coverageIncomplete?: boolean };
} = {}) {
  const rows = new Map<string, Row>();
  const progressByPortfolio = new Map<string, Progress>();
  const leaseTokens = new Map<string, string>();
  const effects: Array<{ readonly kind: string; readonly command: MeasurementWorkCommand | FeedbackWorkCommand }> = [];
  let idSequence = 1;
  const find = (scope: StableId<"Portfolio">, type: string, period: string) => [...rows.values()].find(row =>
    row.semanticSchedule.portfolioId === scope && row.payload.type === type && row.semanticSchedule.period === period);
  const getStatus = (input: { readonly portfolioId: StableId<"Portfolio">; readonly fromPeriod: string; readonly throughPeriod: string }): Phase7ScheduleStatus => {
    let progress = progressByPortfolio.get(input.portfolioId);
    if (!progress) {
      const prior = addDays(input.fromPeriod, -1);
      progress = { first: input.fromPeriod, required: input.throughPeriod, retentionScheduled: prior,
        retentionComplete: prior, aggregateScheduled: prior, aggregateFinished: prior, complete: prior, phase: "retention" };
      progressByPortfolio.set(input.portfolioId, progress);
    }
    if (progress.phase === "retention" && progress.required < input.throughPeriod) progress.required = input.throughPeriod;
    const retentionThrough = [progress.retentionScheduled, progress.required, input.throughPeriod].sort()[0]!;
    for (let day = addDays(progress.retentionComplete, 1); day <= retentionThrough; day = addDays(day, 1)) {
      if (!RETENTION_TYPES.every(type => {
        const row = find(input.portfolioId, type, day);
        return finished(row);
      })) break;
      progress.retentionComplete = day;
    }
    const aggregateThrough = [progress.aggregateScheduled, progress.retentionComplete, progress.required, input.throughPeriod].sort()[0]!;
    for (let day = addDays(progress.aggregateFinished, 1); day <= aggregateThrough; day = addDays(day, 1)) {
      const retained = RETENTION_TYPES.every(type => finished(find(input.portfolioId, type, day)));
      const aggregates = Array.from({ length: 15 }, (_, index) => addDays(day, index - 14))
        .every(utcDay => finished(find(input.portfolioId, AGGREGATE_TYPE, `${day}:${utcDay}`)));
      if (!retained || !aggregates) break;
      progress.aggregateFinished = day;
    }
    const policyThrough = [progress.aggregateScheduled, progress.retentionComplete, progress.required, input.throughPeriod].sort()[0]!;
    for (let day = addDays(progress.complete, 1); day <= policyThrough; day = addDays(day, 1)) {
      const retained = RETENTION_TYPES.every(type => { const row = find(input.portfolioId, type, day); return row?.status === "completed" && !row.coverageIncomplete; });
      const aggregates = Array.from({ length: 15 }, (_, index) => addDays(day, index - 14))
        .every(utcDay => { const row = find(input.portfolioId, AGGREGATE_TYPE, `${day}:${utcDay}`); return row?.status === "completed" && !row.coverageIncomplete; });
      if (!retained || !aggregates) break;
      progress.complete = day;
    }
    if (progress.phase === "retention" && progress.retentionComplete >= progress.required && progress.aggregateFinished < progress.required) progress.phase = "aggregate";
    else if (progress.phase === "aggregate" && progress.aggregateFinished >= progress.required) progress.phase = "retention";
    const all = [...rows.values()].filter(row => row.semanticSchedule.portfolioId === input.portfolioId);
    const frontier = [addDays(progress.retentionScheduled, 1), addDays(progress.retentionComplete, 1),
      addDays(progress.aggregateScheduled, 1), addDays(progress.complete, 1)].filter(day => day <= input.throughPeriod).sort()[0] ?? null;
    const persistedUnfinished = all.filter(row => row.status !== "completed" || row.coverageIncomplete)
      .map(row => row.semanticSchedule.period.split(":")[0]!).filter(day => day <= input.throughPeriod).sort()[0] ?? null;
    const unfinished = [frontier, persistedUnfinished].filter((day): day is string => day !== null).sort()[0] ?? null;
    const detailFrom = [addDays(progress.retentionScheduled, 1), addDays(progress.retentionComplete, 1),
      addDays(progress.aggregateScheduled, 1), addDays(progress.complete, 1)].filter(day => day <= input.throughPeriod).sort()[0]
      ?? addDays(progress.complete, 1);
    const detailThrough = [addDays(detailFrom, 14), input.throughPeriod].sort()[0]!;
    const jobs = all.filter(row => {
      const day = row.semanticSchedule.period.split(":")[0]!;
      return day >= detailFrom && day <= detailThrough;
    }).map(row => ({ jobType: row.payload.type, period: row.semanticSchedule.period, status: row.status,
      coverageIncomplete: row.coverageIncomplete }));
    const coverage = jobs.filter(row => row.coverageIncomplete).map(row => row.period.split(":")[0]!).sort()[0] ?? null;
    return { jobs, firstPolicyPeriod: progress.first, requiredThroughPeriod: progress.required,
      retentionScheduledThrough: progress.retentionScheduled, retentionCompleteThrough: progress.retentionComplete,
      aggregateScheduledThrough: progress.aggregateScheduled, lastCompletePolicyPeriod: progress.complete < progress.first ? null : progress.complete,
      phase: progress.phase, oldestOverduePeriod: [unfinished, coverage].filter((day): day is string => day !== null).sort()[0] ?? null,
      oldestUnfinishedPeriod: unfinished, oldestCoverageIncompletePeriod: coverage,
      failedCount: jobs.filter(row => row.status === "dead" || row.status === "failed").length };
  };
  const operations = {
    transactions: { run: async <T>(callback: (transaction: { readonly kind: "transaction" }) => Promise<T>) => callback({ kind: "transaction" }) },
    jobs: {
      async enqueue(_transaction: { readonly kind: "transaction" }, job: Omit<Row, "status" | "coverageIncomplete" | "attemptCount">): Promise<boolean> {
        const key = `${job.semanticSchedule.portfolioId}:${job.payload.type}:${job.semanticSchedule.period}`;
        if ([...rows.values()].some(row => `${row.semanticSchedule.portfolioId}:${row.payload.type}:${row.semanticSchedule.period}` === key)) return false;
        if (job.payload.type === AGGREGATE_TYPE) {
          const state = progressByPortfolio.get(job.semanticSchedule.portfolioId);
          const period = job.semanticSchedule.period.split(":")[0]!;
          if (!state || state.phase !== "aggregate" || state.retentionComplete < state.required ||
              !RETENTION_TYPES.every(type => { const row = find(job.semanticSchedule.portfolioId, type, period);
                return finished(row); })) return false;
        }
        rows.set(job.jobId, { ...job, status: "available", coverageIncomplete: false, attemptCount: 0 });
        return true;
      },
      async claimDue(input: { readonly jobTypes?: readonly string[]; readonly semanticScopeId?: StableId<"Portfolio"> }): Promise<readonly LeasedJobRecord[]> {
        const row = [...rows.values()].find(candidate => candidate.status === "available" &&
          candidate.semanticSchedule.portfolioId === input.semanticScopeId && input.jobTypes?.includes(candidate.payload.type));
        if (!row) return [];
        if (row.payload.type === AGGREGATE_TYPE) {
          const state = progressByPortfolio.get(row.semanticSchedule.portfolioId);
          const period = row.semanticSchedule.period.split(":")[0]!;
          if (!state || state.phase !== "aggregate" || state.retentionComplete < state.required ||
              !RETENTION_TYPES.every(type => { const retention = find(row.semanticSchedule.portfolioId, type, period);
                return finished(retention); })) return [];
        }
        row.status = "leased";
        row.attemptCount += 1;
        const leaseToken = `lease-${row.jobId}-${row.attemptCount}`;
        leaseTokens.set(row.jobId, leaseToken);
        return [{ jobId: row.jobId, payload: row.payload, semanticSchedule: row.semanticSchedule,
          leaseToken, leaseExpiresAt: now, attemptCount: row.attemptCount }];
      },
      async complete(jobId: string, token: string, _at: string, coverageIncomplete = false): Promise<boolean> {
        const row = rows.get(jobId);
        if (!row || row.status !== "leased" || leaseTokens.get(jobId) !== token) return false;
        row.status = "completed";
        row.coverageIncomplete = coverageIncomplete;
        return true;
      },
      async fail(jobId: string, token: string): Promise<boolean> {
        const row = rows.get(jobId);
        if (!row || row.status !== "leased" || leaseTokens.get(jobId) !== token) return false;
        row.status = "dead";
        return true;
      },
      async scheduleRetry(jobId: string, token: string): Promise<boolean> {
        return this.release(jobId, token);
      },
      async release(jobId: string, token: string): Promise<boolean> {
        const row = rows.get(jobId);
        if (!row || row.status !== "leased" || leaseTokens.get(jobId) !== token) return false;
        row.status = "available";
        return true;
      },
      async getPhase7ScheduleStatus(input: { readonly portfolioId: StableId<"Portfolio">; readonly fromPeriod: string; readonly throughPeriod: string }) {
        return getStatus(input);
      },
      async getPhase7ScheduleStatusAtDatabaseCurrentPeriod(input: { readonly portfolioId: StableId<"Portfolio">; readonly fromPeriod: string; readonly throughPeriod: string }) {
        return getStatus(input);
      },
      async admitPhase7DependentWork(input: { readonly portfolioId: StableId<"Portfolio"> }) {
        const state = progressByPortfolio.get(input.portfolioId);
        return state !== undefined && state.retentionComplete >= state.required;
      },
      async advancePhase7RetentionSchedule(input: { portfolioId: StableId<"Portfolio">; expectedNextPeriod: string; scheduledThroughPeriod: string }) {
        const state = progressByPortfolio.get(input.portfolioId);
        if (!state || input.expectedNextPeriod !== addDays(state.retentionScheduled, 1) || input.scheduledThroughPeriod > state.required) return false;
        const periods: string[] = [];
        for (let day = input.expectedNextPeriod; day <= input.scheduledThroughPeriod; day = addDays(day, 1)) periods.push(day);
        if (periods.length === 0 || periods.length > 15 || periods.some(day => !RETENTION_TYPES.every(type => find(input.portfolioId, type, day)))) return false;
        state.retentionScheduled = input.scheduledThroughPeriod; return true;
      },
      async advancePhase7AggregateSchedule(input: { portfolioId: StableId<"Portfolio">; expectedNextPeriod: string; scheduledThroughPeriod: string }) {
        const state = progressByPortfolio.get(input.portfolioId);
        if (!state || state.phase !== "aggregate" || state.retentionComplete < state.required ||
            input.expectedNextPeriod !== addDays(state.aggregateScheduled, 1) || input.scheduledThroughPeriod > state.required) return false;
        const periods: string[] = [];
        for (let day = input.expectedNextPeriod; day <= input.scheduledThroughPeriod; day = addDays(day, 1)) periods.push(day);
        if (periods.length === 0 || periods.length > 15 || periods.some(day => Array.from({ length: 15 }, (_, index) => addDays(day, index - 14))
          .some(utcDay => !find(input.portfolioId, AGGREGATE_TYPE, `${day}:${utcDay}`)))) return false;
        state.aggregateScheduled = input.scheduledThroughPeriod; return true;
      },
    },
  };
  const measurement = {
    async aggregateDay(command: MeasurementWorkCommand & { utcDay: string }) {
      effects.push({ kind: "aggregate", command });
      return { ok: true as const, value: options.aggregateDay?.(command) ?? { processedCount: 2, nextCursor: null, incomplete: false } };
    },
    async expireDetail(command: MeasurementWorkCommand) {
      effects.push({ kind: "detail-retention", command });
      return { ok: true as const, value: options.expireDetail?.(command) ?? { processedCount: 1, nextCursor: null, incomplete: false } };
    },
    async expireAggregates(command: MeasurementWorkCommand) {
      effects.push({ kind: "aggregate-retention", command });
      return { ok: true as const, value: { processedCount: 1, nextCursor: null, incomplete: false } };
    },
    async cleanWithdrawnConsent(command: MeasurementWorkCommand) {
      effects.push({ kind: "withdrawal-cleanup", command });
      return { ok: true as const, value: { processedCount: 1, nextCursor: null, incomplete: false } };
    },
  };
  const interaction = { async expireFeedback(command: FeedbackWorkCommand) {
    effects.push({ kind: "feedback-retention", command });
    return { ok: true as const, value: { processedCount: 1, nextCursor: null, incomplete: false } };
  } };
  const ownerExports = { runOwnerExportAssembly: async () => ({ ok: true as const,
    value: { claimed: 0, completed: 0, retried: 0, failed: 0, staleLeases: 0,
      cleanup: { scanned: 0, deleted: 0, pending: 0, incomplete: false } } }) };
  const makeService = (scope: StableId<"Portfolio">) => createPhase7DueWorkService({
    portfolioId: scope,
    clock: { now: options.clockNow ?? (() => now) },
    ids: { generate: () => `0196a1b2-7c3d-7e11-9f22-${(idSequence++).toString(16).padStart(12, "0")}` },
    operations: operations as never,
    measurement,
    interaction,
    ownerExports,
  });
  return { rows, effects, operations, progressByPortfolio, makeService, ownerExports };
}

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

  it("reports shutdown before work as incomplete without scheduling or claiming a backlog", async () => {
    const fixture = makeFixture();
    const result = await fixture.makeService(portfolioId).runDueWork({ workerId: "stopping-worker", shouldStop: () => true });

    expect(result).toMatchObject({ ok: true, value: { scheduled: 0, claimed: 0,
      incompleteBacklog: true, incomplete: true, lastCompletePolicyPeriod: null, oldestOverduePeriod: "2026-10-12" } });
    expect(fixture.rows.size).toBe(0);
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
