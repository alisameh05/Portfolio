-- Phase 7 #201: deterministically match consented event sequences to activated goal versions.
-- Rollback: stop conversion work and retain the conversion history for later replay.
-- Corrections use a forward-only migration.

set lock_timeout = '5s';

grant usage on schema measurement to shipwithali_worker;
grant shipwithali_migration to current_user;
set role shipwithali_migration;

create table measurement.goal_conversion_rebuilds (
  portfolio_id uuid not null,
  measurement_subject uuid not null
    check (measurement_subject::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  generation bigint not null check (generation >= 1),
  completed_generation bigint not null default 0 check (completed_generation >= 0 and completed_generation <= generation),
  trigger_event_id uuid not null,
  trigger_accepted_at timestamptz not null,
  cursor_effective_at timestamptz,
  cursor_accepted_at timestamptz,
  cursor_event_id uuid,
  progress jsonb not null check (jsonb_typeof(progress) = 'object'),
  completed boolean not null default false,
  updated_at timestamptz not null,
  primary key (portfolio_id, measurement_subject),
  check ((cursor_effective_at is null and cursor_accepted_at is null and cursor_event_id is null) or
    (cursor_effective_at is not null and cursor_accepted_at is not null and cursor_event_id is not null))
);

create table measurement.goal_conversion_contributions (
  portfolio_id uuid not null,
  measurement_subject uuid not null
    check (measurement_subject::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  goal_id uuid not null,
  version_id uuid not null,
  terminal_event_id uuid not null references measurement.public_events(event_id) on delete cascade,
  converted_at timestamptz not null,
  accepted_at timestamptz not null,
  consent_revision integer not null check (consent_revision >= 1),
  activation_sequence bigint not null check (activation_sequence >= 1),
  generation bigint not null check (generation >= 1),
  primary key (portfolio_id, measurement_subject, goal_id, version_id, terminal_event_id, generation),
  foreign key (portfolio_id, goal_id, version_id)
    references measurement.analytics_goal_versions (portfolio_id, goal_id, version_id) on delete cascade
);

create index goal_conversion_contributions_retention
  on measurement.goal_conversion_contributions (portfolio_id, accepted_at, measurement_subject);
create index goal_conversion_rebuilds_retention
  on measurement.goal_conversion_rebuilds (portfolio_id, trigger_accepted_at);
create index goal_conversion_contributions_subject_generation
  on measurement.goal_conversion_contributions (portfolio_id, measurement_subject, generation, goal_id, version_id);
create index public_events_goal_conversion_order
  on measurement.public_events (portfolio_id, measurement_subject, effective_at, accepted_at, event_id);

alter table measurement.goal_conversion_rebuilds enable row level security;
alter table measurement.goal_conversion_rebuilds force row level security;
alter table measurement.goal_conversion_contributions enable row level security;
alter table measurement.goal_conversion_contributions force row level security;

revoke all on measurement.goal_conversion_rebuilds, measurement.goal_conversion_contributions from public, anon,
  authenticated, shipwithali_application, shipwithali_worker, shipwithali_backup;
grant select on measurement.consents, measurement.consent_history, measurement.analytics_goal_versions,
  measurement.analytics_goal_activation_history to shipwithali_worker;
grant select, insert, update, delete on measurement.goal_conversion_rebuilds to shipwithali_worker;
grant select, insert, delete on measurement.goal_conversion_contributions to shipwithali_worker;

create policy goal_conversion_rebuild_worker on measurement.goal_conversion_rebuilds
  for all to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid)
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy goal_conversion_contribution_worker on measurement.goal_conversion_contributions
  for all to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid)
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy goal_conversion_consent_worker_read on measurement.consents
  for select to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy goal_conversion_consent_history_worker_read on measurement.consent_history
  for select to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy goal_conversion_versions_worker_read on measurement.analytics_goal_versions
  for select to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy goal_conversion_activations_worker_read on measurement.analytics_goal_activation_history
  for select to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);

comment on table measurement.goal_conversion_rebuilds is
  'Bounded per-subject chronological checkpoints. Generation swaps publish only fully recomputed conversions.';
comment on table measurement.goal_conversion_contributions is
  'Purpose-limited, retention-bounded goal contributions. Only the completed subject generation is reportable.';
comment on column measurement.goal_conversion_contributions.accepted_at is
  'Anchored to the first matched event so retention cannot outlive the earliest source detail.';

reset role;
