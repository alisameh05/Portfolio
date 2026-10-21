# Phase 8 job retry and recovery handoff (#237)

## Retry policy

The first execution is attempt 1. A transient failure schedules the next claim
after `min(30s * 2^(attempt - 1), 15m) + floor(random * (floor(base * .25) + 1))`.
The random sample is in `[0, 1)` and is injected into the worker. Delay vectors
are 30s, 60s, 120s, 240s, and 480s before jitter; the cap is 900s, and the
largest integer delay is 1,125,000ms. PostgreSQL adds the delay to its own
clock and the worker lease token fences the update.

`PHASE7_WORK_FAILED` is the safe transient worker code. Invalid work uses
`PHASE7_JOB_INVALID` and is terminal immediately. At five claims, a final
failure or an expired fifth lease terminalizes as `dead` and writes the
deduplicated `job:<uuid>` incident. Outbox work follows the same five-claim
bound and stores its terminal timestamp and safe cause.

## Operator recovery

The application entry point is `redriveDeadJob` from
`src/modules/portability-operations`. Call it only from a server composition
that has authenticated the operator and supplies `authorizeOperator`; that
authorization must return a purpose-limited lowercase SHA-256 scope hash. Use
an actor with purpose `operations.redrive` and the original dead job ID.
The service accepts only policy `phase7-handlers-v1` and the current allowlist
of Phase 7 job payloads. It generates a fresh job ID. PostgreSQL copies the
original type/version/payload, inserts one audit row with operator scope hash,
policy version and payload hash, and leaves the original job and deduplication
records intact. A given dead job can be re-driven once; if its replacement
later becomes dead, recover that replacement as a new original.

The executable verification command is:

```text
npm run phase8:focus:retry-recovery
```

It starts disposable native PostgreSQL, applies all migrations, exercises the
restricted worker role and cleans up its cluster. It does not perform a live
re-drive. This ticket does not provision operator credentials or a deployed
operator CLI; do not invoke `redriveDeadJob` without the host authorization
composition.

## Delivery guarantees and owner recovery

SQL effect and idempotency receipt changes share a transaction. A worker crash
after commit can replay the same effect without applying it twice. The current
allowlisted jobs have no external provider side effects; this implementation
does not claim exactly-once network delivery. Any future external handler must
add provider idempotency or durable reconciliation before it is registered.

Failed Owner exports remain terminal and their artifact IDs are not reused.
The Owner recovery path is a new `requestOwnerExport` operation with a fresh
idempotency key, which creates a new export ID; there is no product retry
operation. Publication, route, taxonomy, CV and moderation mutations continue
to commit state, projection and outbox together. Optional post-commit work must
not roll back or replace the last valid publication when it fails.
