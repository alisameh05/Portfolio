import { sql } from "kysely";
import { parseStableId, type StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import { resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { AnalyticsGoalDefinition } from "../application/owner-analytics.js";
import { emptyGoalConversionProgress, type GoalConversionEvent, type GoalConversionTimeline } from "../application/goal-conversions.js";
import type { GoalConversionCheckpoint, GoalConversionCursor, GoalConversionRepositoryPort } from "../ports/goal-conversions.js";

interface TriggerRow { event_id: string; measurement_subject: string; accepted_at: string }
interface StateRow {
  generation: string | number; completed_generation: string | number; trigger_event_id: string; trigger_accepted_at: string;
  cursor_effective_at: string | null; cursor_accepted_at: string | null; cursor_event_id: string | null;
  progress: GoalConversionCheckpoint["progress"]; completed: boolean;
}
interface GoalRow { goal_id: string; version_id: string; definition: AnalyticsGoalDefinition }
interface ActivationRow { goal_id: string; version_id: string; activated_at: string; activation_sequence: string | number }
interface EventRow {
  event_id: string; measurement_subject: string; action: GoalConversionEvent["action"]; page_route_identity: string;
  project_ids: string[]; effective_at: string; accepted_at: string; consent_revision: number;
}

function asInstant(value: string | Date): string {
  if (typeof value === "string") return value;
  return value.toISOString();
}

function instantMicros(value: string): number {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error("GOAL_CONVERSION_TIMESTAMP_INVALID");
  const fraction = /\.(\d+)(?:Z|[+-]\d\d:\d\d)$/i.exec(value)?.[1] ?? "";
  return millis * 1_000 + Number(fraction.padEnd(6, "0").slice(3, 6));
}

async function setScope(tx: TransactionContext, portfolioId: StableId<"Portfolio">) {
  const db = resolvePostgresTransaction(tx);
  await sql`select set_config('shipwithali.portfolio_id', ${portfolioId}, true)`.execute(db);
  return db;
}

function toCursor(row: StateRow): GoalConversionCursor | null {
  if (!row.cursor_effective_at || !row.cursor_accepted_at || !row.cursor_event_id) return null;
  const eventId = parseStableId("PublicEvent", row.cursor_event_id);
  if (!eventId.ok) throw new Error("GOAL_CONVERSION_CURSOR_INVALID");
  return { effectiveAt: asInstant(row.cursor_effective_at), acceptedAt: asInstant(row.cursor_accepted_at), eventId: eventId.value };
}

export function createPostgresGoalConversionRepository(): GoalConversionRepositoryPort {
  return {
    async beginOrResume(input, transaction): Promise<GoalConversionCheckpoint | null> {
      const db = await setScope(transaction, input.portfolioId);
      const triggerResult = await sql<TriggerRow>`select event_id::text, measurement_subject::text,
          to_char(accepted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as accepted_at
        from measurement.public_events where portfolio_id = ${input.portfolioId}::uuid and event_id = ${input.eventId}::uuid`.execute(db);
      const trigger = triggerResult.rows[0];
      if (!trigger) return null;
      const subject = parseStableId("MeasurementVisitor", trigger.measurement_subject);
      if (!subject.ok) throw new Error("GOAL_CONVERSION_SUBJECT_INVALID");
      await sql`select pg_advisory_xact_lock(hashtextextended(${input.portfolioId + ":" + subject.value}, 191))`.execute(db);
      const consentResult = await sql<{ state: string | null }>`select state from measurement.consents
        where portfolio_id = ${input.portfolioId}::uuid and subject = ${subject.value}::uuid
        order by recorded_at desc, consent_id desc limit 1`.execute(db);
      const consentGranted = consentResult.rows[0]?.state === "granted";
      const stateResult = await sql<StateRow>`select generation, completed_generation, trigger_event_id::text,
          to_char(trigger_accepted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as trigger_accepted_at,
          case when cursor_effective_at is null then null else to_char(cursor_effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end as cursor_effective_at,
          case when cursor_accepted_at is null then null else to_char(cursor_accepted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end as cursor_accepted_at,
          cursor_event_id::text, progress, completed
        from measurement.goal_conversion_rebuilds where portfolio_id = ${input.portfolioId}::uuid
          and measurement_subject = ${subject.value}::uuid for update`.execute(db);
      const state = stateResult.rows[0];
      if (!state) {
        await sql`insert into measurement.goal_conversion_rebuilds
          (portfolio_id, measurement_subject, generation, completed_generation, trigger_event_id, trigger_accepted_at, progress, completed, updated_at)
          values (${input.portfolioId}::uuid, ${subject.value}::uuid, 1, 0, ${input.eventId}::uuid, ${trigger.accepted_at}::timestamptz,
            ${JSON.stringify(emptyGoalConversionProgress())}::jsonb, false, ${input.now}::timestamptz)`.execute(db);
        return { status: "ready", portfolioId: input.portfolioId, measurementSubject: subject.value, generation: 1,
          triggerEventId: input.eventId, progress: emptyGoalConversionProgress(), cursor: null, consentGranted };
      }

      const triggerAt = instantMicros(state.trigger_accepted_at);
      const incomingAt = instantMicros(trigger.accepted_at);
      const sameTrigger = state.trigger_event_id === input.eventId;
      if (sameTrigger && state.completed) return { status: "already-complete", portfolioId: input.portfolioId,
        measurementSubject: subject.value, generation: Number(state.generation), triggerEventId: input.eventId,
        progress: state.progress, cursor: toCursor(state), consentGranted };
      if (!sameTrigger && (incomingAt < triggerAt || (incomingAt === triggerAt && input.eventId <= state.trigger_event_id))) {
        return { status: "stale-trigger", portfolioId: input.portfolioId, measurementSubject: subject.value,
          generation: Number(state.generation), triggerEventId: input.eventId, progress: state.progress, cursor: toCursor(state), consentGranted };
      }
      if (!sameTrigger) {
        const generation = Number(state.generation) + 1;
        if (!Number.isSafeInteger(generation)) throw new Error("GOAL_CONVERSION_GENERATION_INVALID");
        await sql`update measurement.goal_conversion_rebuilds set generation = ${generation}, trigger_event_id = ${input.eventId}::uuid,
            trigger_accepted_at = ${trigger.accepted_at}::timestamptz, cursor_effective_at = null, cursor_accepted_at = null,
            cursor_event_id = null, progress = ${JSON.stringify(emptyGoalConversionProgress())}::jsonb,
            completed = false, updated_at = ${input.now}::timestamptz
          where portfolio_id = ${input.portfolioId}::uuid and measurement_subject = ${subject.value}::uuid`.execute(db);
        return { status: "ready", portfolioId: input.portfolioId, measurementSubject: subject.value, generation,
          triggerEventId: input.eventId, progress: emptyGoalConversionProgress(), cursor: null, consentGranted };
      }
      return { status: "ready", portfolioId: input.portfolioId, measurementSubject: subject.value,
        generation: Number(state.generation), triggerEventId: input.eventId, progress: state.progress,
        cursor: toCursor(state), consentGranted };
    },

    async listTimelines(portfolioId, transaction): Promise<readonly GoalConversionTimeline[]> {
      const db = await setScope(transaction, portfolioId);
      const goals = await sql<GoalRow>`select versions.goal_id::text, versions.version_id::text, versions.definition
        from measurement.analytics_goal_versions versions
        where versions.portfolio_id = ${portfolioId}::uuid
        order by versions.goal_id, versions.version_number`.execute(db);
      const activations = await sql<ActivationRow>`select goal_id::text, version_id::text,
          to_char(activated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as activated_at, activation_sequence
        from measurement.analytics_goal_activation_history where portfolio_id = ${portfolioId}::uuid
        order by goal_id, activation_sequence`.execute(db);
      const grouped = new Map<string, { goalId: StableId<"AnalyticsGoal">; versions: GoalConversionTimeline["versions"][number][]; activations: GoalConversionTimeline["activations"][number][] }>();
      for (const row of goals.rows) {
        const goalId = parseStableId("AnalyticsGoal", row.goal_id);
        const versionId = parseStableId("AnalyticsGoalVersion", row.version_id);
        if (!goalId.ok || !versionId.ok) throw new Error("GOAL_CONVERSION_TIMELINE_ID_INVALID");
        const group = grouped.get(goalId.value) ?? { goalId: goalId.value, versions: [], activations: [] };
        group.versions.push({ versionId: versionId.value, definition: row.definition });
        grouped.set(goalId.value, group);
      }
      for (const row of activations.rows) {
        const goalId = parseStableId("AnalyticsGoal", row.goal_id);
        const versionId = parseStableId("AnalyticsGoalVersion", row.version_id);
        if (!goalId.ok || !versionId.ok) throw new Error("GOAL_CONVERSION_ACTIVATION_ID_INVALID");
        const group = grouped.get(goalId.value);
        if (!group || !group.versions.some(version => version.versionId === versionId.value)) throw new Error("GOAL_CONVERSION_ACTIVATION_VERSION_MISSING");
        group.activations.push({ versionId: versionId.value, activatedAt: asInstant(row.activated_at), activationSequence: Number(row.activation_sequence) });
      }
      return [...grouped.values()];
    },

    async listEvents(input, transaction): Promise<readonly GoalConversionEvent[]> {
      const db = await setScope(transaction, input.portfolioId);
      const rows = await sql<EventRow>`select e.event_id::text, e.measurement_subject::text, e.action,
          e.page_route_identity::text,
          array_remove(array[e.project_id::text, e.source_project_id::text, e.target_project_id::text], null) as project_ids,
          to_char(e.effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as effective_at,
          to_char(e.accepted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as accepted_at,
          consent_at_event.revision as consent_revision
        from measurement.public_events e
        join lateral (
          select consent.consent_id from measurement.consents consent
          where consent.portfolio_id = e.portfolio_id and consent.subject = e.measurement_subject and consent.state = 'granted'
          order by consent.recorded_at desc, consent.consent_id desc limit 1
        ) current_consent on true
        join lateral (
          select history.revision, history.state from measurement.consent_history history
          where history.portfolio_id = e.portfolio_id and history.consent_id = current_consent.consent_id
            and history.recorded_at <= e.accepted_at
          order by history.revision desc limit 1
        ) consent_at_event on consent_at_event.state = 'granted'
        where e.portfolio_id = ${input.portfolioId}::uuid and e.measurement_subject = ${input.measurementSubject}::uuid
          and e.accepted_at >= ${input.acceptedAfter}::timestamptz
          and (${input.after?.effectiveAt ?? null}::timestamptz is null or
            (e.effective_at, e.accepted_at, e.event_id) > (${input.after?.effectiveAt ?? null}::timestamptz,
              ${input.after?.acceptedAt ?? null}::timestamptz, ${input.after?.eventId ?? null}::uuid))
        order by e.effective_at, e.accepted_at, e.event_id limit ${input.limit}`.execute(db);
      return rows.rows.map(row => {
        const eventId = parseStableId("PublicEvent", row.event_id);
        const measurementSubject = parseStableId("MeasurementVisitor", row.measurement_subject);
        const routeId = parseStableId("PublicRoute", row.page_route_identity);
        const projectIds = row.project_ids.map(value => parseStableId("Project", value));
        if (!eventId.ok || !measurementSubject.ok || !routeId.ok || !Number.isSafeInteger(row.consent_revision)) {
          throw new Error("GOAL_CONVERSION_EVENT_ROW_INVALID");
        }
        const validProjectIds: StableId<"Project">[] = [];
        for (const projectId of projectIds) {
          if (!projectId.ok) throw new Error("GOAL_CONVERSION_PROJECT_ID_INVALID");
          validProjectIds.push(projectId.value);
        }
        return { eventId: eventId.value, measurementSubject: measurementSubject.value, action: row.action,
          pageRouteIdentity: routeId.value, projectIds: validProjectIds,
          effectiveAt: row.effective_at, acceptedAt: row.accepted_at, consentRevision: row.consent_revision };
      });
    },

    async saveBatch(input, transaction): Promise<boolean> {
      const db = await setScope(transaction, input.checkpoint.portfolioId);
      const updated = await sql`update measurement.goal_conversion_rebuilds set
          cursor_effective_at = ${input.cursor?.effectiveAt ?? null}::timestamptz,
          cursor_accepted_at = ${input.cursor?.acceptedAt ?? null}::timestamptz,
          cursor_event_id = ${input.cursor?.eventId ?? null}::uuid,
          progress = ${JSON.stringify(input.progress)}::jsonb,
          completed = ${input.completed},
          completed_generation = case when ${input.completed} then generation else completed_generation end,
          updated_at = transaction_timestamp()
        where portfolio_id = ${input.checkpoint.portfolioId}::uuid
          and measurement_subject = ${input.checkpoint.measurementSubject}::uuid
          and generation = ${input.checkpoint.generation} and trigger_event_id = ${input.checkpoint.triggerEventId}::uuid
          and completed = false`.execute(db);
      if (updated.numAffectedRows !== 1n) return false;
      for (const contribution of input.contributions) {
        if (contribution.measurementSubject !== input.checkpoint.measurementSubject) throw new Error("GOAL_CONVERSION_SUBJECT_SCOPE_MISMATCH");
        await sql`insert into measurement.goal_conversion_contributions
          (portfolio_id, measurement_subject, goal_id, version_id, terminal_event_id, converted_at, accepted_at, consent_revision, activation_sequence, generation)
          values (${input.checkpoint.portfolioId}::uuid, ${contribution.measurementSubject}::uuid, ${contribution.goalId}::uuid,
            ${contribution.versionId}::uuid, ${contribution.terminalEventId}::uuid, ${contribution.convertedAt}::timestamptz,
            ${contribution.acceptedAt}::timestamptz, ${contribution.consentRevision},
            ${contribution.activationSequence}, ${input.checkpoint.generation}) on conflict do nothing`.execute(db);
      }
      return true;
    },
  };
}
