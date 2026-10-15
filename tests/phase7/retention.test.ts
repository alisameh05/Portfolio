import { describe, expect, it, vi } from "vitest";
import type { BoundedWorkResult } from "../../src/shared/application/index.js";
import type { StableId } from "../../src/shared/domain/index.js";
import type { MeasurementRetentionRepositoryPort } from "../../src/modules/measurement/ports/retention.js";
import type { MeasurementWorkCommand } from "../../src/modules/measurement/application/work.js";
import type { TransactionRunner } from "../../src/runtime/ports.js";
import { createMeasurementRetentionWorkService, measurementAggregateExpiryAt, measurementDetailExpiryAt } from "../../src/modules/measurement/application/retention.js";

const portfolioId = "0196a1b2-7c3d-7e11-9f22-000000000001" as StableId<"Portfolio">;
const foreignPortfolioId = "0196a1b2-7c3d-7e11-9f22-000000000002" as StableId<"Portfolio">;
const jobId = "0196a1b2-7c3d-7e11-9f22-000000000003" as StableId<"Job">;
const now = "2026-10-15T12:00:00.000Z";

function command(overrides: Partial<MeasurementWorkCommand> = {}): MeasurementWorkCommand {
  return { scope: { kind: "portfolio", portfolioId }, correlationId: "retention-test",
    actor: { kind: "system", jobId, purpose: "measurement.retention" }, batchSize: 25, now, ...overrides };
}

function setup(): { service: ReturnType<typeof createMeasurementRetentionWorkService>; processBatch: ReturnType<typeof vi.fn> } {
  const processBatch = vi.fn<MeasurementRetentionRepositoryPort["processBatch"]>().mockResolvedValue({
    processedCount: 2, nextCursor: jobId, incomplete: false,
  } satisfies BoundedWorkResult);
  const service = createMeasurementRetentionWorkService({ portfolioId,
    transactions: { async run(work) { return work({ kind: "transaction" }); } } as TransactionRunner, repository: { processBatch } });
  return { service, processBatch };
}

describe("Measurement retention policy", () => {
  it("anchors raw expiry to acceptedAt plus fourteen UTC days, inclusive at the returned instant", () => {
    expect(measurementDetailExpiryAt("2026-10-01T12:00:00.000Z")).toBe("2026-10-15T12:00:00.000Z");
    expect(measurementDetailExpiryAt("2024-02-28T23:59:59.000Z")).toBe("2024-03-13T23:59:59.000Z");
  });

  it("adds thirteen calendar months from UTC day start with month-end and leap-day clamping", () => {
    expect(measurementAggregateExpiryAt("2024-01-31")).toBe("2025-02-28T00:00:00.000Z");
    expect(measurementAggregateExpiryAt("2024-02-29")).toBe("2025-03-29T00:00:00.000Z");
    expect(measurementAggregateExpiryAt("2024-03-31")).toBe("2025-04-30T00:00:00.000Z");
  });

  it("permits only the dedicated System purpose and keeps work inside the configured Portfolio", async () => {
    const { service, processBatch } = setup();
    const owner = { kind: "owner", ownerId: "0196a1b2-7c3d-7e11-9f22-000000000004" as StableId<"Owner">, sessionId: "owner" };
    const visitor = { kind: "visitor", consent: "granted" as const };
    expect(await service.expireDetail(command({ actor: owner as never }))).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(await service.expireDetail(command({ actor: visitor as never }))).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(await service.cleanWithdrawnConsent(command({ actor: { kind: "system", jobId, purpose: "measurement.retention" } }))).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(await service.expireAggregates(command({ scope: { kind: "portfolio", portfolioId: foreignPortfolioId } }))).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(processBatch).not.toHaveBeenCalled();
  });

  it("uses a bounded transaction and rejects non-canonical times and oversized batches", async () => {
    const { service, processBatch } = setup();
    const result = await service.expireDetail(command({ batchSize: 100 }));
    expect(result).toMatchObject({ ok: true, value: { processedCount: 2, nextCursor: jobId, incomplete: false } });
    expect(processBatch).toHaveBeenCalledWith({ kind: "detail", portfolioId, jobId, batchSize: 100, now }, expect.anything());
    expect(await service.expireDetail(command({ now: "2026-10-15" }))).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(await service.expireDetail(command({ batchSize: 101 as 25 }))).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(processBatch).toHaveBeenCalledTimes(1);
  });
});
