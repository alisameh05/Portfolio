-- Phase 6 #149: claims serialize same-key processing across application instances.
-- Rollback: restore the pre-Phase 6 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table media.processing_commands add column failure_code text;
alter table media.processing_commands add constraint media_processing_commands_failure_code_safe
  check (failure_code is null or failure_code ~ '^MEDIA_[A-Z0-9_]{1,120}$');

create table media.processing_claims (
  portfolio_id uuid not null,
  owner_id uuid not null,
  media_id uuid not null references media.assets (media_id),
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  claim_id uuid not null unique check (claim_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  lease_expires_at timestamptz not null,
  primary key (portfolio_id, owner_id, media_id)
);

alter table media.processing_claims enable row level security;
alter table media.processing_claims force row level security;
grant select, insert, update, delete on media.processing_claims to shipwithali_application;
grant select on media.processing_claims to shipwithali_backup;
create policy media_processing_claims_owner_scope on media.processing_claims
  for all to shipwithali_application using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  ) with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );
create index media_processing_claims_expiry_idx on media.processing_claims (lease_expires_at);

reset role;
