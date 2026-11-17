-- #303 shared public Reaction abuse control.
-- Rollback: disable Reaction HTTP assembly and retain limiter history.
-- Forward fix: repair with a later additive migration; do not drop this table in production.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

create table identity_access.public_rate_limit_windows (
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  operation text not null check (operation = 'putProjectReaction'),
  window_started_at timestamptz not null,
  request_count smallint not null check (request_count between 1 and 31),
  primary key (subject_hash, operation, window_started_at)
);
create index public_rate_limit_windows_expiry_idx
  on identity_access.public_rate_limit_windows (window_started_at);

alter table identity_access.public_rate_limit_windows enable row level security;
alter table identity_access.public_rate_limit_windows force row level security;
create policy public_rate_limit_windows_migration_policy
  on identity_access.public_rate_limit_windows
  for all to shipwithali_migration using (true) with check (true);
revoke all on identity_access.public_rate_limit_windows
  from public, anon, authenticated, shipwithali_application, shipwithali_worker, shipwithali_backup;

create or replace function identity_access.check_public_reaction_rate_limit(
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
  if p_subject_hash is null or p_subject_hash !~ '^[0-9a-f]{64}$' or
      p_operation is distinct from 'putProjectReaction' then
    raise exception using errcode = '22023', message = 'invalid rate limit scope';
  end if;

  v_window := to_timestamp(floor(extract(epoch from v_now) / 60) * 60);

  delete from identity_access.public_rate_limit_windows
  where window_started_at < v_now - interval '24 hours'
    and ctid in (
      select ctid from identity_access.public_rate_limit_windows
      where window_started_at < v_now - interval '24 hours'
      order by window_started_at
      limit 64
    );

  insert into identity_access.public_rate_limit_windows (
    subject_hash, operation, window_started_at, request_count
  ) values (p_subject_hash, p_operation, v_window, 1)
  on conflict (subject_hash, operation, window_started_at)
  do update set request_count = least(
    identity_access.public_rate_limit_windows.request_count + 1, 31
  )
  returning request_count into v_count;

  return query select v_count <= 30,
    greatest(1, ceil(extract(epoch from (v_window + interval '60 seconds' - v_now)))::integer);
end;
$$;

revoke all on function identity_access.check_public_reaction_rate_limit(text, text)
  from public, anon, authenticated, shipwithali_worker, shipwithali_backup;
grant execute on function identity_access.check_public_reaction_rate_limit(text, text)
  to shipwithali_application;

reset role;
