-- Phase 8 #243: read Media acceptance metadata for portable Owner exports.
-- The worker can only read the current owner-scoped snapshot for this purpose.
-- No Media writes, private rejection rationale, or provider paths are granted.
-- Rollback: revoke the worker's column SELECT grants and drop these policies
-- and the scope predicate; no existing Owner or public access is changed.

set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;

create function media.owner_export_scope_is_valid(target_portfolio_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, portfolio_config
as $$
  select target_portfolio_id::text = nullif(current_setting('shipwithali.portfolio_id', true), '')
     and current_setting('shipwithali.worker_purpose', true) = 'media.owner-export'
     and exists (
       select 1 from portfolio_config.settings settings
        where settings.portfolio_id = target_portfolio_id
          and settings.owner_id::text = nullif(current_setting('shipwithali.owner_id', true), '')
     );
$$;

grant usage on schema media to shipwithali_worker;
grant select (media_id, portfolio_id, owner_id, aggregate_version, kind) on media.assets to shipwithali_worker;
grant select (media_id, portfolio_id, owner_id, aggregate_version, latest_attempt_id) on media.processing_states to shipwithali_worker;
grant select (media_id, portfolio_id, owner_id, lease_expires_at) on media.processing_claims to shipwithali_worker;
grant select (media_id, portfolio_id, owner_id, result, detected_mime_type, detected_byte_length, input_sha256, finding_codes, finished_at, attempt_id) on media.processing_attempts to shipwithali_worker;
grant select (media_id, portfolio_id, owner_id, aggregate_version, decision, decided_at, reason_code, input_object_id, input_sha256, detected_mime_type, detected_byte_length, scanner_version, processor_version, processing_policy_version, accessibility, sealed_outputs) on media.decision_history to shipwithali_worker;
grant select (media_id, portfolio_id, owner_id, aggregate_version, reason_code, rejected_at) on media.rejection_history to shipwithali_worker;
grant select (upload_intent_id, media_id, portfolio_id, owner_id, media_object_id) on media.upload_intents to shipwithali_worker;
grant select (object_id, media_id, portfolio_id, owner_id, sha256, byte_length, mime_type, object_version) on media.processed_objects to shipwithali_worker;
grant select (object_id, media_id, attempt_id, width, height, codec) on media.processing_attempt_outputs to shipwithali_worker;
grant select (object_id, media_id, attempt_id, width, height) on media.processing_attempt_variants to shipwithali_worker;

revoke all on function media.owner_export_scope_is_valid(uuid)
  from public, anon, authenticated, shipwithali_application, shipwithali_backup;
grant execute on function media.owner_export_scope_is_valid(uuid) to shipwithali_worker;

create policy media_assets_worker_owner_export on media.assets
  for select to shipwithali_worker using (media.owner_export_scope_is_valid(portfolio_id));
create policy media_processing_states_worker_owner_export on media.processing_states
  for select to shipwithali_worker using (media.owner_export_scope_is_valid(portfolio_id));
create policy media_processing_claims_worker_owner_export on media.processing_claims
  for select to shipwithali_worker using (media.owner_export_scope_is_valid(portfolio_id));
create policy media_processing_attempts_worker_owner_export on media.processing_attempts
  for select to shipwithali_worker using (media.owner_export_scope_is_valid(portfolio_id));
create policy media_decision_history_worker_owner_export on media.decision_history
  for select to shipwithali_worker using (media.owner_export_scope_is_valid(portfolio_id));
create policy media_rejection_history_worker_owner_export on media.rejection_history
  for select to shipwithali_worker using (media.owner_export_scope_is_valid(portfolio_id));
create policy media_processed_objects_worker_owner_export on media.processed_objects
  for select to shipwithali_worker using (media.owner_export_scope_is_valid(portfolio_id));
create policy media_processing_attempt_outputs_worker_owner_export on media.processing_attempt_outputs
  for select to shipwithali_worker using (media.owner_export_scope_is_valid(portfolio_id));
create policy media_processing_attempt_variants_worker_owner_export on media.processing_attempt_variants
  for select to shipwithali_worker using (media.owner_export_scope_is_valid(portfolio_id));
create policy media_upload_intents_worker_owner_export on media.upload_intents
  for select to shipwithali_worker using (media.owner_export_scope_is_valid(portfolio_id));

comment on function media.owner_export_scope_is_valid(uuid) is
  'Purpose-limited Media export predicate; requires transaction-local portfolio, Owner, and media.owner-export purpose.';
comment on policy media_rejection_history_worker_owner_export on media.rejection_history is
  'Owner export reads only sanitized reason codes; private_reason has no worker column grant.';

reset role;
