import { err, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import type { BoundedWorkResult } from "@shared/application";
import type { TransactionRunner } from "../../../runtime/ports.js";
import type { FeedbackRetentionRepositoryPort } from "../ports/retention.js";
import type { FeedbackWorkCommand, FeedbackWorkService } from "./work.js";

export interface FeedbackRetentionWorkDependencies {
  readonly portfolioId: StableId<"Portfolio">;
  readonly transactions: Pick<TransactionRunner, "run">;
  readonly repository: FeedbackRetentionRepositoryPort;
}

const unavailable = () => err<Rejection>({ kind: "temporarily_unavailable", code: "FEEDBACK_RETENTION_UNAVAILABLE" });
const invalid = () => err<Rejection>({ kind: "validation", code: "FEEDBACK_RETENTION_COMMAND_INVALID" });
const denied = () => err<Rejection>({ kind: "forbidden", code: "FEEDBACK_RETENTION_NOT_PERMITTED" });

function validInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function createFeedbackRetentionWorkService(deps: FeedbackRetentionWorkDependencies): FeedbackWorkService {
  return {
    async expireFeedback(command: FeedbackWorkCommand): Promise<Result<BoundedWorkResult, Rejection>> {
      if (command.scope.kind !== "portfolio" || command.scope.portfolioId !== deps.portfolioId) return denied();
      if (command.actor.kind !== "system" || command.actor.purpose !== "feedback.retention") return denied();
      if (!parseStableId("Job", command.actor.jobId).ok || ![25, 50, 100].includes(command.batchSize) ||
          !validInstant(command.now) || typeof command.correlationId !== "string" ||
          command.correlationId.length < 1 || command.correlationId.length > 200 ||
          (command.cursor !== undefined && command.cursor !== command.actor.jobId)) return invalid();
      try {
        return await deps.transactions.run(async transaction => ({ ok: true, value: await deps.repository.processBatch({
          portfolioId: deps.portfolioId, jobId: command.actor.jobId,
          batchSize: command.batchSize, now: command.now,
        }, transaction) }));
      } catch {
        return unavailable();
      }
    },
  };
}

const DAY_MS = 86_400_000;
export function pendingFeedbackExpiryAt(submittedAt: string): string {
  const submitted = Date.parse(submittedAt);
  if (!Number.isFinite(submitted)) throw new Error("FEEDBACK_RETENTION_INSTANT_INVALID");
  return new Date(submitted + 90 * DAY_MS).toISOString();
}

export function suppressedFeedbackExpiryAt(suppressedAt: string): string {
  const parsed = Date.parse(suppressedAt);
  if (!Number.isFinite(parsed)) throw new Error("FEEDBACK_RETENTION_INSTANT_INVALID");
  const date = new Date(parsed);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString();
}
