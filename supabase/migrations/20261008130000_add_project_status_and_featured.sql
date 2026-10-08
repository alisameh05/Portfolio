-- Phase 5 #116 Content-owned Project status and Featured state.
-- Rollback: restore the pre-Phase 5 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

create table content.project_status_values (
  value_id uuid primary key
    check (value_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  portfolio_id uuid not null references portfolio_config.settings (portfolio_id),
  label text not null check (char_length(btrim(label)) between 1 and 100 and lower(btrim(label)) <> 'archived'),
  normalized_label text generated always as (lower(regexp_replace(btrim(label), '[[:space:]]+', ' ', 'g'))) stored,
  state text not null default 'active' check (state in ('active', 'retired')),
  aggregate_version integer not null default 1 check (aggregate_version > 0),
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  unique (value_id, portfolio_id),
  unique (portfolio_id, normalized_label)
);

comment on table content.project_status_values is
  'Content-owned, Portfolio-scoped Project maturity labels; retirement preserves identity and historical references.';

alter table content.items
  add column status_value_id uuid,
  add column featured boolean not null default false;

alter table content.items
  add constraint content_items_status_value_scope_fk
  foreign key (status_value_id, portfolio_id)
  references content.project_status_values (value_id, portfolio_id);

create table content.project_status_value_history (
  value_id uuid not null,
  portfolio_id uuid not null,
  transition_sequence integer not null check (transition_sequence > 0),
  operation text not null check (operation in ('created', 'renamed', 'retired')),
  previous_label text,
  label text not null check (char_length(btrim(label)) between 1 and 100),
  state text not null check (state in ('active', 'retired')),
  aggregate_version integer not null check (aggregate_version > 0),
  changed_at timestamptz not null default transaction_timestamp(),
  primary key (value_id, transition_sequence),
  unique (value_id, aggregate_version),
  foreign key (value_id, portfolio_id)
    references content.project_status_values (value_id, portfolio_id),
  check ((operation = 'created' and previous_label is null and aggregate_version = 1)
      or (operation = 'renamed' and previous_label is not null and previous_label <> label and state = 'active')
      or (operation = 'retired' and previous_label = label and state = 'retired'))
);

create table content.project_status_history (
  content_id uuid not null,
  portfolio_id uuid not null,
  transition_sequence integer not null check (transition_sequence > 0),
  previous_value_id uuid,
  current_value_id uuid not null,
  aggregate_version integer not null check (aggregate_version > 1),
  changed_at timestamptz not null default transaction_timestamp(),
  primary key (content_id, transition_sequence),
  unique (content_id, aggregate_version),
  foreign key (content_id, portfolio_id)
    references content.items (content_id, portfolio_id) on delete cascade,
  foreign key (previous_value_id, portfolio_id)
    references content.project_status_values (value_id, portfolio_id),
  foreign key (current_value_id, portfolio_id)
    references content.project_status_values (value_id, portfolio_id)
);

create function content.reject_project_status_history_mutation() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using errcode = '55000', message = 'PROJECT_STATUS_HISTORY_IMMUTABLE';
end;
$$;

create trigger content_project_status_value_history_immutable
before update or delete on content.project_status_value_history
for each row execute function content.reject_project_status_history_mutation();

create trigger content_project_status_history_immutable
before update or delete on content.project_status_history
for each row execute function content.reject_project_status_history_mutation();

create function content.require_active_project_status() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.content_type <> 'project' and (new.status_value_id is not null or new.featured) then
    raise exception using errcode = '23514', message = 'PROJECT_STATUS_AND_FEATURED_REQUIRE_PROJECT_CONTENT';
  end if;
  if new.status_value_id is not null then
    perform 1 from content.project_status_values status
     where status.value_id = new.status_value_id
       and status.portfolio_id = new.portfolio_id
       and status.state = 'active'
     for share;
    if not found then
      raise exception using errcode = '23514', message = 'PROJECT_STATUS_VALUE_NOT_ACTIVE';
    end if;
  end if;
  return new;
end;
$$;

create trigger content_project_status_must_be_active
before insert or update of status_value_id, featured on content.items
for each row execute function content.require_active_project_status();

alter table content.project_status_values enable row level security;
alter table content.project_status_values force row level security;
alter table content.project_status_value_history enable row level security;
alter table content.project_status_value_history force row level security;
alter table content.project_status_history enable row level security;
alter table content.project_status_history force row level security;

alter table taxonomy.project_discovery_locales
  add column status_value_id uuid,
  add column featured boolean not null default false;

alter table taxonomy.project_discovery_locales
  add constraint project_discovery_status_value_scope_fk
  foreign key (status_value_id, portfolio_id)
  references content.project_status_values (value_id, portfolio_id);

grant usage on schema content to shipwithali_application;
grant select, insert, update (label, state, aggregate_version, updated_at)
  on content.project_status_values to shipwithali_application;
grant select, insert on content.project_status_value_history to shipwithali_application;
grant select, insert on content.project_status_history to shipwithali_application;
grant update (status_value_id, featured, aggregate_version, updated_at)
  on content.items to shipwithali_application;
grant update (status_value_id, featured)
  on taxonomy.project_discovery_locales to shipwithali_application;

create policy project_status_values_application_scope on content.project_status_values
  for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = project_status_values.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = project_status_values.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)));

create policy project_status_value_history_application_scope on content.project_status_value_history
  for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = project_status_value_history.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = project_status_value_history.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)));

create policy project_status_history_application_scope on content.project_status_history
  for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = project_status_history.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = project_status_history.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)));

revoke all on content.project_status_values, content.project_status_value_history,
  content.project_status_history from public, anon, authenticated, shipwithali_worker, shipwithali_backup;
revoke all on function content.reject_project_status_history_mutation() from public, anon, authenticated,
  shipwithali_application, shipwithali_worker, shipwithali_backup;
revoke all on function content.require_active_project_status() from public, anon, authenticated,
  shipwithali_application, shipwithali_worker, shipwithali_backup;

reset role;
