-- Phase 4 #80 narrow private Owner identity mapping.
-- Rollback: restore the pre-Phase 4 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.
--
-- Stores only the narrowly necessary private mapping from an immutable GitHub
-- subject (from trusted provider identity records) to the stable domain Owner.
-- Stable Owner identity survives session and provider-record changes: sessions
-- rotate and provider records refresh, while github_subject and owner_id stay
-- stable. No raw session tokens, cookies, JWTs, emails, usernames,
-- user-editable metadata, or provider payloads are stored here.

set lock_timeout = '5s';

-- Membership persists from the security-baseline migration; re-granting keeps
-- this migration applicable on its own when the executor administers schema.
grant shipwithali_migration to current_user;

set role shipwithali_migration;

create table identity_access.owner_links (
  github_subject text primary key check (github_subject <> ''),
  owner_id uuid not null,
  created_at timestamptz not null default transaction_timestamp(),
  last_seen_at timestamptz not null default transaction_timestamp()
);

comment on table identity_access.owner_links is
  'Phase 4 #80 private mapping: immutable GitHub subject to stable Owner.';
comment on column identity_access.owner_links.github_subject is
  'Immutable GitHub subject from trusted provider identity records only.';
comment on column identity_access.owner_links.owner_id is
  'Stable domain Owner identity; unchanged by session or provider refresh.';

alter table identity_access.owner_links enable row level security;
alter table identity_access.owner_links force row level security;

grant usage on schema identity_access to shipwithali_application, shipwithali_backup;
grant select, insert, update on identity_access.owner_links to shipwithali_application;
grant select on identity_access.owner_links to shipwithali_backup;

create policy owner_links_application_select_policy on identity_access.owner_links
  for select to shipwithali_application using (true);
create policy owner_links_application_insert_policy on identity_access.owner_links
  for insert to shipwithali_application with check (true);
create policy owner_links_application_update_policy on identity_access.owner_links
  for update to shipwithali_application using (true) with check (true);
create policy owner_links_backup_policy on identity_access.owner_links
  for select to shipwithali_backup using (true);

revoke all on identity_access.owner_links
  from public, anon, authenticated;

reset role;
