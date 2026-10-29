-- Phase 8 #251: indexes for bounded, read-only operational summaries.
-- Rollback: drop these indexes and nullable observation columns; no queue rows are deleted.
-- Forward fix: add compatible indexes with a later migration; do not widen the worker role.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table operations.outbox_events add column lease_acquired_at timestamptz;
alter table operations.jobs add column lease_acquired_at timestamptz;

create index outbox_events_operational_summary_dead_idx
  on operations.outbox_events (dead_at, event_id)
  include (attempt_count)
  where dead_at is not null;

create index outbox_events_operational_summary_retry_idx
  on operations.outbox_events (available_at, occurred_at, event_id)
  include (attempt_count)
  where completed_at is null and dead_at is null and attempt_count > 0;

create index outbox_events_operational_summary_lease_idx
  on operations.outbox_events (lease_expires_at, event_id)
  include (available_at, attempt_count, lease_acquired_at)
  where lease_expires_at is not null and completed_at is null and dead_at is null;

create index outbox_events_operational_summary_eligible_idx
  on operations.outbox_events (occurred_at, event_id)
  include (available_at, attempt_count, lease_expires_at, lease_acquired_at)
  where completed_at is null and dead_at is null;

create index jobs_operational_summary_status_idx
  on operations.jobs (status, available_at, job_id)
  include (attempt_count, lease_expires_at)
  where status in ('available', 'leased', 'dead');

create index jobs_operational_summary_dead_idx
  on operations.jobs (available_at, job_id)
  include (attempt_count)
  where status = 'dead';

create index jobs_operational_summary_lease_idx
  on operations.jobs (lease_expires_at, job_id)
  include (attempt_count, lease_acquired_at)
  where status = 'leased';

create index owner_exports_operational_summary_recent_idx
  on portability.owner_exports (portfolio_id, status, requested_at desc, export_id desc)
  include (started_at, completed_at, artifact_content_length);

create index owner_exports_operational_summary_ready_idx
  on portability.owner_exports (portfolio_id, completed_at desc, export_id desc)
  include (started_at, artifact_content_length)
  where status = 'ready' and completed_at is not null;

create index owner_exports_operational_summary_failed_idx
  on portability.owner_exports (portfolio_id, failed_at desc, export_id desc)
  where status = 'failed' and failed_at is not null;

create index owner_exports_operational_summary_expired_idx
  on portability.owner_exports (portfolio_id, expired_at desc, export_id desc)
  where status = 'expired' and expired_at is not null;

reset role;
