-- Phase 4 #85 allows an authorized Owner command to replace ordered channels.
-- Rollback: revoke the grant and drop the delete policy in a new migration.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;

set role shipwithali_migration;

grant delete on portfolio_config.contact_channels to shipwithali_application;

create policy portfolio_channels_application_delete on portfolio_config.contact_channels
  for delete to shipwithali_application
  using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (
      select 1 from portfolio_config.settings settings
       where settings.portfolio_id = contact_channels.portfolio_id
         and settings.owner_id::text = current_setting('shipwithali.owner_id', true)
    )
  );

reset role;
