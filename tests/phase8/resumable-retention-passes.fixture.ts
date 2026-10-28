import { createPhase7DueWorkService } from "../../src/runtime/phase7-due-work.js";
import type { LeasedJobRecord, OperationsObservationPort, Phase7ScheduleStatus, VersionedPayload } from "../../src/modules/portability-operations/index.js";
import type { MeasurementWorkCommand } from "../../src/modules/measurement/index.js";
import type { FeedbackWorkCommand } from "../../src/modules/interaction-moderation/index.js";
import type { StableId } from "../../src/shared/domain/index.js";
import type { Rejection, Result } from "../../src/shared/domain/index.js";
import type { BoundedWorkResult } from "../../src/shared/application/index.js";
export const portfolioId = "0196a1b2-7c3d-7e11-9f22-000000000001" as StableId<"Portfolio">;
export const otherPortfolioId = "0196a1b2-7c3d-7e11-9f22-000000000002" as StableId<"Portfolio">;
export const now = "2026-10-26T12:00:00.000Z";
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

export const addDays = (day: string, count: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + count * 86_400_000).toISOString().slice(0, 10);
export const RETENTION_TYPES = ["measurement.detail-retention.v1", "measurement.aggregate-retention.v1",
  "measurement.withdrawal-cleanup.v1", "interaction.feedback-retention.v1"] as const;
const AGGREGATE_TYPE = "measurement.daily-aggregate.v1";
const finished = (row: Row | undefined) => row?.status === "completed";

export function makeFixture(options: {
  readonly clockNow?: () => string;
  readonly observations?: Pick<OperationsObservationPort, "recordSignal">;
  readonly expireDetail?: (command: MeasurementWorkCommand) => BoundedWorkResult | Result<BoundedWorkResult, Rejection>;
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
      const outcome = options.expireDetail?.(command) ?? { processedCount: 1, nextCursor: null, incomplete: false };
      return "ok" in outcome ? outcome : { ok: true as const, value: outcome };
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
    observations: options.observations ?? { async recordSignal() {} },
    measurement,
    interaction,
    ownerExports,
  });
  return { rows, effects, operations, progressByPortfolio, makeService, ownerExports };
}

