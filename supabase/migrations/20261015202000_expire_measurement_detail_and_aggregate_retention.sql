-- Phase 7 #204: bounded Measurement-owned retention and withdrawal cleanup.
-- Rollback stops cleanup; it never restores deleted detail.
set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table measurement.daily_aggregate_checkpoints
  add column retention_sealed boolean not null default false;

create function measurement.prevent_sealed_aggregate_checkpoint_rewrite()
returns trigger
language plpgsql
set search_path = pg_catalog, measurement
as $function$
begin
  if old.retention_sealed and (not new.retention_sealed or (old.incomplete and not new.incomplete)
    or old.source_event_count is distinct from new.source_event_count
    or old.source_conversion_count is distinct from new.source_conversion_count
    or old.policy_version is distinct from new.policy_version
    or old.checkpoint_at is distinct from new.checkpoint_at) then
    raise exception 'sealed aggregate checkpoint is immutable' using errcode = '42501';
  end if;
  return new;
end
$function$;
revoke all on function measurement.prevent_sealed_aggregate_checkpoint_rewrite()
  from public, anon, authenticated, shipwithali_application, shipwithali_backup;
create trigger daily_aggregate_checkpoint_seal_guard
  before update on measurement.daily_aggregate_checkpoints
  for each row execute function measurement.prevent_sealed_aggregate_checkpoint_rewrite();

create function measurement.seal_daily_aggregate_checkpoint(
  target_portfolio uuid, target_day date, mark_incomplete boolean, sealed_at timestamptz
) returns void
language plpgsql
security definer
set search_path = pg_catalog, measurement
as $function$
begin
  if target_portfolio is distinct from nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid then
    raise exception 'retention Portfolio scope mismatch' using errcode = '42501';
  end if;
  if sealed_at > statement_timestamp() then
    raise exception 'aggregate seal cannot be future dated' using errcode = '22023';
  end if;
  update measurement.daily_aggregate_checkpoints
    set retention_sealed = true, incomplete = measurement.daily_aggregate_checkpoints.incomplete or mark_incomplete,
        checkpoint_at = case when measurement.daily_aggregate_checkpoints.retention_sealed
          then measurement.daily_aggregate_checkpoints.checkpoint_at else greatest(checkpoint_at, sealed_at) end
    where portfolio_id = target_portfolio and utc_day = target_day;
end
$function$;
revoke all on function measurement.seal_daily_aggregate_checkpoint(uuid, date, boolean, timestamptz)
  from public, anon, authenticated, shipwithali_application, shipwithali_backup;
grant execute on function measurement.seal_daily_aggregate_checkpoint(uuid, date, boolean, timestamptz)
  to shipwithali_worker;

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

create function measurement.begin_retention_checkpoint(
  requested_portfolio uuid, requested_job uuid, requested_kind text, requested_at timestamptz, initial_stage text
) returns void
language plpgsql
security definer
set search_path = pg_catalog, measurement
as $function$
begin
  if requested_portfolio is distinct from nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid then
    raise exception 'retention Portfolio scope mismatch' using errcode = '42501';
  end if;
  if requested_at > statement_timestamp() then
    raise exception 'retention checkpoint cannot be future dated' using errcode = '22023';
  end if;
  insert into measurement.retention_checkpoints
    (portfolio_id, job_id, work_kind, requested_at, stage, updated_at)
    values (requested_portfolio, requested_job, requested_kind, requested_at, initial_stage, requested_at)
    on conflict (portfolio_id, job_id, work_kind) do nothing;
end
$function$;
revoke all on function measurement.begin_retention_checkpoint(uuid, uuid, text, timestamptz, text)
  from public, anon, authenticated, shipwithali_application, shipwithali_backup;
grant execute on function measurement.begin_retention_checkpoint(uuid, uuid, text, timestamptz, text)
  to shipwithali_worker;

