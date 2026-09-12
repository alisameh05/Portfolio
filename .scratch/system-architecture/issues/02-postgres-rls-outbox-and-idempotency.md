# PostgreSQL, RLS, outbox, and idempotency foundation

Status: ready-for-agent
Type: task
Blocked by: 01

## Objective

Implement module-owned migrations, stable UUID identities, public read projections, pooled access, Row Level Security, optimistic versions, idempotency records, transactional outbox records, and leased PostgreSQL jobs.

## Acceptance criteria

- Public roles can read only current Published Language versions and accepted public objects.
- Drafts, uploads, Feedback, identities, exports, and operational records are private.
- One transaction commits domain state, idempotency result, and outbox events or rolls all of them back.
- Job claims use bounded leases and `FOR UPDATE SKIP LOCKED`; retries cannot repeat a successful effect.
- I-01, I-02, and I-03 integration evidence passes.

## Comments

Follow ADR-0014 and the consistency section of `docs/architecture/quality-attributes.md`.
