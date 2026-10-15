import { describe, expect, it } from "vitest";
import { createOwnerFeedbackModerationService } from "../../src/modules/interaction-moderation/application/moderation.js";
import { createStableId } from "../../src/shared/domain/index.js";

describe("Owner moderation application authorization", () => {
  it("T06-01 rejects a Visitor before persistence, even with an Owner-like property", async () => {
    const portfolioId = createStableId("Portfolio");
    const service = createOwnerFeedbackModerationService({
      scope: { portfolioId, ownerId: createStableId("Owner") },
      authorize: async () => ({ ok: true, value: true }),
      operations: {} as never, repository: {} as never, content: {} as never,
      clock: { now: () => "2026-10-15T00:00:00.000Z" }, ids: {} as never,
    });
    expect(await service.getOwnerFeedbackModeration({ scope: { kind: "portfolio", portfolioId },
      actor: { kind: "visitor", consent: "unknown" }, feedbackId: createStableId("Feedback"), correlationId: "test" }))
      .toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(await service.suppressOwnerFeedback({ scope: { kind: "portfolio", portfolioId },
      actor: { kind: "visitor", consent: "unknown" }, feedbackId: createStableId("Feedback"),
      correlationId: "suppression", expectedVersion: 2, reason: "Private reason", idempotencyKey: "retry-key" as never }))
      .toMatchObject({ ok: false, error: { kind: "forbidden" } });
  });
});
