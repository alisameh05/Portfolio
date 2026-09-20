/**
 * fakes/reaction.ts — Phase 2 #26 deterministic Reaction fakes.
 *
 * Test composition may inject deterministic application fakes for every
 * declared success and rejection. Production Phase 2 composition injects
 * the fail-closed fake, which returns `temporarily_unavailable` with the
 * stable `RUNTIME_NOT_IMPLEMENTED` code and never fabricates business
 * success. Real identity, authorization, persistence, and domain behavior
 * remain later-phase work.
 */

import type {
  Rejection,
  StableId,
} from "../../shared/domain/index.js";
import type {
  InteractionModerationService,
  ReactionKind,
  SubmitReactionCommand,
} from "../../modules/interaction-moderation/index.js";
import { createSystemClock, type Clock } from "../ports.js";

export type ReactionFakeMode =
  | { readonly type: "success"; readonly reaction?: ReactionKind }
  | { readonly type: "rejection"; readonly rejection: Rejection }
  | { readonly type: "invalid-success" };

export interface ReactionTestFake
  extends Pick<InteractionModerationService, "submitReaction"> {
  readonly calls: ReadonlyArray<SubmitReactionCommand>;
}

const FAKE_VISITOR_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e90";

export function createReactionTestFake(
  mode: ReactionFakeMode,
  clock: Clock = createSystemClock(),
): ReactionTestFake {
  const calls: SubmitReactionCommand[] = [];
  return {
    get calls(): ReadonlyArray<SubmitReactionCommand> {
      return calls;
    },
    async submitReaction(command: SubmitReactionCommand) {
      calls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: {
              projectId: command.projectId,
              visitorId: FAKE_VISITOR_ID as StableId<"FunctionalVisitor">,
              kind: mode.reaction ?? command.kind,
              updatedAt: clock.now(),
            },
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return {
            ok: true as const,
            value: {
              projectId: "not-a-uuid" as unknown as StableId<"Project">,
              visitorId: FAKE_VISITOR_ID as StableId<"FunctionalVisitor">,
              kind: command.kind,
              updatedAt: clock.now(),
            },
          };
      }
    },
  };
}

/**
 * Production Phase 2 composition for the Reaction operation.
 *
 * Every unfinished product operation fails closed with the declared 503
 * response (`temporarily_unavailable` / `RUNTIME_NOT_IMPLEMENTED`) and
 * never returns fabricated business success.
 */
export function createProductionReactionService(): Pick<
  InteractionModerationService,
  "submitReaction"
> {
  return {
    async submitReaction(_command: SubmitReactionCommand) {
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
