-- Phase 5 #112 Achievement publication and locale-aware chronological Timeline.
-- Rollback: restore the pre-Phase 5 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table content.language_publications
  drop constraint language_publications_content_type_check,
  add constraint language_publications_content_type_check check (content_type in ('project', 'achievement')),
  add constraint language_publications_project_route_identity_check
    check (content_type <> 'project' or route_identity is not null),
  alter column route_identity drop not null;

alter table content.publication_history
  drop constraint publication_history_content_type_check,
  add constraint publication_history_content_type_check check (content_type in ('project', 'achievement')),
  add constraint publication_history_project_route_identity_check
    check (content_type <> 'project' or route_identity is not null),
  alter column route_identity drop not null;

create table content.public_achievement_locales (
  content_id uuid not null,
  portfolio_id uuid not null,
  content_type text not null default 'achievement' check (content_type = 'achievement'),
  locale text not null check (locale in ('en', 'ar')),
  revision_id uuid not null,
  achieved_on date not null,
  title text not null,
  summary text not null,
  body text not null,
  artifacts jsonb not null default '[]'::jsonb check (jsonb_typeof(artifacts) = 'array'),
  first_published_at timestamptz not null,
  published_at timestamptz not null,
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (content_id, locale),
  foreign key (content_id, portfolio_id, content_type)
    references content.items (content_id, portfolio_id, content_type) on delete cascade,
  foreign key (revision_id, content_id, portfolio_id, locale)
    references content.revisions (revision_id, content_id, portfolio_id, locale),
  foreign key (content_id, locale)
    references content.language_publications (content_id, locale) on delete cascade
);

create index public_achievement_timeline_order
  on content.public_achievement_locales (portfolio_id, locale, achieved_on, content_id);

alter table content.public_achievement_locales enable row level security;
alter table content.public_achievement_locales force row level security;

grant select, insert, update (revision_id, achieved_on, title, summary, body, artifacts, first_published_at, published_at, updated_at)
  on content.public_achievement_locales to shipwithali_application;

create policy public_achievement_locales_application_scope on content.public_achievement_locales
  for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from content.items item
      where item.content_id = public_achievement_locales.content_id
        and item.portfolio_id = public_achievement_locales.portfolio_id
        and item.content_type = 'achievement' and item.lifecycle = 'published')
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = public_achievement_locales.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from content.items item
      where item.content_id = public_achievement_locales.content_id
        and item.portfolio_id = public_achievement_locales.portfolio_id
        and item.content_type = 'achievement' and item.lifecycle = 'published')
    and exists (select 1 from content.language_publications publication
      where publication.content_id = public_achievement_locales.content_id
        and publication.portfolio_id = public_achievement_locales.portfolio_id
        and publication.locale = public_achievement_locales.locale
        and publication.revision_id = public_achievement_locales.revision_id)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = public_achievement_locales.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)));

revoke all on content.public_achievement_locales from public, anon, authenticated,
  shipwithali_worker, shipwithali_backup;

reset role;
