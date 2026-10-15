-- #192 expand-only private pending Feedback. No tracking identity or text in facts.
-- Rollback: disable submission assembly, retain private rows, forward fix in a new migration.
set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;
create table interaction.feedback (
  feedback_id uuid primary key check (feedback_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  portfolio_id uuid not null check (portfolio_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  project_id uuid not null check (project_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  locale text not null check (locale in ('en','ar')),
  author_name text not null check (char_length(btrim(author_name)) between 1 and 100),
  paragraph text not null check (char_length(btrim(paragraph)) between 1 and 2000),
  moderation_state text not null check (moderation_state in ('pending','approved','rejected','suppressed')),
  aggregate_version bigint not null check (aggregate_version >= 1),
  submitted_at timestamptz not null
);
-- No cross-module FK: Content owns authoritative eligibility and its lock.
create index feedback_project_locale on interaction.feedback (portfolio_id, project_id, locale, submitted_at desc, feedback_id desc);
alter table interaction.feedback enable row level security;
alter table interaction.feedback force row level security;
revoke all on interaction.feedback from public, anon, authenticated, shipwithali_application, shipwithali_worker, shipwithali_backup;
grant usage on schema interaction to shipwithali_application;
-- Submission only needs INSERT: Owner read/moderation grants belong to #193.
grant insert on interaction.feedback to shipwithali_application;
create policy feedback_submission on interaction.feedback for insert to shipwithali_application
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and moderation_state = 'pending' and aggregate_version = 1);
reset role;
