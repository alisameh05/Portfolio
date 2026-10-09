import { err, type ActorContext, type IdempotencyKey, type Rejection, type Result, type StableId } from "../../../shared/domain/index.js";
import type { Clock, StableIdGenerator, TransactionContext } from "../../../runtime/ports.js";
import { createSystemClock, createSystemIdGenerator } from "../../../runtime/ports.js";
import { hashCanonicalRequest, type CanonicalValue } from "../../../shared/application/idempotency.js";
import type { OperationsPersistencePorts, SafeResultEnvelope } from "../../portability-operations/index.js";
import type { ContentTaxonomyAssignmentsPort } from "../../content-publishing/index.js";

export type TaxonomyKind = "category" | "ai-ml-domain" | "technology" | "project-type";
export interface TaxonomyValueView {
  readonly valueId: StableId<"TaxonomyValue">;
  readonly name: string;
  readonly state: "active" | "retired" | "merged";
  readonly mergedIntoValueId?: StableId<"TaxonomyValue">;
}
export interface TaxonomyEvolutionHistoryView {
  readonly valueId: StableId<"TaxonomyValue">;
  readonly action: "created" | "renamed" | "retired" | "merged";
  readonly previousLabel: string | null;
  readonly label: string;
  readonly aggregateVersion: number;
  readonly changedAt: string;
}
export interface OwnerTaxonomyView {
  readonly taxonomyId: StableId<"Taxonomy">;
  readonly aggregateVersion: number;
  readonly kind: TaxonomyKind;
  readonly values: readonly TaxonomyValueView[];
  readonly history: readonly TaxonomyEvolutionHistoryView[];
  readonly assignmentHistory: readonly {
    readonly projectId: StableId<"Project">;
    readonly valueId: StableId<"TaxonomyValue">;
    readonly aggregateVersion: number;
    readonly changedAt: string;
  }[];
}
export interface TaxonomyOwnerScope {
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
}
export interface TaxonomyOwnerRepository {
  getOwnerTaxonomy(input: { readonly taxonomyId: StableId<"Taxonomy">; readonly scope: TaxonomyOwnerScope }, context: TransactionContext): Promise<Result<Omit<OwnerTaxonomyView, "assignmentHistory">, Rejection>>;
  createValue(input: { readonly taxonomyId: StableId<"Taxonomy">; readonly valueId: StableId<"TaxonomyValue">; readonly name: string; readonly expectedVersion: number; readonly scope: TaxonomyOwnerScope }, context: TransactionContext): Promise<Result<{ readonly aggregateVersion: number }, Rejection>>;
  renameValue(input: { readonly valueId: StableId<"TaxonomyValue">; readonly name: string; readonly expectedVersion: number; readonly actorId: StableId<"Owner">; readonly scope: TaxonomyOwnerScope }, context: TransactionContext): Promise<Result<TaxonomyEvolutionResult, Rejection>>;
  retireValue(input: { readonly valueId: StableId<"TaxonomyValue">; readonly reason?: string; readonly expectedVersion: number; readonly actorId: StableId<"Owner">; readonly scope: TaxonomyOwnerScope }, context: TransactionContext): Promise<Result<TaxonomyEvolutionResult, Rejection>>;
  mergeValue(input: { readonly sourceValueId: StableId<"TaxonomyValue">; readonly targetValueId: StableId<"TaxonomyValue">; readonly expectedVersion: number; readonly actorId: StableId<"Owner">; readonly scope: TaxonomyOwnerScope }, contentAssignments: ContentTaxonomyAssignmentsPort, context: TransactionContext): Promise<Result<TaxonomyEvolutionResult, Rejection>>;
}
export interface TaxonomyEvolutionResult {
  readonly taxonomyId: StableId<"Taxonomy">;
  readonly aggregateVersion: number;
  readonly changed: boolean;
  readonly previousLabel?: string;
  readonly label: string;
}
export interface CreateOwnerTaxonomyValueCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly taxonomyId: StableId<"Taxonomy">;
  readonly name: string;
}
export interface RenameOwnerTaxonomyValueCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly valueId: StableId<"TaxonomyValue">;
  readonly name: string;
}
export interface RetireOwnerTaxonomyValueCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly valueId: StableId<"TaxonomyValue">;
  readonly reason?: string;
}
export interface TaxonomyOwnerService {
  getOwnerTaxonomy(input: { readonly actor: ActorContext; readonly taxonomyId: StableId<"Taxonomy"> }): Promise<Result<OwnerTaxonomyView, Rejection>>;
  createOwnerTaxonomyValue(command: CreateOwnerTaxonomyValueCommand): Promise<Result<{ readonly aggregateId: StableId<"Taxonomy">; readonly aggregateVersion: number; readonly outcome: "taxonomy-value-created" }, Rejection>>;
  renameOwnerTaxonomyValue(command: RenameOwnerTaxonomyValueCommand): Promise<Result<{ readonly aggregateId: StableId<"Taxonomy">; readonly aggregateVersion: number; readonly outcome: "taxonomy-value-renamed" }, Rejection>>;
  retireOwnerTaxonomyValue(command: RetireOwnerTaxonomyValueCommand): Promise<Result<{ readonly aggregateId: StableId<"Taxonomy">; readonly aggregateVersion: number; readonly outcome: "taxonomy-value-retired" }, Rejection>>;
  mergeOwnerTaxonomyValue(command: { readonly actor: ActorContext; readonly idempotencyKey: IdempotencyKey; readonly expectedVersion: number; readonly sourceValueId: StableId<"TaxonomyValue">; readonly targetValueId: StableId<"TaxonomyValue"> }): Promise<Result<{ readonly aggregateId: StableId<"Taxonomy">; readonly aggregateVersion: number; readonly outcome: "taxonomy-value-merged" }, Rejection>>;
}

