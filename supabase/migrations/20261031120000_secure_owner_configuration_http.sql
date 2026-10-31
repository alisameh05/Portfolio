-- Phase 9 #294 secure Owner configuration HTTP composition.
-- Rollback: restore the pre-Phase 9 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped additive migration.
--
-- The Auth lookup only returns an active session's trusted GitHub identity
-- linked to the configured stable Owner. The limiter persists hashed Owner
-- subjects for a fixed, database-clock window and exposes only one bounded
-- operation through a narrowly granted function.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

reset role;
grant select (id, user_id) on auth.sessions to shipwithali_migration;
grant select (user_id, provider, provider_id) on auth.identities to shipwithali_migration;
set role shipwithali_migration;

create policy owner_links_migration_select_policy on identity_access.owner_links
  for select to shipwithali_migration using (true);

create or replace function identity_access.owner_session_is_active(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, auth
as $$
  select exists (select 1 from auth.sessions as s where s.id = p_session_id)
$$;

revoke all on function identity_access.owner_session_is_active(uuid)
  from public, anon, authenticated;
grant execute on function identity_access.owner_session_is_active(uuid)
  to shipwithali_application;

create or replace function identity_access.resolve_owner_session_identity(
  p_user_id uuid,
  p_session_id uuid
)
returns table(provider text, subject text, owner_id uuid)
language sql
stable
security definer
set search_path = pg_catalog, auth, identity_access
as $$
  select i.provider::text, i.provider_id::text, l.owner_id
  from auth.sessions as s
  join auth.identities as i on i.user_id = s.user_id and i.provider = 'github'
  join identity_access.owner_links as l on l.github_subject = i.provider_id
  where s.id = p_session_id
    and s.user_id = p_user_id
$$;

revoke all on function identity_access.resolve_owner_session_identity(uuid, uuid)
  from public, anon, authenticated;
grant execute on function identity_access.resolve_owner_session_identity(uuid, uuid)
  to shipwithali_application;

create table identity_access.owner_configuration_limit_windows (
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  operation text not null check (operation in (
    'updateOwnerProfileConfiguration',
    'updateOwnerContactChannels',
    'updateOwnerGlobalProjectCta'
  )),
  window_started_at timestamptz not null,
  request_count smallint not null check (request_count between 1 and 31),
  primary key (subject_hash, operation, window_started_at)
);
create index owner_configuration_limit_windows_expiry_idx
  on identity_access.owner_configuration_limit_windows (window_started_at);

alter table identity_access.owner_configuration_limit_windows enable row level security;
alter table identity_access.owner_configuration_limit_windows force row level security;
create policy owner_configuration_limit_migration_policy
  on identity_access.owner_configuration_limit_windows
  for all to shipwithali_migration using (true) with check (true);
revoke all on identity_access.owner_configuration_limit_windows
  from public, anon, authenticated, shipwithali_application, shipwithali_worker, shipwithali_backup;

create or replace function identity_access.check_owner_configuration_rate_limit(
  p_subject_hash text,
  p_operation text
)
returns table(allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = pg_catalog, identity_access
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window timestamptz;
  v_count smallint;
begin
  if p_subject_hash !~ '^[0-9a-f]{64}$' or p_operation not in (
    'updateOwnerProfileConfiguration',
    'updateOwnerContactChannels',
    'updateOwnerGlobalProjectCta'
  ) then
    raise exception using errcode = '22023', message = 'invalid rate limit scope';
  end if;

  v_window := to_timestamp(floor(extract(epoch from v_now) / 60) * 60);

  delete from identity_access.owner_configuration_limit_windows
  where window_started_at < v_now - interval '24 hours'
    and ctid in (
      select ctid from identity_access.owner_configuration_limit_windows
      where window_started_at < v_now - interval '24 hours'
      order by window_started_at
      limit 64
    );

  insert into identity_access.owner_configuration_limit_windows (
    subject_hash, operation, window_started_at, request_count
  ) values (p_subject_hash, p_operation, v_window, 1)
  on conflict (subject_hash, operation, window_started_at)
  do update set request_count = least(
    identity_access.owner_configuration_limit_windows.request_count + 1, 31
  )
  returning request_count into v_count;

  return query select v_count <= 30,
    greatest(1, ceil(extract(epoch from (v_window + interval '60 seconds' - v_now)))::integer);
end;
$$;

revoke all on function identity_access.check_owner_configuration_rate_limit(text, text)
  from public, anon, authenticated, shipwithali_worker, shipwithali_backup;
grant execute on function identity_access.check_owner_configuration_rate_limit(text, text)
  to shipwithali_application;

reset role;
