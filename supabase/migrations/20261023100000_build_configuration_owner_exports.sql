-- Phase 8 #240: resumable configuration snapshot checkpoints and artifact facts.
-- Rollback: restore the pre-#240 owner export rows before deployment; snapshots
-- and candidate objects are purpose-limited and may be deleted with that rollback.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;

set role shipwithali_migration;

alter table portability.owner_exports
  add column snapshot_id uuid,
  add column snapshot_captured_at timestamptz,
  add column configuration_version integer,
  add column snapshot_data jsonb,
  add column candidate_artifact_id uuid,
  add column candidate_sha256 text,
  add column candidate_content_length bigint,
  add column artifact_sha256 text,
  add column artifact_content_length bigint,
  add column expires_at timestamptz;

alter table portability.owner_exports
  add constraint owner_exports_snapshot_checkpoint_complete check (
    (snapshot_id is null and snapshot_captured_at is null and configuration_version is null and snapshot_data is null)
    or (snapshot_id is not null and snapshot_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and snapshot_captured_at is not null and snapshot_data is not null
      and (configuration_version is null or configuration_version >= 1))
  ),
  add constraint owner_exports_candidate_checkpoint_complete check (
    (candidate_artifact_id is null and candidate_sha256 is null and candidate_content_length is null)
    or (candidate_artifact_id is not null and candidate_artifact_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      and candidate_sha256 is not null and candidate_sha256 ~ '^[a-f0-9]{64}$'
      and candidate_content_length is not null and candidate_content_length between 1 and 67108864)
  ),
  add constraint owner_exports_artifact_integrity_complete check (
    (artifact_sha256 is null and artifact_content_length is null)
    or (artifact_sha256 is not null and artifact_sha256 ~ '^[a-f0-9]{64}$'
      and artifact_content_length is not null and artifact_content_length between 1 and 67108864)
  );

comment on column portability.owner_exports.snapshot_data is
  'Worker-private captured configuration facts. It is write-once before upload so retries never recapture a changed configuration.';
comment on column portability.owner_exports.candidate_artifact_id is
  'Stable immutable Storage object identity allocated before upload; retained across worker retries.';
comment on column portability.owner_exports.expires_at is
  'Effective artifact expiry, no later than seven days after completion or an earlier applicable policy deadline.';
comment on column portability.owner_exports.configuration_version is
  'Latest retained Configuration aggregate version captured by the export, or null when no configuration row exists.';

drop policy owner_exports_application_select_policy on portability.owner_exports;
create policy owner_exports_application_select_policy on portability.owner_exports
  for select to shipwithali_application using (
    portfolio_id::text = nullif(current_setting('shipwithali.portfolio_id', true), '')
    and owner_id::text = nullif(current_setting('shipwithali.owner_id', true), '')
  );

drop policy owner_exports_application_update_policy on portability.owner_exports;
create policy owner_exports_application_update_policy on portability.owner_exports
  for update to shipwithali_application using (
    portfolio_id::text = nullif(current_setting('shipwithali.portfolio_id', true), '')
    and owner_id::text = nullif(current_setting('shipwithali.owner_id', true), '')
  ) with check (
    portfolio_id::text = nullif(current_setting('shipwithali.portfolio_id', true), '')
    and owner_id::text = nullif(current_setting('shipwithali.owner_id', true), '')
  );

grant usage on schema portfolio_config to shipwithali_worker;
grant select on portfolio_config.settings, portfolio_config.contact_channels to shipwithali_worker;

create policy portfolio_settings_worker_export_select on portfolio_config.settings
  for select to shipwithali_worker
  using (
    portfolio_id::text = nullif(current_setting('shipwithali.portfolio_id', true), '')
    and owner_id::text = nullif(current_setting('shipwithali.owner_id', true), '')
  );

create policy portfolio_channels_worker_export_select on portfolio_config.contact_channels
  for select to shipwithali_worker
  using (
    portfolio_id::text = nullif(current_setting('shipwithali.portfolio_id', true), '')
    and exists (
      select 1 from portfolio_config.settings settings
       where settings.portfolio_id = contact_channels.portfolio_id
         and settings.owner_id::text = nullif(current_setting('shipwithali.owner_id', true), '')
    )
  );

reset role;
