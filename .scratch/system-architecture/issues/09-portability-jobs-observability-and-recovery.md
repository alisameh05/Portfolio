# Portability, jobs, observability, and recovery

Status: ready-for-agent
Type: task
Blocked by: 02, 03, 04, 05, 06, 07, 08

## Objective

Implement versioned Owner exports, integrity manifests, outbox dispatch, scheduled aggregation/retention/link checks, cache invalidation, encrypted backup workflows, structured logs, scrubbed Sentry reporting, alerts, and isolated restore rehearsals.

## Acceptance criteria

- Exports preserve stable identities, locales, revisions, lifecycle, relationships, Taxonomy history, Moderation history, eligible analytics, schema version, and checksums.
- Job handlers use leases, bounded retries, backoff, terminal failure, and one actionable alert.
- Nightly encrypted PostgreSQL and weekly encrypted storage/export artifacts meet the defined retention and key-separation rules.
- An isolated restore proves relational RPO 24 hours, media RPO 7 days, and RTO 8 hours.
- Logs and traces contain correlation data but no content bodies, raw identifiers, cookies, authorization headers, or secrets.
- D-16, I-06, Q-05, Q-06, and Q-07 evidence pass.

## Comments

Healthy operations populate dashboards without notifications.
