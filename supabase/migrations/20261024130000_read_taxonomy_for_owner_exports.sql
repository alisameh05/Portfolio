-- Phase 8 #242: export complete taxonomy identity, assignment, and evolution facts.
-- Rollback: restore the pre-#242 database snapshot before deployment. Forward
-- fixes use another additive, purpose-limited migration.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

create function taxonomy.owner_export_scope_is_valid(target_portfolio_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, portfolio_config
as $$
  select target_portfolio_id::text = nullif(current_setting('shipwithali.portfolio_id', true), '')
     and current_setting('shipwithali.worker_purpose', true) = 'taxonomy.owner-export'
     and exists (
       select 1 from portfolio_config.settings settings
        where settings.portfolio_id = target_portfolio_id
          and settings.owner_id::text = nullif(current_setting('shipwithali.owner_id', true), '')
     );
$$;

grant usage on schema taxonomy, content to shipwithali_worker;
grant select on taxonomy.taxonomy_values, taxonomy.value_history,
  content.project_taxonomy_assignment_history to shipwithali_worker;
revoke all on function taxonomy.owner_export_scope_is_valid(uuid)
  from public, anon, authenticated, shipwithali_application, shipwithali_backup;
grant execute on function taxonomy.owner_export_scope_is_valid(uuid) to shipwithali_worker;

create policy taxonomy_values_worker_owner_export on taxonomy.taxonomy_values
  for select to shipwithali_worker using (taxonomy.owner_export_scope_is_valid(portfolio_id));
create policy taxonomy_value_history_worker_owner_export on taxonomy.value_history
  for select to shipwithali_worker using (taxonomy.owner_export_scope_is_valid(portfolio_id));
create policy taxonomy_roots_worker_taxonomy_export on taxonomy.roots
  for select to shipwithali_worker using (taxonomy.owner_export_scope_is_valid(portfolio_id));
create policy project_taxonomy_assignment_history_worker_owner_export on content.project_taxonomy_assignment_history
  for select to shipwithali_worker using (content.owner_export_scope_is_valid(portfolio_id));

comment on function taxonomy.owner_export_scope_is_valid(uuid) is
  'Purpose-limited Owner taxonomy export predicate; requires transaction-local portfolio, Owner, and taxonomy.owner-export purpose.';

reset role;
