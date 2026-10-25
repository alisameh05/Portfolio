-- Phase 8 #246: purpose-limited reads of immutable goal history and retained aggregates.
-- Rollback: stop Analytics export assembly, then revoke the grants and drop the policies/function.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

create function measurement.owner_export_scope_is_valid(target_portfolio_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, portfolio_config
as $$
  select target_portfolio_id::text = nullif(current_setting('shipwithali.portfolio_id', true), '')
     and current_setting('shipwithali.worker_purpose', true) = 'measurement.owner-export'
     and exists (
       select 1 from portfolio_config.settings settings
        where settings.portfolio_id = target_portfolio_id
          and settings.owner_id::text = nullif(current_setting('shipwithali.owner_id', true), '')
     );
$$;

grant usage on schema measurement to shipwithali_worker;
grant select (portfolio_id, goal_id, aggregate_version, active_version_id)
  on measurement.analytics_goals to shipwithali_worker;
grant select (portfolio_id, goal_id, version_id, version_number, definition, created_at)
  on measurement.analytics_goal_versions to shipwithali_worker;
revoke select on measurement.analytics_goal_activation_history from shipwithali_worker;
grant select (portfolio_id, goal_id, version_id, activated_at, activation_sequence)
  on measurement.analytics_goal_activation_history to shipwithali_worker;
revoke all on function measurement.owner_export_scope_is_valid(uuid)
  from public, anon, authenticated, shipwithali_application, shipwithali_backup;
grant execute on function measurement.owner_export_scope_is_valid(uuid) to shipwithali_worker;

create policy analytics_goals_worker_owner_export on measurement.analytics_goals
  for select to shipwithali_worker using (measurement.owner_export_scope_is_valid(portfolio_id));
create policy analytics_goal_versions_worker_owner_export on measurement.analytics_goal_versions
  for select to shipwithali_worker using (measurement.owner_export_scope_is_valid(portfolio_id));
create policy analytics_goal_activation_worker_owner_export on measurement.analytics_goal_activation_history
  for select to shipwithali_worker using (measurement.owner_export_scope_is_valid(portfolio_id));
create policy analytics_goal_versions_worker_purpose_fence on measurement.analytics_goal_versions
  as restrictive for select to shipwithali_worker using (
    (current_setting('shipwithali.worker_purpose', true) = 'measurement.goal-conversion'
      and portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid)
    or measurement.owner_export_scope_is_valid(portfolio_id)
  );
create policy analytics_goal_activations_worker_purpose_fence on measurement.analytics_goal_activation_history
  as restrictive for select to shipwithali_worker using (
    (current_setting('shipwithali.worker_purpose', true) = 'measurement.goal-conversion'
      and portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid)
    or measurement.owner_export_scope_is_valid(portfolio_id)
  );
create policy daily_aggregates_worker_owner_export on measurement.daily_aggregates
  for select to shipwithali_worker using (measurement.owner_export_scope_is_valid(portfolio_id));
create policy daily_aggregate_checkpoints_worker_owner_export on measurement.daily_aggregate_checkpoints
  for select to shipwithali_worker using (measurement.owner_export_scope_is_valid(portfolio_id));

-- The earlier aggregate worker policies stay available for aggregate work. This restrictive
-- fence requires either that job purpose or the exact owner-export scope, and makes Analytics
-- owner-export reads read-only even though the aggregate role can write during its own job.
create policy daily_aggregates_worker_purpose_fence on measurement.daily_aggregates
  as restrictive for all to shipwithali_worker
  using (
    (current_setting('shipwithali.worker_purpose', true) in ('measurement.aggregate', 'measurement.retention')
      and portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid)
    or measurement.owner_export_scope_is_valid(portfolio_id)
  )
  with check (
    current_setting('shipwithali.worker_purpose', true) in ('measurement.aggregate', 'measurement.retention')
    and portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid
  );
create policy daily_aggregate_checkpoints_worker_purpose_fence on measurement.daily_aggregate_checkpoints
  as restrictive for all to shipwithali_worker
  using (
    (current_setting('shipwithali.worker_purpose', true) in ('measurement.aggregate', 'measurement.retention')
      and portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid)
    or measurement.owner_export_scope_is_valid(portfolio_id)
  )
  with check (
    current_setting('shipwithali.worker_purpose', true) in ('measurement.aggregate', 'measurement.retention')
    and portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid
  );

comment on function measurement.owner_export_scope_is_valid(uuid) is
  'Purpose-limited Analytics owner-export predicate; requires the transaction-local portfolio, Owner, and measurement.owner-export purpose.';

reset role;
