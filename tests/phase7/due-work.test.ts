import { describe, expect, it, vi } from "vitest";
import { createPhase7DueWorkService } from "../../src/runtime/phase7-due-work.js";
import { createProtectedDueWorkTrigger } from "../../src/runtime/protected-due-work-trigger.js";
import { DEFAULT_PROTECTED_DUE_WORK_BUDGET } from "../../src/runtime/phase8-due-work-control.js";
import type { LeasedJobRecord, OwnerExportAssemblyRunResult, Phase7ScheduleStatus, VersionedPayload } from "../../src/modules/portability-operations/index.js";
import type { MeasurementWorkCommand } from "../../src/modules/measurement/index.js";
import type { FeedbackWorkCommand } from "../../src/modules/interaction-moderation/index.js";
import type { StableId } from "../../src/shared/domain/index.js";
import type { Rejection, Result } from "../../src/shared/domain/index.js";

const portfolioId = "0196a1b2-7c3d-7e11-9f22-000000000001" as StableId<"Portfolio">;
const now = "2026-10-16T12:00:00.000Z";
const retentionTypes = ["measurement.detail-retention.v1", "measurement.aggregate-retention.v1",
  "measurement.withdrawal-cleanup.v1", "interaction.feedback-retention.v1"] as const;
const aggregateType = "measurement.daily-aggregate.v1";
type Row = { jobId: string; payload: VersionedPayload; availableAt: string;
  semanticSchedule: { portfolioId: StableId<"Portfolio">; period: string };
  status: "available" | "leased" | "completed" | "dead" | "failed"; coverageIncomplete: boolean; attemptCount: number };
type Progress = { first: string; required: string; retentionScheduled: string; retentionComplete: string;
  aggregateScheduled: string; aggregateFinished: string; complete: string; phase: "retention" | "aggregate" };

const addDays = (day: string, count: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + count * 86_400_000).toISOString().slice(0, 10);
const complete = (row: Row | undefined) => row?.status === "completed" && !row.coverageIncomplete;
const finished = (row: Row | undefined) => row?.status === "completed";

