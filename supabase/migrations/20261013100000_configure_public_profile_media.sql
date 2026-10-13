-- Phase 6 #158: explicitly configured public profile Media identity.
-- Rollback: restore the pre-Phase 6 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table portfolio_config.settings
  add column profile_media_asset_id uuid;

alter table portfolio_config.settings
  add constraint portfolio_settings_profile_media_owner_fk
  foreign key (profile_media_asset_id, portfolio_id, owner_id)
  references media.assets (media_id, portfolio_id, owner_id)
  not valid;

alter table portfolio_config.settings
  validate constraint portfolio_settings_profile_media_owner_fk;

grant update (profile_media_asset_id)
  on portfolio_config.settings to shipwithali_application;

comment on column portfolio_config.settings.profile_media_asset_id is
  'Optional stable identity of the explicitly configured public profile image; delivery still requires current accepted Media evidence.';

create index content_public_project_media_use_gin_idx
  on content.public_project_locales using gin (claims jsonb_path_ops);

reset role;
