-- Phase 7 #202: reproducible daily sufficient statistics and safe Owner reads.
-- Rollback: stop aggregation/report reads and retain the aggregate history.
-- Corrections use a forward-only migration.

set lock_timeout = '5s';

grant usage on schema measurement to shipwithali_application, shipwithali_worker;
grant shipwithali_migration to current_user;
set role shipwithali_migration;

create table measurement.daily_aggregates (
  portfolio_id uuid not null,
  utc_day date not null,
  metric_kind text not null check (metric_kind in ('action', 'goal')),
  metric_key text not null check (length(metric_key) between 1 and 180),
  goal_id uuid,
  goal_version_id uuid,
  dimensions jsonb not null default '{}'::jsonb check (jsonb_typeof(dimensions) = 'object' and dimensions = '{}'::jsonb),
  event_count bigint not null check (event_count > 0),
  sum_value bigint not null default 0 check (sum_value >= 0),
  observed_subjects bigint not null check (observed_subjects > 0),
  returning_subjects bigint not null default 0 check (returning_subjects >= 0 and returning_subjects <= observed_subjects),
  policy_version text not null check (policy_version = 'phase7.daily.v1'),
  checkpoint_at timestamptz not null,
  incomplete boolean not null default false,
  primary key (portfolio_id, utc_day, metric_kind, metric_key),
  check ((metric_kind = 'action' and goal_id is null and goal_version_id is null)
      or (metric_kind = 'goal' and goal_id is not null and goal_version_id is not null)),
  foreign key (portfolio_id, goal_id, goal_version_id)
    references measurement.analytics_goal_versions (portfolio_id, goal_id, version_id) on delete restrict
);

create table measurement.daily_aggregate_checkpoints (
  portfolio_id uuid not null,
  utc_day date not null,
  source_event_count bigint not null check (source_event_count >= 0),
  source_conversion_count bigint not null check (source_conversion_count >= 0),
  policy_version text not null check (policy_version = 'phase7.daily.v1'),
  checkpoint_at timestamptz not null,
  incomplete boolean not null default false,
  primary key (portfolio_id, utc_day)
);

create index daily_aggregates_report_range
  on measurement.daily_aggregates (portfolio_id, utc_day, metric_kind, metric_key);
create index public_events_daily_aggregate_order
  on measurement.public_events (portfolio_id, effective_at, accepted_at, action);
create index goal_conversion_daily_aggregate_order
  on measurement.goal_conversion_contributions (portfolio_id, converted_at, goal_id, version_id, generation);

alter table measurement.daily_aggregates enable row level security;
alter table measurement.daily_aggregates force row level security;
alter table measurement.daily_aggregate_checkpoints enable row level security;
alter table measurement.daily_aggregate_checkpoints force row level security;

revoke all on measurement.daily_aggregates, measurement.daily_aggregate_checkpoints
  from public, anon, authenticated, shipwithali_application, shipwithali_worker, shipwithali_backup;
grant select on measurement.daily_aggregates, measurement.daily_aggregate_checkpoints to shipwithali_application;
grant select, insert, update, delete on measurement.daily_aggregates to shipwithali_worker;
grant select, insert, update on measurement.daily_aggregate_checkpoints to shipwithali_worker;
grant select on measurement.daily_aggregates, measurement.daily_aggregate_checkpoints to shipwithali_backup;
grant select on measurement.public_events, measurement.goal_conversion_contributions, measurement.goal_conversion_rebuilds to shipwithali_worker;

create policy daily_aggregates_application_read on measurement.daily_aggregates
  for select to shipwithali_application
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid
    and nullif(current_setting('shipwithali.owner_id', true), '') is not null);
create policy daily_aggregates_worker on measurement.daily_aggregates
  for all to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid)
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy daily_aggregate_checkpoints_application_read on measurement.daily_aggregate_checkpoints
  for select to shipwithali_application
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid
    and nullif(current_setting('shipwithali.owner_id', true), '') is not null);
create policy daily_aggregate_checkpoints_worker on measurement.daily_aggregate_checkpoints
  for all to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid)
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);

comment on table measurement.daily_aggregates is
  'Replaceable daily sufficient statistics only; no visitor identity, arbitrary dimension combinations, or raw journey is stored.';
comment on column measurement.daily_aggregates.sum_value is
  'Metric-specific sufficient statistic: active-attention milliseconds for actions, or zero for counts and goal conversions.';
comment on table measurement.daily_aggregate_checkpoints is
  'Completed per-day recomputation watermark; absence of a requested day marks an Owner report incomplete.';

reset role;
