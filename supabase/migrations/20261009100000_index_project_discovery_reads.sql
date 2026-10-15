begin;
set lock_timeout = '5s';

-- Rollback: drop taxonomy.project_discovery_locale_public_order and taxonomy.project_discovery_value_public_filter.

-- Match the public locale keyset order and the single controlled-value filter.
create index project_discovery_locale_public_order
  on taxonomy.project_discovery_locales
  (portfolio_id, locale, first_published_at desc, content_id desc);

create index project_discovery_value_public_filter
  on taxonomy.project_discovery_taxonomy_values
  (portfolio_id, locale, value_id, content_id);

comment on index taxonomy.project_discovery_locale_public_order is
  'Supports Portfolio and locale scoped newest-first public discovery keyset pages.';
comment on index taxonomy.project_discovery_value_public_filter is
  'Supports one stable controlled-value filter and project lookup within a locale.';

commit;
