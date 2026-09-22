/**
 * fakes/owner-moderation.ts — Phase 2 #32 deterministic Owner Moderation fakes.
 *
 * Test composition may inject deterministic application fakes for every
 * declared success and rejection. Production Phase 2 composition injects
 * the fail-closed fake, which returns `temporarily_unavailable` with the
 * stable `RUNTIME_NOT_IMPLEMENTED` code and never fabricates business
 * success. Real Moderation, retention, persistence, identity, and
 * authorization behavior remain later-phase work.
 */

import type { Rejection, StableId } from "../../shared/domain/index.js";
import type {
  ApproveOwnerFeedbackApplicationCommand,
  GetOwnerFeedbackModerationQuery,
  OwnerFeedbackModerationView,
  OwnerModerationApplicationService,
  OwnerModerationCommandReceipt,
  RejectOwnerFeedbackApplicationCommand,
  SuppressOwnerFeedbackApplicationCommand,
} from "../http/owner-moderation.js";

export type OwnerModerationFakeMode =
  | { readonly type: "success" }
  | { readonly type: "rejection"; readonly rejection: Rejection }
  | { readonly type: "invalid-success" };

export interface OwnerModerationTestFake extends OwnerModerationApplicationService {
  readonly calls: {
    readonly getOwnerFeedbackModeration: ReadonlyArray<GetOwnerFeedbackModerationQuery>;
    readonly approveOwnerFeedback: ReadonlyArray<ApproveOwnerFeedbackApplicationCommand>;
    readonly rejectOwnerFeedback: ReadonlyArray<RejectOwnerFeedbackApplicationCommand>;
    readonly suppressOwnerFeedback: ReadonlyArray<SuppressOwnerFeedbackApplicationCommand>;
  };
}

function moderationView(feedbackId: StableId<string>): OwnerFeedbackModerationView {
  return {
    feedbackId,
    aggregateVersion: 1,
    state: "pending",
    authorName: "Ada Lovelace",
    paragraph: "The case study explained the trade-offs clearly and linked supporting evidence.",
    submittedAt: "2026-09-22T00:00:00.000Z",
    decisionHistory: [],
  };
}

function invalidModerationView(feedbackId: StableId<string>): OwnerFeedbackModerationView {
  return {
    feedbackId: "not-a-uuid" as unknown as StableId<string>,
    aggregateVersion: -1,
    state: "pending",
    authorName: "",
    paragraph: "",
    submittedAt: "not-a-datetime",
    decisionHistory: [
      {
        decision: "approved",
        reason: "History entry retained for the invalid-shape probe.",
        decidedAt: "2026-09-22T00:00:00.000Z",
      },
    ],
  };
}

function receipt(
  aggregateId: string,
  aggregateVersion: number,
  outcome: OwnerModerationCommandReceipt["outcome"],
): OwnerModerationCommandReceipt {
  return {
    aggregateId: aggregateId as StableId<string>,
    aggregateVersion,
    outcome,
  };
}

function invalidReceipt(outcome: OwnerModerationCommandReceipt["outcome"]): OwnerModerationCommandReceipt {
  return {
    aggregateId: "not-a-uuid" as unknown as StableId<string>,
    aggregateVersion: -1,
    outcome,
  };
}

export function createOwnerModerationTestFake(mode: OwnerModerationFakeMode): OwnerModerationTestFake {
  const getCalls: GetOwnerFeedbackModerationQuery[] = [];
  const approveCalls: ApproveOwnerFeedbackApplicationCommand[] = [];
  const rejectCalls: RejectOwnerFeedbackApplicationCommand[] = [];
  const suppressCalls: SuppressOwnerFeedbackApplicationCommand[] = [];
  return {
    get calls() {
      return {
        getOwnerFeedbackModeration: getCalls,
        approveOwnerFeedback: approveCalls,
        rejectOwnerFeedback: rejectCalls,
        suppressOwnerFeedback: suppressCalls,
      };
    },
    async getOwnerFeedbackModeration(query: GetOwnerFeedbackModerationQuery) {
      getCalls.push(query);
      switch (mode.type) {
        case "success":
          return { ok: true as const, value: moderationView(query.feedbackId) };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidModerationView(query.feedbackId) };
      }
    },
    async approveOwnerFeedback(command: ApproveOwnerFeedbackApplicationCommand) {
      approveCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: receipt(command.feedbackId, command.expectedVersion + 1, "feedback-approved"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidReceipt("feedback-approved") };
      }
    },
    async rejectOwnerFeedback(command: RejectOwnerFeedbackApplicationCommand) {
      rejectCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: receipt(command.feedbackId, command.expectedVersion + 1, "feedback-rejected"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidReceipt("feedback-rejected") };
      }
    },
    async suppressOwnerFeedback(command: SuppressOwnerFeedbackApplicationCommand) {
      suppressCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: receipt(command.feedbackId, command.expectedVersion + 1, "feedback-suppressed"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidReceipt("feedback-suppressed") };
      }
    },
  };
}

/**
 * Production Phase 2 composition for the four Owner Moderation operations.
 *
 * Every unfinished product operation fails closed with the declared 503
 * response (`temporarily_unavailable` / `RUNTIME_NOT_IMPLEMENTED`) and
 * never returns fabricated business success.
 */
export function createProductionOwnerModerationService(): OwnerModerationApplicationService {
  const failure = {
    ok: false as const,
    error: {
      kind: "temporarily_unavailable" as const,
      code: "RUNTIME_NOT_IMPLEMENTED",
    },
  };
  return {
    async getOwnerFeedbackModeration(_query: GetOwnerFeedbackModerationQuery) {
      return failure;
    },
    async approveOwnerFeedback(_command: ApproveOwnerFeedbackApplicationCommand) {
      return failure;
    },
    async rejectOwnerFeedback(_command: RejectOwnerFeedbackApplicationCommand) {
      return failure;
    },
    async suppressOwnerFeedback(_command: SuppressOwnerFeedbackApplicationCommand) {
      return failure;
    },
  };
}
