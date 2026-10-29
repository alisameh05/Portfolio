-- Phase 8 #238: durable Owner export request metadata and one assembly job per request.
-- Rollback: restore the pre-Phase 8 portability snapshot before deployment.
-- Forward fixes use a new expand-compatible migration.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;

set role shipwithali_migration;

create schema portability authorization shipwithali_migration;
grant usage on schema portability to shipwithali_application, shipwithali_worker, shipwithali_backup;
comment on schema portability is 'Logical owner: Portability and Operations module.';

create table portability.owner_exports (
  export_id uuid primary key
    check (export_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  portfolio_id uuid not null,
  owner_id uuid not null,
  included_scopes text[] not null check (array_length(included_scopes, 1) between 1 and 7
    and included_scopes <@ array[
      'portfolio-content', 'taxonomy', 'media-metadata', 'cv-metadata',
      'moderation-history', 'analytics-reports', 'portfolio-configuration'
    ]::text[]),
  status text not null check (status in ('requested', 'building', 'ready', 'failed', 'expired')),
  schema_version text not null check (schema_version ~ '^[1-9][0-9]*\.[0-9]+$'),
  requested_at timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  expired_at timestamptz,
  failure_code text check (failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  manifest jsonb,
  artifact_id uuid,
  aggregate_version integer not null default 1 check (aggregate_version >= 1),
  check (
    (status = 'requested' and started_at is null and completed_at is null
      and failed_at is null and expired_at is null and failure_code is null
      and manifest is null and artifact_id is null)
    or (status = 'building' and started_at is not null and completed_at is null
      and failed_at is null and expired_at is null and failure_code is null
      and manifest is null and artifact_id is null)
    or (status = 'ready' and started_at is not null and completed_at is not null
      and failed_at is null and expired_at is null and failure_code is null
      and manifest is not null and artifact_id is not null)
    or (status = 'failed' and completed_at is null and failed_at is not null
      and expired_at is null and failure_code is not null
      and manifest is null and artifact_id is null)
    or (status = 'expired' and completed_at is not null and expired_at is not null
      and failed_at is null and failure_code is null
      and manifest is not null and artifact_id is not null)
  )
);

comment on table portability.owner_exports is
  'Durable five-state Owner export request metadata. Completion is sliced only by the module assembly worker.';
comment on column portability.owner_exports.included_scopes is
  'Every declared nonempty unique subset of the seven documented domains; canonical order is enforced by the application.';
comment on column portability.owner_exports.failure_code is
  'Purpose-limited persistence machine code, never an Owner-visible reason or provider detail.';

alter table portability.owner_exports enable row level security;
alter table portability.owner_exports force row level security;

grant select, insert, update on portability.owner_exports to shipwithali_application;
grant select, update on portability.owner_exports to shipwithali_worker;
grant select on portability.owner_exports to shipwithali_backup;

create policy owner_exports_application_select_policy on portability.owner_exports
  for select to shipwithali_application using (true);
create policy owner_exports_application_insert_policy on portability.owner_exports
  for insert to shipwithali_application with check (owner_id::text = nullif(current_setting('shipwithali.owner_id', true), ''));
create policy owner_exports_application_update_policy on portability.owner_exports
  for update to shipwithali_application using (true) with check (true);
create policy owner_exports_worker_select_policy on portability.owner_exports
  for select to shipwithali_worker using (true);
create policy owner_exports_worker_update_policy on portability.owner_exports
  for update to shipwithali_worker using (true) with check (true);
create policy operations_backup_policy_owner_exports on portability.owner_exports
  for select to shipwithali_backup using (true);

revoke all on portability.owner_exports from public, anon, authenticated;

-- The single assembly queue stays operations.jobs; the Owner export request
-- transaction may reserve exactly its own declared job payload there. The
-- resolved Owner identity binds payload identity to the request context, so
-- another actor's scope cannot enqueue work under this policy.
create policy owner_export_jobs_application_insert on operations.jobs
  for insert to shipwithali_application
  with check (
    job_type = 'portability.owner-export-assembly.v1'
    and payload_version = 1
    and jsonb_typeof(payload) = 'object'
    and (select cast(count(*) as integer) = 4 from jsonb_object_keys(payload))
    and payload ?& array['exportId', 'portfolioId', 'ownerId', 'includedScopes']
    and payload->>'portfolioId' = nullif(current_setting('shipwithali.portfolio_id', true), '')
    and payload->>'ownerId' = nullif(current_setting('shipwithali.owner_id', true), '')
    and payload->>'exportId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and jsonb_typeof(payload->'includedScopes') = 'array'
    and jsonb_array_length(payload->'includedScopes') between 1 and 7
    and jsonb_array_length(payload->'includedScopes') = (
      select count(distinct value_text)
        from jsonb_array_elements_text(payload->'includedScopes') as elements(value_text)
    )
    and not exists (
      select 1
        from jsonb_array_elements_text(payload->'includedScopes') as members(value_text)
       where members.value_text not in (
         'portfolio-content', 'taxonomy', 'media-metadata', 'cv-metadata',
         'moderation-history', 'analytics-reports', 'portfolio-configuration'
       )
    )
  );

grant insert on operations.jobs to shipwithali_application;

-- The restricted assembly worker completes Owner exports by slicing readiness
-- inside its own atomic transaction, so the shared outbox accepts exactly the
-- module-produced event whose payload identity equals its own aggregate and
-- manifest. Every other event type — including probe or foreign-module types
-- that already flow through the application or outbox-claim paths — stays
-- denied for the worker append: the narrow policy and the narrow grant keep
-- the restricted role from writing anything beyond its module-owned slice.
grant insert on operations.outbox_events to shipwithali_worker;

create policy owner_export_outbox_worker_insert on operations.outbox_events
  for insert to shipwithali_worker
  with check (
    event_type = 'portability.export_produced.v1'
    and schema_version = 1
    and aggregate_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and jsonb_typeof(payload) = 'object'
    and (select cast(count(*) as integer) = 2 from jsonb_object_keys(payload))
    and payload ?& array['exportId', 'manifest']
    and payload->>'exportId' = aggregate_id::text
    and jsonb_typeof(payload->'manifest') = 'object'
    and payload->'manifest' ?& array['schemaVersion', 'exportId', 'checksumSha256', 'recordCounts']
    and payload->'manifest'->>'exportId' = aggregate_id::text
  );

reset role;
