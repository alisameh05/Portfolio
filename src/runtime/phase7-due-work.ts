import { err, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import type { BoundedWorkResult } from "@shared/application";
import {
  calculateJobRetryDelayMilliseconds,
  JOB_MAX_ATTEMPTS,
  parsePhase7WorkPayload,
  parseSafeErrorCode,
  recordOperationsSignal,
  type OperationsObservationPort,
  type OperationsPersistencePorts,
  type OwnerExportAssemblyRunResult,
  type VersionedPayload,
} from "../modules/portability-operations/index.js";
import type { MeasurementWorkService } from "../modules/measurement/index.js";
import type { FeedbackWorkService } from "../modules/interaction-moderation/index.js";
import type { Clock, StableIdGenerator } from "./ports.js";

const AGGREGATE = "measurement.daily-aggregate.v1";
const DETAIL_RETENTION = "measurement.detail-retention.v1";
const AGGREGATE_RETENTION = "measurement.aggregate-retention.v1";
const WITHDRAWAL_CLEANUP = "measurement.withdrawal-cleanup.v1";
const FEEDBACK_RETENTION = "interaction.feedback-retention.v1";
const RETENTION_TYPES = [DETAIL_RETENTION, AGGREGATE_RETENTION, WITHDRAWAL_CLEANUP, FEEDBACK_RETENTION] as const;
const AGGREGATE_TYPES = [AGGREGATE] as const;
const ALL_TYPES = [...RETENTION_TYPES, AGGREGATE] as const;
const LEASE_DURATION_SECONDS = 300;
const BATCH_SIZE = 100 as const;
const MAX_CLAIMS_PER_PHASE = 1_000;
const MAX_CATCH_UP_PERIODS = 15;
const SAFE_FAILURE = parseSafeErrorCode("PHASE7_WORK_FAILED");
const SAFE_INVALID = parseSafeErrorCode("PHASE7_JOB_INVALID");
const DAY_MS = 86_400_000;

/** Deployment handoff only. Phase 10 installs schedules; this module never does. */
export const PHASE7_DUE_WORK_SCHEDULES = Object.freeze([
  Object.freeze({ name: "phase7-policy-daily", cadence: "daily", timezone: "UTC", invocation: "runDueWork", installed: false,
    maxCatchUpPeriods: MAX_CATCH_UP_PERIODS, maxClaimsPerPhase: MAX_CLAIMS_PER_PHASE }),
  Object.freeze({ name: "phase7-policy-catch-up", cadence: "on-incomplete-or-missed-period", timezone: "UTC", invocation: "runDueWork", installed: false,
    maxCatchUpPeriods: MAX_CATCH_UP_PERIODS, maxClaimsPerPhase: MAX_CLAIMS_PER_PHASE }),
]);

export interface Phase7DueWorkDependencies {
  readonly portfolioId: StableId<"Portfolio">;
  readonly clock: Clock;
  readonly ids: StableIdGenerator;
  readonly random?: () => number;
  readonly operations: Pick<OperationsPersistencePorts, "transactions" | "jobs">;
  readonly observations?: Pick<OperationsObservationPort, "recordSignal">;
  readonly measurement: Pick<MeasurementWorkService, "aggregateDay" | "expireDetail" | "expireAggregates" | "cleanWithdrawnConsent">;
  readonly interaction: Pick<FeedbackWorkService, "expireFeedback">;
  /** Existing module-owned #247 cleanup, expiry, orphan reconciliation, and assembly dispatch. */
  readonly ownerExports: {
    runOwnerExportAssembly(input: { readonly workerId: string }): Promise<Result<OwnerExportAssemblyRunResult, Rejection>>;
  };
}

export interface DueWorkRunCommand {
  readonly workerId: string;
  /** Per-phase bound. Smaller values let a runner return control early. */
  readonly maxClaimsPerPhase?: number;
  /** Checked between effects; the active owner-module batch always finishes first. */
  readonly shouldStop?: () => boolean;
}

export interface DueWorkRunResult {
  readonly scheduled: number;
  readonly deduplicated: number;
  readonly claimed: number;
  readonly completed: number;
  readonly released: number;
  readonly failed: number;
  readonly staleLeases: number;
  readonly processedCount: number;
  readonly incompleteBacklog: boolean;
  readonly incompleteCoverage: boolean;
  readonly incompleteOwnerExports: boolean;
  readonly incomplete: boolean;
  readonly lastCompletePolicyPeriod: string | null;
  readonly oldestOverduePeriod: string | null;
  readonly ownerExportAssembly: OwnerExportAssemblyRunResult | null;
}

const invalid = (code: string): Result<never, Rejection> => err({ kind: "validation", code });
const unavailable = (): Result<never, Rejection> => err({ kind: "temporarily_unavailable", code: "PHASE7_DUE_WORK_UNAVAILABLE" });

function validInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validUtcDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function utcDayAtOffset(day: string, offset: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + offset * DAY_MS).toISOString().slice(0, 10);
}

