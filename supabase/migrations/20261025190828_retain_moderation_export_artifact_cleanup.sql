-- #245 repair: durable deletion retry/tombstone for owned Moderation ZIPs.
-- Expand-compatible; no foreign-module writes or additional grants.
-- Rollback: stop export workers and restore the pre-migration portability snapshot.
set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;
alter table portability.owner_exports
  add column artifact_revoked_at timestamptz,
  add column artifact_deleted_at timestamptz,
  add constraint owner_exports_artifact_cleanup_state check (
    (artifact_revoked_at is null and artifact_deleted_at is null)
    or (artifact_revoked_at is not null and candidate_artifact_id is not null
      and status in ('failed', 'expired')
      and (artifact_deleted_at is null or artifact_deleted_at >= artifact_revoked_at))
  );
create index owner_exports_moderation_cleanup on portability.owner_exports (portfolio_id, owner_id, export_id)
  where included_scopes @> array['moderation-history']::text[]
    and candidate_artifact_id is not null and artifact_deleted_at is null;
comment on column portability.owner_exports.artifact_revoked_at is
  'Durable access/upload fence committed before external ZIP deletion; contains no Feedback text.';
comment on column portability.owner_exports.artifact_deleted_at is
  'Storage deletion acknowledged; null after revocation means deletion must retry.';
reset role;
