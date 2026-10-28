-- Phase 8 #248: keep policy-period deduplication and completion coverage on the
-- existing Operations job queue. Nullable schedule metadata leaves existing
-- producers and consumers compatible during an application rollback.
-- Rollback: roll back the application first; retain nullable metadata,
-- progress rows, and indexes so durable scheduled jobs remain identifiable.
-- Forward fix: add a follow-up migration; do not rewrite or delete job history.
set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table operations.jobs
  add column semantic_scope_id uuid,
  add column semantic_period text,
  add column work_incomplete boolean default false,
  add constraint jobs_semantic_schedule_pair_check check (
    (semantic_scope_id is null and semantic_period is null)
    or (semantic_scope_id is not null and semantic_period ~ '^\d{4}-\d{2}-\d{2}(:\d{4}-\d{2}-\d{2})?$')
  );

create unique index jobs_semantic_schedule_once
  on operations.jobs (semantic_scope_id, job_type, semantic_period)
  where semantic_scope_id is not null;

create index jobs_policy_period_status_idx
  on operations.jobs (semantic_scope_id, semantic_period, job_type)
  include (status, work_incomplete)
  where semantic_scope_id is not null and job_type in (
    'measurement.daily-aggregate.v1',
    'measurement.detail-retention.v1',
    'measurement.aggregate-retention.v1',
    'measurement.withdrawal-cleanup.v1',
    'interaction.feedback-retention.v1'
  );

-- One bounded row per Portfolio keeps the schedule and contiguous completion
-- watermarks independent of the recent job-detail window. Aggregation admission
-- remains closed until retention has caught up through the latest requested day.
create table operations.phase7_schedule_progress (
  portfolio_id uuid primary key,
  first_policy_period date not null,
  required_through_period date not null,
  retention_scheduled_through date not null,
  retention_complete_through date not null,
  aggregate_scheduled_through date not null,
  aggregate_finished_through date not null,
  last_complete_period date not null,
  phase text not null default 'retention',
  updated_at timestamptz not null default clock_timestamp(),
  constraint phase7_schedule_progress_phase_check check (phase in ('retention', 'aggregate')),
  constraint phase7_schedule_progress_bounds_check check (
    required_through_period >= first_policy_period - 1
    and retention_scheduled_through >= first_policy_period - 1
    and retention_complete_through >= first_policy_period - 1
    and aggregate_scheduled_through >= first_policy_period - 1
    and aggregate_finished_through >= first_policy_period - 1
    and last_complete_period >= first_policy_period - 1
    and retention_complete_through <= retention_scheduled_through
    and aggregate_scheduled_through <= retention_complete_through
    and aggregate_finished_through <= aggregate_scheduled_through
    and aggregate_finished_through <= retention_complete_through
    and last_complete_period <= aggregate_finished_through
    and last_complete_period <= aggregate_scheduled_through
    and last_complete_period <= retention_complete_through
  )
);

alter table operations.phase7_schedule_progress enable row level security;
alter table operations.phase7_schedule_progress force row level security;
grant select, insert, update on operations.phase7_schedule_progress to shipwithali_worker;
grant select on operations.phase7_schedule_progress to shipwithali_backup;

create policy phase7_schedule_progress_worker_select on operations.phase7_schedule_progress
  for select to shipwithali_worker using (true);
create policy phase7_schedule_progress_worker_insert on operations.phase7_schedule_progress
  for insert to shipwithali_worker with check (true);
create policy phase7_schedule_progress_worker_update on operations.phase7_schedule_progress
  for update to shipwithali_worker using (true) with check (true);
create policy operations_backup_policy_phase7_schedule_progress on operations.phase7_schedule_progress
  for select to shipwithali_backup using (true);

revoke all on operations.phase7_schedule_progress
  from public, anon, authenticated, shipwithali_application;

reset role;
