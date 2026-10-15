import { hashCanonicalRequest } from "../../../shared/application/index.js";
import { parseStableId, parseIdempotencyKey, type Rejection, type Result, type StableId, type OwnerActor } from "@shared/domain";
import { requestTransactionRollback, type TransactionContext, type Clock, type StableIdGenerator } from "../../../runtime/ports.js";
import type { OperationsPersistencePorts } from "../../portability-operations/index.js";
import type { ProjectInteractionEligibilityPort } from "../../content-publishing/index.js";
import type { AuthorizeOperationQuery } from "../../identity-access/index.js";
import type { Feedback, PublicFeedbackPage } from "../domain/index.js";
import type { OwnerModerationApplicationService, OwnerFeedbackModerationView, OwnerModerationCommandReceipt, ApproveOwnerFeedbackApplicationCommand, GetOwnerFeedbackModerationQuery } from "./owner-moderation.js";
import type { InteractionModerationService } from "./service.js";

export type ModerationDecision = "approved" | "rejected" | "suppressed";
export interface RetainedModerationDecision {
  readonly id: StableId<"ModerationDecision">;
  readonly sequence: number;
  readonly decision: ModerationDecision;
  readonly reason: string;
  readonly ownerId: StableId<"Owner">;
  readonly decidedAt: string;
}
export interface ModerationRepositoryPort {
  /** Sets transaction-local Owner scope; the immutable association is read before Content then Feedback locks. */
  getFeedback(scope: { portfolioId: StableId<"Portfolio">; ownerId: StableId<"Owner"> }, id: StableId<"Feedback">, lock: boolean, tx: TransactionContext): Promise<Feedback | null>;
  history(id: StableId<"Feedback">, tx: TransactionContext): Promise<readonly RetainedModerationDecision[]>;
  decide(feedback: Feedback, decision: RetainedModerationDecision, tx: TransactionContext): Promise<void>;
  /** Reads only approved rows; application holds current exact-locale Content facts. */
  approved(input: { portfolioId: StableId<"Portfolio">; projectId: StableId<"Project">; locale: "en" | "ar"; limit: number; cursor?: NonNullable<PublicFeedbackPage["nextCursor"]> }, tx: TransactionContext): Promise<PublicFeedbackPage>;
}
export interface ModerationApplicationDeps {
  readonly scope: { portfolioId: StableId<"Portfolio">; ownerId: StableId<"Owner"> };
  readonly authorize: (query: AuthorizeOperationQuery) => Promise<Result<boolean, Rejection>>;
  readonly operations: OperationsPersistencePorts;
  readonly content: ProjectInteractionEligibilityPort;
  readonly repository: ModerationRepositoryPort;
  readonly clock: Clock;
  readonly ids: StableIdGenerator;
}
type ModerationService = OwnerModerationApplicationService & Pick<InteractionModerationService, "getApprovedFeedback">;
const reject = (kind: "not_found" | "validation" | "conflict" | "precondition_failed" | "forbidden" | "temporarily_unavailable", code: string): Result<never, Rejection> => ({ ok: false, error: { kind, code } });
const missing = () => reject("not_found", "FEEDBACK_NOT_FOUND");
const unavailable = () => reject("temporarily_unavailable", "MODERATION_PERSISTENCE_UNAVAILABLE");

