-- Phase 6 #156: atomically activate accepted CV versions and preserve current-use invariants.
-- Rollback: restore the pre-Phase 6 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table cv_portfolio.versions
  add column is_current boolean not null default false,
  add constraint cv_versions_activation_target_unique
    unique (version_id, portfolio_id, owner_id, state, locale);

alter table cv_portfolio.acceptance_history
  add constraint cv_acceptance_activation_target_unique
    unique (version_id, portfolio_id, owner_id);

alter table cv_portfolio.portfolios
  add column ever_activated boolean not null default false,
  add column current_version_state text not null default 'accepted' check (current_version_state = 'accepted'),
  add column current_version_locale text not null default 'en' check (current_version_locale = 'en'),
  add constraint cv_portfolio_current_requires_activation
    check (not ever_activated or current_version_id is not null);

alter table cv_portfolio.portfolios
  drop constraint cv_portfolio_current_version_scope_fk,
  add constraint cv_portfolio_current_version_accepted_english_fk
    foreign key (current_version_id, portfolio_id, owner_id, current_version_state, current_version_locale)
    references cv_portfolio.versions (version_id, portfolio_id, owner_id, state, locale)
    deferrable initially deferred,
  add constraint cv_portfolio_current_version_approval_fk
    foreign key (current_version_id, portfolio_id, owner_id)
    references cv_portfolio.acceptance_history (version_id, portfolio_id, owner_id)
    deferrable initially deferred;

update cv_portfolio.versions version
   set is_current = true
  from cv_portfolio.portfolios portfolio
 where portfolio.current_version_id = version.version_id
   and portfolio.portfolio_id = version.portfolio_id
   and portfolio.owner_id = version.owner_id;

create function cv_portfolio.retain_activated_current()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.current_version_id is not null or old.ever_activated then
    new.ever_activated := true;
  end if;
  return new;
end;
$$;

revoke all on function cv_portfolio.retain_activated_current() from public, anon, authenticated;
create trigger cv_portfolio_retain_activated_current
  before insert or update of current_version_id, ever_activated on cv_portfolio.portfolios
  for each row execute function cv_portfolio.retain_activated_current();

create unique index cv_versions_one_current_uidx
  on cv_portfolio.versions (portfolio_id, owner_id) where is_current;

create function cv_portfolio.assert_current_cv_consistency()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  root_version uuid;
  root_ever_activated boolean;
  current_count integer;
begin
  select portfolio.current_version_id, portfolio.ever_activated
    into root_version, root_ever_activated
    from cv_portfolio.portfolios portfolio
   where portfolio.portfolio_id = new.portfolio_id and portfolio.owner_id = new.owner_id;
  if not found then
    return null;
  end if;

  select count(*) into current_count
    from cv_portfolio.versions version
   where version.portfolio_id = new.portfolio_id
     and version.owner_id = new.owner_id
     and version.is_current;

  if (root_version is null and current_count <> 0) or
     (root_version is not null and (current_count <> 1 or not exists (
       select 1 from cv_portfolio.versions version
        where version.version_id = root_version
          and version.portfolio_id = new.portfolio_id
          and version.owner_id = new.owner_id
          and version.is_current
     ))) or (root_ever_activated and current_count <> 1) then
    raise exception 'CV_CURRENT_DESIGNATION_INCONSISTENT' using errcode = '23514';
  end if;
  return null;
end;
$$;

revoke all on function cv_portfolio.assert_current_cv_consistency() from public, anon, authenticated;
create constraint trigger cv_portfolio_root_current_consistency
  after insert or update on cv_portfolio.portfolios
  deferrable initially deferred for each row
  execute function cv_portfolio.assert_current_cv_consistency();
create constraint trigger cv_portfolio_version_current_consistency
  after insert or update on cv_portfolio.versions
  deferrable initially deferred for each row
  execute function cv_portfolio.assert_current_cv_consistency();

create table cv_portfolio.activation_commands (
  portfolio_id uuid not null,
  owner_id uuid not null,
  idempotency_key_hash text not null check (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  version_id uuid not null,
  aggregate_version integer not null check (aggregate_version > 0),
  created_at timestamptz not null default transaction_timestamp(),
  primary key (portfolio_id, owner_id, idempotency_key_hash),
  foreign key (portfolio_id, owner_id) references cv_portfolio.portfolios (portfolio_id, owner_id),
  foreign key (version_id, portfolio_id, owner_id)
    references cv_portfolio.versions (version_id, portfolio_id, owner_id)
);

comment on column cv_portfolio.portfolios.ever_activated is
  'Monotonic guard set by the pointer trigger; once activated, the portfolio cannot commit without a Current CV.';
comment on column cv_portfolio.versions.is_current is
  'Denormalized Owner current flag; a deferred constraint trigger requires exact agreement with the authoritative portfolio pointer.';
comment on table cv_portfolio.activation_commands is
  'Safe exact-replay receipts for Current CV activation, including version-preserving no-ops. Idempotency keys are stored only as SHA-256 digests.';

create index cv_activation_commands_version_idx
  on cv_portfolio.activation_commands (portfolio_id, owner_id, version_id, aggregate_version desc);

create policy cv_activation_commands_owner_scope on cv_portfolio.activation_commands
  for all to shipwithali_application using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  ) with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and owner_id::text = current_setting('shipwithali.owner_id', true)
  );

alter table cv_portfolio.activation_commands enable row level security;
alter table cv_portfolio.activation_commands force row level security;
revoke all on cv_portfolio.activation_commands from public, anon, authenticated, shipwithali_worker, shipwithali_backup;
grant select, insert on cv_portfolio.activation_commands to shipwithali_application;
grant update (is_current) on cv_portfolio.versions to shipwithali_application;

reset role;
