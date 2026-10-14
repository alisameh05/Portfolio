# Reaction acceptance (#190)

Run with Node 24.21.0 / npm 11.19.0 after `npm run setup:validation` and
`npm run validation:ready`:

```text
npm run phase7:focus:reactions
```

The runner creates a native disposable PostgreSQL cluster on a dynamically
allocated loopback port. `PHASE7_POSTGRES_BIN` optionally selects installed
PostgreSQL binaries (Windows default: PostgreSQL 18). It applies every committed
migration in order, verifies generated Interaction schema types, and exercises
real application/HTTP workflows, AES-GCM identity, restricted RLS, independent
connections, observed database lock barriers, rollback, and runtime assembly.
No developer database, normal Supabase stack, external Auth account, or production
data is used. Owner lifecycle fixtures exercise the existing application service;
functional tokens use the actual Identity and Access crypto.

`npm run phase7:focus:reactions -- --refresh-types` refreshes owned generated
types during setup. Settle source and rerun without that flag for final acceptance.
The runner requires every assertion and suite to pass with zero failures/skips,
unchanged source fingerprint, and successful cluster cleanup before publishing
`evidence/phase7-reactions-190.json`. It never prints database URLs or server logs.
Clean-reset/previous-release upgrade equivalence across all modules remains #208.

The migration adds one table without changing existing tables or public/Owner
contracts. RLS requires transaction-local Portfolio and functional subject scope;
anonymous, authenticated and worker roles have no table grants. An application
login is a trusted server capability, never a client-exposed SQL login. The
configured Content adapter supplies the stable Owner scope needed by existing
Content policies; it exposes only narrow eligibility facts to Interaction.

Content root lock precedes the Reaction pair lock and replay ledger. Publication
and lifecycle commands use that same root lock. Locales are read in a separate
statement after acquisition so a waiting READ COMMITTED transaction observes the
latest committed publication. Reaction state, safe ledger receipt and the
subject-free changed fact commit together. Exact replay is reauthorized while
holding the root lock. Same-value requests under a new key emit no changed fact.

Rollback: disable Reaction assembly while retaining the new table and existing
data. Correct defects with a new timestamped migration. No production migrations,
schedule, Measurement event consumer, Rating activation or new HTTP route is
part of this ticket.
