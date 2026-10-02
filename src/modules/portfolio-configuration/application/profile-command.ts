import { err, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import { hashCanonicalRequest } from "../../../shared/application/idempotency.js";
import type { Clock, StableIdGenerator } from "../../../runtime/ports.js";
import { createSystemClock, createSystemIdGenerator } from "../../../runtime/ports.js";
import type { OperationsPersistencePorts, SafeResultEnvelope } from "../../portability-operations/index.js";
import type { PortfolioScope } from "../ports/index.js";
import type { PortfolioProfile } from "../domain/index.js";
import type { UpdatePortfolioProfileCommand } from "./service.js";
import type { PortfolioSettingsRepository } from "./settings-service.js";

export interface PortfolioProfileCommandService {
  updateProfile(command: UpdatePortfolioProfileCommand): Promise<Result<PortfolioProfileCommandReceipt, Rejection>>;
}

export interface PortfolioProfileCommandReceipt {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome: "configuration-updated";
}

const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;
const OPERATION_SCOPE = "portfolio-configuration.update-owner-profile";

type StoredOutcome =
  | { readonly kind: "completed"; readonly aggregateId: string; readonly aggregateVersion: number }
  | { readonly kind: "rejected"; readonly rejectionKind: string; readonly code: string; readonly currentVersion?: number };

function validProfile(profile: unknown): profile is PortfolioProfile {
  if (profile === null || typeof profile !== "object") return false;
  const value = profile as Partial<PortfolioProfile>;
  return typeof value.displayName === "string" && value.displayName.trim().length > 0 &&
      value.displayName.length <= 100 &&
      typeof value.headline === "string" && value.headline.trim().length > 0 &&
      value.headline.length <= 160 &&
      typeof value.bio === "string" && value.bio.trim().length > 0 &&
      value.bio.length <= 4000 &&
      !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(
        value.displayName + value.headline + value.bio,
      );
}

function rejectionOutcome(rejection: Rejection): StoredOutcome {
  if (rejection.kind === "conflict" || rejection.kind === "precondition_failed") {
    return {
      kind: "rejected",
      rejectionKind: rejection.kind,
      code: rejection.code,
      ...(rejection.currentVersion === undefined ? {} : { currentVersion: rejection.currentVersion }),
    };
  }
  return { kind: "rejected", rejectionKind: rejection.kind, code: rejection.code };
}

function storedOutcome(result: SafeResultEnvelope): StoredOutcome {
  const kind = result["kind"];
  if (kind === "completed" && typeof result["aggregateId"] === "string" &&
      typeof result["aggregateVersion"] === "number" && Number.isSafeInteger(result["aggregateVersion"]) &&
      result["aggregateVersion"] > 0) {
    return {
      kind,
      aggregateId: result["aggregateId"],
      aggregateVersion: result["aggregateVersion"],
    };
  }
  if (kind === "rejected" && typeof result["rejectionKind"] === "string" &&
      typeof result["code"] === "string" &&
      (result["currentVersion"] === undefined || Number.isSafeInteger(result["currentVersion"]))) {
    return {
      kind,
      rejectionKind: result["rejectionKind"],
      code: result["code"],
      ...(typeof result["currentVersion"] === "number" ? { currentVersion: result["currentVersion"] } : {}),
    };
  }
  throw new Error("Invalid stored configuration command result.");
}

function asRejection(outcome: Extract<StoredOutcome, { kind: "rejected" }>): Rejection {
  switch (outcome.rejectionKind) {
    case "validation": return { kind: "validation", code: outcome.code };
    case "unauthenticated": return { kind: "unauthenticated", code: outcome.code };
    case "forbidden": return { kind: "forbidden", code: outcome.code };
    case "not_found": return { kind: "not_found", code: outcome.code };
    case "conflict": return { kind: "conflict", code: outcome.code, ...(outcome.currentVersion === undefined ? {} : { currentVersion: outcome.currentVersion }) };
    case "precondition_failed": return { kind: "precondition_failed", code: outcome.code, ...(outcome.currentVersion === undefined ? {} : { currentVersion: outcome.currentVersion }) };
    case "rate_limited": return { kind: "rate_limited", code: outcome.code, retryAfterSeconds: 60 };
    case "temporarily_unavailable": return { kind: "temporarily_unavailable", code: outcome.code };
    default: throw new Error("Invalid stored configuration rejection.");
  }
}

function changedProfileFields(before: PortfolioProfile, after: PortfolioProfile): readonly (keyof PortfolioProfile)[] {
  return ( ["displayName", "headline", "bio"] as const)
    .filter((field) => before[field] !== after[field]);
}

export function createPortfolioProfileCommandService(input: {
  readonly repository: Pick<PortfolioSettingsRepository, "getSettings" | "updateProfile">;
  readonly operations: OperationsPersistencePorts;
  readonly scope: PortfolioScope;
  readonly clock?: Clock;
  readonly ids?: StableIdGenerator;
}): PortfolioProfileCommandService {
  const clock = input.clock ?? createSystemClock();
  const ids = input.ids ?? createSystemIdGenerator();

  return {
    async updateProfile(command) {
      // Authorization always precedes access to the shared replay ledger.
      if (command.actor.kind !== "owner" || command.actor.ownerId !== input.scope.ownerId) {
        return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      }
      if (command.portfolioId !== input.scope.portfolioId) {
        return err({ kind: "forbidden", code: "PORTFOLIO_SCOPE_MISMATCH" });
      }
      if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) {
        return err({ kind: "validation", code: "INVALID_EXPECTED_VERSION" });
      }
      if (!validProfile(command.profile)) {
        return err({ kind: "validation", code: "INVALID_PORTFOLIO_PROFILE" });
      }
      if (!/^[\x21-\x7e]{1,128}$/.test(command.correlationId) ||
          (command.causationId !== undefined && !/^[\x21-\x7e]{1,128}$/.test(command.causationId))) {
        return err({ kind: "validation", code: "INVALID_CONFIGURATION_CORRELATION" });
      }

      const request = {
        expectedVersion: command.expectedVersion,
        profile: {
          displayName: command.profile.displayName,
          headline: command.profile.headline,
          bio: command.profile.bio,
        },
      };
      const [requestHash, actorScope] = await Promise.all([
        hashCanonicalRequest(request),
        hashCanonicalRequest({ ownerId: command.actor.ownerId }),
      ]);
      const now = clock.now();
      const expiresAt = new Date(Date.parse(now) + IDEMPOTENCY_RETENTION_MS).toISOString();
      const execution = await input.operations.idempotency.execute({
        operationScope: OPERATION_SCOPE,
        actorScope,
        key: command.idempotencyKey,
        requestHash,
        expiresAt,
      }, async (context): Promise<SafeResultEnvelope> => {
        const current = await input.repository.getSettings(input.scope, context);
        if (!current.ok) return rejectionOutcome(current.error);
        if (current.value.version !== command.expectedVersion) {
          return rejectionOutcome({
            kind: "precondition_failed",
            code: "PORTFOLIO_SETTINGS_VERSION_MISMATCH",
            currentVersion: current.value.version,
          });
        }
        const updated = await input.repository.updateProfile(
          input.scope,
          command.profile,
          command.expectedVersion,
          context,
        );
        if (!updated.ok) return rejectionOutcome(updated.error);

        await input.operations.outbox.append(context, {
          eventId: ids.generate("DomainEvent"),
          payload: {
            type: "portfolio_configuration.profile_updated.v1",
            version: 1,
            value: {
              changedFields: changedProfileFields(current.value.profile, command.profile),
              ownerScope: actorScope,
            },
          },
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

      if (execution.kind === "conflict") {
        return err({ kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" });
      }
      const outcome = storedOutcome(execution.result);
      if (outcome.kind === "rejected") return err(asRejection(outcome));
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
    },
  };
}
