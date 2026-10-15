-- Phase 6 #151: retain bounded video output variants and their immutable object facts.
-- Rollback: restore the pre-Phase 6 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table media.processed_objects
  drop constraint processed_objects_byte_length_check,
  drop constraint processed_objects_mime_type_check;
alter table media.processed_objects
  add constraint processed_objects_byte_length_check check (byte_length between 1 and 52428800),
  add constraint processed_objects_mime_type_check check (mime_type in ('application/pdf', 'video/mp4', 'video/webm'));

alter table media.processing_attempts
  add column output_variants jsonb not null default '[]'::jsonb
    check (jsonb_typeof(output_variants) = 'array' and jsonb_array_length(output_variants) <= 8),
  add constraint processing_attempts_passed_video_has_variants
    check (result <> 'passed' or detected_mime_type not in ('video/mp4', 'video/webm') or jsonb_array_length(output_variants) between 1 and 8);
alter table media.processing_attempts
  add constraint processing_attempts_scope_unique unique (attempt_id, media_id, portfolio_id, owner_id);

create table media.processing_attempt_outputs (
  attempt_id uuid not null,
  portfolio_id uuid not null,
  owner_id uuid not null,
  media_id uuid not null,
  object_id uuid not null,
  variant_name text not null check (variant_name ~ '^[a-z0-9-]{1,32}$'),
  mime_type text not null check (mime_type in ('video/mp4', 'video/webm')),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  byte_length bigint not null check (byte_length between 1 and 52428800),
  object_version text not null check (length(object_version) between 1 and 255),
  width integer not null check (width between 1 and 1920),
  height integer not null check (height between 1 and 1080),
  codec text not null check (codec ~ '^[a-z0-9_]{2,16}$'),
  primary key (attempt_id, variant_name),
  unique (object_id),
  foreign key (attempt_id, media_id, portfolio_id, owner_id)
    references media.processing_attempts (attempt_id, media_id, portfolio_id, owner_id),
  foreign key (object_id, media_id, portfolio_id, owner_id)
    references media.processed_objects (object_id, media_id, portfolio_id, owner_id)
);

alter table media.processing_attempt_outputs enable row level security;
alter table media.processing_attempt_outputs force row level security;
grant select, insert on media.processing_attempt_outputs to shipwithali_application;
grant select on media.processing_attempt_outputs to shipwithali_backup;

create policy media_processing_attempt_outputs_owner_scope on media.processing_attempt_outputs
  for all to shipwithali_application using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  ) with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );

create index media_processing_attempt_outputs_history_idx
  on media.processing_attempt_outputs (portfolio_id, owner_id, media_id, attempt_id, variant_name);

reset role;
