-- Phase 7 #203: retain fixed, single-dimension sufficient statistics.
-- Existing summary-only rows are marked incomplete until rebuilt with dimensions.
-- Rollback: suppress Owner aggregate reports; preserve aggregate history.

set lock_timeout = '5s';

grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table measurement.daily_aggregates
  drop constraint daily_aggregates_dimensions_check,
  drop constraint daily_aggregates_pkey,
  drop constraint daily_aggregates_policy_version_check;

alter table measurement.daily_aggregates
  add constraint daily_aggregates_dimensions_check check (
    jsonb_typeof(dimensions) = 'object' and (
      dimensions = '{}'::jsonb or (
        (dimensions ? 'locale' and dimensions - 'locale' = '{}'::jsonb and dimensions->>'locale' in ('en', 'ar')) or
        (dimensions ? 'countryCode' and dimensions - 'countryCode' = '{}'::jsonb and (dimensions->>'countryCode' = 'unknown' or dimensions->>'countryCode' ~ '^[A-Z]{2}$')) or
        (dimensions ? 'deviceClass' and dimensions - 'deviceClass' = '{}'::jsonb and dimensions->>'deviceClass' in ('desktop', 'mobile', 'tablet', 'other', 'unknown')) or
        (dimensions ? 'referrerClass' and dimensions - 'referrerClass' = '{}'::jsonb and dimensions->>'referrerClass' in ('direct', 'search', 'social', 'professional', 'referral', 'unknown')) or
        (dimensions ? 'projectId' and dimensions - 'projectId' = '{}'::jsonb and (dimensions->>'projectId' = 'unknown' or dimensions->>'projectId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) or
        (dimensions ? 'publicRouteId' and dimensions - 'publicRouteId' = '{}'::jsonb and dimensions->>'publicRouteId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
      )
    )
  ),
  add constraint daily_aggregates_pkey primary key (portfolio_id, utc_day, metric_kind, metric_key, dimensions),
  add constraint daily_aggregates_policy_version_check check (policy_version in ('phase7.daily.v1', 'phase7.daily.v2'));

alter table measurement.daily_aggregate_checkpoints
  drop constraint daily_aggregate_checkpoints_policy_version_check,
  add constraint daily_aggregate_checkpoints_policy_version_check check (policy_version in ('phase7.daily.v1', 'phase7.daily.v2'));

update measurement.daily_aggregates set incomplete = true where dimensions = '{}'::jsonb;
update measurement.daily_aggregate_checkpoints set incomplete = true;

comment on column measurement.daily_aggregates.dimensions is
  'Empty for a summary or exactly one approved coarse dimension. Multi-dimension combinations are not persisted.';

reset role;
