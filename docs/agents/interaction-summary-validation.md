# Current interaction summary acceptance (#195)

Use the repository-pinned Node 24.21.0 and npm 11.19.0:

```text
npm run setup:validation
npm run validation:ready
npm run phase7:focus:summaries
```

The focused runner extends Moderation/suppression acceptance with real current
summary and lifecycle scenarios. It creates its own native PostgreSQL cluster
on a dynamic loopback port. `PHASE7_POSTGRES_BIN` selects the binaries (Windows
defaults to PostgreSQL 18). No developer/production database is used. Migration
qualification uses the real Supabase CLI ledger for prior-release upgrade, clean
installation, preservation and no-op replay. The generated Interaction types
include the two safe aggregate views; `-- --refresh-types` is setup only.

Summary reads use standard runtime assembly and the in-process
`getProjectAggregate` interface. There is no public HTTP read operation. A
statement snapshot computes current vote totals and approved exact-locale count;
it never consumes Measurement identities, asynchronous projections or delayed
visibility. The caller receives database snapshot time in `asOf`. Content's root
lock serializes queries and mutations with actual hide/archive/restore commands.

Required reports reject aggregate/suite failures, unexpected assertion counts,
skips, source changes and failed cleanup. Only after successful cleanup is
`evidence/phase7-summaries-195.json` written. Query plans omit SQL predicates,
fixture IDs and provider details. Broad optional integration skips and hosted
checks are reported separately from this required acceptance.

The aggregate views intentionally use owner rights to avoid granting raw-voter
SELECT to runtime. Their private owner is NOLOGIN/NOBYPASSRLS, inherits the
existing application Content policies, and has scoped SELECT policies on forced
RLS vote tables. It is never granted to the runtime, worker or Data API roles.
Only counts and an average at five or more raters can leave the views. Both
views independently filter current publication and requested locale. Tests must
verify ownership, membership direction, raw-row isolation, denied roles, unset
and reused scopes, and absence of subject/private fields in application DTOs.

The expand-only migration preserves stored votes and Feedback. Rollback disables
the summary capability; a reviewed forward migration repairs policies/views.
No production migration, worker schedule, deployment or branch protection change
is part of this command. Phase 7 aggregation jobs remain a later ticket; this
on-read strategy has no worker write path that can restore public visibility.
