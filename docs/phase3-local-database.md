# Phase 3 local PostgreSQL workflow

Ticket #45 establishes a disposable local Supabase/PostgreSQL workflow. It uses
only the exact CLI and database packages in `package-lock.json`; a global CLI,
remote project, and production or staging credentials are neither used nor
required.

## Prerequisites

- Node.js 24.21.0 and npm 11.19.0, as pinned by the repository.
- Docker Desktop or another Docker-compatible runtime with its daemon running.
- The repository checked out without a linked remote Supabase project.

Install and verify the locked toolchain from a clean checkout:

```powershell
npm ci
npm run db:verify
```

The verifier reads the local package installation and lockfile. It does not use
a globally installed CLI, contact a Supabase project, or print environment
values.

## Daily local flow

Start the disposable stack. A clean local volume applies the committed
migrations and non-secret seed:

```powershell
npm run db:start
```

Inspect whether the local stack is available without printing generated local
connection strings, passwords, or API keys:

```powershell
npm run db:status
```

Recreate the local database from committed SQL migrations and `seed.sql`:

```powershell
npm run db:reset
```

Reuse an existing local data volume on a later session without resetting it:

```powershell
npm run db:reuse
```

Stop only this repository's stack while preserving its local data volume:

```powershell
npm run db:stop
```

`supabase/config.toml`, `supabase/migrations/`, and `supabase/seed.sql` are the
only repository-owned database inputs in this flow. Ticket #45 introduced no
application migration or seed data; #46 and the remaining Phase 3 work own the
reviewed schemas, security baseline, and operations primitives. Data APIs, Auth/signup, Realtime, Storage,
Studio, Edge Runtime, and Analytics remain disabled until their owning phase.
Remote authentication, project linking, remote migration, and deployment remain
outside this workflow.

## Migration and security baseline

Ticket #46 adds the first timestamped application migration. It creates only
the declared module schemas and passwordless capability roles; it creates no
business table or seed data. The Phase 2 prior-release snapshot is recorded at
`supabase/baselines/phase2.json` as an initialized local Supabase database with
zero application migrations and zero application schemas.

Run the deterministic source and policy checks without Docker:

```powershell
npm run db:baseline:verify
```

With Docker running, prove clean and prior-baseline upgrades produce the same
normalized schemas, owners, capability-role attributes, default privileges,
object inventory, and migration ledger:

```powershell
npm run db:baseline:test
```

The live check creates two process-scoped Supabase projects on separate local
ports and never changes the repository's normal local stack. The upgrade
project starts with an empty migration set, verifies the initialized Phase 2
platform markers (`auth.users` present, `storage.objects` absent per the
storage-disabled topology) and empty migration history (the history table may
be absent before the first `migration up`), then applies the Phase 3
migration through `supabase migration up --local` twice: once to migrate and
once to prove replay is a no-op. The clean project starts with the committed
migration and runs `supabase db reset --local`. Both paths create and remove
privilege probes for future tables, sequences, and functions before their
normalized states and migration ledgers are compared. The verifier stops both
projects, removes their temporary work directories, writes sanitized evidence,
rejects non-loopback database URLs, and never emits the captured connection
string or provider output. Application login principals and passwords are
provisioned outside migrations; the committed roles are passwordless
capabilities only. If an isolated project cannot be stopped, the command exits
nonzero, reports `LOCAL_DB_CLEANUP_FAILED`, and retains that project's temporary
metadata so an operator can recover it; cleanup failure can never be reported
as success.

## Runtime and focused verification

Database-enabled application and worker composition requires `DATABASE_URL`.
Each process receives a separately provisioned login principal whose only
capability membership is `shipwithali_application` or `shipwithali_worker`.
`DATABASE_DIRECT_URL` is reserved for migration, type-generation, and backup
tooling and is never read by runtime composition.

The following checks remain independently runnable after the local stack has
been reset. Commands that exercise PostgreSQL read the loopback URL internally;
do not paste it into issue comments, logs, or evidence.

```powershell
npm run db:phase3:source
npm run db:phase3:migrations
$env:PHASE3_DATABASE_URL = '<loopback URL reported internally by the local stack>'
$env:PHASE3_REQUIRE_DATABASE = '1'
npm run db:phase3:integration
npm run db:phase3:security
```

