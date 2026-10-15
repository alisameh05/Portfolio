-- Phase 7 #200: activate immutable goal snapshots with ordered history.
-- Rollback: disable goal activation while retaining pointer and append-only facts.
-- Forward corrections use a new expand-compatible migration.

set lock_timeout = '5s';

grant usage on schema measurement to shipwithali_application;
grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table measurement.analytics_goal_activation_history
  add column activation_sequence bigint;

with ordered_activations as (
  select portfolio_id, goal_id, activation_id,
    row_number() over (partition by portfolio_id, goal_id order by aggregate_version, activation_id) as sequence
  from measurement.analytics_goal_activation_history
)
update measurement.analytics_goal_activation_history history
set activation_sequence = ordered_activations.sequence
from ordered_activations
where history.portfolio_id = ordered_activations.portfolio_id
  and history.goal_id = ordered_activations.goal_id
  and history.activation_id = ordered_activations.activation_id;

alter table measurement.analytics_goal_activation_history
  alter column activation_sequence set not null,
  add constraint analytics_goal_activation_sequence_positive check (activation_sequence >= 1),
  add constraint analytics_goal_activation_sequence_unique unique (portfolio_id, goal_id, activation_sequence);

drop index measurement.analytics_goal_activation_ordered;
create index analytics_goal_activation_ordered
  on measurement.analytics_goal_activation_history (portfolio_id, goal_id, activation_sequence);

comment on column measurement.analytics_goal_activation_history.activation_sequence is
  'Monotonic goal-local order, allocated under the goal lock so delayed matching can resolve tied activation timestamps.';

reset role;
