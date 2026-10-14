import { describe, expect, it } from "vitest";
import { createStableId, parseIdempotencyKey } from "../../src/shared/domain/index.js";
import { createFeedbackApplicationService } from "../../src/modules/interaction-moderation/index.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";
import type { OperationsPersistencePorts } from "../../src/modules/portability-operations/index.js";
import { validateVersionedPayload } from "../../src/modules/portability-operations/application/persistence.js";

describe("Feedback application validation", () => {
  it("T05-08 safe Feedback UUID facts pass the outbox guard while private text and malformed IDs reject", () => {
    const payload = { type: "interaction.feedback_submitted.v1", version: 1, value: { feedbackId: createStableId("Feedback"), projectId: createStableId("Project") } };
    expect(validateVersionedPayload(payload)).toEqual(payload);
    for (const value of [{ feedbackId: "PRIVATE_TEXT" }, { feedbackId: { nested: "PRIVATE_TEXT" } },
      { feedback: "PRIVATE_TEXT" }, { authorName: "PRIVATE_TEXT" }, { paragraph: "PRIVATE_TEXT" }, { comment: "PRIVATE_TEXT" }, { reason: "PRIVATE_TEXT" }, { token: "PRIVATE_TEXT" }]) {
      expect(() => validateVersionedPayload({ ...payload, value })).toThrow();
    }
  });
  it("T05-03 rejects private invalid text before beginning any transaction", async () => {
    const portfolioId = createStableId("Portfolio"), projectId = createStableId("Project");
    let transactions = 0;
    const service = createFeedbackApplicationService({ portfolioId,
      operations: { transactions: { run: async () => { transactions++; throw new Error("UNEXPECTED_PERSISTENCE"); } } } as unknown as OperationsPersistencePorts,
      repository: { insert: async () => { throw new Error("UNEXPECTED_PERSISTENCE"); } },
      content: { getProjectInteractionFacts: async () => { throw new Error("UNEXPECTED_PERSISTENCE"); } },
      clock: { now: () => "2026-10-15T00:00:00.000Z" }, ids: createSystemIdGenerator() });
    const key = parseIdempotencyKey("feedback-unit"); if (!key.ok) throw new Error("key");
    const command = { scope: { kind: "portfolio" as const, portfolioId }, actor: { kind: "visitor" as const, consent: "unknown" as const },
      projectId, authorName: "Ada", comment: "Helpful", locale: "en" as const, idempotencyKey: key.value, correlationId: "unit" };
    for (const invalid of [{ authorName: "   " }, { comment: "\u0000" }, { authorName: "x".repeat(101) },
      { comment: "x".repeat(2001) }, { locale: "fr" }, { extra: "PRIVATE_SENTINEL" }, { authorName: 42 }, { actor: { kind: "owner" } }]) {
      expect(await service.submitFeedback({ ...command, ...invalid } as never)).toMatchObject({ ok: false });
    }
    expect(transactions).toBe(0);
  });
});
