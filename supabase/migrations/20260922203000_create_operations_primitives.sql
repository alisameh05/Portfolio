-- Phase 3 operations persistence primitives.
-- Rollback: restore the pre-Phase 3 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';
set role shipwithali_migration;

create table operations.idempotency_records (
  operation_scope text not null,
  actor_scope text not null,
  key_hash char(64) not null,
  request_hash char(64) not null,
  status text not null check (status in ('reserved', 'completed')),
  result_envelope jsonb,
  created_at timestamptz not null default transaction_timestamp(),
  completed_at timestamptz,
  expires_at timestamptz not null,
  primary key (operation_scope, actor_scope, key_hash),
  check ((status = 'reserved' and result_envelope is null and completed_at is null)
    or (status = 'completed' and result_envelope is not null and completed_at is not null)),
  check (expires_at > created_at)
);

create table operations.outbox_events (
  event_id uuid primary key,
  event_type text not null,
  schema_version integer not null check (schema_version > 0),
  aggregate_id uuid not null,
  aggregate_version integer not null check (aggregate_version > 0),
  payload jsonb not null,
  correlation_id text not null,
  causation_id text,
  occurred_at timestamptz not null,
  available_at timestamptz not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_owner text,
  lease_token text,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  check ((lease_owner is null and lease_token is null and lease_expires_at is null)
    or (lease_owner is not null and lease_token is not null and lease_expires_at is not null))
);

create index outbox_events_due_idx
  on operations.outbox_events (available_at, event_id)
  where completed_at is null;

create table operations.jobs (
  job_id uuid primary key,
  job_type text not null,
  payload_version integer not null check (payload_version > 0),
  payload jsonb not null,
  available_at timestamptz not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  status text not null default 'available' check (status in ('available', 'leased', 'completed')),
  lease_owner text,
  lease_token text,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  last_error_code text,
  check ((status = 'leased' and lease_owner is not null and lease_token is not null and lease_expires_at is not null and completed_at is null)
    or (status = 'available' and lease_owner is null and lease_token is null and lease_expires_at is null and completed_at is null)
    or (status = 'completed' and lease_owner is null and lease_token is null and lease_expires_at is null and completed_at is not null))
);

create index jobs_due_idx
  on operations.jobs (available_at, job_id)
  where completed_at is null;

alter table operations.idempotency_records enable row level security;
alter table operations.idempotency_records force row level security;
alter table operations.outbox_events enable row level security;
alter table operations.outbox_events force row level security;
alter table operations.jobs enable row level security;
alter table operations.jobs force row level security;

grant usage on schema operations to shipwithali_application, shipwithali_worker, shipwithali_backup;
grant select, insert, update on operations.idempotency_records to shipwithali_application;
grant insert on operations.outbox_events to shipwithali_application;
grant select, update on operations.outbox_events to shipwithali_worker;
grant select, insert, update on operations.jobs to shipwithali_worker;
grant select on operations.idempotency_records, operations.outbox_events, operations.jobs to shipwithali_backup;

create policy idempotency_application_select_policy on operations.idempotency_records
  for select to shipwithali_application using (true);
create policy idempotency_application_insert_policy on operations.idempotency_records
  for insert to shipwithali_application with check (true);
create policy idempotency_application_update_policy on operations.idempotency_records
  for update to shipwithali_application using (true) with check (true);
create policy outbox_application_insert_policy on operations.outbox_events
  for insert to shipwithali_application with check (true);
create policy outbox_worker_select_policy on operations.outbox_events
  for select to shipwithali_worker using (true);
create policy outbox_worker_update_policy on operations.outbox_events
  for update to shipwithali_worker using (true) with check (true);
create policy jobs_worker_select_policy on operations.jobs
  for select to shipwithali_worker using (true);
create policy jobs_worker_insert_policy on operations.jobs
  for insert to shipwithali_worker with check (true);
create policy jobs_worker_update_policy on operations.jobs
  for update to shipwithali_worker using (true) with check (true);
create policy operations_backup_policy_idempotency on operations.idempotency_records
  for select to shipwithali_backup using (true);
create policy operations_backup_policy_outbox on operations.outbox_events
  for select to shipwithali_backup using (true);
create policy operations_backup_policy_jobs on operations.jobs
  for select to shipwithali_backup using (true);

revoke all on operations.idempotency_records, operations.outbox_events, operations.jobs
  from public, anon, authenticated;

reset role;
