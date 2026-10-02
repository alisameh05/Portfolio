-- Phase 4 #83 configured Portfolio settings aggregate.
-- Rollback: restore the pre-Phase 4 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';

-- Membership persists from the security-baseline migration; re-granting keeps
-- this migration applicable on its own when the executor administers schema.
grant shipwithali_migration to current_user;

set role shipwithali_migration;

create table portfolio_config.settings (
  portfolio_id uuid primary key
    check (portfolio_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  owner_id uuid not null unique
    check (owner_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 100),
  headline text not null check (char_length(btrim(headline)) between 1 and 160),
  bio text not null check (char_length(btrim(bio)) between 1 and 4000),
  global_cta_label text not null check (char_length(btrim(global_cta_label)) between 1 and 80),
  global_cta_destination text not null check (char_length(global_cta_destination) between 1 and 2048),
  global_cta_unavailable_fallback text not null
    check (char_length(btrim(global_cta_unavailable_fallback)) between 1 and 160),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp()
);

comment on table portfolio_config.settings is
  'Single versioned public settings aggregate for the configured Portfolio and stable Owner.';
comment on column portfolio_config.settings.owner_id is
  'Private stable Owner scope used only by trusted application authorization and RLS.';

create table portfolio_config.contact_channels (
  portfolio_id uuid not null references portfolio_config.settings (portfolio_id) on delete cascade,
  position smallint not null check (position between 0 and 19),
  channel text not null check (channel in ('linkedin', 'whatsapp', 'instagram', 'phone', 'email', 'other')),
  label text not null check (char_length(btrim(label)) between 1 and 80),
  destination text not null check (char_length(destination) between 1 and 2048),
  available_locales jsonb not null check (available_locales in (
    '["en"]'::jsonb, '["ar"]'::jsonb, '["en","ar"]'::jsonb, '["ar","en"]'::jsonb
  )),
  primary key (portfolio_id, position)
);

comment on table portfolio_config.contact_channels is
  'Ordered Contact channels for one configured Portfolio; position is the persisted order.';

alter table portfolio_config.settings enable row level security;
alter table portfolio_config.settings force row level security;
alter table portfolio_config.contact_channels enable row level security;
alter table portfolio_config.contact_channels force row level security;

grant usage on schema portfolio_config to shipwithali_application;
grant select, insert on portfolio_config.settings, portfolio_config.contact_channels
  to shipwithali_application;

create policy portfolio_settings_application_select on portfolio_config.settings
  for select to shipwithali_application
  using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );
create policy portfolio_settings_application_insert on portfolio_config.settings
  for insert to shipwithali_application
  with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );
create policy portfolio_channels_application_select on portfolio_config.contact_channels
  for select to shipwithali_application
  using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (
      select 1 from portfolio_config.settings settings
       where settings.portfolio_id = contact_channels.portfolio_id
         and settings.owner_id::text = current_setting('shipwithali.owner_id', true)
    )
  );
create policy portfolio_channels_application_insert on portfolio_config.contact_channels
  for insert to shipwithali_application
  with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and exists (
      select 1 from portfolio_config.settings settings
       where settings.portfolio_id = contact_channels.portfolio_id
         and settings.owner_id::text = current_setting('shipwithali.owner_id', true)
    )
  );

revoke all on portfolio_config.settings, portfolio_config.contact_channels
  from public, anon, authenticated, shipwithali_worker, shipwithali_backup;
revoke update, delete, truncate, references, trigger
  on portfolio_config.settings, portfolio_config.contact_channels
  from shipwithali_application;

reset role;
