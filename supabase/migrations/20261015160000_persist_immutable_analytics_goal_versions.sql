-- Phase 7 #199: persist immutable Analytics goal definition history.
-- Rollback: disable the goal-version application capability and retain history.
-- Forward corrections use a new expand-compatible migration.

set lock_timeout = '5s';

grant usage on schema measurement to shipwithali_application;
grant shipwithali_migration to current_user;
set role shipwithali_migration;

create table measurement.analytics_goals (
  portfolio_id uuid not null,
  goal_id uuid not null check (goal_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  aggregate_version integer not null default 1 check (aggregate_version >= 1),
  active_version_id uuid,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (portfolio_id, goal_id)
);

create table measurement.analytics_goal_versions (
  portfolio_id uuid not null,
  goal_id uuid not null,
  version_id uuid not null check (version_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  version_number integer not null check (version_number >= 1),
  definition jsonb not null check (jsonb_typeof(definition) = 'object'),
  created_at timestamptz not null,
  primary key (portfolio_id, goal_id, version_number),
  unique (portfolio_id, goal_id, version_id),
  foreign key (portfolio_id, goal_id) references measurement.analytics_goals (portfolio_id, goal_id) on delete restrict
);

create table measurement.analytics_goal_activation_history (
  portfolio_id uuid not null,
  goal_id uuid not null,
  activation_id uuid not null check (activation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  version_id uuid not null,
  aggregate_version integer not null check (aggregate_version >= 2),
  activated_at timestamptz not null,
  primary key (portfolio_id, goal_id, activation_id),
  foreign key (portfolio_id, goal_id) references measurement.analytics_goals (portfolio_id, goal_id) on delete restrict,
  foreign key (portfolio_id, goal_id, version_id) references measurement.analytics_goal_versions (portfolio_id, goal_id, version_id) on delete restrict
);

alter table measurement.analytics_goals
  add constraint analytics_goals_active_version_fk
  foreign key (portfolio_id, goal_id, active_version_id)
  references measurement.analytics_goal_versions (portfolio_id, goal_id, version_id)
  deferrable initially deferred;

create index analytics_goal_versions_ordered
  on measurement.analytics_goal_versions (portfolio_id, goal_id, version_number);
create index analytics_goal_activation_ordered
  on measurement.analytics_goal_activation_history (portfolio_id, goal_id, aggregate_version, activation_id);

alter table measurement.analytics_goals enable row level security;
alter table measurement.analytics_goals force row level security;
alter table measurement.analytics_goal_versions enable row level security;
alter table measurement.analytics_goal_versions force row level security;
alter table measurement.analytics_goal_activation_history enable row level security;
alter table measurement.analytics_goal_activation_history force row level security;

revoke all on measurement.analytics_goals, measurement.analytics_goal_versions,
  measurement.analytics_goal_activation_history from public, anon, authenticated,
  shipwithali_application, shipwithali_worker, shipwithali_backup;
grant select, insert on measurement.analytics_goals to shipwithali_application;
grant update (aggregate_version, active_version_id) on measurement.analytics_goals to shipwithali_application;
grant select, insert on measurement.analytics_goal_versions to shipwithali_application;
grant select, insert on measurement.analytics_goal_activation_history to shipwithali_application;

create policy analytics_goals_application on measurement.analytics_goals
  for all to shipwithali_application
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid)
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy analytics_goal_versions_application_select on measurement.analytics_goal_versions
  for select to shipwithali_application
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy analytics_goal_versions_application_insert on measurement.analytics_goal_versions
  for insert to shipwithali_application
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy analytics_goal_activation_application_select on measurement.analytics_goal_activation_history
  for select to shipwithali_application
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy analytics_goal_activation_application_insert on measurement.analytics_goal_activation_history
  for insert to shipwithali_application
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);

comment on table measurement.analytics_goals is
  'Owner-scoped Analytics goal root, aggregate version, and nullable activation pointer.';
comment on table measurement.analytics_goal_versions is
  'Append-only immutable Analytics goal definition snapshots; the application role has no update or delete privilege.';
comment on table measurement.analytics_goal_activation_history is
  'Append-only activation facts; creating a definition version does not activate it.';

reset role;
