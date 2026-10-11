-- Phase 6 #154: initialize a versioned CV Portfolio and register accepted English PDF assets.
-- Rollback: restore the pre-Phase 6 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

create schema cv_portfolio;

create unique index portfolio_settings_owner_scope_uidx
  on portfolio_config.settings (portfolio_id, owner_id);

create table cv_portfolio.portfolios (
  portfolio_id uuid primary key references portfolio_config.settings (portfolio_id),
  owner_id uuid not null,
  aggregate_version integer not null default 1 check (aggregate_version > 0),
  current_version_id uuid,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  unique (portfolio_id, owner_id),
  foreign key (portfolio_id, owner_id)
    references portfolio_config.settings (portfolio_id, owner_id)
);

create table cv_portfolio.versions (
  version_id uuid primary key
    check (version_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  portfolio_id uuid not null,
  owner_id uuid not null,
  media_id uuid not null,
  media_asset_version integer not null check (media_asset_version > 0),
  version_number integer not null check (version_number > 0),
  locale text not null default 'en' check (locale = 'en'),
  label text not null check (char_length(btrim(label)) between 1 and 120),
  state text not null default 'registered' check (state in ('registered', 'accepted')),
  registered_at timestamptz not null default transaction_timestamp(),
  unique (version_id, portfolio_id, owner_id),
  unique (portfolio_id, owner_id, version_number),
  foreign key (portfolio_id, owner_id)
    references cv_portfolio.portfolios (portfolio_id, owner_id),
  foreign key (media_id, portfolio_id, owner_id)
    references media.assets (media_id, portfolio_id, owner_id)
);

alter table cv_portfolio.portfolios
  add constraint cv_portfolio_current_version_scope_fk
  foreign key (current_version_id, portfolio_id, owner_id)
  references cv_portfolio.versions (version_id, portfolio_id, owner_id)
  deferrable initially deferred;

create table cv_portfolio.registration_commands (
  portfolio_id uuid not null,
  owner_id uuid not null,
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  version_id uuid not null,
  aggregate_version integer not null check (aggregate_version > 1),
  created_at timestamptz not null default transaction_timestamp(),
  primary key (portfolio_id, owner_id, idempotency_key_hash),
  foreign key (portfolio_id, owner_id)
    references cv_portfolio.portfolios (portfolio_id, owner_id),
  foreign key (version_id, portfolio_id, owner_id)
    references cv_portfolio.versions (version_id, portfolio_id, owner_id)
);

create table cv_portfolio.activation_history (
  activation_id uuid primary key
    check (activation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  portfolio_id uuid not null,
  owner_id uuid not null,
  version_id uuid not null,
  activated_at timestamptz not null default transaction_timestamp(),
  foreign key (version_id, portfolio_id, owner_id)
    references cv_portfolio.versions (version_id, portfolio_id, owner_id)
);

comment on table cv_portfolio.portfolios is
  'One private versioned CV Portfolio root per configured Owner Portfolio. Root creation is idempotent and begins at version 1.';
comment on table cv_portfolio.versions is
  'Retained English CV registrations. Media identity and asset version bind each immutable registration to accepted PDF facts.';
comment on column cv_portfolio.versions.media_asset_version is
  'Snapshot of the accepted Media aggregate version observed inside the registration transaction.';
comment on table cv_portfolio.registration_commands is
  'Safe exact-replay receipts for CV registration. Idempotency keys are stored only as SHA-256 digests.';
comment on table cv_portfolio.activation_history is
  'Append-only retained Current CV activation history; Owner reads return a deterministic bounded latest-100 projection.';

create index cv_versions_owner_history_idx
  on cv_portfolio.versions (portfolio_id, owner_id, version_number desc, version_id desc);
create index cv_activation_history_owner_recent_idx
  on cv_portfolio.activation_history (portfolio_id, owner_id, activated_at desc, activation_id desc);

create policy cv_portfolios_owner_scope on cv_portfolio.portfolios
  for all to shipwithali_application
  using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
    and exists (
      select 1 from portfolio_config.settings settings
       where settings.portfolio_id = portfolios.portfolio_id
         and settings.owner_id = portfolios.owner_id
    )
  )
  with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
    and exists (
      select 1 from portfolio_config.settings settings
       where settings.portfolio_id = portfolios.portfolio_id
         and settings.owner_id = portfolios.owner_id
    )
  );

create policy cv_versions_owner_scope on cv_portfolio.versions
  for all to shipwithali_application
  using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  )
  with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
    and exists (
      select 1 from cv_portfolio.portfolios portfolio
       where portfolio.portfolio_id = versions.portfolio_id
         and portfolio.owner_id = versions.owner_id
    )
  );

create policy cv_registration_commands_owner_scope on cv_portfolio.registration_commands
  for all to shipwithali_application
  using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  )
  with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );

create policy cv_activation_history_owner_scope on cv_portfolio.activation_history
  for all to shipwithali_application
  using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  )
  with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );

revoke all on cv_portfolio.portfolios, cv_portfolio.versions,
  cv_portfolio.registration_commands, cv_portfolio.activation_history
  from public, anon, authenticated, shipwithali_worker, shipwithali_backup;
revoke delete, truncate, references, trigger on cv_portfolio.versions,
  cv_portfolio.registration_commands, cv_portfolio.activation_history
  from shipwithali_application;
revoke delete, truncate, references, trigger on cv_portfolio.portfolios
  from shipwithali_application;

-- Backfill roots for already-configured owners. Future owners are initialized
-- lazily by the existing authenticated CV read/register application interface.
-- Temporarily suspend forced RLS in this atomic migration transaction so the
-- migration role can read every configured owner and insert each private root.
-- The new root table remains inaccessible until the backfill completes.
alter table portfolio_config.settings no force row level security;
alter table portfolio_config.settings disable row level security;

insert into cv_portfolio.portfolios (portfolio_id, owner_id, aggregate_version)
select portfolio_id, owner_id, 1 from portfolio_config.settings
on conflict (portfolio_id) do nothing;

set constraints all immediate;
alter table portfolio_config.settings enable row level security;
alter table portfolio_config.settings force row level security;

alter table cv_portfolio.portfolios enable row level security;
alter table cv_portfolio.portfolios force row level security;
alter table cv_portfolio.versions enable row level security;
alter table cv_portfolio.versions force row level security;
alter table cv_portfolio.registration_commands enable row level security;
alter table cv_portfolio.registration_commands force row level security;
alter table cv_portfolio.activation_history enable row level security;
alter table cv_portfolio.activation_history force row level security;

-- Grant application access only after every CV table has forced RLS.
grant usage on schema cv_portfolio to shipwithali_application;
grant select, insert, update on cv_portfolio.portfolios to shipwithali_application;
grant select, insert on cv_portfolio.versions, cv_portfolio.activation_history to shipwithali_application;
grant select, insert on cv_portfolio.registration_commands to shipwithali_application;

reset role;
