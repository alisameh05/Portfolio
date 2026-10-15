-- Phase 7 #204: bounded Measurement-owned retention and withdrawal cleanup.
-- Rollback stops cleanup; it never restores deleted detail.
set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table measurement.daily_aggregate_checkpoints
  add column retention_sealed boolean not null default false;

-- A dedicated no-op field gives the Worker row-lock capability without
-- granting it permission to change consent state or evidence.
alter table measurement.consents
  add column retention_lock boolean not null default false;
grant update (retention_lock) on measurement.consents to shipwithali_worker;
create policy consent_worker_retention_lock on measurement.consents
  for update to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid)
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);

create table measurement.retention_checkpoints (
  portfolio_id uuid not null,
  job_id uuid not null,
  work_kind text not null check (work_kind in ('detail', 'aggregates', 'withdrawal')),
  requested_at timestamptz not null,
  stage text not null check (stage in ('contributions', 'events', 'rebuilds', 'consent-history', 'consents', 'aggregates', 'checkpoints')),
  incomplete boolean not null default false,
  updated_at timestamptz not null,
  primary key (portfolio_id, job_id, work_kind),
  check (job_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
create index retention_checkpoints_age on measurement.retention_checkpoints (portfolio_id, updated_at, job_id);

alter table measurement.retention_checkpoints enable row level security;
alter table measurement.retention_checkpoints force row level security;
revoke all on measurement.retention_checkpoints from public, anon, authenticated, shipwithali_application, shipwithali_backup;
grant usage on schema measurement to shipwithali_worker;
grant select, insert, update, delete on measurement.retention_checkpoints to shipwithali_worker;
create policy retention_checkpoints_worker on measurement.retention_checkpoints
  for all to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid)
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy consent_worker_expire_checkpoint on measurement.consents
  for delete to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid
    and exists (select 1 from measurement.retention_checkpoints checkpoint
      where checkpoint.portfolio_id = consents.portfolio_id and checkpoint.work_kind = 'detail'
        and consents.evidence_expires_at <= checkpoint.requested_at));

grant delete on measurement.public_events, measurement.goal_conversion_rebuilds,
  measurement.goal_conversion_contributions, measurement.daily_aggregates,
  measurement.daily_aggregate_checkpoints, measurement.consent_history to shipwithali_worker;

create policy public_events_worker_delete on measurement.public_events
  for delete to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);

-- The Worker may remove only expired conversion scratch or records for a
-- subject whose current consent no longer grants Measurement.
drop policy goal_conversion_rebuild_worker on measurement.goal_conversion_rebuilds;
create policy goal_conversion_rebuild_worker_read on measurement.goal_conversion_rebuilds
  for select to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy goal_conversion_rebuild_worker_insert on measurement.goal_conversion_rebuilds
  for insert to shipwithali_worker
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy goal_conversion_rebuild_worker_update on measurement.goal_conversion_rebuilds
  for update to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid)
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy goal_conversion_rebuild_worker_delete on measurement.goal_conversion_rebuilds
  for delete to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);

drop policy goal_conversion_contribution_worker on measurement.goal_conversion_contributions;
create policy goal_conversion_contribution_worker_read on measurement.goal_conversion_contributions
  for select to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy goal_conversion_contribution_worker_insert on measurement.goal_conversion_contributions
  for insert to shipwithali_worker
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy goal_conversion_contribution_worker_delete on measurement.goal_conversion_contributions
  for delete to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);

drop policy daily_aggregates_worker on measurement.daily_aggregates;
create policy daily_aggregates_worker_read on measurement.daily_aggregates
  for select to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy daily_aggregates_worker_insert on measurement.daily_aggregates
  for insert to shipwithali_worker
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy daily_aggregates_worker_update on measurement.daily_aggregates
  for update to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid)
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy daily_aggregates_worker_delete on measurement.daily_aggregates
  for delete to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);

drop policy daily_aggregate_checkpoints_worker on measurement.daily_aggregate_checkpoints;
create policy daily_aggregate_checkpoints_worker_read on measurement.daily_aggregate_checkpoints
  for select to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy daily_aggregate_checkpoints_worker_insert on measurement.daily_aggregate_checkpoints
  for insert to shipwithali_worker
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy daily_aggregate_checkpoints_worker_update on measurement.daily_aggregate_checkpoints
  for update to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid)
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy daily_aggregate_checkpoints_worker_delete on measurement.daily_aggregate_checkpoints
  for delete to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);

create policy consent_history_worker_delete on measurement.consent_history
  for delete to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);

comment on column measurement.daily_aggregate_checkpoints.retention_sealed is
  'Set atomically before source detail expires; prevents later rebuilds from replacing retained sufficient statistics with partial data.';
comment on table measurement.retention_checkpoints is
  'Bounded idempotent Measurement retention progress. Contains no visitor subject, event payload, or content text.';

reset role;