export function createOwnerFeedbackModerationService(deps: ModerationApplicationDeps): ModerationService {
  async function authorize(query: GetOwnerFeedbackModerationQuery): Promise<Result<OwnerActor, Rejection>> {
    if (query.actor?.kind !== "owner" || query.actor.ownerId !== deps.scope.ownerId || !query.actor.sessionId ||
        query.scope.kind !== "portfolio" || query.scope.portfolioId !== deps.scope.portfolioId) return reject("forbidden", "OWNER_SCOPE_REQUIRED");
    const permitted = await deps.authorize({ actor: query.actor, requiredPermission: "write:owner" });
    if (!permitted.ok) return permitted;
    if (!permitted.value) return reject("forbidden", "OPERATION_NOT_PERMITTED");
    return { ok: true, value: query.actor };
  }
  async function moderate(command: ApproveOwnerFeedbackApplicationCommand, decision: ModerationDecision): Promise<Result<OwnerModerationCommandReceipt, Rejection>> {
    try {
      // Authorization precedes ledger lookup, including exact replay after version advancement.
      const owner = await authorize(command);
      if (!owner.ok) return owner;
      if (!parseStableId("Feedback", command.feedbackId).ok || !parseIdempotencyKey(command.idempotencyKey).ok ||
          !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1 ||
          typeof command.reason !== "string" || command.reason.length > 500 || !command.reason.trim() ||
          /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(command.reason) ||
          Object.keys(command).some(k => !["scope", "actor", "correlationId", "feedbackId", "idempotencyKey", "expectedVersion", "reason"].includes(k))) return reject("validation", "MODERATION_INVALID");
      const reason = command.reason.normalize("NFC").trim();
      if (reason.length > 500) return reject("validation", "MODERATION_INVALID");
      return await deps.operations.transactions.run<Result<OwnerModerationCommandReceipt, Rejection>>(async tx => {
        const existing = await deps.repository.getFeedback(deps.scope, command.feedbackId, false, tx);
        if (!existing) return requestTransactionRollback(missing());
        // Content lock order is shared with submission/public queries/lifecycle. Hidden/Archived are retained private workflows.
        const facts = await deps.content.getProjectInteractionFacts({ portfolioId: deps.scope.portfolioId, projectId: existing.projectId }, tx);
        if (!facts.ok || facts.value.portfolioId !== deps.scope.portfolioId || facts.value.projectId !== existing.projectId) return requestTransactionRollback(missing());
        const feedback = await deps.repository.getFeedback(deps.scope, command.feedbackId, true, tx);
        if (!feedback) return requestTransactionRollback(missing());
        const now = deps.clock.now();
        const executed = await deps.operations.idempotency.execute({
          operationScope: "interaction.moderation:" + decision + ":" + deps.scope.portfolioId + ":" + feedback.id,
          actorScope: await hashCanonicalRequest({ purpose: "owner_moderation", ownerId: owner.value.ownerId }),
          key: command.idempotencyKey,
          requestHash: await hashCanonicalRequest({ feedbackId: feedback.id, expectedVersion: command.expectedVersion, reason }),
          expiresAt: new Date(Date.parse(now) + 90 * 86400_000).toISOString(),
        }, async context => {
          // Typed rejection is rolled back by the outer runner. Throwing here would
          // deliberately become a sanitized infrastructure failure at that boundary.
          if (feedback.aggregateVersion !== command.expectedVersion) return { rejection: "FEEDBACK_VERSION_STALE" };
          if (feedback.moderationState !== (decision === "suppressed" ? "approved" : "pending")) return { rejection: "MODERATION_TRANSITION_INVALID" };
          const id = parseStableId("ModerationDecision", deps.ids.generate("ModerationDecision"));
          if (!id.ok) throw new Error("INVALID_DECISION_ID");
          await deps.repository.decide(feedback, { id: id.value, sequence: feedback.aggregateVersion, decision, reason, ownerId: owner.value.ownerId, decidedAt: now }, context);
          await deps.operations.outbox.append(context, { eventId: deps.ids.generate("Event"), aggregateId: feedback.id,
            aggregateVersion: feedback.aggregateVersion + 1, correlationId: command.correlationId, occurredAt: now, availableAt: now,
            payload: { type: "interaction.feedback_" + decision + ".v1", version: 1, value: { feedbackId: feedback.id, projectId: feedback.projectId } } });
          return { aggregateId: feedback.id, aggregateVersion: feedback.aggregateVersion + 1, outcome: "feedback-" + decision };
        }, tx);
        if (executed.kind === "conflict") return requestTransactionRollback(reject("conflict", "IDEMPOTENCY_PAYLOAD_CONFLICT"));
        const receipt = executed.result;
        if (receipt["rejection"] === "FEEDBACK_VERSION_STALE") return requestTransactionRollback(reject("precondition_failed", "FEEDBACK_VERSION_STALE"));
        if (receipt["rejection"] === "MODERATION_TRANSITION_INVALID") return requestTransactionRollback(reject("conflict", "MODERATION_TRANSITION_INVALID"));
        if (receipt["aggregateId"] !== feedback.id || receipt["outcome"] !== "feedback-" + decision ||
            typeof receipt["aggregateVersion"] !== "number" || !Number.isSafeInteger(receipt["aggregateVersion"]) || receipt["aggregateVersion"] < 2 || Object.keys(receipt).length !== 3) throw new Error("INVALID_SAFE_RECEIPT");
        return { ok: true, value: { aggregateId: feedback.id, aggregateVersion: receipt["aggregateVersion"], outcome: `feedback-${decision}` } };
      });
    } catch { return unavailable(); }
  }
  return {
    async getOwnerFeedbackModeration(query): Promise<Result<OwnerFeedbackModerationView, Rejection>> {
      try {
        const owner = await authorize(query);
        if (!owner.ok) return owner;
        if (!parseStableId("Feedback", query.feedbackId).ok) return reject("validation", "MODERATION_INVALID");
        return await deps.operations.transactions.run(async tx => {
          // A shared Feedback lock keeps private state/version and history from different commits out of the same view.
          const feedback = await deps.repository.getFeedback(deps.scope, query.feedbackId, true, tx);
          if (!feedback) return missing();
          const history = await deps.repository.history(feedback.id, tx);
          return { ok: true, value: { feedbackId: feedback.id, aggregateVersion: feedback.aggregateVersion, state: feedback.moderationState,
            authorName: feedback.authorName, paragraph: feedback.comment, submittedAt: feedback.submittedAt,
            decisionHistory: history.map(d => ({ decision: d.decision, reason: d.reason, decidedAt: d.decidedAt })) } };
        });
      } catch { return unavailable(); }
    },
    approveOwnerFeedback: command => moderate(command, "approved"),
    rejectOwnerFeedback: command => moderate(command, "rejected"),
    suppressOwnerFeedback: command => moderate(command, "suppressed"),
    async getApprovedFeedback(query): Promise<Result<PublicFeedbackPage, Rejection>> {
      if (query.scope.kind !== "portfolio" || query.scope.portfolioId !== deps.scope.portfolioId || query.portfolioId !== deps.scope.portfolioId) return missing();
      const limit = query.limit === undefined ? 25 : query.limit;
      if (!parseStableId("Project", query.projectId).ok || !["en", "ar"].includes(query.locale) ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
          (query.cursor !== undefined && !validCursor(query.cursor))) return reject("validation", "FEEDBACK_QUERY_INVALID");
      try {
        return await deps.operations.transactions.run(async tx => {
          const facts = await deps.content.getProjectInteractionFacts({ portfolioId: deps.scope.portfolioId, projectId: query.projectId }, tx);
          if (!facts.ok || facts.value.portfolioId !== deps.scope.portfolioId || facts.value.projectId !== query.projectId ||
              facts.value.lifecycle !== "published" || !facts.value.publishedLocales.includes(query.locale)) return reject("not_found", "PROJECT_UNAVAILABLE");
          return { ok: true, value: await deps.repository.approved({ portfolioId: deps.scope.portfolioId, projectId: query.projectId,
            locale: query.locale, limit, ...(query.cursor === undefined ? {} : { cursor: query.cursor }) }, tx) };
        });
      } catch { return unavailable(); }
    },
  };
}

/** UTC cursor timestamps round-trip exactly, including PostgreSQL microseconds. */
function validCursor(cursor: NonNullable<PublicFeedbackPage["nextCursor"]>): boolean {
  if (!cursor || typeof cursor !== "object" || Object.keys(cursor).length !== 2 ||
      !parseStableId("Feedback", cursor.feedbackId).ok || typeof cursor.displayedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/.test(cursor.displayedAt)) return false;
  const milliseconds = cursor.displayedAt.replace(/(\.\d{3})\d{3}Z$/, "$1Z");
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) && date.toISOString() === milliseconds;
}
