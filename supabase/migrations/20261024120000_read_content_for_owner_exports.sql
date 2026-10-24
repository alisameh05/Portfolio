-- Phase 8 #241: permit the leased export worker to read a complete private
-- Content snapshot under an exact, transaction-local purpose and owner scope.
-- Rollback: revoke the worker SELECT grants and drop the worker policies and
-- scope predicate. No Content write capability is added.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

create function content.owner_export_scope_is_valid(target_portfolio_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, portfolio_config
as $$
  select target_portfolio_id::text = nullif(current_setting('shipwithali.portfolio_id', true), '')
     and current_setting('shipwithali.worker_purpose', true) = 'content.owner-export'
     and exists (
       select 1 from portfolio_config.settings settings
        where settings.portfolio_id = target_portfolio_id
          and settings.owner_id::text = nullif(current_setting('shipwithali.owner_id', true), '')
     );
$$;

grant usage on schema content, taxonomy to shipwithali_worker;
revoke all on function content.owner_export_scope_is_valid(uuid)
  from public, anon, authenticated, shipwithali_application, shipwithali_backup;
grant execute on function content.owner_export_scope_is_valid(uuid) to shipwithali_worker;
grant select on content.items, content.project_status_values, content.revisions, content.revision_reviews,
  content.language_publications, content.testimonial_language_publications, content.publication_history,
  content.testimonial_publication_history, content.lifecycle_history, content.public_routes,
  content.public_route_reservations, content.public_route_history, content.project_relationship_views,
  content.project_relationship_history, content.project_taxonomy_assignments, taxonomy.roots
  to shipwithali_worker;

create policy content_items_worker_owner_export on content.items
  for select to shipwithali_worker using (content.owner_export_scope_is_valid(portfolio_id));
create policy project_status_values_worker_owner_export on content.project_status_values
  for select to shipwithali_worker using (content.owner_export_scope_is_valid(portfolio_id));
create policy content_revisions_worker_owner_export on content.revisions
  for select to shipwithali_worker using (content.owner_export_scope_is_valid(portfolio_id));
create policy content_revision_reviews_worker_owner_export on content.revision_reviews
  for select to shipwithali_worker using (content.owner_export_scope_is_valid(portfolio_id));
create policy language_publications_worker_owner_export on content.language_publications
  for select to shipwithali_worker using (content.owner_export_scope_is_valid(portfolio_id));
create policy testimonial_publications_worker_owner_export on content.testimonial_language_publications
  for select to shipwithali_worker using (content.owner_export_scope_is_valid(portfolio_id));
create policy publication_history_worker_owner_export on content.publication_history
  for select to shipwithali_worker using (content.owner_export_scope_is_valid(portfolio_id));
create policy testimonial_publication_history_worker_owner_export on content.testimonial_publication_history
  for select to shipwithali_worker using (content.owner_export_scope_is_valid(portfolio_id));
create policy lifecycle_history_worker_owner_export on content.lifecycle_history
  for select to shipwithali_worker using (content.owner_export_scope_is_valid(portfolio_id));
create policy public_routes_worker_owner_export on content.public_routes
  for select to shipwithali_worker using (content.owner_export_scope_is_valid(portfolio_id));
create policy public_route_reservations_worker_owner_export on content.public_route_reservations
  for select to shipwithali_worker using (content.owner_export_scope_is_valid(portfolio_id));
create policy public_route_history_worker_owner_export on content.public_route_history
  for select to shipwithali_worker using (content.owner_export_scope_is_valid(portfolio_id));
create policy project_relationship_views_worker_owner_export on content.project_relationship_views
  for select to shipwithali_worker using (content.owner_export_scope_is_valid(portfolio_id));
create policy project_relationship_history_worker_owner_export on content.project_relationship_history
  for select to shipwithali_worker using (content.owner_export_scope_is_valid(portfolio_id));
create policy project_taxonomy_assignments_worker_owner_export on content.project_taxonomy_assignments
  for select to shipwithali_worker using (content.owner_export_scope_is_valid(portfolio_id));
create policy taxonomy_roots_worker_owner_export on taxonomy.roots
  for select to shipwithali_worker using (content.owner_export_scope_is_valid(portfolio_id));

comment on function content.owner_export_scope_is_valid(uuid) is
  'Purpose-limited Owner export read predicate; requires the transaction-local portfolio, Owner, and content.owner-export purpose.';

reset role;
