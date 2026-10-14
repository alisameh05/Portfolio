import { describe, expect, it } from "vitest";
import { createRatingApplicationService } from "../../src/modules/interaction-moderation/application/ratings.js";
import { createStableId } from "../../src/shared/domain/index.js";

describe("Rating application boundary", () => {
  it("rejects invalid values before any persistence effect", async () => {
    const portfolioId = createStableId("Portfolio");
    const service = createRatingApplicationService({ portfolioId } as never);
    for (const value of [0, 1.5, 6, "5", null, NaN, Infinity, undefined]) {
      expect(await service.submitRating({ scope: { kind: "portfolio", portfolioId }, correlationId: "invalid",
        actor: { kind: "visitor", consent: "unknown", functionalId: createStableId("FunctionalVisitor") },
        projectId: createStableId("Project"), value: value as never, idempotencyKey: "rating-test-key" as never }))
        .toMatchObject({ ok: false, error: { kind: "validation", code: "RATING_INVALID" } });
    }
  });
});
