import type { ApplicationRequestContext } from "@shared/application";
import type { ActorContext, IdempotencyKey, Rejection, Result, StableId } from "@shared/domain";

export interface GetOwnerFeedbackModerationQuery extends ApplicationRequestContext {
  readonly actor: ActorContext;
  readonly feedbackId: StableId<string>;
}

export interface ApproveOwnerFeedbackApplicationCommand extends ApplicationRequestContext {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly feedbackId: StableId<string>;
  readonly reason: string;
}

export interface RejectOwnerFeedbackApplicationCommand extends ApplicationRequestContext {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly feedbackId: StableId<string>;
  readonly reason: string;
}

export interface SuppressOwnerFeedbackApplicationCommand extends ApplicationRequestContext {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly feedbackId: StableId<string>;
  readonly reason: string;
}

export interface OwnerModerationDecisionView {
  readonly decision: "approved" | "rejected" | "suppressed";
  readonly reason: string;
  readonly decidedAt: string;
}

export interface OwnerFeedbackModerationView {
  readonly feedbackId: StableId<string>;
  readonly aggregateVersion: number;
  readonly state: "pending" | "approved" | "rejected" | "suppressed";
  readonly authorName: string;
  readonly paragraph: string;
  readonly submittedAt: string;
  readonly decisionHistory: ReadonlyArray<OwnerModerationDecisionView>;
}

export interface OwnerModerationCommandReceipt {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome: "feedback-approved" | "feedback-rejected" | "feedback-suppressed";
}

export interface OwnerModerationApplicationService {
  getOwnerFeedbackModeration(
    query: GetOwnerFeedbackModerationQuery,
  ): Promise<Result<OwnerFeedbackModerationView, Rejection>>;
  approveOwnerFeedback(
    command: ApproveOwnerFeedbackApplicationCommand,
  ): Promise<Result<OwnerModerationCommandReceipt, Rejection>>;
  rejectOwnerFeedback(
    command: RejectOwnerFeedbackApplicationCommand,
  ): Promise<Result<OwnerModerationCommandReceipt, Rejection>>;
  suppressOwnerFeedback(
    command: SuppressOwnerFeedbackApplicationCommand,
  ): Promise<Result<OwnerModerationCommandReceipt, Rejection>>;
}
