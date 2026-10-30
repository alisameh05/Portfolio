import { CompiledQuery, sql, type Kysely, type RawBuilder } from "kysely";
import { parseStableId } from "@shared/domain";
import type { DB } from "../../../shared/adapters/postgres/database.generated.js";
import { PostgresInfrastructureError } from "../../../shared/adapters/postgres/runtime.js";
import type {
  BoundedCount,
  OperationsSummaryQuery,
  OperationsSummaryReaderPort,
  OperationsSummarySnapshot,
} from "../application/operations-observability.js";

const SUMMARY_SAMPLE_LIMIT = 1_000;
const SUMMARY_SAMPLE_SIZE = SUMMARY_SAMPLE_LIMIT;

interface SummaryRow {
  observed_at: Date | string;
  eligible_outbox_count: number | string;
  eligible_outbox_candidates: number | string;
  eligible_outbox_capped: boolean;
  eligible_outbox_oldest_known: boolean;
  eligible_outbox_oldest_age_seconds: number | string | null;
  delayed_outbox_count: number | string;
  retry_outbox_count: number | string;
  dead_outbox_count: number | string;
  active_outbox_lease_count: number | string;
  expired_outbox_lease_count: number | string;
  available_job_count: number | string;
  leased_job_count: number | string;
  active_job_lease_count: number | string;
  dead_job_count: number | string;
  expired_job_lease_count: number | string;
  lease_age_seconds: number | string | null;
  lease_age_unknown: boolean;
  export_requested_count: number | string;
  export_building_count: number | string;
  export_ready_count: number | string;
  export_failed_count: number | string;
  export_expired_count: number | string;
  export_completed_build_count: number | string;
  export_max_build_duration_ms: number | string | null;
  export_verified_artifact_count: number | string;
  export_artifact_bytes: number | string | null;
  export_capped: boolean;
  relational_backup_watermark_age_hours: number | string | null;
  object_backup_watermark_age_hours: number | string | null;
  object_backup_count: number | string | null;
  object_backup_bytes: number | string | null;
  object_backup_state: "complete" | "incomplete" | "failed" | null;
  policy_progress_found: boolean;
  first_policy_period: string | null;
  required_through_period: string | null;
  retention_complete_through: string | null;
  aggregate_finished_through: string | null;
  last_complete_period: string | null;
  phase: "retention" | "aggregate" | null;
}