function fixture() {
  const rows = new Map<string, Row>();
  const queue: string[] = [];
  const effects: Array<{ kind: string; command: MeasurementWorkCommand | FeedbackWorkCommand }> = [];
  const ownerResponses: Result<OwnerExportAssemblyRunResult, Rejection>[] = [];
  const leaseTokens = new Map<string, string>();
  let progress: Progress | undefined;
  let idSequence = 1;
  const find = (scope: StableId<"Portfolio">, type: string, period: string) => [...rows.values()].find(row =>
    row.semanticSchedule.portfolioId === scope && row.payload.type === type && row.semanticSchedule.period === period);
  const makeStatus = (input: { portfolioId: StableId<"Portfolio">; fromPeriod: string; throughPeriod: string }): Phase7ScheduleStatus => {
    if (!progress) {
      const prior = addDays(input.fromPeriod, -1);
      progress = { first: input.fromPeriod, required: input.throughPeriod, retentionScheduled: prior,
        retentionComplete: prior, aggregateScheduled: prior, aggregateFinished: prior, complete: prior, phase: "retention" };
    }
    if (progress.phase === "retention" && progress.required < input.throughPeriod) progress.required = input.throughPeriod;
    const retentionThrough = [progress.retentionScheduled, progress.required, input.throughPeriod].sort()[0]!;
    for (let day = addDays(progress.retentionComplete, 1); day <= retentionThrough; day = addDays(day, 1)) {
      if (!retentionTypes.every(type => finished(find(input.portfolioId, type, day)))) break;
      progress.retentionComplete = day;
    }
    const policyThrough = [progress.aggregateScheduled, progress.retentionComplete, progress.required, input.throughPeriod].sort()[0]!;
    const aggregateThrough = [progress.aggregateScheduled, progress.retentionComplete, progress.required, input.throughPeriod].sort()[0]!;
    for (let day = addDays(progress.aggregateFinished, 1); day <= aggregateThrough; day = addDays(day, 1)) {
      const retentionFinished = retentionTypes.every(type => finished(find(input.portfolioId, type, day)));
      const aggregatesFinished = Array.from({ length: 15 }, (_, index) => addDays(day, index - 14))
        .every(utcDay => finished(find(input.portfolioId, aggregateType, `${day}:${utcDay}`)));
      if (!retentionFinished || !aggregatesFinished) break;
      progress.aggregateFinished = day;
    }
    for (let day = addDays(progress.complete, 1); day <= policyThrough; day = addDays(day, 1)) {
      const retentionDone = retentionTypes.every(type => complete(find(input.portfolioId, type, day)));
      const aggregatesDone = Array.from({ length: 15 }, (_, index) => addDays(day, index - 14))
        .every(utcDay => complete(find(input.portfolioId, aggregateType, `${day}:${utcDay}`)));
      if (!retentionDone || !aggregatesDone) break;
      progress.complete = day;
    }
    if (progress.phase === "retention" && progress.retentionComplete >= progress.required && progress.aggregateFinished < progress.required) progress.phase = "aggregate";
    else if (progress.phase === "aggregate" && progress.aggregateFinished >= progress.required) progress.phase = "retention";

    const allScoped = [...rows.values()].filter(row => row.semanticSchedule.portfolioId === input.portfolioId);
    const frontier = [addDays(progress.retentionScheduled, 1), addDays(progress.retentionComplete, 1),
      addDays(progress.aggregateScheduled, 1), addDays(progress.complete, 1)].filter(day => day <= input.throughPeriod).sort()[0] ?? null;
    const persistedUnfinished = allScoped.filter(row => row.status !== "completed" || row.coverageIncomplete)
      .map(row => row.semanticSchedule.period.split(":")[0]!).filter(day => day <= input.throughPeriod).sort()[0] ?? null;
    const unfinished = [frontier, persistedUnfinished].filter((day): day is string => day !== null).sort()[0] ?? null;
    const detailFrom = [addDays(progress.retentionScheduled, 1), addDays(progress.retentionComplete, 1),
      addDays(progress.aggregateScheduled, 1), addDays(progress.complete, 1)].filter(day => day <= input.throughPeriod).sort()[0]
      ?? addDays(progress.complete, 1);
    const detailThrough = [addDays(detailFrom, 14), input.throughPeriod].sort()[0]!;
    const jobs = allScoped.filter(row => {
      const policyDay = row.semanticSchedule.period.split(":")[0]!;
      return policyDay >= detailFrom && policyDay <= detailThrough;
    }).map(row => ({ jobType: row.payload.type, period: row.semanticSchedule.period, status: row.status,
      coverageIncomplete: row.coverageIncomplete }));
    const coverage = jobs.filter(row => row.coverageIncomplete).map(row => row.period.split(":")[0]!).sort()[0] ?? null;
    const overdue = [unfinished, coverage].filter((day): day is string => day !== null).sort()[0] ?? null;
    return { jobs, firstPolicyPeriod: progress.first, requiredThroughPeriod: progress.required,
      retentionScheduledThrough: progress.retentionScheduled, retentionCompleteThrough: progress.retentionComplete,
      aggregateScheduledThrough: progress.aggregateScheduled, lastCompletePolicyPeriod: progress.complete < progress.first ? null : progress.complete,
      phase: progress.phase, oldestOverduePeriod: overdue, oldestUnfinishedPeriod: unfinished,
      oldestCoverageIncompletePeriod: coverage, failedCount: jobs.filter(row => row.status === "dead" || row.status === "failed").length };
  };
  const jobs = {
    enqueue: vi.fn(async (_transaction: unknown, input: { jobId: string; payload: VersionedPayload; availableAt: string;
      semanticSchedule: { portfolioId: StableId<"Portfolio">; period: string } }) => {
      if (find(input.semanticSchedule.portfolioId, input.payload.type, input.semanticSchedule.period)) return false;
      if (input.payload.type === aggregateType && (!progress || progress.phase !== "aggregate" ||
          progress.retentionComplete < progress.required || !retentionTypes.every(type => finished(find(input.semanticSchedule.portfolioId, type,
            input.semanticSchedule.period.split(":")[0]!))))) return false;
      rows.set(input.jobId, { ...input, status: "available", coverageIncomplete: false, attemptCount: 0 });
      queue.push(input.jobId);
      return true;
    }),
    claimDue: vi.fn(async (input: { jobTypes?: readonly string[]; semanticScopeId?: StableId<"Portfolio"> }): Promise<readonly LeasedJobRecord[]> => {
      const index = queue.findIndex(jobId => {
        const row = rows.get(jobId)!;
        const policyDay = row.semanticSchedule.period.split(":")[0]!;
        const aggregateAllowed = row.payload.type !== aggregateType || Boolean(progress?.phase === "aggregate" &&
          progress.retentionComplete >= progress.required && retentionTypes.every(type => finished(find(input.semanticScopeId!, type, policyDay))));
        return row.status === "available" && row.availableAt <= now && input.jobTypes?.includes(row.payload.type) &&
          row.semanticSchedule.portfolioId === input.semanticScopeId && aggregateAllowed;
      });
      if (index < 0) return [];
      const row = rows.get(queue.splice(index, 1)[0]!)!;
      row.status = "leased";
      row.attemptCount += 1;
      const token = `lease-${row.jobId}-${row.attemptCount}`;
      leaseTokens.set(row.jobId, token);
      return [{ jobId: row.jobId, payload: row.payload, semanticSchedule: row.semanticSchedule,
        leaseToken: token, leaseExpiresAt: now, attemptCount: row.attemptCount }];
    }),
    complete: vi.fn(async (jobId: string, token: string, _at: string, incomplete = false) => {
      const row = rows.get(jobId);
      if (!row || row.status !== "leased" || leaseTokens.get(jobId) !== token) return false;
      row.status = "completed"; row.coverageIncomplete = incomplete; return true;
    }),
    fail: vi.fn(async (jobId: string) => { const row = rows.get(jobId); if (!row) return false; row.status = "dead"; return true; }),
    scheduleRetry: vi.fn(async (jobId: string) => { const row = rows.get(jobId); if (!row) return false; row.status = "available"; return true; }),
    release: vi.fn(async (jobId: string, token: string) => {
      const row = rows.get(jobId);
      if (!row || row.status !== "leased" || leaseTokens.get(jobId) !== token) return false;
      row.status = "available"; queue.push(jobId); return true;
    }),
    admitPhase7DependentWork: vi.fn(async (_input: { portfolioId: StableId<"Portfolio"> }) => Boolean(progress) &&
      progress!.retentionComplete >= progress!.required),
    getPhase7ScheduleStatus: vi.fn(async (input: { portfolioId: StableId<"Portfolio">; fromPeriod: string; throughPeriod: string }) => makeStatus(input)),
    getPhase7ScheduleStatusAtDatabaseCurrentPeriod: vi.fn(async (input: { portfolioId: StableId<"Portfolio">; fromPeriod: string; throughPeriod: string }) => makeStatus(input)),
    advancePhase7RetentionSchedule: vi.fn(async (input: { portfolioId: StableId<"Portfolio">; expectedNextPeriod: string; scheduledThroughPeriod: string }) => {
      if (!progress || input.expectedNextPeriod !== addDays(progress.retentionScheduled, 1) || input.scheduledThroughPeriod > progress.required) return false;
      const days = Array.from({ length: 15 }, (_, index) => addDays(input.expectedNextPeriod, index)).filter(day => day <= input.scheduledThroughPeriod);
      if (days.at(-1) !== input.scheduledThroughPeriod || days.some(day => !retentionTypes.every(type => find(input.portfolioId, type, day)))) return false;
      progress.retentionScheduled = input.scheduledThroughPeriod; return true;
    }),
    advancePhase7AggregateSchedule: vi.fn(async (input: { portfolioId: StableId<"Portfolio">; expectedNextPeriod: string; scheduledThroughPeriod: string }) => {
      if (!progress || progress.phase !== "aggregate" || progress.retentionComplete < progress.required ||
          input.expectedNextPeriod !== addDays(progress.aggregateScheduled, 1) || input.scheduledThroughPeriod > progress.required) return false;
      const days = Array.from({ length: 15 }, (_, index) => addDays(input.expectedNextPeriod, index)).filter(day => day <= input.scheduledThroughPeriod);
      if (days.at(-1) !== input.scheduledThroughPeriod || days.some(day => Array.from({ length: 15 }, (_, index) => addDays(day, index - 14))
        .some(utcDay => !find(input.portfolioId, aggregateType, `${day}:${utcDay}`)))) return false;
      progress.aggregateScheduled = input.scheduledThroughPeriod; return true;
    }),
  };
  let detailBatches = 0;
  const measurement = {
    aggregateDay: vi.fn(async (command: MeasurementWorkCommand & { utcDay: string }) => {
      effects.push({ kind: "aggregate", command }); return { ok: true as const, value: { processedCount: 2, nextCursor: null, incomplete: false } };
    }),
    expireDetail: vi.fn(async (command: MeasurementWorkCommand) => {
      effects.push({ kind: "detail-retention", command });
      detailBatches += 1;
      return { ok: true as const, value: { processedCount: 100, nextCursor: detailBatches === 1 ? "checkpoint" : null,
        incomplete: detailBatches === 1 } };
    }),
    expireAggregates: vi.fn(async (command: MeasurementWorkCommand) => {
      effects.push({ kind: "aggregate-retention", command }); return { ok: true as const, value: { processedCount: 1, nextCursor: null, incomplete: false } };
    }),
    cleanWithdrawnConsent: vi.fn(async (command: MeasurementWorkCommand) => {
      effects.push({ kind: "withdrawal-cleanup", command }); return { ok: true as const, value: { processedCount: 1, nextCursor: null, incomplete: false } };
    }),
  };
  const interaction = { expireFeedback: vi.fn(async (command: FeedbackWorkCommand) => {
    effects.push({ kind: "feedback-retention", command }); return { ok: true as const, value: { processedCount: 1, nextCursor: null, incomplete: false } };
  }) };
  const ownerExports = { runOwnerExportAssembly: vi.fn(async () => ownerResponses.shift() ?? ({ ok: true as const,
    value: { claimed: 0, completed: 0, retried: 0, failed: 0, staleLeases: 0, cleanup: { scanned: 0, deleted: 0, pending: 0, incomplete: false } } })) };
  const makeService = () => createPhase7DueWorkService({ portfolioId, clock: { now: () => now }, random: () => 0.5,
    ids: { generate: () => `0196a1b2-7c3d-7e11-9f22-${(idSequence++).toString(16).padStart(12, "0")}` },
    operations: { transactions: { run: async <T>(callback: (tx: unknown) => Promise<T>) => callback({}) }, jobs } as never,
    measurement, interaction, ownerExports });
  return { rows, effects, jobs, measurement, ownerExports, ownerResponses, makeService };
}

