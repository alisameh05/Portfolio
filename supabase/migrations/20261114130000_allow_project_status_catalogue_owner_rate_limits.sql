-- Phase 9 #298 extends the Owner rate-limit boundary to Project status catalogue operations.
-- Rollback: roll back the #298 routes and application allowlist; retain this additive database allowlist and its history.
-- Forward fix: correct defects with a new timestamped additive migration.

set lock_timeout = '5s';

begin;

set local role shipwithali_migration;

alter table identity_access.owner_configuration_limit_windows
  drop constraint owner_configuration_limit_windows_operation_check;
alter table identity_access.owner_configuration_limit_windows
  add constraint owner_configuration_limit_windows_operation_check check (operation in (
    'updateOwnerProfileConfiguration',
    'updateOwnerContactChannels',
    'updateOwnerGlobalProjectCta',
    'createOwnerContent',
    'getOwnerContentAggregate',
    'saveOwnerContentRevision',
    'previewOwnerContentRevision',
    'reviewOwnerContentRevision',
    'getOwnerContentHistory',
    'publishOwnerContentLanguage',
    'hideOwnerContent',
    'archiveOwnerContent',
    'restoreOwnerContent',
    'getOwnerProjectAggregate',
    'changeOwnerProjectStatus',
    'setOwnerProjectFeatured',
    'changeOwnerProjectPublicSlug',
    'correctOwnerProjectCandidateSlug',
    'relateOwnerProjects',
    'listOwnerProjectStatusValues',
    'createOwnerProjectStatusValue',
    'renameOwnerProjectStatusValue',
    'retireOwnerProjectStatusValue'
  ));

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
    'updateOwnerGlobalProjectCta',
    'createOwnerContent',
    'getOwnerContentAggregate',
    'saveOwnerContentRevision',
    'previewOwnerContentRevision',
    'reviewOwnerContentRevision',
    'getOwnerContentHistory',
    'publishOwnerContentLanguage',
    'hideOwnerContent',
    'archiveOwnerContent',
    'restoreOwnerContent',
    'getOwnerProjectAggregate',
    'changeOwnerProjectStatus',
    'setOwnerProjectFeatured',
    'changeOwnerProjectPublicSlug',
    'correctOwnerProjectCandidateSlug',
    'relateOwnerProjects',
    'listOwnerProjectStatusValues',
    'createOwnerProjectStatusValue',
    'renameOwnerProjectStatusValue',
    'retireOwnerProjectStatusValue'
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

reset role;

commit;
