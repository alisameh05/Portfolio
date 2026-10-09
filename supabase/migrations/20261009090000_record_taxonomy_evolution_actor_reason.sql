-- Taxonomy evolution retains the responsible Owner and an optional retirement reason.
-- Rollback: restore the prior taxonomy migration set before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table taxonomy.value_history
  add column actor_id uuid,
  add column reason text;

alter table taxonomy.value_history
  add constraint taxonomy_value_history_actor_reason_check check (
    (action = 'created' and actor_id is null and reason is null)
    or (action = 'renamed' and actor_id is not null and reason is null)
    or (action = 'retired' and actor_id is not null and
      (reason is null or char_length(btrim(reason)) between 1 and 500))
    or (action = 'merged' and actor_id is not null and reason is null)
  );

drop policy taxonomy_value_history_application_scope on taxonomy.value_history;
create policy taxonomy_value_history_application_scope on taxonomy.value_history for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = value_history.portfolio_id and s.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = value_history.portfolio_id and s.owner_id::text = current_setting('shipwithali.owner_id', true))
    and ((action = 'created' and actor_id is null) or actor_id::text = current_setting('shipwithali.owner_id', true)));

reset role;
