-- Phase 5 #111 reviewed Project publication, durable first route, and safe read projection.
-- Rollback: restore the pre-Phase 5 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

create table content.public_routes (
  route_identity uuid primary key
    check (route_identity::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  content_id uuid not null,
  portfolio_id uuid not null,
  content_type text not null check (content_type = 'project'),
  current_slug text not null check (current_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(current_slug) <= 120),
  first_published_at timestamptz not null,
  created_at timestamptz not null default transaction_timestamp(),
  unique (content_id, portfolio_id),
  unique (route_identity, content_id, portfolio_id),
  foreign key (content_id, portfolio_id, content_type)
    references content.items (content_id, portfolio_id, content_type) on delete cascade
);

create table content.public_route_reservations (
  portfolio_id uuid not null,
  content_type text not null check (content_type = 'project'),
  normalized_slug text not null check (normalized_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(normalized_slug) <= 120),
  route_identity uuid not null,
  content_id uuid not null,
  is_current boolean not null,
  reserved_at timestamptz not null default transaction_timestamp(),
  primary key (portfolio_id, content_type, normalized_slug),
  unique (route_identity, normalized_slug),
  foreign key (route_identity, content_id, portfolio_id)
    references content.public_routes (route_identity, content_id, portfolio_id) on delete cascade
    deferrable initially deferred
);

create table content.language_publications (
  content_id uuid not null,
  portfolio_id uuid not null,
  content_type text not null check (content_type = 'project'),
  locale text not null check (locale in ('en', 'ar')),
  revision_id uuid not null,
  review_id uuid not null,
  route_identity uuid not null,
  publication_sequence integer not null check (publication_sequence > 0),
  published_at timestamptz not null,
  media_facts_version text check (media_facts_version is null or char_length(media_facts_version) between 1 and 128),
  primary key (content_id, locale),
  unique (route_identity, locale),
  foreign key (content_id, portfolio_id, content_type)
    references content.items (content_id, portfolio_id, content_type) on delete cascade,
  foreign key (revision_id, content_id, portfolio_id, locale)
    references content.revisions (revision_id, content_id, portfolio_id, locale),
  foreign key (review_id, content_id, portfolio_id, revision_id)
    references content.revision_reviews (review_id, content_id, portfolio_id, revision_id),
  foreign key (route_identity, content_id, portfolio_id)
    references content.public_routes (route_identity, content_id, portfolio_id)
);

create table content.publication_history (
  content_id uuid not null,
  portfolio_id uuid not null,
  content_type text not null check (content_type = 'project'),
  locale text not null check (locale in ('en', 'ar')),
  publication_sequence integer not null check (publication_sequence > 0),
  revision_id uuid not null,
  review_id uuid not null,
  route_identity uuid not null,
  published_at timestamptz not null,
  media_facts_version text check (media_facts_version is null or char_length(media_facts_version) between 1 and 128),
  primary key (content_id, locale, publication_sequence),
  foreign key (content_id, portfolio_id, content_type)
    references content.items (content_id, portfolio_id, content_type) on delete cascade,
  foreign key (revision_id, content_id, portfolio_id, locale)
    references content.revisions (revision_id, content_id, portfolio_id, locale),
  foreign key (review_id, content_id, portfolio_id, revision_id)
    references content.revision_reviews (review_id, content_id, portfolio_id, revision_id),
  foreign key (route_identity, content_id, portfolio_id)
    references content.public_routes (route_identity, content_id, portfolio_id)
);

create table content.public_project_locales (
  content_id uuid not null,
  portfolio_id uuid not null,
  content_type text not null default 'project' check (content_type = 'project'),
  locale text not null check (locale in ('en', 'ar')),
  revision_id uuid not null,
  route_identity uuid not null,
  title text not null,
  summary text not null,
  body text not null,
  case_study jsonb not null check (jsonb_typeof(case_study) = 'object'),
  claims jsonb not null check (jsonb_typeof(claims) = 'array'),
  external_links jsonb not null check (jsonb_typeof(external_links) = 'array'),
  first_published_at timestamptz not null,
  published_at timestamptz not null,
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (content_id, locale),
  foreign key (content_id, portfolio_id, content_type)
    references content.items (content_id, portfolio_id, content_type) on delete cascade,
  foreign key (revision_id, content_id, portfolio_id, locale)
    references content.revisions (revision_id, content_id, portfolio_id, locale),
  foreign key (route_identity, content_id, portfolio_id)
    references content.public_routes (route_identity, content_id, portfolio_id)
);

create function content.reject_publication_history_mutation() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using errcode = '55000', message = 'CONTENT_PUBLICATION_HISTORY_IMMUTABLE';
end;
$$;

create trigger content_publication_history_immutable
before update or delete on content.publication_history
for each row execute function content.reject_publication_history_mutation();

alter table content.public_routes enable row level security;
alter table content.public_routes force row level security;
alter table content.public_route_reservations enable row level security;
alter table content.public_route_reservations force row level security;
alter table content.language_publications enable row level security;
alter table content.language_publications force row level security;
alter table content.publication_history enable row level security;
alter table content.publication_history force row level security;
alter table content.public_project_locales enable row level security;
alter table content.public_project_locales force row level security;

grant select, insert, update (current_slug) on content.public_routes to shipwithali_application;
grant select, insert on content.public_route_reservations to shipwithali_application;
grant select, insert, update (revision_id, review_id, route_identity, publication_sequence, published_at, media_facts_version)
  on content.language_publications to shipwithali_application;
grant select, insert on content.publication_history to shipwithali_application;
grant select, insert, update (revision_id, route_identity, title, summary, body, case_study, claims, external_links, first_published_at, published_at, updated_at)
  on content.public_project_locales to shipwithali_application;
grant update (lifecycle, first_published_at, aggregate_version, updated_at) on content.items to shipwithali_application;

create policy public_routes_application_scope on content.public_routes
  for all to shipwithali_application
  using (exists (select 1 from portfolio_config.settings settings
    where settings.portfolio_id = public_routes.portfolio_id
      and settings.portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
      and settings.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (exists (select 1 from portfolio_config.settings settings
    where settings.portfolio_id = public_routes.portfolio_id
      and settings.portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
      and settings.owner_id::text = current_setting('shipwithali.owner_id', true)));
create policy route_reservations_application_scope on content.public_route_reservations
  for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = public_route_reservations.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = public_route_reservations.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)));
create policy language_publications_application_scope on content.language_publications
  for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = language_publications.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = language_publications.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)));
create policy publication_history_application_scope on content.publication_history
  for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = publication_history.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = publication_history.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)));
create policy public_project_locales_application_scope on content.public_project_locales
  for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from content.items item
      where item.content_id = public_project_locales.content_id
        and item.portfolio_id = public_project_locales.portfolio_id
        and item.lifecycle = 'published')
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = public_project_locales.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from content.items item
      where item.content_id = public_project_locales.content_id
        and item.portfolio_id = public_project_locales.portfolio_id
        and item.lifecycle = 'published')
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = public_project_locales.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)));

revoke all on content.public_routes, content.public_route_reservations,
  content.language_publications, content.publication_history, content.public_project_locales
  from public, anon, authenticated, shipwithali_worker, shipwithali_backup;
revoke all on function content.reject_publication_history_mutation() from public, anon, authenticated,
  shipwithali_application, shipwithali_worker, shipwithali_backup;

reset role;
