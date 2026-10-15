-- Phase 6 #149: byte-bound processing attempts and immutable private PDF outputs.
-- Rollback: restore the pre-Phase 6 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;

create table media.processing_states (
  media_id uuid primary key references media.assets (media_id),
  portfolio_id uuid not null,
  owner_id uuid not null,
  aggregate_version integer not null default 1 check (aggregate_version >= 1),
  latest_attempt_id uuid,
  updated_at timestamptz not null default transaction_timestamp(),
  foreign key (media_id, portfolio_id, owner_id) references media.assets (media_id, portfolio_id, owner_id)
);

create table media.processed_objects (
  object_id uuid primary key check (object_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  portfolio_id uuid not null,
  owner_id uuid not null,
  media_id uuid not null references media.assets (media_id),
  source_object_id uuid not null references media.upload_intents (media_object_id),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_length bigint not null check (byte_length between 1 and 20971520),
  mime_type text not null check (mime_type = 'application/pdf'),
  object_version text not null check (length(object_version) between 1 and 255),
  created_at timestamptz not null default transaction_timestamp(),
  unique (object_id, media_id, portfolio_id, owner_id)
);

create table media.processing_attempts (
  attempt_id uuid primary key check (attempt_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  portfolio_id uuid not null,
  owner_id uuid not null,
  media_id uuid not null references media.assets (media_id),
  input_object_id uuid not null references media.upload_intents (media_object_id),
  input_sha256 text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
  detected_mime_type text not null,
  detected_byte_length bigint not null check (detected_byte_length >= 0),
  result text not null check (result in ('passed', 'failed')),
  output_object_id uuid,
  output_sha256 text check (output_sha256 is null or output_sha256 ~ '^[0-9a-f]{64}$'),
  scanner_version text not null check (length(scanner_version) between 1 and 160),
  processor_version text not null check (length(processor_version) between 1 and 160),
  policy_version text not null check (length(policy_version) between 1 and 160),
  finding_codes jsonb not null check (jsonb_typeof(finding_codes) = 'array' and jsonb_array_length(finding_codes) <= 16),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  check (finished_at >= started_at),
  check ((result = 'passed') = (output_object_id is not null and output_sha256 is not null)),
  foreign key (output_object_id, media_id, portfolio_id, owner_id)
    references media.processed_objects (object_id, media_id, portfolio_id, owner_id)
);

create table media.processing_commands (
  portfolio_id uuid not null,
  owner_id uuid not null,
  media_id uuid not null references media.assets (media_id),
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  attempt_id uuid not null references media.processing_attempts (attempt_id),
  aggregate_version integer not null check (aggregate_version > 1),
  outcome text not null check (outcome = 'media-processing-recorded'),
  created_at timestamptz not null default transaction_timestamp(),
  primary key (portfolio_id, owner_id, media_id, idempotency_key_hash)
);

create table media.processing_orphans (
  object_id uuid primary key check (object_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  portfolio_id uuid not null,
  owner_id uuid not null,
  media_id uuid not null references media.assets (media_id),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  state text not null default 'pending' check (state in ('pending', 'reconciled')),
  created_at timestamptz not null default transaction_timestamp(),
  reconciled_at timestamptz,
  check ((state = 'reconciled') = (reconciled_at is not null))
);

alter table media.processing_states enable row level security;
alter table media.processing_states force row level security;
alter table media.processed_objects enable row level security;
alter table media.processed_objects force row level security;
alter table media.processing_attempts enable row level security;
alter table media.processing_attempts force row level security;
alter table media.processing_commands enable row level security;
alter table media.processing_commands force row level security;
alter table media.processing_orphans enable row level security;
alter table media.processing_orphans force row level security;

grant usage on schema media to shipwithali_application;
grant select, insert, update on media.processing_states to shipwithali_application;
grant select, insert on media.processed_objects, media.processing_attempts, media.processing_commands to shipwithali_application;
grant select, insert, update on media.processing_orphans to shipwithali_application;
grant select on media.processing_states, media.processed_objects, media.processing_attempts, media.processing_commands to shipwithali_backup;
grant select on media.processing_orphans to shipwithali_backup;

create policy media_processing_states_owner_scope on media.processing_states
  for all to shipwithali_application using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  ) with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );

create policy media_processed_objects_owner_scope on media.processed_objects
  for all to shipwithali_application using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  ) with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );

create policy media_processing_attempts_owner_scope on media.processing_attempts
  for all to shipwithali_application using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  ) with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );

create policy media_processing_commands_owner_scope on media.processing_commands
  for all to shipwithali_application using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  ) with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );

create policy media_processing_orphans_owner_scope on media.processing_orphans
  for all to shipwithali_application using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  ) with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );

create index media_processing_attempts_history_idx
  on media.processing_attempts (portfolio_id, owner_id, media_id, finished_at desc, attempt_id desc);
create index media_processing_orphans_pending_idx
  on media.processing_orphans (portfolio_id, owner_id, created_at, object_id) where state = 'pending';

reset role;
