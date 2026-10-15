-- Phase 7 #196: retain only consented, privacy-minimized first-slice event detail.
-- Rollback: disable the event-ingestion capability; preserve accepted detail.
-- Forward fixes use a new expand-compatible migration.

set lock_timeout = '5s';

grant usage on schema measurement to shipwithali_application, shipwithali_worker;
grant insert on operations.jobs to shipwithali_application;
grant shipwithali_migration to current_user;
set role shipwithali_migration;

create table measurement.public_events (
  event_id uuid primary key
    check (event_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  portfolio_id uuid not null,
  measurement_subject uuid not null
    check (measurement_subject::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  action text not null check (action in ('page-viewed', 'project-viewed', 'active-engagement-sampled')),
  occurred_at timestamptz not null,
  accepted_at timestamptz not null,
  effective_at timestamptz not null,
  page_route_identity uuid not null
    check (page_route_identity::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  project_id uuid check (project_id is null or project_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  locale text not null check (locale in ('en', 'ar')),
  consent_version text not null check (consent_version ~ '^[A-Za-z0-9._-]{1,40}$'),
  journey_context uuid[] check (journey_context is null or cardinality(journey_context) <= 10),
  referrer_class text check (referrer_class is null or referrer_class in ('direct', 'search', 'social', 'professional', 'referral', 'unknown')),
  device_class text check (device_class is null or device_class in ('desktop', 'mobile', 'tablet', 'other', 'unknown')),
  country_code text check (country_code is null or country_code ~ '^[A-Z]{2}$'),
  active_milliseconds integer,
  created_at timestamptz not null default transaction_timestamp(),
  check (effective_at <= accepted_at),
  check (
    (action = 'page-viewed' and project_id is null and active_milliseconds is null)
    or (action = 'project-viewed' and project_id is not null and active_milliseconds is null)
    or (action = 'active-engagement-sampled' and (active_milliseconds between 1000 and 60000))
  )
);

create index public_events_retention_idx
  on measurement.public_events (portfolio_id, accepted_at, event_id);
create index public_events_subject_time_idx
  on measurement.public_events (portfolio_id, measurement_subject, accepted_at, event_id);
create index public_events_route_time_idx
  on measurement.public_events (portfolio_id, page_route_identity, effective_at desc, event_id desc);

alter table measurement.public_events enable row level security;
alter table measurement.public_events force row level security;
revoke all on measurement.public_events from public, anon, authenticated, shipwithali_application, shipwithali_worker, shipwithali_backup;
grant insert on measurement.public_events to shipwithali_application;
grant select on measurement.public_events to shipwithali_worker;
create policy measurement_event_jobs_application_insert on operations.jobs
  for insert to shipwithali_application
  with check (
    job_type = 'measurement.public-event-received.v1'
    and payload_version = 1
    and jsonb_typeof(payload) = 'object'
    and (select count(*) = 2 from jsonb_object_keys(payload))
    and payload ?& array['eventId', 'portfolioId']
    and payload->>'portfolioId' = nullif(current_setting('shipwithali.portfolio_id', true), '')
    and payload->>'eventId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  );

create policy public_events_application_insert on measurement.public_events
  for insert to shipwithali_application
  with check (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);
create policy public_events_worker_read on measurement.public_events
  for select to shipwithali_worker
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid);

comment on table measurement.public_events is
  'Consent-gated, purpose-separated raw Public event data. Retention is anchored to server accepted_at.';
comment on column measurement.public_events.measurement_subject is
  'Purpose-limited MeasurementVisitor identity; never copied to receipts, idempotency results, jobs, or outbox payloads.';
comment on column measurement.public_events.journey_context is
  'At most ten distinct ordered retained PublicRoute identities; no route content is copied.';

reset role;
