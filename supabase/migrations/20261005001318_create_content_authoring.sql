-- Phase 5 #109 Content-owned Draft roots and immutable localized Revisions.
-- Rollback: restore the pre-Phase 5 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

create table content.items (
  content_id uuid primary key
    check (content_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  portfolio_id uuid not null references portfolio_config.settings (portfolio_id),
  content_type text not null check (content_type in ('project', 'achievement', 'testimonial')),
  lifecycle text not null default 'draft' check (lifecycle in ('draft', 'published', 'hidden', 'archived')),
  candidate_slug text,
  aggregate_version integer not null default 1 check (aggregate_version > 0),
  first_published_at timestamptz,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  unique (content_id, portfolio_id),
  unique (content_id, portfolio_id, content_type),
  check (candidate_slug is null or (
    char_length(candidate_slug) between 1 and 120 and
    candidate_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  )),
  check (content_type = 'project' or candidate_slug is null)
);

comment on table content.items is
  'Owner-scoped publishable content roots; Draft roots have no public route identity.';
comment on column content.items.candidate_slug is
  'Editable private candidate only; it never reserves or identifies a public route.';

create table content.revisions (
  revision_id uuid primary key
    check (revision_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  content_id uuid not null,
  portfolio_id uuid not null,
  content_type text not null check (content_type in ('project', 'achievement', 'testimonial')),
  locale text not null check (locale in ('en', 'ar')),
  stream_sequence integer not null check (stream_sequence > 0),
  aggregate_version integer not null check (aggregate_version > 0),
  title text not null check (char_length(btrim(title)) between 1 and 160),
  summary text not null check (char_length(btrim(summary)) between 1 and 500),
  body text not null check (char_length(btrim(body)) between 1 and 50000),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  reviewed boolean not null default false,
  saved_at timestamptz not null,
  unique (content_id, locale, stream_sequence),
  unique (revision_id, content_id, portfolio_id),
  foreign key (content_id, portfolio_id, content_type)
    references content.items (content_id, portfolio_id, content_type) on delete cascade,
  check (payload->>'contentType' = content_type),
  check (payload->>'locale' = locale),
  check (payload->>'title' = title),
  check (payload->>'summary' = summary),
  check (payload->>'body' = body)
);

comment on table content.revisions is
  'Append-only localized Revision snapshots retaining typed draft and evidence references.';

create function content.reject_revision_mutation() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using errcode = '55000', message = 'CONTENT_REVISION_IMMUTABLE';
end;
$$;

create trigger content_revisions_immutable
before update or delete on content.revisions
for each row execute function content.reject_revision_mutation();

alter table content.items enable row level security;
alter table content.items force row level security;
alter table content.revisions enable row level security;
alter table content.revisions force row level security;

grant usage on schema content to shipwithali_application;
grant select, insert on content.items to shipwithali_application;
grant update (aggregate_version, updated_at) on content.items to shipwithali_application;
grant select, insert on content.revisions to shipwithali_application;

create policy content_items_application_select on content.items
  for select to shipwithali_application
  using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (
      select 1 from portfolio_config.settings settings
       where settings.portfolio_id = items.portfolio_id
         and settings.owner_id::text = current_setting('shipwithali.owner_id', true)
    )
  );
create policy content_items_application_insert on content.items
  for insert to shipwithali_application
  with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (
      select 1 from portfolio_config.settings settings
       where settings.portfolio_id = items.portfolio_id
         and settings.owner_id::text = current_setting('shipwithali.owner_id', true)
    )
  );
create policy content_items_application_update on content.items
  for update to shipwithali_application
  using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (
      select 1 from portfolio_config.settings settings
       where settings.portfolio_id = items.portfolio_id
         and settings.owner_id::text = current_setting('shipwithali.owner_id', true)
    )
  )
  with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (
      select 1 from portfolio_config.settings settings
       where settings.portfolio_id = items.portfolio_id
         and settings.owner_id::text = current_setting('shipwithali.owner_id', true)
    )
  );
create policy content_revisions_application_select on content.revisions
  for select to shipwithali_application
  using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (
      select 1 from content.items item
       where item.content_id = revisions.content_id
         and item.portfolio_id = revisions.portfolio_id
    )
  );
create policy content_revisions_application_insert on content.revisions
  for insert to shipwithali_application
  with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (
      select 1 from content.items item
       where item.content_id = revisions.content_id
         and item.portfolio_id = revisions.portfolio_id
    )
  );

revoke all on content.items, content.revisions from public, anon, authenticated,
  shipwithali_worker, shipwithali_backup;
revoke all on function content.reject_revision_mutation() from public, anon, authenticated,
  shipwithali_application, shipwithali_worker, shipwithali_backup;

reset role;
