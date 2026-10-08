import { err, type ActorContext, type IdempotencyKey, type Rejection, type Result, type StableId } from "../../../shared/domain/index.js";
import type { Clock, StableIdGenerator, TransactionContext } from "../../../runtime/ports.js";
import { createSystemClock, createSystemIdGenerator } from "../../../runtime/ports.js";
import { hashCanonicalRequest } from "../../../shared/application/idempotency.js";
import type { OperationsPersistencePorts, SafeResultEnvelope } from "../../portability-operations/index.js";

export type TaxonomyKind = "category" | "ai-ml-domain" | "technology" | "project-type";
export interface TaxonomyValueView {
  readonly valueId: StableId<"TaxonomyValue">;
  readonly name: string;
  readonly state: "active" | "retired" | "merged";
  readonly mergedIntoValueId?: StableId<"TaxonomyValue">;
}
export interface OwnerTaxonomyView {
  readonly taxonomyId: StableId<"Taxonomy">;
  readonly aggregateVersion: number;
  readonly kind: TaxonomyKind;
  readonly values: readonly TaxonomyValueView[];
}
export interface TaxonomyOwnerScope {
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
}
export interface TaxonomyOwnerRepository {
  getOwnerTaxonomy(input: { readonly taxonomyId: StableId<"Taxonomy">; readonly scope: TaxonomyOwnerScope }, context: TransactionContext): Promise<Result<OwnerTaxonomyView, Rejection>>;
  createValue(input: { readonly taxonomyId: StableId<"Taxonomy">; readonly valueId: StableId<"TaxonomyValue">; readonly name: string; readonly expectedVersion: number; readonly scope: TaxonomyOwnerScope }, context: TransactionContext): Promise<Result<{ readonly aggregateVersion: number }, Rejection>>;
}
export interface CreateOwnerTaxonomyValueCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly taxonomyId: StableId<"Taxonomy">;
  readonly name: string;
}
export interface TaxonomyOwnerService {
  getOwnerTaxonomy(input: { readonly actor: ActorContext; readonly taxonomyId: StableId<"Taxonomy"> }): Promise<Result<OwnerTaxonomyView, Rejection>>;
  createOwnerTaxonomyValue(command: CreateOwnerTaxonomyValueCommand): Promise<Result<{ readonly aggregateId: StableId<"Taxonomy">; readonly aggregateVersion: number; readonly outcome: "taxonomy-value-created" }, Rejection>>;
}

export function createTaxonomyOwnerService(input: {
  readonly repository: TaxonomyOwnerRepository;
  readonly operations: OperationsPersistencePorts;
  readonly scope: TaxonomyOwnerScope;
  readonly ids?: StableIdGenerator;
  readonly clock?: Clock;
}): TaxonomyOwnerService {
  const ids = input.ids ?? createSystemIdGenerator();
  const clock = input.clock ?? createSystemClock();
  const actorScope = hashCanonicalRequest({ ownerId: input.scope.ownerId });
  const authorized = (actor: ActorContext) => actor.kind === "owner" && actor.ownerId === input.scope.ownerId;

  return {
    async getOwnerTaxonomy(query) {
      if (!authorized(query.actor)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      return input.operations.transactions.run((context) => input.repository.getOwnerTaxonomy({ taxonomyId: query.taxonomyId, scope: input.scope }, context));
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
  };
}
