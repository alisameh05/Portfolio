-- #247: expiry and privacy reconciliation covers every registered export scope.
-- Narrow worker/backup ledger access only; no application grants or foreign-module writes.
-- Rollback: stop export workers and restore the pre-migration portability snapshot.
set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;
drop index portability.owner_exports_moderation_cleanup;
alter table portability.owner_exports
  add column artifact_revocation_code text;
grant select, update (artifact_revocation_code) on portability.owner_exports to shipwithali_migration;
create policy owner_exports_migration_revocation_backfill_select on portability.owner_exports
  for select to shipwithali_migration using (true);
create policy owner_exports_migration_revocation_backfill_update on portability.owner_exports
  for update to shipwithali_migration using (true) with check (true);
update portability.owner_exports set artifact_revocation_code =
  'prior_revocation'
  where artifact_revoked_at is not null;
drop policy owner_exports_migration_revocation_backfill_update on portability.owner_exports;
revoke update (artifact_revocation_code) on portability.owner_exports from shipwithali_migration;
alter table portability.owner_exports
  add constraint owner_exports_artifact_revocation_code_check check (
    (artifact_revoked_at is null and artifact_revocation_code is null)
    or (artifact_revoked_at is not null and artifact_revocation_code in ('expired', 'privacy_invalid', 'build_failed', 'prior_revocation'))
  );
create table portability.owner_export_invalidation_ledger (
  export_id uuid primary key
    check (export_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  portfolio_id uuid not null,
  artifact_id uuid not null
    check (artifact_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  revoked_at timestamptz not null,
  revocation_code text not null check (revocation_code in ('expired', 'privacy_invalid', 'build_failed', 'prior_revocation')),
  artifact_deleted_at timestamptz,
  check (artifact_deleted_at is null or artifact_deleted_at >= revoked_at)
);
comment on table portability.owner_export_invalidation_ledger is
  'Protected minimal current invalidation/deletion ledger for restore-quarantine reconciliation; no Visitor or Feedback fields.';
insert into portability.owner_export_invalidation_ledger (
  export_id, portfolio_id, artifact_id, revoked_at, revocation_code, artifact_deleted_at
)
select export_id, portfolio_id, candidate_artifact_id, artifact_revoked_at,
  artifact_revocation_code, artifact_deleted_at
from portability.owner_exports
where artifact_revoked_at is not null and candidate_artifact_id is not null;
-- FORCE RLS also applies to the restricted table owner. Retain both read
-- permissions until the ledger has copied prior revocations and deletions.
drop policy owner_exports_migration_revocation_backfill_select on portability.owner_exports;
revoke select on portability.owner_exports from shipwithali_migration;
alter table portability.owner_export_invalidation_ledger enable row level security;
alter table portability.owner_export_invalidation_ledger force row level security;
grant select on portability.owner_export_invalidation_ledger to shipwithali_worker;
grant insert (export_id, portfolio_id, artifact_id, revoked_at, revocation_code)
  on portability.owner_export_invalidation_ledger to shipwithali_worker;
grant update (artifact_deleted_at) on portability.owner_export_invalidation_ledger to shipwithali_worker;
grant select on portability.owner_export_invalidation_ledger to shipwithali_backup;
create policy owner_export_invalidation_ledger_worker_select on portability.owner_export_invalidation_ledger
  for select to shipwithali_worker using (true);
create policy owner_export_invalidation_ledger_worker_insert on portability.owner_export_invalidation_ledger
  for insert to shipwithali_worker with check (
    artifact_deleted_at is null and exists (
      select 1 from portability.owner_exports export
       where export.export_id = owner_export_invalidation_ledger.export_id
         and export.portfolio_id = owner_export_invalidation_ledger.portfolio_id
         and export.candidate_artifact_id = owner_export_invalidation_ledger.artifact_id
         and export.artifact_revoked_at = owner_export_invalidation_ledger.revoked_at
         and export.artifact_revocation_code = owner_export_invalidation_ledger.revocation_code
         and export.artifact_deleted_at is null
         and export.status in ('failed', 'expired')
    )
  );
create policy owner_export_invalidation_ledger_worker_update on portability.owner_export_invalidation_ledger
  for update to shipwithali_worker using (artifact_deleted_at is null) with check (
    artifact_deleted_at is not null and artifact_deleted_at >= revoked_at and exists (
      select 1 from portability.owner_exports export
       where export.export_id = owner_export_invalidation_ledger.export_id
         and export.portfolio_id = owner_export_invalidation_ledger.portfolio_id
         and export.candidate_artifact_id = owner_export_invalidation_ledger.artifact_id
         and export.artifact_revoked_at = owner_export_invalidation_ledger.revoked_at
         and export.artifact_revocation_code = owner_export_invalidation_ledger.revocation_code
         and export.artifact_deleted_at = owner_export_invalidation_ledger.artifact_deleted_at
         and export.status in ('failed', 'expired')
    )
  );
create policy owner_export_invalidation_ledger_backup_select on portability.owner_export_invalidation_ledger
  for select to shipwithali_backup using (true);
revoke all on portability.owner_export_invalidation_ledger from public, anon, authenticated, shipwithali_application;
create index owner_export_invalidation_ledger_portfolio_export
  on portability.owner_export_invalidation_ledger (portfolio_id, export_id);
create index owner_exports_artifact_cleanup on portability.owner_exports (portfolio_id, owner_id, export_id)
  where candidate_artifact_id is not null and artifact_deleted_at is null;
reset role;
