-- Phase 4 #84: permit the application to update only its scoped settings row.
-- Rollback:
--   drop policy portfolio_settings_application_update on portfolio_config.settings;
--   revoke update (display_name, headline, bio, version, updated_at)
--     on portfolio_config.settings from shipwithali_application;
-- Forward fix: correct any policy or grant defect with a new expansion migration.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;

set role shipwithali_migration;

grant update (display_name, headline, bio, version, updated_at)
  on portfolio_config.settings to shipwithali_application;

create policy portfolio_settings_application_update on portfolio_config.settings
  for update to shipwithali_application
  using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  )
  with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );

reset role;
