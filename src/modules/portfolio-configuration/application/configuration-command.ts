import { err, parseStableId, type ActorContext, type IdempotencyKey, type Rejection, type Result, type StableId } from "@shared/domain";
import { hashCanonicalRequest } from "../../../shared/application/idempotency.js";
import type { Clock, StableIdGenerator, TransactionContext } from "../../../runtime/ports.js";
import { createSystemClock, createSystemIdGenerator } from "../../../runtime/ports.js";
import type { OperationsPersistencePorts, SafeResultEnvelope, VersionedPayload } from "../../portability-operations/index.js";
import type { PortfolioSettings, PortfolioProfile } from "../domain/index.js";
import type { PortfolioAggregateUpdate, PortfolioScope } from "../ports/index.js";
import type { PortfolioSettingsRepository } from "./settings-service.js";
import {
  outcomeFromRejection,
  readPortfolioCommandOutcome,
  rejectionFromPortfolioCommandOutcome,
} from "./command-outcome.js";

const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;

export interface PortfolioConfigurationCommandBase {
  readonly actor: ActorContext;
  readonly portfolioId: StableId<"Portfolio">;
  readonly expectedVersion: number;
  readonly idempotencyKey: IdempotencyKey;
  readonly correlationId: string;
  readonly causationId?: string;
}

export interface PortfolioConfigurationCommandReceipt {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome: "configuration-updated";
}

export function changedConfigurationFields<T extends object>(
  before: T,
  after: T,
  fields: readonly (keyof T & string)[],
): readonly (keyof T & string)[] {
  return fields.filter((field) => before[field] !== after[field]);
}

function meaningfulCorrelation(value: string): boolean {
  return /^[\x21-\x7e]{1,128}$/.test(value);
}

export async function executePortfolioConfigurationCommand<T>(input: {
  readonly command: PortfolioConfigurationCommandBase;
  readonly operationScope: string;
  readonly invalidCode: string;
  readonly request: unknown;
  /** Operation-specific canonical form; keep persisted retry hashes stable across versions. */
  readonly idempotencyRequest: unknown;
  readonly isValid: (request: unknown) => request is T;
  readonly apply: (request: T, context: TransactionContext) => Promise<Result<PortfolioAggregateUpdate, Rejection>>;
  readonly event: (before: PortfolioSettings, request: T, ownerScope: string) => VersionedPayload;
  readonly repository: Pick<PortfolioSettingsRepository, "getSettings">;
  readonly operations: OperationsPersistencePorts;
  readonly scope: PortfolioScope;
  readonly clock?: Clock;
  readonly ids?: StableIdGenerator;
}): Promise<Result<PortfolioConfigurationCommandReceipt, Rejection>> {
  const { command } = input;
  const request = input.request;
  if (command.actor.kind !== "owner" || command.actor.ownerId !== input.scope.ownerId) {
    return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
  }
  if (command.portfolioId !== input.scope.portfolioId) {
    return err({ kind: "forbidden", code: "PORTFOLIO_SCOPE_MISMATCH" });
  }
  if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) {
    return err({ kind: "validation", code: "INVALID_EXPECTED_VERSION" });
  }
  if (!input.isValid(request)) {
    return err({ kind: "validation", code: input.invalidCode });
  }
  if (!meaningfulCorrelation(command.correlationId) ||
      (command.causationId !== undefined && !meaningfulCorrelation(command.causationId))) {
    return err({ kind: "validation", code: "INVALID_CONFIGURATION_CORRELATION" });
  }

  const clock = input.clock ?? createSystemClock();
  const ids = input.ids ?? createSystemIdGenerator();
  const [requestHash, actorScope] = await Promise.all([
    hashCanonicalRequest(input.idempotencyRequest),
    hashCanonicalRequest({ ownerId: command.actor.ownerId }),
  ]);
  const now = clock.now();
  const expiresAt = new Date(Date.parse(now) + IDEMPOTENCY_RETENTION_MS).toISOString();
  const execution = await input.operations.idempotency.execute({
    operationScope: input.operationScope,
    actorScope,
    key: command.idempotencyKey,
    requestHash,
    expiresAt,
  }, async (context): Promise<SafeResultEnvelope> => {
    const current = await input.repository.getSettings(input.scope, context);
    if (!current.ok) return outcomeFromRejection(current.error);
    if (current.value.version !== command.expectedVersion) {
      return outcomeFromRejection({
        kind: "precondition_failed",
        code: "PORTFOLIO_SETTINGS_VERSION_MISMATCH",
        currentVersion: current.value.version,
      });
    }
    const updated = await input.apply(request, context);
    if (!updated.ok) return outcomeFromRejection(updated.error);

    await input.operations.outbox.append(context, {
      eventId: ids.generate("DomainEvent"),
      payload: input.event(current.value, request, actorScope),
      aggregateId: input.scope.portfolioId,
      aggregateVersion: updated.value.aggregateVersion,
      correlationId: command.correlationId,
      ...(command.causationId === undefined ? {} : { causationId: command.causationId }),
      occurredAt: updated.value.updatedAt,
      availableAt: updated.value.updatedAt,
    });
    return {
      kind: "completed",
      aggregateId: input.scope.portfolioId,
      aggregateVersion: updated.value.aggregateVersion,
    };
  });

  if (execution.kind === "conflict") return err({ kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" });
  const outcome = readPortfolioCommandOutcome(execution.result);
  if (outcome.kind === "rejected") return err(rejectionFromPortfolioCommandOutcome(outcome));
  const aggregateId = parseStableId("Portfolio", outcome.aggregateId);
  if (!aggregateId.ok || aggregateId.value !== input.scope.portfolioId) {
    throw new Error("Invalid stored configuration aggregate identity.");
  }
  return {
    ok: true,
    value: {
      aggregateId: aggregateId.value,
      aggregateVersion: outcome.aggregateVersion,
      outcome: "configuration-updated",
    },
  };
}
