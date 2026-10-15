import { hashCanonicalRequest, type CanonicalValue } from "../../../shared/application/index.js";
import { parseIdempotencyKey, parseStableId, type ActorContext, type Rejection, type Result, type StableId } from "@shared/domain";
import { requestTransactionRollback, type Clock, type StableIdGenerator, type TransactionContext } from "../../../runtime/ports.js";
import type { OperationsPersistencePorts } from "../../portability-operations/index.js";
import type { AuthorizeOperationQuery } from "../../identity-access/index.js";
import type { AnalyticsGoalRootRecord, AnalyticsGoalVersionRecord, OwnerAnalyticsGoalRepositoryPort } from "../ports/repository.js";
import type {
  AnalyticsEventAction, AnalyticsGoalDefinition, AnalyticsGoalAggregateView, AnalyticsGoalVersionView,
  AnalyticsGoalVersionReceipt, CreateOwnerAnalyticsGoalVersionApplicationCommand, GetOwnerAnalyticsGoalQuery,
  ActivateOwnerAnalyticsGoalVersionApplicationCommand, AnalyticsGoalActivationReceipt, OwnerAnalyticsApplicationService,
} from "./owner-analytics.js";

export interface AnalyticsGoalScopeFactsPort {
  hasRetainedRoute(input: { readonly portfolioId: StableId<"Portfolio">; readonly routeId: StableId<"PublicRoute"> }, transaction: TransactionContext): Promise<Result<boolean, Rejection>>;
  hasRetainedProject(input: { readonly portfolioId: StableId<"Portfolio">; readonly projectId: StableId<"Project"> }, transaction: TransactionContext): Promise<Result<boolean, Rejection>>;
}

export interface OwnerAnalyticsGoalServiceDependencies {
  readonly scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> };
  readonly authorize: (query: AuthorizeOperationQuery) => Promise<Result<boolean, Rejection>>;
  readonly operations: OperationsPersistencePorts;
  readonly repository: OwnerAnalyticsGoalRepositoryPort;
  readonly scopeFacts: AnalyticsGoalScopeFactsPort;
  readonly clock: Clock;
  readonly ids: StableIdGenerator;
}

const reject = (kind: Rejection["kind"], code: string, currentVersion?: number): Result<never, Rejection> => ({
  ok: false,
  error: { kind, code, ...(currentVersion === undefined ? {} : { currentVersion }) } as Rejection,
});
const unavailable = () => reject("temporarily_unavailable", "ANALYTICS_GOAL_UNAVAILABLE");
const ACTIONS = new Set<AnalyticsEventAction>([
  "page-viewed", "project-viewed", "active-engagement-sampled", "media-engaged", "related-project-opened",
  "contact-channel-opened", "external-project-link-opened", "testimonial-engaged", "global-project-cta-opened",
]);
const REQUEST_FIELDS = new Set(["scope", "correlationId", "actor", "idempotencyKey", "expectedVersion", "goalId", "definition"]);
const ACTIVATION_REQUEST_FIELDS = new Set(["scope", "correlationId", "actor", "idempotencyKey", "expectedVersion", "goalId", "versionId"]);
const DEFINITION_FIELDS = new Set(["name", "steps"]);
const STEP_FIELDS = new Set(["action", "publicRouteIds", "projectIds"]);

function validOwner(actor: ActorContext, scope: OwnerAnalyticsGoalServiceDependencies["scope"]): boolean {
  return actor.kind === "owner" && actor.ownerId === scope.ownerId && typeof actor.sessionId === "string" && actor.sessionId.length > 0;
}

