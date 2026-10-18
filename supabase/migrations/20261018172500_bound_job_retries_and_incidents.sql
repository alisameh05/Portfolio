-- Bound operations retries and retain safe terminal incidents.
-- Rollback: restore the pre-migration snapshot before deployment.
-- Forward fix: repair constraints with another timestamped migration.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table operations.jobs drop constraint if exists jobs_status_check;
alter table operations.jobs
  add constraint jobs_status_check
  check (status in ('available', 'leased', 'completed', 'dead'));
alter table operations.jobs drop constraint if exists jobs_check;
alter table operations.jobs
  add constraint jobs_lifecycle_check
  check ((status = 'leased' and lease_owner is not null and lease_token is not null
          and lease_expires_at is not null and completed_at is null)
    or (status = 'available' and lease_owner is null and lease_token is null
        and lease_expires_at is null and completed_at is null)
    or (status = 'completed' and lease_owner is null and lease_token is null
        and lease_expires_at is null and completed_at is not null)
    or (status = 'dead' and lease_owner is null and lease_token is null
        and lease_expires_at is null and completed_at is null and last_error_code is not null));

alter table operations.outbox_events add column dead_at timestamptz;
alter table operations.outbox_events
  add constraint outbox_events_terminal_state_check
  check ((completed_at is null or dead_at is null)
    and (dead_at is null or (lease_owner is null and lease_token is null and lease_expires_at is null)));
drop index operations.outbox_events_due_idx;
create index outbox_events_due_idx
  on operations.outbox_events (available_at, event_id)
  where completed_at is null and dead_at is null;

create table operations.incidents (
  incident_id uuid primary key default gen_random_uuid(),
  incident_key text not null unique,
  category text not null check (category in ('job', 'outbox', 'export', 'backup', 'recovery')),
  source_id uuid,
  safe_error_code text not null check (safe_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  severity text not null check (severity in ('warning', 'critical')),
  first_observed_at timestamptz not null default transaction_timestamp(),
  last_observed_at timestamptz not null default transaction_timestamp(),
  occurrences integer not null default 1 check (occurrences > 0),
  resolved_at timestamptz,
  check (last_observed_at >= first_observed_at)
);

create index incidents_open_idx
  on operations.incidents (last_observed_at desc, incident_id)
  where resolved_at is null;

alter table operations.incidents enable row level security;
alter table operations.incidents force row level security;
grant usage on schema operations to shipwithali_worker, shipwithali_backup;
grant select, insert on operations.incidents to shipwithali_worker;
grant update (safe_error_code, last_observed_at, occurrences, resolved_at) on operations.incidents to shipwithali_worker;
grant select on operations.incidents to shipwithali_backup;
create policy incidents_worker_select_policy on operations.incidents
  for select to shipwithali_worker using (true);
create policy incidents_worker_insert_policy on operations.incidents
  for insert to shipwithali_worker with check (true);
create policy incidents_worker_update_policy on operations.incidents
  for update to shipwithali_worker using (true) with check (true);
create policy operations_backup_policy_incidents on operations.incidents
  for select to shipwithali_backup using (true);
revoke all on operations.incidents from public, anon, authenticated;

create table operations.job_redrive_audit (
  audit_id uuid primary key default gen_random_uuid(),
  original_job_id uuid not null unique references operations.jobs(job_id),
  replacement_job_id uuid not null unique references operations.jobs(job_id),
  operator_scope_hash text not null check (operator_scope_hash ~ '^[0-9a-f]{64}$'),
  policy_version text not null check (policy_version ~ '^[a-z][a-z0-9-]{0,63}$'),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default transaction_timestamp(),
  check (original_job_id <> replacement_job_id)
);
create index job_redrive_audit_original_idx on operations.job_redrive_audit(original_job_id, created_at);
alter table operations.job_redrive_audit enable row level security;
alter table operations.job_redrive_audit force row level security;
grant select, insert on operations.job_redrive_audit to shipwithali_worker;
grant select on operations.job_redrive_audit to shipwithali_backup;
create policy job_redrive_audit_worker_select_policy on operations.job_redrive_audit
  for select to shipwithali_worker using (true);
create policy job_redrive_audit_worker_insert_policy on operations.job_redrive_audit
  for insert to shipwithali_worker with check (true);
create policy operations_backup_policy_job_redrive_audit on operations.job_redrive_audit
  for select to shipwithali_backup using (true);
revoke all on operations.job_redrive_audit from public, anon, authenticated;

reset role;
