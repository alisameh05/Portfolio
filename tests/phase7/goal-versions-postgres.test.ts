import { isolatedIdentityReadiness, isolatedOwnerAuthEnvironment } from "../fixtures/identity-readiness.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { parseIdempotencyKey, parseStableId, type StableId } from "../../src/shared/domain/index.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPostgresOwnerAnalyticsGoalRepository } from "../../src/modules/measurement/adapters/postgres-goals.js";
import { createPostgresAnalyticsGoalScopeFacts } from "../../src/modules/measurement/adapters/postgres-goal-scope-facts.js";
import { createOwnerAnalyticsGoalService } from "../../src/modules/measurement/application/goal-versions.js";
import type { AnalyticsGoalDefinition } from "../../src/modules/measurement/index.js";
import { decideAuthorization } from "../../src/modules/identity-access/index.js";
import { getLifecycleCoordinator } from "../../src/runtime/lifecycle.js";
import { getOwnerAnalyticsRuntimeServices, resetRuntimeForTests, initializeDatabaseRuntime } from "../../src/bootstrap/composition-root.js";
import { handleActivateOwnerAnalyticsGoalVersion, handleCreateOwnerAnalyticsGoalVersion, handleGetOwnerAnalyticsGoal } from "../../src/runtime/http/owner-analytics.js";
import { ownerTestSecurity, withOwnerTestAuth } from "../runtime/owner-test-auth.js";

const DATABASE_URL = process.env["PHASE7_GOAL_DATABASE_URL"];
const ADMIN_URL = process.env["PHASE7_GOAL_ADMIN_URL"];
function seededId<T extends string>(kind: T, value: number): StableId<T> {
  const parsed = parseStableId(kind, `0196a1b2-7c3d-7e11-9f22-${value.toString(16).padStart(12, "0")}`);
  if (!parsed.ok) throw new Error("INVALID_SEEDED_TEST_ID");
  return parsed.value;
}

const portfolioId = seededId("Portfolio", 1);
const ownerId = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0" as StableId<"Owner">;
const projectId = seededId("Project", 2);
const routeId = seededId("PublicRoute", 3);
const runtime = DATABASE_URL ? createPostgresRuntimeDatabase(DATABASE_URL) : undefined;
let admin: Client | undefined;
let service: Awaited<ReturnType<typeof getOwnerAnalyticsRuntimeServices>>["service"] | undefined;
let assembledService: Awaited<ReturnType<typeof getOwnerAnalyticsRuntimeServices>>["service"] | undefined;
let nextGoalId = 10;
let nextGeneratedId = 100;
const now = "2026-10-15T12:00:00.000Z";
const definition: AnalyticsGoalDefinition = { name: "  Historical project journey  ", steps: [{ action: "project-viewed", projectIds: [projectId], publicRouteIds: [routeId] }] };

function makeGoalId(): StableId<"AnalyticsGoal"> { return seededId("AnalyticsGoal", nextGoalId++); }

function seededIds() {
  return { generate(kind: string) { return seededId(kind, nextGeneratedId++); } };
}

function makeService(repository = createPostgresOwnerAnalyticsGoalRepository(), operations = createPostgresOperationsPersistence(runtime!.database)) {
  const scope = { portfolioId, ownerId };
  return createOwnerAnalyticsGoalService({ scope, authorize: async query => decideAuthorization(query),
    operations, repository,
    scopeFacts: createPostgresAnalyticsGoalScopeFacts(scope), clock: { now: () => now }, ids: seededIds() });
}

function rendezvous(parties: number) {
  let arrivals = 0;
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  return async () => { arrivals += 1; if (arrivals === parties) release(); await released; };
}

function command(goalId: StableId<"AnalyticsGoal">, key: string, expectedVersion = 1, inputDefinition = definition) {
  const parsed = parseIdempotencyKey(key);
  if (!parsed.ok) throw new Error("INVALID_TEST_KEY");
  return { scope: { kind: "portfolio" as const, portfolioId }, correlationId: "goal-postgres-test", actor: { kind: "owner" as const, ownerId, sessionId: "verified-owner-session" },
    idempotencyKey: parsed.value, expectedVersion, goalId, definition: inputDefinition };
}

