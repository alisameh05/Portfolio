-- Phase 8 #254: encrypted Storage object and eligible Owner-export copies.
-- Only protected catalog metadata is stored in PostgreSQL; object identities,
-- hashes, and owner references remain inside the authenticated encrypted envelope.

set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;

create table operations.object_backup_copies (
  copy_id uuid primary key,
  destination_name text not null check (destination_name ~ '^[a-z][a-z0-9-]{2,47}$'),
  object_key text not null check (object_key ~ '^[a-z0-9][a-z0-9._/-]{9,239}$'),
  envelope_version smallint not null check (envelope_version = 1),
  algorithm text not null check (algorithm = 'AES-256-GCM'),
  key_version text not null check (key_version ~ '^[a-z0-9][a-z0-9-]{1,47}$'),
  source_watermark_at timestamptz not null,
  relational_watermark_at timestamptz not null,
  object_count integer not null check (object_count >= 0),
  media_bytes bigint not null check (media_bytes between 0 and 1099511627776),
  export_bytes bigint not null check (export_bytes between 0 and 1099511627776),
  ciphertext_bytes bigint not null check (ciphertext_bytes between 0 and 1099511627776),
  catalog_sha256 char(64) not null check (catalog_sha256 ~ '^[0-9a-f]{64}$'),
  ciphertext_sha256 char(64) not null check (ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('uploading', 'usable', 'failed')),
  failure_code text check (failure_code is null or failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  attempted_at timestamptz not null,
  verified_at timestamptz,
  committed_at timestamptz,
  retention_lifetime_hours integer check (retention_lifetime_hours is null or retention_lifetime_hours between 24 and 8760),
  expires_at timestamptz,
  deletion_acknowledged_at timestamptz,
  incident_environment text not null default 'unknown' check (incident_environment in ('unknown','local','test','staging','production')),
  constraint object_backup_copies_usable_verified_check check (state <> 'usable' or (verified_at is not null and committed_at is not null and deletion_acknowledged_at is null)),
  constraint object_backup_copies_failure_state_check check (failure_code is null or state = 'failed'),
  constraint object_backup_copies_committed_state_check check (committed_at is null or state = 'usable'),
  constraint object_backup_copies_expiry_check check (expires_at is null or retention_lifetime_hours is not null),
  constraint object_backup_copies_deletion_check check (deletion_acknowledged_at is null or state = 'usable'),
  constraint object_backup_copies_watermark_order_check check (source_watermark_at <= relational_watermark_at)
);

-- A non-login migration-owned view exposes only configured Portfolio/Owner IDs
-- to the backup role so each run can prove its scope list is complete.
create policy object_backup_owner_scope_inventory on portfolio_config.settings
  as permissive for select to shipwithali_migration using (true);
create view operations.object_backup_owner_scopes with (security_barrier = true) as
  select portfolio_id, owner_id from portfolio_config.settings;
revoke all on operations.object_backup_owner_scopes from public, anon, authenticated, shipwithali_application;
grant select on operations.object_backup_owner_scopes to shipwithali_backup;

-- Operations summaries need backup watermarks, but the application role must
-- not read catalog keys, digests, or other recovery metadata directly.
create policy relational_backup_copies_migration_metrics on operations.relational_backup_copies
  as permissive for select to shipwithali_migration using (true);
grant select on operations.relational_backup_copies to shipwithali_migration;

alter table operations.object_backup_copies enable row level security;
alter table operations.object_backup_copies force row level security;
create index object_backup_copies_current_idx on operations.object_backup_copies (destination_name, committed_at desc, copy_id)
  where state = 'usable' and deletion_acknowledged_at is null;
create index object_backup_copies_retention_idx on operations.object_backup_copies (expires_at, copy_id)
  where state = 'usable' and deletion_acknowledged_at is null;
create policy operations_backup_policy_object_backup_copies on operations.object_backup_copies
  as permissive for select to shipwithali_backup using (true);
create policy object_backup_copies_worker_inspect on operations.object_backup_copies
  as permissive for select to shipwithali_worker using (true);
create policy object_backup_copies_migration_metrics on operations.object_backup_copies
  as permissive for select to shipwithali_migration using (true);
create policy object_backup_copies_backup_insert on operations.object_backup_copies
  as permissive for insert to shipwithali_backup with check (state = 'uploading');
create policy object_backup_copies_backup_update on operations.object_backup_copies
  as permissive for update to shipwithali_backup
  using (state = 'uploading' or (state = 'usable' and deletion_acknowledged_at is null and expires_at <= clock_timestamp()))
  with check ((state = 'uploading' and deletion_acknowledged_at is null) or
    (state in ('usable','failed') and deletion_acknowledged_at is null) or
    (state = 'usable' and deletion_acknowledged_at is not null and expires_at <= clock_timestamp()));
grant select on operations.object_backup_copies to shipwithali_backup, shipwithali_worker;
grant insert on operations.object_backup_copies to shipwithali_backup;
grant update (state,failure_code,verified_at,committed_at,deletion_acknowledged_at,object_count,media_bytes,export_bytes,ciphertext_bytes,catalog_sha256,ciphertext_sha256)
  on operations.object_backup_copies to shipwithali_backup;
grant select on operations.object_backup_copies to shipwithali_migration;

create view operations.backup_copy_metrics with (security_barrier = true) as
  select 'relational'::text as backup_type, state, attempted_at, committed_at, source_watermark_at,
    expires_at, deletion_acknowledged_at, null::integer as object_count, null::bigint as object_bytes
  from operations.relational_backup_copies
  union all
  select 'object'::text as backup_type, state, attempted_at, committed_at, source_watermark_at,
    expires_at, deletion_acknowledged_at, object_count, media_bytes + export_bytes as object_bytes
  from operations.object_backup_copies;
revoke all on operations.backup_copy_metrics from public, anon, authenticated;
grant select on operations.backup_copy_metrics to shipwithali_application;

create policy object_backup_incidents_insert on operations.incidents
  as permissive for insert to shipwithali_backup with check (
    category = 'backup' and owner_role = 'backup' and remediation_pointer = 'runbook:recovery/object-backup');
create policy object_backup_incidents_update on operations.incidents
  as permissive for update to shipwithali_backup using (
    category = 'backup' and owner_role = 'backup' and remediation_pointer = 'runbook:recovery/object-backup')
  with check (category = 'backup' and owner_role = 'backup' and remediation_pointer = 'runbook:recovery/object-backup');

reset role;
revoke all on operations.object_backup_copies from public, anon, authenticated, shipwithali_application;
