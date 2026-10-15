import { describe, expect, it } from "vitest";
import { createStableId, parseIdempotencyKey, type StableId } from "../../src/shared/domain/index.js";
import { isTransactionRollback } from "../../src/runtime/ports.js";
import { createOwnerAnalyticsGoalService } from "../../src/modules/measurement/application/goal-versions.js";
import type { AnalyticsGoalDefinition } from "../../src/modules/measurement/index.js";

const portfolioId = createStableId("Portfolio");
const ownerId = createStableId("Owner");
const goalId = createStableId("AnalyticsGoal");
const versionId = createStableId("AnalyticsGoalVersion");
const projectId = createStableId("Project");
const routeId = createStableId("PublicRoute");
const now = "2026-10-15T12:00:00.000Z";
const tx = { kind: "transaction" as const };
const definition: AnalyticsGoalDefinition = {
  name: "  Contact path  ",
  steps: [{ action: "contact-channel-opened", projectIds: [projectId], publicRouteIds: [routeId] }],
};

function setup(options: { readonly retainedIds?: readonly string[] } = {}) {
  const retainedIds = new Set(options.retainedIds ?? [projectId, routeId]);
  const roots = new Map<string, { aggregateVersion: number; activeVersionId: StableId<"AnalyticsGoalVersion"> | null }>();
  const versions = new Map<string, Array<{ versionId: StableId<"AnalyticsGoalVersion">; versionNumber: number; definition: AnalyticsGoalDefinition; createdAt: string }>>();
  const activations = new Map<string, Array<{ versionId: StableId<"AnalyticsGoalVersion">; activatedAt: string }>>();
  const ledger = new Map<string, { hash: string; result: Record<string, unknown> }>();
  const writes: unknown[] = [];
  let ids = 0;
  let versionIds = 0;
  const repository = {
    async lockGoal() {},
    async getGoal(id: string) {
      const root = roots.get(id);
      return root ? { goalId: id as StableId<"AnalyticsGoal">, ...root } : null;
    },
    async insertGoal(id: StableId<"AnalyticsGoal">) { roots.set(id, { aggregateVersion: 1, activeVersionId: null }); },
    async appendVersion(input: { goalId: StableId<"AnalyticsGoal">; versionId: StableId<"AnalyticsGoalVersion">; versionNumber: number; definition: AnalyticsGoalDefinition; createdAt: string }) {
      const rows = versions.get(input.goalId) ?? [];
      rows.push({ versionId: input.versionId, versionNumber: input.versionNumber, definition: input.definition, createdAt: input.createdAt });
      versions.set(input.goalId, rows);
      roots.set(input.goalId, { ...roots.get(input.goalId)!, aggregateVersion: roots.get(input.goalId)!.aggregateVersion + 1 });
    },
    async listVersions(id: string) { return versions.get(id) ?? []; },
    async listActivations(id: string) { return activations.get(id) ?? []; },
  };
  const operations = {
    transactions: { async run<T>(work: (context: typeof tx) => Promise<T> | T) { const result = await work(tx); return isTransactionRollback(result) ? result.value : result; } },
    idempotency: {
      async execute(input: { operationScope: string; actorScope: string; key: string; requestHash: string }, effect: (context: typeof tx) => Promise<Record<string, unknown>>) {
        const key = `${input.operationScope}:${input.actorScope}:${input.key}`;
        const prior = ledger.get(key);
        if (prior) return prior.hash === input.requestHash ? { kind: "replayed" as const, result: prior.result } : { kind: "conflict" as const };
        const result = await effect(tx);
        ledger.set(key, { hash: input.requestHash, result });
        return { kind: "executed" as const, result };
      },
    },
    outbox: { async append(_context: typeof tx, event: unknown) { writes.push(event); } },
  };
  const service = createOwnerAnalyticsGoalService({
    scope: { portfolioId, ownerId },
    authorize: async () => ({ ok: true as const, value: true }),
    operations: operations as never,
    repository: repository as never,
    scopeFacts: {
      async hasRetainedRoute(input: { routeId: string }) { return { ok: true as const, value: retainedIds.has(input.routeId) }; },
      async hasRetainedProject(input: { projectId: string }) { return { ok: true as const, value: retainedIds.has(input.projectId) }; },
    } as never,
    clock: { now: () => now },
    ids: { generate(kind: string) { return kind === "AnalyticsGoalVersion" && versionIds++ === 0 ? versionId : (ids++, createStableId(kind as "Event")); } },
  });
  const command = (override: Partial<{ expectedVersion: number; definition: AnalyticsGoalDefinition; idempotencyKey: string }> = {}) => {
    const key = parseIdempotencyKey(override.idempotencyKey ?? "goal-create-001");
    if (!key.ok) throw new Error("invalid test key");
    return {
      scope: { kind: "portfolio" as const, portfolioId }, correlationId: "goal-correlation",
      actor: { kind: "owner" as const, ownerId, sessionId: "verified-session" },
      idempotencyKey: key.value, expectedVersion: override.expectedVersion ?? 1, goalId, definition: override.definition ?? definition,
    };
  };
  const query = () => ({ scope: { kind: "portfolio" as const, portfolioId }, correlationId: "goal-query", actor: { kind: "owner" as const, ownerId, sessionId: "verified-session" }, goalId });
  return { service, roots, versions, writes, command, query };
}

