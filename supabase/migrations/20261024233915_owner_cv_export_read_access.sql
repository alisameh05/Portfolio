-- Phase 8 #244: allow the leased export worker to read a bounded CV snapshot
-- only for the current Owner Portfolio and the explicit cv.owner-export purpose.
-- No CV writes, idempotency receipts, or actor identity are exposed.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

create function cv_portfolio.owner_export_scope_is_valid(target_portfolio_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, portfolio_config
as $$
  select target_portfolio_id::text = nullif(current_setting('shipwithali.portfolio_id', true), '')
     and current_setting('shipwithali.worker_purpose', true) = 'cv.owner-export'
     and exists (
       select 1 from portfolio_config.settings settings
        where settings.portfolio_id = target_portfolio_id
          and settings.owner_id::text = nullif(current_setting('shipwithali.owner_id', true), '')
     );
$$;

grant usage on schema cv_portfolio to shipwithali_worker;
revoke all on function cv_portfolio.owner_export_scope_is_valid(uuid)
  from public, anon, authenticated, shipwithali_application, shipwithali_backup;
grant execute on function cv_portfolio.owner_export_scope_is_valid(uuid) to shipwithali_worker;

revoke all on cv_portfolio.portfolios, cv_portfolio.versions,
  cv_portfolio.acceptance_history, cv_portfolio.activation_history
  from public, anon, authenticated, shipwithali_worker, shipwithali_backup;
grant select (portfolio_id, owner_id, aggregate_version, current_version_id)
  on cv_portfolio.portfolios to shipwithali_worker;
grant select (version_id, portfolio_id, owner_id, media_id, media_asset_version,
  version_number, locale, label, state, registered_at, is_current, media_decision_id,
  media_object_id, media_sha256, media_object_version)
  on cv_portfolio.versions to shipwithali_worker;
grant select (approval_id, portfolio_id, owner_id, version_id, media_decision_id,
  media_object_id, media_sha256, media_object_version, accepted_at)
  on cv_portfolio.acceptance_history to shipwithali_worker;
grant select (activation_id, portfolio_id, owner_id, version_id, activated_at)
  on cv_portfolio.activation_history to shipwithali_worker;

-- CV stores the accepted Media decision identity. The scoped Media snapshot
-- reader needs that identity to prove the exact sealed PDF binding; the
-- existing Media owner-export RLS policy still gates the row read.
grant select (decision_id) on media.decision_history to shipwithali_worker;

create policy cv_portfolios_worker_owner_export on cv_portfolio.portfolios
  for select to shipwithali_worker
  using (cv_portfolio.owner_export_scope_is_valid(portfolio_id));
create policy cv_versions_worker_owner_export on cv_portfolio.versions
  for select to shipwithali_worker
  using (cv_portfolio.owner_export_scope_is_valid(portfolio_id));
create policy cv_acceptance_history_worker_owner_export on cv_portfolio.acceptance_history
  for select to shipwithali_worker
  using (cv_portfolio.owner_export_scope_is_valid(portfolio_id));
create policy cv_activation_history_worker_owner_export on cv_portfolio.activation_history
  for select to shipwithali_worker
  using (cv_portfolio.owner_export_scope_is_valid(portfolio_id));

comment on function cv_portfolio.owner_export_scope_is_valid(uuid) is
  'Purpose-limited CV export predicate; requires the transaction-local portfolio, Owner, and cv.owner-export purpose.';
comment on policy cv_versions_worker_owner_export on cv_portfolio.versions is
  'Worker CV export reads only the active Owner Portfolio version snapshot; no write policy is added.';

reset role;