describe("Phase 7 due-work orchestration", () => {
  it("completes retention before scheduling aggregates and dispatches the existing Owner export service", async () => {
    const state = fixture();
    const first = await state.makeService().runDueWork({ workerId: "phase7-local" });
    expect(first).toMatchObject({ ok: true, value: { scheduled: 60, claimed: 61, completed: 60,
      incompleteBacklog: true, incomplete: true, lastCompletePolicyPeriod: null } });
    expect([...state.rows.values()].filter(row => row.payload.type === aggregateType)).toHaveLength(0);
    const result = await state.makeService().runDueWork({ workerId: "phase7-local-restarted" });
    expect(result).toMatchObject({ ok: true, value: { scheduled: 225, deduplicated: 0, claimed: 225,
      completed: 225, failed: 0, staleLeases: 0, processedCount: 450,
      incompleteBacklog: false, incompleteCoverage: false, incompleteOwnerExports: false, incomplete: false,
      lastCompletePolicyPeriod: "2026-10-16", oldestOverduePeriod: null, ownerExportAssembly: { completed: 0 } } });
    expect([...state.rows.values()].filter(row => row.payload.type === aggregateType)).toHaveLength(225);
    expect(state.effects.findIndex(effect => effect.kind === "feedback-retention"))
      .toBeLessThan(state.effects.findIndex(effect => effect.kind === "aggregate"));
    expect(state.ownerExports.runOwnerExportAssembly).toHaveBeenCalledTimes(2);
    expect(state.jobs.complete).toHaveBeenCalledTimes(285);
    expect(state.jobs.release).toHaveBeenCalledTimes(1);
  });

  it("fails the protected trigger safely on an Owner dependency error and resumes after retry", async () => {
    const state = fixture();
    const service = state.makeService();
    const prepared = await service.runDueWork({ workerId: "phase7-retention-preparation", maxClaimsPerPhase: 1_000 });
    expect(prepared).toMatchObject({ ok: true, value: { scheduled: 60, completed: 60, incompleteBacklog: true } });
    expect([...state.rows.values()].filter(row => retentionTypes.includes(row.payload.type as typeof retentionTypes[number]) &&
      row.status === "completed")).toHaveLength(60);
    expect([...state.rows.values()].filter(row => row.payload.type === aggregateType)).toHaveLength(0);

    const privateMarker = "OWNER_EXPORT_PRIVATE_DEPENDENCY_MARKER";
    state.ownerResponses.push({ ok: false, error: { kind: "temporarily_unavailable", code: privateMarker } });
    state.ownerExports.runOwnerExportAssembly.mockClear();
    const failedAttemptClaims = state.jobs.claimDue.mock.calls.length;
    const trigger = createProtectedDueWorkTrigger({ cronTriggerSecret: "phase8-test-cron-secret",
      workerId: "phase8-composed-test-worker", runDueWork: service.runDueWork,
      observations: { monotonicNowMs: () => 100, memoryUsageBytes: () => 128 * 1024 * 1024 },
      budget: { ...DEFAULT_PROTECTED_DUE_WORK_BUDGET, maxClaimsPerPhase: 50, maxCatchUpPeriods: 15 } });
    const request = () => new Request("https://portfolio.example.test/internal/operations/phase7-due-work", {
      method: "GET", headers: { authorization: "Bearer phase8-test-cron-secret" },
    });

    const failed = await trigger.handle(request());
    const failedBody = await failed.text();
    expect(failed.status).toBe(503);
    expect(failedBody).toBe('{"ok":false,"code":"due_work_unavailable"}');
    expect(failedBody).not.toContain(privateMarker);
    expect(state.ownerExports.runOwnerExportAssembly).toHaveBeenCalledTimes(1);
    const failedClaimCalls = state.jobs.claimDue.mock.calls.slice(failedAttemptClaims);
    expect(failedClaimCalls.some(([input]) => input.jobTypes?.includes(aggregateType))).toBe(false);
    expect([...state.rows.values()].filter(row => row.payload.type === aggregateType)).toHaveLength(0);
    expect([...state.rows.values()].some(row => row.status === "leased")).toBe(false);

    state.ownerExports.runOwnerExportAssembly.mockClear();
    const retryClaimCalls = state.jobs.claimDue.mock.calls.length;
    const retried = await trigger.handle(request());
    const retryBody = await retried.json() as { incomplete: boolean };
    expect(retried.status).toBe(200);
    expect(retryBody.incomplete).toBe(true);
    expect(state.ownerExports.runOwnerExportAssembly).toHaveBeenCalledTimes(1);
    const retryClaims = state.jobs.claimDue.mock.calls.slice(retryClaimCalls);
    expect(retryClaims.some(([input]) => input.jobTypes?.includes(aggregateType))).toBe(true);
    expect([...state.rows.values()].filter(row => row.payload.type === aggregateType)).toHaveLength(225);
    expect([...state.rows.values()].some(row => row.status === "leased")).toBe(false);
  });

  it("does not admit aggregation when a durable retention key is delayed or dead", async () => {
    for (const blocker of ["delayed", "dead"] as const) {
      const state = fixture();
      await state.makeService().runDueWork({ workerId: "seed-retention", maxClaimsPerPhase: 1 });
      const row = [...state.rows.values()].find(job => job.payload.type === retentionTypes[2]);
      expect(row).toBeDefined();
      if (row) {
        if (blocker === "dead") row.status = "dead";
        else { row.status = "available"; row.availableAt = "2030-01-01T00:00:00.000Z"; }
      }
      const second = await state.makeService().runDueWork({ workerId: `${blocker}-worker`, maxClaimsPerPhase: 1 });
      expect(second).toMatchObject({ ok: true, value: { incomplete: true } });
      expect([...state.rows.values()].some(job => job.payload.type === aggregateType)).toBe(false);
      expect(state.measurement.aggregateDay).not.toHaveBeenCalled();
      expect(state.ownerExports.runOwnerExportAssembly).not.toHaveBeenCalled();
    }
  });

  it("rejects an invalid worker identity before queue access", async () => {
    const state = fixture();
    expect(await state.makeService().runDueWork({ workerId: "bad worker" })).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(state.jobs.claimDue).not.toHaveBeenCalled();
  });
});
