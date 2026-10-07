-- Phase 5 #113 localized Testimonial publication and safe in-process projections.
-- Rollback: restore the pre-Phase 5 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

create table content.testimonial_language_publications (
  content_id uuid not null,
  portfolio_id uuid not null,
  content_type text not null default 'testimonial' check (content_type = 'testimonial'),
  locale text not null check (locale in ('en', 'ar')),
  revision_id uuid not null,
  review_id uuid not null,
  publication_sequence integer not null check (publication_sequence > 0),
  published_at timestamptz not null,
  primary key (content_id, locale),
  foreign key (content_id, portfolio_id, content_type)
    references content.items (content_id, portfolio_id, content_type) on delete cascade,
  foreign key (revision_id, content_id, portfolio_id, locale)
    references content.revisions (revision_id, content_id, portfolio_id, locale),
  foreign key (review_id, content_id, portfolio_id, revision_id)
    references content.revision_reviews (review_id, content_id, portfolio_id, revision_id)
);

create table content.testimonial_publication_history (
  content_id uuid not null,
  portfolio_id uuid not null,
  content_type text not null default 'testimonial' check (content_type = 'testimonial'),
  locale text not null check (locale in ('en', 'ar')),
  publication_sequence integer not null check (publication_sequence > 0),
  revision_id uuid not null,
  review_id uuid not null,
  published_at timestamptz not null,
  primary key (content_id, locale, publication_sequence),
  foreign key (content_id, portfolio_id, content_type)
    references content.items (content_id, portfolio_id, content_type) on delete cascade,
  foreign key (revision_id, content_id, portfolio_id, locale)
    references content.revisions (revision_id, content_id, portfolio_id, locale),
  foreign key (review_id, content_id, portfolio_id, revision_id)
    references content.revision_reviews (review_id, content_id, portfolio_id, revision_id)
);

create trigger testimonial_publication_history_immutable
before update or delete on content.testimonial_publication_history
for each row execute function content.reject_publication_history_mutation();

create table content.public_testimonial_locales (
  content_id uuid not null,
  portfolio_id uuid not null,
  content_type text not null default 'testimonial' check (content_type = 'testimonial'),
  locale text not null check (locale in ('en', 'ar')),
  revision_id uuid not null,
  author_name text not null check (char_length(btrim(author_name)) between 1 and 200),
  quote text not null check (char_length(btrim(quote)) between 1 and 10000),
  association_type text not null check (association_type in ('profile', 'project')),
  project_id uuid,
  project_content_type text not null default 'project' check (project_content_type = 'project'),
  published_at timestamptz not null,
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (content_id, locale),
  foreign key (content_id, portfolio_id, content_type)
    references content.items (content_id, portfolio_id, content_type) on delete cascade,
  foreign key (revision_id, content_id, portfolio_id, locale)
    references content.revisions (revision_id, content_id, portfolio_id, locale),
  foreign key (project_id, portfolio_id, project_content_type)
    references content.items (content_id, portfolio_id, content_type),
  check ((association_type = 'profile' and project_id is null) or
         (association_type = 'project' and project_id is not null))
);

alter table content.testimonial_language_publications enable row level security;
alter table content.testimonial_language_publications force row level security;
alter table content.testimonial_publication_history enable row level security;
alter table content.testimonial_publication_history force row level security;
alter table content.public_testimonial_locales enable row level security;
alter table content.public_testimonial_locales force row level security;

grant usage on schema content to shipwithali_application;
grant select, insert, update (revision_id, review_id, publication_sequence, published_at)
  on content.testimonial_language_publications to shipwithali_application;
grant select, insert on content.testimonial_publication_history to shipwithali_application;
grant select, insert, update (revision_id, author_name, quote, association_type, project_id, published_at, updated_at)
  on content.public_testimonial_locales to shipwithali_application;
grant update (lifecycle, first_published_at, aggregate_version, updated_at) on content.items to shipwithali_application;

create policy testimonial_publications_application_scope on content.testimonial_language_publications
  for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = testimonial_language_publications.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = testimonial_language_publications.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)));
create policy testimonial_publication_history_application_scope on content.testimonial_publication_history
  for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = testimonial_publication_history.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = testimonial_publication_history.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)));
create policy public_testimonial_locales_application_scope on content.public_testimonial_locales
  for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from content.items item
      where item.content_id = public_testimonial_locales.content_id
        and item.portfolio_id = public_testimonial_locales.portfolio_id
        and item.content_type = 'testimonial' and item.lifecycle = 'published')
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = public_testimonial_locales.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from content.items item
      where item.content_id = public_testimonial_locales.content_id
        and item.portfolio_id = public_testimonial_locales.portfolio_id
        and item.content_type = 'testimonial' and item.lifecycle = 'published')
    and exists (select 1 from content.testimonial_language_publications publication
      where publication.content_id = public_testimonial_locales.content_id
        and publication.portfolio_id = public_testimonial_locales.portfolio_id
        and publication.locale = public_testimonial_locales.locale
        and publication.revision_id = public_testimonial_locales.revision_id)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = public_testimonial_locales.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)));

revoke all on content.testimonial_language_publications, content.testimonial_publication_history,
  content.public_testimonial_locales from public, anon, authenticated, shipwithali_worker, shipwithali_backup;
revoke all on function content.reject_publication_history_mutation() from public, anon, authenticated,
  shipwithali_application, shipwithali_worker, shipwithali_backup;

reset role;