/** The exact bounded query builder is exported for the focused EXPLAIN gate. */
export function buildOperationsSummaryQuery(query: OperationsSummaryQuery): RawBuilder<SummaryRow> {
  return sql<SummaryRow>`
    with
      args as (
        select ${query.portfolioId}::uuid as portfolio_id,
               ${query.observedAt}::timestamptz as observed_at
      ),
      pending_outbox_candidates as materialized (
        select event.event_id, event.occurred_at, event.available_at,
               event.attempt_count, event.lease_expires_at
          from operations.outbox_events event cross join args
         where event.completed_at is null and event.dead_at is null
         order by event.occurred_at, event.event_id
         limit ${SUMMARY_SAMPLE_SIZE + 1}
      ),
      eligible_outbox as materialized (
        select event.occurred_at, event.attempt_count, event.lease_expires_at
          from pending_outbox_candidates event cross join args
         where event.available_at <= args.observed_at
         order by event.occurred_at, event.event_id
         limit ${SUMMARY_SAMPLE_SIZE}
      ),
      retry_outbox as materialized (
        select event.event_id from operations.outbox_events event
         where event.completed_at is null and event.dead_at is null and event.attempt_count > 0
         order by event.available_at, event.occurred_at, event.event_id
         limit ${SUMMARY_SAMPLE_SIZE}
      ),
      delayed_outbox as materialized (
        select event.event_id from operations.outbox_events event
         where event.completed_at is null and event.dead_at is null
           and event.available_at > ${query.observedAt}::timestamptz
         order by event.available_at, event.event_id
         limit ${SUMMARY_SAMPLE_SIZE}
      ),
      dead_outbox as materialized (
        select event.event_id from operations.outbox_events event
         where event.dead_at is not null
         order by event.dead_at, event.event_id
         limit ${SUMMARY_SAMPLE_SIZE}
      ),
      active_outbox_leases as materialized (
        select event.event_id from operations.outbox_events event cross join args
         where event.completed_at is null and event.dead_at is null
           and event.lease_expires_at > args.observed_at
         order by event.lease_expires_at, event.event_id
         limit ${SUMMARY_SAMPLE_SIZE}
      ),
      expired_outbox_leases as materialized (
        select event.event_id from operations.outbox_events event cross join args
         where event.completed_at is null and event.dead_at is null
           and event.lease_expires_at <= args.observed_at
         order by event.lease_expires_at, event.event_id
         limit ${SUMMARY_SAMPLE_SIZE}
      ),
      available_jobs as materialized (
        select job.job_id from operations.jobs job
         where job.status = 'available'
         order by job.available_at, job.job_id
         limit ${SUMMARY_SAMPLE_SIZE}
      ),
      leased_jobs as materialized (
        select job.job_id, job.lease_expires_at from operations.jobs job
         where job.status = 'leased'
         order by job.lease_expires_at, job.job_id
         limit ${SUMMARY_SAMPLE_SIZE}
      ),
      active_job_leases as materialized (
        select job.job_id from operations.jobs job cross join args
         where job.status = 'leased' and job.lease_expires_at > args.observed_at
         order by job.lease_expires_at, job.job_id
         limit ${SUMMARY_SAMPLE_SIZE}
      ),
      dead_jobs as materialized (
        select job.job_id from operations.jobs job
         where job.status = 'dead'
         order by job.available_at, job.job_id
         limit ${SUMMARY_SAMPLE_SIZE}
      ),
      expired_job_leases as materialized (
        select job.job_id from operations.jobs job cross join args
         where job.status = 'leased' and job.lease_expires_at <= args.observed_at
         order by job.lease_expires_at, job.job_id
         limit ${SUMMARY_SAMPLE_SIZE}
      ),
      active_outbox_lease_age as materialized (
        select event.lease_acquired_at
          from operations.outbox_events event cross join args
         where event.completed_at is null and event.dead_at is null
           and event.lease_expires_at > args.observed_at
         order by event.lease_expires_at, event.event_id
         limit ${SUMMARY_SAMPLE_SIZE + 1}
      ),
      active_job_lease_age as materialized (
        select job.lease_acquired_at
          from operations.jobs job cross join args
         where job.status = 'leased' and job.lease_expires_at > args.observed_at
         order by job.lease_expires_at, job.job_id
         limit ${SUMMARY_SAMPLE_SIZE + 1}
      ),
      lease_age_excess as materialized (
        select (select count(*) from active_outbox_lease_age) > ${SUMMARY_SAMPLE_LIMIT}
            or (select count(*) from active_job_lease_age) > ${SUMMARY_SAMPLE_LIMIT} as capped
      ),
      lease_age_missing as materialized (
        select exists (select 1 from active_outbox_lease_age where lease_acquired_at is null)
            or exists (select 1 from active_job_lease_age where lease_acquired_at is null) as missing
      ),
      export_requested as materialized (
        select export.export_id from portability.owner_exports export
         where export.portfolio_id = ${query.portfolioId}::uuid and export.status = 'requested'
           and export.requested_at <= ${query.observedAt}::timestamptz
         order by export.requested_at desc, export.export_id desc
         limit ${SUMMARY_SAMPLE_SIZE}
      ),
      export_building as materialized (
        select export.export_id from portability.owner_exports export
         where export.portfolio_id = ${query.portfolioId}::uuid and export.status = 'building'
           and export.requested_at <= ${query.observedAt}::timestamptz
         order by export.requested_at desc, export.export_id desc
         limit ${SUMMARY_SAMPLE_SIZE}
      ),
      export_ready as materialized (
        select export.started_at, export.completed_at, export.artifact_content_length
          from portability.owner_exports export cross join args
         where export.portfolio_id = args.portfolio_id and export.status = 'ready'
           and export.completed_at <= args.observed_at
           and export.completed_at >= args.observed_at - interval '24 hours'
         order by export.completed_at desc, export.export_id desc
         limit ${SUMMARY_SAMPLE_SIZE}
      ),
      export_failed as materialized (
        select export.export_id from portability.owner_exports export cross join args
         where export.portfolio_id = args.portfolio_id and export.status = 'failed'
           and export.failed_at <= args.observed_at
           and export.failed_at >= args.observed_at - interval '24 hours'
         order by export.failed_at desc, export.export_id desc
         limit ${SUMMARY_SAMPLE_SIZE}
      ),
      export_expired as materialized (
        select export.export_id from portability.owner_exports export cross join args
         where export.portfolio_id = args.portfolio_id and export.status = 'expired'
           and export.expired_at <= args.observed_at
           and export.expired_at >= args.observed_at - interval '24 hours'
         order by export.expired_at desc, export.export_id desc
         limit ${SUMMARY_SAMPLE_SIZE}
      ),
      policy_progress as materialized (
        select to_char(progress.first_policy_period, 'YYYY-MM-DD') as first_policy_period,
               to_char(progress.required_through_period, 'YYYY-MM-DD') as required_through_period,
               to_char(progress.retention_complete_through, 'YYYY-MM-DD') as retention_complete_through,
               to_char(progress.aggregate_finished_through, 'YYYY-MM-DD') as aggregate_finished_through,
               to_char(progress.last_complete_period, 'YYYY-MM-DD') as last_complete_period,
               progress.phase
          from operations.phase7_schedule_progress progress cross join args
         where progress.portfolio_id = args.portfolio_id
         limit 1
      )
    select
      args.observed_at as observed_at,
      (select count(*) from eligible_outbox) as eligible_outbox_count,
      (select count(*) from pending_outbox_candidates) as eligible_outbox_candidates,
      (select count(*) from pending_outbox_candidates) > ${SUMMARY_SAMPLE_LIMIT} as eligible_outbox_capped,
      ((select count(*) from pending_outbox_candidates) <= ${SUMMARY_SAMPLE_LIMIT}
        or exists(select 1 from eligible_outbox)) as eligible_outbox_oldest_known,
      (select case when min(occurred_at) is null then null
                   else greatest(0, extract(epoch from (max(args.observed_at) - min(occurred_at)))) end
         from eligible_outbox cross join args) as eligible_outbox_oldest_age_seconds,
      (select count(*) from delayed_outbox) as delayed_outbox_count,
      (select count(*) from retry_outbox) as retry_outbox_count,
      (select count(*) from dead_outbox) as dead_outbox_count,
      (select count(*) from active_outbox_leases) as active_outbox_lease_count,
      (select count(*) from expired_outbox_leases) as expired_outbox_lease_count,
      (select count(*) from available_jobs) as available_job_count,
      (select count(*) from leased_jobs) as leased_job_count,
      (select count(*) from active_job_leases) as active_job_lease_count,
      (select count(*) from dead_jobs) as dead_job_count,
      (select count(*) from expired_job_leases) as expired_job_lease_count,
      (select max(greatest(0, extract(epoch from (args.observed_at - lease_acquired_at))))
         from (select lease_acquired_at from active_outbox_lease_age
               union all select lease_acquired_at from active_job_lease_age) lease_ages
         cross join args) as lease_age_seconds,
      ((select missing from lease_age_missing) or (select capped from lease_age_excess)) as lease_age_unknown,
      (select count(*) from export_requested) as export_requested_count,
      (select count(*) from export_building) as export_building_count,
      (select count(*) from export_ready) as export_ready_count,
      (select count(*) from export_failed) as export_failed_count,
      (select count(*) from export_expired) as export_expired_count,
      (select count(*) from export_ready where completed_at is not null and started_at is not null) as export_completed_build_count,
      (select max(extract(epoch from (completed_at - started_at)) * 1000)
         from export_ready where completed_at is not null and started_at is not null) as export_max_build_duration_ms,
      (select count(*) from export_ready where completed_at is not null and started_at is not null) as export_verified_artifact_count,
      (select case when exists (select 1 from export_ready where artifact_content_length is null) then null
                   else coalesce(sum(artifact_content_length), 0) end from export_ready) as export_artifact_bytes,
      greatest(
        (select count(*) from export_requested), (select count(*) from export_building),
        (select count(*) from export_ready), (select count(*) from export_failed),
        (select count(*) from export_expired)
      ) >= ${SUMMARY_SAMPLE_LIMIT} as export_capped,
      (select case when max(copy.source_watermark_at) is null then null else greatest(0, extract(epoch from (max(args.observed_at) - max(copy.source_watermark_at))) / 3600) end
         from operations.backup_copy_metrics copy cross join args
        where copy.backup_type = 'relational'
          and copy.state = 'usable' and copy.deletion_acknowledged_at is null
          and (copy.expires_at is null or copy.expires_at > args.observed_at)) as relational_backup_watermark_age_hours,
      (select case when max(copy.source_watermark_at) is null then null else greatest(0, extract(epoch from (max(args.observed_at) - max(copy.source_watermark_at))) / 3600) end
         from operations.backup_copy_metrics copy cross join args
        where copy.backup_type = 'object' and copy.state = 'usable' and copy.deletion_acknowledged_at is null
          and (copy.expires_at is null or copy.expires_at > args.observed_at)) as object_backup_watermark_age_hours,
      (select copy.object_count from operations.backup_copy_metrics copy
        where copy.backup_type = 'object'
          and copy.state = 'usable' and copy.deletion_acknowledged_at is null
          and (copy.expires_at is null or copy.expires_at > args.observed_at)
        order by copy.committed_at desc, copy.attempted_at desc limit 1) as object_backup_count,
      (select copy.object_bytes from operations.backup_copy_metrics copy
        where copy.backup_type = 'object' and copy.state = 'usable' and copy.deletion_acknowledged_at is null
          and (copy.expires_at is null or copy.expires_at > args.observed_at)
        order by copy.attempted_at desc, copy.committed_at desc limit 1) as object_backup_bytes,
      (select case when copy.state = 'usable' then 'complete' when copy.state = 'uploading' then 'incomplete' else 'failed' end
         from operations.backup_copy_metrics copy cross join args where copy.backup_type = 'object' and copy.attempted_at <= args.observed_at
        order by copy.attempted_at desc, copy.committed_at desc limit 1) as object_backup_state,
      exists(select 1 from policy_progress) as policy_progress_found,
      (select first_policy_period from policy_progress) as first_policy_period,
      (select required_through_period from policy_progress) as required_through_period,
      (select retention_complete_through from policy_progress) as retention_complete_through,
      (select aggregate_finished_through from policy_progress) as aggregate_finished_through,
      (select last_complete_period from policy_progress) as last_complete_period,
      (select phase from policy_progress) as phase
      from args
  `;
}

