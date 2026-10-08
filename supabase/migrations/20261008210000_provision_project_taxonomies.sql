-- Phase 5 #118 controlled Taxonomies and Content-owned Project assignments.
-- Rollback: restore the pre-Phase 5 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;

create table taxonomy.roots (
  portfolio_id uuid not null references portfolio_config.settings (portfolio_id),
  taxonomy_id uuid not null check (taxonomy_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  kind text not null check (kind in ('category', 'ai-ml-domain', 'technology', 'project-type')),
  aggregate_version integer not null default 1 check (aggregate_version > 0),
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (portfolio_id, taxonomy_id),
  unique (portfolio_id, kind),
  check ((kind = 'category' and taxonomy_id = '01890f3e-7b2f-7cc0-98cf-5a2890378ef6'::uuid)
      or (kind = 'ai-ml-domain' and taxonomy_id = '01890f3e-7b2f-7cc0-98cf-5a2890378ef7'::uuid)
      or (kind = 'technology' and taxonomy_id = '01890f3e-7b2f-7cc0-98cf-5a2890378ef8'::uuid)
      or (kind = 'project-type' and taxonomy_id = '01890f3e-7b2f-7cc0-98cf-5a2890378ef9'::uuid))
);
comment on table taxonomy.roots is 'Portfolio-scoped controlled classification roots; one stable identity per supported kind.';

create table taxonomy.taxonomy_values (
  portfolio_id uuid not null,
  taxonomy_id uuid not null,
  value_id uuid not null check (value_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  label text not null check (char_length(btrim(label)) between 1 and 100),
  normalized_label text generated always as (lower(regexp_replace(btrim(label), '[[:space:]]+', ' ', 'g'))) stored,
  state text not null default 'active' check (state in ('active', 'retired', 'merged')),
  merged_into_value_id uuid,
  aggregate_version integer not null default 1 check (aggregate_version > 0),
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (portfolio_id, value_id),
  unique (portfolio_id, taxonomy_id, value_id),
  unique (portfolio_id, taxonomy_id, normalized_label),
  foreign key (portfolio_id, taxonomy_id) references taxonomy.roots (portfolio_id, taxonomy_id),
  foreign key (portfolio_id, taxonomy_id, merged_into_value_id) references taxonomy.taxonomy_values (portfolio_id, taxonomy_id, value_id),
  check ((state = 'merged' and merged_into_value_id is not null and merged_into_value_id <> value_id)
      or (state <> 'merged' and merged_into_value_id is null))
);
comment on table taxonomy.taxonomy_values is 'Stable, root-scoped controlled values; inactive values remain addressable for historical assignments.';

create table taxonomy.value_history (
  portfolio_id uuid not null,
  taxonomy_id uuid not null,
  value_id uuid not null,
  transition_sequence integer not null check (transition_sequence > 0),
  action text not null check (action in ('created', 'renamed', 'retired', 'merged')),
  previous_label text,
  label text not null check (char_length(btrim(label)) between 1 and 100),
  state text not null check (state in ('active', 'retired', 'merged')),
  aggregate_version integer not null check (aggregate_version > 0),
  changed_at timestamptz not null default transaction_timestamp(),
  primary key (portfolio_id, value_id, transition_sequence),
  unique (portfolio_id, value_id, aggregate_version),
  foreign key (portfolio_id, taxonomy_id, value_id) references taxonomy.taxonomy_values (portfolio_id, taxonomy_id, value_id),
  check ((action = 'created' and previous_label is null and aggregate_version = 1 and state = 'active')
      or (action = 'renamed' and previous_label is not null and previous_label <> label and state = 'active')
      or (action = 'retired' and previous_label = label and state = 'retired')
      or (action = 'merged' and previous_label = label and state = 'merged'))
);

create table content.project_taxonomy_assignments (
  portfolio_id uuid not null,
  content_id uuid not null,
  content_type text not null default 'project' check (content_type = 'project'),
  taxonomy_id uuid not null,
  value_id uuid not null,
  assigned_at timestamptz not null default transaction_timestamp(),
  primary key (portfolio_id, content_id, value_id),
  foreign key (content_id, portfolio_id, content_type) references content.items (content_id, portfolio_id, content_type) on delete cascade,
  foreign key (portfolio_id, taxonomy_id, value_id) references taxonomy.taxonomy_values (portfolio_id, taxonomy_id, value_id)
);
create index project_taxonomy_assignments_value on content.project_taxonomy_assignments (portfolio_id, value_id, content_id);

create table content.project_taxonomy_assignment_history (
  portfolio_id uuid not null,
  content_id uuid not null,
  content_type text not null default 'project' check (content_type = 'project'),
  sequence integer not null check (sequence > 0),
  taxonomy_id uuid not null,
  value_id uuid not null,
  aggregate_version integer not null check (aggregate_version > 1),
  actor_id uuid not null,
  changed_at timestamptz not null default transaction_timestamp(),
  primary key (portfolio_id, content_id, sequence),
  unique (portfolio_id, content_id, aggregate_version),
  foreign key (content_id, portfolio_id, content_type) references content.items (content_id, portfolio_id, content_type),
  foreign key (portfolio_id, taxonomy_id, value_id) references taxonomy.taxonomy_values (portfolio_id, taxonomy_id, value_id)
);

alter table taxonomy.project_discovery_locales
  add constraint project_discovery_locales_content_scope_locale_unique unique (content_id, portfolio_id, locale);

create table taxonomy.project_discovery_taxonomy_values (
  portfolio_id uuid not null,
  content_id uuid not null,
  locale text not null check (locale in ('en', 'ar')),
  taxonomy_id uuid not null,
  value_id uuid not null,
  kind text not null check (kind in ('category', 'ai-ml-domain', 'technology', 'project-type')),
  label text not null check (char_length(btrim(label)) between 1 and 100),
  first_published_at timestamptz not null,
  primary key (portfolio_id, content_id, locale, value_id),
  foreign key (content_id, portfolio_id, locale) references taxonomy.project_discovery_locales (content_id, portfolio_id, locale) on delete cascade,
  foreign key (portfolio_id, taxonomy_id, value_id) references taxonomy.taxonomy_values (portfolio_id, taxonomy_id, value_id)
);
create index project_discovery_taxonomy_filter on taxonomy.project_discovery_taxonomy_values
  (portfolio_id, locale, kind, value_id, first_published_at desc, content_id);

create function taxonomy.reject_value_history_mutation() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  raise exception using errcode = '55000', message = 'TAXONOMY_VALUE_HISTORY_IMMUTABLE';
end;
$$;
create trigger taxonomy_value_history_immutable before update or delete on taxonomy.value_history
for each row execute function taxonomy.reject_value_history_mutation();
create trigger project_taxonomy_assignment_history_immutable before update or delete on content.project_taxonomy_assignment_history
for each row execute function content.reject_publication_history_mutation();

create function taxonomy.provision_roots_for_portfolio() returns trigger
language plpgsql set search_path = pg_catalog, taxonomy as $$
begin
  insert into taxonomy.roots (portfolio_id, taxonomy_id, kind) values
    (new.portfolio_id, '01890f3e-7b2f-7cc0-98cf-5a2890378ef6', 'category'),
    (new.portfolio_id, '01890f3e-7b2f-7cc0-98cf-5a2890378ef7', 'ai-ml-domain'),
    (new.portfolio_id, '01890f3e-7b2f-7cc0-98cf-5a2890378ef8', 'technology'),
    (new.portfolio_id, '01890f3e-7b2f-7cc0-98cf-5a2890378ef9', 'project-type')
  on conflict (portfolio_id, kind) do nothing;
  return new;
end;
$$;
create trigger portfolio_taxonomy_roots after insert on portfolio_config.settings
for each row execute function taxonomy.provision_roots_for_portfolio();
insert into taxonomy.roots (portfolio_id, taxonomy_id, kind)
select settings.portfolio_id, roots.taxonomy_id, roots.kind
from portfolio_config.settings settings
cross join (values
  ('01890f3e-7b2f-7cc0-98cf-5a2890378ef6'::uuid, 'category'),
  ('01890f3e-7b2f-7cc0-98cf-5a2890378ef7'::uuid, 'ai-ml-domain'),
  ('01890f3e-7b2f-7cc0-98cf-5a2890378ef8'::uuid, 'technology'),
  ('01890f3e-7b2f-7cc0-98cf-5a2890378ef9'::uuid, 'project-type')
) roots(taxonomy_id, kind)
on conflict (portfolio_id, kind) do nothing;

alter table taxonomy.roots enable row level security;
alter table taxonomy.roots force row level security;
alter table taxonomy.taxonomy_values enable row level security;
alter table taxonomy.taxonomy_values force row level security;
alter table taxonomy.value_history enable row level security;
alter table taxonomy.value_history force row level security;
alter table taxonomy.project_discovery_taxonomy_values enable row level security;
alter table taxonomy.project_discovery_taxonomy_values force row level security;
alter table content.project_taxonomy_assignments enable row level security;
alter table content.project_taxonomy_assignments force row level security;
alter table content.project_taxonomy_assignment_history enable row level security;
alter table content.project_taxonomy_assignment_history force row level security;

grant usage on schema taxonomy to shipwithali_application;
grant select, insert, update (aggregate_version, updated_at) on taxonomy.roots to shipwithali_application;
grant select, insert, update (label, state, merged_into_value_id, aggregate_version, updated_at) on taxonomy.taxonomy_values to shipwithali_application;
grant select, insert on taxonomy.value_history to shipwithali_application;
grant select, insert, update, delete on taxonomy.project_discovery_taxonomy_values to shipwithali_application;
grant select, insert, delete on content.project_taxonomy_assignments to shipwithali_application;
grant select, insert on content.project_taxonomy_assignment_history to shipwithali_application;
grant update (aggregate_version, updated_at) on content.items to shipwithali_application;

create policy taxonomy_roots_application_scope on taxonomy.roots for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = roots.portfolio_id and s.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = roots.portfolio_id and s.owner_id::text = current_setting('shipwithali.owner_id', true)));
create policy taxonomy_roots_migration_provisioning on taxonomy.roots for all to shipwithali_migration
  using (true) with check (true);
