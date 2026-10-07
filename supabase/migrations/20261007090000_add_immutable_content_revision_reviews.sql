-- Phase 5 #110 immutable Owner review decisions for exact localized snapshots.
-- Rollback: restore the pre-Phase 5 snapshot before deployment.
-- Forward fix: correct defects with a new timestamped expand-compatible migration.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

create table content.revision_reviews (
  review_id uuid primary key
    check (review_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  content_id uuid not null,
  portfolio_id uuid not null,
  content_type text not null check (content_type in ('project', 'achievement', 'testimonial')),
  revision_id uuid not null,
  locale text not null check (locale in ('en', 'ar')),
  review_sequence integer not null check (review_sequence > 0),
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  evidence_version integer not null check (evidence_version > 0),
  reviewer_id uuid not null,
  decision text not null check (decision in ('accepted', 'rejected')),
  findings jsonb not null default '[]'::jsonb check (jsonb_typeof(findings) = 'array'),
  reviewed_at timestamptz not null,
  unique (revision_id, review_sequence),
  unique (review_id, content_id, portfolio_id, revision_id),
  foreign key (content_id, portfolio_id, content_type)
    references content.items (content_id, portfolio_id, content_type) on delete cascade,
  foreign key (revision_id, content_id, portfolio_id)
    references content.revisions (revision_id, content_id, portfolio_id) on delete cascade,
  check (reviewer_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);

comment on table content.revision_reviews is
  'Append-only Owner decisions bound to one immutable content, locale, evidence, and revision snapshot hash.';
comment on column content.revision_reviews.findings is
  'Private bounded editorial notes; never copied into public projections or outbox payloads.';

create function content.reject_revision_review_mutation() returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  raise exception using errcode = '55000', message = 'CONTENT_REVIEW_IMMUTABLE';
end;
$$;

create trigger content_revision_reviews_immutable
before update or delete on content.revision_reviews
for each row execute function content.reject_revision_review_mutation();

alter table content.revision_reviews enable row level security;
alter table content.revision_reviews force row level security;

grant usage on schema content to shipwithali_application;
grant select, insert on content.revision_reviews to shipwithali_application;

create policy content_revision_reviews_application_select on content.revision_reviews
  for select to shipwithali_application
  using (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and reviewer_id::text = current_setting('shipwithali.owner_id', true)
    and exists (
      select 1 from portfolio_config.settings settings
       where settings.portfolio_id = revision_reviews.portfolio_id
         and settings.owner_id::text = current_setting('shipwithali.owner_id', true)
    )
  );
create policy content_revision_reviews_application_insert on content.revision_reviews
  for insert to shipwithali_application
  with check (
    portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and reviewer_id::text = current_setting('shipwithali.owner_id', true)
    and exists (
      select 1 from portfolio_config.settings settings
       where settings.portfolio_id = revision_reviews.portfolio_id
         and settings.owner_id::text = current_setting('shipwithali.owner_id', true)
    )
  );

revoke all on content.revision_reviews from public, anon, authenticated,
  shipwithali_worker, shipwithali_backup;
revoke all on function content.reject_revision_review_mutation() from public, anon, authenticated,
  shipwithali_application, shipwithali_worker, shipwithali_backup;

reset role;
