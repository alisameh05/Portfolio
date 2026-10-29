-- Phase 8 #252: actionable incident metadata and durable bounded delivery state.
-- Existing operational incidents are preserved and receive safe default pointers.
-- Rollback disables delivery scheduling; incident history remains available.

set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table operations.incidents
  drop constraint incidents_category_check,
  add constraint incidents_category_check check (category in ('job', 'outbox', 'export', 'publication', 'retention', 'backup', 'recovery')),
  add column measured_value numeric(20,4) check (measured_value is null or measured_value >= 0),
  add column threshold_value numeric(20,4) check (threshold_value is null or threshold_value >= 0),
  add column measurement_unit text
    check (measurement_unit is null or measurement_unit in ('seconds', 'milliseconds', 'hours', 'percent', 'count')),
  add column measurement_window_seconds integer check (measurement_window_seconds is null or measurement_window_seconds between 0 and 604800),
  add column owner_role text not null default 'operations'
    check (owner_role in ('operations', 'content', 'measurement', 'backup', 'identity')),
  add column remediation_pointer text not null default 'runbook:operations/general'
    check (remediation_pointer ~ '^runbook:[a-z0-9/_-]{3,120}$'),
  add column delivery_state text not null default 'pending'
    check (delivery_state in ('pending', 'delivered', 'exhausted', 'not-required')),
  add column delivery_attempts smallint not null default 0
    check (delivery_attempts between 0 and 8),
  add column next_delivery_at timestamptz default clock_timestamp(),
  add column delivery_lease_token uuid,
  add column delivery_lease_generation bigint not null default 0 check (delivery_lease_generation >= 0),
  add column delivery_lease_expires_at timestamptz,
  add column delivery_error_code text
    check (delivery_error_code is null or delivery_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  add column recovery_recorded_at timestamptz,
  add column environment text not null default 'unknown'
    check (environment in ('unknown', 'local', 'test', 'staging', 'production')),
  add column measurement_is_lower_bound boolean not null default false;

alter table operations.incidents
  add constraint incidents_delivery_lease_pair_check check (
    (delivery_lease_token is null and delivery_lease_expires_at is null)
    or (delivery_lease_token is not null and delivery_lease_expires_at is not null
        and resolved_at is null and delivery_state = 'pending')
  );

update operations.incidents
   set next_delivery_at = last_observed_at
 where resolved_at is null and delivery_state = 'pending' and next_delivery_at is null;

create index incidents_delivery_due_idx
  on operations.incidents (next_delivery_at, incident_id)
  where resolved_at is null and delivery_state = 'pending';

grant update (first_observed_at, severity, environment, measurement_is_lower_bound, measured_value, threshold_value, measurement_unit, measurement_window_seconds,
  owner_role, remediation_pointer, delivery_state, delivery_attempts,
  next_delivery_at, delivery_lease_token, delivery_lease_generation, delivery_lease_expires_at,
  delivery_error_code, recovery_recorded_at) on operations.incidents to shipwithali_worker;

reset role;
