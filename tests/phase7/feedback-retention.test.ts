import { describe, expect, it, vi } from "vitest";
import type { StableId } from "../../src/shared/domain/index.js";
import type { FeedbackRetentionRepositoryPort } from "../../src/modules/interaction-moderation/ports/retention.js";
import type { FeedbackWorkCommand } from "../../src/modules/interaction-moderation/application/work.js";
import type { TransactionRunner } from "../../src/runtime/ports.js";
import { createFeedbackRetentionWorkService, pendingFeedbackExpiryAt, suppressedFeedbackExpiryAt } from "../../src/modules/interaction-moderation/application/retention.js";

const portfolioId = "0196a1b2-7c3d-7e11-9f22-000000000001" as StableId<"Portfolio">;
const foreignPortfolioId = "0196a1b2-7c3d-7e11-9f22-000000000002" as StableId<"Portfolio">;
const jobId = "0196a1b2-7c3d-7e11-9f22-000000000003" as StableId<"Job">;
const now = "2026-10-15T12:00:00.000Z";

function command(overrides: Partial<FeedbackWorkCommand> = {}): FeedbackWorkCommand {
  return { scope: { kind: "portfolio", portfolioId }, correlationId: "feedback-retention-test",
    actor: { kind: "system", jobId, purpose: "feedback.retention" }, batchSize: 25, now, ...overrides };
}

function setup(throws = false) {
  const processBatch = vi.fn<FeedbackRetentionRepositoryPort["processBatch"]>();
  processBatch.mockImplementation(async () => { if (throws) throw new Error("PRIVATE_PARAGRAPH_SENTINEL");
    return { processedCount: 2, nextCursor: jobId, incomplete: true }; });
  const service = createFeedbackRetentionWorkService({ portfolioId,
    transactions: { async run(work) { return work({ kind: "transaction" }); } } as TransactionRunner,
    repository: { processBatch } });
  return { service, processBatch };
}

describe("Feedback retention policy", () => {
  it("expires pending and rejected Feedback at the exact 90 UTC-day boundary", () => {
    expect(pendingFeedbackExpiryAt("2026-01-01T00:00:00.000Z")).toBe("2026-04-01T00:00:00.000Z");
    expect(pendingFeedbackExpiryAt("2024-02-29T12:30:00.000Z")).toBe("2024-05-29T12:30:00.000Z");
  });

  it("clamps suppressed Feedback expiry at the month end after 12 UTC calendar months", () => {
    expect(suppressedFeedbackExpiryAt("2024-02-29T12:30:00.000Z")).toBe("2025-02-28T12:30:00.000Z");
    expect(suppressedFeedbackExpiryAt("2024-03-31T12:30:00.000Z")).toBe("2025-03-31T12:30:00.000Z");
    expect(suppressedFeedbackExpiryAt("2023-01-31T00:00:00.000Z")).toBe("2024-01-31T00:00:00.000Z");
  });

  it("permits only the dedicated System purpose and configured Portfolio", async () => {
    const { service, processBatch } = setup();
    const owner = { kind: "owner", ownerId: "0196a1b2-7c3d-7e11-9f22-000000000004" as StableId<"Owner">, sessionId: "owner" };
    const visitor = { kind: "visitor", consent: "unknown" as const };
    expect(await service.expireFeedback(command({ actor: owner as never }))).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(await service.expireFeedback(command({ actor: visitor as never }))).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(await service.expireFeedback(command({ actor: { kind: "system", jobId, purpose: "measurement.retention" as never } }))).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(await service.expireFeedback(command({ scope: { kind: "portfolio", portfolioId: foreignPortfolioId } }))).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(processBatch).not.toHaveBeenCalled();
  });

  it("runs one bounded repository batch and validates canonical time, batch size and cursor", async () => {
    const { service, processBatch } = setup();
    expect(await service.expireFeedback(command({ batchSize: 100 }))).toMatchObject({ ok: true, value: { processedCount: 2, nextCursor: jobId, incomplete: true } });
    expect(processBatch).toHaveBeenCalledWith({ portfolioId, jobId, batchSize: 100, now }, expect.anything());
    expect(await service.expireFeedback(command({ now: "2026-10-15" }))).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(await service.expireFeedback(command({ batchSize: 101 as 25 }))).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(await service.expireFeedback(command({ cursor: "another-job" }))).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(processBatch).toHaveBeenCalledTimes(1);
  });

  it("maps repository failure to a sanitized unavailable result", async () => {
    const { service } = setup(true);
    const result = await service.expireFeedback(command());
    expect(result).toEqual({ ok: false, error: { kind: "temporarily_unavailable", code: "FEEDBACK_RETENTION_UNAVAILABLE" } });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_PARAGRAPH_SENTINEL");
  });
});