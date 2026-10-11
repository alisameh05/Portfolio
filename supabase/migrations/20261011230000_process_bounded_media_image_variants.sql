-- Phase 6 #150: retain immutable, byte-bound PNG/JPEG/WebP processing variants.
-- Rollback: restore the pre-Phase 6 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table media.processed_objects drop constraint processed_objects_mime_type_check;
alter table media.processed_objects add constraint processed_objects_mime_type_check
  check (mime_type in ('application/pdf', 'image/webp'));

alter table media.processing_orphans add column mime_type text not null default 'application/pdf'
  check (mime_type in ('application/pdf', 'image/webp'));

alter table media.processing_attempts add constraint processing_attempts_scope_identity_unique
  unique (attempt_id, media_id, portfolio_id, owner_id);

alter table media.processing_attempts add column processing_duration_ms integer
  check (processing_duration_ms >= 0);

create table media.processing_attempt_variants (
  attempt_id uuid not null references media.processing_attempts (attempt_id),
  object_id uuid not null,
  portfolio_id uuid not null,
  owner_id uuid not null,
  media_id uuid not null,
  variant_name text not null check (variant_name in ('display', 'thumbnail')),
  mime_type text not null default 'image/webp' check (mime_type = 'image/webp'),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  width integer not null check (width between 1 and 40000000),
  height integer not null check (height between 1 and 40000000),
  created_at timestamptz not null default transaction_timestamp(),
  primary key (attempt_id, variant_name),
  unique (attempt_id, object_id),
  check (width::bigint * height::bigint <= 40000000),
  foreign key (object_id, media_id, portfolio_id, owner_id)
    references media.processed_objects (object_id, media_id, portfolio_id, owner_id),
  foreign key (attempt_id, media_id, portfolio_id, owner_id)
    references media.processing_attempts (attempt_id, media_id, portfolio_id, owner_id)
);

alter table media.processing_attempt_variants enable row level security;
alter table media.processing_attempt_variants force row level security;
grant select, insert on media.processing_attempt_variants to shipwithali_application;
grant select on media.processing_attempt_variants to shipwithali_backup;

create policy media_processing_attempt_variants_owner_scope on media.processing_attempt_variants
  for all to shipwithali_application using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  ) with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );

create index media_processing_attempt_variants_history_idx
  on media.processing_attempt_variants (portfolio_id, owner_id, media_id, attempt_id, variant_name);

reset role;