function periodsAfterWatermark(watermark: string, throughPeriod: string, limit = MAX_CATCH_UP_PERIODS): readonly string[] {
  const first = utcDayAtOffset(watermark, 1);
  if (first > throughPeriod) return [];
  const periods: string[] = [];
  for (let period = first; period <= throughPeriod && periods.length < limit;
    period = utcDayAtOffset(period, 1)) periods.push(period);
  return periods;
}

function utcDayFromInstant(now: string): string {
  return new Date(Date.parse(now)).toISOString().slice(0, 10);
}

function startOfUtcDay(day: string): string {
  return `${day}T00:00:00.000Z`;
}

function jobPayload(type: string, value: Readonly<Record<string, string>> = {}): VersionedPayload {
  return { type, version: 1, value };
}

interface PhaseTotals {
  claimed: number;
  completed: number;
  released: number;
  failed: number;
  staleLeases: number;
  processedCount: number;
  incompleteCoverage: boolean;
  incompleteBacklog: boolean;
  halted: boolean;
}

export function createPhase7DueWorkService(deps: Phase7DueWorkDependencies) {
  async function enqueue(type: string, value: Readonly<Record<string, string>>, policyPeriod: string,
    semanticPeriod: string): Promise<boolean> {
    const jobId = parseStableId("Job", deps.ids.generate("Job"));
    if (!jobId.ok) throw new Error("PHASE7_JOB_ID_INVALID");
    return deps.operations.transactions.run(async transaction => deps.operations.jobs.enqueue(transaction, {
      jobId: jobId.value,
      payload: jobPayload(type, value),
      availableAt: startOfUtcDay(policyPeriod),
      semanticSchedule: { portfolioId: deps.portfolioId, period: semanticPeriod },
    }));
  }

  async function enqueueRetentionJobs(periods: readonly string[]): Promise<{ scheduled: number; deduplicated: number }> {
    let scheduled = 0;
    let deduplicated = 0;
    for (const period of periods) for (const type of RETENTION_TYPES) {
      if (await enqueue(type, {}, period, period)) scheduled += 1;
      else deduplicated += 1;
    }
    return { scheduled, deduplicated };
  }

  async function enqueueAggregateJobs(periods: readonly string[]): Promise<{ scheduled: number; deduplicated: number }> {
    let scheduled = 0;
    let deduplicated = 0;
    for (const policyPeriod of periods) {
      // Rebuild the full retained UTC horizon each policy period so late accepted events converge.
      for (let offset = -14; offset <= 0; offset += 1) {
        const utcDay = utcDayAtOffset(policyPeriod, offset);
        if (await enqueue(AGGREGATE, { utcDay }, policyPeriod, `${policyPeriod}:${utcDay}`)) scheduled += 1;
        else deduplicated += 1;
      }
    }
    return { scheduled, deduplicated };
  }

  function validScheduledJob(job: { semanticSchedule?: { portfolioId: StableId<"Portfolio">; period: string } },
    parsed: NonNullable<ReturnType<typeof parsePhase7WorkPayload>>): boolean {
    if (job.semanticSchedule?.portfolioId !== deps.portfolioId) return false;
    const [policyPeriod, aggregatePeriod, ...extra] = job.semanticSchedule.period.split(":");
    if (!policyPeriod || !validUtcDay(policyPeriod) || extra.length > 0) return false;
    if (parsed.kind === "aggregate") return aggregatePeriod === parsed.utcDay && !!aggregatePeriod && validUtcDay(aggregatePeriod);
    return aggregatePeriod === undefined;
  }

  async function runPhase(command: DueWorkRunCommand, types: readonly string[], maxClaims: number): Promise<PhaseTotals> {
    const totals: PhaseTotals = { claimed: 0, completed: 0, released: 0, failed: 0, staleLeases: 0,
      processedCount: 0, incompleteCoverage: false, incompleteBacklog: false, halted: false };
    for (let claimNumber = 0; claimNumber < maxClaims; claimNumber += 1) {
      if (command.shouldStop?.()) return { ...totals, incompleteBacklog: true, halted: true };
      const claimTime = deps.clock.now();
      if (!validInstant(claimTime)) return { ...totals, incompleteBacklog: true, halted: true };
      const claims = await deps.operations.jobs.claimDue({ workerId: command.workerId, now: claimTime,
        leaseDurationSeconds: LEASE_DURATION_SECONDS, limit: 1, jobTypes: types, semanticScopeId: deps.portfolioId });
      const job = claims[0];
      if (!job) return totals;
      totals.claimed += 1;
      const parsedJobId = parseStableId("Job", job.jobId);
      const parsed = parsePhase7WorkPayload(job.payload);
      if (!parsedJobId.ok || !parsed || !validScheduledJob(job, parsed)) {
        const transitioned = await deps.operations.jobs.fail(job.jobId, job.leaseToken, SAFE_INVALID);
        if (transitioned) totals.failed += 1; else totals.staleLeases += 1;
        totals.incompleteBacklog = true;
        totals.halted = true;
        return totals;
      }

      // A stable policy-period instant keeps module-owned checkpoint anchors identical on retry/restart.
      const policyPeriod = job.semanticSchedule!.period.slice(0, 10);
      const jobNow = startOfUtcDay(policyPeriod);
      const common = { scope: { kind: "portfolio" as const, portfolioId: deps.portfolioId },
        correlationId: "phase7-due-work", batchSize: BATCH_SIZE, now: jobNow };
      let outcome: Result<BoundedWorkResult, Rejection>;
      try {
        switch (parsed.kind) {
          case "aggregate": outcome = await deps.measurement.aggregateDay({ ...common,
            actor: { kind: "system", jobId: parsedJobId.value, purpose: "measurement.aggregate" }, utcDay: parsed.utcDay! }); break;
          case "detail-retention": outcome = await deps.measurement.expireDetail({ ...common,
            actor: { kind: "system", jobId: parsedJobId.value, purpose: "measurement.retention" } }); break;
          case "aggregate-retention": outcome = await deps.measurement.expireAggregates({ ...common,
            actor: { kind: "system", jobId: parsedJobId.value, purpose: "measurement.retention" } }); break;
          case "withdrawal-cleanup": outcome = await deps.measurement.cleanWithdrawnConsent({ ...common,
            actor: { kind: "system", jobId: parsedJobId.value, purpose: "measurement.withdrawal" } }); break;
          case "feedback-retention": outcome = await deps.interaction.expireFeedback({ ...common,
            actor: { kind: "system", jobId: parsedJobId.value, purpose: "feedback.retention" } }); break;
        }
      } catch {
        outcome = err({ kind: "temporarily_unavailable", code: "PHASE7_WORK_FAILED" });
      }
      if (!outcome.ok) {
        const transient = outcome.error.kind === "temporarily_unavailable";
        const transitioned = transient
          ? await deps.operations.jobs.scheduleRetry(job.jobId, job.leaseToken, SAFE_FAILURE,
              calculateJobRetryDelayMilliseconds(job.attemptCount, deps.random ?? Math.random))
          : await deps.operations.jobs.fail(job.jobId, job.leaseToken, SAFE_FAILURE);
        if (transitioned) {
          if (transient && job.attemptCount < JOB_MAX_ATTEMPTS) totals.released += 1;
          else totals.failed += 1;
        } else totals.staleLeases += 1;
        if (parsed.kind !== "aggregate") void recordOperationsSignal(deps.observations, {
          kind: "retention-work",
          domain: parsed.kind === "feedback-retention" ? "feedback" : "measurement",
          outcome: !transitioned || transient && job.attemptCount < JOB_MAX_ATTEMPTS ? "incomplete" : "failed",
          processed: 0,
        });
        totals.incompleteBacklog = true;
        totals.halted = true;
        return totals;
      }
      totals.processedCount += outcome.value.processedCount;
      const hasMore = outcome.value.nextCursor !== null;
      const coverageIncomplete = outcome.value.coverageIncomplete ?? (outcome.value.incomplete && !hasMore);
      totals.incompleteCoverage ||= coverageIncomplete;
      const transitioned = hasMore
        ? await deps.operations.jobs.release(job.jobId, job.leaseToken, true)
        : await deps.operations.jobs.complete(job.jobId, job.leaseToken, jobNow, coverageIncomplete);
      if (parsed.kind !== "aggregate") void recordOperationsSignal(deps.observations, {
        kind: "retention-work",
        domain: parsed.kind === "feedback-retention" ? "feedback" : "measurement",
        outcome: transitioned && !hasMore && !coverageIncomplete ? "completed" : "incomplete",
        processed: Math.max(0, Math.min(1_000_000, outcome.value.processedCount)),
      });
      if (!transitioned) {
        totals.staleLeases += 1;
        totals.incompleteBacklog = true;
        totals.halted = true;
        return totals;
      }
      if (hasMore) totals.released += 1;
      else totals.completed += 1;
    }
    return { ...totals, incompleteBacklog: true, halted: true };
  }

  return {
    async runDueWork(command: DueWorkRunCommand): Promise<Result<DueWorkRunResult, Rejection>> {
      const maxClaims = command.maxClaimsPerPhase ?? MAX_CLAIMS_PER_PHASE;
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(command.workerId) || !Number.isSafeInteger(maxClaims) ||
          maxClaims < 1 || maxClaims > MAX_CLAIMS_PER_PHASE || (command.shouldStop !== undefined && typeof command.shouldStop !== "function")) {
        return invalid("PHASE7_WORKER_COMMAND_INVALID");
      }
      const scheduledAt = deps.clock.now();
      let today = validInstant(scheduledAt) ? utcDayFromInstant(scheduledAt) : "";
      if (!validUtcDay(today) || !parseStableId("Portfolio", deps.portfolioId).ok) return invalid("PHASE7_DUE_WORK_CONTEXT_INVALID");
      let fromPeriod = utcDayAtOffset(today, -(MAX_CATCH_UP_PERIODS - 1));
      try {
        const before = await deps.operations.jobs.getPhase7ScheduleStatusAtDatabaseCurrentPeriod({ portfolioId: deps.portfolioId,
          fromPeriod, throughPeriod: today });
        today = [today, before.requiredThroughPeriod].sort().at(-1)!;
        fromPeriod = utcDayAtOffset(today, -(MAX_CATCH_UP_PERIODS - 1));
        const retentionPeriods = periodsAfterWatermark(before.retentionScheduledThrough, today);
        const retentionScheduled = await enqueueRetentionJobs(retentionPeriods);
        if (retentionPeriods.length > 0) {
          await deps.operations.jobs.advancePhase7RetentionSchedule({ portfolioId: deps.portfolioId,
            expectedNextPeriod: retentionPeriods[0]!, scheduledThroughPeriod: retentionPeriods.at(-1)! });
        }
        const retention = await runPhase(command, RETENTION_TYPES, maxClaims);
        const afterRetention = await deps.operations.jobs.getPhase7ScheduleStatusAtDatabaseCurrentPeriod({ portfolioId: deps.portfolioId,
          fromPeriod, throughPeriod: today });
        let aggregateScheduled = { scheduled: 0, deduplicated: 0 };
        let aggregate: PhaseTotals = { claimed: 0, completed: 0, released: 0, failed: 0, staleLeases: 0,
          processedCount: 0, incompleteCoverage: false, incompleteBacklog: false, halted: false };
        // Durable phase status alone is not permission to start dependent work:
        // this invocation may have reached its claim/deadline budget, or shutdown
        // may have arrived after the last retention effect committed.
        let retentionStageComplete = afterRetention.retentionCompleteThrough >= afterRetention.requiredThroughPeriod &&
          !retention.halted && !command.shouldStop?.();
        let ownerExportAssembly: OwnerExportAssemblyRunResult | null = null;
        if (retentionStageComplete) {
          // This short owning-port transaction rechecks PostgreSQL's UTC day and ends before dependent work I/O.
          const admitted = await deps.operations.jobs.admitPhase7DependentWork({ portfolioId: deps.portfolioId });
          retentionStageComplete = admitted;
          if (admitted) {
            const ownerExports = await deps.ownerExports.runOwnerExportAssembly({ workerId: command.workerId });
            if (ownerExports.ok) ownerExportAssembly = ownerExports.value;
          }
        }
        if (retentionStageComplete) {
          const aggregatePeriods = periodsAfterWatermark(afterRetention.aggregateScheduledThrough,
            afterRetention.retentionCompleteThrough, Math.max(0, MAX_CATCH_UP_PERIODS - retentionPeriods.length));
          aggregateScheduled = await enqueueAggregateJobs(aggregatePeriods);
          if (aggregatePeriods.length > 0) {
            await deps.operations.jobs.advancePhase7AggregateSchedule({ portfolioId: deps.portfolioId,
              expectedNextPeriod: aggregatePeriods[0]!, scheduledThroughPeriod: aggregatePeriods.at(-1)! });
          }
          aggregate = await runPhase(command, AGGREGATE_TYPES, maxClaims);
        }
        const after = await deps.operations.jobs.getPhase7ScheduleStatusAtDatabaseCurrentPeriod({ portfolioId: deps.portfolioId,
          fromPeriod, throughPeriod: today });
        const incompleteBacklog = retention.incompleteBacklog || aggregate.incompleteBacklog ||
          retention.halted || aggregate.halted || after.oldestUnfinishedPeriod !== null;
        const incompleteCoverage = retention.incompleteCoverage || aggregate.incompleteCoverage || after.oldestCoverageIncompletePeriod !== null;
        const ownerExportPhaseReady = after.retentionCompleteThrough >= after.requiredThroughPeriod;
        const incompleteOwnerExports = ownerExportPhaseReady && (ownerExportAssembly === null || ownerExportAssembly.failed > 0 ||
          ownerExportAssembly.retried > 0 || ownerExportAssembly.staleLeases > 0 || ownerExportAssembly.cleanup?.incomplete === true ||
          (ownerExportAssembly.cleanup?.pending ?? 0) > 0 || ownerExportAssembly.incompleteBacklog === true);
        return { ok: true, value: {
          scheduled: retentionScheduled.scheduled + aggregateScheduled.scheduled,
          deduplicated: retentionScheduled.deduplicated + aggregateScheduled.deduplicated,
          claimed: retention.claimed + aggregate.claimed,
          completed: retention.completed + aggregate.completed,
          released: retention.released + aggregate.released,
          failed: after.failedCount,
          staleLeases: retention.staleLeases + aggregate.staleLeases,
          processedCount: retention.processedCount + aggregate.processedCount,
          incompleteBacklog,
          incompleteCoverage,
          lastCompletePolicyPeriod: after.lastCompletePolicyPeriod,
          oldestOverduePeriod: after.oldestOverduePeriod,
          ownerExportAssembly,
          incompleteOwnerExports,
          incomplete: incompleteBacklog || incompleteCoverage || incompleteOwnerExports,
        } };
      } catch {
        return unavailable();
      }
    },
  };
}
