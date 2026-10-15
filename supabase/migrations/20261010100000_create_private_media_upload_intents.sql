-- Phase 6 #148: private candidate roots, exact replay receipts and encrypted upload capabilities.
-- Rollback: restore the pre-Phase 6 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

create table media.assets (
  media_id uuid primary key
    check (media_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  portfolio_id uuid not null references portfolio_config.settings (portfolio_id),
  owner_id uuid not null,
  aggregate_version integer not null default 1 check (aggregate_version = 1),
  kind text not null check (kind in ('image', 'video', 'document')),
  original_file_name text not null check (char_length(original_file_name) between 1 and 255),
  declared_media_type text not null,
  declared_byte_length bigint not null check (declared_byte_length > 0),
  declared_sha256 text not null check (declared_sha256 ~ '^[0-9a-f]{64}$'),
  lifecycle text not null default 'candidate' check (lifecycle = 'candidate'),
  created_at timestamptz not null default transaction_timestamp(),
  unique (media_id, portfolio_id, owner_id),
  check (
    (kind = 'image' and declared_media_type in ('image/png', 'image/jpeg', 'image/webp') and declared_byte_length <= 10485760) or
    (kind = 'video' and declared_media_type in ('video/mp4', 'video/webm') and declared_byte_length <= 52428800) or
    (kind = 'document' and declared_media_type = 'application/pdf' and declared_byte_length <= 20971520)
  )
);

comment on table media.assets is
  'Private Media candidates. Declared upload facts remain distinct from later detected and accepted facts.';
comment on column media.assets.original_file_name is
  'Private display metadata only; never a Storage path, object identity, log field or public projection.';

create table media.upload_intents (
  upload_intent_id uuid primary key
    check (upload_intent_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  media_id uuid not null,
  media_object_id uuid not null
    check (media_object_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  portfolio_id uuid not null,
  owner_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default transaction_timestamp(),
  unique (upload_intent_id, portfolio_id, owner_id),
  unique (media_object_id),
  foreign key (media_id, portfolio_id, owner_id)
    references media.assets (media_id, portfolio_id, owner_id)
);

comment on table media.upload_intents is
  'Scoped single-candidate upload capability metadata; the generated object path stays private to the Storage adapter.';

create table media.upload_intent_commands (
  portfolio_id uuid not null,
  owner_id uuid not null,
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  media_id uuid not null,
  upload_intent_id uuid not null,
  media_object_id uuid not null,
  command_state text not null check (command_state in ('preparing', 'completed', 'abandoned', 'compensated')),
  reservation_expires_at timestamptz not null,
  safe_receipt jsonb,
  created_at timestamptz not null default transaction_timestamp(),
  completed_at timestamptz,
  primary key (portfolio_id, owner_id, idempotency_key_hash),
  check (safe_receipt is null or (
    jsonb_typeof(safe_receipt) = 'object' and
    not (safe_receipt ?| array['uploadTarget', 'target', 'token', 'signedUrl', 'signedURL'])
  )),
  check ((command_state = 'completed') = (safe_receipt is not null))
);

comment on table media.upload_intent_commands is
  'Safe idempotency ledger. Receipts contain IDs and expiry only; replay bearer material is stored in the encrypted capability table.';

create table media.upload_intent_capabilities (
  upload_intent_id uuid primary key,
  portfolio_id uuid not null,
  owner_id uuid not null,
  encryption_version smallint not null check (encryption_version = 1),
  nonce bytea not null check (octet_length(nonce) = 12),
  ciphertext bytea not null check (octet_length(ciphertext) between 1 and 8192),
  authentication_tag bytea not null check (octet_length(authentication_tag) = 16),
  created_at timestamptz not null default transaction_timestamp(),
  foreign key (upload_intent_id, portfolio_id, owner_id)
    references media.upload_intents (upload_intent_id, portfolio_id, owner_id)
);

comment on table media.upload_intent_capabilities is
  'Restricted AES-256-GCM ciphertext for exact upload-target replay; never stores a plaintext bearer URL.';

alter table media.assets enable row level security;
alter table media.assets force row level security;
alter table media.upload_intents enable row level security;
alter table media.upload_intents force row level security;
alter table media.upload_intent_commands enable row level security;
alter table media.upload_intent_commands force row level security;
alter table media.upload_intent_capabilities enable row level security;
alter table media.upload_intent_capabilities force row level security;

grant usage on schema media to shipwithali_application;
grant select, insert on media.assets, media.upload_intents to shipwithali_application;
grant select, insert, update on media.upload_intent_commands to shipwithali_application;
grant select, insert on media.upload_intent_capabilities to shipwithali_application;

create policy media_assets_owner_scope on media.assets
  for all to shipwithali_application
  using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
    and exists (
      select 1 from portfolio_config.settings settings
       where settings.portfolio_id = assets.portfolio_id
         and settings.owner_id = assets.owner_id
    )
  )
  with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
    and exists (
      select 1 from portfolio_config.settings settings
       where settings.portfolio_id = assets.portfolio_id
         and settings.owner_id = assets.owner_id
    )
  );

create policy media_upload_intents_owner_scope on media.upload_intents
  for all to shipwithali_application
  using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  )
  with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
    and exists (
      select 1 from media.assets asset
       where asset.media_id = upload_intents.media_id
         and asset.portfolio_id = upload_intents.portfolio_id
         and asset.owner_id = upload_intents.owner_id
    )
  );

create policy media_upload_intent_commands_owner_scope on media.upload_intent_commands
  for all to shipwithali_application
  using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  )
  with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );

create policy media_upload_intent_capabilities_owner_scope on media.upload_intent_capabilities
  for all to shipwithali_application
  using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  )
  with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );

revoke all on media.assets, media.upload_intents, media.upload_intent_commands, media.upload_intent_capabilities
  from public, anon, authenticated, shipwithali_worker, shipwithali_backup;

reset role;
