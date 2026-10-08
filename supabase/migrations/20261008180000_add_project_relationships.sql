-- Phase 5 #117 Content-owned symmetric Project relationships.
-- Rollback: restore the pre-Phase 5 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

create table content.project_relationships (
  portfolio_id uuid not null,
  left_project_id uuid not null,
  right_project_id uuid not null,
  content_type text not null default 'project' check (content_type = 'project'),
  created_by uuid not null,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (portfolio_id, left_project_id, right_project_id),
  check (left_project_id < right_project_id),
  foreign key (left_project_id, portfolio_id, content_type)
    references content.items (content_id, portfolio_id, content_type),
  foreign key (right_project_id, portfolio_id, content_type)
    references content.items (content_id, portfolio_id, content_type)
);

create index project_relationships_right_endpoint
  on content.project_relationships (portfolio_id, right_project_id, left_project_id);

create table content.project_relationship_views (
  portfolio_id uuid not null,
  project_id uuid not null,
  related_project_id uuid not null,
  left_project_id uuid not null,
  right_project_id uuid not null,
  content_type text not null default 'project' check (content_type = 'project'),
  created_at timestamptz not null default transaction_timestamp(),
  primary key (portfolio_id, project_id, related_project_id),
  check (project_id <> related_project_id),
  check ((project_id = left_project_id and related_project_id = right_project_id)
      or (project_id = right_project_id and related_project_id = left_project_id)),
  foreign key (portfolio_id, left_project_id, right_project_id)
    references content.project_relationships (portfolio_id, left_project_id, right_project_id),
  foreign key (project_id, portfolio_id, content_type)
    references content.items (content_id, portfolio_id, content_type),
  foreign key (related_project_id, portfolio_id, content_type)
    references content.items (content_id, portfolio_id, content_type)
);

create index project_relationship_views_related_order
  on content.project_relationship_views (portfolio_id, related_project_id, project_id);

create trigger project_relationship_views_immutable
before update or delete on content.project_relationship_views
for each row execute function content.reject_publication_history_mutation();

create table content.project_relationship_history (
  portfolio_id uuid not null,
  left_project_id uuid not null,
  right_project_id uuid not null,
  content_type text not null default 'project' check (content_type = 'project'),
  sequence integer not null check (sequence > 0),
  action text not null check (action = 'related'),
  initiating_project_id uuid not null,
  related_project_id uuid not null,
  initiating_aggregate_version integer not null check (initiating_aggregate_version > 0),
  related_aggregate_version integer not null check (related_aggregate_version > 0),
  actor_id uuid not null,
  occurred_at timestamptz not null default transaction_timestamp(),
  primary key (portfolio_id, left_project_id, right_project_id, sequence),
  check (left_project_id < right_project_id),
  check (initiating_project_id <> related_project_id),
  foreign key (portfolio_id, left_project_id, right_project_id)
    references content.project_relationships (portfolio_id, left_project_id, right_project_id),
  foreign key (initiating_project_id, portfolio_id, content_type)
    references content.items (content_id, portfolio_id, content_type),
  foreign key (related_project_id, portfolio_id, content_type)
    references content.items (content_id, portfolio_id, content_type)
);

create index project_relationship_history_portfolio_order
  on content.project_relationship_history (portfolio_id, left_project_id, right_project_id, sequence desc);

create trigger project_relationship_history_immutable
before update or delete on content.project_relationship_history
for each row execute function content.reject_publication_history_mutation();

alter table content.project_relationships enable row level security;
alter table content.project_relationships force row level security;
alter table content.project_relationship_views enable row level security;
alter table content.project_relationship_views force row level security;
alter table content.project_relationship_history enable row level security;
alter table content.project_relationship_history force row level security;

grant select, insert on content.project_relationships to shipwithali_application;
grant select, insert on content.project_relationship_views to shipwithali_application;
grant select, insert on content.project_relationship_history to shipwithali_application;

create policy project_relationships_application_scope on content.project_relationships
  for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = project_relationships.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = project_relationships.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)));

create policy project_relationship_history_application_scope on content.project_relationship_history
  for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = project_relationship_history.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = project_relationship_history.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)));

create policy project_relationship_views_application_scope on content.project_relationship_views
  for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = project_relationship_views.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = project_relationship_views.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)));

revoke all on content.project_relationships, content.project_relationship_views, content.project_relationship_history
  from public, anon, authenticated, shipwithali_worker, shipwithali_backup;
revoke all on function content.reject_publication_history_mutation() from public, anon, authenticated,
  shipwithali_application, shipwithali_worker, shipwithali_backup;

reset role;
