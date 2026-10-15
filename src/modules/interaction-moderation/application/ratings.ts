import { hashCanonicalRequest } from "../../../shared/application/index.js";
import { parseIdempotencyKey, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import type { Clock, StableIdGenerator, TransactionContext } from "../../../runtime/ports.js";
import { requestTransactionRollback } from "../../../runtime/ports.js";
import type { OperationsPersistencePorts } from "../../portability-operations/index.js";
import type { ProjectInteractionEligibilityPort } from "../../content-publishing/index.js";
import type { Rating, RatingReceipt, RatingValue } from "../domain/index.js";
import type { InteractionModerationService } from "./service.js";

export interface RatingRepositoryPort {
  /** Called only after Content is locked. Serialize missing and existing pairs. */
  lockCurrent(input: { portfolioId: StableId<"Portfolio">; projectId: StableId<"Project">; visitorId: StableId<"FunctionalVisitor"> }, tx: TransactionContext): Promise<Rating | null>;
  save(rating: Rating, tx: TransactionContext): Promise<void>;
}
export interface RatingApplicationDeps {
  readonly portfolioId: StableId<"Portfolio">;
  readonly operations: OperationsPersistencePorts;
  readonly content: ProjectInteractionEligibilityPort;
  readonly repository: RatingRepositoryPort;
  readonly clock: Clock;
  readonly ids: StableIdGenerator;
}
const unavailable = (): Result<never, Rejection> => ({ ok: false, error: { kind: "not_found", code: "PROJECT_UNAVAILABLE" } });

export function createRatingApplicationService(deps: RatingApplicationDeps): Pick<InteractionModerationService, "submitRating"> {
  return {
    async submitRating(command): Promise<Result<RatingReceipt, Rejection>> {
      if (command.scope.kind !== "portfolio" || command.scope.portfolioId !== deps.portfolioId) return unavailable();
      if (command.actor.kind !== "visitor" || !command.actor.functionalId || !parseStableId("FunctionalVisitor", command.actor.functionalId).ok) {
        return { ok: false, error: { kind: "forbidden", code: "VERIFIED_FUNCTIONAL_ID_REQUIRED" } };
      }
      if (!parseStableId("Project", command.projectId).ok || !parseIdempotencyKey(command.idempotencyKey).ok ||
          (!Number.isInteger(command.value) || command.value < 1 || command.value > 5)) {
        return { ok: false, error: { kind: "validation", code: "RATING_INVALID" } };
      }
      const visitorId = command.actor.functionalId;
      const portfolioId = deps.portfolioId;
      try {
        return await deps.operations.transactions.run<Result<RatingReceipt, Rejection>>(async tx => {
          const facts = await deps.content.getProjectInteractionFacts({ portfolioId, projectId: command.projectId }, tx);
          if (!facts.ok) return requestTransactionRollback({ ok: false, error: facts.error });
          if (facts.value.projectId !== command.projectId || facts.value.portfolioId !== portfolioId ||
              facts.value.lifecycle !== "published" || facts.value.publishedLocales.length === 0) return requestTransactionRollback(unavailable());
          const current = await deps.repository.lockCurrent({ portfolioId, projectId: command.projectId, visitorId }, tx);
          const now = deps.clock.now();
          const executed = await deps.operations.idempotency.execute({
            operationScope: "interaction.rating:" + portfolioId + ":" + command.projectId,
            actorScope: await hashCanonicalRequest({ purpose: "visitor_functional", portfolioId, visitorId }),
            key: command.idempotencyKey, requestHash: await hashCanonicalRequest({ projectId: command.projectId, value: command.value }),
            expiresAt: new Date(Date.parse(now) + 30 * 86400_000).toISOString(),
          }, async context => {
            if (current?.value !== command.value) {
              await deps.repository.save({ portfolioId, projectId: command.projectId, visitorId, value: command.value, updatedAt: now }, context);
              await deps.operations.outbox.append(context, { eventId: deps.ids.generate("Event"),
                payload: { type: "interaction.rating_changed.v1", version: 1, value: { projectId: command.projectId, value: command.value } },
                aggregateId: command.projectId, aggregateVersion: 1, correlationId: command.correlationId,
                occurredAt: now, availableAt: now });
            }
            return { projectId: command.projectId, value: command.value };
          }, tx);
          if (executed.kind === "conflict") return requestTransactionRollback({ ok: false, error: { kind: "conflict", code: "IDEMPOTENCY_PAYLOAD_CONFLICT" } });
          const receipt = executed.result;
          if (receipt["projectId"] !== command.projectId || (typeof receipt["value"] !== "number" || !Number.isInteger(receipt["value"]) || receipt["value"] < 1 || receipt["value"] > 5)) throw new Error("INVALID_SAFE_RECEIPT");
          return { ok: true, value: { projectId: command.projectId, value: receipt["value"] as RatingValue } };
        });
      } catch {
        return { ok: false, error: { kind: "temporarily_unavailable", code: "RATING_PERSISTENCE_UNAVAILABLE" } };
      }
    },
  };
}
