/**
 * fakes/feedback.ts — Phase 2 #28 deterministic Feedback fakes.
 *
 * Test composition may inject deterministic application fakes for every
 * declared success and rejection. Production Phase 2 composition injects
 * the fail-closed fake, which returns `temporarily_unavailable` with the
 * stable `RUNTIME_NOT_IMPLEMENTED` code and never fabricates business
 * success. Real identity, authorization, persistence, moderation workflow,
 * and domain behavior remain later-phase work.
 */

import type {
  Rejection,
  StableId,
} from "../../shared/domain/index.js";
import type {
  InteractionModerationService,
  SubmitFeedbackCommand,
} from "../../modules/interaction-moderation/index.js";
import { createSystemClock, type Clock } from "../ports.js";

export type FeedbackFakeMode =
  | { readonly type: "success" }
  | { readonly type: "rejection"; readonly rejection: Rejection }
  | { readonly type: "invalid-success" };

export interface FeedbackTestFake
  extends Pick<InteractionModerationService, "submitFeedback"> {
  readonly calls: ReadonlyArray<SubmitFeedbackCommand>;
}

const FAKE_FEEDBACK_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e91";

export function createFeedbackTestFake(
  mode: FeedbackFakeMode,
  clock: Clock = createSystemClock(),
): FeedbackTestFake {
  const calls: SubmitFeedbackCommand[] = [];
  return {
    get calls(): ReadonlyArray<SubmitFeedbackCommand> {
      return calls;
    },
    async submitFeedback(command: SubmitFeedbackCommand) {
      calls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: {
              id: FAKE_FEEDBACK_ID as StableId<"Feedback">,
              projectId: command.projectId,
              authorName: command.authorName,
              comment: command.comment,
              moderationState: "pending" as const,
              submittedAt: clock.now(),
            },
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return {
            ok: true as const,
            value: {
              id: "not-a-uuid" as unknown as StableId<"Feedback">,
              projectId: command.projectId,
              authorName: command.authorName,
              comment: command.comment,
              moderationState: "pending" as const,
              submittedAt: clock.now(),
            },
          };
      }
    },
  };
}

/**
 * Production Phase 2 composition for the Feedback operation.
 *
 * Every unfinished product operation fails closed with the declared 503
 * response (`temporarily_unavailable` / `RUNTIME_NOT_IMPLEMENTED`) and
 * never returns fabricated business success.
 */
export function createProductionFeedbackService(): Pick<
  InteractionModerationService,
  "submitFeedback"
> {
  return {
    async submitFeedback(_command: SubmitFeedbackCommand) {
      return {
        ok: false as const,
        error: {
          kind: "temporarily_unavailable" as const,
          code: "RUNTIME_NOT_IMPLEMENTED",
        },
      };
    },
  };
}
