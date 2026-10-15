-- Phase 7 #197: enable the three fact-validated public interaction events.
-- Measurement stores only their stable action facts; Content and Media remain
-- authoritative for current public use and association checks at intake.
-- Rollback: disable these event actions at application composition.
-- Forward fixes use a new expand-compatible migration.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table measurement.public_events
  add column media_asset_id uuid,
  add column media_engagement text,
  add column source_project_id uuid,
  add column target_project_id uuid,
  add column testimonial_id uuid;

alter table measurement.public_events
  add constraint public_events_media_asset_id_uuidv7_check
    check (media_asset_id is null or media_asset_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  add constraint public_events_source_project_id_uuidv7_check
    check (source_project_id is null or source_project_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  add constraint public_events_target_project_id_uuidv7_check
    check (target_project_id is null or target_project_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  add constraint public_events_testimonial_id_uuidv7_check
    check (testimonial_id is null or testimonial_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');

do $$
declare constraint_name name;
begin
  for constraint_name in
    select conname
      from pg_constraint
     where conrelid = 'measurement.public_events'::regclass
       and contype = 'c'
       and (pg_get_constraintdef(oid) like '%action%' or pg_get_constraintdef(oid) like '%active_milliseconds%')
  loop
    execute format('alter table measurement.public_events drop constraint %I', constraint_name);
  end loop;
end
$$;

alter table measurement.public_events
  add constraint public_events_action_check
    check (action in ('page-viewed', 'project-viewed', 'active-engagement-sampled',
      'media-engaged', 'related-project-opened', 'testimonial-engaged')),
  add constraint public_events_action_facts_check check (
    (action = 'page-viewed' and project_id is null and active_milliseconds is null
      and media_asset_id is null and media_engagement is null and source_project_id is null
      and target_project_id is null and testimonial_id is null)
    or (action = 'project-viewed' and project_id is not null and active_milliseconds is null
      and media_asset_id is null and media_engagement is null and source_project_id is null
      and target_project_id is null and testimonial_id is null)
    or (action = 'active-engagement-sampled' and active_milliseconds between 1000 and 60000
      and media_asset_id is null and media_engagement is null and source_project_id is null
      and target_project_id is null and testimonial_id is null)
    or (action = 'media-engaged' and active_milliseconds is null and media_asset_id is not null
      and media_engagement in ('opened', 'played', 'paused', 'completed')
      and source_project_id is null and target_project_id is null and testimonial_id is null)
    or (action = 'related-project-opened' and project_id is null and active_milliseconds is null
      and media_asset_id is null and media_engagement is null and source_project_id is not null
      and target_project_id is not null and source_project_id <> target_project_id and testimonial_id is null)
    or (action = 'testimonial-engaged' and active_milliseconds is null and media_asset_id is null
      and media_engagement is null and source_project_id is null and target_project_id is null
      and testimonial_id is not null)
  );

reset role;
