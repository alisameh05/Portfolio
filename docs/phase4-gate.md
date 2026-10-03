# Phase 4 completion gate

`npm run phase4:gate` produces the authoritative Phase 4 verdict in
`evidence/phase-4-gate-report.json`. The gate validates the Phase 1 and Phase 2
historical invariants in their own contexts, the Phase 3 source invariants, and
the Phase 3 transaction, idempotency, outbox, leased-job, and role/RLS database
invariants on a disposable database at the committed Phase 3 migration
snapshot. It then verifies that snapshot through current Phase 4 database
integration and runs the Phase 4 context, focused tests, real local Auth
token verification, and PostgreSQL integration. The old full Phase 3 gate is
phase-restricted to Phase 3's migration set, so it is not run after Phase 4
migrations exist. Each constituent remains independently runnable through its
script or package command.

## Clean-checkout reproduction

Use Node `24.21.0` and npm `11.19.0`. From a clean checkout, install the locked
development dependencies and confirm readiness:

```text
npm run setup:validation
npm run validation:ready
npm run phase4:gate
```

Setup needs access to `nodejs.org` and `registry.npmjs.org`; the gate itself
uses installed, pinned dependencies. A wrong runtime, stale install, missing
dependency, or failed setup is a failure, not a skipped validation.

Docker must be running with access for the invoking user. The gate starts and
cleans up separate disposable loopback-only resources for the Phase 3 database,
local Auth, and Phase 4 database checks, in sequence. The Phase 4 database
runner uses two temporary Supabase projects to compare an empty reset with an
upgrade from the committed Phase 3 snapshot. The Auth runner enables only local
Auth and its API gateway, provisions one disposable local test identity, then
checks a real locally issued token through the adapter. Both runners redact
credentials and remove only resources they created, including on failure. They
never access the normal development database or any deployed environment.

No GitHub OAuth exchange, production or staging credential, remote Auth change,
remote migration, or deployed service is part of this gate. Local Auth token
verification is separate from the deterministic JWT, authorization, cookie,
CSRF, consent, and privacy fixtures.

## Failure interpretation

The gate fails if any named constituent fails or cannot start, a required
Docker/PostgreSQL/Auth service is unavailable, a required test is skipped or
partial, a result or generated evidence is missing, or evidence predates the
current run. The report binds every evidence file to a run ID and source commit
and records its SHA-256 digest. `coverage` summarizes the Auth and authorization
matrices, identity consent and rotation cases, settings contracts, migration
ledger/checksums, RLS grants/policies, concurrency/replay/rollback results,
generated-type drift, and sanitized audit examples. The detailed database
snapshot is kept in `evidence/phase-4-database-integrity.json`.

Inspect the check-specific log named in the report. Stable codes such as
`LOCAL_AUTH_DOCKER_UNAVAILABLE`, `LOCAL_DB_UNAVAILABLE`,
`PORTFOLIO_SETTINGS_TYPE_DRIFT`, and `LOCAL_AUTH_CLEANUP_FAILED` identify the
failing boundary. Raw credentials, database URLs, provider payloads, private
subjects, and contact destinations do not belong in logs or evidence. Do not
publish a report whose verdict is `fail` or whose evidence list has stale or
missing entries.

## Migration rollback and forward fix

Issue #90 adds no database DDL. For an application release rollback, redeploy
the last accepted application revision while retaining the Phase 4 schema; the
Phase 4 migrations are additive and the prior application remains compatible.
If a migration defect is discovered, do not edit or replay a released
migration. Prepare a reviewed, timestamped forward migration with bounded lock
timeouts and a rollback/forward-fix note, then rerun the clean and Phase 3
upgrade equivalence checks. This gate performs no remote migration.

The gate preserves Phase 4 scope: Identity and Access and Portfolio
Configuration only, exactly five public v1 operations, and no frontend, Lab,
or later-phase behavior. Phase completion still requires fresh independent
Codex review, deterministic CI, and human approval under the repository PR
policy.
