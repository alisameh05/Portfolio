import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { parseStableId, type StableId } from "../../src/shared/domain/index.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPostgresGoalConversionRepository } from "../../src/modules/measurement/adapters/postgres-goal-conversions.js";
import { createGoalConversionWorkService } from "../../src/modules/measurement/application/process-goal-conversions.js";
import type { RecomputeGoalConversionsCommand } from "../../src/modules/measurement/application/process-goal-conversions.js";
import type { GoalConversionRepositoryPort } from "../../src/modules/measurement/ports/goal-conversions.js";

const DATABASE_URL = process.env["PHASE7_CONVERSION_DATABASE_URL"];
const ADMIN_URL = process.env["PHASE7_CONVERSION_ADMIN_URL"];
const portfolioId = "0196a1b2-7c3d-7e11-9f22-000000000001" as StableId<"Portfolio">;
const routeId = "0196a1b2-7c3d-7e11-9f22-000000000002" as StableId<"PublicRoute">;
const projectId = "0196a1b2-7c3d-7e11-9f22-000000000003" as StableId<"Project">;
let admin: Client | undefined;
let runtime: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
let service: ReturnType<typeof createGoalConversionWorkService> | undefined;
let serial = 100;

function id<T extends string>(kind: T): StableId<T> {
  const value = parseStableId(kind, `0196a1b2-7c3d-7e11-9f22-${(serial++).toString(16).padStart(12, "0")}`);
  if (!value.ok) throw new Error("INVALID_TEST_ID");
  return value.value;
}

function command(eventId: StableId<"PublicEvent">) {
  return { scope: { kind: "portfolio" as const, portfolioId }, correlationId: "goal-conversion-postgres-test",
    actor: { kind: "system" as const, jobId: id("Job"), purpose: "measurement.conversion" as const }, eventId, batchSize: 25 as const, now: "2026-10-15T12:00:00.000Z" };
}

async function addSubject(subject: StableId<"MeasurementVisitor">, state: "granted" | "denied" = "granted") {
  const consentId = id("Consent");
  await admin!.query(`insert into measurement.consents (portfolio_id,consent_id,subject,state,notice_version,revision,recorded_at,evidence_expires_at)
    values ($1,$2,$3,$4,'v1',1,'2026-10-15T10:00:00Z','2026-10-20T10:00:00Z')`, [portfolioId, consentId, subject, state]);
  await admin!.query(`insert into measurement.consent_history (portfolio_id,consent_id,revision,state,notice_version,recorded_at)
    values ($1,$2,1,$3,'v1','2026-10-15T10:00:00Z')`, [portfolioId, consentId, state]);
  return consentId;
}

async function addEvent(input: { subject: StableId<"MeasurementVisitor">; action: "page-viewed" | "project-viewed" | "contact-channel-opened";
  occurredAt: string; acceptedAt?: string; route?: StableId<"PublicRoute">; project?: StableId<"Project"> }): Promise<StableId<"PublicEvent">> {
  const eventId = id("PublicEvent");
  const acceptedAt = input.acceptedAt ?? input.occurredAt;
  await admin!.query(`insert into measurement.public_events
    (event_id,portfolio_id,measurement_subject,action,occurred_at,accepted_at,effective_at,page_route_identity,project_id,locale,consent_version,contact_channel)
    values ($1,$2,$3,$4,$5,$6,$5,$7,$8,'en','v1',case when $4='contact-channel-opened' then 'linkedin' else null end)`,
    [eventId, portfolioId, input.subject, input.action, input.occurredAt, acceptedAt, input.route ?? routeId, input.project ?? (input.action === "project-viewed" ? projectId : null)]);
  return eventId;
}