describe("Owner Analytics goal version application seam", () => {
  it("bootstraps immutable version 1 atomically and inspects ordered history without activation", async () => {
    const { service, roots, versions, writes, command, query } = setup();
    const created = await service.createOwnerAnalyticsGoalVersion(command());
    expect(created).toEqual({ ok: true, value: { goalId, versionId, aggregateVersion: 2, outcome: "analytics-goal-version-created" } });
    expect(roots.get(goalId)).toEqual({ aggregateVersion: 2, activeVersionId: null });
    expect(versions.get(goalId)).toEqual([{ versionId, versionNumber: 1, definition: { name: "Contact path", steps: [{ action: "contact-channel-opened", projectIds: [projectId], publicRouteIds: [routeId] }] }, createdAt: now }]);
    expect(writes).toHaveLength(1);
    expect(await service.getOwnerAnalyticsGoal(query())).toEqual({ ok: true, value: {
      goalId, aggregateVersion: 2, activeVersionId: null,
      versions: [{ versionId, versionNumber: 1, definition: { name: "Contact path", steps: [{ action: "contact-channel-opened", projectIds: [projectId], publicRouteIds: [routeId] }] }, createdAt: now }],
      activationHistory: [],
    } });
  });

  it("replays the original safe receipt and conflicts when the same key carries a changed definition", async () => {
    const { service, command, writes } = setup();
    const first = await service.createOwnerAnalyticsGoalVersion(command());
    expect(await service.createOwnerAnalyticsGoalVersion(command())).toEqual(first);
    expect(writes).toHaveLength(1);
    const changed = await service.createOwnerAnalyticsGoalVersion(command({ definition: { name: "Different", steps: definition.steps } }));
    expect(changed).toMatchObject({ ok: false, error: { kind: "conflict", code: "IDEMPOTENCY_PAYLOAD_CONFLICT" } });
    expect(writes).toHaveLength(1);
  });

  it("appends ordered snapshots while keeping the active pointer and activation history unchanged", async () => {
    const { service, roots, versions, writes, command, query } = setup();
    await service.createOwnerAnalyticsGoalVersion(command());
    const second = await service.createOwnerAnalyticsGoalVersion(command({ expectedVersion: 2, idempotencyKey: "goal-create-002", definition: { name: "Updated", steps: definition.steps } }));
    expect(second).toMatchObject({ ok: true, value: { aggregateVersion: 3, outcome: "analytics-goal-version-created" } });
    expect(roots.get(goalId)).toEqual({ aggregateVersion: 3, activeVersionId: null });
    expect(versions.get(goalId)?.map(version => version.versionNumber)).toEqual([1, 2]);
    const inspected = await service.getOwnerAnalyticsGoal(query());
    expect(inspected.ok && inspected.value.activationHistory).toEqual([]);
    expect(writes).toHaveLength(2);
  });

  it("rejects malformed definitions and unavailable or cross-Portfolio scopes without writes", async () => {
    const { service, writes, command } = setup();
    const invalid: AnalyticsGoalDefinition[] = [
      { name: " ", steps: definition.steps }, { name: "x".repeat(121), steps: definition.steps },
      { name: "Empty", steps: [] }, { name: "Too many", steps: Array.from({ length: 11 }, () => ({ action: "page-viewed" as const })) },
      { name: "Duplicate scope", steps: [{ action: "project-viewed", projectIds: [projectId, projectId] }] },
      { name: "Invented action", steps: [{ action: "reaction-submitted" as never }] },
      { name: "Wrong scope collection type", steps: [{ action: "project-viewed", projectIds: "not-an-array" as never }] },
      { name: "Foreign project", steps: [{ action: "project-viewed", projectIds: [createStableId("Project")] }] },
      { name: "Unknown definition property", steps: definition.steps, extra: "closed-shape" } as never,
    ];
    for (const value of invalid) expect((await service.createOwnerAnalyticsGoalVersion(command({ definition: value, idempotencyKey: `invalid-${invalid.indexOf(value)}` }))).ok).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it("accepts the inclusive ten-step and one-hundred-scope limits and rejects a 101st scope", async () => {
    const projects = Array.from({ length: 100 }, () => createStableId("Project"));
    const routes = Array.from({ length: 100 }, () => createStableId("PublicRoute"));
    const { service, command } = setup({ retainedIds: [...projects, ...routes] });
    const accepted = await service.createOwnerAnalyticsGoalVersion(command({ definition: {
      name: "Maximum valid definition", steps: Array.from({ length: 10 }, () => ({ action: "project-viewed" as const, projectIds: projects, publicRouteIds: routes })),
    } }));
    expect(accepted.ok).toBe(true);
    const tooMany = await service.createOwnerAnalyticsGoalVersion(command({ idempotencyKey: "too-many-scopes", definition: {
      name: "Too many", steps: [{ action: "project-viewed", projectIds: [...projects, createStableId("Project")] }],
    } }));
    expect(tooMany).toMatchObject({ ok: false, error: { kind: "validation", code: "ANALYTICS_GOAL_SCOPE_INVALID" } });
  });

  it("requires a verified scoped Owner and rejects reads of absent roots", async () => {
    const { service, command, query } = setup();
    expect(await service.getOwnerAnalyticsGoal(query())).toMatchObject({ ok: false, error: { kind: "not_found", code: "ANALYTICS_GOAL_NOT_FOUND" } });
    expect(await service.createOwnerAnalyticsGoalVersion({ ...command(), actor: { kind: "visitor", consent: "unknown" } as never }))
      .toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(await service.createOwnerAnalyticsGoalVersion({ ...command(), scope: { kind: "portfolio", portfolioId: createStableId("Portfolio") } }))
      .toMatchObject({ ok: false, error: { kind: "forbidden" } });
  });

  it("requires expected version 1 to bootstrap a missing root", async () => {
    const { service, roots, command, writes } = setup();
    expect(await service.createOwnerAnalyticsGoalVersion(command({ expectedVersion: 2 })))
      .toMatchObject({ ok: false, error: { kind: "precondition_failed", code: "GOAL_INITIAL_VERSION_REQUIRED" } });
    expect(roots.size).toBe(0);
    expect(writes).toHaveLength(0);
  });
});
