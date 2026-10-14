-- Measurement owns minimal consent state and decision facts. No event/identity join.
-- Expand only. Forward fix with a new migration; rollback deploys the prior code,
-- leaving these private tables unused. Never destructively roll back revocations.
set lock_timeout = '5s';
set role shipwithali_migration;
create table measurement.consents (
  portfolio_id uuid not null,
  consent_id uuid not null,
  subject uuid,
  state text not null check (state in ('granted', 'denied', 'unknown')),
  notice_version text not null check (notice_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  revision integer not null check (revision > 0),
  recorded_at timestamptz not null,
  evidence_expires_at timestamptz not null,
  primary key (portfolio_id, consent_id),
  check (state <> 'granted' or (subject is not null and evidence_expires_at > recorded_at)),
  check (evidence_expires_at <= recorded_at + interval '30 days')
);
create table measurement.consent_history (
  portfolio_id uuid not null,
  consent_id uuid not null,
  revision integer not null check (revision > 0),
  state text not null check (state in ('granted', 'denied', 'unknown')),
  notice_version text not null check (notice_version ~ '^[A-Za-z0-9._-]{1,64}$'),
  recorded_at timestamptz not null,
  primary key (portfolio_id, consent_id, revision),
  foreign key (portfolio_id, consent_id) references measurement.consents on delete cascade
);
create index consents_expiry on measurement.consents (portfolio_id, evidence_expires_at, consent_id);
alter table measurement.consents enable row level security;
alter table measurement.consents force row level security;
alter table measurement.consent_history enable row level security;
alter table measurement.consent_history force row level security;
revoke all on measurement.consents, measurement.consent_history from public, anon, authenticated;
grant usage on schema measurement to shipwithali_application, shipwithali_worker;
grant select, insert, update on measurement.consents to shipwithali_application;
grant select, insert on measurement.consent_history to shipwithali_application;
grant select, delete on measurement.consents, measurement.consent_history to shipwithali_worker;
create policy consent_application on measurement.consents for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true));
create policy consent_history_application on measurement.consent_history for all to shipwithali_application
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true))
  with check (portfolio_id::text = current_setting('shipwithali.portfolio_id', true));
create policy consent_worker_read on measurement.consents for select to shipwithali_worker
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true));
create policy consent_worker_expire on measurement.consents for delete to shipwithali_worker
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true)
    and evidence_expires_at <= statement_timestamp());
create policy consent_history_worker_read on measurement.consent_history for select to shipwithali_worker
  using (portfolio_id::text = current_setting('shipwithali.portfolio_id', true));
-- History is deleted only by the owned consent FK cascade after the horizon.
reset role;
