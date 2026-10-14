-- #191 expand-only scoped current Ratings. No functional subjects in outbox.
-- Rollback: disable Rating assembly and retain rows; forward fix via new migration.
set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;
create table interaction.ratings (
  portfolio_id uuid not null check (portfolio_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  project_id uuid not null check (project_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  visitor_id uuid not null check (visitor_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  value smallint not null check (value between 1 and 5),
  updated_at timestamptz not null,
  primary key (portfolio_id, project_id, visitor_id)
);
-- No cross-module FK: Content application owns eligibility/serialization.
alter table interaction.ratings enable row level security;
alter table interaction.ratings force row level security;
grant usage on schema interaction to shipwithali_application;
grant select, insert, update on interaction.ratings to shipwithali_application;
create policy ratings_application_scope on interaction.ratings
  for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and visitor_id::text = current_setting('shipwithali.functional_id', true))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and visitor_id::text = current_setting('shipwithali.functional_id', true));
revoke all on interaction.ratings from public, anon, authenticated, shipwithali_worker, shipwithali_backup;
reset role;
