-- Phase 7 #198: enable validated Contact channel, External link, and Global CTA events.
-- Rollback: disable these actions at the event application seam; preserve accepted records.
-- Forward fixes use a new expand-compatible migration.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table measurement.public_events
  add column contact_channel text,
  add column external_destination text;

alter table measurement.public_events
  drop constraint public_events_action_check,
  drop constraint public_events_action_facts_check;

alter table measurement.public_events
  add constraint public_events_action_check
    check (action in ('page-viewed', 'project-viewed', 'active-engagement-sampled',
      'media-engaged', 'related-project-opened', 'testimonial-engaged',
      'contact-channel-opened', 'external-project-link-opened', 'global-project-cta-opened')),
  add constraint public_events_contact_channel_check
    check (contact_channel is null or contact_channel in ('linkedin', 'whatsapp', 'instagram', 'phone')),
  add constraint public_events_external_destination_check
    check (external_destination is null or external_destination in ('github-repository', 'live-demo')),
  add constraint public_events_action_facts_check check (
    (action = 'page-viewed' and project_id is null and active_milliseconds is null
      and media_asset_id is null and media_engagement is null and source_project_id is null
      and target_project_id is null and testimonial_id is null and contact_channel is null and external_destination is null)
    or (action = 'project-viewed' and project_id is not null and active_milliseconds is null
      and media_asset_id is null and media_engagement is null and source_project_id is null
      and target_project_id is null and testimonial_id is null and contact_channel is null and external_destination is null)
    or (action = 'active-engagement-sampled' and active_milliseconds between 1000 and 60000
      and media_asset_id is null and media_engagement is null and source_project_id is null
      and target_project_id is null and testimonial_id is null and contact_channel is null and external_destination is null)
    or (action = 'media-engaged' and active_milliseconds is null and media_asset_id is not null
      and media_engagement in ('opened', 'played', 'paused', 'completed') and source_project_id is null
      and target_project_id is null and testimonial_id is null and contact_channel is null and external_destination is null)
    or (action = 'related-project-opened' and project_id is null and active_milliseconds is null
      and media_asset_id is null and media_engagement is null and source_project_id is not null
      and target_project_id is not null and source_project_id <> target_project_id and testimonial_id is null
      and contact_channel is null and external_destination is null)
    or (action = 'testimonial-engaged' and active_milliseconds is null and media_asset_id is null
      and media_engagement is null and source_project_id is null and target_project_id is null
      and testimonial_id is not null and contact_channel is null and external_destination is null)
    or (action = 'contact-channel-opened' and active_milliseconds is null and media_asset_id is null
      and media_engagement is null and source_project_id is null and target_project_id is null
      and testimonial_id is null and contact_channel is not null and external_destination is null)
    or (action = 'external-project-link-opened' and project_id is not null and active_milliseconds is null
      and media_asset_id is null and media_engagement is null and source_project_id is null
      and target_project_id is null and testimonial_id is null and contact_channel is null and external_destination is not null)
    or (action = 'global-project-cta-opened' and project_id is not null and active_milliseconds is null
      and media_asset_id is null and media_engagement is null and source_project_id is null
      and target_project_id is null and testimonial_id is null and contact_channel is null and external_destination is null)
  );

reset role;
