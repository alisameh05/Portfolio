-- Phase 3 migration capability bootstrap.
-- Rollback: restore the Phase 2 snapshot; capability roles contain no login credentials.
-- Forward fix: change capabilities only through a later reviewed migration.

set lock_timeout = '5s';

do $migration$
begin
  if not exists (select 1 from pg_roles where rolname = 'shipwithali_migration') then
    create role shipwithali_migration
      nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  execute format(
    'grant connect, create, temporary on database %I to shipwithali_migration',
    current_database()
  );
end
$migration$;
