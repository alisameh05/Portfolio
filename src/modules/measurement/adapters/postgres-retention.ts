import { sql } from "kysely";
import type { BoundedWorkResult } from "@shared/application";
import type { TransactionContext } from "../../../runtime/ports.js";
import { resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { MeasurementRetentionBatch, MeasurementRetentionRepositoryPort } from "../ports/retention.js";

interface RetentionCheckpoint { stage: string; requested_at: string | Date; incomplete: boolean }
interface RemovedDetail { row_id: string; utc_day: string }
interface RemovedConversion { row_id: string; utc_day: string }
interface DayCounts { source_event_count: string | number; source_conversion_count: string | number; pending_rebuild_count: string | number }

const DAY_MS = 86_400_000;
const RAW_DAYS = 14;
const AGGREGATE_MONTHS = 13;

function instant(value: string | Date): string { return typeof value === "string" ? new Date(value).toISOString() : value.toISOString(); }
function numeric(value: string | number | bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("MEASUREMENT_RETENTION_COUNT_INVALID");
  return number;
}
function retentionStages(kind: MeasurementRetentionBatch["kind"]): readonly string[] {
  if (kind === "detail") return ["contributions", "events", "rebuilds", "consent-history", "consents"];
  if (kind === "aggregates") return ["aggregates", "checkpoints"];
  return ["contributions", "events", "rebuilds"];
}
function asCutoff(now: string): string { return new Date(Date.parse(now) - RAW_DAYS * DAY_MS).toISOString(); }

async function configure(tx: TransactionContext, portfolioId: string) {
  const db = resolvePostgresTransaction(tx);
  await sql`select set_config('shipwithali.portfolio_id', ${portfolioId}, true)`.execute(db);
  return db;
}

async function sealDays(db: ReturnType<typeof resolvePostgresTransaction>, portfolioId: string,
  days: readonly string[], asOf: string): Promise<boolean> {
  let incomplete = false;
  for (const day of [...new Set(days)].sort()) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${portfolioId + ":" + day}, 202))`.execute(db);
    const counts = await sql<DayCounts>`select
      (select count(*) from measurement.public_events e where e.portfolio_id = ${portfolioId}::uuid
        and (e.effective_at at time zone 'UTC')::date = ${day}::date
        and e.accepted_at <= ${asOf}::timestamptz) as source_event_count,
      (select count(*) from measurement.goal_conversion_contributions c
        join measurement.goal_conversion_rebuilds r on r.portfolio_id = c.portfolio_id
          and r.measurement_subject = c.measurement_subject and r.completed_generation = c.generation
        where c.portfolio_id = ${portfolioId}::uuid and (c.converted_at at time zone 'UTC')::date = ${day}::date
          and c.accepted_at <= ${asOf}::timestamptz) as source_conversion_count,
      (select count(*) from measurement.goal_conversion_rebuilds r
        join measurement.public_events e on e.portfolio_id = r.portfolio_id and e.measurement_subject = r.measurement_subject
        where r.portfolio_id = ${portfolioId}::uuid and (e.effective_at at time zone 'UTC')::date = ${day}::date
          and e.accepted_at <= ${asOf}::timestamptz and r.completed_generation < r.generation) as pending_rebuild_count`.execute(db);
    const actual = counts.rows[0];
    if (!actual) throw new Error("MEASUREMENT_RETENTION_DAY_COUNTS_MISSING");
    const existing = await sql<{ source_event_count: string | number; source_conversion_count: string | number; incomplete: boolean }>`
      select source_event_count, source_conversion_count, incomplete from measurement.daily_aggregate_checkpoints
      where portfolio_id = ${portfolioId}::uuid and utc_day = ${day}::date for update`.execute(db);
    const checkpoint = existing.rows[0];
    if (!checkpoint) {
      await sql`insert into measurement.daily_aggregate_checkpoints
        (portfolio_id, utc_day, source_event_count, source_conversion_count, policy_version, checkpoint_at, incomplete, retention_sealed)
        values (${portfolioId}::uuid, ${day}::date, 0, 0, 'phase7.daily.v1', ${asOf}::timestamptz, true, true)
        on conflict (portfolio_id, utc_day) do nothing`.execute(db);
      incomplete = true;
      continue;
    }
    const missing = numeric(checkpoint.source_event_count) < numeric(actual.source_event_count) ||
      numeric(checkpoint.source_conversion_count) < numeric(actual.source_conversion_count) ||
      numeric(actual.pending_rebuild_count) > 0;
    const dayIncomplete = checkpoint.incomplete || missing;
    await sql`select measurement.seal_daily_aggregate_checkpoint(${portfolioId}::uuid, ${day}::date,
      ${dayIncomplete}, ${asOf}::timestamptz)`.execute(db);
    incomplete ||= dayIncomplete;
  }
  return incomplete;
}

async function selectAndDeleteContributions(db: ReturnType<typeof resolvePostgresTransaction>, input: MeasurementRetentionBatch,
  withdrawal: boolean): Promise<{ count: number; incomplete: boolean }> {
  const cutoff = asCutoff(input.now);
  const selected = withdrawal
    ? await sql<RemovedConversion>`with page as materialized (
        select c.ctid::text as row_id, (c.converted_at at time zone 'UTC')::date::text as utc_day
        from measurement.goal_conversion_contributions c
        join measurement.consents consent on consent.portfolio_id = c.portfolio_id
          and consent.subject = c.measurement_subject and consent.state <> 'granted'
        where c.portfolio_id = ${input.portfolioId}::uuid
        order by c.accepted_at, c.measurement_subject, c.goal_id, c.version_id, c.terminal_event_id, c.generation
        limit ${input.batchSize} for update of consent
      ) select row_id, utc_day from page`.execute(db)
    : await sql<RemovedConversion>`with page as materialized (
        select c.ctid::text as row_id, (c.converted_at at time zone 'UTC')::date::text as utc_day
        from measurement.goal_conversion_contributions c
        where c.portfolio_id = ${input.portfolioId}::uuid and (
          c.accepted_at <= ${cutoff}::timestamptz or exists (
            select 1 from measurement.public_events expired where expired.portfolio_id = c.portfolio_id
              and expired.event_id = c.terminal_event_id and expired.accepted_at <= ${cutoff}::timestamptz))
        order by c.accepted_at, c.measurement_subject, c.goal_id, c.version_id, c.terminal_event_id, c.generation
        limit ${input.batchSize}
      ) select row_id, utc_day from page`.execute(db);
  const incomplete = await sealDays(db, input.portfolioId, selected.rows.map(row => row.utc_day), input.now);
  if (selected.rows.length) await sql`delete from measurement.goal_conversion_contributions
    where portfolio_id = ${input.portfolioId}::uuid and ctid = any(${selected.rows.map(row => row.row_id)}::tid[])`.execute(db);
  return { count: selected.rows.length, incomplete };
}

async function deleteExpiredEvents(db: ReturnType<typeof resolvePostgresTransaction>, input: MeasurementRetentionBatch,
  withdrawal: boolean): Promise<{ count: number; incomplete: boolean }> {
  const cutoff = asCutoff(input.now);
  const selected = withdrawal
    ? await sql<RemovedDetail>`with page as materialized (
        select e.ctid::text as row_id, (e.effective_at at time zone 'UTC')::date::text as utc_day
        from measurement.public_events e join measurement.consents consent on consent.portfolio_id = e.portfolio_id
          and consent.subject = e.measurement_subject and consent.state <> 'granted'
        where e.portfolio_id = ${input.portfolioId}::uuid
        order by e.accepted_at, e.event_id limit ${input.batchSize} for update of consent
      ) select row_id, utc_day from page`.execute(db)
    : await sql<RemovedDetail>`with page as materialized (
        select e.ctid::text as row_id, (e.effective_at at time zone 'UTC')::date::text as utc_day
        from measurement.public_events e where e.portfolio_id = ${input.portfolioId}::uuid
          and e.accepted_at <= ${cutoff}::timestamptz
        order by e.accepted_at, e.event_id limit ${input.batchSize}
      ) select row_id, utc_day from page`.execute(db);
  const incomplete = await sealDays(db, input.portfolioId, selected.rows.map(row => row.utc_day), input.now);
  if (selected.rows.length) await sql`delete from measurement.public_events
    where portfolio_id = ${input.portfolioId}::uuid and ctid = any(${selected.rows.map(row => row.row_id)}::tid[])`.execute(db);
  return { count: selected.rows.length, incomplete };
}

async function processStage(db: ReturnType<typeof resolvePostgresTransaction>, input: MeasurementRetentionBatch,
  stage: string): Promise<{ count: number; incomplete: boolean }> {
  if (stage === "contributions") return selectAndDeleteContributions(db, input, input.kind === "withdrawal");
  if (stage === "events") return deleteExpiredEvents(db, input, input.kind === "withdrawal");
  if (stage === "rebuilds") {
    const cutoff = asCutoff(input.now);
    const withdrawn = input.kind === "withdrawal";
    const result = withdrawn
      ? await sql`with page as materialized (
          select r.ctid from measurement.goal_conversion_rebuilds r
          join measurement.consents consent on consent.portfolio_id = r.portfolio_id
            and consent.subject = r.measurement_subject and consent.state <> 'granted'
          where r.portfolio_id = ${input.portfolioId}::uuid
            and not exists (select 1 from measurement.public_events e where e.portfolio_id = r.portfolio_id
              and e.measurement_subject = r.measurement_subject)
          order by r.trigger_accepted_at, r.measurement_subject limit ${input.batchSize} for update of r, consent
        ) delete from measurement.goal_conversion_rebuilds r using page where r.ctid = page.ctid`.execute(db)
      : await sql`with page as materialized (
          select r.ctid from measurement.goal_conversion_rebuilds r
          where r.portfolio_id = ${input.portfolioId}::uuid and r.trigger_accepted_at <= ${cutoff}::timestamptz
            and not exists (select 1 from measurement.public_events e where e.portfolio_id = r.portfolio_id
              and e.measurement_subject = r.measurement_subject and e.accepted_at > ${cutoff}::timestamptz)
          order by r.trigger_accepted_at, r.measurement_subject limit ${input.batchSize} for update of r
        ) delete from measurement.goal_conversion_rebuilds r using page where r.ctid = page.ctid`.execute(db);
    return { count: numeric(result.numAffectedRows ?? 0n), incomplete: false };
  }
  if (stage === "consent-history") {
    const cutoff = asCutoff(input.now);
    const result = await sql`with page as materialized (
        select h.ctid from measurement.consent_history h join measurement.consents c
          on c.portfolio_id = h.portfolio_id and c.consent_id = h.consent_id
        where h.portfolio_id = ${input.portfolioId}::uuid and c.evidence_expires_at <= ${input.now}::timestamptz
          and (c.subject is null or not exists (select 1 from measurement.public_events e where e.portfolio_id = c.portfolio_id
            and e.measurement_subject = c.subject))
          and (c.subject is null or not exists (select 1 from measurement.goal_conversion_rebuilds r where r.portfolio_id = c.portfolio_id
            and r.measurement_subject = c.subject))
        order by h.consent_id, h.revision limit ${input.batchSize} for update of c
      ) delete from measurement.consent_history h using page where h.ctid = page.ctid`.execute(db);
    return { count: numeric(result.numAffectedRows ?? 0n), incomplete: false };
  }
  if (stage === "consents") {
    const result = await sql`with page as materialized (
        select c.ctid from measurement.consents c where c.portfolio_id = ${input.portfolioId}::uuid
          and c.evidence_expires_at <= ${input.now}::timestamptz
          and not exists (select 1 from measurement.public_events e where e.portfolio_id = c.portfolio_id and e.measurement_subject = c.subject)
          and not exists (select 1 from measurement.goal_conversion_rebuilds r where r.portfolio_id = c.portfolio_id and r.measurement_subject = c.subject)
          and not exists (select 1 from measurement.consent_history h where h.portfolio_id = c.portfolio_id and h.consent_id = c.consent_id)
        order by c.evidence_expires_at, c.consent_id limit ${input.batchSize} for update of c
      ) delete from measurement.consents c using page where c.ctid = page.ctid`.execute(db);
    return { count: numeric(result.numAffectedRows ?? 0n), incomplete: false };
  }
  if (input.kind === "aggregates" && stage === "aggregates") {
    const expiry = sql`((a.utc_day::timestamp at time zone 'UTC') + interval '13 months') <= ${input.now}::timestamptz`;
    const result = await sql`with page as materialized (
        select a.ctid from measurement.daily_aggregates a where a.portfolio_id = ${input.portfolioId}::uuid and ${expiry}
        order by a.utc_day, a.metric_kind, a.metric_key limit ${input.batchSize} for update of a
      ) delete from measurement.daily_aggregates a using page where a.ctid = page.ctid`.execute(db);
    return { count: numeric(result.numAffectedRows ?? 0n), incomplete: false };
  }
  if (input.kind === "aggregates" && stage === "checkpoints") {
    const result = await sql`with page as materialized (
        select c.ctid from measurement.daily_aggregate_checkpoints c where c.portfolio_id = ${input.portfolioId}::uuid
          and ((c.utc_day::timestamp at time zone 'UTC') + interval '13 months') <= ${input.now}::timestamptz
          and not exists (select 1 from measurement.daily_aggregates a where a.portfolio_id = c.portfolio_id and a.utc_day = c.utc_day)
        order by c.utc_day limit ${input.batchSize} for update of c
      ) delete from measurement.daily_aggregate_checkpoints c using page where c.ctid = page.ctid`.execute(db);
    return { count: numeric(result.numAffectedRows ?? 0n), incomplete: false };
  }
  return { count: 0, incomplete: false };
}

export function createPostgresMeasurementRetentionRepository(): MeasurementRetentionRepositoryPort {
  return {
    async processBatch(input, transaction): Promise<BoundedWorkResult> {
      const db = await configure(transaction, input.portfolioId);
      const firstStage = retentionStages(input.kind)[0]!;
      await sql`select measurement.begin_retention_checkpoint(${input.portfolioId}::uuid, ${input.jobId}::uuid,
        ${input.kind}, ${input.now}::timestamptz, ${firstStage})`.execute(db);
      const result = await sql<RetentionCheckpoint>`select stage, requested_at, incomplete from measurement.retention_checkpoints
        where portfolio_id = ${input.portfolioId}::uuid and job_id = ${input.jobId}::uuid and work_kind = ${input.kind} for update`.execute(db);
      const checkpoint = result.rows[0];
      if (!checkpoint || instant(checkpoint.requested_at) !== input.now) throw new Error("MEASUREMENT_RETENTION_CHECKPOINT_MISMATCH");
      const stages = retentionStages(input.kind);
      const stageIndex = stages.indexOf(checkpoint.stage);
      if (stageIndex < 0) throw new Error("MEASUREMENT_RETENTION_STAGE_INVALID");
      const batch = await processStage(db, input, checkpoint.stage);
      const incomplete = checkpoint.incomplete || batch.incomplete;
      const nextStage = batch.count < input.batchSize ? stages[stageIndex + 1] : checkpoint.stage;
      if (!nextStage) {
        await sql`delete from measurement.retention_checkpoints where portfolio_id = ${input.portfolioId}::uuid
          and job_id = ${input.jobId}::uuid and work_kind = ${input.kind}`.execute(db);
        return { processedCount: batch.count, nextCursor: null, incomplete };
      }
      await sql`update measurement.retention_checkpoints set stage = ${nextStage}, incomplete = ${incomplete}, updated_at = ${input.now}::timestamptz
        where portfolio_id = ${input.portfolioId}::uuid and job_id = ${input.jobId}::uuid and work_kind = ${input.kind}`.execute(db);
      return { processedCount: batch.count, nextCursor: input.jobId, incomplete };
    },
  };
}
