-- Phase 6 #157: retain private Media rejection and block withdrawal while public use remains.
-- Rollback: restore the pre-Phase-6 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table media.acceptance_commands
  drop constraint acceptance_commands_outcome_check;
alter table media.acceptance_commands
  add constraint media_acceptance_commands_outcome_check
  check (outcome in ('media-accepted', 'media-rejected'));

create table media.rejection_history (
  rejection_id uuid primary key
    check (rejection_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  portfolio_id uuid not null,
  owner_id uuid not null,
  media_id uuid not null,
  aggregate_version integer not null check (aggregate_version > 1),
  reason_code text not null default 'OWNER_REJECTED' check (reason_code = 'OWNER_REJECTED'),
  private_reason text not null check (char_length(btrim(private_reason)) between 1 and 1000),
  rejected_by uuid not null,
  rejected_at timestamptz not null default transaction_timestamp(),
  unique (media_id, aggregate_version),
  foreign key (media_id, portfolio_id, owner_id) references media.assets (media_id, portfolio_id, owner_id),
  check (rejected_by = owner_id)
);

comment on table media.rejection_history is
  'Append-only private Owner rejection rationale. Outbox events and command receipts expose only stable IDs and reason codes.';
comment on column media.rejection_history.private_reason is
  'Private editorial rationale. Never copy into public DTOs, logs, command receipts, or outbox payloads.';

alter table media.rejection_history enable row level security;
alter table media.rejection_history force row level security;
grant select, insert on media.rejection_history to shipwithali_application;
grant select on media.rejection_history to shipwithali_backup;
revoke all on media.rejection_history from public, anon, authenticated;
revoke update, delete, truncate, references, trigger on media.rejection_history from shipwithali_application;

create policy media_rejection_history_owner_scope on media.rejection_history
  for all to shipwithali_application using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  ) with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );

create policy media_rejection_history_backup on media.rejection_history
  for select to shipwithali_backup using (true);

create index media_rejection_history_owner_idx
  on media.rejection_history (portfolio_id, owner_id, media_id, aggregate_version desc);

reset role;
