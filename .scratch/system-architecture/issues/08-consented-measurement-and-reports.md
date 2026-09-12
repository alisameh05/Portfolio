# Consented Measurement and reports

Status: ready-for-agent
Type: task
Blocked by: 01, 02, 03, 04

## Objective

Implement consented allowlisted event intake, separate analytics identity, immutable Analytics goal versions, bounded Journey context, engagement estimates, daily aggregates, Low-sample reporting, and retention jobs.

## Acceptance criteria

- Passive browsing creates no analytics identity or non-essential event.
- Intake rejects missing consent, duplicate idempotency keys, unknown actions, and fields outside the event schema.
- At most three events are budgeted per page view and prohibited sensitive fields never enter events or Sentry.
- Raw events expire at 14 days and daily aggregates at 13 months.
- Reports identify the goal version, label Engagement estimates, preserve Journey context without causal claims, and suppress low samples.
- I-03, I-05, Q-02, Q-04, and Q-07 evidence pass where owned here.

## Comments

PostgreSQL remains the event store until the Measurement extraction trigger is sustained.
