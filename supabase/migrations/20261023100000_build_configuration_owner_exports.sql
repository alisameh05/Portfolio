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

-- The assembly worker commits a produced event with the ready transition.
-- Keep its insert capability limited to the matching ready Owner export.
grant insert on operations.outbox_events to shipwithali_worker;

create unique index owner_export_produced_outbox_once
  on operations.outbox_events (aggregate_id, aggregate_version)
  where event_type = 'portability.export_produced.v1';

create policy owner_export_produced_outbox_worker_insert on operations.outbox_events
  for insert to shipwithali_worker
  with check (
    event_type = 'portability.export_produced.v1'
    and schema_version = 1
    and occurred_at = available_at
    and exists (
      select 1
        from portability.owner_exports owner_export
       where owner_export.export_id = outbox_events.aggregate_id
         and owner_export.status = 'ready'
         and owner_export.aggregate_version = outbox_events.aggregate_version
         and owner_export.manifest is not null
         and outbox_events.correlation_id = owner_export.export_id::text
         and outbox_events.payload = jsonb_build_object(
           'exportId', owner_export.export_id::text,
           'manifest', jsonb_build_object(
             'schemaVersion', '1.0',
             'exportId', owner_export.export_id::text,
             'checksumSha256', owner_export.manifest->>'digest',
             'recordCounts', (
               select jsonb_object_agg(entry.value->>'scope', entry.value->'recordCount')
                 from jsonb_array_elements(owner_export.manifest->'entries') as entry(value)
             )
           )
         )
         and exists (
           select 1
             from operations.jobs job
            where job.job_id::text = outbox_events.causation_id
              and job.job_type = 'portability.owner-export-assembly.v1'
              and job.payload_version = 1
              and job.payload->>'exportId' = owner_export.export_id::text
              and job.payload->>'portfolioId' = owner_export.portfolio_id::text
              and job.payload->>'ownerId' = owner_export.owner_id::text
              and job.payload->'includedScopes' = to_jsonb(owner_export.included_scopes)
              and job.status = 'leased'
              and job.lease_token is not null
              and job.lease_expires_at > clock_timestamp()
         )
    )
  );

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