Ticket #55 focused checks (#55 criterion 3) remain independently runnable for
migration/reset, baseline upgrade, type drift, role/RLS, transaction rollback,
optimistic concurrency, idempotency, outbox, lease recovery,
readiness/lifecycle, and query plans:

```powershell
npm run phase3:focus:migration
npm run phase3:focus:source
npm run phase3:focus:security
npm run phase3:focus:role-rls
npm run phase3:focus:transaction
npm run phase3:focus:occ
npm run phase3:focus:idempotency
npm run phase3:focus:outbox
npm run phase3:focus:leases
npm run phase3:focus:readiness
npm run phase3:focus:plans
```

`phase3:focus:migration` proves clean and Phase-2-baseline upgrades are
equivalent; `phase3:focus:source` proves adapter-confined sources without
Docker; `phase3:focus:security`/`role-rls` prove the allow/deny matrix as the
credited roles; `transaction`/`occ`/`idempotency`/`outbox`/`leases` prove
rollback, versioned updates, replay/conflict, atomic appends, and lease
recovery; `readiness` proves database-backed ready state and lifecycle drain;
`plans` captures index-backed outbox, job, and disposable `public_read`
`EXPLAIN` output. With `PHASE3_REQUIRE_DATABASE=1`, a missing
`PHASE3_DATABASE_URL` throws instead of skipping, and the gate fails on any
non-zero skipped suite, missing/stale evidence, or partial result.

`db:phase3:integration` proves observable commit/rollback, optimistic
concurrency, idempotency replay/conflict, outbox atomicity, exclusive leases,
token guards, and reclaim behavior through provider-neutral ports.
`db:phase3:security` verifies forced RLS and future-object defaults, checks
generated Kysely types byte-for-byte, and captures index-backed outbox, job,
and disposable `public_read` plans.

Role and grant assertions connect as the credited role. Capability roles are
passwordless `NOLOGIN` roles, so the check and the `role-rls-matrix` suite
create disposable login roles (random per-run passwords, provisioned outside
migrations), grant each login exactly one capability, connect with that login,
and assert through `SET ROLE`. Every assertion verifies
`session_user` (the unprivileged login) differs from `current_user` (the
credited role); superuser and migration-owner connections only arrange
fixtures and are never the asserting identity. Probe logins are dropped
afterwards and hold no grants, so a leaked probe cannot reach data.

Migration executor note: the local Supabase `postgres` login holds
`CREATEROLE` without `SUPERUSER`, so migrations cannot assume a superuser.
Role creation is unconditional while attribute correction runs only for
superuser executors, and each migration grants the executor membership in
`shipwithali_migration` before `SET ROLE`. No application, worker, backup,
anonymous, or authenticated grant is created by that membership.

Function default privileges: PostgreSQL 17 does not apply
default-privilege entries to newly created functions (their system default
remains `PUBLIC EXECUTE`). The baseline revoke is kept as defense in depth,
but every `CREATE FUNCTION` in production migrations must additionally carry
an explicit object-level `REVOKE ... FROM public, anon, authenticated`. The
baseline source verifier rejects unrevoked functions.

The authoritative completion command orchestrates all of this from a clean
checkout, starts with the complete Phase 2 gate, resets the local stack, rejects
missing or stale evidence, and stops the stack when finished:

```powershell
npm run phase3:gate
```

Docker must be running. A skipped database suite, unavailable Docker daemon,
missing local image, stale evidence file, or partial prior result is a failing
verdict, never a successful Phase 3 result.

## Safe failure behavior

The wrapper removes remote credential variables before invoking the project-local
CLI. Successful commands emit fixed summaries rather than provider output. A
failure reports a stable local diagnostic code while suppressing raw CLI output,
which can contain generated database passwords and connection strings.
## Completion-gate isolation

`npm run phase3:gate` copies the full checked-in migration chain and non-secret
seed into its own temporary Supabase project with a unique bounded identifier
and loopback port range. Start, reset, status and stop target that project; the
gate removes its owned services, volumes and temporary directory. The regular
`db:*` commands continue to target the configured developer stack.

The disposable migration bootstrap creates capability roles with the normal
local administrator, then elevates only that administrator while applying the
historical migration suffix requiring privileged ownership changes. It verifies
the exact container/project identity and restores the original privilege even
when migration application fails. This local fixture does not establish managed
Supabase deployment compatibility.