function activationCommand(goalId: StableId<"AnalyticsGoal">, versionId: StableId<"AnalyticsGoalVersion">, key: string, expectedVersion: number) {
  const parsed = parseIdempotencyKey(key);
  if (!parsed.ok) throw new Error("INVALID_TEST_KEY");
  return { scope: { kind: "portfolio" as const, portfolioId }, correlationId: "goal-activation-test",
    actor: { kind: "owner" as const, ownerId, sessionId: "verified-owner-session" }, idempotencyKey: parsed.value,
    expectedVersion, goalId, versionId };
}

function rows<T extends { rows: Array<{ count: number }> }>(result: T): number { return Number(result.rows[0]?.count ?? 0); }

async function counts(goalId: string) {
  const roots = rows(await admin!.query("select count(*)::int as count from measurement.analytics_goals where portfolio_id=$1 and goal_id=$2", [portfolioId, goalId]));
  const versions = rows(await admin!.query("select count(*)::int as count from measurement.analytics_goal_versions where portfolio_id=$1 and goal_id=$2", [portfolioId, goalId]));
  const outbox = rows(await admin!.query("select count(*)::int as count from operations.outbox_events where aggregate_id=$1", [goalId]));
  const ledger = rows(await admin!.query("select count(*)::int as count from operations.idempotency_records where operation_scope=$1", [`measurement.analytics-goal-version:${portfolioId}:${goalId}`]));
  return { roots, versions, outbox, ledger };
}

async function activationState(goalId: string) {
  const root = (await admin!.query("select aggregate_version, active_version_id from measurement.analytics_goals where portfolio_id=$1 and goal_id=$2", [portfolioId, goalId])).rows[0];
  const histories = rows(await admin!.query("select count(*)::int as count from measurement.analytics_goal_activation_history where portfolio_id=$1 and goal_id=$2", [portfolioId, goalId]));
  const events = rows(await admin!.query("select count(*)::int as count from operations.outbox_events where aggregate_id=$1 and event_type='measurement.goal_version_activated.v1'", [goalId]));
  const ledger = rows(await admin!.query("select count(*)::int as count from operations.idempotency_records where operation_scope=$1", [`measurement.analytics-goal-activation:${portfolioId}:${goalId}`]));
  return { aggregateVersion: Number(root?.aggregate_version ?? 0), activeVersionId: root?.active_version_id ?? null, histories, events, ledger };
}

