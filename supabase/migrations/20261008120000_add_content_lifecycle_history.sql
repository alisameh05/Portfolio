-- Phase 5 #114 transactional withdrawal and restoration history.
-- Rollback: restore the pre-Phase 5 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

create table content.lifecycle_history (
  content_id uuid not null,
  portfolio_id uuid not null,
  content_type text not null check (content_type in ('project', 'achievement', 'testimonial')),
  transition_sequence integer not null check (transition_sequence > 0),
  previous_lifecycle text not null check (previous_lifecycle in ('draft', 'published', 'hidden', 'archived')),
  lifecycle text not null check (lifecycle in ('published', 'hidden', 'archived')),
  aggregate_version integer not null check (aggregate_version > 1),
  reason text check (reason is null or char_length(btrim(reason)) between 1 and 500),
  changed_at timestamptz not null default transaction_timestamp(),
  primary key (content_id, transition_sequence),
  unique (content_id, aggregate_version),
  foreign key (content_id, portfolio_id, content_type)
    references content.items (content_id, portfolio_id, content_type),
  check (previous_lifecycle <> lifecycle)
);

create index content_lifecycle_history_portfolio_order
  on content.lifecycle_history (portfolio_id, content_id, transition_sequence desc);

create trigger content_lifecycle_history_immutable
before update or delete on content.lifecycle_history
for each row execute function content.reject_publication_history_mutation();

alter table content.lifecycle_history enable row level security;
alter table content.lifecycle_history force row level security;

grant usage on schema content to shipwithali_application;
grant select, insert on content.lifecycle_history to shipwithali_application;

create policy content_lifecycle_history_application_scope on content.lifecycle_history
  for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = lifecycle_history.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (select 1 from portfolio_config.settings settings
      where settings.portfolio_id = lifecycle_history.portfolio_id
        and settings.owner_id::text = current_setting('shipwithali.owner_id', true)));

revoke all on content.lifecycle_history from public, anon, authenticated, shipwithali_worker, shipwithali_backup;
revoke all on function content.reject_publication_history_mutation() from public, anon, authenticated,
  shipwithali_application, shipwithali_worker, shipwithali_backup;

reset role;
