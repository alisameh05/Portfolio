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
only repository-owned database inputs in this flow. Ticket #45 intentionally
ships no application migration or seed data; ticket #46 owns the first reviewed
schema and security migration. Remote authentication, project linking, remote
migration, and deployment remain outside this workflow.

## Safe failure behavior

The wrapper removes remote credential variables before invoking the project-local
CLI. Successful commands emit fixed summaries rather than provider output. A
failure reports a stable local diagnostic code while suppressing raw CLI output,
which can contain generated database passwords and connection strings.
