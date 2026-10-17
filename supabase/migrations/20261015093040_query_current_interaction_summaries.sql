-- #195 expand-only, current on-read counts. No projection worker or stored visibility.
-- Rollback: disable the summary capability; retain votes/Feedback; forward-fix policies/views.
-- The private view owner is NOLOGIN/NOBYPASSRLS and is NOT granted to runtime roles.
-- It inherits existing application Content read policies; only aggregate view SELECT
-- is granted back to the application. No runtime-wide raw-voter SELECT policy is added.
set lock_timeout = '5s';
do $migration$
declare
  executor_is_superuser boolean;
  summary_role record;
begin
  select rolsuper into executor_is_superuser
    from pg_roles
   where rolname = current_user;

  if not exists (select 1 from pg_roles where rolname = 'shipwithali_summary_reader') then
    create role shipwithali_summary_reader nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  elsif executor_is_superuser then
    alter role shipwithali_summary_reader nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  else
    select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      into summary_role
      from pg_roles
     where rolname = 'shipwithali_summary_reader';
    if summary_role.rolcanlogin or summary_role.rolsuper or summary_role.rolcreatedb
      or summary_role.rolcreaterole or summary_role.rolreplication or summary_role.rolbypassrls then
      raise exception 'shipwithali_summary_reader has unsafe attributes; a superuser must correct the role';
    end if;
  end if;
end
$migration$;
grant shipwithali_application to shipwithali_summary_reader;
-- The migration owner creates the views and must be able to transfer them to
-- the isolated reader role. Runtime roles never receive this membership.
grant shipwithali_summary_reader to shipwithali_migration;
grant shipwithali_migration to current_user;
set role shipwithali_migration;

create policy reactions_summary_read on interaction.reactions for select to shipwithali_summary_reader
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid
    and project_id = nullif(current_setting('shipwithali.summary_project_id', true), '')::uuid);
create policy ratings_summary_read on interaction.ratings for select to shipwithali_summary_reader
  using (portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid
    and project_id = nullif(current_setting('shipwithali.summary_project_id', true), '')::uuid);

-- Deliberately owner-rights aggregate views: using security_invoker would require
-- broad raw-subject access for runtime. Forced RLS still applies to the view owner.
create view interaction.current_reaction_counts with (security_barrier = true) as
  select count(*) filter (where kind = 'like') as likes,
    count(*) filter (where kind = 'dislike') as dislikes
  from interaction.reactions r
  where r.portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid
    and r.project_id = nullif(current_setting('shipwithali.summary_project_id', true), '')::uuid
    and exists (select 1 from content.items i join content.language_publications p
      on p.content_id = i.content_id and p.portfolio_id = i.portfolio_id
      where i.content_id = r.project_id and i.portfolio_id = r.portfolio_id
        and i.content_type = 'project' and i.lifecycle = 'published'
        and p.locale = current_setting('shipwithali.summary_locale', true));
create view interaction.current_rating_summary with (security_barrier = true) as
  select count(*) as raters, case when count(*) >= 5 then sum(value)::numeric / count(*) end as average
  from interaction.ratings r
  where r.portfolio_id = nullif(current_setting('shipwithali.portfolio_id', true), '')::uuid
    and r.project_id = nullif(current_setting('shipwithali.summary_project_id', true), '')::uuid
    and exists (select 1 from content.items i join content.language_publications p
      on p.content_id = i.content_id and p.portfolio_id = i.portfolio_id
      where i.content_id = r.project_id and i.portfolio_id = r.portfolio_id
        and i.content_type = 'project' and i.lifecycle = 'published'
        and p.locale = current_setting('shipwithali.summary_locale', true));
revoke all on interaction.current_reaction_counts, interaction.current_rating_summary
  from public, anon, authenticated, shipwithali_worker, shipwithali_backup;
grant select on interaction.current_reaction_counts, interaction.current_rating_summary to shipwithali_application;
grant create on schema interaction to shipwithali_summary_reader;
-- Ownership changes run under the privileged migration role, never runtime.
alter view interaction.current_reaction_counts owner to shipwithali_summary_reader;
alter view interaction.current_rating_summary owner to shipwithali_summary_reader;
revoke create on schema interaction from shipwithali_summary_reader;
reset role;
