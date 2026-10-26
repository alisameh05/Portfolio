-- Phase 8 #246: keep Analytics owner-export reads from authorizing DELETE.
-- WITH CHECK protects INSERT/UPDATE; DELETE needs its own restrictive USING fence.
-- Rollback: stop Analytics export assembly before dropping these two policies.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

create policy daily_aggregates_worker_delete_purpose_fence on measurement.daily_aggregates
  as restrictive for delete to shipwithali_worker
  using (
    current_setting('shipwithali.worker_purpose', true) in ('measurement.aggregate', 'measurement.retention')
    and portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid
  );

create policy daily_aggregate_checkpoints_worker_delete_purpose_fence on measurement.daily_aggregate_checkpoints
  as restrictive for delete to shipwithali_worker
  using (
    current_setting('shipwithali.worker_purpose', true) in ('measurement.aggregate', 'measurement.retention')
    and portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid
  );

reset role;
