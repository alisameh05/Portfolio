import { err, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import type { BoundedWorkResult } from "@shared/application";
import {
  calculateJobRetryDelayMilliseconds,
  JOB_MAX_ATTEMPTS,
  parsePhase7WorkPayload,
  parseSafeErrorCode,
  type OperationsPersistencePorts,
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
const LEASE_DURATION_SECONDS = 300;
const BATCH_SIZE = 100 as const;
const MAX_CLAIMS_PER_PHASE = 1_000;
const SAFE_FAILURE = parseSafeErrorCode("PHASE7_WORK_FAILED");
const SAFE_INVALID = parseSafeErrorCode("PHASE7_JOB_INVALID");

export interface Phase7DueWorkDependencies {
  readonly portfolioId: StableId<"Portfolio">;
  readonly clock: Clock;
  readonly ids: StableIdGenerator;
  readonly random?: () => number;
  readonly operations: Pick<OperationsPersistencePorts, "transactions" | "jobs">;
  readonly measurement: Pick<MeasurementWorkService, "aggregateDay" | "expireDetail" | "expireAggregates" | "cleanWithdrawnConsent">;
  readonly interaction: Pick<FeedbackWorkService, "expireFeedback">;
}

export interface DueWorkRunCommand {
  readonly workerId: string;
}

export interface DueWorkRunResult {
  readonly scheduled: number;
  readonly claimed: number;
  readonly completed: number;
  readonly released: number;
  readonly failed: number;
  readonly staleLeases: number;
  readonly processedCount: number;
  readonly incomplete: boolean;
}

const invalid = (code: string): Result<never, Rejection> => err({ kind: "validation", code });
const unavailable = (): Result<never, Rejection> => err({ kind: "temporarily_unavailable", code: "PHASE7_DUE_WORK_UNAVAILABLE" });

function validInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function utcDayAtOffset(now: string, offset: number): string {
  return new Date(Date.parse(now) + offset * 86_400_000).toISOString().slice(0, 10);
}

function jobPayload(type: string, value: Readonly<Record<string, string>> = {}): VersionedPayload {
  return { type, version: 1, value };
}

export function createPhase7DueWorkService(deps: Phase7DueWorkDependencies) {
  async function enqueue(type: string, value: Readonly<Record<string, string>>, availableAt: string): Promise<void> {
    const jobId = parseStableId("Job", deps.ids.generate("Job"));
    if (!jobId.ok) throw new Error("PHASE7_JOB_ID_INVALID");
    await deps.operations.transactions.run(async transaction => {
      await deps.operations.jobs.enqueue(transaction, { jobId: jobId.value, payload: jobPayload(type, value), availableAt });
    });
  }

  async function enqueueRetentionJobs(now: string): Promise<number> {
    for (const type of RETENTION_TYPES) await enqueue(type, {}, now);
    return RETENTION_TYPES.length;
  }

  async function enqueueAggregateJobs(now: string): Promise<number> {
    // Rebuild the full retained UTC horizon so late accepted events converge on the canonical totals.
    for (let offset = -14; offset <= 0; offset += 1) {
      await enqueue(AGGREGATE, { utcDay: utcDayAtOffset(now, offset) }, now);
    }
    return 15;
  }

  async function runPhase(command: DueWorkRunCommand, types: readonly string[]): Promise<{
    claimed: number; completed: number; released: number; failed: number; staleLeases: number; processedCount: number;
    incomplete: boolean; halted: boolean;
  }> {
    const totals = { claimed: 0, completed: 0, released: 0, failed: 0, staleLeases: 0, processedCount: 0, incomplete: false, halted: false };
    for (let claimNumber = 0; claimNumber < MAX_CLAIMS_PER_PHASE; claimNumber += 1) {
      const claimTime = deps.clock.now();
      if (!validInstant(claimTime)) return { ...totals, incomplete: true, halted: true };
      const claims = await deps.operations.jobs.claimDue({ workerId: command.workerId, now: claimTime,
        leaseDurationSeconds: LEASE_DURATION_SECONDS, limit: 1, jobTypes: types });
      const job = claims[0];
      if (!job) return totals;
      totals.claimed += 1;
      const parsedJobId = parseStableId("Job", job.jobId);
      const parsed = parsePhase7WorkPayload(job.payload);
      if (!parsedJobId.ok || !parsed) {
        const transitioned = await deps.operations.jobs.fail(job.jobId, job.leaseToken, SAFE_INVALID);
        if (transitioned) totals.failed += 1; else totals.staleLeases += 1;
        totals.incomplete = true;
        totals.halted = true;
        return totals;
      }

      const jobNow = deps.clock.now();
      if (!validInstant(jobNow)) return { ...totals, incomplete: true, halted: true };
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
        totals.incomplete = true;
        totals.halted = true;
        return totals;
      }
      totals.processedCount += outcome.value.processedCount;
      // `incomplete` reports aggregate coverage. `nextCursor` reports whether
      // this recoverable job still has bounded batches to process.
      totals.incomplete ||= outcome.value.incomplete;
      const hasMore = outcome.value.nextCursor !== null;
      const transitioned = hasMore
        ? await deps.operations.jobs.release(job.jobId, job.leaseToken)
        : await deps.operations.jobs.complete(job.jobId, job.leaseToken, jobNow);
      if (!transitioned) {
        totals.staleLeases += 1;
        totals.incomplete = true;
        totals.halted = true;
        return totals;
      }
      if (hasMore) totals.released += 1;
      else totals.completed += 1;
    }
    totals.incomplete = true;
    totals.halted = true;
    return totals;
  }

  return {
    async runDueWork(command: DueWorkRunCommand): Promise<Result<DueWorkRunResult, Rejection>> {
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(command.workerId)) return invalid("PHASE7_WORKER_ID_INVALID");
      const scheduledAt = deps.clock.now();
      if (!validInstant(scheduledAt) || !parseStableId("Portfolio", deps.portfolioId).ok) return invalid("PHASE7_DUE_WORK_CONTEXT_INVALID");
      try {
        const scheduled = await enqueueRetentionJobs(scheduledAt);
        const retention = await runPhase(command, RETENTION_TYPES);
        if (retention.halted) return { ok: true, value: { scheduled, claimed: retention.claimed,
          completed: retention.completed, released: retention.released, failed: retention.failed,
          staleLeases: retention.staleLeases, processedCount: retention.processedCount, incomplete: true } };
        const aggregateScheduled = await enqueueAggregateJobs(scheduledAt);
        const aggregate = await runPhase(command, AGGREGATE_TYPES);
        return { ok: true, value: { scheduled: scheduled + aggregateScheduled,
          claimed: retention.claimed + aggregate.claimed,
          completed: retention.completed + aggregate.completed,
          released: retention.released + aggregate.released,
          failed: retention.failed + aggregate.failed,
          staleLeases: retention.staleLeases + aggregate.staleLeases,
          processedCount: retention.processedCount + aggregate.processedCount,
          incomplete: retention.incomplete || aggregate.incomplete } };
      } catch {
        return unavailable();
      }
    },
  };
}
