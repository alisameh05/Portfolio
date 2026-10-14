import { describe, expect, it } from "vitest";
import { createReactionApplicationService } from "../../src/modules/interaction-moderation/application/reactions.js";
import { createStableId } from "../../src/shared/domain/index.js";

describe("Reaction application boundary", () => {
  it("rejects unconfigured scope before any identity or persistence effect", async () => {
    const service = createReactionApplicationService({} as never);
    expect(await service.submitReaction({ scope: { kind: "unconfigured" }, correlationId: "test",
      actor: { kind: "visitor", consent: "unknown" }, projectId: createStableId("Project"),
      kind: "like", idempotencyKey: "reaction-test-key" as never })).toMatchObject({ ok: false });
  });
});