alter table measurement.retention_checkpoints enable row level security;
alter table measurement.retention_checkpoints force row level security;
revoke all on measurement.retention_checkpoints from public, anon, authenticated, shipwithali_application, shipwithali_backup;
grant usage on schema measurement to shipwithali_worker;
grant select, delete on measurement.retention_checkpoints to shipwithali_worker;
grant update (stage, incomplete, updated_at) on measurement.retention_checkpoints to shipwithali_worker;
create policy retention_checkpoints_worker on measurement.retention_checkpoints
  for all to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid)
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy retention_checkpoints_migration on measurement.retention_checkpoints
  for all to shipwithali_migration
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid)
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
drop policy consent_worker_expire on measurement.consents;
create policy consent_worker_expire_checkpoint on measurement.consents
  for delete to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid
    and exists (select 1 from measurement.retention_checkpoints checkpoint
      where checkpoint.portfolio_id = consents.portfolio_id and checkpoint.work_kind = 'detail'
        and consents.evidence_expires_at <= checkpoint.requested_at)
    and not exists (select 1 from measurement.public_events event
      where event.portfolio_id = consents.portfolio_id and event.measurement_subject = consents.subject)
    and not exists (select 1 from measurement.goal_conversion_rebuilds rebuild
      where rebuild.portfolio_id = consents.portfolio_id and rebuild.measurement_subject = consents.subject)
    and not exists (select 1 from measurement.consent_history history
      where history.portfolio_id = consents.portfolio_id and history.consent_id = consents.consent_id));

grant delete on measurement.public_events, measurement.goal_conversion_rebuilds,
  measurement.goal_conversion_contributions, measurement.daily_aggregates,
  measurement.daily_aggregate_checkpoints, measurement.consent_history to shipwithali_worker;

create policy public_events_worker_delete on measurement.public_events
  for delete to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid
    and (exists (select 1 from measurement.retention_checkpoints checkpoint
      where checkpoint.portfolio_id = public_events.portfolio_id and checkpoint.work_kind = 'detail'
        and public_events.accepted_at <= checkpoint.requested_at - interval '14 days')
      or exists (select 1 from measurement.retention_checkpoints checkpoint
        join measurement.consents consent on consent.portfolio_id = checkpoint.portfolio_id
          and consent.subject = public_events.measurement_subject and consent.state <> 'granted'
        where checkpoint.portfolio_id = public_events.portfolio_id and checkpoint.work_kind = 'withdrawal')));

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
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid
    and (exists (select 1 from measurement.retention_checkpoints checkpoint
        where checkpoint.portfolio_id = goal_conversion_rebuilds.portfolio_id and checkpoint.work_kind = 'detail'
          and goal_conversion_rebuilds.trigger_accepted_at <= checkpoint.requested_at - interval '14 days'
          and not exists (select 1 from measurement.public_events event
            where event.portfolio_id = goal_conversion_rebuilds.portfolio_id
              and event.measurement_subject = goal_conversion_rebuilds.measurement_subject
              and event.accepted_at > checkpoint.requested_at - interval '14 days'))
      or exists (select 1 from measurement.retention_checkpoints checkpoint
        join measurement.consents consent on consent.portfolio_id = checkpoint.portfolio_id
          and consent.subject = goal_conversion_rebuilds.measurement_subject and consent.state <> 'granted'
        where checkpoint.portfolio_id = goal_conversion_rebuilds.portfolio_id and checkpoint.work_kind = 'withdrawal'
          and not exists (select 1 from measurement.public_events event where event.portfolio_id = goal_conversion_rebuilds.portfolio_id
            and event.measurement_subject = goal_conversion_rebuilds.measurement_subject))));

