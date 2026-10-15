import { hashCanonicalRequest } from "../../../shared/application/index.js";
import { parseIdempotencyKey, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import type { Clock, StableIdGenerator, TransactionContext } from "../../../runtime/ports.js";
import { requestTransactionRollback } from "../../../runtime/ports.js";
import type { OperationsPersistencePorts } from "../../portability-operations/index.js";
import type { ProjectInteractionEligibilityPort } from "../../content-publishing/index.js";
import type { Reaction, ReactionReceipt } from "../domain/index.js";
import type { InteractionModerationService } from "./service.js";

export interface ReactionRepositoryPort {
  /** Called only after Content is locked. Serialize missing and existing pairs. */
  lockCurrent(input: { portfolioId: StableId<"Portfolio">; projectId: StableId<"Project">; visitorId: StableId<"FunctionalVisitor"> }, tx: TransactionContext): Promise<Reaction | null>;
  save(reaction: Reaction, tx: TransactionContext): Promise<void>;
}
export interface ReactionApplicationDeps {
  readonly portfolioId: StableId<"Portfolio">;
  readonly operations: OperationsPersistencePorts;
  readonly content: ProjectInteractionEligibilityPort;
  readonly repository: ReactionRepositoryPort;
  readonly clock: Clock;
  readonly ids: StableIdGenerator;
}
const unavailable = (): Result<never, Rejection> => ({ ok: false, error: { kind: "not_found", code: "PROJECT_UNAVAILABLE" } });

export function createReactionApplicationService(deps: ReactionApplicationDeps): Pick<InteractionModerationService, "submitReaction"> {
  return {
    async submitReaction(command): Promise<Result<ReactionReceipt, Rejection>> {
      if (command.scope.kind !== "portfolio" || command.scope.portfolioId !== deps.portfolioId) return unavailable();
      if (command.actor.kind !== "visitor" || !command.actor.functionalId || !parseStableId("FunctionalVisitor", command.actor.functionalId).ok) {
        return { ok: false, error: { kind: "forbidden", code: "VERIFIED_FUNCTIONAL_ID_REQUIRED" } };
      }
      if (!parseStableId("Project", command.projectId).ok || !parseIdempotencyKey(command.idempotencyKey).ok ||
          (command.kind !== "like" && command.kind !== "dislike")) {
        return { ok: false, error: { kind: "validation", code: "REACTION_INVALID" } };
      }
      const visitorId = command.actor.functionalId;
      const portfolioId = deps.portfolioId;
      try {
        return await deps.operations.transactions.run<Result<ReactionReceipt, Rejection>>(async tx => {
          const facts = await deps.content.getProjectInteractionFacts({ portfolioId, projectId: command.projectId }, tx);
          if (!facts.ok) return requestTransactionRollback({ ok: false, error: facts.error });
          if (facts.value.projectId !== command.projectId || facts.value.portfolioId !== portfolioId ||
              facts.value.lifecycle !== "published" || facts.value.publishedLocales.length === 0) return requestTransactionRollback(unavailable());
          const current = await deps.repository.lockCurrent({ portfolioId, projectId: command.projectId, visitorId }, tx);
          const now = deps.clock.now();
          const executed = await deps.operations.idempotency.execute({
            operationScope: "interaction.reaction:" + portfolioId + ":" + command.projectId,
            actorScope: await hashCanonicalRequest({ purpose: "visitor_functional", portfolioId, visitorId }),
            key: command.idempotencyKey, requestHash: await hashCanonicalRequest({ projectId: command.projectId, kind: command.kind }),
            expiresAt: new Date(Date.parse(now) + 30 * 86400_000).toISOString(),
          }, async context => {
            if (current?.kind !== command.kind) {
              await deps.repository.save({ portfolioId, projectId: command.projectId, visitorId, kind: command.kind, updatedAt: now }, context);
              await deps.operations.outbox.append(context, { eventId: deps.ids.generate("Event"),
                payload: { type: "interaction.reaction_changed.v1", version: 1, value: { projectId: command.projectId, kind: command.kind } },
                aggregateId: command.projectId, aggregateVersion: 1, correlationId: command.correlationId,
                occurredAt: now, availableAt: now });
            }
            return { projectId: command.projectId, kind: command.kind };
          }, tx);
          if (executed.kind === "conflict") return requestTransactionRollback({ ok: false, error: { kind: "conflict", code: "IDEMPOTENCY_PAYLOAD_CONFLICT" } });
          const receipt = executed.result;
          if (receipt["projectId"] !== command.projectId || (receipt["kind"] !== "like" && receipt["kind"] !== "dislike")) throw new Error("INVALID_SAFE_RECEIPT");
          return { ok: true, value: { projectId: command.projectId, kind: receipt["kind"] } };
        });
      } catch {
        return { ok: false, error: { kind: "temporarily_unavailable", code: "REACTION_PERSISTENCE_UNAVAILABLE" } };
      }
    },
  };
}