export function createTaxonomyOwnerService(input: {
  readonly repository: TaxonomyOwnerRepository;
  readonly operations: OperationsPersistencePorts;
  readonly scope: TaxonomyOwnerScope;
  readonly contentAssignments: ContentTaxonomyAssignmentsPort;
  readonly ids?: StableIdGenerator;
  readonly clock?: Clock;
}): TaxonomyOwnerService {
  const ids = input.ids ?? createSystemIdGenerator();
  const clock = input.clock ?? createSystemClock();
  const actorScope = hashCanonicalRequest({ ownerId: input.scope.ownerId });
  const authorized = (actor: ActorContext) => actor.kind === "owner" && actor.ownerId === input.scope.ownerId;
  const commandExpiry = () => new Date(Date.parse(clock.now()) + 30 * 24 * 60 * 60 * 1000).toISOString();
  const runEvolution = async (
    operation: "rename-value" | "retire-value",
    command: RenameOwnerTaxonomyValueCommand | RetireOwnerTaxonomyValueCommand,
    request: CanonicalValue,
    apply: (context: TransactionContext) => Promise<Result<TaxonomyEvolutionResult, Rejection>>,
  ): Promise<Result<{ readonly aggregateId: StableId<"Taxonomy">; readonly aggregateVersion: number; readonly outcome: "taxonomy-value-renamed" | "taxonomy-value-retired" }, Rejection>> => {
    const requestHash = await hashCanonicalRequest(request);
    const ownerHash = await actorScope;
    const expiresAt = commandExpiry();
    const execution = await input.operations.idempotency.execute({
      operationScope: `taxonomy-discovery.${operation}`,
      actorScope: ownerHash,
      key: command.idempotencyKey,
      requestHash,
      expiresAt,
    }, async (context): Promise<SafeResultEnvelope> => {
      const changed = await apply(context);
      if (!changed.ok) return { status: "rejected", error: {
        kind: changed.error.kind,
        code: changed.error.code,
        ...(changed.error.kind === "precondition_failed" && changed.error.currentVersion !== undefined
          ? { currentVersion: changed.error.currentVersion }
          : {}),
      } };
      if (changed.value.changed) {
        const occurredAt = clock.now();
        const renamed = operation === "rename-value";
        await input.operations.outbox.append(context, {
          eventId: ids.generate("DomainEvent"),
          payload: renamed
            ? { type: "taxonomy.value_renamed.v1", version: 1, value: {
                taxonomyId: changed.value.taxonomyId,
                valueId: command.valueId,
                previousLabel: changed.value.previousLabel ?? changed.value.label,
                newLabel: changed.value.label,
                ownerScope: ownerHash,
              } as const }
            : { type: "taxonomy.value_retired.v1", version: 1, value: {
                taxonomyId: changed.value.taxonomyId,
                valueId: command.valueId,
                ownerScope: ownerHash,
              } as const },
          aggregateId: changed.value.taxonomyId,
          aggregateVersion: changed.value.aggregateVersion,
          correlationId: `taxonomy:${changed.value.taxonomyId}`,
          occurredAt,
          availableAt: occurredAt,
        });
      }
      return { status: "completed", receipt: {
        aggregateId: changed.value.taxonomyId,
        aggregateVersion: changed.value.aggregateVersion,
        outcome: operation === "rename-value" ? "taxonomy-value-renamed" : "taxonomy-value-retired",
      } };
    });
    if (execution.kind === "conflict") return err({ kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" });
    const result = execution.result;
    if (result["status"] === "completed" && typeof result["receipt"] === "object" && result["receipt"] !== null) {
      const receipt = result["receipt"] as Record<string, unknown>;
      const expectedOutcome = operation === "rename-value" ? "taxonomy-value-renamed" : "taxonomy-value-retired";
      if (typeof receipt["aggregateId"] === "string" && Number.isSafeInteger(receipt["aggregateVersion"]) && receipt["outcome"] === expectedOutcome) {
        return { ok: true, value: {
          aggregateId: receipt["aggregateId"] as StableId<"Taxonomy">,
          aggregateVersion: receipt["aggregateVersion"] as number,
          outcome: expectedOutcome,
        } };
      }
    }
    const rejection = result["error"] as { kind?: string; code?: string; currentVersion?: number } | undefined;
    if (result["status"] === "rejected" && rejection?.kind !== undefined && rejection.code !== undefined) {
      if (rejection.kind === "precondition_failed" && Number.isSafeInteger(rejection.currentVersion)) {
        return err({ kind: "precondition_failed", code: rejection.code, currentVersion: rejection.currentVersion! });
      }
      return err({ kind: rejection.kind as Rejection["kind"], code: rejection.code } as Rejection);
    }
    return err({ kind: "temporarily_unavailable", code: "TAXONOMY_COMMAND_FAILED" });
  };

  return {
    async getOwnerTaxonomy(query) {
      if (!authorized(query.actor)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      return input.operations.transactions.run(async (context) => {
        const taxonomy = await input.repository.getOwnerTaxonomy({ taxonomyId: query.taxonomyId, scope: input.scope }, context);
        if (!taxonomy.ok) return taxonomy;
        const assignmentHistory = await input.contentAssignments.listAssignmentHistory(query.taxonomyId, 100, context);
        return { ok: true, value: { ...taxonomy.value, assignmentHistory } };
      });
    },
    async createOwnerTaxonomyValue(command) {
      if (!authorized(command.actor)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      const name = command.name.normalize("NFKC").replace(/\s+/g, " ").trim();
      if (name.length < 1 || name.length > 100 || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) {
        return err({ kind: "validation", code: "INVALID_TAXONOMY_VALUE" });
      }
      const requestHash = await hashCanonicalRequest({ taxonomyId: command.taxonomyId, name, expectedVersion: command.expectedVersion });
      const ownerHash = await actorScope;
      const valueId = ids.generate("TaxonomyValue") as StableId<"TaxonomyValue">;
      const expiresAt = new Date(Date.parse(clock.now()) + 30 * 24 * 60 * 60 * 1000).toISOString();
      const execution = await input.operations.idempotency.execute({
        operationScope: "taxonomy-discovery.create-value",
        actorScope: ownerHash,
        key: command.idempotencyKey,
        requestHash,
        expiresAt,
      }, async (context): Promise<SafeResultEnvelope> => {
        const created = await input.repository.createValue({ taxonomyId: command.taxonomyId, valueId, name, expectedVersion: command.expectedVersion, scope: input.scope }, context);
        if (!created.ok) return { status: "rejected", error: {
          kind: created.error.kind,
          code: created.error.code,
          ...(created.error.kind === "precondition_failed" && created.error.currentVersion !== undefined
            ? { currentVersion: created.error.currentVersion }
            : {}),
        } };
        const occurredAt = clock.now();
        await input.operations.outbox.append(context, {
          eventId: ids.generate("DomainEvent"),
          payload: { type: "taxonomy.value_created.v1", version: 1, value: { taxonomyId: command.taxonomyId, valueId, ownerScope: ownerHash } },
          aggregateId: command.taxonomyId,
          aggregateVersion: created.value.aggregateVersion,
          correlationId: "taxonomy:" + command.taxonomyId,
          occurredAt,
          availableAt: occurredAt,
        });
        return { status: "completed", receipt: { aggregateId: command.taxonomyId, aggregateVersion: created.value.aggregateVersion, outcome: "taxonomy-value-created" } };
      });
      if (execution.kind === "conflict") return err({ kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" });
      const result = execution.result;
      if (result["status"] === "completed" && typeof result["receipt"] === "object" && result["receipt"] !== null) {
        const receipt = result["receipt"] as Record<string, unknown>;
        if (receipt["aggregateId"] === command.taxonomyId && Number.isSafeInteger(receipt["aggregateVersion"])) {
          return { ok: true, value: { aggregateId: command.taxonomyId, aggregateVersion: receipt["aggregateVersion"] as number, outcome: "taxonomy-value-created" } };
        }
      }
      const rejection = result["error"] as { kind?: string; code?: string; currentVersion?: number } | undefined;
      if (result["status"] === "rejected" && rejection?.kind !== undefined && rejection.code !== undefined) {
        if (rejection.kind === "precondition_failed" && Number.isSafeInteger(rejection.currentVersion)) {
          return err({ kind: "precondition_failed", code: rejection.code, currentVersion: rejection.currentVersion! });
        }
        return err({ kind: rejection.kind as Rejection["kind"], code: rejection.code } as Rejection);
      }
      return err({ kind: "temporarily_unavailable", code: "TAXONOMY_COMMAND_FAILED" });
    },
    async renameOwnerTaxonomyValue(command) {
      if (!authorized(command.actor)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      const name = command.name.normalize("NFKC").replace(/\s+/g, " ").trim();
      if (name.length < 1 || name.length > 100 || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) {
        return err({ kind: "validation", code: "INVALID_TAXONOMY_VALUE" });
      }
      const result = await runEvolution("rename-value", command, {
        valueId: command.valueId, name, expectedVersion: command.expectedVersion,
      }, (context) => input.repository.renameValue({
        valueId: command.valueId, name, expectedVersion: command.expectedVersion,
        actorId: input.scope.ownerId, scope: input.scope,
      }, context));
      return result.ok ? { ok: true, value: { ...result.value, outcome: "taxonomy-value-renamed" as const } } : result;
    },
    async retireOwnerTaxonomyValue(command) {
      if (!authorized(command.actor)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      const reason = command.reason?.normalize("NFKC").replace(/\s+/g, " ").trim();
      if ((reason !== undefined && (reason.length < 1 || reason.length > 500)) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) {
        return err({ kind: "validation", code: "INVALID_TAXONOMY_RETIREMENT" });
      }
      const result = await runEvolution("retire-value", command, {
        valueId: command.valueId, ...(reason === undefined ? {} : { reason }), expectedVersion: command.expectedVersion,
      }, (context) => input.repository.retireValue({
        valueId: command.valueId, ...(reason === undefined ? {} : { reason }),
        expectedVersion: command.expectedVersion, actorId: input.scope.ownerId, scope: input.scope,
      }, context));
      return result.ok ? { ok: true, value: { ...result.value, outcome: "taxonomy-value-retired" as const } } : result;
    },
    async mergeOwnerTaxonomyValue(command) {
      if (!authorized(command.actor)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      if (command.sourceValueId === command.targetValueId) return err({ kind: "validation", code: "TAXONOMY_MERGE_VALUES_MUST_DIFFER" });
      if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) return err({ kind: "validation", code: "INVALID_TAXONOMY_MERGE" });
      const requestHash = await hashCanonicalRequest({
        sourceValueId: command.sourceValueId, targetValueId: command.targetValueId, expectedVersion: command.expectedVersion,
      });
      const ownerHash = await actorScope;
      let execution: Awaited<ReturnType<OperationsPersistencePorts["idempotency"]["execute"]>>;
      try {
        execution = await input.operations.idempotency.execute({
        operationScope: "taxonomy-discovery.merge-value",
        actorScope: ownerHash,
        key: command.idempotencyKey,
        requestHash,
        expiresAt: commandExpiry(),
      }, async (context): Promise<SafeResultEnvelope> => {
        const merged = await input.repository.mergeValue({
          sourceValueId: command.sourceValueId,
          targetValueId: command.targetValueId,
          expectedVersion: command.expectedVersion,
          actorId: input.scope.ownerId,
          scope: input.scope,
        }, input.contentAssignments, context);
        if (!merged.ok) return { status: "rejected", error: {
          kind: merged.error.kind,
          code: merged.error.code,
          ...(merged.error.kind === "precondition_failed" && merged.error.currentVersion !== undefined
            ? { currentVersion: merged.error.currentVersion }
            : {}),
        } };
        const occurredAt = clock.now();
        await input.operations.outbox.append(context, {
          eventId: ids.generate("DomainEvent"),
          payload: { type: "taxonomy.value_merged.v1", version: 1, value: {
            taxonomyId: merged.value.taxonomyId,
            sourceValueId: command.sourceValueId,
            targetValueId: command.targetValueId,
            ownerScope: ownerHash,
          } as const },
          aggregateId: merged.value.taxonomyId,
          aggregateVersion: merged.value.aggregateVersion,
          correlationId: `taxonomy:${merged.value.taxonomyId}`,
          occurredAt,
          availableAt: occurredAt,
        });
        return { status: "completed", receipt: {
          aggregateId: merged.value.taxonomyId,
          aggregateVersion: merged.value.aggregateVersion,
          outcome: "taxonomy-value-merged",
        } };
        });
      } catch {
        // The transaction runner rolls back first. Timeout/deadlock and other
        // persistence failures share this safe retryable Owner response.
        return err({ kind: "temporarily_unavailable", code: "TAXONOMY_MERGE_RETRYABLE" });
      }
      if (execution.kind === "conflict") return err({ kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" });
      const result = execution.result;
      if (result["status"] === "completed" && typeof result["receipt"] === "object" && result["receipt"] !== null) {
        const receipt = result["receipt"] as Record<string, unknown>;
        if (typeof receipt["aggregateId"] === "string" && Number.isSafeInteger(receipt["aggregateVersion"]) && receipt["outcome"] === "taxonomy-value-merged") {
          return { ok: true, value: { aggregateId: receipt["aggregateId"] as StableId<"Taxonomy">, aggregateVersion: receipt["aggregateVersion"] as number, outcome: "taxonomy-value-merged" } };
        }
      }
      const rejection = result["error"] as { kind?: string; code?: string; currentVersion?: number } | undefined;
      if (result["status"] === "rejected" && rejection?.kind !== undefined && rejection.code !== undefined) {
        if (rejection.kind === "precondition_failed" && Number.isSafeInteger(rejection.currentVersion)) {
          return err({ kind: "precondition_failed", code: rejection.code, currentVersion: rejection.currentVersion! });
        }
        return err({ kind: rejection.kind as Rejection["kind"], code: rejection.code } as Rejection);
      }
      return err({ kind: "temporarily_unavailable", code: "TAXONOMY_MERGE_FAILED" });
    },
  };
}