drop policy goal_conversion_contribution_worker on measurement.goal_conversion_contributions;
create policy goal_conversion_contribution_worker_read on measurement.goal_conversion_contributions
  for select to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy goal_conversion_contribution_worker_insert on measurement.goal_conversion_contributions
  for insert to shipwithali_worker
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy goal_conversion_contribution_worker_delete on measurement.goal_conversion_contributions
  for delete to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid
    and (exists (select 1 from measurement.retention_checkpoints checkpoint
        where checkpoint.portfolio_id = goal_conversion_contributions.portfolio_id and checkpoint.work_kind = 'detail'
          and (goal_conversion_contributions.accepted_at <= checkpoint.requested_at - interval '14 days'
            or exists (select 1 from measurement.public_events event where event.portfolio_id = goal_conversion_contributions.portfolio_id
              and event.event_id = goal_conversion_contributions.terminal_event_id
              and event.accepted_at <= checkpoint.requested_at - interval '14 days')))
      or exists (select 1 from measurement.retention_checkpoints checkpoint
        join measurement.consents consent on consent.portfolio_id = checkpoint.portfolio_id
          and consent.subject = goal_conversion_contributions.measurement_subject and consent.state <> 'granted'
        where checkpoint.portfolio_id = goal_conversion_contributions.portfolio_id and checkpoint.work_kind = 'withdrawal')));

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
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid
    and (exists (select 1 from measurement.daily_aggregate_checkpoints checkpoint
        where checkpoint.portfolio_id = daily_aggregates.portfolio_id and checkpoint.utc_day = daily_aggregates.utc_day
          and not checkpoint.retention_sealed)
      or exists (select 1 from measurement.retention_checkpoints checkpoint
        where checkpoint.portfolio_id = daily_aggregates.portfolio_id and checkpoint.work_kind = 'aggregates'
          and ((daily_aggregates.utc_day::timestamp at time zone 'UTC') + interval '13 months') <= checkpoint.requested_at)));

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
create policy daily_aggregate_checkpoints_migration on measurement.daily_aggregate_checkpoints
  for all to shipwithali_migration
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid)
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy daily_aggregate_checkpoints_worker_delete on measurement.daily_aggregate_checkpoints
  for delete to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid
    and exists (select 1 from measurement.retention_checkpoints checkpoint
      where checkpoint.portfolio_id = daily_aggregate_checkpoints.portfolio_id and checkpoint.work_kind = 'aggregates'
        and ((daily_aggregate_checkpoints.utc_day::timestamp at time zone 'UTC') + interval '13 months') <= checkpoint.requested_at)
    and not exists (select 1 from measurement.daily_aggregates aggregate_row
      where aggregate_row.portfolio_id = daily_aggregate_checkpoints.portfolio_id
        and aggregate_row.utc_day = daily_aggregate_checkpoints.utc_day));

drop policy daily_aggregates_worker_update on measurement.daily_aggregates;
revoke update on measurement.daily_aggregates from shipwithali_worker;

revoke update on measurement.daily_aggregate_checkpoints from shipwithali_worker;
grant update (source_event_count, source_conversion_count, policy_version, checkpoint_at, incomplete)
  on measurement.daily_aggregate_checkpoints to shipwithali_worker;

create policy consent_history_worker_delete on measurement.consent_history
  for delete to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid
    and exists (select 1 from measurement.retention_checkpoints checkpoint
      join measurement.consents consent on consent.portfolio_id = checkpoint.portfolio_id
        and consent.consent_id = consent_history.consent_id
      where checkpoint.portfolio_id = consent_history.portfolio_id and checkpoint.work_kind = 'detail'
        and consent.evidence_expires_at <= checkpoint.requested_at
        and (consent.subject is null or not exists (select 1 from measurement.public_events event
          where event.portfolio_id = consent_history.portfolio_id and event.measurement_subject = consent.subject))
        and (consent.subject is null or not exists (select 1 from measurement.goal_conversion_rebuilds rebuild
          where rebuild.portfolio_id = consent_history.portfolio_id and rebuild.measurement_subject = consent.subject))));

comment on column measurement.daily_aggregate_checkpoints.retention_sealed is
  'Set atomically before source detail expires; prevents later rebuilds from replacing retained sufficient statistics with partial data.';
comment on table measurement.retention_checkpoints is
  'Bounded idempotent Measurement retention progress. Contains no visitor subject, event payload, or content text.';

reset role;
