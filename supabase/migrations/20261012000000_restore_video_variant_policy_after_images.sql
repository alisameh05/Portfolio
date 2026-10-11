-- Phase 6 #151 follow-up: preserve video formats after the image migration's MIME constraint update.
-- Rollback: restore the pre-Phase 6 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table media.processed_objects drop constraint processed_objects_mime_type_check;
alter table media.processed_objects add constraint processed_objects_mime_type_check
  check (mime_type in ('application/pdf', 'image/webp', 'video/mp4', 'video/webm'));

alter table media.processing_orphans drop constraint processing_orphans_mime_type_check;
alter table media.processing_orphans add constraint processing_orphans_mime_type_check
  check (mime_type in ('application/pdf', 'image/webp', 'video/mp4', 'video/webm'));

reset role;
