import { describe, expect, it, vi } from "vitest";
import { createPhase7DueWorkService } from "../../src/runtime/phase7-due-work.js";
import type { LeasedJobRecord, VersionedPayload } from "../../src/modules/portability-operations/index.js";
import type { MeasurementWorkCommand } from "../../src/modules/measurement/index.js";
import type { FeedbackWorkCommand } from "../../src/modules/interaction-moderation/index.js";
import type { StableId } from "../../src/shared/domain/index.js";

const portfolioId = "0196a1b2-7c3d-7e11-9f22-000000000001" as StableId<"Portfolio">;
const now = "2026-10-16T12:00:00.000Z";
const queue: LeasedJobRecord[] = [];
const enqueued: Array<{ jobId: string; payload: VersionedPayload; availableAt: string }> = [];
const calls: Array<{ kind: string; command: MeasurementWorkCommand | FeedbackWorkCommand }> = [];
const jobs = {
  enqueue: vi.fn(async (_transaction: { readonly kind: "transaction" }, job: { jobId: string; payload: VersionedPayload; availableAt: string }) => {
    enqueued.push(job);
    queue.push({ jobId: job.jobId, payload: job.payload, leaseToken: `lease-${job.jobId}`, leaseExpiresAt: now, attemptCount: 1 });
  }),
  claimDue: vi.fn(async (input: { jobTypes?: readonly string[] }) => {
    const index = queue.findIndex(job => input.jobTypes?.includes(job.payload.type));
    if (index < 0) return [];
    return [queue.splice(index, 1)[0]!];
  }),
  complete: vi.fn(async () => true),
  fail: vi.fn(async () => true),
  release: vi.fn(async (jobId: string) => {
    const job = enqueued.find(entry => entry.jobId === jobId);
    if (job) queue.push({ jobId, payload: job.payload, leaseToken: `lease-${jobId}-again`, leaseExpiresAt: now, attemptCount: 2 });
    return true;
  }),
};
const transactions = { run: vi.fn(async <T>(callback: (transaction: { readonly kind: "transaction" }) => Promise<T>) => callback({ kind: "transaction" })) };

function setup() {
  vi.clearAllMocks(); queue.length = 0; enqueued.length = 0; calls.length = 0;
  let retentionBatches = 0;
  const measurement = {
    aggregateDay: vi.fn(async (command: MeasurementWorkCommand & { utcDay: string }) => {
      calls.push({ kind: "aggregate", command });
      return { ok: true as const, value: { processedCount: 2, nextCursor: null, incomplete: false } };
    }),
    expireDetail: vi.fn(async (command: MeasurementWorkCommand) => {
      calls.push({ kind: "detail-retention", command });
      retentionBatches += 1;
      return { ok: true as const, value: { processedCount: 100,
        nextCursor: retentionBatches === 1 ? "checkpoint" : null, incomplete: retentionBatches === 1 } };
    }),
    expireAggregates: vi.fn(async (command: MeasurementWorkCommand) => {
      calls.push({ kind: "aggregate-retention", command });
      return { ok: true as const, value: { processedCount: 1, nextCursor: null, incomplete: false } };
    }),
    cleanWithdrawnConsent: vi.fn(async (command: MeasurementWorkCommand) => {
      calls.push({ kind: "withdrawal-cleanup", command });
      return { ok: true as const, value: { processedCount: 0, nextCursor: null, incomplete: false } };
    }),
  };
  const interaction = { expireFeedback: vi.fn(async (command: FeedbackWorkCommand) => {
    calls.push({ kind: "feedback-retention", command });
    return { ok: true as const, value: { processedCount: 3, nextCursor: null, incomplete: false } };
  }) };
  const service = createPhase7DueWorkService({ portfolioId, clock: { now: () => now },
    ids: { generate: (() => { let count = 1; return () => `0196a1b2-7c3d-7e11-9f22-${(count++).toString(16).padStart(12, "0")}`; })() },
    operations: { transactions: transactions as never, jobs: jobs as never }, measurement, interaction });
  return { service, measurement, interaction };
}

describe("Phase 7 due-work orchestration", () => {
  it("runs retention before rebuilding the retained UTC horizon through module commands", async () => {
    const { service } = setup();
    const result = await service.runDueWork({ workerId: "phase7-local" });

    expect(result).toEqual({ ok: true, value: {
      scheduled: 19, claimed: 20, completed: 19, released: 1, failed: 0,
      staleLeases: 0, processedCount: 234, incomplete: true,
    } });
    expect(enqueued.map(job => job.payload.type)).toEqual([
      "measurement.detail-retention.v1", "measurement.aggregate-retention.v1", "measurement.withdrawal-cleanup.v1",
      "interaction.feedback-retention.v1", ...Array(15).fill("measurement.daily-aggregate.v1"),
    ]);
    expect(calls.findIndex(call => call.kind === "feedback-retention"))
      .toBeLessThan(calls.findIndex(call => call.kind === "aggregate"));
    expect(calls.every(call => call.command.batchSize === 100 && call.command.actor.kind === "system" &&
      call.command.scope.kind === "portfolio" && call.command.scope.portfolioId === portfolioId)).toBe(true);
    expect(jobs.claimDue).toHaveBeenCalledWith(expect.objectContaining({ limit: 1, jobTypes: [
      "measurement.detail-retention.v1", "measurement.aggregate-retention.v1", "measurement.withdrawal-cleanup.v1", "interaction.feedback-retention.v1",
    ] }));
    expect(jobs.complete).toHaveBeenCalledTimes(19);
    expect(jobs.release).toHaveBeenCalledTimes(1);
  });

  it("stores only a fixed safe error code and stops before aggregation after a failed owned command", async () => {
    const { service, measurement } = setup();
    measurement.expireDetail.mockResolvedValueOnce({ ok: false, error: { kind: "temporarily_unavailable", code: "PRIVATE_SUBJECT_TOKEN_SHOULD_NOT_ESCAPE" } } as never);

    const result = await service.runDueWork({ workerId: "phase7-local" });

    expect(result).toMatchObject({ ok: true, value: { scheduled: 4, claimed: 1, failed: 1, incomplete: true } });
    expect(jobs.fail).toHaveBeenCalledWith(expect.any(String), expect.any(String), "PHASE7_WORK_FAILED");
    expect(measurement.aggregateDay).not.toHaveBeenCalled();
    expect(enqueued.some(job => job.payload.type === "measurement.daily-aggregate.v1")).toBe(false);
  });

  it("rejects an invalid worker identity before queue access", async () => {
    const { service } = setup();
    expect(await service.runDueWork({ workerId: "bad worker" })).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(jobs.claimDue).not.toHaveBeenCalled();
  });
});