function normalizeDefinition(value: AnalyticsGoalDefinition): Result<AnalyticsGoalDefinition, Rejection> {
  if (!value || typeof value !== "object" || Object.keys(value).some(key => !DEFINITION_FIELDS.has(key)) ||
      typeof value.name !== "string" || !Array.isArray(value.steps)) return reject("validation", "ANALYTICS_GOAL_DEFINITION_INVALID");
  const name = value.name.normalize("NFC").trim();
  if (!name || name.length > 120 || value.steps.length < 1 || value.steps.length > 10) return reject("validation", "ANALYTICS_GOAL_DEFINITION_INVALID");
  const steps: Array<AnalyticsGoalDefinition["steps"][number]> = [];
  for (const candidate of value.steps) {
    if (!candidate || typeof candidate !== "object" || Object.keys(candidate).some(key => !STEP_FIELDS.has(key)) ||
        !ACTIONS.has(candidate.action)) return reject("validation", "ANALYTICS_GOAL_STEP_INVALID");
    const next: { action: AnalyticsEventAction; publicRouteIds?: readonly StableId<"PublicRoute">[]; projectIds?: readonly StableId<"Project">[] } = { action: candidate.action };
    for (const [field, kind, maximum] of [["publicRouteIds", "PublicRoute", 100], ["projectIds", "Project", 100]] as const) {
      const entries: unknown = candidate[field];
      if (entries === undefined) continue;
      if (!Array.isArray(entries) || entries.length > maximum || new Set(entries).size !== entries.length ||
          entries.some(id => typeof id !== "string" || !parseStableId(kind, id).ok)) return reject("validation", "ANALYTICS_GOAL_SCOPE_INVALID");
      if (field === "publicRouteIds") next.publicRouteIds = [...entries] as StableId<"PublicRoute">[];
      else next.projectIds = [...entries] as StableId<"Project">[];
    }
    steps.push(Object.freeze(next));
  }
  return { ok: true, value: Object.freeze({ name, steps: Object.freeze(steps) }) };
}

async function validateScopes(definition: AnalyticsGoalDefinition, deps: OwnerAnalyticsGoalServiceDependencies, tx: TransactionContext): Promise<Result<void, Rejection>> {
  for (const step of definition.steps) {
    for (const routeId of step.publicRouteIds ?? []) {
      const route = await deps.scopeFacts.hasRetainedRoute({ portfolioId: deps.scope.portfolioId, routeId }, tx);
      if (!route.ok) return route;
      if (!route.value) return reject("validation", "ANALYTICS_GOAL_SCOPE_UNAVAILABLE");
    }
    for (const projectId of step.projectIds ?? []) {
      const project = await deps.scopeFacts.hasRetainedProject({ portfolioId: deps.scope.portfolioId, projectId }, tx);
      if (!project.ok) return project;
      if (!project.value) return reject("validation", "ANALYTICS_GOAL_SCOPE_UNAVAILABLE");
    }
  }
  return { ok: true, value: undefined };
}

function asVersionView(row: AnalyticsGoalVersionRecord): AnalyticsGoalVersionView {
  return { versionId: row.versionId, versionNumber: row.versionNumber, definition: row.definition, createdAt: row.createdAt };
}

function isReceipt(value: Record<string, unknown>, goalId: StableId<"AnalyticsGoal">): value is Record<string, unknown> & {
  goalId: StableId<"AnalyticsGoal">; versionId: StableId<"AnalyticsGoalVersion">; aggregateVersion: number; outcome: "analytics-goal-version-created";
} {
  return value["goalId"] === goalId && typeof value["versionId"] === "string" && parseStableId("AnalyticsGoalVersion", value["versionId"]).ok &&
    Number.isSafeInteger(value["aggregateVersion"]) && (value["aggregateVersion"] as number) >= 2 && value["outcome"] === "analytics-goal-version-created" && Object.keys(value).length === 4;
}

function isActivationReceipt(value: Record<string, unknown>, goalId: StableId<"AnalyticsGoal">): value is Record<string, unknown> & {
  aggregateId: StableId<"AnalyticsGoal">; aggregateVersion: number; outcome: "analytics-goal-version-activated";
} {
  return value["aggregateId"] === goalId && Number.isSafeInteger(value["aggregateVersion"]) &&
    (value["aggregateVersion"] as number) >= 2 && value["outcome"] === "analytics-goal-version-activated" && Object.keys(value).length === 3;
}