async function addGoal(steps: readonly { action: string; publicRouteIds?: readonly string[]; projectIds?: readonly string[] }[], activationAt = "2026-10-15T10:00:00Z") {
  const goalId = id("AnalyticsGoal");
  const versionId = id("AnalyticsGoalVersion");
  const activationId = id("Event");
  await admin!.query(`insert into measurement.analytics_goals (portfolio_id,goal_id,aggregate_version,active_version_id)
    values ($1,$2,3,null)`, [portfolioId, goalId]);
  await admin!.query(`insert into measurement.analytics_goal_versions (portfolio_id,goal_id,version_id,version_number,definition,created_at)
    values ($1,$2,$3,1,$4::jsonb,'2026-10-15T09:00:00Z')`, [portfolioId, goalId, versionId, JSON.stringify({ name: "Conversion", steps })]);
  await admin!.query(`update measurement.analytics_goals set active_version_id=$3 where portfolio_id=$1 and goal_id=$2`, [portfolioId, goalId, versionId]);
  await admin!.query(`insert into measurement.analytics_goal_activation_history
    (portfolio_id,goal_id,activation_id,version_id,aggregate_version,activated_at,activation_sequence)
    values ($1,$2,$3,$4,3,$5,1)`, [portfolioId, goalId, activationId, versionId, activationAt]);
  return { goalId, versionId };
}

async function contributions(subject: StableId<"MeasurementVisitor">, goalId: StableId<"AnalyticsGoal">) {
  return admin!.query(`select c.goal_id::text,c.version_id::text,c.terminal_event_id::text,c.generation::text,
      r.completed_generation::text
    from measurement.goal_conversion_contributions c join measurement.goal_conversion_rebuilds r
      on r.portfolio_id=c.portfolio_id and r.measurement_subject=c.measurement_subject and r.completed_generation=c.generation
    where c.portfolio_id=$1 and c.measurement_subject=$2 and c.goal_id=$3`, [portfolioId, subject, goalId]);
}

async function allContributions(subject: StableId<"MeasurementVisitor">, goalId: StableId<"AnalyticsGoal">) {
  return admin!.query(`select c.goal_id::text,c.version_id::text,c.terminal_event_id::text,c.generation::text
    from measurement.goal_conversion_contributions c
    where c.portfolio_id=$1 and c.measurement_subject=$2 and c.goal_id=$3 order by c.generation`, [portfolioId, subject, goalId]);
}

function makeService(repository: GoalConversionRepositoryPort = createPostgresGoalConversionRepository()) {
  const operations = createPostgresOperationsPersistence(runtime!.database);
  return createGoalConversionWorkService({ portfolioId, operations, repository });
}

async function drain(trigger: StableId<"PublicEvent">) {
  let calls = 0;
  let result = await service!.recomputeGoalConversions(command(trigger));
  while (result.ok && result.value.incomplete && calls < 500) {
    calls++;
    result = await service!.recomputeGoalConversions(command(trigger));
  }
  if (!result.ok || result.value.incomplete) throw new Error("GOAL_CONVERSION_DRAIN_FAILED");
  return { calls: calls + 1, result };
}

