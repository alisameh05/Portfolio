-- Phase 6 #152: immutable editorial acceptance snapshots and transaction-held facts.
-- Rollback: restore the pre-Phase 6 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;

create table media.decision_history (
  decision_id uuid primary key check (decision_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  portfolio_id uuid not null,
  owner_id uuid not null,
  media_id uuid not null,
  aggregate_version integer not null check (aggregate_version > 1),
  decision text not null check (decision in ('accepted', 'rejected')),
  processing_attempt_id uuid not null references media.processing_attempts (attempt_id),
  input_object_id uuid not null references media.upload_intents (media_object_id),
  input_sha256 text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
  detected_mime_type text not null,
  detected_byte_length bigint not null check (detected_byte_length > 0),
  scanner_version text not null check (length(scanner_version) between 1 and 160),
  processor_version text not null check (length(processor_version) between 1 and 160),
  processing_policy_version text not null check (length(processing_policy_version) between 1 and 160),
  sealed_outputs jsonb not null check (jsonb_typeof(sealed_outputs) = 'array' and jsonb_array_length(sealed_outputs) between 1 and 8),
  accessibility jsonb not null check (jsonb_typeof(accessibility) = 'object'),
  ownership_attested_by uuid not null,
  ownership_attested_at timestamptz not null,
  public_suitability_attested_by uuid not null,
  public_suitability_attested_at timestamptz not null,
  decided_by uuid not null,
  decided_at timestamptz not null default transaction_timestamp(),
  reason_code text check (reason_code is null or reason_code ~ '^[A-Z0-9_]{1,80}$'),
  unique (media_id, aggregate_version),
  foreign key (media_id, portfolio_id, owner_id) references media.assets (media_id, portfolio_id, owner_id),
  check ((decision = 'accepted') = (reason_code is null)),
  check (ownership_attested_by = owner_id and public_suitability_attested_by = owner_id and decided_by = owner_id),
  check (ownership_attested_at = decided_at and public_suitability_attested_at = decided_at)
);

comment on table media.decision_history is
  'Append-only Media decisions. Accepted rows snapshot exact trusted processing evidence, approved accessibility and independent Owner attestations.';
comment on column media.decision_history.sealed_outputs is
  'Immutable, provider-neutral descriptors of the exact processed objects approved by this decision.';

create table media.acceptance_commands (
  portfolio_id uuid not null,
  owner_id uuid not null,
  media_id uuid not null references media.assets (media_id),
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  aggregate_version integer not null check (aggregate_version > 1),
  outcome text not null check (outcome = 'media-accepted'),
  created_at timestamptz not null default transaction_timestamp(),
  primary key (portfolio_id, owner_id, media_id, idempotency_key_hash),
  foreign key (media_id, portfolio_id, owner_id) references media.assets (media_id, portfolio_id, owner_id)
);

alter table media.decision_history enable row level security;
alter table media.decision_history force row level security;
alter table media.acceptance_commands enable row level security;
alter table media.acceptance_commands force row level security;

grant usage on schema media to shipwithali_application;
grant select, insert on media.decision_history to shipwithali_application;
grant select, insert on media.acceptance_commands to shipwithali_application;
grant select on media.decision_history, media.acceptance_commands to shipwithali_backup;
revoke all on media.decision_history, media.acceptance_commands from public, anon, authenticated;

create policy media_decision_history_owner_scope on media.decision_history
  for all to shipwithali_application using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  ) with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );

create policy media_acceptance_commands_owner_scope on media.acceptance_commands
  for all to shipwithali_application using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  ) with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );

create index media_decision_history_owner_idx
  on media.decision_history (portfolio_id, owner_id, media_id, aggregate_version desc);
create index media_acceptance_commands_history_idx
  on media.acceptance_commands (portfolio_id, owner_id, media_id, created_at desc);

reset role;
