-- Phase 5 #115: candidate correction and durable same-identity route changes.
-- Rollback: restore the pre-#115 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

create table content.public_route_history (
  route_identity uuid not null,
  content_id uuid not null,
  portfolio_id uuid not null,
  sequence integer not null check (sequence > 0),
  from_slug text not null check (from_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(from_slug) <= 120),
  to_slug text not null check (to_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(to_slug) <= 120),
  changed_at timestamptz not null default transaction_timestamp(),
  primary key (route_identity, sequence),
  check (from_slug <> to_slug),
  foreign key (route_identity, content_id, portfolio_id)
    references content.public_routes (route_identity, content_id, portfolio_id)
);

create function content.reject_public_route_history_mutation() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using errcode = '55000', message = 'CONTENT_PUBLIC_ROUTE_HISTORY_IMMUTABLE';
end;
$$;

create trigger content_public_route_history_immutable
before update or delete on content.public_route_history
for each row execute function content.reject_public_route_history_mutation();

alter table content.public_route_history enable row level security;
alter table content.public_route_history force row level security;

grant update (candidate_slug) on content.items to shipwithali_application;
grant update (current_slug) on content.public_routes to shipwithali_application;
grant update (is_current) on content.public_route_reservations to shipwithali_application;
grant select, insert on content.public_route_history to shipwithali_application;

drop policy project_discovery_locales_application_scope on taxonomy.project_discovery_locales;
create policy project_discovery_locales_application_scope on taxonomy.project_discovery_locales
  for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from content.items item
      where item.content_id = project_discovery_locales.content_id
        and item.portfolio_id = project_discovery_locales.portfolio_id
        and item.content_type = 'project' and item.lifecycle in ('published', 'hidden', 'archived'))
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = project_discovery_locales.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from content.items item
      where item.content_id = project_discovery_locales.content_id
        and item.portfolio_id = project_discovery_locales.portfolio_id
        and item.content_type = 'project' and item.lifecycle in ('published', 'hidden', 'archived'))
    and exists (select 1 from content.language_publications publication
      where publication.content_id = project_discovery_locales.content_id
        and publication.portfolio_id = project_discovery_locales.portfolio_id
        and publication.locale = project_discovery_locales.locale
        and publication.revision_id = project_discovery_locales.revision_id
        and publication.route_identity = project_discovery_locales.route_identity)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = project_discovery_locales.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)));

create policy public_route_history_application_scope on content.public_route_history
  for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = public_route_history.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = public_route_history.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)));

revoke all on content.public_route_history from public, anon, authenticated, shipwithali_worker, shipwithali_backup;
revoke all on function content.reject_public_route_history_mutation() from public, anon, authenticated,
  shipwithali_application, shipwithali_worker, shipwithali_backup;

reset role;
