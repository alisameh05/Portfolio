-- Phase 8 #253: independently recoverable encrypted relational backups.
-- Adds the durable system-wide ledger of encrypted off-primary relational
-- backup copy attempts. Only safe metadata lives here: destination and object
-- identifiers, algorithm/tool/key labels, counts, digests, lifecycle state,
-- and configured retention inputs. The ledger never stores credentials, key
-- material, plaintext dumps, or provider connection coordinates.
--
-- Terminal rows are immutable identities: a failed attempt never mutates a
-- usable row, so the newest committed usable copy per destination stays the
-- last-known-good reference until retention acknowledges its deletion.
--
-- Rollback removes the ledger; recovery copies at external destinations are
-- managed by the configured destination lifecycle and operators, never by
-- this schema alone.

set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;

create table operations.relational_backup_copies (
  copy_id uuid primary key,
  destination_name text not null
    check (destination_name ~ '^[a-z][a-z0-9-]{2,47}$'),
  object_key text not null
    check (object_key ~ '^[a-z0-9][a-z0-9._/-]{9,239}$'),
  envelope_version smallint not null check (envelope_version = 1),
  algorithm text not null check (algorithm = 'AES-256-GCM'),
  key_version text not null check (key_version ~ '^[a-z0-9][a-z0-9-]{1,47}$'),
  dump_tool text not null check (dump_tool ~ '^[A-Za-z0-9 ./+-]{4,120}$'),
  source_watermark_at timestamptz not null,
  dump_bytes bigint not null check (dump_bytes between 0 and 1099511627776),
  ciphertext_bytes bigint not null check (ciphertext_bytes between 0 and 1099511627776),
  catalog_sha256 char(64) not null check (catalog_sha256 ~ '^[0-9a-f]{64}$'),
  ciphertext_sha256 char(64) not null check (ciphertext_sha256 ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('uploading', 'usable', 'failed')),
  failure_code text
    constraint relational_backup_copies_failure_shape_check
      check (failure_code is null or failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  attempted_at timestamptz not null,
  verified_at timestamptz,
  committed_at timestamptz,
  retention_lifetime_hours integer
    check (retention_lifetime_hours is null or retention_lifetime_hours between 24 and 8760),
  expires_at timestamptz,
  deletion_acknowledged_at timestamptz,
  incident_environment text not null default 'unknown'
    check (incident_environment in ('unknown', 'local', 'test', 'staging', 'production')),
  incident_job_id uuid,
  constraint relational_backup_copies_usable_verified_check
    check (state <> 'usable' or
      (verified_at is not null and committed_at is not null and deletion_acknowledged_at is null)),
  constraint relational_backup_copies_failure_code_check
    check (failure_code is null or state = 'failed'),
  constraint relational_backup_copies_committed_usable_check
    check (committed_at is null or state = 'usable'),
  constraint relational_backup_copies_expiry_lifecycle_check
    check (expires_at is null or retention_lifetime_hours is not null),
  constraint relational_backup_copies_deletion_state_check
    check (deletion_acknowledged_at is null or state in ('uploading', 'usable'))
);

alter table operations.relational_backup_copies enable row level security;
alter table operations.relational_backup_copies force row level security;

create index relational_backup_copies_current_idx
  on operations.relational_backup_copies (destination_name, committed_at desc, copy_id)
  where state = 'usable';

create index relational_backup_copies_retention_idx
  on operations.relational_backup_copies (expires_at, copy_id)
  where state = 'usable' and deletion_acknowledged_at is null;

create policy operations_backup_policy_relational_backup_copies
  on operations.relational_backup_copies
  as permissive for select to shipwithali_backup using (true);

create policy relational_backup_copies_backup_insert
  on operations.relational_backup_copies
  as permissive for insert to shipwithali_backup with check (state = 'uploading');

create policy relational_backup_copies_backup_update
  on operations.relational_backup_copies
  as permissive for update to shipwithali_backup
  using (
    state = 'uploading'
    or (state = 'usable' and deletion_acknowledged_at is null and expires_at <= clock_timestamp())
  )
  with check (
    (state in ('usable', 'failed') and deletion_acknowledged_at is null)
    or (state = 'usable' and deletion_acknowledged_at is not null and expires_at <= clock_timestamp())
  );

create policy relational_backup_copies_worker_inspect
  on operations.relational_backup_copies
  as permissive for select to shipwithali_worker using (true);

grant select on operations.relational_backup_copies to shipwithali_backup, shipwithali_worker;
grant insert on operations.relational_backup_copies to shipwithali_backup;
grant update (state, failure_code, verified_at, committed_at, deletion_acknowledged_at)
  on operations.relational_backup_copies to shipwithali_backup;

create policy relational_backup_incidents_insert
  on operations.incidents
  as permissive for insert to shipwithali_backup
  with check (
    category = 'backup'
    and owner_role = 'backup'
    and remediation_pointer = 'runbook:recovery/relational-backup'
  );

create policy relational_backup_incidents_update
  on operations.incidents
  as permissive for update to shipwithali_backup
  using (
    category = 'backup'
    and owner_role = 'backup'
    and remediation_pointer = 'runbook:recovery/relational-backup'
  )
  with check (
    category = 'backup'
    and owner_role = 'backup'
    and remediation_pointer = 'runbook:recovery/relational-backup'
  );

grant insert on operations.incidents to shipwithali_backup;
grant update (safe_error_code, last_observed_at, occurrences, resolved_at,
  recovery_recorded_at, delivery_state, next_delivery_at)
  on operations.incidents to shipwithali_backup;

reset role;
revoke all on operations.relational_backup_copies
  from public, anon, authenticated, shipwithali_application;
