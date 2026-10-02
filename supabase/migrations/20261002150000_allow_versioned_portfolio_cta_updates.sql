-- Phase 4 #86: permit scoped updates to only the single Global project CTA.
-- The existing settings update policy enforces the configured Portfolio/Owner
-- scope; the version and timestamp columns were already granted for #84.
-- Rollback: revoke update (global_cta_label, global_cta_destination,
--   global_cta_unavailable_fallback) on portfolio_config.settings
--   from shipwithali_application;
-- Forward fix: correct any grant defect with a new expansion migration.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;

set role shipwithali_migration;

grant update (global_cta_label, global_cta_destination, global_cta_unavailable_fallback)
  on portfolio_config.settings to shipwithali_application;

reset role;
