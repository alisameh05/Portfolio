-- #193 expand-only retained Owner decisions. Approval is eligibility, never publication.
-- Rollback: disable moderation assembly; preserve Feedback/history and forward fix.
-- The CLI generated a timestamp before the already committed #192 migration;
-- moved this file after that prerequisite to preserve clean/upgrade ordering.
set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;
alter table interaction.feedback add column approved_at timestamptz;
alter table interaction.feedback add constraint feedback_scope_identity unique (portfolio_id, feedback_id);
create table interaction.moderation_decisions (
  decision_id uuid primary key check (decision_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  portfolio_id uuid not null,
  feedback_id uuid not null,
  sequence bigint not null check (sequence >= 1),
  decision text not null check (decision in ('approved','rejected','suppressed')),
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  owner_id uuid not null check (owner_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  decided_at timestamptz not null,
  unique (portfolio_id, feedback_id, sequence),
  foreign key (portfolio_id, feedback_id) references interaction.feedback (portfolio_id, feedback_id) on delete cascade
);
create index feedback_approved_locale on interaction.feedback (portfolio_id, project_id, locale, approved_at desc, feedback_id desc) where moderation_state = 'approved';
alter table interaction.moderation_decisions enable row level security;
alter table interaction.moderation_decisions force row level security;
revoke all on interaction.moderation_decisions from public, anon, authenticated, shipwithali_application, shipwithali_worker, shipwithali_backup;
grant select, insert on interaction.moderation_decisions to shipwithali_application;
grant select on interaction.feedback to shipwithali_application;
grant update (moderation_state, aggregate_version, approved_at) on interaction.feedback to shipwithali_application;
-- Server-only, transaction-local scopes. Anonymous/authenticated Data API roles have no grants.
create policy feedback_owner_read on interaction.feedback for select to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and current_setting('shipwithali.feedback_access', true) = 'owner'
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = feedback.portfolio_id and s.owner_id::text = current_setting('shipwithali.owner_id', true)));
create policy feedback_owner_update on interaction.feedback for update to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and current_setting('shipwithali.feedback_access', true) = 'owner'
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = feedback.portfolio_id and s.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and current_setting('shipwithali.feedback_access', true) = 'owner'
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = feedback.portfolio_id and s.owner_id::text = current_setting('shipwithali.owner_id', true)));
create policy moderation_owner_read on interaction.moderation_decisions for select to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and current_setting('shipwithali.feedback_access', true) = 'owner'
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = moderation_decisions.portfolio_id and s.owner_id::text = current_setting('shipwithali.owner_id', true)));
create policy moderation_owner_append on interaction.moderation_decisions for insert to shipwithali_application
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
    and current_setting('shipwithali.feedback_access', true) = 'owner'
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = moderation_decisions.portfolio_id and s.owner_id = moderation_decisions.owner_id));
-- Only approved exact-locale text can enter the in-process public projection.
-- Content locks/checks are held by the application, and this policy independently checks visibility.
create policy feedback_public_approved on interaction.feedback for select to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and current_setting('shipwithali.feedback_access', true) = 'public' and moderation_state = 'approved'
    and exists (select 1 from content.items i where i.portfolio_id = feedback.portfolio_id and i.content_id = feedback.project_id and i.content_type = 'project' and i.lifecycle = 'published')
    and exists (select 1 from content.language_publications p where p.portfolio_id = feedback.portfolio_id and p.content_id = feedback.project_id and p.locale = feedback.locale));
reset role;
