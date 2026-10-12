-- Phase 6 #155: retain explicit CV editorial approval bound to immutable Media output.
-- Rollback: restore the pre-Phase 6 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table cv_portfolio.versions
  add column media_decision_id uuid,
  add column media_object_id uuid,
  add column media_sha256 text,
  add column media_object_version text;

do $$
begin
  if exists (
    select version.version_id
      from cv_portfolio.versions version
      left join lateral (
        select decision.decision_id, object.object_id
          from media.decision_history decision
          join media.processed_objects object
            on object.media_id = decision.media_id
           and object.portfolio_id = decision.portfolio_id
           and object.owner_id = decision.owner_id
           and object.mime_type = 'application/pdf'
           and exists (
             select 1 from jsonb_array_elements(decision.sealed_outputs) output
              where output->>'objectId' = object.object_id::text
                and output->>'sha256' = object.sha256
                and output->>'objectVersion' = object.object_version
                and output->>'mimeType' = 'application/pdf'
           )
         where decision.media_id = version.media_id
           and decision.portfolio_id = version.portfolio_id
           and decision.owner_id = version.owner_id
           and decision.aggregate_version = version.media_asset_version
           and decision.decision = 'accepted'
      ) snapshot on true
     group by version.version_id
    having count(snapshot.object_id) <> 1
  ) then
    raise exception 'CV_ACCEPTANCE_SNAPSHOT_BACKFILL_INVALID';
  end if;
end $$;

update cv_portfolio.versions version
   set media_decision_id = decision.decision_id,
       media_object_id = object.object_id,
       media_sha256 = object.sha256,
       media_object_version = object.object_version
  from media.decision_history decision
  join media.processed_objects object
    on object.media_id = decision.media_id
   and object.portfolio_id = decision.portfolio_id
   and object.owner_id = decision.owner_id
   and object.mime_type = 'application/pdf'
   and exists (
     select 1 from jsonb_array_elements(decision.sealed_outputs) output
      where output->>'objectId' = object.object_id::text
        and output->>'sha256' = object.sha256
        and output->>'objectVersion' = object.object_version
        and output->>'mimeType' = 'application/pdf'
   )
 where decision.media_id = version.media_id
   and decision.portfolio_id = version.portfolio_id
   and decision.owner_id = version.owner_id
   and decision.aggregate_version = version.media_asset_version
   and decision.decision = 'accepted';

alter table cv_portfolio.versions
  alter column media_decision_id set not null,
  alter column media_object_id set not null,
  alter column media_sha256 set not null,
  alter column media_object_version set not null,
  add constraint cv_versions_media_sha256_check check (media_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint cv_versions_media_object_version_check check (length(media_object_version) between 1 and 255),
  add constraint cv_versions_media_decision_fk foreign key (media_decision_id)
    references media.decision_history (decision_id),
  add constraint cv_versions_media_object_scope_fk foreign key (media_object_id, media_id, portfolio_id, owner_id)
    references media.processed_objects (object_id, media_id, portfolio_id, owner_id),
  add constraint cv_versions_media_snapshot_unique unique
    (version_id, portfolio_id, owner_id, media_decision_id, media_object_id, media_sha256, media_object_version);

create table cv_portfolio.acceptance_history (
  approval_id uuid primary key
    check (approval_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  portfolio_id uuid not null,
  owner_id uuid not null,
  version_id uuid not null,
  media_decision_id uuid not null references media.decision_history (decision_id),
  media_object_id uuid not null,
  media_sha256 text not null check (media_sha256 ~ '^[0-9a-f]{64}$'),
  media_object_version text not null check (length(media_object_version) between 1 and 255),
  accepted_by uuid not null,
  accepted_at timestamptz not null default transaction_timestamp(),
  unique (version_id),
  foreign key (version_id, portfolio_id, owner_id, media_decision_id, media_object_id, media_sha256, media_object_version)
    references cv_portfolio.versions
      (version_id, portfolio_id, owner_id, media_decision_id, media_object_id, media_sha256, media_object_version),
  check (accepted_by = owner_id)
);

create table cv_portfolio.acceptance_commands (
  portfolio_id uuid not null,
  owner_id uuid not null,
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  version_id uuid not null,
  aggregate_version integer not null check (aggregate_version > 1),
  created_at timestamptz not null default transaction_timestamp(),
  primary key (portfolio_id, owner_id, idempotency_key_hash),
  foreign key (portfolio_id, owner_id) references cv_portfolio.portfolios (portfolio_id, owner_id),
  foreign key (version_id, portfolio_id, owner_id)
    references cv_portfolio.versions (version_id, portfolio_id, owner_id)
);

comment on table cv_portfolio.acceptance_history is
  'Append-only CV editorial approval history bound to the exact accepted Media decision and immutable PDF output snapshot.';
comment on table cv_portfolio.acceptance_commands is
  'Safe exact-replay receipts for CV acceptance. Idempotency keys are stored only as SHA-256 digests.';

create index cv_acceptance_history_owner_recent_idx
  on cv_portfolio.acceptance_history (portfolio_id, owner_id, accepted_at desc, approval_id desc);

create policy cv_acceptance_history_owner_scope on cv_portfolio.acceptance_history
  for all to shipwithali_application using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  ) with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );

create policy cv_acceptance_commands_owner_scope on cv_portfolio.acceptance_commands
  for all to shipwithali_application using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  ) with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );

alter table cv_portfolio.acceptance_history enable row level security;
alter table cv_portfolio.acceptance_history force row level security;
alter table cv_portfolio.acceptance_commands enable row level security;
alter table cv_portfolio.acceptance_commands force row level security;

revoke all on cv_portfolio.acceptance_history, cv_portfolio.acceptance_commands
  from public, anon, authenticated, shipwithali_worker, shipwithali_backup;
revoke update on cv_portfolio.versions from shipwithali_application;
grant update (state) on cv_portfolio.versions to shipwithali_application;
grant select, insert on cv_portfolio.acceptance_history, cv_portfolio.acceptance_commands to shipwithali_application;

reset role;
