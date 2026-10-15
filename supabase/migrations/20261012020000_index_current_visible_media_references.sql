-- Phase 6 #153 indexes authoritative revision evidence lookups for visible Media usage.
-- Rollback: drop the index before restoring the pre-Phase-6 migration snapshot.
-- Forward fix: add a new timestamped migration with the corrected lookup expression.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

create index content_revision_media_artifacts_lookup
  on content.revisions using gin ((payload #> '{evidence,artifacts}') jsonb_path_ops)
  where content_type in ('project', 'achievement');

reset role;
