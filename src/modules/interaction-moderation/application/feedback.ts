import { hashCanonicalRequest } from "../../../shared/application/index.js";
import { parseIdempotencyKey, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import { requestTransactionRollback, type Clock, type StableIdGenerator, type TransactionContext } from "../../../runtime/ports.js";
import type { OperationsPersistencePorts } from "../../portability-operations/index.js";
import type { ProjectInteractionEligibilityPort } from "../../content-publishing/index.js";
import type { Feedback, FeedbackReceipt } from "../domain/index.js";
import type { InteractionModerationService } from "./service.js";

export interface FeedbackSubmissionRepositoryPort {
  /** Content eligibility is locked before this insert; no public private-text read. */
  insert(feedback: Feedback, tx: TransactionContext): Promise<void>;
}
export interface FeedbackApplicationDeps {
  readonly portfolioId: StableId<"Portfolio">;
  readonly operations: OperationsPersistencePorts;
  readonly content: ProjectInteractionEligibilityPort;
  readonly repository: FeedbackSubmissionRepositoryPort;
  readonly clock: Clock;
  readonly ids: StableIdGenerator;
}
const unavailable = (): Result<never, Rejection> => ({ ok: false, error: { kind: "not_found", code: "PROJECT_UNAVAILABLE" } });
// Paragraph permits ordinary line breaks and tabs; reject other controls and bidi overrides.
function normalizeText(value: unknown, maximum: number, paragraph = false): string | null {
  if (typeof value !== "string" || value.length > maximum) return null;
  const disallowed = paragraph ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u : /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
  if (disallowed.test(value)) return null;
  const normalized = value.normalize("NFC").trim();
  return normalized.length > 0 && normalized.length <= maximum ? normalized : null;
}

export function createFeedbackApplicationService(deps: FeedbackApplicationDeps): Pick<InteractionModerationService, "submitFeedback"> {
  return {
    async submitFeedback(command): Promise<Result<FeedbackReceipt, Rejection>> {
      if (command.scope.kind !== "portfolio" || command.scope.portfolioId !== deps.portfolioId) return unavailable();
      const name = normalizeText(command.authorName, 100), paragraph = normalizeText(command.comment, 2000, true);
      const allowed = ["scope", "actor", "correlationId", "idempotencyKey", "projectId", "authorName", "comment", "locale"];
      if (!name || !paragraph || !["en", "ar"].includes(command.locale) ||
          command.actor?.kind !== "visitor" || !["granted", "denied", "unknown"].includes(command.actor.consent) ||
          Object.keys(command.actor).some(k => k !== "kind" && k !== "consent") || Object.keys(command).some(k => !allowed.includes(k)) ||
          !parseStableId("Project", command.projectId).ok || !parseIdempotencyKey(command.idempotencyKey).ok) {
        return { ok: false, error: { kind: "validation", code: "FEEDBACK_INVALID" } };
      }
      const portfolioId = deps.portfolioId;
      try {
        return await deps.operations.transactions.run<Result<FeedbackReceipt, Rejection>>(async tx => {
          const facts = await deps.content.getProjectInteractionFacts({ portfolioId, projectId: command.projectId }, tx);
          if (!facts.ok) return requestTransactionRollback({ ok: false, error: facts.error });
          if (facts.value.portfolioId !== portfolioId || facts.value.projectId !== command.projectId ||
              facts.value.lifecycle !== "published" || !facts.value.publishedLocales.includes(command.locale)) return requestTransactionRollback(unavailable());
          const now = deps.clock.now();
          const executed = await deps.operations.idempotency.execute({
            operationScope: "interaction.feedback:" + portfolioId + ":" + command.projectId,
            actorScope: await hashCanonicalRequest({ purpose: "anonymous_feedback_submission" }),
            key: command.idempotencyKey,
            requestHash: await hashCanonicalRequest({ projectId: command.projectId, locale: command.locale, authorName: name, comment: paragraph }),
            expiresAt: new Date(Date.parse(now) + 90 * 86400_000).toISOString(),
          }, async context => {
            const generated = parseStableId("Feedback", deps.ids.generate("Feedback"));
            if (!generated.ok) throw new Error("INVALID_FEEDBACK_ID");
            const id = generated.value;
            await deps.repository.insert({ id, portfolioId, projectId: command.projectId, authorName: name, comment: paragraph,
              locale: command.locale, moderationState: "pending", aggregateVersion: 1, submittedAt: now }, context);
            await deps.operations.outbox.append(context, { eventId: deps.ids.generate("Event"),
              payload: { type: "interaction.feedback_submitted.v1", version: 1, value: { feedbackId: id, projectId: command.projectId } },
              aggregateId: id, aggregateVersion: 1, correlationId: command.correlationId, occurredAt: now, availableAt: now });
            return { id, projectId: command.projectId, status: "pending" };
          }, tx);
          if (executed.kind === "conflict") return requestTransactionRollback({ ok: false, error: { kind: "conflict", code: "IDEMPOTENCY_PAYLOAD_CONFLICT" } });
          const receipt = executed.result, id = parseStableId("Feedback", typeof receipt["id"] === "string" ? receipt["id"] : "");
          if (!id.ok || receipt["projectId"] !== command.projectId || receipt["status"] !== "pending" || Object.keys(receipt).length !== 3) throw new Error("INVALID_SAFE_RECEIPT");
          return { ok: true, value: { id: id.value, projectId: command.projectId, status: "pending" } };
        });
      } catch {
        return { ok: false, error: { kind: "temporarily_unavailable", code: "FEEDBACK_PERSISTENCE_UNAVAILABLE" } };
      }
    },
  };
}