export function createOwnerAnalyticsGoalService(deps: OwnerAnalyticsGoalServiceDependencies): OwnerAnalyticsApplicationService {
  async function authorize(query: GetOwnerAnalyticsGoalQuery | CreateOwnerAnalyticsGoalVersionApplicationCommand | ActivateOwnerAnalyticsGoalVersionApplicationCommand): Promise<Result<void, Rejection>> {
    if (!validOwner(query.actor, deps.scope) || query.scope.kind !== "portfolio" || query.scope.portfolioId !== deps.scope.portfolioId) return reject("forbidden", "OWNER_SCOPE_REQUIRED");
    const permitted = await deps.authorize({ actor: query.actor, requiredPermission: "write:owner" });
    if (!permitted.ok) return permitted;
    return permitted.value ? { ok: true, value: undefined } : reject("forbidden", "OPERATION_NOT_PERMITTED");
  }

  return {
    async getOwnerAnalyticsGoal(query) {
      try {
        const access = await authorize(query);
        if (!access.ok) return access;
        if (!parseStableId("AnalyticsGoal", query.goalId).ok) return reject("validation", "ANALYTICS_GOAL_ID_INVALID");
        return await deps.operations.transactions.run<Result<AnalyticsGoalAggregateView, Rejection>>(async tx => {
          const root = await deps.repository.getGoal(query.goalId, deps.scope.portfolioId, tx);
          if (!root) return reject("not_found", "ANALYTICS_GOAL_NOT_FOUND");
          const versions = (await deps.repository.listVersions(query.goalId, deps.scope.portfolioId, tx)).map(asVersionView);
          const activationRecords = await deps.repository.listActivations(query.goalId, deps.scope.portfolioId, tx);
          const activationHistory = activationRecords.map(({ versionId, activatedAt }) => ({ versionId, activatedAt }));
          if (activationRecords.some((activation, index) => activation.activationSequence !== index + 1)) throw new Error("ANALYTICS_GOAL_ACTIVATION_ORDER_INVALID");
          if (!versions.length || versions[0]?.versionNumber !== 1 || versions.some((version, index) => version.versionNumber !== index + 1)) throw new Error("ANALYTICS_GOAL_HISTORY_INVALID");
          const view: AnalyticsGoalAggregateView = { goalId: root.goalId, aggregateVersion: root.aggregateVersion,
            activeVersionId: root.activeVersionId, versions, activationHistory };
          return { ok: true, value: view };
        });
      } catch { return unavailable(); }
    },
    async createOwnerAnalyticsGoalVersion(command: CreateOwnerAnalyticsGoalVersionApplicationCommand) {
      try {
        const access = await authorize(command);
        if (!access.ok) return access;
        if (Object.keys(command).some(key => !REQUEST_FIELDS.has(key)) || !parseStableId("AnalyticsGoal", command.goalId).ok ||
            !parseIdempotencyKey(command.idempotencyKey).ok || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1 ||
            typeof command.correlationId !== "string" || command.correlationId.length < 1 || command.correlationId.length > 200) {
          return reject("validation", "ANALYTICS_GOAL_COMMAND_INVALID");
        }
        const parsedDefinition = normalizeDefinition(command.definition);
        if (!parsedDefinition.ok) return parsedDefinition;
        const definition = parsedDefinition.value;
        return await deps.operations.transactions.run<Result<AnalyticsGoalVersionReceipt, Rejection>>(async tx => {
          await deps.repository.lockGoal(command.goalId, deps.scope.portfolioId, tx);
          const scopes = await validateScopes(definition, deps, tx);
          if (!scopes.ok) return requestTransactionRollback(scopes);
          const now = deps.clock.now();
          const versionId = parseStableId("AnalyticsGoalVersion", deps.ids.generate("AnalyticsGoalVersion"));
          const eventId = parseStableId("Event", deps.ids.generate("Event"));
          if (!versionId.ok || !eventId.ok || !Number.isFinite(Date.parse(now))) throw new Error("ANALYTICS_GOAL_ID_GENERATION_INVALID");
          const execution = await deps.operations.idempotency.execute({
            operationScope: `measurement.analytics-goal-version:${deps.scope.portfolioId}:${command.goalId}`,
            actorScope: await hashCanonicalRequest({ purpose: "owner_analytics_goal", ownerId: deps.scope.ownerId }),
            key: command.idempotencyKey,
            requestHash: await hashCanonicalRequest({ goalId: command.goalId, expectedVersion: command.expectedVersion, definition: definition as unknown as CanonicalValue }),
            expiresAt: new Date(Date.parse(now) + 90 * 86_400_000).toISOString(),
          }, async context => {
            let root: AnalyticsGoalRootRecord | null = await deps.repository.getGoal(command.goalId, deps.scope.portfolioId, context);
            if (!root) {
              if (command.expectedVersion !== 1) return { rejection: "GOAL_INITIAL_VERSION_REQUIRED" };
              await deps.repository.insertGoal(command.goalId, deps.scope.portfolioId, context);
              root = { goalId: command.goalId, aggregateVersion: 1, activeVersionId: null };
            } else if (command.expectedVersion !== root.aggregateVersion) {
              return { rejection: "ANALYTICS_GOAL_VERSION_STALE", currentVersion: root.aggregateVersion };
            }
            const priorVersions = await deps.repository.listVersions(command.goalId, deps.scope.portfolioId, context);
            const versionNumber = priorVersions.length + 1;
            if ((versionNumber === 1 && root.aggregateVersion !== 1) || root.aggregateVersion < versionNumber) throw new Error("ANALYTICS_GOAL_VERSION_SEQUENCE_INVALID");
            await deps.repository.appendVersion({ goalId: command.goalId, portfolioId: deps.scope.portfolioId, versionId: versionId.value,
              versionNumber, expectedAggregateVersion: root.aggregateVersion, definition, createdAt: now }, context);
            const aggregateVersion = root.aggregateVersion + 1;
            await deps.operations.outbox.append(context, { eventId: eventId.value, aggregateId: command.goalId, aggregateVersion,
              correlationId: command.correlationId, occurredAt: now, availableAt: now,
              payload: { type: "measurement.goal-version-created.v1", version: 1,
                value: { goalId: command.goalId, versionId: versionId.value, versionNumber } } });
            return { goalId: command.goalId, versionId: versionId.value, aggregateVersion, outcome: "analytics-goal-version-created" };
          }, tx);
          if (execution.kind === "conflict") return requestTransactionRollback(reject("conflict", "IDEMPOTENCY_PAYLOAD_CONFLICT"));
          if (execution.result["rejection"] === "GOAL_INITIAL_VERSION_REQUIRED") return requestTransactionRollback(reject("precondition_failed", "GOAL_INITIAL_VERSION_REQUIRED"));
          if (execution.result["rejection"] === "ANALYTICS_GOAL_VERSION_STALE") return requestTransactionRollback(reject("precondition_failed", "ANALYTICS_GOAL_VERSION_STALE", Number(execution.result["currentVersion"])));
          if (!isReceipt(execution.result, command.goalId)) throw new Error("ANALYTICS_GOAL_RECEIPT_INVALID");
          return { ok: true as const, value: { goalId: execution.result.goalId, versionId: execution.result.versionId,
            aggregateVersion: execution.result.aggregateVersion, outcome: execution.result.outcome } };
        });
      } catch { return unavailable(); }
    },
    async activateOwnerAnalyticsGoalVersion(command: ActivateOwnerAnalyticsGoalVersionApplicationCommand): Promise<Result<AnalyticsGoalActivationReceipt, Rejection>> {
      try {
        const access = await authorize(command);
        if (!access.ok) return access;
        if (Object.keys(command).some(key => !ACTIVATION_REQUEST_FIELDS.has(key)) ||
            !parseStableId("AnalyticsGoal", command.goalId).ok || !parseStableId("AnalyticsGoalVersion", command.versionId).ok ||
            !parseIdempotencyKey(command.idempotencyKey).ok || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1 ||
            typeof command.correlationId !== "string" || command.correlationId.length < 1 || command.correlationId.length > 200) {
          return reject("validation", "ANALYTICS_GOAL_COMMAND_INVALID");
        }
        return await deps.operations.transactions.run<Result<AnalyticsGoalActivationReceipt, Rejection>>(async tx => {
          await deps.repository.lockGoal(command.goalId, deps.scope.portfolioId, tx);
          const root = await deps.repository.getGoal(command.goalId, deps.scope.portfolioId, tx);
          if (!root) return requestTransactionRollback(reject("not_found", "ANALYTICS_GOAL_NOT_FOUND"));
          const executionTime = deps.clock.now();
          const activationId = parseStableId("Event", deps.ids.generate("Event"));
          const eventId = parseStableId("Event", deps.ids.generate("Event"));
          if (!activationId.ok || !eventId.ok || !Number.isFinite(Date.parse(executionTime))) throw new Error("ANALYTICS_GOAL_ID_GENERATION_INVALID");
          const execution = await deps.operations.idempotency.execute({
            operationScope: `measurement.analytics-goal-activation:${deps.scope.portfolioId}:${command.goalId}`,
            actorScope: await hashCanonicalRequest({ purpose: "owner_analytics_goal", ownerId: deps.scope.ownerId }),
            key: command.idempotencyKey,
            requestHash: await hashCanonicalRequest({ goalId: command.goalId, versionId: command.versionId, expectedVersion: command.expectedVersion }),
            expiresAt: new Date(Date.parse(executionTime) + 90 * 86_400_000).toISOString(),
          }, async context => {
            const current = await deps.repository.getGoal(command.goalId, deps.scope.portfolioId, context);
            if (!current) return { rejection: "ANALYTICS_GOAL_NOT_FOUND" };
            if (command.expectedVersion !== current.aggregateVersion) {
              return { rejection: "ANALYTICS_GOAL_VERSION_STALE", currentVersion: current.aggregateVersion };
            }
            const versions = await deps.repository.listVersions(command.goalId, deps.scope.portfolioId, context);
            if (!versions.some(version => version.versionId === command.versionId)) return { rejection: "ANALYTICS_GOAL_VERSION_UNAVAILABLE" };
            if (current.activeVersionId === command.versionId) {
              return { aggregateId: command.goalId, aggregateVersion: current.aggregateVersion, outcome: "analytics-goal-version-activated" };
            }
            const aggregateVersion = current.aggregateVersion + 1;
            await deps.repository.activateVersion({ goalId: command.goalId, portfolioId: deps.scope.portfolioId,
              versionId: command.versionId, activationId: activationId.value, expectedAggregateVersion: current.aggregateVersion,
              activatedAt: executionTime }, context);
            const version = versions.find(candidate => candidate.versionId === command.versionId);
            if (!version) throw new Error("ANALYTICS_GOAL_VERSION_DISAPPEARED");
            await deps.operations.outbox.append(context, { eventId: eventId.value, aggregateId: command.goalId, aggregateVersion,
              correlationId: command.correlationId, occurredAt: executionTime, availableAt: executionTime,
              payload: { type: "measurement.goal_version_activated.v1", version: 1,
                value: { goalId: command.goalId, versionId: command.versionId, versionNumber: version.versionNumber } } });
            return { aggregateId: command.goalId, aggregateVersion, outcome: "analytics-goal-version-activated" };
          }, tx);
          if (execution.kind === "conflict") return requestTransactionRollback(reject("conflict", "IDEMPOTENCY_PAYLOAD_CONFLICT"));
          if (execution.result["rejection"] === "ANALYTICS_GOAL_NOT_FOUND") return requestTransactionRollback(reject("not_found", "ANALYTICS_GOAL_NOT_FOUND"));
          if (execution.result["rejection"] === "ANALYTICS_GOAL_VERSION_UNAVAILABLE") return requestTransactionRollback(reject("validation", "ANALYTICS_GOAL_VERSION_UNAVAILABLE"));
          if (execution.result["rejection"] === "ANALYTICS_GOAL_VERSION_STALE") return requestTransactionRollback(reject("precondition_failed", "ANALYTICS_GOAL_VERSION_STALE", Number(execution.result["currentVersion"])));
          if (!isActivationReceipt(execution.result, command.goalId)) throw new Error("ANALYTICS_GOAL_ACTIVATION_RECEIPT_INVALID");
          return { ok: true as const, value: { aggregateId: execution.result.aggregateId,
            aggregateVersion: execution.result.aggregateVersion, outcome: execution.result.outcome } };
        });
      } catch { return unavailable(); }
    },
  };
}
