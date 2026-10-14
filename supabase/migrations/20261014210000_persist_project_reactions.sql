-- #190 expand-only scoped current Reactions. No functional subjects in outbox.
-- Rollback: disable Reaction assembly and retain rows; forward fix via new migration.
set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;
create table interaction.reactions (
  portfolio_id uuid not null check (portfolio_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  project_id uuid not null check (project_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  visitor_id uuid not null check (visitor_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  kind text not null check (kind in ('like', 'dislike')),
  updated_at timestamptz not null,
  primary key (portfolio_id, project_id, visitor_id)
);
-- No cross-module FK: Content application owns eligibility/serialization.
alter table interaction.reactions enable row level security;
alter table interaction.reactions force row level security;
grant usage on schema interaction to shipwithali_application;
grant select, insert, update on interaction.reactions to shipwithali_application;
create policy reactions_application_scope on interaction.reactions
  for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and visitor_id::text = current_setting('shipwithali.functional_id', true))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and visitor_id::text = current_setting('shipwithali.functional_id', true));
revoke all on interaction.reactions from public, anon, authenticated, shipwithali_worker, shipwithali_backup;
reset role;
