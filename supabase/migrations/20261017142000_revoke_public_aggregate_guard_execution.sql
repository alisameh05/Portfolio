-- Phase 7 predecessor correction: preserve the released migration ledger and
-- remove the trigger guard's implicit PUBLIC EXECUTE on existing installations.
-- Rollback: retain this denial; older application versions need no direct
-- invocation of a trigger-only function. Do not restore PUBLIC EXECUTE.
-- Forward fix: apply a reviewed additive ACL correction if access needs evolve.
set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;
revoke all on function measurement.prevent_sealed_aggregate_checkpoint_rewrite()
  from public, anon, authenticated, shipwithali_application, shipwithali_backup;
reset role;