export function createPostgresOperationsSummaryReader(database: Kysely<DB>): OperationsSummaryReaderPort {
  return {
    async readOperationsSummary(query: OperationsSummaryQuery): Promise<OperationsSummarySnapshot> {
      if (!parseStableId("Portfolio", query.portfolioId).ok || query.windowSeconds !== 900 ||
          query.maxRows !== SUMMARY_SAMPLE_LIMIT || !validUtcInstant(query.observedAt)) {
        throw new PostgresInfrastructureError();
      }
      try {
          const result = await database.transaction().execute(async (transaction) => {
            await sql`set local lock_timeout = '250ms'`.execute(transaction);
            await sql`set local statement_timeout = '2s'`.execute(transaction);
            return buildOperationsSummaryQuery(query).execute(transaction);
          });
        const row = result.rows[0];
        if (!row) throw new PostgresInfrastructureError();
        const observedAt = toIso(row.observed_at);
        const stateCount = (value: number | string): BoundedCount => boundedCount(value, SUMMARY_SAMPLE_LIMIT);
        const progress = row.policy_progress_found && row.first_policy_period !== null &&
          row.required_through_period !== null && row.retention_complete_through !== null &&
          row.aggregate_finished_through !== null && row.last_complete_period !== null && row.phase !== null
          ? {
              firstPolicyPeriod: row.first_policy_period,
              requiredThroughPeriod: row.required_through_period,
              retentionCompleteThrough: row.retention_complete_through,
              aggregateFinishedThrough: row.aggregate_finished_through,
              lastCompletePeriod: row.last_complete_period,
              phase: row.phase,
            }
          : null;
        const exportSampleCount = [row.export_requested_count, row.export_building_count, row.export_ready_count,
          row.export_failed_count, row.export_expired_count].reduce<number>((sum, count) => sum + countValue(count), 0);
        return {
          observedAt,
          outbox: {
            eligibleDepth: { ...boundedCount(row.eligible_outbox_count, SUMMARY_SAMPLE_LIMIT),
              capped: row.eligible_outbox_capped || countValue(row.eligible_outbox_count) >= SUMMARY_SAMPLE_LIMIT },
            oldestEligibleAgeSeconds: row.eligible_outbox_oldest_age_seconds === null
              ? null : finiteNumber(row.eligible_outbox_oldest_age_seconds),
            eligibleOldestKnown: row.eligible_outbox_oldest_known,
            futureDelayedDepth: stateCount(row.delayed_outbox_count),
            retryDepth: stateCount(row.retry_outbox_count),
            deadDepth: stateCount(row.dead_outbox_count),
            activeLeaseDepth: stateCount(row.active_outbox_lease_count),
            expiredLeaseDepth: stateCount(row.expired_outbox_lease_count),
          },
          jobs: {
            availableDepth: stateCount(row.available_job_count),
            leasedDepth: stateCount(row.leased_job_count),
            activeLeaseDepth: stateCount(row.active_job_lease_count),
            deadDepth: stateCount(row.dead_job_count),
            expiredLeaseDepth: stateCount(row.expired_job_lease_count),
          },
          leases: {
            ageSeconds: row.lease_age_seconds === null ? null : finiteNumber(row.lease_age_seconds),
            ageKnown: !row.lease_age_unknown,
          },
          exports: {
            windowSeconds: 86_400,
            states: {
              requested: stateCount(row.export_requested_count),
              building: stateCount(row.export_building_count),
              ready: stateCount(row.export_ready_count),
              failed: stateCount(row.export_failed_count),
              expired: stateCount(row.export_expired_count),
            },
            completedBuilds: boundedCount(row.export_completed_build_count, SUMMARY_SAMPLE_LIMIT).value,
            maxBuildDurationMs: row.export_max_build_duration_ms === null ? null : finiteNumber(row.export_max_build_duration_ms),
            verifiedArtifacts: boundedCount(row.export_verified_artifact_count, SUMMARY_SAMPLE_LIMIT).value,
            artifactBytes: row.export_artifact_bytes === null ? null : finiteNumber(row.export_artifact_bytes),
            sampleCount: exportSampleCount,
            capped: row.export_capped,
          },
          backup: {
            relationalSourceWatermarkAgeHours: row.relational_backup_watermark_age_hours === null ? null : finiteNumber(row.relational_backup_watermark_age_hours),
            objectSourceWatermarkAgeHours: row.object_backup_watermark_age_hours === null ? null : finiteNumber(row.object_backup_watermark_age_hours),
            objectCount: row.object_backup_count === null ? null : boundedCount(row.object_backup_count, SUMMARY_SAMPLE_LIMIT),
            objectBytes: row.object_backup_bytes === null ? null : finiteNumber(row.object_backup_bytes),
            state: row.object_backup_state,
          },
          policyProgress: progress,
        };
      } catch {
        throw new PostgresInfrastructureError();
      }
    },
  };
}

export async function explainOperationsSummaryQuery(database: Kysely<DB>, query: OperationsSummaryQuery): Promise<unknown> {
  const compiled = buildOperationsSummaryQuery(query).compile(database);
  const explained = await database.executeQuery(CompiledQuery.raw(`explain (analyze, buffers, format json) ${compiled.sql}`, [...compiled.parameters]));
  const first = explained.rows[0] as Record<string, unknown> | undefined;
  return first?.["QUERY PLAN"];
}

function boundedCount(value: number | string, limit: number): BoundedCount {
  const parsed = countValue(value);
  return { value: Math.min(parsed, limit), capped: parsed >= limit, sampleLimit: limit };
}

function countValue(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new PostgresInfrastructureError();
  return parsed;
}

function finiteNumber(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new PostgresInfrastructureError();
  return parsed;
}

function toIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new PostgresInfrastructureError();
  return date.toISOString();
}

function validUtcInstant(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
