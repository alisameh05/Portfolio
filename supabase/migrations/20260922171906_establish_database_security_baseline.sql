-- Phase 3 database security baseline.
-- Rollback: no destructive rollback is shipped; restore the prior release snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';

do $migration$
declare
  capability_role text;
begin
  foreach capability_role in array array[
    'shipwithali_application',
    'shipwithali_worker',
    'shipwithali_migration',
    'shipwithali_backup'
  ]
  loop
    if not exists (select 1 from pg_roles where rolname = capability_role) then
      execute format(
        'create role %I nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls',
        capability_role
      );
    else
      execute format(
        'alter role %I with nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls',
        capability_role
      );
    end if;
  end loop;
end
$migration$;

set role shipwithali_migration;

create schema portfolio_config authorization shipwithali_migration;
comment on schema portfolio_config is 'Logical owner: Portfolio Configuration module.';

create schema content authorization shipwithali_migration;
comment on schema content is 'Logical owner: Content and Publishing module.';

create schema taxonomy authorization shipwithali_migration;
comment on schema taxonomy is 'Logical owner: Taxonomy and Discovery module.';

create schema media authorization shipwithali_migration;
comment on schema media is 'Logical owner: Media module.';

create schema cv authorization shipwithali_migration;
comment on schema cv is 'Logical owner: CV Portfolio module.';

create schema interaction authorization shipwithali_migration;
comment on schema interaction is 'Logical owner: Interaction and Moderation module.';

create schema measurement authorization shipwithali_migration;
comment on schema measurement is 'Logical owner: Measurement module.';

create schema identity_access authorization shipwithali_migration;
comment on schema identity_access is 'Logical owner: Identity and Access module.';

create schema operations authorization shipwithali_migration;
comment on schema operations is 'Logical owner: Portability and Operations module.';

create schema public_read authorization shipwithali_migration;
comment on schema public_read is 'Read-model DDL stays owned by each producing module.';

do $privileges$
declare
  application_schema text;
begin
  foreach application_schema in array array[
    'portfolio_config',
    'content',
    'taxonomy',
    'media',
    'cv',
    'interaction',
    'measurement',
    'identity_access',
    'operations',
    'public_read'
  ]
  loop
    execute format(
      'revoke all on schema %I from public, anon, authenticated',
      application_schema
    );
    execute format(
      'revoke all on all tables in schema %I from public, anon, authenticated',
      application_schema
    );
    execute format(
      'revoke all on all sequences in schema %I from public, anon, authenticated',
      application_schema
    );
    execute format(
      'revoke all on all functions in schema %I from public, anon, authenticated',
      application_schema
    );
    execute format(
      'alter default privileges in schema %I revoke all on tables from public, anon, authenticated',
      application_schema
    );
    execute format(
      'alter default privileges in schema %I revoke all on sequences from public, anon, authenticated',
      application_schema
    );
    execute format(
      'alter default privileges in schema %I revoke all on functions from public, anon, authenticated',
      application_schema
    );
  end loop;
end
$privileges$;

reset role;
