-- Phase 8 #245: read retained Feedback and actual moderation decisions for
-- private Owner exports. The exporter is read-only and bound to one Owner
-- Portfolio and the interaction.owner-export purpose.
-- Rollback: drop these four policies and the scope predicate, revoke its
-- EXECUTE grant and the column-level Worker SELECT grants. Leave schema USAGE
-- intact because other Interactions worker capabilities may depend on it.
set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

create function interaction.owner_feedback_export_scope_is_valid(target_portfolio_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, portfolio_config
as $$
  select target_portfolio_id::text = nullif(current_setting('shipwithali.portfolio_id', true), '')
     and current_setting('shipwithali.worker_purpose', true) = 'interaction.owner-export'
     and current_setting('shipwithali.feedback_access', true) = 'owner-export'
     and exists (
       select 1 from portfolio_config.settings settings
        where settings.portfolio_id = target_portfolio_id
          and settings.owner_id::text = nullif(current_setting('shipwithali.owner_id', true), '')
     );
$$;

revoke all on function interaction.owner_feedback_export_scope_is_valid(uuid)
  from public, anon, authenticated, shipwithali_application, shipwithali_backup;
grant execute on function interaction.owner_feedback_export_scope_is_valid(uuid) to shipwithali_worker;

grant usage on schema interaction to shipwithali_worker;
grant select (portfolio_id, feedback_id, project_id, locale, aggregate_version, moderation_state,
  author_name, paragraph, submitted_at, text_erased_at)
  on interaction.feedback to shipwithali_worker;
grant select (portfolio_id, feedback_id, sequence, decision, reason, decided_at)
  on interaction.moderation_decisions to shipwithali_worker;

create policy feedback_owner_export_read on interaction.feedback for select to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and current_setting('shipwithali.feedback_access', true) = 'owner-export'
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = feedback.portfolio_id
      and s.owner_id::text = current_setting('shipwithali.owner_id', true)));
create policy moderation_owner_export_read on interaction.moderation_decisions for select to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and current_setting('shipwithali.feedback_access', true) = 'owner-export'
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = moderation_decisions.portfolio_id
      and s.owner_id::text = current_setting('shipwithali.owner_id', true)));
create policy feedback_worker_owner_export_read on interaction.feedback for select to shipwithali_worker
  using (interaction.owner_feedback_export_scope_is_valid(portfolio_id));
create policy moderation_worker_owner_export_read on interaction.moderation_decisions for select to shipwithali_worker
  using (interaction.owner_feedback_export_scope_is_valid(portfolio_id));

comment on policy feedback_worker_owner_export_read on interaction.feedback is
  'Read-only Feedback export policy requires the current Owner Portfolio and interaction.owner-export worker purpose.';
comment on policy moderation_worker_owner_export_read on interaction.moderation_decisions is
  'Read-only moderation export policy requires the current Owner Portfolio and interaction.owner-export worker purpose.';

reset role;