describe.runIf(Boolean(DATABASE_URL && ADMIN_URL))("Measurement goal conversions PostgreSQL acceptance", () => {
  beforeAll(async () => {
    if (!DATABASE_URL || !ADMIN_URL) throw new Error("PHASE7_CONVERSION_DATABASE_REQUIRED");
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    runtime = createPostgresRuntimeDatabase(DATABASE_URL);
    service = makeService();
  }, 20_000);

  afterAll(async () => {
    await runtime?.resource.close();
    await admin?.end();
  });

  it("processes bounded pages, resumes from the durable checkpoint, and publishes one unique conversion", async () => {
    const subject = id("MeasurementVisitor");
    await addSubject(subject);
    const goal = await addGoal([{ action: "project-viewed", projectIds: [projectId], publicRouteIds: [routeId] }, { action: "contact-channel-opened", projectIds: [projectId] }]);
    await addEvent({ subject, action: "project-viewed", occurredAt: "2026-10-15T10:01:00Z" });
    for (let index = 0; index < 24; index++) await addEvent({ subject, action: "page-viewed", occurredAt: `2026-10-15T10:02:${String(index).padStart(2, "0")}Z` });
    const terminal = await addEvent({ subject, action: "contact-channel-opened", project: projectId, occurredAt: "2026-10-15T10:03:00Z" });

    expect(await service!.recomputeGoalConversions(command(terminal))).toEqual({ ok: true, value: { processedCount: 25, nextCursor: terminal, incomplete: true } });
    expect((await contributions(subject, goal.goalId)).rows).toHaveLength(0);
    expect(await service!.recomputeGoalConversions(command(terminal))).toEqual({ ok: true, value: { processedCount: 1, nextCursor: null, incomplete: false } });
    expect((await contributions(subject, goal.goalId)).rows).toEqual([expect.objectContaining({ terminal_event_id: terminal })]);
    expect(await service!.recomputeGoalConversions(command(terminal))).toEqual({ ok: true, value: { processedCount: 0, nextCursor: null, incomplete: false } });
    expect((await contributions(subject, goal.goalId)).rows).toHaveLength(1);
  });

  it("recomputes late accepted events in canonical time order and ignores stale job replays", async () => {
    const subject = id("MeasurementVisitor");
    await addSubject(subject);
    const goal = await addGoal([{ action: "project-viewed" }, { action: "contact-channel-opened" }]);
    const terminal = await addEvent({ subject, action: "contact-channel-opened", occurredAt: "2026-10-15T10:03:00Z" });
    await service!.recomputeGoalConversions(command(terminal));
    expect((await contributions(subject, goal.goalId)).rows).toHaveLength(0);
    const lateFirst = await addEvent({ subject, action: "project-viewed", occurredAt: "2026-10-15T10:02:00Z", acceptedAt: "2026-10-15T10:04:00Z" });
    await drain(lateFirst);
    expect((await contributions(subject, goal.goalId)).rows).toEqual([expect.objectContaining({ terminal_event_id: terminal })]);
    expect((await service!.recomputeGoalConversions(command(terminal))).ok).toBe(true);
    expect((await contributions(subject, goal.goalId)).rows).toHaveLength(1);
  });

  it("resumes across more than 100 activation-history rows with one bounded interval per transaction", async () => {
    const subject = id("MeasurementVisitor");
    await addSubject(subject);
    const goal = await addGoal([{ action: "project-viewed" }]);
    for (let sequence = 2; sequence <= 101; sequence++) {
      const versionId = id("AnalyticsGoalVersion");
      const activationId = id("Event");
      const activatedAt = new Date(Date.parse("2026-10-15T10:00:00Z") + sequence * 1_000).toISOString();
      await admin!.query(`insert into measurement.analytics_goal_versions (portfolio_id,goal_id,version_id,version_number,definition,created_at)
        values ($1,$2,$3,$4,$5::jsonb,$6)`, [portfolioId, goal.goalId, versionId, sequence,
        JSON.stringify({ name: "Conversion", steps: [{ action: "project-viewed" }] }), activatedAt]);
      await admin!.query(`insert into measurement.analytics_goal_activation_history
        (portfolio_id,goal_id,activation_id,version_id,aggregate_version,activated_at,activation_sequence)
        values ($1,$2,$3,$4,$5,$6,$7)`, [portfolioId, goal.goalId, activationId, versionId, sequence + 2, activatedAt, sequence]);
    }
    const terminal = await addEvent({ subject, action: "project-viewed", occurredAt: "2026-10-15T11:00:00Z", project: projectId });
    const drained = await drain(terminal);
    expect(drained.calls).toBeGreaterThan(100);
    expect(drained.result.value.processedCount).toBe(1);
    expect((await contributions(subject, goal.goalId)).rows).toEqual([expect.objectContaining({ terminal_event_id: terminal })]);
  });

  it("reports one terminal contribution from only the completed generation after recomputation", async () => {
    const subject = id("MeasurementVisitor");
    await addSubject(subject);
    const goal = await addGoal([{ action: "project-viewed" }]);
    const terminal = await addEvent({ subject, action: "project-viewed", occurredAt: "2026-10-15T10:05:00Z", project: projectId });
    await drain(terminal);
    await addEvent({ subject, action: "page-viewed", occurredAt: "2026-10-15T10:06:00Z" });
    const recomputeTrigger = await addEvent({ subject, action: "page-viewed", occurredAt: "2026-10-15T10:07:00Z" });
    await drain(recomputeTrigger);
    const stored = await allContributions(subject, goal.goalId);
    const reportable = await contributions(subject, goal.goalId);
    expect(stored.rows).toHaveLength(2);
    expect(new Set(stored.rows.map(row => row.generation)).size).toBe(2);
    expect(reportable.rows).toEqual([expect.objectContaining({ terminal_event_id: terminal })]);
  });

  it("does not bridge a consent withdrawal and a later regrant on the same subject", async () => {
    const subject = id("MeasurementVisitor");
    const consentId = await addSubject(subject);
    const goal = await addGoal([{ action: "project-viewed" }, { action: "contact-channel-opened" }]);
    await addEvent({ subject, action: "project-viewed", occurredAt: "2026-10-15T10:30:00Z" });
    const terminal = await addEvent({ subject, action: "contact-channel-opened", occurredAt: "2026-10-15T11:20:00Z" });
    await admin!.query(`update measurement.consents set state='granted',revision=3,recorded_at='2026-10-15T11:10:00Z' where consent_id=$1`, [consentId]);
    await admin!.query(`insert into measurement.consent_history (portfolio_id,consent_id,revision,state,notice_version,recorded_at)
      values ($1,$2,2,'denied','v1','2026-10-15T11:00:00Z'),($1,$2,3,'granted','v1','2026-10-15T11:10:00Z')`, [portfolioId, consentId]);
    expect((await service!.recomputeGoalConversions(command(terminal))).ok).toBe(true);
    expect((await contributions(subject, goal.goalId)).rows).toHaveLength(0);
  });

  it("rolls back contribution and checkpoint writes together and rejects unauthorized or foreign scope", async () => {
    const subject = id("MeasurementVisitor");
    await addSubject(subject);
    const goal = await addGoal([{ action: "project-viewed" }]);
    const trigger = await addEvent({ subject, action: "project-viewed", occurredAt: "2026-10-15T10:05:00Z" });
    const base = createPostgresGoalConversionRepository();
    const failing: GoalConversionRepositoryPort = { ...base, async saveBatch(input, tx) {
      await base.saveBatch(input, tx);
      throw new Error("injected contribution/checkpoint failure");
    } };
    expect(await makeService(failing).recomputeGoalConversions(command(trigger))).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable" } });
    expect((await admin!.query(`select count(*)::int as count from measurement.goal_conversion_rebuilds where portfolio_id=$1 and measurement_subject=$2`, [portfolioId, subject])).rows[0]?.count).toBe(0);
    expect((await contributions(subject, goal.goalId)).rows).toHaveLength(0);
    const unauthorized = { ...command(trigger), actor: { ...command(trigger).actor, purpose: "measurement.retention" } } as unknown as RecomputeGoalConversionsCommand;
    expect(await service!.recomputeGoalConversions(unauthorized)).toMatchObject({ ok: false, error: { kind: "validation" } });
    const foreign = { ...command(trigger), scope: { kind: "portfolio" as const, portfolioId: id("Portfolio") } };
    expect(await service!.recomputeGoalConversions(foreign)).toMatchObject({ ok: false, error: { kind: "validation" } });
  });

  it("keeps event subjects, checkpoints, and contributions unreadable to application and anonymous roles", async () => {
    for (const role of ["shipwithali_application", "anon"]) {
      await admin!.query(`set role ${role}`);
      let failure: unknown;
      try {
        await admin!.query("select measurement_subject from measurement.goal_conversion_contributions limit 1");
      } catch (error) {
        failure = error;
      } finally {
        await admin!.query("reset role");
      }
      expect(String(failure)).toContain("permission denied");
    }
  });
});
