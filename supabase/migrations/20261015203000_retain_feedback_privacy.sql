-- #205 module-owned Feedback retention. Pending/rejected rows are deleted;
-- suppressed rows retain minimal non-identifying audit after their text is erased.
-- Rollback: disable the Feedback retention command; data deletion is irreversible.
set lock_timeout = '5s';
grant shipwithali_migration to current_user;
set role shipwithali_migration;

alter table interaction.feedback alter column author_name drop not null;
alter table interaction.feedback alter column paragraph drop not null;
alter table interaction.feedback add column text_erased_at timestamptz;
alter table interaction.feedback add constraint feedback_text_erasure_consistent check (
  (text_erased_at is null and author_name is not null and paragraph is not null) or
  (text_erased_at is not null and author_name is null and paragraph is null)
);
alter table interaction.moderation_decisions alter column reason drop not null;
alter table interaction.moderation_decisions drop constraint moderation_decisions_reason_check;
alter table interaction.moderation_decisions add constraint moderation_decisions_reason_check
  check (reason is null or char_length(btrim(reason)) between 1 and 500);
alter table interaction.moderation_decisions alter column owner_id drop not null;

create table interaction.feedback_retention_checkpoints (
  portfolio_id uuid not null,
  job_id uuid not null check (job_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  requested_at timestamptz not null,
  stage text not null check (stage in ('pending-rejected','suppressed-text')),
  updated_at timestamptz not null,
  primary key (portfolio_id, job_id)
);

alter table interaction.feedback_retention_checkpoints enable row level security;
alter table interaction.feedback_retention_checkpoints force row level security;
revoke all on interaction.feedback_retention_checkpoints from public, anon, authenticated, shipwithali_application, shipwithali_worker, shipwithali_backup;
grant usage on schema interaction to shipwithali_worker;
grant select (portfolio_id, feedback_id, submitted_at, moderation_state, text_erased_at) on interaction.feedback to shipwithali_worker;
grant delete on interaction.feedback to shipwithali_worker;
grant update (author_name, paragraph, text_erased_at) on interaction.feedback to shipwithali_worker;
grant select (portfolio_id, feedback_id, decision, sequence, decided_at) on interaction.moderation_decisions to shipwithali_worker;
grant update (reason, owner_id) on interaction.moderation_decisions to shipwithali_worker;
grant select, insert, update, delete on interaction.feedback_retention_checkpoints to shipwithali_worker;

create policy feedback_retention_read on interaction.feedback for select to shipwithali_worker
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and current_setting('shipwithali.system_purpose', true) = 'feedback.retention'
    and current_setting('shipwithali.feedback_access', true) = 'retention'
    and ((moderation_state in ('pending','rejected')
          and ((submitted_at at time zone 'UTC') + interval '90 days') at time zone 'UTC'
              <= current_setting('shipwithali.retention_now', true)::timestamptz)
      or moderation_state = 'suppressed'));
create policy feedback_retention_delete on interaction.feedback for delete to shipwithali_worker
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and current_setting('shipwithali.system_purpose', true) = 'feedback.retention'
    and current_setting('shipwithali.feedback_access', true) = 'retention'
    and moderation_state in ('pending','rejected')
    and ((submitted_at at time zone 'UTC') + interval '90 days') at time zone 'UTC'
        <= current_setting('shipwithali.retention_now', true)::timestamptz);
create policy feedback_retention_update on interaction.feedback for update to shipwithali_worker
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and current_setting('shipwithali.system_purpose', true) = 'feedback.retention'
    and current_setting('shipwithali.feedback_access', true) = 'retention'
    and moderation_state = 'suppressed' and text_erased_at is null)
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and current_setting('shipwithali.system_purpose', true) = 'feedback.retention'
    and current_setting('shipwithali.feedback_access', true) = 'retention'
    and moderation_state = 'suppressed');
create policy moderation_retention_read on interaction.moderation_decisions for select to shipwithali_worker
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and current_setting('shipwithali.system_purpose', true) = 'feedback.retention'
    and current_setting('shipwithali.feedback_access', true) = 'retention');
create policy moderation_retention_update on interaction.moderation_decisions for update to shipwithali_worker
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and current_setting('shipwithali.system_purpose', true) = 'feedback.retention'
    and current_setting('shipwithali.feedback_access', true) = 'retention')
  with check (reason is null and owner_id is null and portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and current_setting('shipwithali.system_purpose', true) = 'feedback.retention'
    and current_setting('shipwithali.feedback_access', true) = 'retention');
create policy feedback_retention_checkpoint_access on interaction.feedback_retention_checkpoints for all to shipwithali_worker
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and current_setting('shipwithali.system_purpose', true) = 'feedback.retention'
    and current_setting('shipwithali.feedback_access', true) = 'retention')
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and current_setting('shipwithali.system_purpose', true) = 'feedback.retention'
    and current_setting('shipwithali.feedback_access', true) = 'retention');

reset role;
