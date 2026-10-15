import { sql } from "kysely";
import { parseStableId, type StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import { resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { AnalyticsGoalDefinition } from "../application/owner-analytics.js";
import type { DailyAggregate, MeasurementEventType } from "../domain/index.js";
import type { DailyAggregatePage, DailyAggregateRepositoryPort, DailyAggregateReportRecord } from "../ports/daily-aggregates.js";

const POLICY_VERSION = "phase7.daily.v1";
const SAFE_ACTIONS = new Set<MeasurementEventType>([
  "page-viewed", "project-viewed", "active-engagement-sampled", "media-engaged", "related-project-opened",
  "contact-channel-opened", "external-project-link-opened", "testimonial-engaged", "global-project-cta-opened",
]);

interface ActionRow { metric_key: string; event_count: string | number; sum_value: string | number; observed_subjects: string | number; returning_subjects: string | number }
interface GoalRow { goal_id: string; version_id: string; definition: AnalyticsGoalDefinition; event_count: string | number; sum_value: string | number; observed_subjects: string | number; returning_subjects: string | number }
interface CheckpointRow { source_event_count: string | number; source_conversion_count: string | number }
interface ReportRow { utc_day: string | Date; metric_kind: "action" | "goal"; metric_key: string; goal_id: string | null; goal_version_id: string | null;
  event_count: string | number; sum_value: string | number; observed_subjects: string | number; returning_subjects: string | number;
  policy_version: string; checkpoint_at: string | Date; incomplete: boolean; definition: AnalyticsGoalDefinition | null }
interface CoverageRow { day_count: string | number; incomplete: boolean | null; as_of: string | Date | null }

function number(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("DAILY_AGGREGATE_NUMBER_INVALID");
  return parsed;
}

function instant(value: string | Date): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}

function stableId<T extends string>(kind: T, value: string): StableId<T> {
  const parsed = parseStableId(kind, value);
  if (!parsed.ok) throw new Error("DAILY_AGGREGATE_STABLE_ID_INVALID");
  return parsed.value;
}

async function configure(tx: TransactionContext, portfolioId: StableId<"Portfolio">, ownerId?: StableId<"Owner">) {
  const db = resolvePostgresTransaction(tx);
  await sql`select set_config('shipwithali.portfolio_id', ${portfolioId}, true)`.execute(db);
  if (ownerId !== undefined) await sql`select set_config('shipwithali.owner_id', ${ownerId}, true)`.execute(db);
  return db;
}

function asRecord(row: ReportRow): DailyAggregateReportRecord {
  const date = typeof row.utc_day === "string" ? row.utc_day.slice(0, 10) : row.utc_day.toISOString().slice(0, 10);
  const metric: DailyAggregate["metric"] = row.metric_kind;
  const common: DailyAggregate = {
    date, metric, metricKey: row.metric_key, count: number(row.event_count), sum: number(row.sum_value),
    observedSubjects: number(row.observed_subjects), returningSubjects: number(row.returning_subjects),
    policyVersion: row.policy_version, asOf: instant(row.checkpoint_at), incomplete: row.incomplete,
  };
  if (metric === "action") {
    if (!SAFE_ACTIONS.has(row.metric_key as MeasurementEventType) || row.goal_id !== null || row.goal_version_id !== null) throw new Error("DAILY_AGGREGATE_ACTION_ROW_INVALID");
    return common;
  }
  if (!row.goal_id || !row.goal_version_id || !row.definition) throw new Error("DAILY_AGGREGATE_GOAL_ROW_INVALID");
  return { ...common, goalId: stableId("AnalyticsGoal", row.goal_id), goalVersionId: stableId("AnalyticsGoalVersion", row.goal_version_id), definitionSnapshot: row.definition };
}

export function createPostgresDailyAggregateRepository(): DailyAggregateRepositoryPort {
  return {
    async rebuildDay(input, transaction): Promise<number> {
      const db = await configure(transaction, input.portfolioId);
      const start = `${input.utcDay}T00:00:00.000Z`;
      const endDate = new Date(Date.parse(start) + 86_400_000).toISOString();
      const acceptedCutoff = new Date(Date.parse(input.asOf) - 14 * 86_400_000).toISOString();
      await sql`select pg_advisory_xact_lock(hashtextextended(${input.portfolioId + ":" + input.utcDay}, 202))`.execute(db);

      const actions = await sql<ActionRow>`with day_events as (
        select e.action, e.measurement_subject, e.active_milliseconds
        from measurement.public_events e
        where e.portfolio_id = ${input.portfolioId}::uuid
          and e.effective_at >= ${start}::timestamptz and e.effective_at < ${endDate}::timestamptz
          and e.accepted_at >= ${acceptedCutoff}::timestamptz and e.accepted_at <= ${input.asOf}::timestamptz
      )
      select e.action as metric_key, count(*)::bigint as event_count,
        coalesce(sum(e.active_milliseconds), 0)::bigint as sum_value,
        count(distinct e.measurement_subject)::bigint as observed_subjects,
        count(distinct e.measurement_subject) filter (where exists (
          select 1 from measurement.public_events prior
          where prior.portfolio_id = ${input.portfolioId}::uuid and prior.measurement_subject = e.measurement_subject
            and prior.effective_at >= ${start}::timestamptz - interval '14 days'
            and prior.effective_at < ${start}::timestamptz
            and prior.accepted_at >= ${acceptedCutoff}::timestamptz and prior.accepted_at <= ${input.asOf}::timestamptz
        ))::bigint as returning_subjects
      from day_events e group by e.action order by e.action`.execute(db);

      const goals = await sql<GoalRow>`with day_conversions as (
        select c.goal_id, c.version_id, c.measurement_subject
        from measurement.goal_conversion_contributions c
        join measurement.goal_conversion_rebuilds r
          on r.portfolio_id = c.portfolio_id and r.measurement_subject = c.measurement_subject
          and r.completed_generation = c.generation
        where c.portfolio_id = ${input.portfolioId}::uuid
          and c.converted_at >= ${start}::timestamptz and c.converted_at < ${endDate}::timestamptz
          and c.accepted_at >= ${acceptedCutoff}::timestamptz and c.accepted_at <= ${input.asOf}::timestamptz
      )
      select c.goal_id::text as goal_id, c.version_id::text as version_id, v.definition,
        count(*)::bigint as event_count, 0::bigint as sum_value,
        count(distinct c.measurement_subject)::bigint as observed_subjects,
        count(distinct c.measurement_subject) filter (where exists (
          select 1 from measurement.public_events prior
          where prior.portfolio_id = ${input.portfolioId}::uuid and prior.measurement_subject = c.measurement_subject
            and prior.effective_at >= ${start}::timestamptz - interval '14 days'
            and prior.effective_at < ${start}::timestamptz
            and prior.accepted_at >= ${acceptedCutoff}::timestamptz and prior.accepted_at <= ${input.asOf}::timestamptz
        ))::bigint as returning_subjects
      from day_conversions c join measurement.analytics_goal_versions v
        on v.portfolio_id = ${input.portfolioId}::uuid and v.goal_id = c.goal_id and v.version_id = c.version_id
      group by c.goal_id, c.version_id, v.definition order by c.goal_id, c.version_id`.execute(db);

      await sql`delete from measurement.daily_aggregates where portfolio_id = ${input.portfolioId}::uuid and utc_day = ${input.utcDay}::date`.execute(db);
      for (const row of actions.rows) {
        if (!SAFE_ACTIONS.has(row.metric_key as MeasurementEventType)) throw new Error("DAILY_AGGREGATE_ACTION_UNSUPPORTED");
        await sql`insert into measurement.daily_aggregates
          (portfolio_id, utc_day, metric_kind, metric_key, dimensions, event_count, sum_value, observed_subjects, returning_subjects, policy_version, checkpoint_at, incomplete)
          values (${input.portfolioId}::uuid, ${input.utcDay}::date, 'action', ${row.metric_key}, '{}'::jsonb,
            ${number(row.event_count)}, ${number(row.sum_value)}, ${number(row.observed_subjects)}, ${number(row.returning_subjects)}, ${POLICY_VERSION}, ${input.asOf}::timestamptz, false)`.execute(db);
      }
      for (const row of goals.rows) {
        await sql`insert into measurement.daily_aggregates
          (portfolio_id, utc_day, metric_kind, metric_key, goal_id, goal_version_id, dimensions, event_count, sum_value, observed_subjects, returning_subjects, policy_version, checkpoint_at, incomplete)
          values (${input.portfolioId}::uuid, ${input.utcDay}::date, 'goal', ${row.goal_id + ":" + row.version_id}, ${row.goal_id}::uuid, ${row.version_id}::uuid, '{}'::jsonb,
            ${number(row.event_count)}, 0, ${number(row.observed_subjects)}, ${number(row.returning_subjects)}, ${POLICY_VERSION}, ${input.asOf}::timestamptz, false)`.execute(db);
      }
      const counts = await sql<CheckpointRow>`select
        (select count(*) from measurement.public_events e where e.portfolio_id = ${input.portfolioId}::uuid
          and e.effective_at >= ${start}::timestamptz and e.effective_at < ${endDate}::timestamptz
          and e.accepted_at >= ${acceptedCutoff}::timestamptz and e.accepted_at <= ${input.asOf}::timestamptz) as source_event_count,
        (select count(*) from measurement.goal_conversion_contributions c join measurement.goal_conversion_rebuilds r
          on r.portfolio_id = c.portfolio_id and r.measurement_subject = c.measurement_subject and r.completed_generation = c.generation
          where c.portfolio_id = ${input.portfolioId}::uuid and c.converted_at >= ${start}::timestamptz and c.converted_at < ${endDate}::timestamptz
            and c.accepted_at >= ${acceptedCutoff}::timestamptz and c.accepted_at <= ${input.asOf}::timestamptz) as source_conversion_count`.execute(db);
      const totals = counts.rows[0];
      if (!totals) throw new Error("DAILY_AGGREGATE_CHECKPOINT_MISSING");
      await sql`insert into measurement.daily_aggregate_checkpoints
        (portfolio_id, utc_day, source_event_count, source_conversion_count, policy_version, checkpoint_at, incomplete)
        values (${input.portfolioId}::uuid, ${input.utcDay}::date, ${number(totals.source_event_count)}, ${number(totals.source_conversion_count)}, ${POLICY_VERSION}, ${input.asOf}::timestamptz, false)
        on conflict (portfolio_id, utc_day) do update set source_event_count = excluded.source_event_count,
          source_conversion_count = excluded.source_conversion_count, policy_version = excluded.policy_version,
          checkpoint_at = excluded.checkpoint_at, incomplete = false`.execute(db);
      return actions.rows.length + goals.rows.length;
    },

    async readReport(input, transaction): Promise<DailyAggregatePage> {
      const db = await configure(transaction, input.portfolioId, input.ownerId);
      const rows = input.grouping === "daily-action"
        ? await sql<ReportRow>`select a.utc_day, a.metric_kind, a.metric_key, a.goal_id::text as goal_id, a.goal_version_id::text as goal_version_id,
            a.event_count, a.sum_value, a.observed_subjects, a.returning_subjects, a.policy_version, a.checkpoint_at, a.incomplete, null::jsonb as definition
          from measurement.daily_aggregates a where a.portfolio_id = ${input.portfolioId}::uuid
            and a.utc_day between ${input.startDay}::date and ${input.endDay}::date and a.metric_kind = 'action'
            and (${input.action ?? null}::text is null or a.metric_key = ${input.action ?? null})
          order by a.utc_day, a.metric_key limit ${input.limit}`.execute(db)
        : await sql<ReportRow>`select a.utc_day, a.metric_kind, a.metric_key, a.goal_id::text as goal_id, a.goal_version_id::text as goal_version_id,
            a.event_count, a.sum_value, a.observed_subjects, a.returning_subjects, a.policy_version, a.checkpoint_at, a.incomplete, v.definition
          from measurement.daily_aggregates a join measurement.analytics_goal_versions v
            on v.portfolio_id = a.portfolio_id and v.goal_id = a.goal_id and v.version_id = a.goal_version_id
          where a.portfolio_id = ${input.portfolioId}::uuid and a.utc_day between ${input.startDay}::date and ${input.endDay}::date and a.metric_kind = 'goal'
          order by a.utc_day, a.metric_key limit ${input.limit}`.execute(db);
      const coverage = await sql<CoverageRow>`select count(*)::int as day_count, bool_or(incomplete) as incomplete,
          to_char(max(checkpoint_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as as_of
        from measurement.daily_aggregate_checkpoints where portfolio_id = ${input.portfolioId}::uuid
          and utc_day between ${input.startDay}::date and ${input.endDay}::date`.execute(db);
      const checkpoint = coverage.rows[0];
      const dayCount = number(checkpoint?.day_count ?? 0);
      const expectedDays = Math.floor((Date.parse(`${input.endDay}T00:00:00Z`) - Date.parse(`${input.startDay}T00:00:00Z`)) / 86_400_000) + 1;
      const pageRows = rows.rows.map(asRecord);
      return {
        rows: pageRows,
        asOf: checkpoint?.as_of ? instant(checkpoint.as_of) : new Date().toISOString(),
        incomplete: dayCount < expectedDays || checkpoint?.incomplete === true || pageRows.some(row => row.incomplete),
      };
    },
  };
}