describe.runIf(Boolean(DATABASE_URL && ADMIN_URL))("Owner Analytics goal versions PostgreSQL acceptance", () => {
beforeAll(async () => {
  if (!DATABASE_URL || !ADMIN_URL || !runtime) throw new Error("PHASE7_GOAL_DATABASE_REQUIRED");
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`insert into portfolio_config.settings
    (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback)
    values ($1,$2,'Owner','Portfolio owner','Owner profile','Contact','https://example.com/contact','Contact the owner')
    on conflict (portfolio_id) do nothing`, [portfolioId, ownerId]);
  await admin.query("insert into content.items (content_id,portfolio_id,content_type,lifecycle,candidate_slug) values ($1,$2,'project','hidden',null)", [projectId, portfolioId]);
  await admin.query("insert into content.public_routes (route_identity,content_id,portfolio_id,content_type,current_slug,first_published_at) values ($1,$2,$3,'project','retained-goal-project',$4)", [routeId, projectId, portfolioId, now]);
  await initializeDatabaseRuntime({ ...isolatedOwnerAuthEnvironment, NODE_ENV: "test", APP_BASE_URL: "https://example.com", DATABASE_URL, PORTFOLIO_ID: portfolioId, OWNER_ID: ownerId }, "application", undefined, { identityReadiness: isolatedIdentityReadiness });
  assembledService = (await getOwnerAnalyticsRuntimeServices()).service;
  service = makeService();
}, 30_000);

afterAll(async () => {
  await getLifecycleCoordinator().shutdown();
  resetRuntimeForTests();
  await admin?.end();
  await runtime?.resource.close();
});

describe("Owner Analytics goal versions through PostgreSQL and existing Owner operations", () => {
  it("T12-01 returns the contracted 201 receipt and inspects ordered immutable history for a scoped Owner", async () => {
    const goalId = makeGoalId();
    const headers = withOwnerTestAuth({ "content-type": "application/json", "Idempotency-Key": "http-goal-create-001", "If-Match": '"1"' });
    const response = await handleCreateOwnerAnalyticsGoalVersion(new Request(`https://example.com/api/owner/v1/analytics-goals/${goalId}/versions`, {
      method: "POST", headers, body: JSON.stringify({ definition }),
    }), { goalId }, { scope: { kind: "portfolio", portfolioId }, service: service!, security: ownerTestSecurity() });
    expect(response.status).toBe(201);
    const receipt = await response.json() as Record<string, unknown>;
    expect(receipt).toMatchObject({ goalId, aggregateVersion: 2, outcome: "analytics-goal-version-created" });
    const get = await handleGetOwnerAnalyticsGoal(new Request(`https://example.com/api/owner/v1/analytics-goals/${goalId}`, { headers: withOwnerTestAuth({}) }),
      { goalId }, { scope: { kind: "portfolio", portfolioId }, service: service!, security: ownerTestSecurity() });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ goalId, aggregateVersion: 2, activeVersionId: null,
      versions: [{ versionId: receipt["versionId"], versionNumber: 1,
        definition: { name: "Historical project journey", steps: [{ action: "project-viewed", projectIds: [projectId], publicRouteIds: [routeId] }] }, createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) },
      ], activationHistory: [] });
    const outbox = await admin!.query("select payload from operations.outbox_events where aggregate_id=$1", [goalId]);
    expect(JSON.stringify(outbox.rows)).not.toContain("Historical project journey");
    expect(await assembledService!.getOwnerAnalyticsGoal({ scope: { kind: "portfolio", portfolioId },
      correlationId: "runtime-composition", actor: command(goalId, "runtime-composition").actor, goalId })).toEqual(await service!.getOwnerAnalyticsGoal({
      scope: { kind: "portfolio", portfolioId }, correlationId: "runtime-composition", actor: command(goalId, "runtime-composition").actor, goalId }));
  });

  it("T12-02 rejects non-one bootstrap preconditions and reports absent-root reads", async () => {
    const goalId = makeGoalId();
    expect(await service!.createOwnerAnalyticsGoalVersion(command(goalId, "invalid-bootstrap-001", 2)))
      .toMatchObject({ ok: false, error: { kind: "precondition_failed", code: "GOAL_INITIAL_VERSION_REQUIRED" } });
    expect(await service!.getOwnerAnalyticsGoal({ scope: { kind: "portfolio", portfolioId }, correlationId: "absent", actor: command(goalId, "unused").actor, goalId }))
      .toMatchObject({ ok: false, error: { kind: "not_found", code: "ANALYTICS_GOAL_NOT_FOUND" } });
    expect(await counts(goalId)).toEqual({ roots: 0, versions: 0, outbox: 0, ledger: 0 });
  });

  it("T12-03 serializes concurrent initializers, allows one immutable version one, and keeps exact retry idempotent", async () => {
    const id = makeGoalId();
    const meet = rendezvous(2);
    const repository = createPostgresOwnerAnalyticsGoalRepository();
    const raceService = makeService({ ...repository, async lockGoal(...args: Parameters<typeof repository.lockGoal>) {
      await meet();
      await repository.lockGoal(...args);
    } });
    const [left, right] = await Promise.all([
      raceService.createOwnerAnalyticsGoalVersion(command(id, "race-goal-left-001")),
      raceService.createOwnerAnalyticsGoalVersion(command(id, "race-goal-right-001")),
    ]);
    expect([left, right].filter(result => result.ok), JSON.stringify([left, right])).toHaveLength(1);
    expect([left, right].filter(result => !result.ok)).toHaveLength(1);
    expect([left, right].find(result => !result.ok)).toMatchObject({ ok: false, error: { kind: "precondition_failed", code: "ANALYTICS_GOAL_VERSION_STALE", currentVersion: 2 } });
    expect(await counts(id)).toEqual({ roots: 1, versions: 1, outbox: 1, ledger: 1 });
    const winningKey = left.ok ? "race-goal-left-001" : "race-goal-right-001";
    const replay = await raceService.createOwnerAnalyticsGoalVersion(command(id, winningKey));
    expect(replay).toEqual(left.ok ? left : right);
    expect(await counts(id)).toEqual({ roots: 1, versions: 1, outbox: 1, ledger: 1 });
    expect(await raceService.createOwnerAnalyticsGoalVersion(command(id, winningKey, 1, { name: "Changed", steps: definition.steps })))
      .toMatchObject({ ok: false, error: { kind: "conflict", code: "IDEMPOTENCY_PAYLOAD_CONFLICT" } });
    expect(await counts(id)).toEqual({ roots: 1, versions: 1, outbox: 1, ledger: 1 });
  });

  it("T12-04/05 rejects invalid and foreign scopes but accepts retained Hidden Project identity without public exposure", async () => {
    const foreignPortfolioId = seededId("Portfolio", 98);
    const foreignProject = seededId("Project", 4);
    const foreignRoute = seededId("PublicRoute", 5);
    await admin!.query(`insert into portfolio_config.settings
      (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback)
      values ($1,$2,'Foreign','Portfolio owner','Owner profile','Contact','https://example.com/contact','Contact the owner')`,
    [foreignPortfolioId, seededId("Owner", 6)]);
    await admin!.query("insert into content.items (content_id,portfolio_id,content_type,lifecycle,candidate_slug) values ($1,$2,'project','hidden',null)",
      [foreignProject, foreignPortfolioId]);
    await admin!.query("insert into content.public_routes (route_identity,content_id,portfolio_id,content_type,current_slug,first_published_at) values ($1,$2,$3,'project','foreign-goal-project',$4)",
      [foreignRoute, foreignProject, foreignPortfolioId, now]);
    for (const [key, scope] of [["foreign-goal-project-001", { projectIds: [foreignProject] }],
      ["foreign-goal-route-001", { publicRouteIds: [foreignRoute] }]] as const) {
      const id = makeGoalId();
      const invalid = await service!.createOwnerAnalyticsGoalVersion(command(id, key, 1,
        { name: "Foreign", steps: [{ action: "project-viewed", ...scope }] }));
      expect(invalid).toMatchObject({ ok: false, error: { kind: "validation", code: "ANALYTICS_GOAL_SCOPE_UNAVAILABLE" } });
      expect(await counts(id)).toEqual({ roots: 0, versions: 0, outbox: 0, ledger: 0 });
    }
    const id = makeGoalId();
    const accepted = await service!.createOwnerAnalyticsGoalVersion(command(id, "retained-goal-scope-001"));
    expect(accepted.ok).toBe(true);
    const stored = await admin!.query("select lifecycle, content_type from content.items where portfolio_id=$1 and content_id=$2", [portfolioId, projectId]);
    expect(stored.rows).toEqual([{ lifecycle: "hidden", content_type: "project" }]);
    const views = await service!.getOwnerAnalyticsGoal({ scope: { kind: "portfolio", portfolioId }, correlationId: "retained-view", actor: command(id, "unused").actor, goalId: id });
    expect(JSON.stringify(views)).not.toContain("Owner");
  });

  it("T12-06 appends later versions in order and leaves activation pointer and facts unchanged", async () => {
    const id = makeGoalId();
    await service!.createOwnerAnalyticsGoalVersion(command(id, "version-one-001"));
    expect(await service!.createOwnerAnalyticsGoalVersion(command(id, "version-two-001", 2, { name: "Updated goal", steps: definition.steps })))
      .toMatchObject({ ok: true, value: { aggregateVersion: 3, outcome: "analytics-goal-version-created" } });
    const view = await service!.getOwnerAnalyticsGoal({ scope: { kind: "portfolio", portfolioId }, correlationId: "ordered-history", actor: command(id, "unused").actor, goalId: id });
    expect(view).toMatchObject({ ok: true, value: { aggregateVersion: 3, activeVersionId: null, versions: [
      { versionNumber: 1, definition: { name: "Historical project journey" }, createdAt: now }, { versionNumber: 2, definition: { name: "Updated goal" }, createdAt: now },
    ], activationHistory: [] } });
  });

  it("T12-07 rejects stale versions and non-Owner access", async () => {
    const id = makeGoalId();
    await service!.createOwnerAnalyticsGoalVersion(command(id, "owner-safety-version-001"));
    expect(await service!.createOwnerAnalyticsGoalVersion(command(id, "owner-safety-stale-001")))
      .toMatchObject({ ok: false, error: { kind: "precondition_failed", code: "ANALYTICS_GOAL_VERSION_STALE" } });
    expect(await service!.createOwnerAnalyticsGoalVersion({ ...command(makeGoalId(), "not-owner-001"), actor: { kind: "visitor", consent: "unknown" } }))
      .toMatchObject({ ok: false, error: { kind: "forbidden" } });
  });

  it("T12-08 rolls back injected root/version/outbox/ledger failures and prevents snapshot mutation", async () => {
    const ops = createPostgresOperationsPersistence(runtime!.database);
    const scope = { portfolioId, ownerId };
    const baseRepository = createPostgresOwnerAnalyticsGoalRepository();
    const facts = createPostgresAnalyticsGoalScopeFacts(scope);
    const failureService = (repository = baseRepository, fail: "outbox" | "ledger" | undefined = undefined) => createOwnerAnalyticsGoalService({
      scope, authorize: async query => decideAuthorization(query),
      operations: fail === undefined ? ops : {
        ...ops,
        ...(fail === "outbox" ? { outbox: { ...ops.outbox, async append() { throw new Error("INJECTED_OUTBOX_FAILURE"); } } } : {}),
        ...(fail === "ledger" ? { idempotency: { ...ops.idempotency, async execute(input: never, effect: never, tx: never) {
          await ops.idempotency.execute(input as never, effect as never, tx as never); throw new Error("INJECTED_LEDGER_FAILURE");
        } } } : {}),
      },
      repository, scopeFacts: facts, clock: { now: () => now }, ids: seededIds(),
    });
    for (const failure of ["root", "version", "outbox", "ledger"] as const) {
      const goalId = makeGoalId();
      const repository = failure === "root" ? { ...baseRepository, async insertGoal(...args: Parameters<typeof baseRepository.insertGoal>) { await baseRepository.insertGoal(...args); throw new Error("INJECTED_ROOT_FAILURE"); } }
        : failure === "version" ? { ...baseRepository, async appendVersion(...args: Parameters<typeof baseRepository.appendVersion>) { await baseRepository.appendVersion(...args); throw new Error("INJECTED_VERSION_FAILURE"); } }
          : baseRepository;
      const result = await failureService(repository, failure === "root" || failure === "version" ? undefined : failure).createOwnerAnalyticsGoalVersion(command(goalId, `failure-${failure}-001`));
      expect(result).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable", code: "ANALYTICS_GOAL_UNAVAILABLE" } });
      expect(await counts(goalId)).toEqual({ roots: 0, versions: 0, outbox: 0, ledger: 0 });
    }
    for (const failure of ["version", "outbox", "ledger"] as const) {
      const goalId = makeGoalId();
      await service!.createOwnerAnalyticsGoalVersion(command(goalId, `append-baseline-${failure}-001`));
      const prior = await counts(goalId);
      const repository = failure === "version" ? { ...baseRepository, async appendVersion(...args: Parameters<typeof baseRepository.appendVersion>) { await baseRepository.appendVersion(...args); throw new Error("INJECTED_APPEND_FAILURE"); } }
        : baseRepository;
      const result = await failureService(repository, failure === "version" ? undefined : failure).createOwnerAnalyticsGoalVersion(command(goalId, `append-failure-${failure}-001`, 2,
        { name: "Appended version", steps: definition.steps }));
      expect(result).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable", code: "ANALYTICS_GOAL_UNAVAILABLE" } });
      expect(await counts(goalId)).toEqual(prior);
    }
    const goalId = makeGoalId();
    await service!.createOwnerAnalyticsGoalVersion(command(goalId, "immutable-snapshot-001"));
    const client = new Client({ connectionString: DATABASE_URL! });
    await client.connect();
    let error: { code?: string } | undefined;
    try {
      await client.query("update measurement.analytics_goal_versions set definition='{}'::jsonb where portfolio_id=$1 and goal_id=$2", [portfolioId, goalId]);
    } catch (caught) { error = caught as { code?: string }; }
    finally { await client.end(); }
    expect(error?.code).toBe("42501");
    const deleteClient = new Client({ connectionString: DATABASE_URL! });
    await deleteClient.connect();
    let deleteError: { code?: string } | undefined;
    try {
      await deleteClient.query("delete from measurement.analytics_goal_versions where portfolio_id=$1 and goal_id=$2", [portfolioId, goalId]);
    } catch (caught) { deleteError = caught as { code?: string }; }
    finally { await deleteClient.end(); }
    expect(deleteError?.code).toBe("42501");
    const rlsClient = new Client({ connectionString: DATABASE_URL! });
    await rlsClient.connect();
    await rlsClient.query("begin");
    try {
      await rlsClient.query("select set_config('shipwithali.portfolio_id',$1,true)", [seededId("Portfolio", 99)]);
      const hidden = await rlsClient.query("select 1 from measurement.analytics_goals where goal_id=$1", [goalId]);
      expect(hidden.rowCount).toBe(0);
      await rlsClient.query("rollback");
    } finally { await rlsClient.end(); }
    const version = await admin!.query("select definition from measurement.analytics_goal_versions where portfolio_id=$1 and goal_id=$2", [portfolioId, goalId]);
    expect(version.rows[0]?.definition).toEqual({ name: "Historical project journey", steps: [{ action: "project-viewed", projectIds: [projectId], publicRouteIds: [routeId] }] });
  });

  it("T13-01/02 activates through the existing Owner HTTP operation and preserves immutable snapshots", async () => {
    const goalId = makeGoalId();
    const created = await service!.createOwnerAnalyticsGoalVersion(command(goalId, "activation-http-create-001"));
    if (!created.ok) throw new Error("GOAL_VERSION_SETUP_FAILED");
    expect(await activationState(goalId)).toMatchObject({ aggregateVersion: 2, activeVersionId: null, histories: 0 });
    const before = await admin!.query("select version_id, version_number, definition::text, created_at from measurement.analytics_goal_versions where portfolio_id=$1 and goal_id=$2", [portfolioId, goalId]);
    const headers = withOwnerTestAuth({ "content-type": "application/json", "Idempotency-Key": "activation-http-001", "If-Match": '"2"' });
    const response = await handleActivateOwnerAnalyticsGoalVersion(new Request(`https://example.com/api/owner/v1/analytics-goals/${goalId}/commands/activate-version`, {
      method: "POST", headers, body: JSON.stringify({ versionId: created.value.versionId }),
    }), { goalId }, { scope: { kind: "portfolio", portfolioId }, service: service!, security: ownerTestSecurity() });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ aggregateId: goalId, aggregateVersion: 3, outcome: "analytics-goal-version-activated" });
    const viewResponse = await handleGetOwnerAnalyticsGoal(new Request(`https://example.com/api/owner/v1/analytics-goals/${goalId}`, { headers: withOwnerTestAuth({}) }),
      { goalId }, { scope: { kind: "portfolio", portfolioId }, service: service!, security: ownerTestSecurity() });
    expect(viewResponse.status).toBe(200);
    expect(await viewResponse.json()).toMatchObject({ aggregateVersion: 3, activeVersionId: created.value.versionId,
      activationHistory: [{ versionId: created.value.versionId, activatedAt: now }] });
    expect((await admin!.query("select version_id, version_number, definition::text, created_at from measurement.analytics_goal_versions where portfolio_id=$1 and goal_id=$2", [portfolioId, goalId])).rows)
      .toEqual(before.rows);
    const activationEvent = await admin!.query("select payload from operations.outbox_events where aggregate_id=$1 and event_type='measurement.goal_version_activated.v1'", [goalId]);
    expect(activationEvent.rows).toEqual([{ payload: { goalId, version: 1 } }]);
    const second = await service!.createOwnerAnalyticsGoalVersion(command(goalId, "activation-http-create-002", 3, { name: "Later immutable version", steps: definition.steps }));
    expect(second).toMatchObject({ ok: true, value: { aggregateVersion: 4 } });
    expect(await activationState(goalId)).toMatchObject({ aggregateVersion: 4, activeVersionId: created.value.versionId, histories: 1, events: 1 });
  });

  it("T13-03 hides cross-goal and foreign-Portfolio versions and rejects a missing root", async () => {
    const goalId = makeGoalId();
    const missing = await service!.activateOwnerAnalyticsGoalVersion(activationCommand(goalId, seededId("AnalyticsGoalVersion", 901), "activation-missing-001", 2));
    expect(missing).toMatchObject({ ok: false, error: { kind: "not_found", code: "ANALYTICS_GOAL_NOT_FOUND" } });
    const ownVersion = await service!.createOwnerAnalyticsGoalVersion(command(goalId, "activation-scope-own-001"));
    const otherGoal = makeGoalId();
    const otherVersion = await service!.createOwnerAnalyticsGoalVersion(command(otherGoal, "activation-scope-other-001"));
    if (!ownVersion.ok || !otherVersion.ok) throw new Error("GOAL_VERSION_SETUP_FAILED");
    const foreignPortfolio = seededId("Portfolio", 98);
    const foreignGoal = seededId("AnalyticsGoal", 902);
    const foreignVersion = seededId("AnalyticsGoalVersion", 903);
    await admin!.query("insert into measurement.analytics_goals (portfolio_id,goal_id,aggregate_version) values ($1,$2,2)", [foreignPortfolio, foreignGoal]);
    await admin!.query("insert into measurement.analytics_goal_versions (portfolio_id,goal_id,version_id,version_number,definition,created_at) values ($1,$2,$3,1,$4::jsonb,$5)",
      [foreignPortfolio, foreignGoal, foreignVersion, JSON.stringify(definition), now]);
    const initial = await activationState(goalId);
    for (const [versionId, key] of [[otherVersion.value.versionId, "activation-cross-goal-001"], [foreignVersion, "activation-foreign-portfolio-001"]] as const) {
      expect(await service!.activateOwnerAnalyticsGoalVersion(activationCommand(goalId, versionId, key, 2)))
        .toMatchObject({ ok: false, error: { kind: "validation", code: "ANALYTICS_GOAL_VERSION_UNAVAILABLE" } });
      expect(await activationState(goalId)).toEqual(initial);
    }
    expect(JSON.stringify(await service!.getOwnerAnalyticsGoal({ scope: { kind: "portfolio", portfolioId }, correlationId: "activation-safe-view",
      actor: command(goalId, "unused-owner-key").actor, goalId }))).not.toContain("foreign");
  });

  it("T13-04/05 replays exact activation, makes same-current activation a no-op, and applies stale/conflict precedence", async () => {
    const goalId = makeGoalId();
    const created = await service!.createOwnerAnalyticsGoalVersion(command(goalId, "activation-replay-create-001"));
    if (!created.ok) throw new Error("GOAL_VERSION_SETUP_FAILED");
    const firstCommand = activationCommand(goalId, created.value.versionId, "activation-replay-001", 2);
    const first = await service!.activateOwnerAnalyticsGoalVersion(firstCommand);
    expect(await service!.activateOwnerAnalyticsGoalVersion(firstCommand)).toEqual(first);
    expect(await service!.activateOwnerAnalyticsGoalVersion(activationCommand(goalId, created.value.versionId, "activation-noop-001", 3))).toEqual(first);
    expect(await activationState(goalId)).toMatchObject({ aggregateVersion: 3, activeVersionId: created.value.versionId, histories: 1, events: 1, ledger: 2 });
    expect(await service!.activateOwnerAnalyticsGoalVersion(activationCommand(goalId, seededId("AnalyticsGoalVersion", 904), "activation-replay-001", 2)))
      .toMatchObject({ ok: false, error: { kind: "conflict", code: "IDEMPOTENCY_PAYLOAD_CONFLICT" } });
    const staleHeaders = withOwnerTestAuth({ "content-type": "application/json", "Idempotency-Key": "activation-stale-001", "If-Match": '"2"' });
    const stale = await handleActivateOwnerAnalyticsGoalVersion(new Request(`https://example.com/api/owner/v1/analytics-goals/${goalId}/commands/activate-version`, {
      method: "POST", headers: staleHeaders, body: JSON.stringify({ versionId: created.value.versionId }),
    }), { goalId }, { scope: { kind: "portfolio", portfolioId }, service: service!, security: ownerTestSecurity() });
    expect(stale.status).toBe(412);
    expect(await activationState(goalId)).toMatchObject({ aggregateVersion: 3, histories: 1, events: 1, ledger: 2 });
  });

  it("T13-06 serializes independent concurrent activations and rolls back pointer/history/outbox/receipt failures", async () => {
    const goalId = makeGoalId();
    const first = await service!.createOwnerAnalyticsGoalVersion(command(goalId, "activation-race-create-001"));
    if (!first.ok) throw new Error("GOAL_VERSION_SETUP_FAILED");
    const second = await service!.createOwnerAnalyticsGoalVersion(command(goalId, "activation-race-create-002", 2, { name: "Second rule", steps: definition.steps }));
    if (!second.ok) throw new Error("GOAL_VERSION_SETUP_FAILED");
    const meet = rendezvous(2);
    const repository = createPostgresOwnerAnalyticsGoalRepository();
    const raceService = makeService({ ...repository, async lockGoal(...args: Parameters<typeof repository.lockGoal>) { await meet(); await repository.lockGoal(...args); } });
    const [left, right] = await Promise.all([
      raceService.activateOwnerAnalyticsGoalVersion(activationCommand(goalId, first.value.versionId, "activation-race-left", 3)),
      raceService.activateOwnerAnalyticsGoalVersion(activationCommand(goalId, second.value.versionId, "activation-race-right", 3)),
    ]);
    expect([left, right].filter(result => result.ok), JSON.stringify([left, right])).toHaveLength(1);
    expect([left, right].find(result => !result.ok)).toMatchObject({ ok: false, error: { kind: "precondition_failed", code: "ANALYTICS_GOAL_VERSION_STALE", currentVersion: 4 } });
    expect(await activationState(goalId)).toMatchObject({ aggregateVersion: 4, histories: 1, events: 1, ledger: 1 });
    const baseRepository = createPostgresOwnerAnalyticsGoalRepository();
    const ops = createPostgresOperationsPersistence(runtime!.database);
    for (const failure of ["pointer-history", "outbox", "ledger"] as const) {
      const current = await service!.getOwnerAnalyticsGoal({ scope: { kind: "portfolio", portfolioId }, correlationId: "rollback-read",
        actor: command(goalId, "unused-rollback-key").actor, goalId });
      if (!current.ok) throw new Error("GOAL_VIEW_SETUP_FAILED");
      const target = current.value.activeVersionId === first.value.versionId ? second.value.versionId : first.value.versionId;
      const before = await activationState(goalId);
      const repositoryWithFailure = failure === "pointer-history" ? { ...baseRepository, async activateVersion(...args: Parameters<typeof baseRepository.activateVersion>) {
        await baseRepository.activateVersion(...args); throw new Error("INJECTED_ACTIVATION_WRITE_FAILURE");
      } } : baseRepository;
      const failureService = makeService(repositoryWithFailure, failure === "outbox" ? {
        ...ops, outbox: { ...ops.outbox, async append() { throw new Error("INJECTED_OUTBOX_FAILURE"); } },
      } : failure === "ledger" ? {
        ...ops, idempotency: { ...ops.idempotency, async execute(input: never, effect: never, tx: never) {
          await ops.idempotency.execute(input as never, effect as never, tx as never); throw new Error("INJECTED_LEDGER_FAILURE");
        } },
      } : ops);
      expect(await failureService.activateOwnerAnalyticsGoalVersion(activationCommand(goalId, target, `activation-failure-${failure}`, before.aggregateVersion)))
        .toMatchObject({ ok: false, error: { kind: "temporarily_unavailable", code: "ANALYTICS_GOAL_UNAVAILABLE" } });
      expect(await activationState(goalId)).toEqual(before);
    }
  });

  it("T13-07 preserves deterministic activation order when a fixed clock ties timestamps", async () => {
    const goalId = makeGoalId();
    const first = await service!.createOwnerAnalyticsGoalVersion(command(goalId, "activation-order-create-001"));
    if (!first.ok) throw new Error("GOAL_VERSION_SETUP_FAILED");
    await service!.activateOwnerAnalyticsGoalVersion(activationCommand(goalId, first.value.versionId, "activation-order-first", 2));
    const second = await service!.createOwnerAnalyticsGoalVersion(command(goalId, "activation-order-create-002", 3, { name: "Second ordered rule", steps: definition.steps }));
    if (!second.ok) throw new Error("GOAL_VERSION_SETUP_FAILED");
    await service!.activateOwnerAnalyticsGoalVersion(activationCommand(goalId, second.value.versionId, "activation-order-second", 4));
    const persisted = await admin!.query(`select version_id, to_char(activated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as activated_at,
      activation_sequence, aggregate_version from measurement.analytics_goal_activation_history where portfolio_id=$1 and goal_id=$2 order by activation_sequence`, [portfolioId, goalId]);
    expect(persisted.rows.map(row => Number(row.activation_sequence))).toEqual([1, 2]);
    expect(persisted.rows.map(row => row.activated_at)).toEqual([now, now]);
    const view = await service!.getOwnerAnalyticsGoal({ scope: { kind: "portfolio", portfolioId }, correlationId: "activation-order-view",
      actor: command(goalId, "unused-order-key").actor, goalId });
    expect(view.ok && view.value.activationHistory.map(item => item.versionId)).toEqual([first.value.versionId, second.value.versionId]);
  });

  it("T13-08 activates through standard production Owner composition", async () => {
    const goalId = makeGoalId();
    const created = await assembledService!.createOwnerAnalyticsGoalVersion(command(goalId, "activation-composition-create"));
    if (!created.ok) throw new Error("GOAL_VERSION_SETUP_FAILED");
    const activated = await assembledService!.activateOwnerAnalyticsGoalVersion(activationCommand(goalId, created.value.versionId, "activation-composition-activate", created.value.aggregateVersion));
    expect(activated).toMatchObject({ ok: true, value: { aggregateId: goalId, aggregateVersion: 3, outcome: "analytics-goal-version-activated" } });
  });
});
});