create policy taxonomy_values_application_scope on taxonomy.taxonomy_values for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = taxonomy_values.portfolio_id and s.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = taxonomy_values.portfolio_id and s.owner_id::text = current_setting('shipwithali.owner_id', true)));
create policy taxonomy_value_history_application_scope on taxonomy.value_history for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = value_history.portfolio_id and s.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = value_history.portfolio_id and s.owner_id::text = current_setting('shipwithali.owner_id', true)));
create policy project_taxonomy_assignments_application_scope on content.project_taxonomy_assignments for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = project_taxonomy_assignments.portfolio_id and s.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = project_taxonomy_assignments.portfolio_id and s.owner_id::text = current_setting('shipwithali.owner_id', true)));
create policy project_taxonomy_assignment_history_application_scope on content.project_taxonomy_assignment_history for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = project_taxonomy_assignment_history.portfolio_id and s.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = project_taxonomy_assignment_history.portfolio_id and s.owner_id::text = current_setting('shipwithali.owner_id', true)));
create policy project_discovery_taxonomy_values_application_scope on taxonomy.project_discovery_taxonomy_values for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = project_discovery_taxonomy_values.portfolio_id and s.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings s where s.portfolio_id = project_discovery_taxonomy_values.portfolio_id and s.owner_id::text = current_setting('shipwithali.owner_id', true)));

revoke all on taxonomy.roots, taxonomy.taxonomy_values, taxonomy.value_history, taxonomy.project_discovery_taxonomy_values,
  content.project_taxonomy_assignments, content.project_taxonomy_assignment_history
  from public, anon, authenticated, shipwithali_worker, shipwithali_backup;
revoke all on function taxonomy.reject_value_history_mutation() from public, anon, authenticated, shipwithali_application, shipwithali_worker, shipwithali_backup;
revoke all on function taxonomy.provision_roots_for_portfolio() from public, anon, authenticated, shipwithali_application, shipwithali_worker, shipwithali_backup;
reset role;
